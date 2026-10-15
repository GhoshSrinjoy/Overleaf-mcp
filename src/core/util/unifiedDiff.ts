import DiffMatchPatch from 'diff-match-patch';

interface DiffLine {
  kind: ' ' | '-' | '+';
  text: string;
  oldLine: number;
  newLine: number;
}

function lineDiff(before: string, after: string): DiffLine[] {
  const dmp = new DiffMatchPatch() as DiffMatchPatch & {
    diff_linesToChars_(a: string, b: string): { chars1: string; chars2: string; lineArray: string[] };
    diff_charsToLines_(diffs: Array<[number, string]>, lineArray: string[]): void;
  };
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(before, after);
  const diffs = dmp.diff_main(chars1, chars2, false);
  dmp.diff_charsToLines_(diffs, lineArray);

  const lines: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const [op, text] of diffs) {
    const parts = text.split('\n');
    if (parts[parts.length - 1] === '') parts.pop();
    for (const part of parts) {
      if (op === 0) lines.push({ kind: ' ', text: part, oldLine: oldLine++, newLine: newLine++ });
      else if (op === -1) lines.push({ kind: '-', text: part, oldLine: oldLine++, newLine });
      else lines.push({ kind: '+', text: part, oldLine, newLine: newLine++ });
    }
  }
  return lines;
}

/** Unified diff with @@ hunk headers, truncated to `maxChars`. */
export function unifiedDiff(before: string, after: string, options: { context?: number; maxChars?: number; label?: string } = {}): string {
  if (before === after) return '';
  const context = options.context ?? 3;
  const maxChars = options.maxChars ?? 20_000;
  const lines = lineDiff(before, after);
  const changed = lines.map((line, index) => (line.kind !== ' ' ? index : -1)).filter((index) => index !== -1);

  const hunks: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(lines.length - 1, index + context);
    const last = hunks[hunks.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else hunks.push([start, end]);
  }

  let out = options.label ? `--- a/${options.label}\n+++ b/${options.label}\n` : '';
  for (const [start, end] of hunks) {
    const slice = lines.slice(start, end + 1);
    const oldCount = slice.filter((l) => l.kind !== '+').length;
    const newCount = slice.filter((l) => l.kind !== '-').length;
    out += `@@ -${slice[0].oldLine},${oldCount} +${slice[0].newLine},${newCount} @@\n`;
    for (const line of slice) out += `${line.kind}${line.text}\n`;
    if (out.length > maxChars) {
      return `${out.slice(0, maxChars)}\n… diff truncated (${changed.length} changed lines in total)\n`;
    }
  }
  return out;
}

export function diffStats(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lineDiff(before, after)) {
    if (line.kind === '+') added++;
    else if (line.kind === '-') removed++;
  }
  return { added, removed };
}
