import { unzipSync } from 'fflate';
import * as path from 'node:path';
import { threeWayMerge } from '../merge';
import { assertEditableText, normalizeNewlines } from '../overleaf/ot';
import { RealtimeProject } from '../overleaf/realtime';
import { ProjectSummary, Tag, TreeEntry } from '../overleaf/types';
import { OverleafWebClient } from '../overleaf/webClient';
import { isTextPath, looksLikeText, decodeText, isTextContent } from '../search/textFiles';
import { SkippedFile } from '../store/snapshotCache';
import { KeyedMutex } from '../util/concurrency';
import { OverleafError } from '../util/errors';
import { normalizeProjectPath } from '../util/fsx';
import { Logger } from '../util/log';
import { RealtimePool } from './realtimePool';
import { CompileOutput, ProjectBackend, ProjectTreeInfo, SnapshotFiles, TextContent, UpdateTextOptions, UpdateTextResult } from './types';

/** Above this, OT updates risk Overleaf's update-size limit; whole-file uploads are used instead. */
const MAX_OT_UPDATE_CHARS = 1_500_000;
const MAX_SNAPSHOT_FILE_BYTES = 8 * 1024 * 1024;

export function splitPath(filePath: string): { dir: string; name: string } {
  const normalized = normalizeProjectPath(filePath);
  if (!normalized) throw new OverleafError('INVALID_INPUT', 'A file path is required');
  const slash = normalized.lastIndexOf('/');
  return { dir: slash === -1 ? '' : normalized.slice(0, slash), name: normalized.slice(slash + 1) };
}

