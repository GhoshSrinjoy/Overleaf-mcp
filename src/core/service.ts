import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { SessionBackend } from './backends/session';
import { GitBackend } from './git/gitBackend';
import { GitProjectConfig } from './git/projectsConfig';
import { CompileOutput, FileEntry, ProjectBackend, ProjectTreeInfo, TextContent, UpdateTextResult } from './backends/types';
import { LogEntry, ParsedLog, parseBibtexLog, parseLatexLog } from './latex/logParser';
import { ProjectOutline, SectionSlice, buildProjectOutline, findHeading, guessRootFile, parseHeadings, sliceSection } from './latex/outline';
import { SESSION_COOKIE_NAMES } from './overleaf/cookies';
import { TextEdit, applyTextEdits, normalizeNewlines } from './overleaf/ot';
import { BuildRef, CodeLocation, PdfLocation, ProjectSummary, Tag } from './overleaf/types';
import { HistoryUpdate, OverleafWebClient } from './overleaf/webClient';
import { jsSearch } from './search/jsGrep';
import { Chunk, LexicalHit, LexicalIndex, buildChunks } from './search/lexical';
import { RipgrepRegexError, locateRipgrep, ripgrepSearch } from './search/ripgrep';
import { decodeText } from './search/textFiles';
import { GrepOptions, GrepResult, SearchTarget } from './search/types';
import { StoredSession } from './store/credentials';
import { DataPaths } from './store/paths';
import { SettingsStore } from './store/settings';
import { SnapshotCache } from './store/snapshotCache';
import { mapLimit, sleep } from './util/concurrency';
import { OverleafError, errorMessage, notLoggedIn } from './util/errors';
import { normalizeProjectPath, walkFiles, writeFileAtomic } from './util/fsx';
import { Logger } from './util/log';
import { unifiedDiff } from './util/unifiedDiff';

export interface SignInRequest {
  /** Browser sign-in unless a cookie is given. */
  cookie?: string;
  serverUrl?: string;
}

/** Supplies the Overleaf session; consulted before each operation so a new sign-in is picked up. */
export interface SessionSource {
  load(): Promise<StoredSession | undefined>;
  /** Overleaf rotated cookies; persist them if this source owns storage. */
  save?(session: StoredSession): Promise<void>;
  /** Signs in interactively and stores the result (lets AI clients sign in through a tool). */
  signIn?(request: SignInRequest): Promise<StoredSession>;
}

/**
 * SyncTeX names files relative to the main document's folder: with the main file at
 * folder/main.tex, folder/intro.tex is known as folder/./intro.tex.
 */
export function synctexPath(filePath: string, rootPath?: string): string {
  const slash = rootPath?.lastIndexOf('/') ?? -1;
  const rootDir = slash > 0 ? rootPath!.slice(0, slash) : '';
  if (rootDir && filePath.startsWith(`${rootDir}/`)) return `${rootDir}/.${filePath.slice(rootDir.length)}`;
  return filePath;
}

/** Compile statuses that mean "try again in a moment". */
const BUSY_COMPILE = new Set(['too-recently-compiled', 'compile-in-progress']);

export interface ServiceOptions {
  paths: DataPaths;
  logger: Logger;
  session: SessionSource;
  /** Extra places to look for ripgrep (e.g. the copy bundled with VS Code). */
  ripgrepCandidates?: string[];
  /** Snapshots older than this are re-downloaded even if Overleaf reports no change. */
  maxCacheAgeMs?: number;
  /** Projects reachable through Overleaf's Git bridge with tokens (projects.json). */
  gitProjects?: GitProjectConfig[];
  /** Git bridge URL override (tests). */
  gitBaseUrl?: string;
}

export interface ProjectInfo extends ProjectSummary {
  pinned: boolean;
  tags: string[];
  /** Local folder kept in two-way sync with the project, if any. */
  localDir?: string;
}

export type ProjectSelector = string[] | 'all' | undefined;

const PROJECT_ID = /^[0-9a-f]{24}$/i;
const PROJECT_LIST_TTL_MS = 30_000;
/** Projects searched by default when none are pinned and none are named. */
const DEFAULT_SEARCH_PROJECTS = 25;

