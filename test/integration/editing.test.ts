import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RealtimeProject } from '../../src/core/overleaf/realtime';
import { OverleafWebClient } from '../../src/core/overleaf/webClient';
import { logger, login, serverAvailable, testSession } from './helpers';

const MONGO_CONTAINER = process.env.OVERLEAF_TEST_MONGO_CONTAINER ?? 'overleaf-mcp-test-mongo-1';

/** Switches a project to Overleaf's newer "history-ot" document format (stage > 0). */
function enableHistoryOt(projectId: string): boolean {
  try {
    execFileSync('docker', [
      'exec', MONGO_CONTAINER, 'mongosh', '--quiet', 'sharelatex', '--eval',
      `db.projects.updateOne({_id: ObjectId("${projectId}")}, {$set: {"overleaf.history.otMigrationStage": 1}})`,
    ], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const available = await serverAvailable();

for (const format of ['sharejs-text-ot', 'history-ot'] as const) {
  describe.skipIf(!available)(`live editing (${format})`, () => {
    let web: OverleafWebClient;
    let realtime: RealtimeProject;
    let userId: string;
    let docId: string;

    beforeAll(async () => {
      web = await login();
      userId = (await testSession()).userId!;
      const projectId = await web.createProject(`editing-${format}-${Date.now()}`, 'none');
      if (format === 'history-ot' && !enableHistoryOt(projectId)) throw new Error('could not switch the project to history-ot');
      realtime = await RealtimeProject.connect(web, projectId, logger);
      docId = realtime.tree.find('main.tex')!.id;
    }, 120_000);

    afterAll(() => realtime?.close());

    it('reports the expected document format', async () => {
      expect((await realtime.readDoc(docId)).type).toBe(format);
    });

    it('round-trips non-ASCII text and edits at both ends', async () => {
      let snapshot = await realtime.readDoc(docId);
      const target = `${snapshot.text}\nGrüße, naïve café — 数学 ∑ ≤ ∞ αβγ\n`;
      await realtime.applyText(snapshot, target);
      snapshot = await realtime.readDoc(docId);
      expect(snapshot.text).toBe(target);

      const next = `% header\n${snapshot.text.replace('café', 'Café')}% footer\n`;
      await realtime.applyText(snapshot, next);
      expect((await realtime.readDoc(docId)).text).toBe(next);
    });

    it('rejects emoji before sending, keeping the connection usable', async () => {
      const snapshot = await realtime.readDoc(docId);
      await expect(realtime.applyText(snapshot, `${snapshot.text}😀\n`)).rejects.toThrow(/Basic Multilingual Plane.*line \d+/);
      expect(realtime.isOpen).toBe(true);
      expect((await realtime.readDoc(docId)).text).toBe(snapshot.text);
    });

    it('merges an edit made against an older version with a concurrent edit', async () => {
      const base = await realtime.readDoc(docId);
      // A collaborator edits first…
      const collaborator = await RealtimeProject.connect(web, realtime.projectId, logger);
      try {
        const theirs = await collaborator.readDoc(docId);
        await collaborator.applyText(theirs, `${theirs.text}collaborator line\n`);
      } finally {
        collaborator.close();
      }
      // …then we send an edit computed against the old version; the server transforms it.
      await realtime.applyText(base, `our line\n${base.text}`);
      const merged = (await realtime.readDoc(docId)).text;
      expect(merged.startsWith('our line\n')).toBe(true);
      expect(merged).toContain('collaborator line');
    });

    it('hears edits to docs this connection never opened (project-wide broadcast)', async () => {
      const listener = await RealtimeProject.connect(web, realtime.projectId, logger);
      try {
        const heard = new Promise<string>((resolve) => listener.addListener({ docChanged: (change) => resolve(change.docId) }));
        const snapshot = await realtime.readDoc(docId);
        await realtime.applyText(snapshot, `${snapshot.text}% broadcast check\n`);
        expect(await Promise.race([heard, new Promise((resolve) => setTimeout(() => resolve('timeout'), 10_000))])).toBe(docId);
      } finally {
        listener.close();
      }
    });

    it('records edits as tracked changes in suggest mode', async () => {
      const snapshot = await realtime.readDoc(docId);
      const before = snapshot.trackedChanges;
      await realtime.applyText(snapshot, snapshot.text.replace('our line', 'our suggested line'), { track: { userId } });
      const after = await realtime.readDoc(docId);
      expect(after.text).toContain('our suggested line');
      expect(after.trackedChanges).toBeGreaterThan(before);
    });
  });
}
