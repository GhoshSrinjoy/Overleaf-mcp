import DiffMatchPatch from 'diff-match-patch';
import { OverleafError } from '../util/errors';

/** ShareJS "text" operation components, as used by Overleaf's realtime protocol. */
export interface InsertOp {
  p: number;
  i: string;
}
export interface DeleteOp {
  p: number;
  d: string;
}
export type OtOp = InsertOp | DeleteOp;

export function isInsert(op: OtOp): op is InsertOp {
  return (op as InsertOp).i !== undefined;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

function splitsSurrogatePair(text: string, position: number): boolean {
  return position > 0 && position < text.length && isHighSurrogate(text.charCodeAt(position - 1)) && isLowSurrogate(text.charCodeAt(position));
}

function diffsToOps(diffs: Array<[number, string]>): OtOp[] {
  const ops: OtOp[] = [];
  let position = 0;
  for (const [kind, text] of diffs) {
    if (!text) continue;
    if (kind === DiffMatchPatch.DIFF_EQUAL) {
      position += text.length;
    } else if (kind === DiffMatchPatch.DIFF_DELETE) {
      ops.push({ p: position, d: text });
    } else {
      ops.push({ p: position, i: text });
      position += text.length;
    }
  }
  return ops;
}

/** True when applying `ops` to `text` never cuts a surrogate pair in half. */
function opsKeepSurrogatesIntact(text: string, ops: OtOp[]): boolean {
  let current = text;
  for (const op of ops) {
    if (splitsSurrogatePair(current, op.p)) return false;
    if (isInsert(op)) {
      current = current.slice(0, op.p) + op.i + current.slice(op.p);
    } else {
      if (splitsSurrogatePair(current, op.p + op.d.length)) return false;
      current = current.slice(0, op.p) + current.slice(op.p + op.d.length);
    }
  }
  return true;
}

export type DiffSegment = [-1 | 0 | 1, string];

/**
 * Diff of `oldText` → `newText` as equal/delete/insert segments. Character-level diffs keep
 * collaborators' comments and cursors anchored; if that would split an emoji's surrogate pair
 * we fall back to whole lines.
 */
export function diffSegments(oldText: string, newText: string, timeoutSeconds = 2): DiffSegment[] {
  if (oldText === newText) return oldText ? [[0, oldText]] : [];
  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = timeoutSeconds;

  const charDiffs = dmp.diff_main(oldText, newText);
  dmp.diff_cleanupSemantic(charDiffs);
  if (opsKeepSurrogatesIntact(oldText, diffsToOps(charDiffs))) return charDiffs as DiffSegment[];

  const { chars1, chars2, lineArray } = (dmp as unknown as {
    diff_linesToChars_(a: string, b: string): { chars1: string; chars2: string; lineArray: string[] };
  }).diff_linesToChars_(oldText, newText);
  const lineDiffs = dmp.diff_main(chars1, chars2, false);
  (dmp as unknown as { diff_charsToLines_(d: Array<[number, string]>, l: string[]): void }).diff_charsToLines_(lineDiffs, lineArray);
  return lineDiffs as DiffSegment[];
}

/** Minimal ShareJS ops turning `oldText` into `newText`. */
export function diffToOps(oldText: string, newText: string, timeoutSeconds = 2): OtOp[] {
  if (oldText === newText) return [];
  return diffsToOps(diffSegments(oldText, newText, timeoutSeconds));
}

/* ------------------------- history-ot (Overleaf's newer doc format) ------------------------- */

/** Retain n | insert "text" | remove -n, optionally with tracked-change info. */
export type HistoryOtComponent =
  | number
  | string
  | { r: number; tracking: { type: 'delete'; userId: string; ts: string } }
  | { i: string; tracking: { type: 'insert'; userId: string; ts: string } };

export interface HistoryOtTextOperation {
  textOperation: HistoryOtComponent[];
}

export interface TrackedRange {
  pos: number;
  length: number;
}

/**
 * Maps positions in the visible text to the stored content, which still holds tracked deletions.
 * Hidden text sitting exactly at the position is skipped ("after") or not ("before").
 */
export function visibleToStoredMapper(trackedDeletes: readonly TrackedRange[]): (visible: number, bias?: 'after' | 'before') => number {
  const ranges = [...trackedDeletes].sort((a, b) => a.pos - b.pos);
  return (visible: number, bias: 'after' | 'before' = 'after') => {
    let offset = 0;
    for (const range of ranges) {
      const point = visible + offset;
      if (range.pos < point || (bias === 'after' && range.pos === point)) offset += range.length;
      else break;
    }
    return visible + offset;
  };
}

/** Removes tracked deletions from stored history-ot content, giving the text the user sees. */
export function visibleContent(content: string, trackedDeletes: readonly TrackedRange[]): string {
  let out = '';
  let cursor = 0;
  for (const range of [...trackedDeletes].sort((a, b) => a.pos - b.pos)) {
    if (cursor < range.pos) out += content.slice(cursor, range.pos);
    cursor = Math.max(cursor, range.pos + range.length);
  }
  return out + content.slice(cursor);
}

/**
 * Builds one history-ot TextOperation (it must span the whole stored content) that turns the
 * visible text `oldVisible` into `newVisible`. With `track`, insertions and deletions become
 * tracked changes the user can accept or reject in Overleaf's review panel.
 */
export function buildHistoryOtOperation(
  storedLength: number,
  trackedDeletes: readonly TrackedRange[],
  oldVisible: string,
  newVisible: string,
  track?: { userId: string; ts?: string },
): HistoryOtTextOperation | undefined {
  if (oldVisible === newVisible) return undefined;
  const toStored = visibleToStoredMapper(trackedDeletes);
  const ts = track?.ts ?? new Date().toISOString();
  const components: HistoryOtComponent[] = [];
  const push = (component: HistoryOtComponent) => {
    const last = components[components.length - 1];
    if (typeof component === 'number' && component > 0 && typeof last === 'number' && last > 0) components[components.length - 1] = last + component;
    else if (typeof component === 'number' && component < 0 && typeof last === 'number' && last < 0) components[components.length - 1] = last + component;
    else if (typeof component === 'string' && typeof last === 'string') components[components.length - 1] = last + component;
    else components.push(component);
  };

  let visible = 0;
  let stored = 0;
  for (const [kind, text] of diffSegments(oldVisible, newVisible)) {
    if (!text) continue;
    if (kind === 1) {
      if (track) components.push({ i: text, tracking: { type: 'insert', userId: track.userId, ts } });
      else push(text);
      continue;
    }
    // A deletion must stop before hidden (tracked-deleted) text that follows it; removing that
    // text would silently accept someone else's suggestion.
    const end = toStored(visible + text.length, kind === -1 ? 'before' : 'after');
    const span = end - stored;
    if (span > 0) {
      if (kind === 0) push(span);
      else if (track) components.push({ r: span, tracking: { type: 'delete', userId: track.userId, ts } });
      else push(-span);
    }
    stored = end;
    visible += text.length;
  }
  if (storedLength > stored) push(storedLength - stored);

  const consumed = components.reduce<number>((sum, c) => {
    if (typeof c === 'number') return sum + Math.abs(c);
    if (typeof c === 'object' && 'r' in c) return sum + c.r;
    return sum;
  }, 0);
  if (consumed !== storedLength) {
    throw new OverleafError('PROTOCOL', `Internal error: history-ot operation spans ${consumed} of ${storedLength} characters`);
  }
  return { textOperation: components };
}

export function applyOps(text: string, ops: readonly OtOp[]): string {
  let current = text;
  for (const op of ops) {
    if (op.p < 0 || op.p > current.length) {
      throw new OverleafError('PROTOCOL', `Op position ${op.p} is outside the document (length ${current.length})`);
    }
    if (isInsert(op)) {
      current = current.slice(0, op.p) + op.i + current.slice(op.p);
    } else {
      const actual = current.slice(op.p, op.p + op.d.length);
      if (actual !== op.d) {
        throw new OverleafError('PROTOCOL', `Delete op at ${op.p} does not match the document text`);
      }
      current = current.slice(0, op.p) + current.slice(op.p + op.d.length);
    }
  }
  return current;
}

/**
 * Overleaf documents can't hold characters outside the Basic Multilingual Plane (emoji, some CJK
 * extensions, math alphanumerics): the server rejects or mangles them, and uploads containing them
 * turn into binary files. Fail early with a message an author can act on.
 */
export function assertEditableText(text: string, context: string): void {
  const offenders: string[] = [];
  const pattern = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(0, match.index ?? 0);
    const line = (before.match(/\n/g)?.length ?? 0) + 1;
    offenders.push(`"${match[0]}" (U+${(match[0].codePointAt(0) ?? 0).toString(16).toUpperCase()}) on line ${line}`);
    if (offenders.length >= 5) break;
  }
  if (offenders.length) {
    throw new OverleafError(
      'INVALID_INPUT',
      `${context}: Overleaf documents cannot contain emoji or other characters outside the Basic Multilingual Plane. ` +
        `Found ${offenders.join(', ')}. Remove them or use a LaTeX command instead (for example \\usepackage{emoji} with \\emoji{...}).`,
    );
  }
}

