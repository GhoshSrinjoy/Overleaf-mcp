import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RealtimeProject } from '../../src/core/overleaf/realtime';
import { OverleafWebClient } from '../../src/core/overleaf/webClient';
import { signInWithCookie, signInWithPassword } from '../../src/core/auth';
import { ADMIN_EMAIL, ADMIN_PASSWORD, SERVER_URL, logger, login, serverAvailable, testSession } from './helpers';

const available = await serverAvailable();

describe.skipIf(!available)('Overleaf protocol against a local Community Edition server', () => {
  let web: OverleafWebClient;
  let projectId: string;
  let realtime: RealtimeProject;

  beforeAll(async () => {
    web = await login();
    projectId = await web.createProject(`protocol-test-${Date.now()}`, 'example');
    realtime = await RealtimeProject.connect(web, projectId, logger);
  }, 120_000);

  afterAll(() => realtime?.close());

  it('verifies the session and lists the new project', async () => {
    const session = await web.verifySession();
    expect(session.userId).toMatch(/^[0-9a-f]{24}$/);
    const projects = await web.listProjects();
    const project = projects.find((p) => p.id === projectId);
    expect(project?.name).toMatch(/^protocol-test-/);
    expect(project?.accessLevel).toBe('owner');
    expect(project?.lastUpdated).toBeTruthy();
  });

  it('receives the project tree over the realtime connection', () => {
    const paths = realtime.tree.entries().map((e) => e.path);
    expect(paths).toContain('main.tex');
    expect(realtime.permissionsLevel).toBe('owner');
    expect(realtime.project.rootDoc_id).toBeTruthy();
  });

  it('reads a doc, applies a live edit and reads it back', async () => {
    const main = realtime.tree.find('main.tex')!;
    const before = await realtime.readDoc(main.id);
    expect(before.text).toContain('\\documentclass');
    const marker = `% edited by overleaf-mcp ✓ ${Date.now()}`;
    const result = await realtime.applyText(before, `${before.text}\n${marker}\n`);
    expect(result.changed).toBe(true);
    expect(result.version).toBeGreaterThan(before.version);
    const after = await realtime.readDoc(main.id);
    expect(after.text).toContain(marker);
    expect(await web.downloadDoc(projectId, main.id)).toContain(marker);
  });

  it('downloads the project zip including the edit', async () => {
    const files = unzipSync(await web.downloadZip(projectId));
    expect(Object.keys(files)).toContain('main.tex');
    expect(new TextDecoder().decode(files['main.tex'])).toContain('edited by overleaf-mcp');
  });

  it('uploads a new file into a new folder and sees the tree event', async () => {
    const treeChanged = new Promise<void>((resolve) => realtime.addListener({ treeChanged: resolve }));
    const result = await web.upload(projectId, realtime.tree.rootFolderId, 'notes.tex', 'Hello from the upload API\n', 'extra/notes.tex');
    expect(result.entityType).toBe('doc');
    await treeChanged;
    await new Promise((r) => setTimeout(r, 300));
    expect(realtime.tree.find('extra/notes.tex')?.type).toBe('doc');
  });

  it('accepts pasted cookies in every common form and rejects bad ones', async () => {
    const session = await testSession();
    const value = session.cookies.split(';').map((c) => c.trim()).find((c) => /^(overleaf\.sid|sharelatex\.sid)=/.test(c))!.split('=').slice(1).join('=');
    for (const input of [value, `overleaf.sid=${value}`, `Cookie: overleaf.sid=${value}; other=1`]) {
      const signedIn = await signInWithCookie(SERVER_URL, input, logger);
      expect(signedIn.info.email).toBe(ADMIN_EMAIL);
    }
    await expect(signInWithCookie(SERVER_URL, 's%3Anot-a-real-session.sig', logger)).rejects.toThrow(/not a signed-in session/);
  });

  it('ends a session on the server when signing out', async () => {
    const fresh = await signInWithPassword(SERVER_URL, ADMIN_EMAIL, ADMIN_PASSWORD, logger);
    const client = new OverleafWebClient({ serverUrl: SERVER_URL, cookies: fresh.session.cookies, logger });
    await client.verifySession();
    await client.logout();
    await expect(new OverleafWebClient({ serverUrl: SERVER_URL, cookies: fresh.session.cookies, logger }).verifySession()).rejects.toThrow(/Not signed in/);
  });

  it('compiles the project and downloads the log', async () => {
    const compile = await web.compile(projectId, { rootDocId: realtime.project.rootDoc_id ?? undefined });
    expect(compile.status).toBe('success');
    const log = compile.outputFiles?.find((f) => f.path === 'output.log');
    expect(log).toBeTruthy();
    const text = new TextDecoder().decode(await web.downloadOutputFile(log!, compile));
    expect(text).toContain('This is');
  }, 240_000);
});
