import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { FileEntry, ProjectBackend, ProjectTreeInfo, SnapshotFiles, TextContent, UpdateTextOptions, UpdateTextResult } from '../backends/types';
import { guessRootFile } from '../latex/outline';
import { assertEditableText } from '../overleaf/ot';
import { ProjectSummary, Tag } from '../overleaf/types';
import { HistoryDiffResponse, HistoryUpdate, HistoryUpdatesResponse } from '../overleaf/webClient';
import { decodeText, isTextContent, isTextPath } from '../search/textFiles';
import { SkippedFile } from '../store/snapshotCache';
import { KeyedMutex } from '../util/concurrency';
import { withFileLock } from '../util/fileLock';
import { OverleafError, isErrno } from '../util/errors';
import { normalizeProjectPath, resolveInside, walkFiles } from '../util/fsx';
import { Logger } from '../util/log';
import { GitProjectConfig } from './projectsConfig';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const FETCH_INTERVAL_MS = 10_000;
const MAX_PUSH_ATTEMPTS = 3;

export interface GitBackendOptions {
  projects: GitProjectConfig[];
  /** Where working clones live (one per project). */
  workDir: string;
  locksDir: string;
  logger: Logger;
  /** Git bridge base URL; tests point this at a local directory of bare repos. */
  baseUrl?: string;
  author?: { name?: string; email?: string };
  /** Test seam: runs right before each push. */
  beforePush?: (projectId: string) => Promise<void>;
}

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Projects reached through Overleaf's Git bridge with per-project tokens (the original server's
 * mode, useful on headless machines). Every write is commit + push; a rejected push means
 * someone else changed the project, so we reset to their version and re-apply the edit.
 */
export class GitBackend implements ProjectBackend {
  readonly kind = 'git' as const;
  private readonly configs: Map<string, GitProjectConfig>;
  private readonly lastFetch = new Map<string, number>();
  private readonly remoteHeads = new Map<string, { at: number; head?: string }>();
  private readonly mutex = new KeyedMutex();
  private readonly baseUrl: string;

  constructor(private readonly options: GitBackendOptions) {
    this.configs = new Map(options.projects.map((p) => [p.projectId, p]));
    this.baseUrl = (options.baseUrl ?? process.env.OVERLEAF_GIT_URL ?? 'https://git.overleaf.com').replace(/\/+$/, '');
  }

  has(projectId: string): boolean {
    return this.configs.has(projectId);
  }

  private config(projectId: string): GitProjectConfig {
    const config = this.configs.get(projectId);
    if (!config) throw new OverleafError('NOT_FOUND', `Project ${projectId} is not configured with a Git token`);
    return config;
  }

  private remoteUrl(config: GitProjectConfig): string {
    return `${this.baseUrl}/${config.projectId}`;
  }

  private repoDir(projectId: string): string {
    return path.join(this.options.workDir, projectId);
  }

  /** Normalizes a project path and refuses anything inside the clone's .git directory. */
  private safePath(filePath: string): string {
    const normalized = normalizeProjectPath(filePath);
    const first = normalized.split('/')[0].toLowerCase().replace(/[. ]+$/, '');
    if (first === '.git') throw new OverleafError('INVALID_INPUT', `"${filePath}" is inside the Git metadata folder, which is not part of the project`);
    return normalized;
  }

