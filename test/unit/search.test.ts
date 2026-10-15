import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { globToRegExp, makePathFilter } from '../../src/core/search/glob';
import { jsSearch } from '../../src/core/search/jsGrep';
import { LexicalIndex, buildChunks, chunkFile, tokenizeLatex } from '../../src/core/search/lexical';
import { locateRipgrep, ripgrepSearch, vscodeRipgrepCandidates } from '../../src/core/search/ripgrep';
import { isTextPath, looksLikeText } from '../../src/core/search/textFiles';
import { GrepOptions, SearchTarget } from '../../src/core/search/types';

/** ripgrep from $OVERLEAF_MCP_RG, the extension's copy, a downloaded test VS Code, or PATH. */
function ripgrepCandidates(): string[] {
  const candidates = [process.env.OVERLEAF_MCP_RG ?? '', path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.overleaf-mcp', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg')];
  const testInstalls = path.resolve(__dirname, '..', '..', '.vscode-test');
  if (existsSync(testInstalls)) {
    for (const install of readdirSync(testInstalls)) {
      for (const inner of readdirSync(path.join(testInstalls, install), { withFileTypes: true })) {
        if (inner.isDirectory()) candidates.push(...vscodeRipgrepCandidates(path.join(testInstalls, install, inner.name, 'resources', 'app')));
      }
    }
  }
  return candidates;
}

const rg = await locateRipgrep(ripgrepCandidates());

describe('globToRegExp', () => {
  it.each([
    ['*.tex', 'main.tex', true],
    ['*.tex', 'chapters/intro.tex', true],
    ['*.tex', 'main.bib', false],
    ['chapters/*.tex', 'chapters/intro.tex', true],
    ['chapters/*.tex', 'chapters/sub/intro.tex', false],
    ['chapters/**', 'chapters/sub/intro.tex', true],
    ['**/fig?.png', 'a/b/fig1.png', true],
    ['*.{tex,bib}', 'refs.bib', true],
    ['[!m]*.tex', 'main.tex', false],
  ])('%s matches %s → %s', (glob, file, expected) => {
    expect(globToRegExp(glob).test(file)).toBe(expected);
  });

  it('combines includes and excludes', () => {
    const keep = makePathFilter(['*.tex'], ['old/**']);
    expect(keep('a/b.tex')).toBe(true);
    expect(keep('old/b.tex')).toBe(false);
    expect(keep('a/b.bib')).toBe(false);
  });
});

describe('text detection', () => {
  it('decides by name where possible and sniffs otherwise', () => {
    expect(isTextPath('x.tex')).toBe(true);
    expect(isTextPath('fig.PNG')).toBe(false);
    expect(isTextPath('latexmkrc')).toBe(true);
    expect(isTextPath('data.xyz')).toBeUndefined();
    expect(looksLikeText(Buffer.from('plain ü text'))).toBe(true);
    expect(looksLikeText(Buffer.from([0x50, 0x00, 0x51]))).toBe(false);
  });
});

describe('grep engines', () => {
  let root: string;
  let targets: SearchTarget[];

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'overleaf-search-'));
    const write = (rel: string, content: string | Buffer) => {
      const file = path.join(root, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    };
    write('p1/main.tex', '\\section{Intro}\nTransformers are great.\nWe use transformers.\n\\section{Method}\nNothing here.\n');
    write('p1/chapters/related.tex', 'Prior work on Transformer models.\nAnother line.\n');
    write('p1/figure.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x74, 0x72, 0x61, 0x6e, 0x73]));
    write('p2/paper.tex', 'Diffusion models.\nNo transformers? Yes transformers!\n');
    targets = [
      { projectId: 'p1', projectName: 'Paper One', dir: path.join(root, 'p1') },
      { projectId: 'p2', projectName: 'Paper Two', dir: path.join(root, 'p2') },
    ];
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const summary = (matches: Array<{ projectId: string; file: string; line: number; column: number }>) =>
    matches.map((m) => `${m.projectId}/${m.file}:${m.line}:${m.column}`).sort();

  const cases: Array<[string, GrepOptions]> = [
    ['smart case (lowercase query matches any case)', { query: 'transformer' }],
    ['explicit case sensitivity', { query: 'Transformer', caseSensitive: true }],
    ['whole words', { query: 'transformers', wholeWord: true }],
    ['regex', { query: '\\\\section\\{[A-Z]', regex: true }],
    ['include globs', { query: 'transformer', include: ['chapters/**'] }],
  ];

  for (const [name, options] of cases) {
    it(`the JS engine handles ${name}`, async () => {
      const result = await jsSearch(targets, options);
      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches.every((m) => !m.file.endsWith('.png'))).toBe(true);
    });

    it.skipIf(!rg)(`ripgrep and the JS engine agree on ${name}`, async () => {
      const [a, b] = await Promise.all([ripgrepSearch(rg!, targets, options), jsSearch(targets, options)]);
      expect(a.engine).toBe('ripgrep');
      expect(summary(a.matches)).toEqual(summary(b.matches));
    });
  }

  it('returns context lines and respects maxResults', async () => {
    const result = await jsSearch(targets, { query: 'We use', contextLines: 1 });
    expect(result.matches[0]).toMatchObject({ file: 'main.tex', line: 3, before: ['Transformers are great.'], after: ['\\section{Method}'] });
    const limited = await jsSearch(targets, { query: 'transformer', maxResults: 2 });
    expect(limited.matches).toHaveLength(2);
    expect(limited.truncated).toBe(true);
  });

  it('reports invalid regular expressions clearly', async () => {
    await expect(jsSearch(targets, { query: '(unclosed', regex: true })).rejects.toThrow(/Invalid regular expression/);
  });
});

describe('lexical search', () => {
  it('strips LaTeX commands and comments when tokenizing', () => {
    expect(tokenizeLatex('\\textbf{Deep} learning % hidden\n\\cite{x}')).toEqual(['Deep', 'learning', 'x']);
  });

  it('chunks by paragraphs and remembers the section', () => {
    const chunks = chunkFile('main.tex', '\\section{Intro}\nFirst paragraph.\n\n\\section{Method}\nSecond paragraph.\n');
    expect(chunks.map((c) => [c.section, c.startLine])).toEqual([
      ['Intro', 1],
      ['Method', 4],
    ]);
  });

  it('ranks the most relevant passage first across projects', () => {
    const chunks = [
      ...buildChunks('p1', 'One', 'intro.tex', '\\section{Intro}\nWe study graphs.\n\n\\section{Related Work}\nDiffusion models generate images by denoising. Diffusion is popular.\n'),
      ...buildChunks('p2', 'Two', 'paper.tex', '\\section{Background}\nA short note on denoising autoencoders.\n'),
    ];
    const hits = new LexicalIndex(chunks).search('diffusion denoising models');
    expect(hits[0]).toMatchObject({ projectId: 'p1', file: 'intro.tex', section: 'Related Work' });
    expect(hits[0].snippet[0]).toContain('Diffusion');
  });
});
