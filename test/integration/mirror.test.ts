import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectMirror, SyncReport, conflictText } from '../../src/core/mirror/mirror';
import { OverleafService } from '../../src/core/service';
import { StoredSession } from '../../src/core/store/credentials';
import { resolveDataPaths } from '../../src/core/store/paths';
import { logger, serverAvailable, testSession } from './helpers';

const available = await serverAvailable();

async function waitFor(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe.skipIf(!available)('two-way local mirror', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'overleaf-mirror-'));
  const dir = path.join(root, 'Paper');
  let session: StoredSession;
  let service: OverleafService;
  /** A second, independent client: a collaborator, or an AI tool in another process. */
  let other: OverleafService;
  let projectId: string;
  let mirror: ProjectMirror;
  const reports: SyncReport[] = [];

  const local = (file: string) => readFileSync(path.join(dir, file), 'utf8');
  const remote = async (file: string) => (await other.readFile(projectId, file)).content.text;
  const remoteFiles = async () => (await other.listFiles(projectId)).tree.entries.map((e) => e.path);
  const startMirror = async () => {
    mirror = new ProjectMirror({ service, projectId, dir, logger, localDebounceMs: 100, onReport: (r) => reports.push(r) });
    return mirror.start();
  };

  beforeAll(async () => {
    session = await testSession();
    service = new OverleafService({ paths: resolveDataPaths(path.join(root, 'home-a')), logger, session: { load: async () => session } });
    other = new OverleafService({ paths: resolveDataPaths(path.join(root, 'home-b')), logger, session: { load: async () => session } });
    projectId = (await service.createProject(`mirror-${Date.now()}`, 'example')).id;
  });

  afterAll(async () => {
    await mirror?.stop();
    service?.dispose();
    other?.dispose();
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('downloads the whole project on first sync, binaries included', async () => {
    const report = await startMirror();
    expect(report.pulled).toEqual(expect.arrayContaining(['main.tex', 'sample.bib', 'frog.jpg']));
    expect(readFileSync(path.join(dir, 'frog.jpg')).length).toBeGreaterThan(1000);
    expect(local('.overleafignore')).toContain('/main.pdf');
    expect(existsSync(path.join(dir, '.overleaf', 'state.json'))).toBe(true);
  });

  it('pushes a local save to Overleaf', async () => {
    writeFileSync(path.join(dir, 'main.tex'), local('main.tex').replace('\\begin{document}', '\\begin{document}\n% LOCAL-SAVE'));
    await waitFor(async () => (await remote('main.tex')).includes('% LOCAL-SAVE'), 'the local save to reach Overleaf');
  });

  it('writes edits made on Overleaf into the local file', async () => {
    await other.editFile(projectId, 'main.tex', [{ oldText: '% LOCAL-SAVE', newText: '% LOCAL-SAVE\n% REMOTE-EDIT' }]);
    await waitFor(() => local('main.tex').includes('% REMOTE-EDIT'), 'the remote edit to arrive locally');
  });

  it('syncs new and deleted files in both directions, keeping build output local', async () => {
    mkdirSync(path.join(dir, 'chapters'), { recursive: true });
    writeFileSync(path.join(dir, 'chapters', 'local-new.tex'), '\\section{Made locally}\n');
    writeFileSync(path.join(dir, 'main.aux'), 'build output');
    await waitFor(async () => (await remoteFiles()).includes('chapters/local-new.tex'), 'the new local file on Overleaf');
    expect(await remoteFiles()).not.toContain('main.aux');

    await other.writeFile(projectId, 'remote-new.tex', '\\section{Made on Overleaf}\n');
    await waitFor(() => existsSync(path.join(dir, 'remote-new.tex')), 'the new remote file locally');

    unlinkSync(path.join(dir, 'chapters', 'local-new.tex'));
    await waitFor(async () => !(await remoteFiles()).includes('chapters/local-new.tex'), 'the local deletion on Overleaf');
    await other.deleteFile(projectId, 'remote-new.tex');
    await waitFor(() => !existsSync(path.join(dir, 'remote-new.tex')), 'the remote deletion locally');
  });

  it('merges edits made on both sides while sync was off', async () => {
    await mirror.stop();
    writeFileSync(path.join(dir, 'main.tex'), local('main.tex').replace('% REMOTE-EDIT', '% REMOTE-EDIT\n% OFFLINE-LOCAL'));
    await other.editFile(projectId, 'main.tex', [{ oldText: '\\end{document}', newText: '% OFFLINE-REMOTE\n\\end{document}' }]);
    const report = await startMirror();
    expect(report.merged).toContain('main.tex');
    expect(local('main.tex')).toContain('% OFFLINE-LOCAL');
    expect(local('main.tex')).toContain('% OFFLINE-REMOTE');
    await waitFor(async () => (await remote('main.tex')).includes('% OFFLINE-LOCAL'), 'the merge on Overleaf');
  });

  it('marks clashing edits with conflict markers instead of overwriting', async () => {
    await mirror.stop();
    writeFileSync(path.join(dir, 'main.tex'), local('main.tex').replace('% OFFLINE-LOCAL', '% CHANGED HERE'));
    await other.editFile(projectId, 'main.tex', [{ oldText: '% OFFLINE-LOCAL', newText: '% CHANGED THERE' }]);
    const report = await startMirror();
    expect(report.conflicts).toContain('main.tex');
    const text = local('main.tex');
    expect(text).toMatch(/<<<<<<< local \(this computer\)\n% CHANGED HERE\n=======\n% CHANGED THERE\n>>>>>>> overleaf/);
    // Resolving and saving pushes the resolution.
    writeFileSync(path.join(dir, 'main.tex'), text.replace(/<<<<<<< local[\s\S]*?>>>>>>> overleaf/, '% RESOLVED'));
    await waitFor(async () => (await remote('main.tex')).includes('% RESOLVED'), 'the resolution on Overleaf');
    expect(await remote('main.tex')).not.toContain('<<<<<<<');
  });
});

