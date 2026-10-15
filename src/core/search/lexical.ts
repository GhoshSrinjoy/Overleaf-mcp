import MiniSearch from 'minisearch';
import { parseHeadings } from '../latex/outline';
import { extensionOf } from './textFiles';

export interface Chunk {
  id: string;
  projectId: string;
  projectName: string;
  file: string;
  startLine: number;
  endLine: number;
  section: string;
  text: string;
}

export interface LexicalHit {
  projectId: string;
  projectName: string;
  file: string;
  startLine: number;
  endLine: number;
  section: string;
  score: number;
  /** The chunk lines that best show why it matched. */
  snippet: string[];
  terms: string[];
}

const STOPWORDS = new Set(
  ('a an and are as at be been but by can could did do does for from had has have how i if in into is it its may might more most no not ' +
    'of on or our so such than that the their them then there these they this those to too was we were what when where which while who ' +
    'why will with would you your also via per each other one two using use used based we our us all any both between during within').split(' '),
);

/** Splits LaTeX into searchable words: drops comments and command names but keeps their arguments. */
export function tokenizeLatex(text: string): string[] {
  return text
    .replace(/(^|[^\\])%.*$/gm, '$1 ')
    .replace(/\\[a-zA-Z@]+\*?/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export function processTerm(term: string): string | null {
  const lower = term.toLowerCase();
  if (lower.length < 2 || STOPWORDS.has(lower)) return null;
  return lower;
}

interface RawChunk {
  startLine: number;
  endLine: number;
  section: string;
  text: string;
}

/** Cuts a file into paragraph-sized pieces so results point at a specific place, not a whole file. */
export function chunkFile(file: string, text: string, targetChars = 700, maxChars = 1600): RawChunk[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const ext = extensionOf(file);
  const headingLines = new Map<number, string>();
  if (ext === 'tex' || ext === 'ltx' || ext === 'latex') {
    for (const heading of parseHeadings(text)) headingLines.set(heading.line, heading.title);
  }
  const isBoundary =
    ext === 'bib'
      ? (line: string) => /^\s*@\w+\s*[{(]/.test(line)
      : (line: string, lineNo: number) => headingLines.has(lineNo) || /^\s*\\begin\{(figure|table|abstract|algorithm)\*?\}/.test(line);

  const chunks: RawChunk[] = [];
  let section = '';
  let buffer: string[] = [];
  let start = 1;
  const flush = (end: number) => {
    const body = buffer.join('\n').trim();
    if (body) chunks.push({ startLine: start, endLine: end, section, text: body });
    buffer = [];
  };

  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1;
    const line = lines[index];
    const size = buffer.reduce((sum, l) => sum + l.length + 1, 0);
    const blank = !line.trim();
    if (isBoundary(line, lineNo) || (blank && size >= targetChars) || size + line.length > maxChars) {
      flush(lineNo - 1);
      start = lineNo;
    }
    if (headingLines.has(lineNo)) section = headingLines.get(lineNo)!;
    if (!buffer.length && blank) {
      start = lineNo + 1;
      continue;
    }
    buffer.push(line);
  }
  flush(lines.length);
  return chunks;
}

export function buildChunks(projectId: string, projectName: string, file: string, text: string): Chunk[] {
  return chunkFile(file, text).map((chunk, index) => ({
    ...chunk,
    id: `${projectId}:${file}:${index}`,
    projectId,
    projectName,
    file,
  }));
}

function snippetFor(chunk: Chunk, terms: readonly string[], maxLines = 3): string[] {
  const lines = chunk.text.split('\n');
  const lowered = terms.map((t) => t.toLowerCase());
  const hits = lines.filter((line) => {
    const lower = line.toLowerCase();
    return lowered.some((term) => lower.includes(term));
  });
  const chosen = (hits.length ? hits : lines).slice(0, maxLines);
  return chosen.map((line) => (line.length > 300 ? `${line.slice(0, 300)}…` : line));
}

/** BM25-ranked search over chunks of many projects at once. */
export class LexicalIndex {
  private readonly engine: MiniSearch<Chunk>;
  private readonly byId = new Map<string, Chunk>();

  constructor(chunks: readonly Chunk[]) {
    this.engine = new MiniSearch<Chunk>({
      fields: ['text', 'section', 'file'],
      storeFields: [],
      tokenize: tokenizeLatex,
      processTerm,
      searchOptions: {
        boost: { section: 2, file: 0.5 },
        prefix: (term) => term.length >= 4,
        fuzzy: (term) => (term.length >= 6 ? 0.15 : false),
        combineWith: 'OR',
      },
    });
    for (const chunk of chunks) this.byId.set(chunk.id, chunk);
    this.engine.addAll(chunks as Chunk[]);
  }

  get size(): number {
    return this.byId.size;
  }

  search(query: string, limit = 20, options: { matchAll?: boolean } = {}): LexicalHit[] {
    const results = this.engine.search(query, options.matchAll ? { combineWith: 'AND' } : {});
    return results.slice(0, limit).map((result) => {
      const chunk = this.byId.get(String(result.id))!;
      return {
        projectId: chunk.projectId,
        projectName: chunk.projectName,
        file: chunk.file,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        section: chunk.section,
        score: Math.round(result.score * 100) / 100,
        snippet: snippetFor(chunk, result.terms),
        terms: result.terms,
      };
    });
  }
}
