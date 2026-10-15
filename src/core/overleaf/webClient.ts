import { randomUUID } from 'node:crypto';
import { sleep } from '../util/concurrency';
import { OverleafError, notLoggedIn } from '../util/errors';
import { Logger } from '../util/log';
import { CookieJar } from './cookies';
import {
  CompileOutputFile,
  CompileResponse,
  EntityType,
  OverleafUserRef,
  ProjectSummary,
  RawFolder,
  SessionInfo,
  Tag,
} from './types';

export const USER_AGENT = 'overleaf-mcp/2.0 (+https://github.com/GhoshSrinjoy/Overleaf-mcp)';

const HTML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'", '#x2F': '/', '#47': '/' };

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (HTML_ENTITIES[body] !== undefined) return HTML_ENTITIES[body];
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
    }
    return entity;
  });
}

/** Reads Overleaf's `<meta name="ol-…" content="…">` tags, in any attribute order. */
export function parseMetaTags(html: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const name = /\bname\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2];
    if (!name?.startsWith('ol-')) continue;
    const content = /\bcontent\s*=\s*(["'])([\s\S]*?)\1/i.exec(tag)?.[2] ?? '';
    tags.set(name, decodeHtmlEntities(content));
  }
  return tags;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  /** Send the CSRF token (needed for every non-GET request). Defaults to true for non-GET. */
  csrf?: boolean;
  accept?: string;
  timeoutMs?: number;
  /** Extra attempts for 429/5xx/network errors (only GET is retried on 5xx). */
  retries?: number;
  /** Treat a redirect to the login page as an expired session (default true). */
  loginRedirectIsError?: boolean;
}

export interface WebClientOptions {
  serverUrl: string;
  cookies: string;
  logger: Logger;
  /** Called when Overleaf updates the session cookies, so they can be persisted. */
  onCookiesChanged?: (cookieHeader: string) => void;
}

function mapUser(raw: unknown): OverleafUserRef | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') return undefined;
  const user = raw as Record<string, string | undefined>;
  return { id: user.id ?? user._id ?? '', email: user.email, firstName: user.firstName ?? user.first_name, lastName: user.lastName ?? user.last_name };
}

export class OverleafWebClient {
  readonly serverUrl: string;
  readonly jar: CookieJar;
  private readonly base: URL;
  private readonly logger: Logger;
  private readonly onCookiesChanged?: (cookieHeader: string) => void;
  private csrfToken?: string;
  private session?: SessionInfo;
  private socketLocation?: { baseUrl: string; resource: string };

