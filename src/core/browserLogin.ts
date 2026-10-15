import { ChildProcess, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { SignedInSession, signInWithCookie } from './auth';
import { SESSION_COOKIE_NAMES } from './overleaf/cookies';
import { normalizeServerUrl } from './store/credentials';
import { sleep } from './util/concurrency';
import { OverleafError } from './util/errors';
import { Logger } from './util/log';

function browserCandidates(): string[] {
  const env = process.env;
  if (process.platform === 'win32') {
    const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.ProgramW6432].filter((r): r is string => !!r);
    const suffixes = [
      'Google\\Chrome\\Application\\chrome.exe',
      'Microsoft\\Edge\\Application\\msedge.exe',
      'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'Chromium\\Application\\chrome.exe',
    ];
    return suffixes.flatMap((suffix) => roots.map((root) => path.join(root, suffix)));
  }
  if (process.platform === 'darwin') {
    const apps = ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Brave Browser.app/Contents/MacOS/Brave Browser', 'Chromium.app/Contents/MacOS/Chromium'];
    return apps.flatMap((app) => [path.join('/Applications', app), path.join(os.homedir(), 'Applications', app)]);
  }
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser', 'brave'];
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return names.flatMap((name) => dirs.map((dir) => path.join(dir, name)));
}

/** First installed Chromium-family browser (Chrome, Edge, Brave, Chromium). */
export async function findChromiumBrowser(): Promise<string | undefined> {
  for (const candidate of browserCandidates()) {
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // not installed here
    }
  }
  return undefined;
}

/** Minimal Chrome DevTools Protocol client (one browser-level session). */
class CdpConnection {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString()) as { id?: number; result?: unknown; error?: { message: string } };
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    ws.on('close', () => {
      for (const [, pending] of this.pending) pending.reject(new Error('DevTools connection closed'));
      this.pending.clear();
    });
  }

  static open(url: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false });
      ws.once('open', () => resolve(new CdpConnection(ws)));
      ws.once('error', reject);
    });
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.ws.close();
  }
}

async function waitForDevTools(profileDir: string, child: ChildProcess, timeoutMs: number): Promise<string> {
  const file = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new OverleafError('PROTOCOL', 'The browser exited before it could be controlled. Close other windows of it that use remote debugging and try again.');
    try {
      const [port, wsPath] = (await fs.readFile(file, 'utf8')).split(/\r?\n/);
      if (port && wsPath) return `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`;
    } catch {
      // not written yet
    }
    await sleep(200);
  }
  throw new OverleafError('TIMEOUT', 'The browser did not start in time');
}

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
}

function cookieApplies(host: string, cookie: CdpCookie): boolean {
  const domain = cookie.domain.replace(/^\./, '').toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

export interface BrowserSignInOptions {
  serverUrl?: string;
  browserPath?: string;
  logger: Logger;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Extra browser flags (tests use --headless=new). */
  extraArgs?: string[];
  /** Called with the DevTools endpoint once the browser is up (used by tests to drive the page). */
  onBrowserReady?: (devtoolsUrl: string) => void;
}

/**
 * Opens a fresh browser window on the Overleaf login page and waits until the person has signed
 * in (password, Google, ORCID, institutional SSO, captcha — whatever the site asks for). The
 * resulting session cookie is captured over the DevTools protocol; the temporary profile is
 * deleted afterwards, so nothing leaks into the person's normal browser.
 */
export async function browserSignIn(options: BrowserSignInOptions): Promise<SignedInSession> {
  const serverUrl = normalizeServerUrl(options.serverUrl);
  const host = new URL(serverUrl).hostname.toLowerCase();
  const executable = options.browserPath || (await findChromiumBrowser());
  if (!executable) {
    throw new OverleafError('UNSUPPORTED', 'No Chrome, Edge, Brave or Chromium browser was found. Set the browser path in settings, or sign in by pasting a session cookie.');
  }

  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-mcp-login-'));
  const args = [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-features=Translate,SigninInterceptBubble',
    ...(options.extraArgs ?? []),
    '--new-window',
    `${serverUrl}/login`,
  ];
  options.logger.info(`Opening ${executable} for Overleaf sign-in`);
  const child = spawn(executable, args, { stdio: 'ignore', windowsHide: false });
  let cdp: CdpConnection | undefined;

  try {
    const devtoolsUrl = await waitForDevTools(profileDir, child, 30_000);
    cdp = await CdpConnection.open(devtoolsUrl);
    options.onBrowserReady?.(devtoolsUrl);

    const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
    let lastValue: string | undefined;
    let lastCheck = 0;
    while (Date.now() < deadline) {
      if (options.signal?.aborted) throw new OverleafError('INVALID_INPUT', 'Sign-in cancelled');
      if (child.exitCode !== null || !cdp.open) throw new OverleafError('INVALID_INPUT', 'The browser window was closed before sign-in finished');

      const { cookies } = await cdp.send<{ cookies: CdpCookie[] }>('Storage.getCookies');
      const relevant = cookies.filter((c) => cookieApplies(host, c));
      const session = relevant.find((c) => SESSION_COOKIE_NAMES.includes(c.name));
      // Overleaf issues a new session cookie on login; check whenever it changes (and now and then).
      if (session && (session.value !== lastValue || Date.now() - lastCheck > 10_000)) {
        lastValue = session.value;
        lastCheck = Date.now();
        const header = relevant.map((c) => `${c.name}=${c.value}`).join('; ');
        try {
          const signedIn = await signInWithCookie(serverUrl, header, options.logger);
          // Let the page Overleaf opened after login finish loading before the window closes;
          // aborting its downloads mid-stream can upset some self-hosted servers.
          await sleep(1500);
          return signedIn;
        } catch (error) {
          if (!(error instanceof OverleafError) || error.code !== 'NOT_LOGGED_IN') throw error;
        }
      }
      await sleep(1000, options.signal).catch(() => undefined);
    }
    throw new OverleafError('TIMEOUT', 'Timed out waiting for the Overleaf sign-in to finish');
  } finally {
    try {
      if (cdp?.open) await Promise.race([cdp.send('Browser.close'), sleep(3000)]);
    } catch {
      // the browser may already be gone
    }
    cdp?.close();
    if (child.exitCode === null) child.kill();
    // The browser releases its profile files a moment after exiting.
    void (async () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          await fs.rm(profileDir, { recursive: true, force: true });
          return;
        } catch {
          await sleep(1000);
        }
      }
    })();
  }
}