  /** The token travels in git's environment-based config, never in argv or .git/config. */
  private env(config: GitProjectConfig): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      // Environment config outranks .git/config, so nothing planted in a clone can run commands.
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`git:${config.gitToken}`).toString('base64')}`,
      GIT_CONFIG_KEY_1: 'core.fsmonitor',
      GIT_CONFIG_VALUE_1: 'false',
      GIT_CONFIG_KEY_2: 'core.hooksPath',
      GIT_CONFIG_VALUE_2: path.join(this.options.workDir, '.no-hooks'),
    };
    const name = this.options.author?.name ?? process.env.OVERLEAF_GIT_AUTHOR_NAME ?? 'Overleaf MCP';
    const email = this.options.author?.email ?? process.env.OVERLEAF_GIT_AUTHOR_EMAIL ?? 'overleaf-mcp@localhost';
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = name;
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = email;
    return env;
  }

  private git(config: GitProjectConfig, args: string[], options: { cwd?: string; allowFailure?: boolean } = {}): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        { cwd: options.cwd ?? this.repoDir(config.projectId), env: this.env(config), windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? Number((error as { code: number }).code) : 1) : 0;
          if (error && isErrno(error, 'ENOENT')) {
            reject(new OverleafError('UNSUPPORTED', 'Git is not installed or not on PATH; it is needed for Git-token projects.'));
            return;
          }
          if (error && !options.allowFailure) {
            const detail = stderr.replace(/https?:\/\/[^\s]*@/g, 'https://***@').trim();
            if (/authentication failed|403|401/i.test(detail)) {
              reject(new OverleafError('FORBIDDEN', `Overleaf rejected the Git token for "${config.name}". Create a new token under Account Settings → Git Integration.`));
              return;
            }
            reject(new OverleafError('HTTP', `git ${args[0]} failed for "${config.name}": ${detail || error.message}`));
            return;
          }
          resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code });
        },
      );
    });
  }

  /** Runs `task` with the project's clone checked out at the latest remote state. */
  private withRepo<T>(projectId: string, task: (config: GitProjectConfig, dir: string) => Promise<T>, forceFetch = false): Promise<T> {
    const config = this.config(projectId);
    return this.mutex.run(projectId, () =>
      withFileLock(path.join(this.options.locksDir, `git-${projectId}.lock`), async () => {
        const dir = this.repoDir(projectId);
        await this.sync(config, dir, forceFetch);
        return task(config, dir);
      }),
    );
  }

  private async branch(config: GitProjectConfig, dir: string): Promise<string> {
    const head = await this.git(config, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: dir, allowFailure: true });
    return head.code === 0 && head.stdout.trim() ? head.stdout.trim().replace(/^origin\//, '') : 'master';
  }

  private async sync(config: GitProjectConfig, dir: string, force: boolean): Promise<void> {
    let cloned = false;
    try {
      await fs.access(path.join(dir, '.git'));
    } catch {
      await fs.mkdir(this.options.workDir, { recursive: true });
      await fs.rm(dir, { recursive: true, force: true });
      await this.git(config, ['clone', '--quiet', this.remoteUrl(config), dir], { cwd: this.options.workDir });
      cloned = true;
    }
    if (cloned || force || Date.now() - (this.lastFetch.get(config.projectId) ?? 0) > FETCH_INTERVAL_MS) {
      if (!cloned) await this.git(config, ['fetch', '--quiet', 'origin'], { cwd: dir });
      const branch = await this.branch(config, dir);
      // The clone is a cache: always match the remote exactly.
      await this.git(config, ['reset', '--hard', '--quiet', `origin/${branch}`], { cwd: dir, allowFailure: cloned });
      await this.git(config, ['clean', '-fdq'], { cwd: dir });
      this.lastFetch.set(config.projectId, Date.now());
    }
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return [...this.configs.values()].map((p) => ({ id: p.projectId, name: p.name, accessLevel: 'owner', source: 'git' }));
  }

  async listTags(): Promise<Tag[]> {
    return [];
  }

  async remoteVersion(project: ProjectSummary): Promise<string | undefined> {
    const cached = this.remoteHeads.get(project.id);
    if (cached && Date.now() - cached.at < FETCH_INTERVAL_MS) return cached.head;
    const config = this.config(project.id);
    const result = await this.git(config, ['ls-remote', this.remoteUrl(config), 'HEAD'], { cwd: process.cwd(), allowFailure: true });
    const head = result.code === 0 ? result.stdout.split(/\s/)[0] || undefined : undefined;
    this.remoteHeads.set(project.id, { at: Date.now(), head });
    return head;
  }

  private async entries(dir: string): Promise<FileEntry[]> {
    const files = (await walkFiles(dir)).filter((f) => !f.startsWith('.git/'));
    const folders = new Set<string>();
    for (const file of files) {
      const parts = file.split('/');
      for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
    }
    const entries: FileEntry[] = [...folders].map((p) => ({ path: p, type: 'folder' as const }));
    for (const file of files) entries.push({ path: file, type: isTextPath(file) === false ? 'file' : 'doc' });
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  getTree(projectId: string): Promise<ProjectTreeInfo> {
    return this.withRepo(projectId, async (_config, dir) => {
      const entries = await this.entries(dir);
      const tex = entries.filter((e) => e.type === 'doc' && e.path.toLowerCase().endsWith('.tex')).slice(0, 40);
      const withText = await Promise.all(tex.map(async (e) => ({ path: e.path, text: await fs.readFile(resolveInside(dir, e.path), 'utf8') })));
      return { entries, rootDocPath: guessRootFile(withText), permissionsLevel: 'owner (Git token)', canEdit: true };
    });
  }

  private async readRaw(dir: string, filePath: string, projectName: string): Promise<Buffer> {
    try {
      return await fs.readFile(resolveInside(dir, filePath));
    } catch (error) {
      if (isErrno(error, 'ENOENT')) throw new OverleafError('NOT_FOUND', `"${filePath}" does not exist in project "${projectName}"`);
      if (isErrno(error, 'EISDIR')) throw new OverleafError('INVALID_INPUT', `"${filePath}" is a folder`);
      throw error;
    }
  }

  readText(projectId: string, filePath: string): Promise<TextContent> {
    return this.withRepo(projectId, async (config, dir) => {
      const bytes = await this.readRaw(dir, this.safePath(filePath), config.name);
      if (!isTextContent(filePath, bytes)) throw new OverleafError('INVALID_INPUT', `"${filePath}" is a binary file (${bytes.byteLength} bytes), not text`);
      return { text: decodeText(bytes) };
    });
  }

  readBinary(projectId: string, filePath: string): Promise<Uint8Array> {
    return this.withRepo(projectId, async (config, dir) => this.readRaw(dir, this.safePath(filePath), config.name));
  }

  /** Stage → commit → push; on a rejected push, reset to the remote and run `change` again. */
  private async commitWithRetry(projectId: string, message: string, change: (dir: string, config: GitProjectConfig) => Promise<boolean>): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
      const pushed = await this.withRepo(
        projectId,
        async (config, dir) => {
          if (!(await change(dir, config))) return 'unchanged' as const;
          await this.git(config, ['add', '--all'], { cwd: dir });
          const status = await this.git(config, ['status', '--porcelain'], { cwd: dir });
          if (!status.stdout.trim()) return 'unchanged' as const;
          await this.git(config, ['commit', '--quiet', '-m', message], { cwd: dir });
          const branch = await this.branch(config, dir);
          await this.options.beforePush?.(projectId);
          const push = await this.git(config, ['push', '--quiet', 'origin', `HEAD:${branch}`], { cwd: dir, allowFailure: true });
          if (push.code === 0) return 'pushed' as const;
          // Only "someone pushed first" is worth retrying; other refusals would just repeat.
          if (/non-fast-forward|fetch first|stale info|\[rejected\]/i.test(push.stderr) && !/remote rejected/i.test(push.stderr)) {
            this.options.logger.info(`Push to "${config.name}" was rejected (remote changed); retrying (${attempt}/${MAX_PUSH_ATTEMPTS})`);
            return 'retry' as const;
          }
          throw new OverleafError('HTTP', `git push failed for "${config.name}": ${push.stderr.trim()}`);
        },
        true,
      );
      if (pushed === 'pushed') return true;
      if (pushed === 'unchanged') return false;
    }
    throw new OverleafError('CONFLICT', `The project kept changing while pushing; try the edit again`);
  }

  async updateText(projectId: string, filePath: string, mutate: (current: string) => string, options: UpdateTextOptions = {}): Promise<UpdateTextResult> {
    if (options.track) throw new OverleafError('UNSUPPORTED', 'Suggest mode (tracked changes) needs the Overleaf web session; Git-token projects get direct commits.');
    const normalized = this.safePath(filePath);
    let before = '';
    let after = '';
    let created = false;
    const changed = await this.commitWithRetry(projectId, options.message ?? `Update ${normalized}`, async (dir, config) => {
      const target = resolveInside(dir, normalized);
      created = false;
      try {
        const bytes = await fs.readFile(target);
        if (!isTextContent(normalized, bytes)) throw new OverleafError('INVALID_INPUT', `"${normalized}" is a binary file`);
        before = decodeText(bytes);
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
        if (!options.createIfMissing) throw new OverleafError('NOT_FOUND', `"${normalized}" does not exist in project "${config.name}"`);
        before = '';
        created = true;
      }
      after = mutate(before);
      if (after === before && !created) return false;
      assertEditableText(after, `Could not update ${normalized}`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, after, 'utf8');
      return true;
    });
    return { path: normalized, created, changed, before, after, via: 'git' };
  }

  async writeBinary(projectId: string, filePath: string, data: Uint8Array): Promise<void> {
    const normalized = this.safePath(filePath);
    await this.commitWithRetry(projectId, `Upload ${normalized}`, async (dir) => {
      const target = resolveInside(dir, normalized);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, data);
      return true;
    });
  }

  async createFolder(): Promise<void> {
    throw new OverleafError('UNSUPPORTED', 'Git cannot store empty folders; write a file into the new folder instead (folders are created automatically).');
  }

  async deletePath(projectId: string, filePath: string): Promise<void> {
    const normalized = this.safePath(filePath);
    await this.commitWithRetry(projectId, `Delete ${normalized}`, async (dir, config) => {
      const target = resolveInside(dir, normalized);
      try {
        await fs.access(target);
      } catch {
        throw new OverleafError('NOT_FOUND', `"${normalized}" does not exist in project "${config.name}"`);
      }
      await fs.rm(target, { recursive: true, force: true });
      return true;
    });
  }

  async movePath(projectId: string, from: string, to: string): Promise<void> {
    const source = this.safePath(from);
    const destination = this.safePath(to);
    await this.commitWithRetry(projectId, `Move ${source} to ${destination}`, async (dir, config) => {
      const target = resolveInside(dir, destination);
      try {
        await fs.access(target);
        throw new OverleafError('CONFLICT', `"${destination}" already exists`);
      } catch (error) {
        if (error instanceof OverleafError) throw error;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      try {
        await fs.rename(resolveInside(dir, source), target);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) throw new OverleafError('NOT_FOUND', `"${source}" does not exist in project "${config.name}"`);
        throw error;
      }
      return true;
    });
  }

  snapshot(projectId: string): Promise<SnapshotFiles> {
    return this.withRepo(projectId, async (config, dir) => {
      const files: Array<[string, Uint8Array]> = [];
      const skipped: SkippedFile[] = [];
      for (const file of await walkFiles(dir)) {
        if (file.startsWith('.git/')) continue;
        const bytes = await fs.readFile(resolveInside(dir, file));
        if (isTextContent(file, bytes) && bytes.byteLength <= 8 * 1024 * 1024) files.push([file, bytes]);
        else skipped.push({ path: file, size: bytes.byteLength });
      }
      const head = await this.git(config, ['rev-parse', 'HEAD'], { cwd: dir, allowFailure: true });
      return { files, skipped, version: head.stdout.trim() || undefined };
    });
  }

  /** Commit hashes in first-parent order; version N is the N-th commit (0 = empty project). */
  private async commits(config: GitProjectConfig, dir: string): Promise<string[]> {
    const result = await this.git(config, ['rev-list', '--first-parent', '--reverse', 'HEAD'], { cwd: dir, allowFailure: true });
    return result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  historyUpdates(projectId: string, options: { minCount?: number }): Promise<HistoryUpdatesResponse> {
    return this.withRepo(projectId, async (config, dir) => {
      const hashes = await this.commits(config, dir);
      const versionOf = new Map(hashes.map((hash, index) => [hash, index + 1]));
      const limit = Math.max(1, Math.min(options.minCount ?? 20, 200));
      const log = await this.git(config, ['log', '--first-parent', `-n${limit}`, '--name-only', '--format=%x1e%H%x1f%an%x1f%ae%x1f%at%x1f%s'], { cwd: dir, allowFailure: true });
      const updates: HistoryUpdate[] = [];
      for (const record of log.stdout.split('\x1e').map((r) => r.trim()).filter(Boolean)) {
        const [header, ...files] = record.split('\n');
        const [hash, name, email, at, subject] = header.split('\x1f');
        const version = versionOf.get(hash) ?? 0;
        updates.push({
          fromV: Math.max(0, version - 1),
          toV: version,
          meta: { users: [{ first_name: name, email }], start_ts: Number(at) * 1000, end_ts: Number(at) * 1000 },
          pathnames: files.map((f) => f.trim()).filter(Boolean),
          labels: subject ? [{ comment: `${subject} (${hash.slice(0, 8)})` }] : [],
        });
      }
      return { updates };
    });
  }

  historyDiff(projectId: string, filePath: string, from: number, to: number): Promise<HistoryDiffResponse> {
    return this.withRepo(projectId, async (config, dir) => {
      const hashes = await this.commits(config, dir);
      const ref = (version: number) => (version <= 0 ? EMPTY_TREE : hashes[Math.min(version, hashes.length) - 1]);
      const show = async (version: number) => {
        if (version <= 0) return '';
        const result = await this.git(config, ['show', `${ref(version)}:${normalizeProjectPath(filePath)}`], { cwd: dir, allowFailure: true });
        return result.code === 0 ? result.stdout : '';
      };
      const [before, after] = await Promise.all([show(from), show(to)]);
      return { diff: [{ d: before }, { i: after }] };
    });
  }

  close(): void {
    // Nothing persistent to close; clones stay on disk as a cache.
  }
}
