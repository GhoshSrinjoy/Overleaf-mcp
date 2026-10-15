import { promises as fs } from 'node:fs';
import { SessionSource, sessionKey } from '../service';
import { CredentialStore, StoredSession, sessionFromEnv } from './credentials';

/** Session from the environment, else the credentials file the extension maintains. */
export class FileSessionSource implements SessionSource {
  private cached?: { mtimeMs: number; session?: StoredSession };

  constructor(
    private readonly store: CredentialStore,
    private readonly file: string,
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
}
