import * as vscode from 'vscode';
import { SignedInSession, signInWithCookie, signInWithPassword } from '../core/auth';
import { browserSignIn } from '../core/browserLogin';
import { OverleafWebClient } from '../core/overleaf/webClient';
import { SessionSource, sessionKey } from '../core/service';
import { CredentialStore, DEFAULT_SERVER_URL, StoredSession, normalizeServerUrl } from '../core/store/credentials';
import { DataPaths } from '../core/store/paths';
import { errorMessage } from '../core/util/errors';
import { Logger } from '../core/util/log';

const SECRET_KEY = 'overleafMcp.session';

export function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('overleafMcp');
}

/**
 * Owns the Overleaf session. It lives in VS Code's SecretStorage (shared by all windows) and,
 * unless disabled, is mirrored to ~/.overleaf-mcp/credentials.json for MCP servers that other
 * apps start.
 */
export class AuthManager implements vscode.Disposable {
  private session?: StoredSession;
  private readonly changed = new vscode.EventEmitter<StoredSession | undefined>();
  readonly onDidChange = this.changed.event;
  private readonly store: CredentialStore;
  private readonly disposables: vscode.Disposable[] = [];
  readonly sessionSource: SessionSource;

  constructor(
    private readonly context: vscode.ExtensionContext,
    paths: DataPaths,
    private readonly logger: Logger,
  ) {
    this.store = new CredentialStore(paths.credentialsFile);
    this.sessionSource = {
      load: async () => this.session,
      save: async (session) => {
        // Overleaf rotated cookies; keep the same login but store the fresh values.
        if (this.session && sessionKey(this.session) === sessionKey(session)) await this.persist(session, false);
      },
    };
    this.disposables.push(
      this.changed,
      context.secrets.onDidChange(async (event) => {
        if (event.key !== SECRET_KEY) return;
        const next = await this.readSecret();
        if (JSON.stringify(next) === JSON.stringify(this.session)) return;
        const sameLogin = !!next && !!this.session && sessionKey(next) === sessionKey(this.session);
        this.session = next;
        // Another window stored refreshed cookies for the same login: adopt them quietly instead of
        // tearing down connections, open editors and syncs.
        if (!sameLogin) this.changed.fire(next);
      }),
    );
  }

  get current(): StoredSession | undefined {
    return this.session;
  }

  get serverUrl(): string {
    return normalizeServerUrl(config().get<string>('serverUrl') || DEFAULT_SERVER_URL);
  }

  get sharesWithExternalClients(): boolean {
    return config().get<boolean>('mcp.shareSessionWithExternalClients', true);
  }

