/*
 * A demo account with a few projects on the local Overleaf, for the README screenshots
 * (`npm run screenshots`). Created once and reused; nothing here touches overleaf.com.
 */
import { signInWithPassword } from '../../src/core/auth';
import { OverleafWebClient, parseMetaTags } from '../../src/core/overleaf/webClient';
import { StoredSession } from '../../src/core/store/credentials';
import { SERVER_URL, logger, testSession } from '../integration/helpers';

const DEMO_EMAIL = 'demo@example.com';
const DEMO_PASSWORD = 'Typeset-Demo-2026';

/** Project name → role in the screenshots. */
export const DEMO_PROJECTS = {
  paper: 'Workshop Paper',
  thesis: 'PhD Thesis',
  grant: 'Grant Proposal',
  notes: 'Lecture Notes',
} as const;

export type DemoProjects = Record<keyof typeof DEMO_PROJECTS, string>;

async function registerDemoUser(): Promise<void> {
  const admin = await testSession();
  const adminClient = new OverleafWebClient({ serverUrl: SERVER_URL, cookies: admin.cookies, logger });
  const registered = await adminClient.request('POST', 'admin/register', { json: { email: DEMO_EMAIL } });
  const { setNewPasswordUrl } = (await registered.json()) as { setNewPasswordUrl: string };
  const token = new URL(setNewPasswordUrl).searchParams.get('token');
  if (!token) throw new Error(`Unexpected activation link: ${setNewPasswordUrl}`);
  // Set the password from a fresh (signed-out) session, as the activation page would.
  const page = await fetch(`${SERVER_URL}/login`);
  const cookies = page.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const csrf = parseMetaTags(await page.text()).get('ol-csrfToken');
  if (!csrf) throw new Error('No CSRF token on the login page');
  const set = await fetch(`${SERVER_URL}/user/password/set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Csrf-Token': csrf, Cookie: cookies },
    body: JSON.stringify({ passwordResetToken: token, password: DEMO_PASSWORD, email: DEMO_EMAIL }),
    redirect: 'manual',
  });
  if (set.status >= 400) throw new Error(`Setting the demo password failed: HTTP ${set.status} ${await set.text()}`);
  await set.body?.cancel();
}

export async function demoAccount(): Promise<{ session: StoredSession; projects: DemoProjects }> {
  let signedIn;
  try {
    signedIn = await signInWithPassword(SERVER_URL, DEMO_EMAIL, DEMO_PASSWORD, logger);
  } catch {
    await registerDemoUser();
    signedIn = await signInWithPassword(SERVER_URL, DEMO_EMAIL, DEMO_PASSWORD, logger);
  }
  const web = new OverleafWebClient({ serverUrl: SERVER_URL, cookies: signedIn.session.cookies, logger });
  const existing = (await web.listProjects()).filter((p) => !p.trashed && !p.archived);
  const projects = {} as DemoProjects;
  for (const [role, name] of Object.entries(DEMO_PROJECTS) as Array<[keyof DemoProjects, string]>) {
    projects[role] = existing.find((p) => p.name === name)?.id ?? (await web.createProject(name, role === 'grant' ? 'none' : 'example'));
  }
  return { session: signedIn.session, projects };
}
