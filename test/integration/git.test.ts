import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitBackend } from '../../src/core/git/gitBackend';
import { loadGitProjects } from '../../src/core/git/projectsConfig';
import { OverleafService } from '../../src/core/service';
import { resolveDataPaths } from '../../src/core/store/paths';
import { silentLogger } from '../../src/core/util/log';

const PROJECT_ID = '0123456789abcdef01234567';
const TOKEN = 'olp_test_secret_token_value';

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Collaborator', GIT_AUTHOR_EMAIL: 'c@example.com', GIT_COMMITTER_NAME: 'Collaborator', GIT_COMMITTER_EMAIL: 'c@example.com' } });

describe.skipIf(!gitAvailable())('Git-token projects (projects.json mode)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'overleaf-git-'));
  const remotes = path.join(root, 'remotes');
  const bare = path.join(remotes, PROJECT_ID);
  const seed = path.join(root, 'seed');
  let service: OverleafService;
  let pushCount = 0;
  let interfere = false;

  /** A collaborator pushing to the same project from elsewhere. */
  const collaboratorCommit = (file: string, content: string) => {
    const dir = mkdtempSync(path.join(root, 'collab-'));
    git(root, 'clone', '--quiet', bare, dir);
    writeFileSync(path.join(dir, file), content);
    git(dir, 'add', '--all');
    git(dir, 'commit', '--quiet', '-m', `Collaborator edits ${file}`);
    git(dir, 'push', '--quiet', 'origin', 'HEAD:master');
  };

  beforeAll(async () => {
    mkdirSync(remotes, { recursive: true });
    git(root, 'init', '--quiet', '--bare', '--initial-branch=master', bare);
    git(root, 'clone', '--quiet', bare, seed);
    mkdirSync(path.join(seed, 'chapters'));
    writeFileSync(path.join(seed, 'main.tex'), '\\documentclass{article}\n\\begin{document}\n\\section{Intro}\nHello git world.\n\\input{chapters/one}\n\\end{document}\n');
    writeFileSync(path.join(seed, 'chapters', 'one.tex'), '\\section{Chapter One}\nThe unique phrase heliotrope.\n');
    writeFileSync(path.join(seed, 'figure.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    git(seed, 'add', '--all');
    git(seed, 'commit', '--quiet', '-m', 'Initial');
    git(seed, 'push', '--quiet', 'origin', 'HEAD:master');

    const projectsFile = path.join(root, 'projects.json');
    writeFileSync(projectsFile, JSON.stringify({ projects: { default: { name: 'Git Paper', projectId: PROJECT_ID, gitToken: TOKEN }, example: { name: 'Placeholder', projectId: 'YOUR_PROJECT_ID', gitToken: 'x' } } }));
    const gitProjects = await loadGitProjects(projectsFile, {});
    expect(gitProjects.map((p) => p.name)).toEqual(['Git Paper']);

    service = new OverleafService({
      paths: resolveDataPaths(path.join(root, 'home')),
      logger: silentLogger,
      session: { load: async () => undefined },
      gitProjects,
      gitBaseUrl: pathToFileURL(remotes).href,
    });
    // Reach in to install the test seam that simulates a collaborator pushing mid-edit.
    const backend = (service as unknown as { git: GitBackend }).git;
    (backend as unknown as { options: { beforePush: () => Promise<void> } }).options.beforePush = async () => {
      pushCount++;
      if (interfere) {
        interfere = false;
        collaboratorCommit('chapters/one.tex', '\\section{Chapter One}\nThe unique phrase heliotrope.\nCollaborator line.\n');
      }
    };
  });

  afterAll(() => {
    service?.dispose();
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('lists configured projects without a web session', async () => {
    const projects = await service.listProjects();
    expect(projects.map((p) => p.name)).toEqual(['Git Paper']);
    const status = await service.status();
    expect(status.gitProjects).toBe(1);
  });

  it('lists files and guesses the main document', async () => {
    const { tree } = await service.listFiles('Git Paper');
    expect(tree.entries.map((e) => `${e.type}:${e.path}`)).toEqual(['folder:chapters', 'doc:chapters/one.tex', 'file:figure.png', 'doc:main.tex']);
    expect(tree.rootDocPath).toBe('main.tex');
  });

  it('edits with commit + push, and retries when someone pushes first', async () => {
    interfere = true;
    const before = pushCount;
    const { result } = await service.editFile('Git Paper', 'chapters/one.tex', [{ oldText: 'heliotrope.', newText: 'heliotrope, edited by the tool.' }]);
    expect(result.via).toBe('git');
    expect(pushCount - before).toBe(2);
    const check = mkdtempSync(path.join(root, 'check-'));
    git(root, 'clone', '--quiet', bare, check);
    const content = readFileSync(path.join(check, 'chapters', 'one.tex'), 'utf8');
    expect(content).toContain('edited by the tool.');
    expect(content).toContain('Collaborator line.');
  });

  it('creates, moves and deletes files', async () => {
    await service.writeFile('Git Paper', 'notes/todo.tex', '\\section{Todo}\n');
    await service.moveFile('Git Paper', 'notes/todo.tex', 'notes/done.tex');
    await service.deleteFile('Git Paper', 'figure.png');
    const { tree } = await service.listFiles('Git Paper');
    const paths = tree.entries.map((e) => e.path);
    expect(paths).toContain('notes/done.tex');
    expect(paths).not.toContain('notes/todo.tex');
    expect(paths).not.toContain('figure.png');
    await expect(service.createFolder('Git Paper', 'empty')).rejects.toThrow(/empty folders/);
    await expect(service.editFile('Git Paper', 'main.tex', [{ oldText: 'Hello', newText: 'Hi' }], { suggest: true })).rejects.toThrow(/Suggest mode/);
  });

  it('builds the outline and searches the project', async () => {
    const { outline } = await service.outline('Git Paper');
    expect(outline.entries.map((e) => `${e.file}:${e.title}`)).toEqual(['main.tex:Intro', 'chapters/one.tex:Chapter One']);
    const { result } = await service.grep({ query: 'heliotrope', projects: ['Git Paper'] });
    expect(result.matches.map((m) => `${m.file}:${m.line}`)).toEqual(['chapters/one.tex:2']);
  });

  it('shows git history as versions and diffs between them', async () => {
    const { updates } = await service.history('Git Paper', { limit: 10 });
    expect(updates[0].labels?.[0]?.comment).toMatch(/^Delete figure\.png/);
    const edit = updates.find((u) => u.pathnames?.includes('chapters/one.tex') && u.labels?.[0]?.comment?.startsWith('Update'))!;
    const { diff } = await service.historyDiff('Git Paper', 'chapters/one.tex', edit.fromV, edit.toV);
    expect(diff).toContain('+The unique phrase heliotrope, edited by the tool.');
  });

  it('refuses paths inside the clone\'s .git folder (no planted hooks or config)', async () => {
    await expect(service.writeFile('Git Paper', '.git/config', '[core]\n\tfsmonitor = calc.exe\n')).rejects.toThrow(/Git metadata folder/);
    await expect(service.writeFile('Git Paper', '.GIT./hooks/pre-commit', '#!/bin/sh\n')).rejects.toThrow(/Git metadata folder/);
    await expect(service.readFile('Git Paper', '.git/config')).rejects.toThrow(/Git metadata folder/);
  });

  it('never writes the token into the clone configuration', () => {
    const config = readFileSync(path.join(root, 'home', 'git', PROJECT_ID, '.git', 'config'), 'utf8');
    expect(config).not.toContain(TOKEN);
    expect(config).not.toMatch(/https?:\/\/[^/\s]*@/);
  });
});
