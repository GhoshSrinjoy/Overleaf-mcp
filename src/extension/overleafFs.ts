import * as vscode from 'vscode';
import { SessionBackend } from '../core/backends/session';
import { RealtimeProject } from '../core/overleaf/realtime';
import { TreeEntry } from '../core/overleaf/types';
import { isTextPath, looksLikeText } from '../core/search/textFiles';
import { OverleafService } from '../core/service';
import { OverleafError, errorMessage } from '../core/util/errors';
import { Logger } from '../core/util/log';

export const SCHEME = 'overleaf';

export function overleafUri(projectId: string, filePath = ''): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, authority: projectId, path: `/${filePath}` });
}

export function parseOverleafUri(uri: vscode.Uri): { projectId: string; path: string } {
  return { projectId: uri.authority, path: uri.path.replace(/^\/+/, '').replace(/\/+$/, '') };
}

interface CachedDoc {
  text: string;
  version: number;
  stale: boolean;
}

function toFsError(error: unknown, uri: vscode.Uri): Error {
  if (error instanceof vscode.FileSystemError) return error;
  if (error instanceof OverleafError) {
    if (error.code === 'NOT_FOUND') return vscode.FileSystemError.FileNotFound(uri);
    if (error.code === 'FORBIDDEN') return vscode.FileSystemError.NoPermissions(error.message);
  }
  return vscode.FileSystemError.Unavailable(errorMessage(error));
}

/**
 * Exposes Overleaf projects as overleaf://<projectId>/<path>. Reads come live from Overleaf;
 * saves are sent as OT updates (merged with collaborators' edits); collaborators' typing is
 * pushed back into open, unmodified editors.
 */