  constructor(options: WebClientOptions) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, '');
    this.base = new URL(`${this.serverUrl}/`);
    this.jar = CookieJar.fromHeader(options.cookies, this.base);
    this.logger = options.logger;
    this.onCookiesChanged = options.onCookiesChanged;
  }

  url(pathname: string, query?: RequestOptions['query']): URL {
    const url = new URL(pathname.replace(/^\/+/, ''), this.base);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  /** Cookie header for the server, for persisting after Overleaf refreshes the session. */
  cookieHeader(): string {
    return this.jar.headerFor(this.base);
  }

  async request(method: string, pathname: string, options: RequestOptions = {}): Promise<Response> {
    const url = this.url(pathname, options.query);
    const needsCsrf = options.csrf ?? method !== 'GET';
    const maxRetries = options.retries ?? 3;
    let csrfRefreshed = false;

    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        Accept: options.accept ?? 'application/json',
        ...options.headers,
      };
      const cookie = this.jar.headerFor(url);
      if (cookie) headers.Cookie = cookie;
      if (needsCsrf) headers['X-Csrf-Token'] = await this.getCsrfToken();
      let body: RequestInit["body"];
      if (options.form) {
        body = options.form;
      } else if (options.json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(options.json);
      }

      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
        });
      } catch (error) {
        if (attempt < maxRetries && (method === 'GET' || method === 'HEAD')) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        const reason = (error as Error).name === 'TimeoutError' ? 'timed out' : (error as Error).message;
        throw new OverleafError('HTTP', `Request to Overleaf failed (${method} ${url.pathname}): ${reason}`, { cause: error });
      }

      this.absorbCookies(response.headers, url);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location') ?? '';
        if ((options.loginRedirectIsError ?? true) && /\/login(\?|$)/.test(location)) throw notLoggedIn(this.serverUrl);
        return response;
      }
      if (response.status === 401) {
        await response.body?.cancel();
        throw notLoggedIn(this.serverUrl);
      }
      if (response.status === 403 && needsCsrf && !csrfRefreshed) {
        // Usually a stale CSRF token (they rotate on login); refresh once and retry.
        await response.body?.cancel();
        csrfRefreshed = true;
        await this.getCsrfToken(true);
        continue;
      }
      if (response.status === 429 && attempt < maxRetries) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await response.body?.cancel();
        // Overleaf's limits use one-minute windows, so back off on that scale.
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : [2000, 6000, 15_000, 30_000][Math.min(attempt, 3)];
        this.logger.warn(`Overleaf rate limit hit on ${url.pathname}; retrying in ${Math.round(wait / 1000)}s`);
        await sleep(Math.min(wait, 60_000));
        continue;
      }
      if (response.status >= 500 && attempt < maxRetries && (method === 'GET' || method === 'HEAD')) {
        await response.body?.cancel();
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      return response;
    }
  }

  /**
   * GET for file downloads, following redirects (e.g. to a file CDN). Overleaf's own origin gets
   * the session cookie; other hosts never do.
   */
  private async download(pathname: string, options: RequestOptions = {}): Promise<Response> {
    let response = await this.request('GET', pathname, { accept: '*/*', ...options });
    for (let hop = 0; hop < 5 && response.status >= 300 && response.status < 400; hop++) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) break;
      const next = new URL(location, this.base);
      if (next.origin === this.base.origin) {
        response = await this.request('GET', `${next.pathname}${next.search}`.replace(this.base.pathname, ''), { accept: '*/*', ...options });
      } else {
        response = await fetch(next, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(options.timeoutMs ?? 300_000) });
      }
    }
    return response;
  }

  private absorbCookies(headers: Headers, url: URL): void {
    const before = this.jar.version;
    this.jar.storeFromResponse(headers, url);
    if (this.jar.version !== before) this.onCookiesChanged?.(this.cookieHeader());
  }

  private async fail(response: Response, action: string): Promise<never> {
    const text = await response.text().catch(() => '');
    let detail = text.slice(0, 300).trim();
    try {
      const json = JSON.parse(text) as { message?: { text?: string; key?: string } | string; error?: string };
      detail = typeof json.message === 'string' ? json.message : json.message?.text ?? json.message?.key ?? json.error ?? detail;
    } catch {
      // not JSON
    }
    if (response.status === 404) throw new OverleafError('NOT_FOUND', `${action}: not found`, { status: 404 });
    if (response.status === 403) throw new OverleafError('FORBIDDEN', `${action}: permission denied${detail ? ` (${detail})` : ''}`, { status: 403 });
    if (response.status === 429) throw new OverleafError('RATE_LIMITED', `${action}: Overleaf rate limit reached, try again in a minute`, { status: 429 });
    throw new OverleafError('HTTP', `${action} failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`, { status: response.status });
  }

  private async json<T>(response: Response, action: string): Promise<T> {
    if (!response.ok) return this.fail(response, action);
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new OverleafError('PROTOCOL', `${action}: unexpected response from Overleaf: ${text.slice(0, 200)}`);
    }
  }

  /* ---------------------------------- session ---------------------------------- */

  async getCsrfToken(force = false): Promise<string> {
    if (this.csrfToken && !force) return this.csrfToken;
    // Overleaf's health-check endpoint returns the token as plain text. The dashboard also has it,
    // but is limited to 30 loads a minute per user, so it is only the fallback.
    const response = await this.request('GET', 'dev/csrf', { accept: 'text/plain', csrf: false, retries: 1 });
    if (response.ok) {
      const token = (await response.text()).trim();
      if (/^[\w-]{16,}$/.test(token)) {
        this.csrfToken = token;
        return token;
      }
    } else {
      await response.body?.cancel();
    }
    await this.verifySession();
    return this.csrfToken!;
  }

  /** Cheap check that the session is signed in (this endpoint is not rate-limited). */
  async isSignedIn(): Promise<boolean> {
    try {
      const response = await this.request('GET', 'user/projects', { csrf: false });
      await response.body?.cancel();
      return response.ok;
    } catch (error) {
      if (error instanceof OverleafError && error.code === 'NOT_LOGGED_IN') return false;
      throw error;
    }
  }

  /** Loads the dashboard to confirm the session is valid and learn who it belongs to. */
  async verifySession(): Promise<SessionInfo> {
    const response = await this.request('GET', 'project', { accept: 'text/html', csrf: false });
    // Being rate-limited says nothing about the session; don't report it as signed out.
    if (response.status === 429) return this.fail(response, 'Checking the Overleaf session');
    if (response.status >= 300 && response.status < 400) throw notLoggedIn(this.serverUrl);
    if (!response.ok) return this.fail(response, 'Loading the Overleaf dashboard');
    const meta = parseMetaTags(await response.text());
    const userId = meta.get('ol-user_id');
    const csrfToken = meta.get('ol-csrfToken');
    if (!userId || !csrfToken) throw notLoggedIn(this.serverUrl);
    let email = meta.get('ol-usersEmail');
    if (!email) {
      try {
        email = (JSON.parse(meta.get('ol-user') ?? '{}') as { email?: string }).email;
      } catch {
        email = undefined;
      }
    }
    this.csrfToken = csrfToken;
    this.session = { userId, email, csrfToken };
    return this.session;
  }

  get currentSession(): SessionInfo | undefined {
    return this.session;
  }

  /**
   * Email/password login. Works on self-hosted servers; overleaf.com normally demands a
   * captcha, in which case the browser sign-in has to be used instead.
   */
  static async loginWithPassword(serverUrl: string, email: string, password: string, logger: Logger): Promise<OverleafWebClient> {
    const client = new OverleafWebClient({ serverUrl, cookies: '', logger });
    const page = await client.request('GET', 'login', { accept: 'text/html', csrf: false, loginRedirectIsError: false });
    const html = await page.text();
    const csrf = parseMetaTags(html).get('ol-csrfToken') ?? /name="_csrf"[^>]*value="([^"]+)"/.exec(html)?.[1];
    if (!csrf) throw new OverleafError('PROTOCOL', 'Could not find the login form on the Overleaf server. Check the server URL.');
    client.csrfToken = csrf;

    const response = await client.request('POST', 'login', {
      json: { _csrf: csrf, email, password },
      accept: 'application/json',
      loginRedirectIsError: false,
      retries: 0,
    });
    const text = await response.text();
    let body: { redir?: string; message?: { text?: string; key?: string } | string; errorReason?: string } = {};
    try {
      body = JSON.parse(text);
    } catch {
      // HTML or plain text error
    }
    if (!response.ok || !body.redir) {
      const message = typeof body.message === 'string' ? body.message : body.message?.text ?? body.message?.key;
      if (body.errorReason === 'cannot_verify_user_not_robot' || /captcha|robot/i.test(text)) {
        throw new OverleafError(
          'FORBIDDEN',
          'Overleaf asked for a captcha, so password sign-in is not possible here. Use "Sign in with browser" or paste a session cookie instead.',
        );
      }
      if (message === 'invalid-password-retry-or-reset' || response.status === 401) {
        throw new OverleafError('FORBIDDEN', 'Overleaf rejected the email or password.');
      }
      if (response.status === 429) {
        // An empty message is Overleaf refusing a second sign-in that raced another one for the same account.
        const parallel = typeof body.message === 'object' && !message;
        throw new OverleafError(
          'RATE_LIMITED',
          parallel ? 'Another sign-in for this account was in progress. Try again in a moment.' : 'Too many login attempts. Wait a couple of minutes and try again.',
        );
      }
      throw new OverleafError('HTTP', `Login failed (HTTP ${response.status})${message ? `: ${message}` : ''}`, { status: response.status });
    }
    // The CSRF secret is reset on login; fetch a fresh token with the new session.
    await client.verifySessionWithRetry();
    return client;
  }

  /** verifySession, retried briefly: a busy server can lag right after a sign-in. */
  async verifySessionWithRetry(attempts = 3): Promise<SessionInfo> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.verifySession();
      } catch (error) {
        if (attempt >= attempts || !(error instanceof OverleafError) || error.code !== 'NOT_LOGGED_IN') throw error;
        await sleep(400 * attempt);
      }
    }
  }

  /** Ends the session on the server (best effort). */
  async logout(): Promise<void> {
    try {
      const response = await this.request('POST', 'logout', { accept: 'text/html', loginRedirectIsError: false, retries: 0 });
      await response.body?.cancel();
    } catch (error) {
      this.logger.debug('Server-side logout failed', error);
    }
  }

  /* ---------------------------------- projects ---------------------------------- */

  async listProjects(): Promise<ProjectSummary[]> {
    const response = await this.request('POST', 'api/project', { json: {} });
    if (response.status === 404) {
      // Older servers: no JSON dashboard API.
      await response.body?.cancel();
      const legacy = await this.json<{ projects: Array<{ _id: string; name: string; accessLevel?: string }> }>(
        await this.request('GET', 'user/projects'),
        'Listing projects',
      );
      return legacy.projects.map((p) => ({ id: p._id, name: p.name, accessLevel: p.accessLevel }));
    }
    const data = await this.json<{ projects: Array<Record<string, unknown>> }>(response, 'Listing projects');
    return data.projects.map((p) => ({
      id: String(p.id ?? p._id),
      name: String(p.name ?? ''),
      lastUpdated: typeof p.lastUpdated === 'string' ? p.lastUpdated : undefined,
      lastUpdatedBy: mapUser(p.lastUpdatedBy),
      owner: mapUser(p.owner),
      accessLevel: typeof p.accessLevel === 'string' ? p.accessLevel : undefined,
      source: typeof p.source === 'string' ? p.source : undefined,
      archived: Boolean(p.archived),
      trashed: Boolean(p.trashed),
    }));
  }

  async listTags(): Promise<Tag[]> {
    const response = await this.request('GET', 'tag');
    if (response.status === 404) {
      await response.body?.cancel();
      return [];
    }
    const tags = await this.json<Array<{ _id: string; name: string; color?: string; project_ids?: string[] }>>(response, 'Listing tags');
    return tags.map((t) => ({ id: t._id, name: t.name, color: t.color, projectIds: t.project_ids ?? [] }));
  }

  async createProject(name: string, template: 'none' | 'example' = 'none'): Promise<string> {
    const data = await this.json<{ project_id: string }>(
      await this.request('POST', 'project/new', { json: { projectName: name, template } }),
      `Creating project "${name}"`,
    );
    return data.project_id;
  }

  /* ---------------------------------- content ---------------------------------- */

  /** Whole project as a zip. Overleaf flushes pending edits first, so this is up to date. */
  async downloadZip(projectId: string): Promise<Uint8Array> {
    const response = await this.download(`Project/${projectId}/download/zip`, { timeoutMs: 300_000 });
    if (!response.ok) return this.fail(response, 'Downloading the project');
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Latest text of one doc, straight from the document updater. */
  async downloadDoc(projectId: string, docId: string): Promise<string> {
    const response = await this.download(`Project/${projectId}/doc/${docId}/download`, { accept: 'text/plain' });
    if (!response.ok) return this.fail(response, 'Downloading a document');
    return response.text();
  }

  async downloadFile(projectId: string, fileId: string, hash?: string): Promise<Uint8Array> {
    const pathname = hash ? `project/${projectId}/blob/${hash}` : `Project/${projectId}/file/${fileId}`;
    let response = await this.download(pathname, { timeoutMs: 300_000 });
    if (!response.ok && hash) {
      await response.body?.cancel();
      response = await this.download(`Project/${projectId}/file/${fileId}`, { timeoutMs: 300_000 });
    }
    if (!response.ok) return this.fail(response, 'Downloading a file');
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * Creates or overwrites a file. Text files become editable docs; an existing doc with the
   * same name is updated in place (same doc id, collaborators see the change live).
   * `relativePath` (e.g. "figures/plot.png") creates missing folders under `folderId`.
   */
  async upload(projectId: string, folderId: string, name: string, data: Uint8Array | string, relativePath?: string): Promise<{ entityId: string; entityType: EntityType }> {
    const form = new FormData();
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    form.append('name', name);
    if (relativePath) form.append('relativePath', relativePath);
    form.append('qqfile', new Blob([bytes as Uint8Array<ArrayBuffer>]), name);
    const response = await this.request('POST', `Project/${projectId}/upload`, {
      query: { folder_id: folderId },
      form,
      timeoutMs: 300_000,
      retries: 0,
    });
    const body = await this.json<{ success?: boolean; entity_id?: string; entity_type?: EntityType; error?: string }>(response, `Uploading ${relativePath ?? name}`);
    if (!body.success || !body.entity_id) {
      const reason = body.error === 'project_has_too_many_files' ? 'the project has too many files' : body.error ?? 'unknown error';
      throw new OverleafError('HTTP', `Uploading ${relativePath ?? name} failed: ${reason}`);
    }
    return { entityId: body.entity_id, entityType: body.entity_type ?? 'file' };
  }

  async createDoc(projectId: string, parentFolderId: string | undefined, name: string): Promise<string> {
    const data = await this.json<{ _id: string }>(
      await this.request('POST', `project/${projectId}/doc`, { json: { name, parent_folder_id: parentFolderId }, retries: 0 }),
      `Creating ${name}`,
    );
    return data._id;
  }

  async createFolder(projectId: string, parentFolderId: string | undefined, name: string): Promise<RawFolder> {
    return this.json<RawFolder>(
      await this.request('POST', `project/${projectId}/folder`, { json: { name, parent_folder_id: parentFolderId }, retries: 0 }),
      `Creating folder ${name}`,
    );
  }

  async renameEntity(projectId: string, type: EntityType, entityId: string, name: string): Promise<void> {
    const response = await this.request('POST', `project/${projectId}/${type}/${entityId}/rename`, { json: { name }, retries: 0 });
    if (!response.ok) await this.fail(response, `Renaming to ${name}`);
  }

  async moveEntity(projectId: string, type: EntityType, entityId: string, folderId: string): Promise<void> {
    const response = await this.request('POST', `project/${projectId}/${type}/${entityId}/move`, { json: { folder_id: folderId }, retries: 0 });
    if (!response.ok) await this.fail(response, 'Moving the entry');
  }

  async deleteEntity(projectId: string, type: EntityType, entityId: string): Promise<void> {
    const response = await this.request('DELETE', `project/${projectId}/${type}/${entityId}`, { retries: 0 });
    if (!response.ok) await this.fail(response, 'Deleting the entry');
  }

  /* ---------------------------------- realtime ---------------------------------- */

  /** Where the realtime (socket.io) service lives; normally {server}/socket.io. */
  async realtimeLocation(projectId: string, rediscover = false): Promise<{ baseUrl: string; resource: string }> {
    if (this.socketLocation && !rediscover) return this.socketLocation;
    let wsUrl: string | undefined;
    if (rediscover) {
      // The editor page announces a custom websocket URL when the server uses one.
      const response = await this.request('GET', `project/${projectId}`, { accept: 'text/html', csrf: false });
      if (response.ok) wsUrl = parseMetaTags(await response.text()).get('ol-wsUrl');
      else await response.body?.cancel();
    }
    const resolved = new URL(wsUrl || `${this.base.pathname.replace(/\/$/, '')}/socket.io`, this.base.origin);
    this.socketLocation = { baseUrl: resolved.origin, resource: resolved.pathname.replace(/^\/+|\/+$/g, '') };
    return this.socketLocation;
  }

  /* ---------------------------------- compile ---------------------------------- */

  async compile(projectId: string, options: { rootDocId?: string; rootResourcePath?: string; draft?: boolean; stopOnFirstError?: boolean }): Promise<CompileResponse> {
    const response = await this.request('POST', `project/${projectId}/compile`, {
      query: { enable_pdf_caching: 'true' },
      json: {
        rootDoc_id: options.rootDocId ?? null,
        rootResourcePath: options.rootResourcePath,
        draft: options.draft ?? false,
        check: 'silent',
        incrementalCompilesEnabled: true,
        stopOnFirstError: options.stopOnFirstError ?? false,
        editorId: randomUUID(),
      },
      timeoutMs: 12 * 60_000,
      retries: 1,
    });
    return this.json<CompileResponse>(response, 'Compiling the project');
  }

  async downloadOutputFile(file: CompileOutputFile, compile: CompileResponse): Promise<Uint8Array> {
    const params = new URLSearchParams();
    if (compile.compileGroup) params.set('compileGroup', compile.compileGroup);
    if (compile.clsiServerId) params.set('clsiserverid', compile.clsiServerId);
    const suffix = params.toString() ? `?${params}` : '';
    if (compile.pdfDownloadDomain && file.build) {
      // Output is served from a separate domain that does not use the session cookie.
      const url = `${compile.pdfDownloadDomain.replace(/\/+$/, '')}/${file.url.replace(/^\/+/, '')}${suffix}`;
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(120_000) });
      if (response.ok) return new Uint8Array(await response.arrayBuffer());
      await response.body?.cancel();
    }
    const response = await this.download(`${file.url.replace(/^\/+/, '')}${suffix}`, { timeoutMs: 120_000 });
    if (!response.ok) return this.fail(response, `Downloading ${file.path}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  /* ---------------------------------- history ---------------------------------- */

  async historyUpdates(projectId: string, options: { minCount?: number; before?: number } = {}): Promise<HistoryUpdatesResponse> {
    return this.json<HistoryUpdatesResponse>(
      await this.request('GET', `project/${projectId}/updates`, { query: { min_count: options.minCount ?? 20, before: options.before } }),
      'Loading project history',
    );
  }

  async historyDiff(projectId: string, pathname: string, from: number, to: number): Promise<HistoryDiffResponse> {
    return this.json<HistoryDiffResponse>(
      await this.request('GET', `project/${projectId}/diff`, { query: { pathname, from, to } }),
      `Loading the history diff of ${pathname}`,
    );
  }
}

export interface HistoryUpdate {
  fromV: number;
  toV: number;
  meta: { users?: Array<{ id?: string; email?: string; first_name?: string; last_name?: string } | null>; start_ts: number; end_ts: number; origin?: { kind?: string } };
  pathnames?: string[];
  project_ops?: Array<Record<string, unknown>>;
  labels?: Array<{ comment?: string }>;
}

export interface HistoryUpdatesResponse {
  updates: HistoryUpdate[];
  nextBeforeTimestamp?: number;
}

export interface HistoryDiffResponse {
  diff: Array<{ u?: string; i?: string; d?: string; meta?: unknown }> | { binary: true };
}
