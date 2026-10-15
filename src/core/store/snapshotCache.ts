import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { withFileLock } from '../util/fileLock';
import { isErrno } from '../util/errors';
import { readJsonFile, removePath, resolveInside, walkFiles, writeFileAtomic } from '../util/fsx';
import { Logger } from '../util/log';

export interface SkippedFile {
  path: string;
  size: number;
}

export interface SnapshotMeta {
  projectId: string;
  projectName: string;
  /** Directory (inside the project's cache dir) holding this snapshot's files. */
  dir: string;
  /** What the remote looked like when downloaded: lastUpdated (web session) or a commit hash (Git). */
  remoteVersion?: string;
  downloadedAt: string;
  textFiles: number;
  bytes: number;
  /** Binary files, which are listed but not stored (search only needs text). */
  skipped: SkippedFile[];
}

/**
 * Read-only copies of project text files, used for search and outlines. Several processes share
 * it, so refreshes run under a cross-process lock and switch snapshots by rewriting meta.json.
 */
export class SnapshotCache {
  constructor(
    private readonly root: string,
    private readonly locksDir: string,
    private readonly logger: Logger,
  ) {}

  private projectDir(projectId: string): string {
    if (!/^[\w.-]+$/.test(projectId)) throw new Error(`Invalid project id "${projectId}"`);
    return path.join(this.root, projectId);
  }

  async meta(projectId: string): Promise<SnapshotMeta | undefined> {
    return readJsonFile<SnapshotMeta>(path.join(this.projectDir(projectId), 'meta.json'));
  }

  async snapshotDir(projectId: string): Promise<string | undefined> {
    const meta = await this.meta(projectId);
    return meta ? path.join(this.projectDir(projectId), meta.dir) : undefined;
  }

  isFresh(meta: SnapshotMeta | undefined, remoteVersion: string | undefined, maxAgeMs: number): boolean {
    if (!meta) return false;
    if (Date.now() - Date.parse(meta.downloadedAt) > maxAgeMs) return false;
    return remoteVersion === undefined || meta.remoteVersion === remoteVersion;
  }

  /** Serializes refreshes of one project across every process using this cache. */
  withLock<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    return withFileLock(path.join(this.locksDir, `cache-${projectId}.lock`), task, { timeoutMs: 300_000 });
  }

  async replace(
    projectId: string,
    projectName: string,
    remoteVersion: string | undefined,
    files: Iterable<[string, Uint8Array]>,
    skipped: SkippedFile[] = [],
  ): Promise<SnapshotMeta> {
    const projectDir = this.projectDir(projectId);
    const dirName = `snap-${Date.now()}-${randomBytes(3).toString('hex')}`;
    const snapshotDir = path.join(projectDir, dirName);
    await fs.mkdir(snapshotDir, { recursive: true });
    let textFiles = 0;
    let bytes = 0;
    for (const [relative, content] of files) {
      const target = resolveInside(snapshotDir, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
      textFiles++;
      bytes += content.byteLength;
    }
    const meta: SnapshotMeta = {
      projectId,
      projectName,
      dir: dirName,
      remoteVersion,
      downloadedAt: new Date().toISOString(),
      textFiles,
      bytes,
      skipped,
    };
    await writeFileAtomic(path.join(projectDir, 'meta.json'), JSON.stringify(meta, null, 2));
    await this.removeOldSnapshots(projectDir, dirName);
    return meta;
  }

  /** Leaves recent old snapshots alone: another process may still be reading one. */
  private async removeOldSnapshots(projectDir: string, keep: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(projectDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.startsWith('snap-') || entry === keep) continue;
      const created = Number(entry.split('-')[1]);
      if (Number.isFinite(created) && Date.now() - created < 60_000) continue;
      await removePath(path.join(projectDir, entry)).catch((error) => this.logger.debug(`Could not remove old snapshot ${entry}`, error));
    }
  }

  /** Keeps the snapshot in step with our own edits so searches see them immediately. */
  async writeFile(projectId: string, filePath: string, content: string | Uint8Array): Promise<void> {
    const dir = await this.snapshotDir(projectId);
    if (!dir) return;
    const target = resolveInside(dir, filePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }

  async removeFile(projectId: string, filePath: string): Promise<void> {
    const dir = await this.snapshotDir(projectId);
    if (!dir) return;
    await removePath(resolveInside(dir, filePath));
  }

  async moveFile(projectId: string, from: string, to: string): Promise<void> {
    const dir = await this.snapshotDir(projectId);
    if (!dir) return;
    const target = resolveInside(dir, to);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.rename(resolveInside(dir, from), target);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
  }

  async readText(projectId: string, filePath: string): Promise<string | undefined> {
    const dir = await this.snapshotDir(projectId);
    if (!dir) return undefined;
    try {
      return await fs.readFile(resolveInside(dir, filePath), 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT', 'EISDIR')) return undefined;
      throw error;
    }
  }

  async listTextFiles(projectId: string): Promise<string[]> {
    const dir = await this.snapshotDir(projectId);
    return dir ? walkFiles(dir) : [];
  }

  async clear(projectId?: string): Promise<void> {
    await removePath(projectId ? this.projectDir(projectId) : this.root);
  }
}
