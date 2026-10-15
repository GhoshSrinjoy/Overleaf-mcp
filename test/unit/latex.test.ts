import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBibtexLog, parseLatexLog } from '../../src/core/latex/logParser';
import {
  buildProjectOutline,
  findHeading,
  guessRootFile,
  maskNonCode,
  parseHeadings,
  parseIncludes,
  sliceSection,
} from '../../src/core/latex/outline';

const fixture = (name: string) => readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

describe('parseHeadings', () => {
  it('finds sectioning commands with stars, short titles and nested braces', () => {
    const text = [
      '\\documentclass{article}',
      '\\section{Introduction}',
      '\\subsection*{Motivation \\emph{and} Goals}',
      '\\section[Short]{A Much Longer Title}',
      '\\paragraph{Detail}',
    ].join('\n');
    const headings = parseHeadings(text);
    expect(headings.map((h) => [h.type, h.title, h.line, h.starred])).toEqual([
      ['section', 'Introduction', 2, false],
      ['subsection', 'Motivation \\emph{and} Goals', 3, true],
      ['section', 'A Much Longer Title', 4, false],
      ['paragraph', 'Detail', 5, false],
    ]);
  });

  it('ignores commented-out and verbatim headings but not escaped percent signs', () => {
    const text = [
      '% \\section{Commented}',
      '50\\% done \\section{Real}',
      '\\begin{verbatim}',
      '\\section{Code sample}',
      '\\end{verbatim}',
      '\\subsectionx{not a heading}',
    ].join('\n');
    expect(parseHeadings(text).map((h) => h.title)).toEqual(['Real']);
  });

  it('keeps offsets aligned when masking', () => {
    const text = 'a % comment\n\\section{X}';
    expect(maskNonCode(text)).toHaveLength(text.length);
    expect(parseHeadings(text)[0].line).toBe(2);
  });
});

describe('parseIncludes', () => {
  it('handles input/include/subfile/import forms', () => {
    const text = [
      '\\input{chapters/intro}',
      '\\include{chapters/methods.tex}',
      '\\input body',
      '\\subfile{appendix}',
      '\\import{parts/}{results}',
      '\\subimport{figs}{plot.tex}',
      '% \\input{ignored}',
    ].join('\n');
    expect(parseIncludes(text).map((d) => [d.command, d.target, d.line])).toEqual([
      ['input', 'chapters/intro', 1],
      ['include', 'chapters/methods.tex', 2],
      ['input', 'body', 3],
      ['subfile', 'appendix', 4],
      ['import', 'parts/results', 5],
      ['subimport', 'figs/plot.tex', 6],
    ]);
  });
});

describe('buildProjectOutline', () => {
  const files: Record<string, string> = {
    'main.tex': '\\documentclass{book}\n\\begin{document}\n\\chapter{One}\n\\input{chapters/a}\n\\chapter{Two}\n\\include{chapters/b}\n\\input{missing}\n\\end{document}\n',
    'chapters/a.tex': '\\section{A1}\ntext\n\\section{A2}\n\\input{chapters/a}\n',
    'chapters/b.tex': '\\section{B1}\n',
  };

  it('walks includes in reading order, skips cycles and reports missing files', async () => {
    const outline = await buildProjectOutline('main.tex', Object.keys(files), async (f) => files[f]);
    expect(outline.entries.map((e) => `${e.file}:${e.line} ${e.title}`)).toEqual([
      'main.tex:3 One',
      'chapters/a.tex:1 A1',
      'chapters/a.tex:3 A2',
      'main.tex:5 Two',
      'chapters/b.tex:1 B1',
    ]);
    expect(outline.missing).toEqual([{ file: 'main.tex', line: 7, target: 'missing' }]);
  });
});

describe('sections', () => {
  const text = '\\section{Intro}\nIntro text.\n\\subsection{Detail}\nMore.\n\\section{Next}\nNext text.\n\\end{document}\n';
  const headings = parseHeadings(text);

  it('slices up to the next heading of the same or higher level', () => {
    const slice = sliceSection(text, headings, findHeading(headings, 'intro').heading!);
    expect(slice.content).toBe('\\section{Intro}\nIntro text.\n\\subsection{Detail}\nMore.');
    expect([slice.startLine, slice.endLine]).toEqual([1, 4]);
    expect(sliceSection(text, headings, findHeading(headings, 'Next').heading!).content).toBe('\\section{Next}\nNext text.');
  });

  it('matches titles exactly first, then by unique substring', () => {
    expect(findHeading(headings, 'DETAIL').heading?.title).toBe('Detail');
    expect(findHeading(headings, 'ex').heading?.title).toBe('Next');
    expect(findHeading(headings, 't').heading).toBeUndefined();
  });

  it('guesses the main file', () => {
    expect(
      guessRootFile([
        { path: 'chapters/intro.tex', text: '\\section{x}' },
        { path: 'paper.tex', text: '\\documentclass{article}\\begin{document}\\end{document}' },
      ]),
    ).toBe('paper.tex');
  });
});

describe('parseLatexLog (real TeX Live logs)', () => {
  it('attributes errors and warnings to the right files and lines', () => {
    const log = parseLatexLog(fixture('errors.log'));
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]).toMatchObject({ file: 'chapters/body.tex', line: 3, message: 'Undefined control sequence.' });
    expect(log.errors[0].context).toContain('\\undefinedcommand');
    const warnings = log.warnings.map((w) => `${w.file}:${w.line ?? '-'} ${w.message}`);
    expect(warnings).toContain("main.tex:5 Reference `sec:missing' on page 1 undefined on input line 5.");
    expect(warnings).toContain("main.tex:5 Citation `nokey2020' on page 1 undefined on input line 5.");
    expect(log.typesetting[0]).toMatchObject({ file: 'main.tex', line: 7 });
    expect(log.pages).toBe(1);
    expect(log.fatal).toBeFalsy();
  });

  it('reports a missing package as one fatal error with its line', () => {
    const log = parseLatexLog(fixture('missing-package.log'));
    expect(log.fatal).toBe(true);
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0].message).toBe("LaTeX Error: File `doesnotexist.sty' not found.");
    expect(log.errors[0].line).toBe(3);
    expect(log.errors[0].context ?? '').not.toMatch(/Enter file name|Type X/);
  });

  it('drops TeX interactive prompts from error context', () => {
    const log = parseLatexLog(['! LaTeX Error: Something broke.', '', 'Type  H <return>  for immediate help.', '*** (cannot \\read from terminal in nonstop modes)', 'l.7 \\broken'].join('\n'));
    expect(log.errors[0]).toMatchObject({ message: 'LaTeX Error: Something broke.', line: 7, context: 'l.7 \\broken' });
  });

  it('understands -file-line-error output', () => {
    const log = parseLatexLog('./sections/intro.tex:12: Undefined control sequence.\nl.12 \\foo\n');
    expect(log.errors[0]).toMatchObject({ file: 'sections/intro.tex', line: 12, message: 'Undefined control sequence.' });
  });
});

describe('parseBibtexLog', () => {
  it('extracts missing entries', () => {
    expect(parseBibtexLog(fixture('errors.blg'))).toEqual([{ level: 'warning', message: 'BibTeX: I didn\'t find a database entry for "nokey2020"' }]);
  });
});