/** Lists the closest existing paths, to help when a path is mistyped. */
export function suggestPaths(wanted: string, entries: readonly { path: string }[], limit = 5): string[] {
  const base = path.posix.basename(wanted).toLowerCase();
  const scored = entries.map((entry) => {
    const candidate = entry.path.toLowerCase();
    let score = 0;
    if (candidate === wanted.toLowerCase()) score += 100;
    if (path.posix.basename(candidate) === base) score += 50;
    if (candidate.includes(base.replace(/\.[^.]+$/, ''))) score += 20;
    for (const part of wanted.toLowerCase().split(/[/._-]+/).filter(Boolean)) if (candidate.includes(part)) score += 5;
    return { path: entry.path, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.path);
}

export function notFoundError(projectName: string, filePath: string, entries: readonly { path: string }[]): OverleafError {
  const suggestions = suggestPaths(filePath, entries);
  return new OverleafError(
    'NOT_FOUND',
    `"${filePath}" does not exist in project "${projectName}".${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''}`,
  );
}

export function extractSnapshot(zip: Uint8Array): { files: Array<[string, Uint8Array]>; skipped: SkippedFile[] } {
  const skipped: SkippedFile[] = [];
  const extracted = unzipSync(zip, {
    filter: (file) => {
      if (file.name.endsWith('/')) return false;
      if (isTextPath(file.name) === false || file.originalSize > MAX_SNAPSHOT_FILE_BYTES) {
        skipped.push({ path: normalizeProjectPath(file.name), size: file.originalSize });
        return false;
      }
      return true;
    },
  });
  const files: Array<[string, Uint8Array]> = [];
  for (const [name, bytes] of Object.entries(extracted)) {
    const filePath = normalizeProjectPath(name);
    if (!filePath) continue;
    if (isTextPath(filePath) === undefined && !looksLikeText(bytes)) {
      skipped.push({ path: filePath, size: bytes.byteLength });
      continue;
    }
    files.push([filePath, bytes]);
  }
  return { files, skipped };
}

/** Projects reached through the signed-in Overleaf web session (works on every plan). */
export class SessionBackend implements ProjectBackend {
  readonly kind = 'session' as const;
  readonly pool: RealtimePool;
  private readonly writes = new KeyedMutex();

  constructor(
    readonly web: OverleafWebClient,
    private readonly logger: Logger,
    /** Known from sign-in; saves loading the (rate-limited) dashboard just to learn it. */
    private userId?: string,
  ) {
    this.pool = new RealtimePool(web, logger);
  }

  private async currentUserId(): Promise<string> {
    if (!this.userId) this.userId = this.web.currentSession?.userId ?? (await this.web.verifySession()).userId;
    return this.userId;
  }

  listProjects(): Promise<ProjectSummary[]> {
    return this.web.listProjects();
  }

  listTags(): Promise<Tag[]> {
    return this.web.listTags();
  }

  async remoteVersion(project: ProjectSummary): Promise<string | undefined> {
    return project.lastUpdated;
  }

  async getTree(projectId: string): Promise<ProjectTreeInfo> {
    const realtime = await this.pool.get(projectId);
    const rootDocId = realtime.project.rootDoc_id ?? undefined;
    return {
      entries: realtime.tree.entries().map((e) => ({ path: e.path, type: e.type, id: e.id, hash: e.hash })),
      rootDocPath: rootDocId ? realtime.tree.pathOf(rootDocId) : undefined,
      permissionsLevel: realtime.permissionsLevel,
      canEdit: realtime.canEdit,
    };
  }

  private async locate(projectId: string, filePath: string): Promise<{ realtime: RealtimeProject; entry?: TreeEntry; normalized: string }> {
    const realtime = await this.pool.get(projectId);
    const normalized = normalizeProjectPath(filePath);
    return { realtime, entry: realtime.tree.find(normalized), normalized };
  }

  async readText(projectId: string, filePath: string): Promise<TextContent> {
    const { realtime, entry, normalized } = await this.locate(projectId, filePath);
    if (!entry) throw notFoundError(realtime.project.name, normalized, realtime.tree.entries());
    if (entry.type === 'folder') throw new OverleafError('INVALID_INPUT', `"${normalized}" is a folder; use list_files to see its contents`);
    if (entry.type === 'doc') {
      const snapshot = await realtime.readDoc(entry.id);
      return { text: snapshot.text, version: snapshot.version, otType: snapshot.type, trackedChanges: snapshot.trackedChanges, comments: snapshot.comments };
    }
    const bytes = await this.web.downloadFile(projectId, entry.id, entry.hash);
    if (!isTextContent(normalized, bytes)) {
      throw new OverleafError('INVALID_INPUT', `"${normalized}" is a binary file (${bytes.byteLength} bytes), not text`);
    }
    return { text: decodeText(bytes) };
  }

  async readBinary(projectId: string, filePath: string): Promise<Uint8Array> {
    const { realtime, entry, normalized } = await this.locate(projectId, filePath);
    if (!entry || entry.type === 'folder') throw notFoundError(realtime.project.name, normalized, realtime.tree.entries());
    if (entry.type === 'doc') return new TextEncoder().encode((await realtime.readDoc(entry.id)).text);
    return this.web.downloadFile(projectId, entry.id, entry.hash);
  }

  updateText(projectId: string, filePath: string, mutate: (current: string) => string, options: UpdateTextOptions = {}): Promise<UpdateTextResult> {
    const normalized = normalizeProjectPath(filePath);
    return this.writes.run(`${projectId}:${normalized}`, async () => {
      const { realtime, entry } = await this.locate(projectId, normalized);
      if (entry?.type === 'folder') throw new OverleafError('INVALID_INPUT', `"${normalized}" is a folder`);

      if (!entry) {
        if (!options.createIfMissing) throw notFoundError(realtime.project.name, normalized, realtime.tree.entries());
        if (options.track) throw new OverleafError('INVALID_INPUT', 'New files cannot be created as tracked changes; create the file without suggest mode');
        const after = mutate('');
        assertEditableText(after, `Could not create ${normalized}`);
        await this.uploadInto(realtime, normalized, new TextEncoder().encode(after));
        return { path: normalized, created: true, changed: true, before: '', after, via: 'upload' };
      }

      if (entry.type === 'file') {
        // Text stored as a binary file (e.g. a very large .bib): replace the whole file.
        if (options.track) throw new OverleafError('INVALID_INPUT', `"${normalized}" is not an editable document, so suggest mode is unavailable`);
        const before = decodeText(await this.web.downloadFile(projectId, entry.id, entry.hash));
        const after = mutate(before);
        if (after === before) return { path: normalized, created: false, changed: false, before, after, via: 'upload' };
        assertEditableText(after, `Could not update ${normalized}`);
        await this.uploadInto(realtime, normalized, new TextEncoder().encode(after));
        return { path: normalized, created: false, changed: true, before, after, via: 'upload' };
      }

      const snapshot = await realtime.readDoc(entry.id);
      const after = mutate(snapshot.text);
      if (after === snapshot.text) {
        return { path: normalized, created: false, changed: false, before: snapshot.text, after, version: snapshot.version, via: 'realtime' };
      }
      if (!options.track && Math.max(after.length, snapshot.text.length) > MAX_OT_UPDATE_CHARS) {
        // Huge rewrite: let the server diff it instead of sending a giant OT update.
        assertEditableText(after, `Could not update ${normalized}`);
        await this.uploadInto(realtime, normalized, new TextEncoder().encode(after));
        return { path: normalized, created: false, changed: true, before: snapshot.text, after, via: 'upload' };
      }
      const track = options.track ? { userId: await this.currentUserId() } : undefined;
      const result = await realtime.applyText(snapshot, after, { track });
      return { path: normalized, created: false, changed: result.changed, before: snapshot.text, after, version: result.version, via: 'realtime' };
    });
  }

  /**
   * Saves an editor buffer. `base` is the text the editor loaded; if the doc changed on Overleaf
   * since then, our changes are rebased onto the latest version instead of overwriting it.
   */
  saveDocument(
    projectId: string,
    filePath: string,
    text: string,
    base?: { text: string; version: number },
  ): Promise<{ text: string; version: number; merged: boolean; reload: boolean }> {
    const normalized = normalizeProjectPath(filePath);
    return this.writes.run(`${projectId}:${normalized}`, async () => {
      const { realtime, entry } = await this.locate(projectId, normalized);
      if (!entry || entry.type !== 'doc') throw notFoundError(realtime.project.name, normalized, realtime.tree.entries());
      const fresh = await realtime.readDoc(entry.id);
      // Editors on Windows may use CRLF; Overleaf documents are LF-only.
      const ours = normalizeNewlines(text);
      let target = ours;
      if (base && base.version !== fresh.version && base.text !== fresh.text) {
        const merge = threeWayMerge(base.text, ours, fresh.text);
        if (!merge.clean) {
          throw new OverleafError(
            'CONFLICT',
            `${normalized} was changed on Overleaf in the same places you edited (${merge.failedHunks} conflicting change(s)). Copy your edits, reload the file, and apply them again.`,
          );
        }
        target = merge.merged;
      }
      const result = await realtime.applyText(fresh, target);
      return { text: target, version: result.version, merged: target !== ours, reload: target !== text };
    });
  }

  private async uploadInto(realtime: RealtimeProject, filePath: string, data: Uint8Array): Promise<void> {
    const { dir, name } = splitPath(filePath);
    const folderId = dir ? realtime.tree.folderId(dir) : realtime.tree.rootFolderId;
    if (folderId) {
      await this.web.upload(realtime.projectId, folderId, name, data);
    } else {
      // relativePath makes Overleaf create the missing folders.
      await this.web.upload(realtime.projectId, realtime.tree.rootFolderId, name, data, filePath);
    }
    await this.waitForPath(realtime, filePath);
  }

  /** Our own HTTP changes arrive back as realtime tree events; wait briefly so the tree is current. */
  private async waitForPath(realtime: RealtimeProject, filePath: string, present = true): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!!realtime.tree.find(filePath) === present) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this.logger.debug(`Tree did not reflect ${filePath} within 5s`);
  }

  async writeBinary(projectId: string, filePath: string, data: Uint8Array): Promise<void> {
    const normalized = normalizeProjectPath(filePath);
    await this.writes.run(`${projectId}:${normalized}`, async () => {
      const realtime = await this.pool.get(projectId);
      if (realtime.tree.find(normalized)?.type === 'folder') throw new OverleafError('INVALID_INPUT', `"${normalized}" is a folder`);
      await this.uploadInto(realtime, normalized, data);
    });
  }

  async createFolder(projectId: string, folderPath: string): Promise<void> {
    const realtime = await this.pool.get(projectId);
    await this.ensureFolder(realtime, normalizeProjectPath(folderPath));
  }

  private async ensureFolder(realtime: RealtimeProject, folderPath: string): Promise<string> {
    let parentId = realtime.tree.rootFolderId;
    let current = '';
    for (const part of folderPath.split('/').filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      const existing = realtime.tree.find(current);
      if (existing?.type === 'folder') {
        parentId = existing.id;
        continue;
      }
      if (existing) throw new OverleafError('CONFLICT', `"${current}" already exists and is not a folder`);
      const folder = await this.web.createFolder(realtime.projectId, parentId, part);
      realtime.tree.addEntity(parentId, 'folder', folder);
      parentId = folder._id;
    }
    return parentId;
  }

  async deletePath(projectId: string, filePath: string): Promise<void> {
    const { realtime, entry, normalized } = await this.locate(projectId, filePath);
    if (!entry) throw notFoundError(realtime.project.name, normalized, realtime.tree.entries());
    if (entry.id === realtime.project.rootDoc_id) {
      throw new OverleafError('INVALID_INPUT', `"${normalized}" is the project's main document; set another main document in Overleaf before deleting it`);
    }
    await this.web.deleteEntity(projectId, entry.type, entry.id);
    realtime.tree.removeEntity(entry.id);
  }

  async movePath(projectId: string, from: string, to: string): Promise<void> {
    const { realtime, entry, normalized } = await this.locate(projectId, from);
    if (!entry) throw notFoundError(realtime.project.name, normalized, realtime.tree.entries());
    const target = splitPath(to);
    const targetPath = normalizeProjectPath(to);
    if (realtime.tree.find(targetPath)) throw new OverleafError('CONFLICT', `"${targetPath}" already exists`);
    const source = splitPath(normalized);
    if (target.dir !== source.dir) {
      const folderId = await this.ensureFolder(realtime, target.dir);
      if (target.name !== source.name && realtime.tree.find(target.dir ? `${target.dir}/${source.name}` : source.name)) {
        // Rename first so the move does not collide with an existing name in the target folder.
        await this.web.renameEntity(projectId, entry.type, entry.id, target.name);
        realtime.tree.renameEntity(entry.id, target.name);
        await this.web.moveEntity(projectId, entry.type, entry.id, folderId);
        realtime.tree.moveEntity(entry.id, folderId);
        return;
      }
      await this.web.moveEntity(projectId, entry.type, entry.id, folderId);
      realtime.tree.moveEntity(entry.id, folderId);
    }
    if (target.name !== source.name) {
      await this.web.renameEntity(projectId, entry.type, entry.id, target.name);
      realtime.tree.renameEntity(entry.id, target.name);
    }
  }

  async snapshot(projectId: string): Promise<SnapshotFiles> {
    return extractSnapshot(await this.web.downloadZip(projectId));
  }

  createProject(name: string, template: 'none' | 'example'): Promise<string> {
    return this.web.createProject(name, template);
  }

  async compile(projectId: string, options: { rootPath?: string; draft?: boolean; stopOnFirstError?: boolean }): Promise<CompileOutput> {
    const realtime = await this.pool.get(projectId);
    let rootDocId = realtime.project.rootDoc_id ?? undefined;
    if (options.rootPath) {
      const entry = realtime.tree.find(normalizeProjectPath(options.rootPath));
      if (!entry || entry.type !== 'doc') throw notFoundError(realtime.project.name, options.rootPath, realtime.tree.entries());
      rootDocId = entry.id;
    }
    const response = await this.web.compile(projectId, { rootDocId, draft: options.draft, stopOnFirstError: options.stopOnFirstError });
    const fetchText = async (name: string) => {
      const file = response.outputFiles?.find((f) => f.path === name);
      if (!file) return undefined;
      try {
        return new TextDecoder().decode(await this.web.downloadOutputFile(file, response));
      } catch (error) {
        this.logger.warn(`Could not download ${name}`, error);
        return undefined;
      }
    };
    const pdfFile = response.outputFiles?.find((f) => f.path === 'output.pdf');
    return {
      response,
      log: await fetchText('output.log'),
      bibtexLog: await fetchText('output.blg'),
      pdf: pdfFile ? () => this.web.downloadOutputFile(pdfFile, response) : undefined,
    };
  }

  historyUpdates(projectId: string, options: { minCount?: number; before?: number }) {
    return this.web.historyUpdates(projectId, options);
  }

  historyDiff(projectId: string, filePath: string, from: number, to: number) {
    return this.web.historyDiff(projectId, normalizeProjectPath(filePath), from, to);
  }

  close(): void {
    this.pool.closeAll();
  }
}
