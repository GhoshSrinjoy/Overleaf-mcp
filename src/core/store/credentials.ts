import { promises as fs } from 'node:fs';
import { readJsonFile, writeFileAtomic } from '../util/fsx';

export const DEFAULT_SERVER_URL = 'https://www.overleaf.com';

export interface StoredSession {
  /** Origin of the Overleaf server, e.g. https://www.overleaf.com */
  serverUrl: string;
  /** Value for the Cookie header (session cookie plus load-balancer affinity cookies). */
  cookies: string;
  userId?: string;
  email?: string;
  savedAt: string;
  /** How the session was obtained; browser/password sessions are ours to log out server-side. */
  method?: 'browser' | 'cookie' | 'password' | 'cli' | 'env';
}

interface CredentialsFile {
  version: 1;
  session?: StoredSession;
}

export function normalizeServerUrl(input: string | undefined): string {
  const raw = (input ?? '').trim() || DEFAULT_SERVER_URL;
  const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  // Self-hosted installs can live under a sub-path, so keep it (without trailing slash).
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Credentials file shared with MCP server processes that VS Code did not start
 * (Claude Code, Claude Desktop, Cursor). Written with owner-only permissions.
 */
export class CredentialStore {
  constructor(private readonly file: string) {}

  async read(): Promise<StoredSession | undefined> {
    const data = await readJsonFile<CredentialsFile>(this.file);
    return data?.session?.cookies ? data.session : undefined;
  }

  async write(session: StoredSession): Promise<void> {
    const data: CredentialsFile = { version: 1, session };
    await writeFileAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`, 0o600);
  }

  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true });
  }
}

/** Headless setups (Docker, CI) can pass the session through the environment instead of the file. */
export function sessionFromEnv(env: NodeJS.ProcessEnv = process.env): StoredSession | undefined {
  const cookies = env.OVERLEAF_COOKIES?.trim() || (env.OVERLEAF_SESSION?.trim() ? `overleaf_session2=${env.OVERLEAF_SESSION.trim()}` : '');
  if (!cookies) return undefined;
  return {
    serverUrl: normalizeServerUrl(env.OVERLEAF_SERVER_URL),
    cookies,
    savedAt: new Date().toISOString(),
    method: 'env',
  };
}