export interface TextEdit {
  /** Exact text to find. Must be unique in the document unless `replaceAll` is set. */
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export interface AppliedEdits {
  text: string;
  replacements: number;
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) count++;
  return count;
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Helps an agent recover from a near miss: finds the passage if only whitespace differs. */
function whitespaceInsensitiveHint(text: string, needle: string): string {
  const tokens = needle.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return '';
  const pattern = new RegExp(tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'g');
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) return '';
  const match = matches[0];
  return ` A passage matching except for whitespace starts at line ${lineOf(text, match.index ?? 0)}:\n${match[0]}`;
}

function bigrams(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const normalized = text.toLowerCase().replace(/\s+/g, ' ');
  for (let i = 0; i < normalized.length - 1; i++) {
    const pair = normalized.slice(i, i + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

/** Dice similarity of character pairs: 1 for identical strings, near 0 for unrelated ones. */
function similarity(a: Map<string, number>, b: Map<string, number>, sizeA: number, sizeB: number): number {
  let shared = 0;
  for (const [pair, count] of a) shared += Math.min(count, b.get(pair) ?? 0);
  return (2 * shared) / Math.max(1, sizeA + sizeB);
}

/** Points at the line that most resembles the first line of a missing oldText (typos, stale reads). */
function closestLineHint(text: string, needle: string): string {
  const firstLine = needle.split('\n').find((line) => line.trim())?.trim();
  if (!firstLine || firstLine.length > 500) return '';
  const lines = text.split('\n');
  const exact = lines.findIndex((line) => line.includes(firstLine));
  if (exact !== -1 && needle.includes('\n')) {
    return ` Its first line matches line ${exact + 1}, but the lines after it differ; read the file again and copy the passage exactly.`;
  }
  const wanted = bigrams(firstLine);
  const wantedSize = Math.max(0, firstLine.length - 1);
  let best = { score: 0, index: -1 };
  for (let i = 0; i < lines.length && i < 20_000; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const score = similarity(wanted, bigrams(line), wantedSize, Math.max(0, line.length - 1));
    if (score > best.score) best = { score, index: i };
  }
  if (best.score < 0.6) return ' The file may have changed since it was read; read it again.';
  return ` The closest line is ${best.index + 1}: ${lines[best.index].trim().slice(0, 200)}`;
}

/** Applies search/replace edits in order, each against the result of the previous one. */
export function applyTextEdits(original: string, edits: readonly TextEdit[]): AppliedEdits {
  let text = original;
  let replacements = 0;
  edits.forEach((edit, index) => {
    const label = edits.length > 1 ? `Edit ${index + 1}: ` : '';
    const oldText = normalizeNewlines(edit.oldText);
    const newText = normalizeNewlines(edit.newText);
    if (!oldText) {
      throw new OverleafError('INVALID_INPUT', `${label}oldText must not be empty. Use write_file to create or replace a whole file.`);
    }
    if (oldText === newText) {
      throw new OverleafError('INVALID_INPUT', `${label}oldText and newText are identical.`);
    }
    const count = countOccurrences(text, oldText);
    if (count === 0) {
      throw new OverleafError('NOT_FOUND', `${label}oldText was not found in the file.${whitespaceInsensitiveHint(text, oldText) || closestLineHint(text, oldText)}`);
    }
    if (count > 1 && !edit.replaceAll) {
      throw new OverleafError(
        'AMBIGUOUS',
        `${label}oldText occurs ${count} times. Include more surrounding text to make it unique, or set replaceAll.`,
      );
    }
    text = edit.replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
    replacements += edit.replaceAll ? count : 1;
  });
  return { text, replacements };
}
