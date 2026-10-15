import { promises as fs } from 'node:fs';
import { signInWithCookie } from '../auth';
import { browserSignIn } from '../browserLogin';
import { SessionSource, SignInRequest, sessionKey } from '../service';
import { silentLogger, Logger } from '../util/log';
import { CredentialStore, StoredSession, sessionFromEnv } from './credentials';

/** Session from the environment, else the credentials file the extension maintains. */
export class FileSessionSource implements SessionSource {
  private cached?: { mtimeMs: number; session?: StoredSession };

  constructor(
    private readonly store: CredentialStore,
    private readonly file: string,
    private readonly logger: Logger = silentLogger,
  ) {}

  async load(): Promise<StoredSession | undefined> {
    const fromEnv = sessionFromEnv();
    if (fromEnv) return fromEnv;
    let mtimeMs = 0;
    try {
      mtimeMs = (await fs.stat(this.file)).mtimeMs;
    } catch {
      this.cached = undefined;
      return undefined;
    }
    if (this.cached?.mtimeMs !== mtimeMs) this.cached = { mtimeMs, session: await this.store.read() };
    return this.cached.session;
  }

  async save(session: StoredSession): Promise<void> {
    if (sessionFromEnv()) return;
    const current = await this.store.read();
    // Never resurrect a session the user signed out of, or overwrite a newer sign-in.
    if (!current || sessionKey(current) !== sessionKey(session)) return;
    await this.store.write(session);
  }

  /** Signs in (browser window by default) and saves the session for every Overleaf tool on this computer. */
  async signIn(request: SignInRequest): Promise<StoredSession> {
    // A self-hosted server can be set once for the whole process.
    const serverUrl = request.serverUrl ?? process.env.OVERLEAF_SERVER_URL;
    const signedIn = request.cookie
      ? await signInWithCookie(serverUrl, request.cookie, this.logger)
      : await browserSignIn({ serverUrl, logger: this.logger });
    const session: StoredSession = { ...signedIn.session, method: request.cookie ? 'cookie' : 'browser' };
    await this.store.write(session);
    this.cached = undefined;
    return session;
  }
}
