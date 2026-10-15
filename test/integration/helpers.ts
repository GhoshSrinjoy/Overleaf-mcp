import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { signInWithPassword } from '../../src/core/auth';
import { OverleafWebClient, parseMetaTags } from '../../src/core/overleaf/webClient';
import { StoredSession } from '../../src/core/store/credentials';
import { createStderrLogger } from '../../src/core/util/log';

/** Local Overleaf Community Edition started from test/overleaf-ce/docker-compose.yml. */
export const SERVER_URL = process.env.OVERLEAF_TEST_URL ?? 'http://localhost:8090';
export const ADMIN_EMAIL = process.env.OVERLEAF_TEST_EMAIL ?? 'admin@example.com';
export const ADMIN_PASSWORD = process.env.OVERLEAF_TEST_PASSWORD ?? 'overleaf-mcp-test-password';

export const logger = createStderrLogger(process.env.OVERLEAF_TEST_DEBUG ? 'debug' : 'warn');

/** Creates the first admin through the launchpad page (no-op when one already exists). */
export async function ensureAdmin(): Promise<void> {
  const page = await fetch(`${SERVER_URL}/launchpad`, { redirect: 'manual' });
  const cookies = page.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const html = await page.text();
  const csrf = parseMetaTags(html).get('ol-csrfToken');
  if (!csrf || page.status !== 200) return;
  const response = await fetch(`${SERVER_URL}/launchpad/register_admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Csrf-Token': csrf, Cookie: cookies },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    redirect: 'manual',
  });
  await response.body?.cancel();
}

export async function serverAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${SERVER_URL}/login`, { signal: AbortSignal.timeout(5000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

const SESSION_CACHE = path.join(tmpdir(), 'overleaf-mcp-test-session.json');

/**
 * One login shared by every test file and run: Overleaf allows only 10 logins per account
 * every two minutes.
 */
export async function testSession(): Promise<StoredSession> {
  try {
    const cached = JSON.parse(readFileSync(SESSION_CACHE, 'utf8')) as StoredSession;
    if (cached.serverUrl === SERVER_URL && (await new OverleafWebClient({ serverUrl: SERVER_URL, cookies: cached.cookies, logger }).isSignedIn())) {
      return cached;
    }
  } catch {
    // no cache, or the session expired
  }
  await ensureAdmin();
  const { session } = await signInWithPassword(SERVER_URL, ADMIN_EMAIL, ADMIN_PASSWORD, logger);
  writeFileSync(SESSION_CACHE, JSON.stringify(session));
  return session;
}

export async function login(): Promise<OverleafWebClient> {
  const session = await testSession();
  const client = new OverleafWebClient({ serverUrl: SERVER_URL, cookies: session.cookies, logger });
  if (!(await client.isSignedIn())) throw new Error('test session is not signed in');
  return client;
}
