import * as path from 'node:path';

export const SECTION_LEVELS = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
} as const;

export type SectionType = keyof typeof SECTION_LEVELS;

export interface Heading {
  type: SectionType;
  level: number;
  title: string;
  starred: boolean;
  /** 1-based line of the command. */
  line: number;
  offset: number;
}

export interface IncludeDirective {
  command: string;
  /** Path as written, combined with the directory argument for \import-style commands. */
  target: string;
  /** For \subimport, \import: the directory that becomes the base for nested includes. */
  baseDir?: string;
  relativeToCurrentFile: boolean;
  line: number;
  offset: number;
}

const VERBATIM_ENVIRONMENTS = ['verbatim', 'verbatim\\*', 'Verbatim', 'lstlisting', 'minted', 'comment', 'filecontents', 'filecontents\\*'];

function blankOut(text: string, start: number, end: number): string {
  return text.slice(0, start) + text.slice(start, end).replace(/[^\n]/g, ' ') + text.slice(end);
}

/**
 * Replaces comments and verbatim-like environments with spaces. Offsets and line numbers
 * stay identical to the original, so positions found in the result map straight back.
 */
export function maskNonCode(text: string): string {
  let masked = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      masked += ch + (text[i + 1] ?? '');
      i++;
      continue;
    }
    if (ch === '%') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      masked += ' '.repeat(stop - i);
      i = stop - 1;
      continue;
    }
    masked += ch;
  }
  for (const env of VERBATIM_ENVIRONMENTS) {
    const pattern = new RegExp(`\\\\begin\\{${env}\\}[\\s\\S]*?\\\\end\\{${env}\\}`, 'g');
    for (const match of [...masked.matchAll(pattern)]) {
      const start = (match.index ?? 0) + `\\begin{${env.replace('\\*', '*')}}`.length;
      const end = (match.index ?? 0) + match[0].length - `\\end{${env.replace('\\*', '*')}}`.length;
      masked = blankOut(masked, start, end);
    }
  }
  return masked;
}

/** Reads a balanced group starting at `open` (which must be `{` or `[`). Returns the inner text and the index after the closing char. */
export function readGroup(text: string, open: number): { inner: string; end: number } | undefined {
  const opener = text[open];
  const closer = opener === '{' ? '}' : opener === '[' ? ']' : undefined;
  if (!closer) return undefined;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) return { inner: text.slice(open + 1, i), end: i + 1 };
    }
  }
  return undefined;
}

function skipSpaces(text: string, index: number): number {
  while (index < text.length && /\s/.test(text[index])) index++;
  return index;
}

export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Builds an index so repeated offset→line lookups are O(log n). */
export function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

export function parseHeadings(text: string): Heading[] {
  const masked = maskNonCode(text);
  const toLine = lineIndex(text);
  const headings: Heading[] = [];
  const pattern = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)(?![a-zA-Z])/g;
  for (const match of masked.matchAll(pattern)) {
    const offset = match.index ?? 0;
    let cursor = skipSpaces(masked, offset + match[0].length);
    if (masked[cursor] === '[') {
      const optional = readGroup(masked, cursor);
      if (!optional) continue;
      cursor = skipSpaces(masked, optional.end);
    }
    if (masked[cursor] !== '{') continue;
    const group = readGroup(masked, cursor);
    if (!group) continue;
    const type = match[1] as SectionType;
    headings.push({
      type,
      level: SECTION_LEVELS[type],
      title: text.slice(cursor + 1, group.end - 1).replace(/\s+/g, ' ').trim(),
      starred: match[2] === '*',
      line: toLine(offset),
      offset,
    });
  }
  return headings;
}

export function parseIncludes(text: string): IncludeDirective[] {
  const masked = maskNonCode(text);
  const toLine = lineIndex(text);
  const directives: IncludeDirective[] = [];
  const pattern = /\\(input|include|subfile|import|subimport|inputfrom|subinputfrom|includefrom|subincludefrom)(?![a-zA-Z])\*?/g;
  for (const match of masked.matchAll(pattern)) {
    const command = match[1];
    const offset = match.index ?? 0;
    let cursor = skipSpaces(masked, offset + match[0].length);
    const takesDir = command !== 'input' && command !== 'include' && command !== 'subfile';
    let baseDir: string | undefined;
    if (takesDir) {
      const dirGroup = masked[cursor] === '{' ? readGroup(masked, cursor) : undefined;
      if (!dirGroup) continue;
      baseDir = dirGroup.inner.trim();
      cursor = skipSpaces(masked, dirGroup.end);
    }
    let target: string | undefined;
    if (masked[cursor] === '{') {
      target = readGroup(masked, cursor)?.inner.trim();
    } else if (command === 'input') {
      // Plain TeX form: \input chapter1
      target = /^[^\s{}%\\]+/.exec(masked.slice(cursor))?.[0];
    }
    if (!target) continue;
    directives.push({
      command,
      target: baseDir ? `${baseDir.replace(/\/?$/, '/')}${target}` : target,
      baseDir,
      relativeToCurrentFile: command.startsWith('sub'),
      line: toLine(offset),
      offset,
    });
  }
  return directives;
}

