import { createHash } from 'node:crypto';
import { FSWatcher, promises as fs, watch } from 'node:fs';
import * as path from 'node:path';
import { unzipSync } from 'fflate';
import { SessionBackend } from '../backends/session';
import { threeWayMerge } from '../merge';
import { normalizeNewlines } from '../overleaf/ot';
import { decodeText, isTextContent } from '../search/textFiles';
import { OverleafService } from '../service';
import { OverleafError, errorMessage, isErrno } from '../util/errors';
import { normalizeProjectPath, pathExists, readJsonFile, resolveInside, walkFiles, writeFileAtomic } from '../util/fsx';
import { Logger } from '../util/log';
import { IGNORE_FILE, STATE_DIR, defaultIgnore, loadIgnoreMatcher } from './ignore';

type FileType = 'doc' | 'file';

interface FileState {
  hash: string;
  type: FileType;
}

interface MirrorState {
  version: 1;
  projectId: string;
  projectName: string;
  serverUrl: string;
  files: Record<string, FileState>;
  lastSync?: string;
}

export interface SyncReport {
  pulled: string[];
  pushed: string[];
  merged: string[];
  deletedLocal: string[];
  deletedRemote: string[];
  conflicts: string[];
  failed: Array<{ path: string; error: string }>;
}

export interface MirrorStatus {
  state: 'starting' | 'idle' | 'syncing' | 'error' | 'stopped';
  lastSync?: string;
  error?: string;
  conflicts: string[];
}

export interface MirrorOptions {
  service: OverleafService;
  projectId: string;
  dir: string;
  logger: Logger;
  onStatus?: (status: MirrorStatus) => void;
  /** Called after each sync step that changed something. */
  onReport?: (report: SyncReport) => void;
  /** Full download-and-compare as a safety net (default 10 minutes). */
  reconcileIntervalMs?: number;
  /** How long to wait for a burst of local writes to settle (default 400 ms). */
  localDebounceMs?: number;
}

