import { describe, expect, it } from 'vitest';
import {
  applyOps,
  applyTextEdits,
  assertEditableText,
  buildHistoryOtOperation,
  diffToOps,
  normalizeNewlines,
  visibleContent,
  visibleToStoredMapper,
} from '../../src/core/overleaf/ot';

/** Applies a history-ot TextOperation to stored content (retain n / insert "s" / remove -n). */
function applyHistoryOt(content: string, components: unknown[]): string {
  let cursor = 0;
  let out = '';
  for (const c of components) {
    if (typeof c === 'number' && c > 0) {
      out += content.slice(cursor, cursor + c);
      cursor += c;
    } else if (typeof c === 'number') {
      cursor += -c;
    } else if (typeof c === 'string') {
      out += c;
    } else if ('i' in (c as object)) {
      out += (c as { i: string }).i;
    } else {
      const r = (c as { r: number }).r;
      out += content.slice(cursor, cursor + r);
      cursor += r;
    }
  }
  return out + content.slice(cursor);
}

function randomText(seed: number, length: number): string {
  const alphabet = 'ab cd\nef\\{}äö—数';
  let x = seed;
  let out = '';
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out += alphabet[x % alphabet.length];
  }
  return out;
}

describe('diffToOps / applyOps', () => {
  it('produces ops that turn the old text into the new text', () => {
    const before = 'The quick brown fox\njumps over the lazy dog.\n';
    const after = 'The quick red fox\njumps over the very lazy dog!\nNew line.\n';
    const ops = diffToOps(before, after);
    expect(applyOps(before, ops)).toBe(after);
    expect(ops.length).toBeGreaterThan(0);
  });

  it('round-trips random edits', () => {
    for (let seed = 1; seed < 200; seed++) {
      const before = randomText(seed, 50 + (seed % 120));
      const after = randomText(seed * 7 + 3, 40 + (seed % 90));
      expect(applyOps(before, diffToOps(before, after))).toBe(after);
    }
  });

  it('returns no ops for identical text', () => {
    expect(diffToOps('same', 'same')).toEqual([]);
  });

  it('never splits a surrogate pair', () => {
    const before = 'x😀y';
    const after = 'x😁y';
    const ops = diffToOps(before, after);
    expect(applyOps(before, ops)).toBe(after);
    for (const op of ops) {
      const text = 'i' in op ? op.i : op.d;
      expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(text)).toBe(false);
    }
  });

  it('rejects a delete that does not match the document', () => {
    expect(() => applyOps('hello', [{ p: 0, d: 'jello' }])).toThrow(/does not match/);
  });
});

describe('applyTextEdits', () => {
  const doc = '\\section{Intro}\nAlpha beta.\nGamma beta.\n';

  it('replaces a unique passage', () => {
    expect(applyTextEdits(doc, [{ oldText: 'Alpha beta.', newText: 'Alpha delta.' }]).text).toBe('\\section{Intro}\nAlpha delta.\nGamma beta.\n');
  });

  it('refuses ambiguous text unless replaceAll is set', () => {
    expect(() => applyTextEdits(doc, [{ oldText: 'beta', newText: 'x' }])).toThrow(/occurs 2 times/);
    const all = applyTextEdits(doc, [{ oldText: 'beta', newText: 'x', replaceAll: true }]);
    expect(all.text).toBe('\\section{Intro}\nAlpha x.\nGamma x.\n');
    expect(all.replacements).toBe(2);
  });

  it('applies edits in sequence and is all-or-nothing', () => {
    const result = applyTextEdits(doc, [
      { oldText: 'Alpha', newText: 'First' },
      { oldText: 'First beta', newText: 'First epsilon' },
    ]);
    expect(result.text).toContain('First epsilon.');
    expect(() => applyTextEdits(doc, [{ oldText: 'Alpha', newText: 'A' }, { oldText: 'missing', newText: 'B' }])).toThrow(/Edit 2: oldText was not found/);
  });

  it('points at a whitespace-only near miss', () => {
    expect(() => applyTextEdits(doc, [{ oldText: 'Alpha   beta.', newText: 'x' }])).toThrow(/except for whitespace starts at line 2/);
  });

  it('points at the closest line when oldText has a typo', () => {
    expect(() => applyTextEdits(doc, [{ oldText: '\\section{Intor}', newText: 'x' }])).toThrow(/closest line is 1: \\section\{Intro\}/);
    expect(() => applyTextEdits(doc, [{ oldText: 'Alpha beta.\nWrong second line', newText: 'x' }])).toThrow(/first line matches line 2/);
    expect(() => applyTextEdits(doc, [{ oldText: 'completely unrelated words', newText: 'x' }])).toThrow(/may have changed since it was read/);
  });

  it('accepts CRLF input against LF documents', () => {
    expect(applyTextEdits('a\nb\n', [{ oldText: 'a\r\nb', newText: 'c\r\nd' }]).text).toBe('c\nd\n');
    expect(normalizeNewlines('x\r\ny\rz')).toBe('x\ny\nz');
  });

  it('does not interpret $ patterns in the replacement', () => {
    expect(applyTextEdits('cost', [{ oldText: 'cost', newText: '$& and $1' }]).text).toBe('$& and $1');
  });

  it('rejects empty or no-op edits', () => {
    expect(() => applyTextEdits(doc, [{ oldText: '', newText: 'x' }])).toThrow(/must not be empty/);
    expect(() => applyTextEdits(doc, [{ oldText: 'Alpha', newText: 'Alpha' }])).toThrow(/identical/);
  });
});