/**
 * Finds the project file an include refers to. TeX resolves plain \input relative to the
 * compile directory (the main file's folder on Overleaf); \subimport-style commands resolve
 * relative to the including file.
 */
export function resolveIncludePath(
  directive: IncludeDirective,
  currentFile: string,
  rootFile: string,
  baseDir: string,
  projectFiles: ReadonlySet<string>,
): string | undefined {
  const target = directive.target.replace(/\\/g, '/');
  const bases = directive.relativeToCurrentFile
    ? [path.posix.dirname(currentFile)]
    : [baseDir, path.posix.dirname(rootFile), ''];
  for (const base of bases) {
    const joined = path.posix.normalize(path.posix.join(base === '.' ? '' : base, target)).replace(/^\.\//, '');
    for (const candidate of [joined, `${joined}.tex`]) {
      if (projectFiles.has(candidate)) return candidate;
    }
  }
  return undefined;
}

export interface OutlineEntry extends Heading {
  file: string;
}

export interface ProjectOutline {
  rootFile: string;
  entries: OutlineEntry[];
  /** Files visited, in document order. */
  files: string[];
  /** Includes that did not resolve to a project file. */
  missing: Array<{ file: string; line: number; target: string }>;
}

/** Walks the document from `rootFile` through its includes, producing the outline in reading order. */
export async function buildProjectOutline(
  rootFile: string,
  projectFiles: readonly string[],
  readText: (file: string) => Promise<string | undefined>,
): Promise<ProjectOutline> {
  const fileSet = new Set(projectFiles);
  const outline: ProjectOutline = { rootFile, entries: [], files: [], missing: [] };
  const visiting = new Set<string>();

  async function visit(file: string, baseDir: string, depth: number): Promise<void> {
    if (visiting.has(file) || depth > 24) return;
    const text = await readText(file);
    if (text === undefined) return;
    visiting.add(file);
    outline.files.push(file);

    const items: Array<{ offset: number; heading?: Heading; include?: IncludeDirective }> = [
      ...parseHeadings(text).map((heading) => ({ offset: heading.offset, heading })),
      ...parseIncludes(text).map((include) => ({ offset: include.offset, include })),
    ].sort((a, b) => a.offset - b.offset);

    for (const item of items) {
      if (item.heading) {
        outline.entries.push({ ...item.heading, file });
        continue;
      }
      const include = item.include!;
      const resolved = resolveIncludePath(include, file, rootFile, baseDir, fileSet);
      if (!resolved) {
        outline.missing.push({ file, line: include.line, target: include.target });
        continue;
      }
      const nextBase = include.baseDir
        ? path.posix.normalize(path.posix.join(include.relativeToCurrentFile ? path.posix.dirname(file) : baseDir, include.baseDir))
        : baseDir;
      await visit(resolved, nextBase === '.' ? '' : nextBase, depth + 1);
    }
    visiting.delete(file);
  }

  await visit(rootFile, path.posix.dirname(rootFile) === '.' ? '' : path.posix.dirname(rootFile), 0);
  return outline;
}

export interface SectionSlice {
  heading: Heading;
  content: string;
  startLine: number;
  endLine: number;
}

function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Picks the heading matching `title`: exact (case-insensitive) first, then a unique substring match. */
export function findHeading<T extends Heading>(headings: readonly T[], title: string): { heading?: T; candidates: T[] } {
  const wanted = normalizeTitle(title);
  const exact = headings.filter((h) => normalizeTitle(h.title) === wanted);
  if (exact.length) return { heading: exact[0], candidates: exact };
  const partial = headings.filter((h) => normalizeTitle(h.title).includes(wanted));
  return { heading: partial.length === 1 ? partial[0] : undefined, candidates: partial };
}

/** Text of a section: from its heading up to the next heading of the same or higher rank. */
export function sliceSection(text: string, headings: readonly Heading[], heading: Heading): SectionSlice {
  const index = headings.indexOf(heading);
  const next = headings.slice(index + 1).find((h) => h.level <= heading.level);
  let end = next ? next.offset : text.length;
  const endDocument = text.indexOf('\\end{document}', heading.offset);
  if (endDocument !== -1 && endDocument < end) end = endDocument;
  const content = text.slice(heading.offset, end).replace(/\s+$/, '');
  return {
    heading,
    content,
    startLine: heading.line,
    endLine: heading.line + (content.match(/\n/g)?.length ?? 0),
  };
}

/** Best guess at the main file when the server does not tell us (e.g. Git-token projects). */
export function guessRootFile(files: ReadonlyArray<{ path: string; text?: string }>): string | undefined {
  const tex = files.filter((f) => f.path.toLowerCase().endsWith('.tex'));
  const withDocument = tex.filter((f) => f.text && /\\documentclass/.test(f.text) && /\\begin\{document\}/.test(f.text));
  const preferred = (list: typeof tex) =>
    list.find((f) => /(^|\/)main\.tex$/i.test(f.path)) ??
    list.sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))[0];
  return (withDocument.length ? preferred(withDocument) : preferred(tex))?.path;
}
