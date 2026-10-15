import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { OverleafError } from '../util/errors';
import { walkFiles } from '../util/fsx';
import { makePathFilter } from './glob';
import { clipLine } from './ripgrep';
import { decodeText, isTextContent } from './textFiles';
import { GrepMatch, GrepOptions, GrepResult, SearchTarget, isSmartCaseInsensitive } from './types';

const MAX_FILE_BYTES = 8 * 1024 * 1024;

export function buildMatcher(options: GrepOptions): RegExp {
  let source = options.regex ? options.query : options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (options.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  const flags = `u${isSmartCaseInsensitive(options) ? 'i' : ''}`;
  try {
    return new RegExp(source, flags);
  } catch (error) {
    throw new OverleafError('INVALID_INPUT', `Invalid regular expression: ${(error as Error).message}`);
  }
}

/** Pure JS search used when ripgrep is unavailable. Same output shape as the ripgrep engine. */
export async function jsSearch(targets: readonly SearchTarget[], options: GrepOptions): Promise<GrepResult> {
  const matcher = buildMatcher(options);
  const keepPath = makePathFilter(options.include, options.exclude);
  const maxResults = options.maxResults ?? 200;
  const context = Math.max(0, Math.min(options.contextLines ?? 0, 10));
  const matches: GrepMatch[] = [];

  for (const target of targets) {
    for (const relative of await walkFiles(target.dir)) {
      if (!keepPath(relative)) continue;
      const absolute = path.join(target.dir, ...relative.split('/'));
      let bytes: Buffer;
      try {
        const stat = await fs.stat(absolute);
        if (stat.size > MAX_FILE_BYTES) continue;
        bytes = await fs.readFile(absolute);
      } catch {
        continue;
      }
      if (!isTextContent(relative, bytes)) continue;
      const lines = decodeText(bytes).split(/\r?\n/);
      let perFile = 0;
      for (let i = 0; i < lines.length; i++) {
        const found = matcher.exec(lines[i]);
        if (!found) continue;
        if (matches.length >= maxResults) return { matches, truncated: true, engine: 'js' };
        const column = found.index + 1;
        matches.push({
          projectId: target.projectId,
          projectName: target.projectName,
          file: relative,
          line: i + 1,
          column,
          text: clipLine(lines[i], column),
          before: lines.slice(Math.max(0, i - context), i).map((l) => clipLine(l)),
          after: lines.slice(i + 1, i + 1 + context).map((l) => clipLine(l)),
        });
        if (options.maxPerFile && ++perFile >= options.maxPerFile) break;
      }
    }
  }
  return { matches, truncated: false, engine: 'js' };
}