/** Pulls a project id out of an Overleaf URL such as https://www.overleaf.com/project/<id>. */
export function projectIdFromRef(ref: string): string | undefined {
  const trimmed = ref.trim();
  if (PROJECT_ID.test(trimmed)) return trimmed.toLowerCase();
  return /\/project\/([0-9a-f]{24})/i.exec(trimmed)?.[1]?.toLowerCase();
}

/** Identifies a login: server + session cookie value (other cookies may rotate freely). */
export function sessionKey(session: StoredSession): string {
  const pairs = new Map(
    session.cookies.split(';').map((part) => {
      const eq = part.indexOf('=');
      return [part.slice(0, eq).trim(), part.slice(eq + 1).trim()] as [string, string];
    }),
  );
  const sessionCookie = SESSION_COOKIE_NAMES.map((name) => pairs.get(name)).find(Boolean);
  return `${session.serverUrl}|${sessionCookie ?? session.cookies}`;
}

function ambiguous(ref: string, matches: ProjectSummary[]): OverleafError {
  const list = matches.slice(0, 8).map((p) => `"${p.name}" (${p.id})`).join(', ');
  return new OverleafError('AMBIGUOUS', `"${ref}" matches several projects: ${list}. Use the project id or a more specific name.`);
}

/**
 * Picks the project a person or AI means by name: exact (case-insensitive) first, then a unique
 * substring, then all words present. Archived/trashed projects only win if nothing else matches.
 */
