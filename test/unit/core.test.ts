import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractSnapshot, suggestPaths } from '../../src/core/backends/session';
import { threeWayMerge } from '../../src/core/merge';
import { CookieJar } from '../../src/core/overleaf/cookies';
import { ProjectTree } from '../../src/core/overleaf/projectTree';
import { decodeHtmlEntities, parseMetaTags } from '../../src/core/overleaf/webClient';
import { decodeWireLine } from '../../src/core/overleaf/realtime';
import { OverleafService, matchProject, projectIdFromRef, sessionKey } from '../../src/core/service';
import { resolveDataPaths } from '../../src/core/store/paths';
import { CredentialStore, normalizeServerUrl, sessionFromEnv } from '../../src/core/store/credentials';
import { FileSessionSource } from '../../src/core/store/fileSessionSource';
import { SettingsStore } from '../../src/core/store/settings';
import { SnapshotCache } from '../../src/core/store/snapshotCache';
import { withFileLock } from '../../src/core/util/fileLock';
import { normalizeProjectPath, resolveInside } from '../../src/core/util/fsx';
import { silentLogger } from '../../src/core/util/log';
import { diffStats, unifiedDiff } from '../../src/core/util/unifiedDiff';

describe('CookieJar', () => {
  const site = new URL('https://www.overleaf.com/project');

  it('stores Set-Cookie values and sends them back to matching hosts only', () => {
    const jar = CookieJar.fromHeader('', site);
    jar.setCookie('overleaf_session2=abc; Domain=.overleaf.com; Path=/; HttpOnly; Secure', site);
    jar.setCookie('GCLB=xyz; Path=/', site);
    expect(jar.headerFor(site)).toBe('overleaf_session2=abc; GCLB=xyz');
    expect(jar.headerFor(new URL('https://git.overleaf.com/'))).toBe('overleaf_session2=abc');
    expect(jar.headerFor(new URL('https://example.com/'))).toBe('');
    expect(jar.headerFor(new URL('http://www.overleaf.com/'))).toBe('GCLB=xyz');
  });

  it('expires cookies, ignores foreign domains and counts value changes', () => {
    const jar = CookieJar.fromHeader('overleaf_session2=old', site);
    expect(jar.version).toBe(0);
    jar.setCookie('overleaf_session2=new', site);
    expect(jar.version).toBe(1);
    jar.setCookie('overleaf_session2=new; Max-Age=3600', site);
    expect(jar.version).toBe(1);
    jar.setCookie('evil=1; Domain=example.com', site);
    expect(jar.get('evil')).toBeUndefined();
    jar.setCookie('overleaf_session2=gone; Max-Age=0', site);
    expect(jar.get('overleaf_session2')).toBeUndefined();
  });
});

describe('page metadata', () => {
  it('reads ol- meta tags in any attribute order and decodes entities', () => {
    const html = '<meta content="tok&amp;en" name="ol-csrfToken"><meta name="ol-user_id" content="64f0"><meta name="ol-user" data-type="json" content="{&quot;email&quot;:&quot;a@b.c&quot;}"><meta name="viewport" content="x">';
    const tags = parseMetaTags(html);
    expect(tags.get('ol-csrfToken')).toBe('tok&en');
    expect(tags.get('ol-user_id')).toBe('64f0');
    expect(JSON.parse(tags.get('ol-user')!)).toEqual({ email: 'a@b.c' });
    expect(tags.has('viewport')).toBe(false);
    expect(decodeHtmlEntities('&#x27;&#39;&lt;&#8212;')).toBe("''<—");
  });

  it('decodes realtime doc lines (UTF-8 bytes sent as Latin-1)', () => {
    expect(decodeWireLine(Buffer.from('Grüße — 数学', 'utf8').toString('latin1'))).toBe('Grüße — 数学');
  });
});