  private async readSecret(): Promise<StoredSession | undefined> {
    const raw = await this.context.secrets.get(SECRET_KEY);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as StoredSession;
    } catch {
      return undefined;
    }
  }

  async initialize(): Promise<void> {
    this.session = await this.readSecret();
    if (!this.session) {
      // Adopt a session created outside VS Code (e.g. `overleaf-mcp login`).
      const external = await this.store.read().catch(() => undefined);
      if (external) {
        this.session = external;
        await this.context.secrets.store(SECRET_KEY, JSON.stringify(external));
      }
    }
    await this.syncSharedFile();
  }

  /** Writes or removes the shared credentials file according to the setting. */
  async syncSharedFile(): Promise<void> {
    try {
      if (this.session && this.sharesWithExternalClients) {
        await this.store.write(this.session);
      } else {
        const onDisk = await this.store.read();
        if (onDisk && (!this.session || sessionKey(onDisk) === sessionKey(this.session))) await this.store.clear();
      }
    } catch (error) {
      this.logger.warn('Could not update the shared credentials file', error);
    }
  }

  private async persist(session: StoredSession, notify = true): Promise<void> {
    this.session = session;
    await this.context.secrets.store(SECRET_KEY, JSON.stringify(session));
    await this.syncSharedFile();
    if (notify) this.changed.fire(session);
  }

  async signIn(preferred?: 'browser' | 'cookie' | 'password'): Promise<boolean> {
    let method = preferred;
    if (!method) {
      const host = new URL(this.serverUrl).host;
      const picked = await vscode.window.showQuickPick(
        [
          { label: '$(globe) Sign in with browser', detail: 'Recommended. Opens the Overleaf login page; Google, ORCID, institutional SSO and passwords all work.', id: 'browser' as const },
          { label: '$(key) Paste a session cookie', detail: 'Copy the overleaf_session2 cookie from a browser where you are logged in.', id: 'cookie' as const },
          { label: '$(mail) Email and password', detail: 'For self-hosted Overleaf servers (overleaf.com usually requires a captcha).', id: 'password' as const },
          { label: '$(server) Use a different Overleaf server…', detail: `Currently ${this.serverUrl}`, id: 'server' as const },
        ],
        { title: `Sign in to ${host}`, ignoreFocusOut: true },
      );
      if (!picked) return false;
      if (picked.id === 'server') {
        const changed = await this.changeServer();
        return changed ? this.signIn() : false;
      }
      method = picked.id;
    }

    try {
      const signedIn = await this.runSignIn(method);
      if (!signedIn) return false;
      await this.persist({ ...signedIn.session, method });
      vscode.window.showInformationMessage(`Signed in to Overleaf as ${signedIn.info.email ?? signedIn.info.userId}.`);
      return true;
    } catch (error) {
      this.logger.warn('Sign-in failed', error);
      const retry = await vscode.window.showErrorMessage(`Overleaf sign-in failed: ${errorMessage(error)}`, 'Try Again', 'Paste Cookie Instead');
      if (retry === 'Try Again') return this.signIn(method);
      if (retry === 'Paste Cookie Instead') return this.signIn('cookie');
      return false;
    }
  }

  private async runSignIn(method: 'browser' | 'cookie' | 'password'): Promise<SignedInSession | undefined> {
    const serverUrl = this.serverUrl;
    if (method === 'browser') {
      return vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Sign in to Overleaf in the browser window that just opened…', cancellable: true },
        async (_progress, token) => {
          const controller = new AbortController();
          token.onCancellationRequested(() => controller.abort());
          return browserSignIn({ serverUrl, browserPath: config().get<string>('browserPath') || undefined, logger: this.logger, signal: controller.signal });
        },
      );
    }
    if (method === 'cookie') {
      const cookie = await vscode.window.showInputBox({
        title: 'Paste your Overleaf session cookie',
        prompt: 'In a browser where you are logged in to Overleaf: DevTools → Application → Cookies → copy the value of overleaf_session2 (or paste a whole Cookie header).',
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() ? undefined : 'Paste the cookie value'),
      });
      if (!cookie) return undefined;
      return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking the Overleaf session…' }, () =>
        signInWithCookie(serverUrl, cookie, this.logger),
      );
    }
    const email = await vscode.window.showInputBox({ title: 'Overleaf email', ignoreFocusOut: true, validateInput: (v) => (/.+@.+/.test(v) ? undefined : 'Enter an email address') });
    if (!email) return undefined;
    const password = await vscode.window.showInputBox({ title: 'Overleaf password', password: true, ignoreFocusOut: true });
    if (!password) return undefined;
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Signing in to Overleaf…' }, () =>
      signInWithPassword(serverUrl, email, password, this.logger),
    );
  }

  async changeServer(): Promise<boolean> {
    const value = await vscode.window.showInputBox({
      title: 'Overleaf server URL',
      prompt: 'https://www.overleaf.com, or the address of a self-hosted Overleaf (Community Edition / Server Pro)',
      value: this.serverUrl,
      ignoreFocusOut: true,
      validateInput: (input) => {
        try {
          normalizeServerUrl(input);
          return undefined;
        } catch {
          return 'Enter a valid URL';
        }
      },
    });
    if (!value) return false;
    await config().update('serverUrl', normalizeServerUrl(value), vscode.ConfigurationTarget.Global);
    return true;
  }

  async signOut(): Promise<void> {
    const session = this.session;
    if (!session) return;
    // Sessions we created (throwaway browser profile, password login) are also ended on Overleaf.
    // A pasted cookie belongs to the person's own browser, so it is left alone.
    if (session.method === 'browser' || session.method === 'password') {
      await new OverleafWebClient({ serverUrl: session.serverUrl, cookies: session.cookies, logger: this.logger }).logout();
    }
    this.session = undefined;
    await this.context.secrets.delete(SECRET_KEY);
    await this.syncSharedFile();
    this.changed.fire(undefined);
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }
}