describe.skipIf(!available)('local mirror conflicts while running', () => {
  it('never uploads conflict markers it wrote itself', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'overleaf-mirror-live-'));
    const dir = path.join(root, 'Paper');
    const session = await testSession();
    const service = new OverleafService({ paths: resolveDataPaths(path.join(root, 'a')), logger, session: { load: async () => session } });
    const other = new OverleafService({ paths: resolveDataPaths(path.join(root, 'b')), logger, session: { load: async () => session } });
    const projectId = (await service.createProject(`mirror-live-${Date.now()}`, 'example')).id;
    // A slow debounce lets a full sync find the clash before the watcher reacts to the local save.
    const mirror = new ProjectMirror({ service, projectId, dir, logger, localDebounceMs: 3000 });
    try {
      await mirror.start();
      const file = path.join(dir, 'main.tex');
      writeFileSync(file, readFileSync(file, 'utf8').replace('\\section{Introduction}', '\\section{Local Title}'));
      await other.editFile(projectId, 'main.tex', [{ oldText: '\\section{Introduction}', newText: '\\section{Remote Title}' }]);
      const report = await mirror.syncNow();
      expect(report.conflicts).toContain('main.tex');
      expect(readFileSync(file, 'utf8')).toContain('<<<<<<< local (this computer)');
      // Give the watcher time to see both the person's save and the marker write.
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const remote = (await other.readFile(projectId, 'main.tex')).content.text;
      expect(remote).not.toContain('<<<<<<<');
      expect(remote).toContain('\\section{Remote Title}');
    } finally {
      await mirror.stop();
      service.dispose();
      other.dispose();
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 120_000);
});

describe('conflictText', () => {
  it('only wraps the lines that differ', () => {
    expect(conflictText('a\nb\nmine\nz', 'a\nb\ntheirs\nz')).toBe('a\nb\n<<<<<<< local (this computer)\nmine\n=======\ntheirs\n>>>>>>> overleaf\nz');
  });
});