describe('project matching', () => {
  const projects = [
    { id: 'a'.repeat(24), name: 'Robotics Paper' },
    { id: 'b'.repeat(24), name: 'Robotics Thesis' },
    { id: 'c'.repeat(24), name: 'Thesis Draft', archived: true },
    { id: 'd'.repeat(24), name: 'Thesis Draft' },
    { id: 'e'.repeat(24), name: 'NeurIPS 2026 submission' },
  ];

  it('prefers exact names, then unique substrings, then all words', () => {
    expect(matchProject(projects, 'robotics paper').id).toBe('a'.repeat(24));
    expect(matchProject(projects, 'neurips').id).toBe('e'.repeat(24));
    expect(matchProject(projects, 'submission 2026').id).toBe('e'.repeat(24));
  });

  it('prefers active projects over archived duplicates', () => {
    expect(matchProject(projects, 'Thesis Draft').id).toBe('d'.repeat(24));
  });

  it('explains ambiguity and misses', () => {
    expect(() => matchProject(projects, 'robotics')).toThrow(/matches several projects: "Robotics Paper"/);
    expect(() => matchProject(projects, 'quantum robotics')).toThrow(/No project matches "quantum robotics". Closest: "Robotics/);
  });

  it('extracts ids from Overleaf URLs', () => {
    expect(projectIdFromRef('https://www.overleaf.com/project/64F0A1B2C3D4E5F6A7B8C9D0')).toBe('64f0a1b2c3d4e5f6a7b8c9d0');
    expect(projectIdFromRef('My Paper')).toBeUndefined();
  });

  it('suggests close file paths', () => {
    expect(suggestPaths('chapter/intro.tex', [{ path: 'chapters/intro.tex' }, { path: 'main.tex' }])[0]).toBe('chapters/intro.tex');
  });
});

describe('diff and merge', () => {
  it('renders unified diffs with hunks', () => {
    const before = 'a\nb\nc\nd\ne\nf\ng\nh\n';
    const after = 'a\nB\nc\nd\ne\nf\ng\nh\nI\n';
    const diff = unifiedDiff(before, after, { context: 1, label: 'x.tex' });
    expect(diff).toBe('--- a/x.tex\n+++ b/x.tex\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -8,1 +8,2 @@\n h\n+I\n');
    expect(diffStats(before, after)).toEqual({ added: 2, removed: 1 });
  });

  it('rebases our edits onto remote changes', () => {
    const base = 'Title\n\nFirst paragraph.\n\nSecond paragraph.\n';
    const ours = 'Title\n\nFirst paragraph, revised by me.\n\nSecond paragraph.\n';
    const theirs = 'New Title\n\nFirst paragraph.\n\nSecond paragraph, revised by them.\n';
    const merged = threeWayMerge(base, ours, theirs);
    expect(merged.clean).toBe(true);
    expect(merged.merged).toBe('New Title\n\nFirst paragraph, revised by me.\n\nSecond paragraph, revised by them.\n');
  });

  it('flags edits that collide', () => {
    const merged = threeWayMerge('The result is 5.\n', 'The result is 6.\n', 'The answer was 7, not 5.\n');
    expect(merged.clean).toBe(false);
  });
});

describe('project tree', () => {
  it('tracks realtime add/rename/move/remove events', () => {
    const tree = new ProjectTree({ _id: 'root', name: 'rootFolder', docs: [{ _id: 'd1', name: 'main.tex' }], fileRefs: [], folders: [{ _id: 'f1', name: 'chapters', docs: [], fileRefs: [], folders: [] }] });
    tree.addEntity('f1', 'doc', { _id: 'd2', name: 'intro.tex' });
    expect(tree.find('chapters/intro.tex')?.id).toBe('d2');
    tree.renameEntity('d2', 'start.tex');
    tree.moveEntity('d2', 'root');
    expect(tree.pathOf('d2')).toBe('start.tex');
    tree.removeEntity('f1');
    expect(tree.entries().map((e) => e.path)).toEqual(['main.tex', 'start.tex']);
    expect(tree.folderId('')).toBe('root');
  });
});

describe('snapshot extraction', () => {
  it('keeps text files, lists binaries, and blocks path escapes', () => {
    const zip = zipSync({
      'main.tex': strToU8('\\documentclass{article}'),
      'figs/plot.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]),
      'data/table.unknownext': strToU8('a,b\n1,2\n'),
      'figs/': new Uint8Array(),
    });
    const { files, skipped } = extractSnapshot(zip);
    expect(files.map(([name]) => name).sort()).toEqual(['data/table.unknownext', 'main.tex']);
    expect(skipped).toEqual([{ path: 'figs/plot.png', size: 7 }]);
  });
});

describe('paths', () => {
  it('normalizes project paths and refuses to escape', () => {
    expect(normalizeProjectPath('/chapters\\intro.tex')).toBe('chapters/intro.tex');
    expect(normalizeProjectPath('a/./b/../c.tex')).toBe('a/c.tex');
    expect(() => normalizeProjectPath('../secret')).toThrow(/escapes/);
    expect(() => resolveInside('/tmp/root', 'a/../../etc/passwd')).toThrow(/escapes/);
    expect(resolveInside(path.resolve('/tmp/root'), 'a/b.tex')).toBe(path.resolve('/tmp/root', 'a', 'b.tex'));
  });

  it('normalizes server URLs', () => {
    expect(normalizeServerUrl(undefined)).toBe('https://www.overleaf.com');
    expect(normalizeServerUrl('overleaf.example.org/')).toBe('https://overleaf.example.org');
    expect(normalizeServerUrl('http://localhost:8090/sub/path/')).toBe('http://localhost:8090/sub/path');
  });
});

describe('local stores', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'overleaf-store-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('serializes work across lock holders', async () => {
    const order: string[] = [];
    const lock = path.join(dir, 'locks', 'x.lock');
    await Promise.all(
      ['a', 'b', 'c'].map((name) =>
        withFileLock(lock, async () => {
          order.push(`${name}+`);
          await new Promise((r) => setTimeout(r, 20));
          order.push(`${name}-`);
        }),
      ),
    );
    for (let i = 0; i < order.length; i += 2) expect(order[i + 1]).toBe(order[i].replace('+', '-'));
  });

  it('caches snapshots and keeps them in step with edits', async () => {
    const cache = new SnapshotCache(path.join(dir, 'cache'), path.join(dir, 'locks'), silentLogger);
    expect(await cache.meta('p1')).toBeUndefined();
    const meta = await cache.replace('p1', 'Paper', '2026-10-01T00:00:00Z', [['main.tex', strToU8('hello')], ['ch/a.tex', strToU8('a')]]);
    expect(cache.isFresh(meta, '2026-10-01T00:00:00Z', 60_000)).toBe(true);
    expect(cache.isFresh(meta, '2026-10-02T00:00:00Z', 60_000)).toBe(false);
    await cache.writeFile('p1', 'main.tex', 'edited');
    await cache.moveFile('p1', 'ch/a.tex', 'ch/b.tex');
    expect(await cache.readText('p1', 'main.tex')).toBe('edited');
    expect(await cache.listTextFiles('p1')).toEqual(['ch/b.tex', 'main.tex']);
    await expect(cache.writeFile('p1', '../escape.tex', 'x')).rejects.toThrow(/escapes/);
  });

  it('shares pins through the settings file', async () => {
    const a = new SettingsStore(path.join(dir, 'settings.json'));
    const b = new SettingsStore(path.join(dir, 'settings.json'));
    await a.update((s) => ({ ...s, pinnedProjects: ['p1', 'p2'] }));
    expect((await b.read(0)).pinnedProjects).toEqual(['p1', 'p2']);
  });

  it('never writes back a session that was signed out or replaced', async () => {
    const file = path.join(dir, 'credentials.json');
    const store = new CredentialStore(file);
    const source = new FileSessionSource(store, file);
    const session = { serverUrl: 'https://www.overleaf.com', cookies: 'overleaf_session2=s1; GCLB=a', savedAt: 'now' };
    await store.write(session);
    expect((await source.load())?.cookies).toBe(session.cookies);
    await source.save({ ...session, cookies: 'overleaf_session2=s1; GCLB=b' });
    expect((await store.read())?.cookies).toBe('overleaf_session2=s1; GCLB=b');
    await store.clear();
    await source.save(session);
    expect(await store.read()).toBeUndefined();
    expect(sessionKey(session)).toBe('https://www.overleaf.com|s1');
  });

  it('chooses which projects multi-project tools cover', async () => {
    const service = new OverleafService({ paths: resolveDataPaths(dir), logger: silentLogger, session: { load: async () => undefined } });
    const projects = Array.from({ length: 30 }, (_, i) => ({
      id: i.toString(16).padStart(24, '0'),
      name: `Paper ${i}`,
      lastUpdated: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
      archived: i === 29,
    }));
    // Prime the project-list cache instead of talking to a server.
    (service as unknown as { projectList: unknown }).projectList = { at: Date.now(), projects, tags: [], sessionIds: new Set(projects.map((p) => p.id)) };

    const recent = await service.resolveSelection(undefined);
    expect(recent.projects).toHaveLength(25);
    expect(recent.projects[0].name).toBe('Paper 28');
    expect(recent.note).toMatch(/25 most recently updated of 29/);
    expect((await service.resolveSelection('all')).projects).toHaveLength(29);
    expect((await service.resolveSelection(['Paper 3', 'paper 3'])).projects.map((p) => p.name)).toEqual(['Paper 3']);

    await service.setPinned(['Paper 5'], true);
    const pinned = await service.resolveSelection(undefined);
    expect(pinned.projects.map((p) => p.name)).toEqual(['Paper 5']);
    expect((await service.resolveProject(undefined)).name).toBe('Paper 5');
  });

  it('lets environment variables override the file (headless use)', () => {
    expect(sessionFromEnv({ OVERLEAF_SESSION: 'abc' })).toMatchObject({ cookies: 'overleaf_session2=abc', serverUrl: 'https://www.overleaf.com', method: 'env' });
    expect(sessionFromEnv({ OVERLEAF_COOKIES: 'overleaf.sid=x', OVERLEAF_SERVER_URL: 'http://localhost:8090' })?.serverUrl).toBe('http://localhost:8090');
    expect(sessionFromEnv({})).toBeUndefined();
  });
});