/** Git's blob hash; Overleaf identifies uploaded files the same way. */
export function gitBlobHash(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

const toBytes = (text: string) => Buffer.from(text, 'utf8');

/** Puts conflict markers around the region where the two versions differ. */
export function conflictText(local: string, remote: string): string {
  const a = local.split('\n');
  const b = remote.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return [...a.slice(0, start), '<<<<<<< local (this computer)', ...a.slice(start, endA), '=======', ...b.slice(start, endB), '>>>>>>> overleaf', ...a.slice(endA)].join('\n');
}

const CONFLICT_START = /^<<<<<<< local \(this computer\)$/m;
const CONFLICT_END = /^>>>>>>> overleaf$/m;

export function hasConflictMarkers(text: string): boolean {
  return CONFLICT_START.test(text) && CONFLICT_END.test(text);
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Why a project path cannot exist as a file on this computer, if it cannot. */
export function localNameProblem(filePath: string, platform: NodeJS.Platform = process.platform): string | undefined {
  for (const segment of filePath.split('/')) {
    if (/[\x00-\x1f]/.test(segment)) return 'it contains control characters';
    if (platform !== 'win32') continue;
    const bad = /[<>:"|?*]/.exec(segment);
    if (bad) return `"${bad[0]}" is not allowed in Windows file names`;
    if (/[. ]$/.test(segment)) return 'Windows file names cannot end with a dot or space';
    if (WINDOWS_RESERVED.test(segment)) return `"${segment}" is a reserved name on Windows`;
  }
  return undefined;
}

/**
 * On case-insensitive file systems (Windows, macOS) two project paths that differ only in case
 * would land in the same local file or folder. Returns the paths that collide.
 */
export function caseCollisions(paths: Iterable<string>, platform: NodeJS.Platform = process.platform): Set<string> {
  const collisions = new Set<string>();
  if (platform !== 'win32' && platform !== 'darwin') return collisions;
  const spellings = new Map<string, Set<string>>();
  const note = (key: string, spelling: string) => {
    if (!spellings.has(key)) spellings.set(key, new Set());
    spellings.get(key)!.add(spelling);
  };
  const all = [...paths];
  for (const filePath of all) {
    const parts = filePath.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      note(prefix.toLowerCase(), prefix);
    }
  }
  for (const filePath of all) {
    const parts = filePath.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      if ((spellings.get(prefix.toLowerCase())?.size ?? 0) > 1) {
        collisions.add(filePath);
        break;
      }
    }
  }
  return collisions;
}

function emptyReport(): SyncReport {
  return { pulled: [], pushed: [], merged: [], deletedLocal: [], deletedRemote: [], conflicts: [], failed: [] };
}

function reportHasChanges(report: SyncReport): boolean {
  return Object.values(report).some((list) => list.length > 0);
}

/**
 * Keeps a local folder and an Overleaf project in sync in both directions. Each file is
 * compared three ways (local, Overleaf, last synced base): one-sided changes are copied across,
 * edits on both sides are merged, and true clashes get conflict markers.
 */
export class ProjectMirror {
  private state!: MirrorState;
  private ignored: (filePath: string) => boolean = () => false;
  private queue: Promise<unknown> = Promise.resolve();
  private watcher?: FSWatcher;
  private unsubscribe?: () => void;
  private reconcileTimer?: NodeJS.Timeout;
  private scanTimer?: NodeJS.Timeout;
  private readonly localTimers = new Map<string, NodeJS.Timeout>();
  private readonly docTimers = new Map<string, NodeJS.Timeout>();
  private treeTimer?: NodeJS.Timeout;
  private readonly seen = new Map<string, { mtimeMs: number; size: number }>();
  /** Hashes of what the mirror itself last wrote, so the watcher does not mistake it for a person's edit. */
  private readonly selfWrites = new Map<string, string>();
  /** Project paths that cannot exist on this computer (invalid names, case clashes); never synced. */
  private blocked = new Map<string, string>();
  private readonly reportedBlocked = new Set<string>();
  private stopped = false;
  status: MirrorStatus = { state: 'starting', conflicts: [] };

  constructor(private readonly options: MirrorOptions) {}

  get dir(): string {
    return this.options.dir;
  }

  get projectId(): string {
    return this.options.projectId;
  }

  private get stateFile(): string {
    return path.join(this.options.dir, STATE_DIR, 'state.json');
  }

  private baseFile(filePath: string): string {
    return resolveInside(path.join(this.options.dir, STATE_DIR, 'base'), filePath);
  }

  private backend(): Promise<SessionBackend> {
    return this.options.service.sessionBackend();
  }

  private setStatus(update: Partial<MirrorStatus>): void {
    this.status = { ...this.status, ...update };
    this.options.onStatus?.(this.status);
  }

  /** Serializes all sync work so local and remote events never interleave. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      if (this.stopped) throw new OverleafError('INVALID_INPUT', 'Sync stopped');
      this.setStatus({ state: 'syncing' });
      try {
        const result = await task();
        this.setStatus({ state: 'idle', error: undefined });
        return result;
      } catch (error) {
        this.setStatus({ state: 'error', error: errorMessage(error) });
        throw error;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /* -------------------------------------------------------------- lifecycle */

  async start(): Promise<SyncReport> {
    const { dir, projectId } = this.options;
    await fs.mkdir(path.join(dir, STATE_DIR), { recursive: true });
    const backend = await this.backend();
    const tree = await backend.getTree(projectId);
    const existing = await readJsonFile<MirrorState>(this.stateFile);
    if (existing && existing.projectId !== projectId) {
      throw new OverleafError('CONFLICT', `${dir} is already synced with a different Overleaf project (${existing.projectName})`);
    }
    const project = (await this.options.service.listProjects({ includeArchived: true })).find((p) => p.id === projectId);
    this.state = existing ?? { version: 1, projectId, projectName: project?.name ?? projectId, serverUrl: backend.web.serverUrl, files: {} };
    if (!(await pathExists(path.join(dir, IGNORE_FILE)))) await fs.writeFile(path.join(dir, IGNORE_FILE), defaultIgnore(tree.rootDocPath));
    this.ignored = await loadIgnoreMatcher(dir);

    const report = await this.enqueue(() => this.reconcile());

    try {
      this.watcher = watch(dir, { recursive: true }, (_event, filename) => {
        if (filename) this.onLocalEvent(filename.toString());
      });
      this.watcher.on('error', (error) => this.options.logger.warn(`File watcher error in ${dir}`, error));
    } catch (error) {
      this.options.logger.warn('Recursive file watching unavailable; relying on periodic scans', error);
    }
    this.unsubscribe = backend.pool.subscribe(projectId, {
      docChanged: (change) => this.onRemoteDoc(change.docId),
      treeChanged: () => this.onRemoteTree(),
      reconnected: () => void this.syncNow().catch(() => undefined),
    });
    this.scanTimer = setInterval(() => void this.enqueue(() => this.scanLocal()).catch(() => undefined), 30_000);
    this.reconcileTimer = setInterval(() => void this.syncNow().catch(() => undefined), this.options.reconcileIntervalMs ?? 10 * 60_000);
    this.scanTimer.unref?.();
    this.reconcileTimer.unref?.();
    return report;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.watcher?.close();
    this.unsubscribe?.();
    clearInterval(this.reconcileTimer);
    clearInterval(this.scanTimer);
    clearTimeout(this.treeTimer);
    for (const timer of [...this.localTimers.values(), ...this.docTimers.values()]) clearTimeout(timer);
    await this.queue;
    this.setStatus({ state: 'stopped' });
  }

  /** Full three-way comparison of the whole project. */
  syncNow(): Promise<SyncReport> {
    return this.enqueue(() => this.reconcile());
  }

  /* -------------------------------------------------------------- state */

  private async saveState(): Promise<void> {
    this.state.lastSync = new Date().toISOString();
    await writeFileAtomic(this.stateFile, JSON.stringify(this.state, null, 2));
    this.setStatus({ lastSync: this.state.lastSync });
  }

  private hash(bytes: Uint8Array, type: FileType): string {
    return type === 'doc' ? gitBlobHash(toBytes(normalizeNewlines(decodeText(bytes)))) : gitBlobHash(bytes);
  }

  private async readBase(filePath: string): Promise<string | undefined> {
    try {
      return await fs.readFile(this.baseFile(filePath), 'utf8');
    } catch {
      return undefined;
    }
  }

  private async record(filePath: string, bytes: Uint8Array, type: FileType): Promise<void> {
    this.state.files[filePath] = { hash: this.hash(bytes, type), type };
    if (type === 'doc') await writeFileAtomic(this.baseFile(filePath), normalizeNewlines(decodeText(bytes)));
  }

  private async forget(filePath: string): Promise<void> {
    delete this.state.files[filePath];
    await fs.rm(this.baseFile(filePath), { force: true });
  }

  /* -------------------------------------------------------------- local files */

  private async readLocal(filePath: string): Promise<Uint8Array | undefined> {
    try {
      return await fs.readFile(resolveInside(this.options.dir, filePath));
    } catch (error) {
      if (isErrno(error, 'ENOENT', 'EISDIR', 'ENOTDIR')) return undefined;
      throw error;
    }
  }

  private async writeLocal(filePath: string, bytes: Uint8Array): Promise<void> {
    const target = resolveInside(this.options.dir, filePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await writeFileAtomic(target, bytes);
    } catch (error) {
      // Some editors hold files open on Windows, which blocks replacing them; write in place.
      if (!isErrno(error, 'EPERM', 'EBUSY', 'EACCES')) throw error;
      await fs.writeFile(target, bytes);
    }
    const stat = await fs.stat(target);
    this.seen.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size });
    this.selfWrites.set(filePath, gitBlobHash(bytes));
  }

  /** Remembers which remote paths can't be stored here, and reports each once. */
  private updateBlocked(remotePaths: Iterable<string>, report: SyncReport): void {
    const paths = [...remotePaths];
    const blocked = new Map<string, string>();
    for (const filePath of paths) {
      const problem = localNameProblem(filePath);
      if (problem) blocked.set(filePath, problem);
    }
    for (const filePath of caseCollisions(paths)) {
      if (!blocked.has(filePath)) blocked.set(filePath, 'another file or folder in the project differs from it only in upper/lower case');
    }
    this.blocked = blocked;
    for (const [filePath, problem] of blocked) {
      if (this.reportedBlocked.has(filePath)) continue;
      this.reportedBlocked.add(filePath);
      report.failed.push({ path: filePath, error: `not synced to this computer: ${problem}` });
    }
  }

  private async deleteLocal(filePath: string): Promise<void> {
    await fs.rm(resolveInside(this.options.dir, filePath), { force: true });
    this.seen.delete(filePath);
    this.selfWrites.delete(filePath);
  }

  private async localFiles(): Promise<Map<string, Uint8Array>> {
    const files = new Map<string, Uint8Array>();
    for (const file of await walkFiles(this.options.dir)) {
      if (this.ignored(file)) continue;
      const bytes = await this.readLocal(file);
      if (bytes) files.set(file, bytes);
    }
    return files;
  }

  /* -------------------------------------------------------------- remote side */

  private async readRemote(filePath: string): Promise<{ bytes?: Uint8Array; type?: FileType }> {
    const backend = await this.backend();
    const realtime = await backend.pool.get(this.options.projectId);
    const entry = realtime.tree.find(filePath);
    if (!entry || entry.type === 'folder') return {};
    if (entry.type === 'doc') return { bytes: toBytes((await realtime.readDoc(entry.id)).text), type: 'doc' };
    return { bytes: await backend.web.downloadFile(this.options.projectId, entry.id, entry.hash), type: 'file' };
  }

  private async pushLocal(filePath: string, local: Uint8Array, type: FileType, report: SyncReport): Promise<void> {
    const backend = await this.backend();
    if (type === 'file') {
      await backend.writeBinary(this.options.projectId, filePath, local);
      await this.record(filePath, local, 'file');
      report.pushed.push(filePath);
      return;
    }
    const ours = normalizeNewlines(decodeText(local));
    if (hasConflictMarkers(ours)) {
      // Unresolved conflict: never upload the markers.
      if (!report.conflicts.includes(filePath)) report.conflicts.push(filePath);
      this.setStatus({ conflicts: [...new Set([...this.status.conflicts, filePath])] });
      return;
    }
    const base = await this.readBase(filePath);
    try {
      const result = await backend.updateText(
        this.options.projectId,
        filePath,
        (current) => {
          if (base === undefined || current === base || current === ours) return ours;
          const merge = threeWayMerge(base, ours, current);
          if (!merge.clean) throw new OverleafError('CONFLICT', 'conflicting edits');
          return merge.merged;
        },
        { createIfMissing: true },
      );
      this.setStatus({ conflicts: this.status.conflicts.filter((c) => c !== filePath) });
      if (result.after !== ours) {
        try {
          await this.writeLocal(filePath, toBytes(result.after));
        } catch (error) {
          // The local file still holds our version: record that, so the merge is pulled next time.
          await this.record(filePath, toBytes(ours), 'doc');
          throw error;
        }
        await this.record(filePath, toBytes(result.after), 'doc');
        report.merged.push(filePath);
      } else {
        await this.record(filePath, toBytes(result.after), 'doc');
        report.pushed.push(filePath);
      }
    } catch (error) {
      if (!(error instanceof OverleafError) || error.code !== 'CONFLICT') throw error;
      const { bytes } = await this.readRemote(filePath);
      await this.markConflict(filePath, ours, bytes ? decodeText(bytes) : '', report);
    }
  }

  private async deleteRemote(filePath: string): Promise<void> {
    try {
      await (await this.backend()).deletePath(this.options.projectId, filePath);
    } catch (error) {
      if (!(error instanceof OverleafError) || error.code !== 'NOT_FOUND') throw error;
    }
  }

  /** Writes conflict markers locally. The remote text becomes the base, so the person's resolution is pushed when saved. */
  private async markConflict(filePath: string, local: string, remote: string, report: SyncReport): Promise<void> {
    await this.writeLocal(filePath, toBytes(conflictText(local, remote)));
    await this.record(filePath, toBytes(remote), 'doc');
    report.conflicts.push(filePath);
    this.setStatus({ conflicts: [...new Set([...this.status.conflicts, filePath])] });
  }

  /* -------------------------------------------------------------- decisions */

  private async reconcilePath(filePath: string, local: Uint8Array | undefined, remote: Uint8Array | undefined, knownType: FileType | undefined, report: SyncReport): Promise<void> {
    // Paths this computer can't store are left alone on both sides (and never treated as deleted).
    if (this.blocked.has(filePath)) return;
    const sample = local ?? remote;
    const type: FileType = knownType ?? this.state.files[filePath]?.type ?? (sample && isTextContent(filePath, sample) ? 'doc' : 'file');
    const hLocal = local ? this.hash(local, type) : undefined;
    const hRemote = remote ? this.hash(remote, type) : undefined;
    const hBase = this.state.files[filePath]?.hash;

    if (hLocal === hRemote) {
      if (hLocal === undefined) await this.forget(filePath);
      else if (hBase !== hLocal) await this.record(filePath, remote!, type);
      return;
    }
    if (hLocal === hBase) {
      // Only Overleaf changed.
      if (!remote) {
        await this.deleteLocal(filePath);
        await this.forget(filePath);
        report.deletedLocal.push(filePath);
      } else {
        await this.writeLocal(filePath, remote);
        await this.record(filePath, remote, type);
        report.pulled.push(filePath);
      }
      return;
    }
    if (hRemote === hBase) {
      // Only this computer changed.
      if (!local) {
        await this.deleteRemote(filePath);
        await this.forget(filePath);
        report.deletedRemote.push(filePath);
      } else {
        await this.pushLocal(filePath, local, type, report);
      }
      return;
    }
    // Both sides changed.
    if (!local) {
      // Deleted here but edited on Overleaf: keep their work.
      await this.writeLocal(filePath, remote!);
      await this.record(filePath, remote!, type);
      report.pulled.push(filePath);
      return;
    }
    if (!remote) {
      // Deleted on Overleaf but edited here: put it back.
      await this.pushLocal(filePath, local, type, report);
      return;
    }
    if (type === 'doc') {
      const base = (await this.readBase(filePath)) ?? '';
      const ours = normalizeNewlines(decodeText(local));
      const theirs = normalizeNewlines(decodeText(remote));
      const merge = threeWayMerge(base, ours, theirs);
      if (!merge.clean) {
        await this.markConflict(filePath, ours, theirs, report);
        return;
      }
      // Local first: if that fails nothing is recorded and the merge is simply retried.
      await this.writeLocal(filePath, toBytes(merge.merged));
      await this.record(filePath, remote, 'doc');
      await this.pushLocal(filePath, toBytes(merge.merged), 'doc', report);
      report.pushed = report.pushed.filter((p) => p !== filePath);
      if (!report.merged.includes(filePath)) report.merged.push(filePath);
      return;
    }
    // Binary clash: Overleaf's version wins; the local one is kept next to the sync state.
    const aside = resolveInside(path.join(this.options.dir, STATE_DIR, 'conflicts'), `${filePath}.${Date.now()}`);
    await fs.mkdir(path.dirname(aside), { recursive: true });
    await fs.writeFile(aside, local);
    await this.writeLocal(filePath, remote);
    await this.record(filePath, remote, 'file');
    report.conflicts.push(filePath);
  }

  private async guarded(filePath: string, report: SyncReport, task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch (error) {
      this.options.logger.warn(`Sync of ${filePath} failed`, error);
      report.failed.push({ path: filePath, error: errorMessage(error) });
    }
  }

  private finish(report: SyncReport): SyncReport {
    if (reportHasChanges(report)) this.options.onReport?.(report);
    return report;
  }

  /** Downloads the whole project and settles every file. */
  private async reconcile(): Promise<SyncReport> {
    const report = emptyReport();
    const backend = await this.backend();
    const tree = await backend.getTree(this.options.projectId);
    const remoteTypes = new Map(tree.entries.filter((e) => e.type !== 'folder').map((e) => [e.path, e.type as FileType]));
    const remote = new Map<string, Uint8Array>();
    for (const [name, bytes] of Object.entries(unzipSync(await backend.web.downloadZip(this.options.projectId)))) {
      if (name.endsWith('/')) continue;
      const filePath = normalizeProjectPath(name);
      if (!this.ignored(filePath)) remote.set(filePath, bytes);
    }
    this.updateBlocked([...remote.keys(), ...tree.entries.map((e) => e.path)], report);
    for (const folder of tree.entries.filter((e) => e.type === 'folder' && !this.ignored(e.path) && !this.blocked.has(e.path))) {
      await fs.mkdir(resolveInside(this.options.dir, folder.path), { recursive: true });
    }
    const local = await this.localFiles();
    const paths = [...new Set([...remote.keys(), ...local.keys(), ...Object.keys(this.state.files)])].filter((p) => !this.ignored(p)).sort();
    for (const filePath of paths) {
      await this.guarded(filePath, report, () => this.reconcilePath(filePath, local.get(filePath), remote.get(filePath), remoteTypes.get(filePath), report));
    }
    await this.saveState();
    return this.finish(report);
  }

  /* -------------------------------------------------------------- events */

  private onLocalEvent(rawPath: string): void {
    let filePath: string;
    try {
      filePath = normalizeProjectPath(rawPath);
    } catch {
      return;
    }
    if (filePath === IGNORE_FILE) {
      void loadIgnoreMatcher(this.options.dir).then((matcher) => {
        this.ignored = matcher;
      });
      return;
    }
    if (!filePath || this.ignored(filePath)) return;
    clearTimeout(this.localTimers.get(filePath));
    this.localTimers.set(
      filePath,
      setTimeout(() => {
        this.localTimers.delete(filePath);
        void this.enqueue(() => this.syncLocalPath(filePath)).catch(() => undefined);
      }, this.options.localDebounceMs ?? 400),
    );
  }

  private async syncLocalPath(filePath: string): Promise<SyncReport> {
    const report = emptyReport();
    let stat: import('node:fs').Stats | undefined;
    try {
      stat = await fs.stat(resolveInside(this.options.dir, filePath));
    } catch {
      stat = undefined;
    }
    let files: string[];
    if (stat?.isDirectory()) {
      files = (await walkFiles(resolveInside(this.options.dir, filePath))).map((f) => `${filePath}/${f}`);
    } else if (!stat) {
      // A deleted file, or a deleted folder with everything in it.
      files = Object.keys(this.state.files).filter((f) => f === filePath || f.startsWith(`${filePath}/`));
    } else {
      files = [filePath];
    }
    for (const file of files.filter((f) => !this.ignored(f))) {
      await this.guarded(file, report, async () => {
        const local = await this.readLocal(file);
        // The mirror's own writes (pulls, merges, conflict markers) are not edits to send back.
        if (local && this.selfWrites.get(file) === gitBlobHash(local)) return;
        this.selfWrites.delete(file);
        const known = this.state.files[file];
        const type: FileType = known?.type ?? (local && isTextContent(file, local) ? 'doc' : 'file');
        if ((local ? this.hash(local, type) : undefined) === known?.hash) return;
        if (!local) {
          await this.deleteRemote(file);
          await this.forget(file);
          report.deletedRemote.push(file);
        } else {
          await this.pushLocal(file, local, type, report);
        }
      });
    }
    if (reportHasChanges(report)) await this.saveState();
    return this.finish(report);
  }

  /** Safety net for missed watcher events: rescans files whose size or mtime changed. */
  private async scanLocal(): Promise<SyncReport> {
    const changed: string[] = [];
    const present = new Set<string>();
    for (const file of await walkFiles(this.options.dir)) {
      if (this.ignored(file)) continue;
      present.add(file);
      const stat = await fs.stat(resolveInside(this.options.dir, file)).catch(() => undefined);
      if (!stat) continue;
      const previous = this.seen.get(file);
      this.seen.set(file, { mtimeMs: stat.mtimeMs, size: stat.size });
      if (!previous || previous.mtimeMs !== stat.mtimeMs || previous.size !== stat.size) changed.push(file);
    }
    for (const known of Object.keys(this.state.files)) if (!present.has(known)) changed.push(known);
    const report = emptyReport();
    for (const file of changed) {
      const partial = await this.syncLocalPath(file);
      for (const key of Object.keys(report) as Array<keyof SyncReport>) (report[key] as unknown[]).push(...(partial[key] as unknown[]));
    }
    return report;
  }

  private onRemoteDoc(docId: string): void {
    clearTimeout(this.docTimers.get(docId));
    this.docTimers.set(
      docId,
      setTimeout(() => {
        this.docTimers.delete(docId);
        void this.enqueue(async () => {
          const report = emptyReport();
          const realtime = await (await this.backend()).pool.get(this.options.projectId);
          const filePath = realtime.tree.pathOf(docId);
          if (!filePath || this.ignored(filePath)) return report;
          const remote = toBytes((await realtime.readDoc(docId)).text);
          if (this.hash(remote, 'doc') === this.state.files[filePath]?.hash) return report;
          await this.guarded(filePath, report, async () => this.reconcilePath(filePath, await this.readLocal(filePath), remote, 'doc', report));
          await this.saveState();
          return this.finish(report);
        }).catch(() => undefined);
      }, 500),
    );
  }

  private onRemoteTree(): void {
    clearTimeout(this.treeTimer);
    this.treeTimer = setTimeout(() => {
      void this.enqueue(async () => {
        const report = emptyReport();
        const backend = await this.backend();
        const tree = await backend.getTree(this.options.projectId);
        const remoteFiles = new Map(tree.entries.filter((e) => e.type !== 'folder').map((e) => [e.path, e.type as FileType]));
        this.updateBlocked(tree.entries.map((e) => e.path), report);
        for (const folder of tree.entries.filter((e) => e.type === 'folder' && !this.ignored(e.path) && !this.blocked.has(e.path))) {
          await fs.mkdir(resolveInside(this.options.dir, folder.path), { recursive: true });
        }
        const added = [...remoteFiles.keys()].filter((p) => !this.state.files[p] && !this.ignored(p) && !this.blocked.has(p));
        const removed = Object.keys(this.state.files).filter((p) => !remoteFiles.has(p));
        for (const filePath of added) {
          await this.guarded(filePath, report, async () => {
            const { bytes, type } = await this.readRemote(filePath);
            await this.reconcilePath(filePath, await this.readLocal(filePath), bytes, type, report);
          });
        }
        for (const filePath of removed) {
          await this.guarded(filePath, report, async () => this.reconcilePath(filePath, await this.readLocal(filePath), undefined, this.state.files[filePath]?.type, report));
        }
        if (reportHasChanges(report)) await this.saveState();
        return this.finish(report);
      }).catch(() => undefined);
    }, 800);
  }
}
