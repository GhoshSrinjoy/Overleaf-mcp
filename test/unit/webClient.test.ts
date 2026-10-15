import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverleafWebClient } from '../../src/core/overleaf/webClient';
import { silentLogger } from '../../src/core/util/log';

type Handler = (url: URL, init: RequestInit) => Response;

function stubFetch(handler: Handler) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push(`${init.method ?? 'GET'} ${url.pathname}`);
    return handler(url, init);
  });
  return calls;
}

const client = () => new OverleafWebClient({ serverUrl: 'https://overleaf.example', cookies: 'overleaf_session2=abc', logger: silentLogger });

describe('OverleafWebClient session handling', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports a rate-limited dashboard as rate limiting, not as signed out', async () => {
    vi.useFakeTimers();
    try {
      stubFetch(() => new Response('Rate limit reached', { status: 429 }));
      const pending = client().verifySession();
      const outcome = expect(pending).rejects.toMatchObject({ code: 'RATE_LIMITED' });
      await vi.runAllTimersAsync();
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a redirect to the login page as signed out', async () => {
    stubFetch(() => new Response(null, { status: 302, headers: { location: '/login' } }));
    await expect(client().verifySession()).rejects.toMatchObject({ code: 'NOT_LOGGED_IN' });
    await expect(client().isSignedIn()).resolves.toBe(false);
  });

  it('gets the CSRF token from the light endpoint without loading the dashboard', async () => {
    const calls = stubFetch((url) => {
      if (url.pathname === '/dev/csrf') return new Response('tok-1234567890abcdef1234');
      if (url.pathname === '/api/project') return Response.json({ projects: [{ id: 'p1', name: 'Paper' }] });
      return new Response('unexpected', { status: 500 });
    });
    const web = client();
    const projects = await web.listProjects();
    expect(projects.map((p) => p.name)).toEqual(['Paper']);
    expect(calls).toEqual(['GET /dev/csrf', 'POST /api/project']);
  });

  it('falls back to the dashboard when the light endpoint is unavailable', async () => {
    const calls = stubFetch((url) => {
      if (url.pathname === '/dev/csrf') return new Response('nope', { status: 404 });
      if (url.pathname === '/project') {
        return new Response('<meta name="ol-user_id" content="u1"><meta name="ol-csrfToken" content="tok-from-dashboard-123">', { headers: { 'content-type': 'text/html' } });
      }
      return new Response('unexpected', { status: 500 });
    });
    expect(await client().getCsrfToken()).toBe('tok-from-dashboard-123');
    expect(calls).toEqual(['GET /dev/csrf', 'GET /project']);
  });
});
