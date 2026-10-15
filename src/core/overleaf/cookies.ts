interface Cookie {
  name: string;
  value: string;
  /** Lowercase, without a leading dot. */
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  expires?: number;
}

/** Cookie names Overleaf uses for the login session (overleaf.com, Community Edition, older installs). */
export const SESSION_COOKIE_NAMES = ['overleaf_session2', 'overleaf.sid', 'sharelatex.sid'];

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

function domainMatches(host: string, cookie: Cookie): boolean {
  if (cookie.hostOnly) return host === cookie.domain;
  return host === cookie.domain || host.endsWith(`.${cookie.domain}`);
}

/** Minimal RFC 6265 cookie jar: enough for one Overleaf server and its load balancer. */
export class CookieJar {
  private cookies: Cookie[] = [];
  /** Bumped whenever a cookie value changes, so callers know when to persist. */
  version = 0;

  /** Seeds the jar from a stored or pasted Cookie header ("a=b; c=d"). */
  static fromHeader(header: string, url: URL): CookieJar {
    const jar = new CookieJar();
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (!name) continue;
      jar.upsert({ name, value, domain: url.hostname.toLowerCase(), hostOnly: true, path: '/', secure: false });
    }
    jar.version = 0;
    return jar;
  }

  private upsert(cookie: Cookie): void {
    const index = this.cookies.findIndex((c) => c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path);
    const expired = cookie.expires !== undefined && cookie.expires <= Date.now();
    if (index === -1) {
      if (expired) return;
      this.cookies.push(cookie);
      this.version++;
      return;
    }
    if (expired) {
      this.cookies.splice(index, 1);
      this.version++;
      return;
    }
    if (this.cookies[index].value !== cookie.value) this.version++;
    this.cookies[index] = cookie;
  }

  setCookie(line: string, requestUrl: URL): void {
    const [pair, ...attributes] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) return;
    const cookie: Cookie = {
      name: pair.slice(0, eq).trim(),
      value: pair.slice(eq + 1).trim(),
      domain: requestUrl.hostname.toLowerCase(),
      hostOnly: true,
      path: '/',
      secure: false,
    };
    let maxAge: number | undefined;
    for (const attribute of attributes) {
      const [rawKey, ...rest] = attribute.split('=');
      const key = rawKey.trim().toLowerCase();
      const value = rest.join('=').trim();
      if (key === 'domain' && value) {
        const domain = value.replace(/^\./, '').toLowerCase();
        const host = requestUrl.hostname.toLowerCase();
        // Ignore cookies a server tries to set for an unrelated domain.
        if (host !== domain && !host.endsWith(`.${domain}`)) return;
        cookie.domain = domain;
        cookie.hostOnly = false;
      } else if (key === 'path' && value.startsWith('/')) {
        cookie.path = value;
      } else if (key === 'secure') {
        cookie.secure = true;
      } else if (key === 'max-age') {
        const seconds = Number(value);
        if (Number.isFinite(seconds)) maxAge = seconds;
      } else if (key === 'expires') {
        const time = Date.parse(value);
        if (Number.isFinite(time)) cookie.expires = time;
      }
    }
    if (maxAge !== undefined) cookie.expires = Date.now() + maxAge * 1000;
    this.upsert(cookie);
  }

  storeFromResponse(headers: Headers, requestUrl: URL): void {
    for (const line of headers.getSetCookie()) this.setCookie(line, requestUrl);
  }

  headerFor(url: URL): string {
    const host = url.hostname.toLowerCase();
    const now = Date.now();
    this.cookies = this.cookies.filter((c) => c.expires === undefined || c.expires > now);
    return this.cookies
      .filter((c) => domainMatches(host, c) && pathMatches(url.pathname || '/', c.path) && (!c.secure || url.protocol === 'https:'))
      .sort((a, b) => b.path.length - a.path.length)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  get(name: string): string | undefined {
    return this.cookies.find((c) => c.name === name)?.value;
  }

  sessionCookieName(): string | undefined {
    return SESSION_COOKIE_NAMES.find((name) => this.get(name) !== undefined);
  }
}
