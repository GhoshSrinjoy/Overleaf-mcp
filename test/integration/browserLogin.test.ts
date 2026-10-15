import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { browserSignIn, findChromiumBrowser } from '../../src/core/browserLogin';
import { ADMIN_EMAIL, ADMIN_PASSWORD, SERVER_URL, ensureAdmin, logger, serverAvailable } from './helpers';

const browser = await findChromiumBrowser();
const available = (await serverAvailable()) && !!browser;

/** Plays the person at the keyboard: fills in the login form of the page the sign-in flow opened. */
async function fillLoginForm(devtoolsUrl: string): Promise<void> {
  const port = new URL(devtoolsUrl).port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
      const page = targets.find((t) => t.type === 'page' && t.url.includes('/login'));
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject));
        const expression = `(() => {
          const email = document.querySelector('input[name=email]');
          const password = document.querySelector('input[name=password]');
          if (!email || !password) return false;
          email.value = ${JSON.stringify(ADMIN_EMAIL)};
          password.value = ${JSON.stringify(ADMIN_PASSWORD)};
          (document.querySelector('button[type=submit]') || email.form.querySelector('button')).click();
          return true;
        })()`;
        const done = await new Promise<boolean>((resolve) => {
          ws.on('message', (data) => resolve(JSON.parse(data.toString()).result?.result?.value === true));
          ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression } }));
        });
        ws.close();
        if (done) return;
      }
    } catch {
      // page not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('login form never appeared');
}

describe.skipIf(!available)('browser sign-in', () => {
  it('captures the session after the person logs in on the real login page', async () => {
    await ensureAdmin();
    let formFilled: Promise<void> | undefined;
    const signedIn = await browserSignIn({
      serverUrl: SERVER_URL,
      browserPath: browser,
      logger,
      timeoutMs: 60_000,
      extraArgs: ['--headless=new'],
      onBrowserReady: (url) => {
        formFilled = fillLoginForm(url);
      },
    });
    await formFilled;
    expect(signedIn.info.email).toBe(ADMIN_EMAIL);
    expect(signedIn.session.serverUrl).toBe(SERVER_URL);
    expect(signedIn.session.cookies).toMatch(/overleaf\.sid=|sharelatex\.sid=/);
  }, 90_000);
});