describe('assertEditableText', () => {
  it('accepts BMP text including math symbols and CJK', () => {
    expect(() => assertEditableText('Grüße ∑ ≤ 数学 — αβγ', 'ctx')).not.toThrow();
  });

  it('rejects emoji with the line number', () => {
    expect(() => assertEditableText('ok\nfine\nbad 😀 here', 'Edit not applied')).toThrow(/U\+1F600\) on line 3/);
  });
});

describe('history-ot operations', () => {
  it('builds a full-length operation for plain edits', () => {
    const before = 'Hello world\nSecond line\n';
    const after = 'Hello brave world\nSecond line!\n';
    const op = buildHistoryOtOperation(before.length, [], before, after)!;
    expect(applyHistoryOt(before, op.textOperation)).toBe(after);
  });

  it('skips over tracked deletions that are hidden from the visible text', () => {
    // Stored content still holds "old " which is a tracked deletion.
    const stored = 'Keep old text here';
    const deletes = [{ pos: 5, length: 4 }];
    const visible = visibleContent(stored, deletes);
    expect(visible).toBe('Keep text here');
    const op = buildHistoryOtOperation(stored.length, deletes, visible, 'Keep new text here')!;
    const result = applyHistoryOt(stored, op.textOperation);
    expect(visibleContent(result, [{ pos: 5, length: 4 }])).toContain('new');
    expect(result).toContain('old ');
  });

  it('marks changes as tracked in suggest mode', () => {
    const before = 'one two three';
    const op = buildHistoryOtOperation(before.length, [], before, 'one 2 three', { userId: 'u1', ts: '2026-01-01T00:00:00.000Z' })!;
    const tracked = op.textOperation.filter((c) => typeof c === 'object');
    expect(tracked).toEqual(
      expect.arrayContaining([
        { i: '2', tracking: { type: 'insert', userId: 'u1', ts: '2026-01-01T00:00:00.000Z' } },
        { r: 3, tracking: { type: 'delete', userId: 'u1', ts: '2026-01-01T00:00:00.000Z' } },
      ]),
    );
    // Tracked deletes keep the text in storage; readers see only the insertion.
    const stored = applyHistoryOt(before, op.textOperation);
    expect(stored).toBe('one two2 three');
    expect(visibleContent(stored, [{ pos: 4, length: 3 }])).toBe('one 2 three');
  });

  it('does not swallow a tracked deletion that directly follows deleted text', () => {
    // Stored "abXYcd" where "XY" is someone's tracked deletion; the visible text is "abcd".
    const deletes = [{ pos: 2, length: 2 }];
    const op = buildHistoryOtOperation(6, deletes, 'abcd', 'acd')!;
    expect(op.textOperation).toEqual([1, -1, 4]);
    expect(applyHistoryOt('abXYcd', op.textOperation)).toBe('aXYcd');
  });

  it('maps visible positions past tracked deletions', () => {
    const map = visibleToStoredMapper([{ pos: 2, length: 3 }, { pos: 10, length: 2 }]);
    expect(map(0)).toBe(0);
    expect(map(2)).toBe(5);
    expect(map(6)).toBe(9);
    expect(map(7)).toBe(12);
  });

  it('returns undefined when nothing changed', () => {
    expect(buildHistoryOtOperation(3, [], 'abc', 'abc')).toBeUndefined();
  });
});