export class OverleafFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private readonly docs = new Map<string, CachedDoc>();
  private readonly mtimes = new Map<string, number>();
  private readonly watchers = new Map<string, { count: number; dispose: () => void }>();
  private readonly pendingEvents = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly service: OverleafService,
    private readonly logger: Logger,
  ) {}

  private async backend(): Promise<SessionBackend> {
    return this.service.sessionBackend();
  }

  private async project(projectId: string): Promise<RealtimeProject> {
    return (await this.backend()).pool.get(projectId);
  }

  private async entry(uri: vscode.Uri): Promise<{ realtime: RealtimeProject; entry?: TreeEntry; path: string; projectId: string }> {
    const { projectId, path } = parseOverleafUri(uri);
    const realtime = await this.project(projectId);
    return { realtime, entry: path ? realtime.tree.find(path) : undefined, path, projectId };
  }

  watch(uri: vscode.Uri): vscode.Disposable {
    const { projectId } = parseOverleafUri(uri);
    const existing = this.watchers.get(projectId);
    if (existing) {
      existing.count++;
    } else {
      const holder = { count: 1, dispose: () => undefined as void };
      this.watchers.set(projectId, holder);
      this.subscribe(projectId, holder);
    }
    return new vscode.Disposable(() => {
      const holder = this.watchers.get(projectId);
      if (!holder || --holder.count > 0) return;
      holder.dispose();
      this.watchers.delete(projectId);
    });
  }

  /** Attaches a watched project to the current session's live connection. */
  private subscribe(projectId: string, holder: { count: number; dispose: () => void }): void {
    void this.backend()
      .then((backend) => {
        if (this.watchers.get(projectId) !== holder) return;
        holder.dispose = backend.pool.subscribe(projectId, {
          treeChanged: () => this.fireSoon(overleafUri(projectId), vscode.FileChangeType.Changed),
          docChanged: (change) => void this.onRemoteDocChange(projectId, change.docId, change.version),
          reconnected: () => this.resyncProject(projectId),
        });
        // Connect now so remote edits start flowing.
        return backend.pool.get(projectId);
      })
      .catch((error) => this.logger.debug(`Could not watch project ${projectId}`, error));
  }

  private async onRemoteDocChange(projectId: string, docId: string, version: number): Promise<void> {
    const realtime = await this.project(projectId);
    const path = realtime.tree.pathOf(docId);
    if (path === undefined) return;
    const uri = overleafUri(projectId, path);
    const key = uri.toString();
    // Let a save that produced this version record it first; then it is not news to us.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const cached = this.docs.get(key);
    if (cached && cached.version >= version) return;
    if (cached) cached.stale = true;
    // An editor with unsaved changes keeps its version; saving it merges the remote edits in.
    // Bumping the timestamp there would only make VS Code refuse the save as a conflict.
    if (vscode.workspace.textDocuments.some((doc) => doc.uri.toString() === key && doc.isDirty)) return;
    if (vscode.workspace.getConfiguration('overleafMcp').get<boolean>('liveUpdates', true)) this.announceChange(uri, 400);
  }

  /** After a reconnect, edits may have been missed: re-read every open, unmodified doc of the project. */
  private resyncProject(projectId: string): void {
    for (const [key, cached] of this.docs) {
      const uri = vscode.Uri.parse(key);
      if (parseOverleafUri(uri).projectId !== projectId) continue;
      cached.stale = true;
      if (!vscode.workspace.textDocuments.some((doc) => doc.uri.toString() === key && doc.isDirty)) this.announceChange(uri, 200);
    }
  }

  /** Marks the file as changed (new timestamp) and tells VS Code, so open editors reload it. */
  private announceChange(uri: vscode.Uri, delay: number): void {
    this.fireSoon(uri, vscode.FileChangeType.Changed, delay, () => this.mtimes.set(uri.toString(), Math.max(Date.now(), (this.mtimes.get(uri.toString()) ?? 0) + 1)));
  }

  /** Coalesces bursts (collaborators type quickly) into one change event per file. */
  private fireSoon(uri: vscode.Uri, type: vscode.FileChangeType, delay = 150, beforeFire?: () => void): void {
    const key = `${type}:${uri.toString()}`;
    clearTimeout(this.pendingEvents.get(key));
    this.pendingEvents.set(
      key,
      setTimeout(() => {
        this.pendingEvents.delete(key);
        beforeFire?.();
        this.emitter.fire([{ type, uri }]);
      }, delay),
    );
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    try {
      const { entry, path } = await this.entry(uri);
      if (!path) return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
      if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
      if (entry.type === 'folder') return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
      // VS Code treats any change of (mtime, size) as "modified elsewhere", so both stay fixed
      // until the file really changes. The size is not known without downloading, so it is 0.
      const key = uri.toString();
      if (!this.mtimes.has(key)) this.mtimes.set(key, Date.now());
      return { type: vscode.FileType.File, ctime: 0, mtime: this.mtimes.get(key)!, size: 0 };
    } catch (error) {
      throw toFsError(error, uri);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    try {
      const { realtime, path } = await this.entry(uri);
      const prefix = path ? `${path}/` : '';
      return realtime.tree
        .entries()
        .filter((e) => e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes('/'))
        .map((e) => [e.name, e.type === 'folder' ? vscode.FileType.Directory : vscode.FileType.File]);
    } catch (error) {
      throw toFsError(error, uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    try {
      const { realtime, entry, path, projectId } = await this.entry(uri);
      if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
      if (entry.type === 'folder') throw vscode.FileSystemError.FileIsADirectory(uri);
      if (entry.type === 'file') return (await this.backend()).web.downloadFile(projectId, entry.id, entry.hash);
      const key = uri.toString();
      const cached = this.docs.get(key);
      if (cached && !cached.stale && this.watchers.has(projectId)) return Buffer.from(cached.text, 'utf8');
      const snapshot = await realtime.readDoc(entry.id);
      this.docs.set(key, { text: snapshot.text, version: snapshot.version, stale: false });
      this.logger.debug(`Read ${path} v${snapshot.version}`);
      return Buffer.from(snapshot.text, 'utf8');
    } catch (error) {
      throw toFsError(error, uri);
    }
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    try {
      const { entry, path, projectId } = await this.entry(uri);
      if (!path) throw vscode.FileSystemError.FileIsADirectory(uri);
      if (entry?.type === 'folder') throw vscode.FileSystemError.FileIsADirectory(uri);
      if (!entry && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
      if (entry && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);
      const bytes = Buffer.from(content);
      const isText = isTextPath(path) ?? looksLikeText(bytes);

      if (entry?.type === 'doc') {
        const key = uri.toString();
        const base = this.docs.get(key);
        const saved = await (await this.backend()).saveDocument(projectId, path, bytes.toString('utf8'), base);
        this.docs.set(key, { text: saved.text, version: saved.version, stale: false });
        this.mtimes.set(key, Math.max(Date.now(), (this.mtimes.get(key) ?? 0) + 1));
        // The editor holds what it saved; once VS Code has finished saving, reload the stored text
        // (a merge with collaborators' edits, or the same text with Overleaf's LF line endings).
        if (saved.reload) this.announceChange(uri, 300);
        if (saved.merged) vscode.window.setStatusBarMessage(`$(git-merge) Merged Overleaf changes into ${path}`, 5000);
        return;
      }
      if (!entry && isText) {
        await this.service.writeFile(projectId, path, bytes.toString('utf8'));
      } else {
        await this.service.uploadFile(projectId, path, bytes);
      }
      this.mtimes.set(uri.toString(), Date.now());
      this.fireSoon(uri, entry ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created);
    } catch (error) {
      throw toFsError(error, uri);
    }
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    try {
      const { projectId, path } = parseOverleafUri(uri);
      await this.service.createFolder(projectId, path);
      this.fireSoon(uri, vscode.FileChangeType.Created);
    } catch (error) {
      throw toFsError(error, uri);
    }
  }

  async delete(uri: vscode.Uri): Promise<void> {
    try {
      const { projectId, path } = parseOverleafUri(uri);
      await this.service.deleteFile(projectId, path);
      this.docs.delete(uri.toString());
      this.fireSoon(uri, vscode.FileChangeType.Deleted);
    } catch (error) {
      throw toFsError(error, uri);
    }
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    try {
      const from = parseOverleafUri(oldUri);
      const to = parseOverleafUri(newUri);
      if (from.projectId !== to.projectId) throw vscode.FileSystemError.NoPermissions('Moving files between projects is not supported');
      const { realtime } = await this.entry(newUri);
      if (realtime.tree.find(to.path)) {
        if (!options.overwrite) throw vscode.FileSystemError.FileExists(newUri);
        await this.service.deleteFile(to.projectId, to.path);
      }
      await this.service.moveFile(from.projectId, from.path, to.path);
      this.docs.delete(oldUri.toString());
      this.emitter.fire([
        { type: vscode.FileChangeType.Deleted, uri: oldUri },
        { type: vscode.FileChangeType.Created, uri: newUri },
      ]);
    } catch (error) {
      throw toFsError(error, oldUri);
    }
  }

  /**
   * The session changed: move VS Code's file watches to the new connection. Cached texts stay as
   * merge bases, so editors that are open (possibly with unsaved changes) still save safely.
   */
  reset(): void {
    for (const [projectId, holder] of this.watchers) {
      holder.dispose();
      holder.dispose = () => undefined;
      this.subscribe(projectId, holder);
    }
    for (const cached of this.docs.values()) cached.stale = true;
  }

  dispose(): void {
    for (const [, watcher] of this.watchers) watcher.dispose();
    this.watchers.clear();
    this.docs.clear();
    for (const timer of this.pendingEvents.values()) clearTimeout(timer);
    this.emitter.dispose();
  }
}
