import { SESSION_COOKIE_NAMES } from './overleaf/cookies';
import { SessionInfo } from './overleaf/types';
import { OverleafWebClient } from './overleaf/webClient';
import { StoredSession, normalizeServerUrl } from './store/credentials';
import { OverleafError } from './util/errors';
import { Logger } from './util/log';

export interface SignedInSession {
  session: StoredSession;
  info: SessionInfo;
}

function toSession(serverUrl: string, client: OverleafWebClient, info: SessionInfo): SignedInSession {
  return {
    session: { serverUrl, cookies: client.cookieHeader(), userId: info.userId, email: info.email, savedAt: new Date().toISOString() },
    info,
  };
}

/**
 * Accepts what people paste: a full Cookie header, a single "name=value" pair, or just the
 * session cookie's value (then each of Overleaf's session cookie names is tried).
 */
export async function signInWithCookie(serverUrlInput: string | undefined, input: string, logger: Logger): Promise<SignedInSession> {
  const serverUrl = normalizeServerUrl(serverUrlInput);
  const cleaned = input.trim().replace(/^cookie:\s*/i, '').replace(/^["']|["']$/g, '');
  if (!cleaned) throw new OverleafError('INVALID_INPUT', 'No cookie given');
  const preferred = /(^|\.)overleaf\.com$/.test(new URL(serverUrl).hostname) ? 'overleaf_session2' : 'overleaf.sid';
  const names = [preferred, ...SESSION_COOKIE_NAMES.filter((n) => n !== preferred)];
  const candidates = cleaned.includes('=') ? [cleaned] : names.map((name) => `${name}=${cleaned}`);

  for (const cookies of candidates) {
    const client = new OverleafWebClient({ serverUrl, cookies, logger });
    try {
      // A single, explicit cookie is worth a short retry; guessed names are not.
      return toSession(serverUrl, client, candidates.length === 1 ? await client.verifySessionWithRetry(2) : await client.verifySession());
    } catch (error) {
      if (!(error instanceof OverleafError) || error.code !== 'NOT_LOGGED_IN') throw error;
    }
  }
  throw new OverleafError('NOT_LOGGED_IN', `That cookie is not a signed-in session on ${serverUrl}. Copy it again from a browser where you are logged in.`);
}

/** Email/password sign-in; for self-hosted servers (overleaf.com usually requires a captcha). */
export async function signInWithPassword(serverUrlInput: string | undefined, email: string, password: string, logger: Logger): Promise<SignedInSession> {
  const serverUrl = normalizeServerUrl(serverUrlInput);
  const client = await OverleafWebClient.loginWithPassword(serverUrl, email, password, logger);
  return toSession(serverUrl, client, client.currentSession ?? (await client.verifySession()));
}
