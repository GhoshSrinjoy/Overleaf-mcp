import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { folderProblem, safeFolderName } from '../../src/core/mirror/folders';
import { makeIgnoreMatcher } from '../../src/core/mirror/ignore';
import { caseCollisions, hasConflictMarkers, localNameProblem } from '../../src/core/mirror/mirror';
import { withFileLock } from '../../src/core/util/fileLock';

describe('names a computer cannot store', () => {
  it('flags Windows-invalid and reserved names only on Windows', () => {
    expect(localNameProblem('figs/fig:1.png', 'win32')).toMatch(/":" is not allowed/);
    expect(localNameProblem('what?.tex', 'win32')).toMatch(/"\?" is not allowed/);
    expect(localNameProblem('notes/CON.tex', 'win32')).toMatch(/reserved name/);
    expect(localNameProblem('trailing./a.tex', 'win32')).toMatch(/dot or space/);
    expect(localNameProblem('figs/fig:1.png', 'linux')).toBeUndefined();
    expect(localNameProblem('chapters/intro.tex', 'win32')).toBeUndefined();
  });

  it('finds paths that collide when case is ignored', () => {
    const paths = ['Intro.tex', 'intro.tex', 'Figures/a.png', 'figures/b.png', 'main.tex'];
    expect([...caseCollisions(paths, 'win32')].sort()).toEqual(['Figures/a.png', 'Intro.tex', 'figures/b.png', 'intro.tex']);
    expect(caseCollisions(paths, 'linux').size).toBe(0);
  });

  it('recognizes the mirror conflict markers', () => {
    expect(hasConflictMarkers('a\n<<<<<<< local (this computer)\nx\n=======\ny\n>>>>>>> overleaf\nb')).toBe(true);
    expect(hasConflictMarkers('<<<<<<< HEAD\nnot ours\n>>>>>>> branch')).toBe(false);
  });

  it('never syncs git metadata, whatever the ignore file says', () => {
    const ignored = makeIgnoreMatcher('!.git/\n');
    expect(ignored('.git/hooks/pre-commit')).toBe(true);
    expect(ignored('.GIT/config')).toBe(true);
    expect(ignored('chapters/.gitkeep')).toBe(false);
    expect(ignored('main.aux')).toBe(false);
    expect(makeIgnoreMatcher('*.aux\n')('sub/main.aux')).toBe(true);
  });
});

describe('sync folders', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'overleaf-folders-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('derives safe folder names', () => {
    expect(safeFolderName('..')).toBe('project');
    expect(safeFolderName('My: Paper?')).toBe('My_ Paper_');
    expect(safeFolderName('CON')).toBe('CON_');
    expect(safeFolderName('Thesis.')).toBe('Thesis');
  });

  it('only accepts new, empty, or same-project folders', async () => {
    expect(await folderProblem(path.join(dir, 'new'), 'p1')).toBeUndefined();
    mkdirSync(path.join(dir, 'empty'));
    expect(await folderProblem(path.join(dir, 'empty'), 'p1')).toBeUndefined();
    mkdirSync(path.join(dir, 'busy'));
    writeFileSync(path.join(dir, 'busy', 'notes.txt'), 'x');
    expect(await folderProblem(path.join(dir, 'busy'), 'p1')).toMatch(/not empty/);
    mkdirSync(path.join(dir, 'synced', '.overleaf'), { recursive: true });
    writeFileSync(path.join(dir, 'synced', '.overleaf', 'state.json'), JSON.stringify({ projectId: 'p1' }));
    expect(await folderProblem(path.join(dir, 'synced'), 'p1')).toBeUndefined();
    expect(await folderProblem(path.join(dir, 'synced'), 'p2')).toMatch(/different Overleaf project/);
  });

  it('never removes a lock that another holder took over', async () => {
    const lock = path.join(dir, 'locks', 'x.lock');
    await withFileLock(lock, async () => {
      // Simulate someone else breaking the lock as stale and taking it.
      await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now(), token: 'someone-else' }));
    });
    const owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8'));
    expect(owner.token).toBe('someone-else');
  });
});