export function matchProject(projects: readonly ProjectSummary[], ref: string): ProjectSummary {
  const wanted = ref.trim().toLowerCase();
  const active = (list: ProjectSummary[]) => {
    const live = list.filter((p) => !p.archived && !p.trashed);
    return live.length ? live : list;
  };
  const exact = active(projects.filter((p) => p.name.toLowerCase() === wanted));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw ambiguous(ref, exact);

  const partial = active(projects.filter((p) => p.name.toLowerCase().includes(wanted)));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw ambiguous(ref, partial);

  const words = wanted.split(/\s+/).filter(Boolean);
  const byWords = active(projects.filter((p) => words.every((w) => p.name.toLowerCase().includes(w))));
  if (byWords.length === 1) return byWords[0];
  if (byWords.length > 1) throw ambiguous(ref, byWords);

  const close = projects
    .map((p) => ({ p, score: words.filter((w) => p.name.toLowerCase().includes(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => `"${x.p.name}"`);
  throw new OverleafError('NOT_FOUND', `No project matches "${ref}".${close.length ? ` Closest: ${close.join(', ')}.` : ' Use list_projects to see all projects.'}`);
}

export class OverleafService {
  readonly paths: DataPaths;
  readonly settings: SettingsStore;
  readonly cache: SnapshotCache;
  private readonly logger: Logger;
  private readonly sessionSource: SessionSource;
  private readonly maxCacheAgeMs: number;
  private state?: { key: string; session: StoredSession; backend: SessionBackend };
  private projectList?: { at: number; projects: ProjectSummary[]; tags: Tag[]; sessionIds: Set<string> };
  private readonly git?: GitBackend;
  private ripgrep?: { path?: string; checked: number };
  private lexicalIndexes = new Map<string, LexicalIndex>();

  constructor(private readonly options: ServiceOptions) {
    this.paths = options.paths;
    this.logger = options.logger;
    this.sessionSource = options.session;
    this.settings = new SettingsStore(options.paths.settingsFile);
    this.cache = new SnapshotCache(options.paths.cacheDir, options.paths.locksDir, options.logger);
    this.maxCacheAgeMs = options.maxCacheAgeMs ?? 24 * 60 * 60_000;
    if (options.gitProjects?.length) {
      this.git = new GitBackend({
        projects: options.gitProjects,
        workDir: path.join(options.paths.root, 'git'),
        locksDir: options.paths.locksDir,
        logger: options.logger,
        baseUrl: options.gitBaseUrl,
      });
    }
  }

  /* ------------------------------------------------------------------ session */

  async sessionBackend(): Promise<SessionBackend> {
    const session = await this.sessionSource.load();
    if (!session) throw notLoggedIn();
    const key = sessionKey(session);
    if (this.state?.key === key) return this.state.backend;

    this.state?.backend.close();
    this.projectList = undefined;
    const web = new OverleafWebClient({
      serverUrl: session.serverUrl,
      cookies: session.cookies,
      logger: this.logger,
      onCookiesChanged: (cookies) => {
        const updated = { ...session, cookies, savedAt: new Date().toISOString() };
        void this.sessionSource.save?.(updated).catch((error) => this.logger.debug('Could not persist refreshed cookies', error));
      },
    });
    this.state = { key, session, backend: new SessionBackend(web, this.logger, session.userId) };
    return this.state.backend;
  }

  /** The live web session serves every project it can see; Git tokens cover the rest. */
  async backendFor(project: ProjectSummary): Promise<ProjectBackend> {
    if (this.git?.has(project.id)) {
      const viaSession = this.projectList?.sessionIds.has(project.id) && (await this.sessionSource.load());
      if (!viaSession) return this.git;
    }
    return this.sessionBackend();
  }

  async status(): Promise<{
    signedIn: boolean;
    serverUrl?: string;
    email?: string;
    userId?: string;
    error?: string;
    pinned: ProjectSummary[];
    gitProjects: number;
    ripgrep?: string;
    dataDir: string;
  }> {
    const base = { dataDir: this.paths.root, ripgrep: await this.ripgrepPath(), pinned: [] as ProjectSummary[], gitProjects: (await this.git?.listProjects())?.length ?? 0 };
    try {
      if (this.git && !(await this.sessionSource.load())) {
        const pinnedIds = (await this.settings.read()).pinnedProjects;
        const projects = await this.allProjects();
        return { ...base, signedIn: false, error: 'not signed in; using Git tokens only', pinned: projects.filter((p) => pinnedIds.includes(p.id)) };
      }
      const backend = await this.sessionBackend();
      const info = await backend.web.verifySession();
      const projects = await this.allProjects();
      const pinnedIds = (await this.settings.read()).pinnedProjects;
      return {
        ...base,
        signedIn: true,
        serverUrl: backend.web.serverUrl,
        email: info.email,
        userId: info.userId,
        pinned: projects.filter((p) => pinnedIds.includes(p.id)),
      };
    } catch (error) {
      return { ...base, signedIn: false, error: errorMessage(error) };
    }
  }

  /* ------------------------------------------------------------------ projects */

  private async allProjects(refresh = false): Promise<ProjectSummary[]> {
    if (!refresh && this.projectList && Date.now() - this.projectList.at < PROJECT_LIST_TTL_MS) return this.projectList.projects;
    let projects: ProjectSummary[] = [];
    let tags: Tag[] = [];
    const signedIn = !!(await this.sessionSource.load());
    if (signedIn || !this.git) {
      const backend = await this.sessionBackend();
      [projects, tags] = await Promise.all([backend.listProjects(), backend.listTags().catch(() => [] as Tag[])]);
    }
    const sessionIds = new Set(projects.map((p) => p.id));
    for (const project of (await this.git?.listProjects()) ?? []) {
      if (!sessionIds.has(project.id)) projects.push(project);
    }
    this.projectList = { at: Date.now(), projects, tags, sessionIds };
    return projects;
  }

  async listProjects(options: { query?: string; includeArchived?: boolean; includeTrashed?: boolean; tag?: string; refresh?: boolean } = {}): Promise<ProjectInfo[]> {
    const projects = await this.allProjects(options.refresh);
    const tags = this.projectList?.tags ?? [];
    const settings = await this.settings.read();
    const pinned = new Set(settings.pinnedProjects);
    const mirrors = new Map((settings.mirrors ?? []).map((m) => [m.projectId, m.dir]));
    const query = options.query?.trim().toLowerCase();
    const tag = options.tag?.trim().toLowerCase();
    return projects
      .map((p) => ({ ...p, pinned: pinned.has(p.id), localDir: mirrors.get(p.id), tags: tags.filter((t) => t.projectIds.includes(p.id)).map((t) => t.name) }))
      .filter((p) => options.includeArchived || !p.archived)
      .filter((p) => options.includeTrashed || !p.trashed)
      .filter((p) => !query || p.name.toLowerCase().includes(query) || p.id === query)
      .filter((p) => !tag || p.tags.some((t) => t.toLowerCase() === tag))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastUpdated ?? '').localeCompare(a.lastUpdated ?? ''));
  }

  /** Finds a project by id, URL, exact name or an unambiguous part of its name. */
  async resolveProject(ref: string | undefined): Promise<ProjectSummary> {
    if (!ref?.trim()) {
      const pinned = await this.pinnedProjects();
      if (pinned.length === 1) return pinned[0];
      throw new OverleafError(
        'INVALID_INPUT',
        pinned.length
          ? `Several projects are pinned (${pinned.map((p) => `"${p.name}"`).join(', ')}); say which project to use.`
          : 'No project given. Pass a project name or id (list_projects shows them), or pin a project in the Overleaf panel.',
      );
    }
    const projects = await this.allProjects();
    const id = projectIdFromRef(ref);
    if (id) {
      const match = projects.find((p) => p.id === id);
      if (match) return match;
      // Possibly shared by link and absent from the dashboard; let the server decide.
      return { id, name: id };
    }

    return matchProject(projects, ref);
  }

  async pinnedProjects(): Promise<ProjectSummary[]> {
    const pinned = (await this.settings.read()).pinnedProjects;
    if (!pinned.length) return [];
    const projects = await this.allProjects();
    return pinned.map((id) => projects.find((p) => p.id === id)).filter((p): p is ProjectSummary => !!p);
  }

  async setPinned(refs: string[], pinned: boolean): Promise<ProjectSummary[]> {
    const projects = await Promise.all(refs.map((ref) => this.resolveProject(ref)));
    await this.settings.update((settings) => {
      const ids = new Set(settings.pinnedProjects);
      for (const project of projects) {
        if (pinned) ids.add(project.id);
        else ids.delete(project.id);
      }
      return { ...settings, pinnedProjects: [...ids] };
    });
    return this.pinnedProjects();
  }

  /** Projects a multi-project tool should cover: explicit list, 'all', or the pinned ones. */
  async resolveSelection(selector: ProjectSelector): Promise<{ projects: ProjectSummary[]; note?: string }> {
    if (Array.isArray(selector) && selector.length && !(selector.length === 1 && ['all', '*'].includes(selector[0]))) {
      const resolved = await Promise.all(selector.map((ref) => this.resolveProject(ref)));
      return { projects: [...new Map(resolved.map((p) => [p.id, p])).values()] };
    }
    const all = (await this.allProjects()).filter((p) => !p.archived && !p.trashed);
    if (selector === 'all' || Array.isArray(selector)) return { projects: all };
    const pinned = await this.pinnedProjects();
    if (pinned.length) return { projects: pinned, note: `Searched the ${pinned.length} pinned project(s). Pass projects: "all" to search everything.` };
    // Without pins, the most recently touched projects keep the first search quick on large accounts.
    if (all.length <= DEFAULT_SEARCH_PROJECTS) return { projects: all, note: `No projects are pinned, so all ${all.length} active projects were searched.` };
    const recent = [...all].sort((a, b) => (b.lastUpdated ?? '').localeCompare(a.lastUpdated ?? '')).slice(0, DEFAULT_SEARCH_PROJECTS);
    return {
      projects: recent,
      note: `No projects are pinned, so the ${DEFAULT_SEARCH_PROJECTS} most recently updated of ${all.length} projects were searched. Pass projects: "all" (or specific names) to widen it.`,
    };
  }

  async createProject(name: string, template: 'none' | 'example' = 'none'): Promise<ProjectSummary> {
    const backend = await this.sessionBackend();
    const id = await backend.createProject(name, template);
    this.projectList = undefined;
    return (await this.allProjects(true)).find((p) => p.id === id) ?? { id, name };
  }

  /* ------------------------------------------------------------------ files */

  async listFiles(ref: string | undefined): Promise<{ project: ProjectSummary; tree: ProjectTreeInfo }> {
    const project = await this.resolveProject(ref);
    const tree = await (await this.backendFor(project)).getTree(project.id);
    return { project, tree };
  }

  async readFile(ref: string | undefined, filePath: string): Promise<{ project: ProjectSummary; path: string; content: TextContent }> {
    const project = await this.resolveProject(ref);
    const normalized = normalizeProjectPath(filePath);
    const content = await (await this.backendFor(project)).readText(project.id, normalized);
    return { project, path: normalized, content };
  }

  async readBinaryFile(ref: string | undefined, filePath: string): Promise<{ project: ProjectSummary; path: string; data: Uint8Array }> {
    const project = await this.resolveProject(ref);
    const normalized = normalizeProjectPath(filePath);
    return { project, path: normalized, data: await (await this.backendFor(project)).readBinary(project.id, normalized) };
  }

  private async afterWrite(project: ProjectSummary, result: UpdateTextResult): Promise<void> {
    if (!result.changed) return;
    await this.cache.writeFile(project.id, result.path, result.after).catch(() => undefined);
    this.lexicalIndexes.clear();
  }

  async editFile(
    ref: string | undefined,
    filePath: string,
    edits: TextEdit[],
    options: { dryRun?: boolean; suggest?: boolean } = {},
  ): Promise<{ project: ProjectSummary; result: UpdateTextResult; replacements: number; diff: string }> {
    if (!edits.length) throw new OverleafError('INVALID_INPUT', 'No edits given');
    const project = await this.resolveProject(ref);
    const backend = await this.backendFor(project);
    let replacements = 0;
    const mutate = (current: string) => {
      const applied = applyTextEdits(current, edits);
      replacements = applied.replacements;
      return applied.text;
    };
    if (options.dryRun) {
      const { text } = await backend.readText(project.id, filePath);
      const after = mutate(text);
      const result: UpdateTextResult = { path: normalizeProjectPath(filePath), created: false, changed: after !== text, before: text, after, via: 'realtime' };
      return { project, result, replacements, diff: unifiedDiff(text, after, { label: result.path }) };
    }
    const result = await backend.updateText(project.id, filePath, mutate, { track: options.suggest });
    await this.afterWrite(project, result);
    return { project, result, replacements, diff: unifiedDiff(result.before, result.after, { label: result.path }) };
  }

  async writeFile(
    ref: string | undefined,
    filePath: string,
    content: string,
    options: { suggest?: boolean; overwrite?: boolean } = {},
  ): Promise<{ project: ProjectSummary; result: UpdateTextResult; diff: string }> {
    const project = await this.resolveProject(ref);
    const backend = await this.backendFor(project);
    const text = normalizeNewlines(content);
    const result = await backend.updateText(
      project.id,
      filePath,
      (current) => {
        if (current && options.overwrite === false) throw new OverleafError('CONFLICT', `"${filePath}" already exists (overwrite is false)`);
        return text;
      },
      { createIfMissing: true, track: options.suggest },
    );
    await this.afterWrite(project, result);
    return { project, result, diff: result.created ? '' : unifiedDiff(result.before, result.after, { label: result.path }) };
  }

  async uploadFile(ref: string | undefined, filePath: string, data: Uint8Array): Promise<{ project: ProjectSummary; path: string }> {
    const project = await this.resolveProject(ref);
    const normalized = normalizeProjectPath(filePath);
    await (await this.backendFor(project)).writeBinary(project.id, normalized, data);
    return { project, path: normalized };
  }

  async deleteFile(ref: string | undefined, filePath: string): Promise<ProjectSummary> {
    const project = await this.resolveProject(ref);
    const normalized = normalizeProjectPath(filePath);
    await (await this.backendFor(project)).deletePath(project.id, normalized);
    await this.cache.removeFile(project.id, normalized).catch(() => undefined);
    this.lexicalIndexes.clear();
    return project;
  }

  async moveFile(ref: string | undefined, from: string, to: string): Promise<ProjectSummary> {
    const project = await this.resolveProject(ref);
    await (await this.backendFor(project)).movePath(project.id, normalizeProjectPath(from), normalizeProjectPath(to));
    await this.cache.moveFile(project.id, normalizeProjectPath(from), normalizeProjectPath(to)).catch(() => undefined);
    this.lexicalIndexes.clear();
    return project;
  }

  async createFolder(ref: string | undefined, folderPath: string): Promise<ProjectSummary> {
    const project = await this.resolveProject(ref);
    await (await this.backendFor(project)).createFolder(project.id, normalizeProjectPath(folderPath));
    return project;
  }

  /* ------------------------------------------------------------------ search */

  private async ripgrepPath(): Promise<string | undefined> {
    if (this.ripgrep && Date.now() - this.ripgrep.checked < 60_000) return this.ripgrep.path;
    const settings = await this.settings.read();
    const found = await locateRipgrep([process.env.OVERLEAF_MCP_RG, settings.ripgrepPath, ...(this.options.ripgrepCandidates ?? [])]);
    this.ripgrep = { path: found, checked: Date.now() };
    return found;
  }

  /** Makes sure each project has a local text snapshot, downloading only what changed. */
  async ensureSnapshots(projects: ProjectSummary[], refresh = false): Promise<{ targets: SearchTarget[]; notes: string[] }> {
    const notes: string[] = [];
    let downloaded = 0;
    const results = await mapLimit(projects, 3, async (project) => {
      try {
        const backend = await this.backendFor(project);
        const remote = await backend.remoteVersion(project);
        let meta = await this.cache.meta(project.id);
        if (refresh || !this.cache.isFresh(meta, remote, this.maxCacheAgeMs)) {
          meta = await this.cache.withLock(project.id, async () => {
            const current = await this.cache.meta(project.id);
            const justRefreshed = current && Date.now() - Date.parse(current.downloadedAt) < 15_000;
            if (current && (refresh ? justRefreshed : this.cache.isFresh(current, remote, this.maxCacheAgeMs))) return current;
            const snapshot = await backend.snapshot(project.id);
            downloaded++;
            return this.cache.replace(project.id, project.name, remote ?? snapshot.version, snapshot.files, snapshot.skipped);
          });
        }
        return { projectId: project.id, projectName: project.name, dir: path.join(this.paths.cacheDir, project.id, meta!.dir) };
      } catch (error) {
        notes.push(`Skipped "${project.name}": ${errorMessage(error)}`);
        return undefined;
      }
    });
    if (downloaded) notes.push(`Downloaded fresh copies of ${downloaded} project(s).`);
    return { targets: results.filter((t): t is SearchTarget => !!t), notes };
  }

  async grep(options: GrepOptions & { projects?: ProjectSelector; refresh?: boolean }): Promise<{ result: GrepResult; projects: ProjectSummary[]; notes: string[] }> {
    if (!options.query) throw new OverleafError('INVALID_INPUT', 'query is required');
    const selection = await this.resolveSelection(options.projects);
    const { targets, notes } = await this.ensureSnapshots(selection.projects, options.refresh);
    if (selection.note) notes.unshift(selection.note);
    if (!targets.length) return { result: { matches: [], truncated: false, engine: 'js' }, projects: selection.projects, notes: [...notes, 'No project could be searched.'] };
    const rg = await this.ripgrepPath();
    let result: GrepResult;
    if (rg) {
      try {
        result = await ripgrepSearch(rg, targets, options);
      } catch (error) {
        if (!(error instanceof RipgrepRegexError)) throw error;
        // ripgrep's regex dialect lacks look-around; JavaScript's has it.
        result = await jsSearch(targets, options);
        notes.push('Used the JavaScript regex engine because ripgrep could not parse the pattern.');
      }
    } else {
      result = await jsSearch(targets, options);
    }
    return { result, projects: selection.projects, notes };
  }

  async search(query: string, options: { projects?: ProjectSelector; limit?: number; refresh?: boolean; matchAll?: boolean } = {}): Promise<{ hits: LexicalHit[]; projects: ProjectSummary[]; notes: string[] }> {
    if (!query.trim()) throw new OverleafError('INVALID_INPUT', 'query is required');
    const selection = await this.resolveSelection(options.projects);
    const { targets, notes } = await this.ensureSnapshots(selection.projects, options.refresh);
    if (selection.note) notes.unshift(selection.note);
    const index = await this.lexicalIndex(targets);
    return { hits: index.search(query, options.limit ?? 15, { matchAll: options.matchAll }), projects: selection.projects, notes };
  }

  private async lexicalIndex(targets: SearchTarget[]): Promise<LexicalIndex> {
    const key = targets.map((t) => t.dir).sort().join('|');
    const cached = this.lexicalIndexes.get(key);
    if (cached) return cached;
    const chunks: Chunk[] = [];
    for (const target of targets) {
      for (const file of await walkFiles(target.dir)) {
        try {
          const absolute = path.join(target.dir, ...file.split('/'));
          if ((await fs.stat(absolute)).size > 2 * 1024 * 1024) continue;
          chunks.push(...buildChunks(target.projectId, target.projectName, file, decodeText(await fs.readFile(absolute))));
        } catch {
          // file vanished during a refresh
        }
      }
    }
    const index = new LexicalIndex(chunks);
    this.lexicalIndexes.set(key, index);
    while (this.lexicalIndexes.size > 3) this.lexicalIndexes.delete(this.lexicalIndexes.keys().next().value!);
    return index;
  }

  /* ------------------------------------------------------------------ LaTeX structure */

  async outline(ref: string | undefined, options: { rootFile?: string } = {}): Promise<{ project: ProjectSummary; outline: ProjectOutline }> {
    const project = await this.resolveProject(ref);
    const backend = await this.backendFor(project);
    const tree = await backend.getTree(project.id);
    const files = tree.entries.filter((e) => e.type !== 'folder').map((e) => e.path);
    const cache = new Map<string, Promise<string | undefined>>();
    const read = (file: string) => {
      if (!cache.has(file)) cache.set(file, backend.readText(project.id, file).then((c) => c.text, () => undefined));
      return cache.get(file)!;
    };
    const rootFile = options.rootFile ? normalizeProjectPath(options.rootFile) : tree.rootDocPath ?? (await this.guessRoot(tree.entries, read));
    if (!rootFile) throw new OverleafError('NOT_FOUND', `Project "${project.name}" has no .tex files`);
    return { project, outline: await buildProjectOutline(rootFile, files, read) };
  }

  private async guessRoot(entries: FileEntry[], read: (file: string) => Promise<string | undefined>): Promise<string | undefined> {
    const tex = entries.filter((e) => e.type !== 'folder' && e.path.toLowerCase().endsWith('.tex')).slice(0, 40);
    const withText = await Promise.all(tex.map(async (e) => ({ path: e.path, text: await read(e.path) })));
    return guessRootFile(withText);
  }

  async section(
    ref: string | undefined,
    title: string,
    options: { file?: string } = {},
  ): Promise<{ project: ProjectSummary; file: string; slice: SectionSlice; alternatives: string[] }> {
    const project = await this.resolveProject(ref);
    const backend = await this.backendFor(project);
    let files: string[];
    if (options.file) {
      files = [normalizeProjectPath(options.file)];
    } else {
      const { outline } = await this.outline(project.id);
      const matches = findHeading(outline.entries, title);
      files = [...new Set((matches.heading ? [matches.heading] : matches.candidates).map((e) => e.file))];
      if (!files.length) {
        const sample = outline.entries.slice(0, 30).map((e) => `${'  '.repeat(Math.max(0, e.level - 1))}${e.title}`).join('\n');
        throw new OverleafError('NOT_FOUND', `No section titled "${title}" in "${project.name}". Sections:\n${sample}`);
      }
    }
    for (const file of files) {
      const { text } = await backend.readText(project.id, file);
      const headings = parseHeadings(text);
      const { heading, candidates } = findHeading(headings, title);
      if (heading) return { project, file, slice: sliceSection(text, headings, heading), alternatives: [] };
      if (candidates.length > 1) {
        throw new OverleafError('AMBIGUOUS', `"${title}" matches several sections in ${file}: ${candidates.map((c) => `"${c.title}" (line ${c.line})`).join(', ')}`);
      }
    }
    throw new OverleafError('NOT_FOUND', `No section titled "${title}" in ${files.join(', ')}`);
  }

  /* ------------------------------------------------------------------ compile & history */

  async compile(
    ref: string | undefined,
    options: { rootFile?: string; draft?: boolean; stopOnFirstError?: boolean; savePdfTo?: string; fetchPdf?: boolean } = {},
  ): Promise<{
    project: ProjectSummary;
    status: string;
    log: ParsedLog;
    bibtex: LogEntry[];
    pdfPath?: string;
    pdf?: Uint8Array;
    logTail?: string;
    rawLog?: string;
    output: CompileOutput;
  }> {
    const project = await this.resolveProject(ref);
    const backend = await this.backendFor(project);
    if (!backend.compile) throw new OverleafError('UNSUPPORTED', 'Compiling needs the Overleaf web session (sign in first)');
    const request = { rootPath: options.rootFile, draft: options.draft, stopOnFirstError: options.stopOnFirstError };
    let output = await backend.compile(project.id, request);
    // Overleaf turns away a compile that starts right after another one; wait and try again.
    for (let attempt = 1; attempt <= 3 && BUSY_COMPILE.has(output.response.status); attempt++) {
      await sleep(1500 * attempt);
      output = await backend.compile(project.id, request);
    }
    const log = output.log ? parseLatexLog(output.log) : { errors: [], warnings: [], typesetting: [] };
    const bibtex = output.bibtexLog ? parseBibtexLog(output.bibtexLog) : [];
    let pdf: Uint8Array | undefined;
    if ((options.savePdfTo || options.fetchPdf) && output.pdf) pdf = await output.pdf();
    let pdfPath: string | undefined;
    if (options.savePdfTo && pdf) {
      pdfPath = path.resolve(options.savePdfTo);
      await writeFileAtomic(pdfPath, pdf);
    }
    const logTail = output.response.status !== 'success' && output.log && !log.errors.length ? output.log.split('\n').slice(-40).join('\n') : undefined;
    return { project, status: output.response.status, log, bibtex, pdfPath, pdf: options.fetchPdf ? pdf : undefined, logTail, rawLog: output.log, output };
  }

  async stopCompile(ref: string | undefined): Promise<void> {
    const project = await this.resolveProject(ref);
    await (await this.sessionBackend()).stopCompile(project.id);
  }

  /** SyncTeX forward search: the PDF boxes a source line produced in the given build. */
  async syncToPdf(ref: string | undefined, build: BuildRef, filePath: string, line: number, column: number, rootPath?: string): Promise<PdfLocation[]> {
    const project = await this.resolveProject(ref);
    const web = (await this.sessionBackend()).web;
    return web.syncFromCode(project.id, build, synctexPath(normalizeProjectPath(filePath), rootPath), line, column);
  }

  /** SyncTeX inverse search: the source position behind a point in the PDF. */
  async syncToCode(ref: string | undefined, build: BuildRef, page: number, h: number, v: number): Promise<CodeLocation | undefined> {
    const project = await this.resolveProject(ref);
    const web = (await this.sessionBackend()).web;
    const [first] = await web.syncFromPdf(project.id, build, page, h, v);
    return first ? { ...first, file: normalizeProjectPath(first.file) } : undefined;
  }

  /** Interactive sign-in through whatever the host provides (browser window, VS Code UI, …). */
  async signIn(options: SignInRequest): Promise<StoredSession> {
    if (!this.sessionSource.signIn) throw new OverleafError('UNSUPPORTED', 'This server cannot sign in by itself; sign in from VS Code or with `overleaf-live-mcp login --browser`.');
    const session = await this.sessionSource.signIn(options);
    this.projectList = undefined;
    return session;
  }

  async history(ref: string | undefined, options: { limit?: number; path?: string } = {}): Promise<{ project: ProjectSummary; updates: HistoryUpdate[] }> {
    const project = await this.resolveProject(ref);
    const backend = await this.backendFor(project);
    if (!backend.historyUpdates) throw new OverleafError('UNSUPPORTED', 'History needs the Overleaf web session');
    const limit = Math.max(1, Math.min(options.limit ?? 20, 200));
    const wanted = options.path ? normalizeProjectPath(options.path) : undefined;
    const updates: HistoryUpdate[] = [];
    let before: number | undefined;
    for (let page = 0; page < 10 && updates.length < limit; page++) {
      const response = await backend.historyUpdates(project.id, { minCount: Math.min(limit * 2, 200), before });
      for (const update of response.updates) {
        if (!wanted || update.pathnames?.includes(wanted) || JSON.stringify(update.project_ops ?? []).includes(`"${wanted}"`)) updates.push(update);
      }
      if (!response.nextBeforeTimestamp) break;
      before = response.nextBeforeTimestamp;
    }
    return { project, updates: updates.slice(0, limit) };
  }

  async historyDiff(ref: string | undefined, filePath: string, from: number, to: number): Promise<{ project: ProjectSummary; diff: string; binary: boolean }> {
    const project = await this.resolveProject(ref);
    const backend = await this.backendFor(project);
    if (!backend.historyDiff) throw new OverleafError('UNSUPPORTED', 'History needs the Overleaf web session');
    const response = await backend.historyDiff(project.id, filePath, from, to);
    if (!Array.isArray(response.diff)) return { project, diff: '', binary: true };
    let before = '';
    let after = '';
    for (const part of response.diff) {
      if (part.u !== undefined) {
        before += part.u;
        after += part.u;
      } else if (part.d !== undefined) {
        before += part.d;
      } else if (part.i !== undefined) {
        after += part.i;
      }
    }
    return { project, diff: unifiedDiff(before, after, { label: normalizeProjectPath(filePath) }), binary: false };
  }

  dispose(): void {
    this.state?.backend.close();
    this.state = undefined;
    this.git?.close();
  }
}
