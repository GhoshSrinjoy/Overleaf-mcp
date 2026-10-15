import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { OverleafError } from '../util/errors';
import { makePathFilter } from './glob';
import { GrepMatch, GrepOptions, GrepResult, SearchTarget, isSmartCaseInsensitive } from './types';

const RG_EXE = process.platform === 'win32' ? 'rg.exe' : 'rg';

/**
 * Finds a ripgrep binary: explicit candidates first (e.g. the copy VS Code ships), then PATH.
 */
export async function locateRipgrep(candidates: ReadonlyArray<string | undefined> = []): Promise<string | undefined> {
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const all = [...candidates.filter((c): c is string => !!c), ...pathDirs.map((dir) => path.join(dir, RG_EXE))];
  for (const candidate of all) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** Where VS Code (and forks like Cursor) keep their bundled ripgrep, relative to `vscode.env.appRoot`. */
export function vscodeRipgrepCandidates(appRoot: string): string[] {
  const platformDir = `${process.platform}-${process.arch}`;
  const candidates: string[] = [];
  for (const modules of ['node_modules.asar.unpacked', 'node_modules']) {
    candidates.push(
      path.join(appRoot, modules, '@vscode', 'ripgrep-universal', 'bin', platformDir, RG_EXE),
      path.join(appRoot, modules, '@vscode', 'ripgrep', 'bin', RG_EXE),
      path.join(appRoot, modules, 'vscode-ripgrep', 'bin', RG_EXE),
    );
  }
  return candidates;
}

export const RIPGREP_EXECUTABLE = RG_EXE;

interface RgText {
  text?: string;
  bytes?: string;
}

function rgText(value: RgText | undefined): string {
  if (!value) return '';
  if (value.text !== undefined) return value.text;
  return value.bytes ? Buffer.from(value.bytes, 'base64').toString('utf8') : '';
}

/** Keeps very long lines (minified data, huge tables) from flooding results. */
export function clipLine(line: string, column = 1, width = 400): string {
  if (line.length <= width) return line;
  const start = Math.max(0, Math.min(column - 1 - Math.floor(width / 4), line.length - width));
  return `${start > 0 ? '…' : ''}${line.slice(start, start + width)}${start + width < line.length ? '…' : ''}`;
}

export class RipgrepRegexError extends OverleafError {}

export async function ripgrepSearch(rgPath: string, targets: readonly SearchTarget[], options: GrepOptions): Promise<GrepResult> {
  // With no paths ripgrep would search the current directory instead.
  if (!targets.length) return { matches: [], truncated: false, engine: 'ripgrep' };
  const maxResults = options.maxResults ?? 200;
  const context = Math.max(0, Math.min(options.contextLines ?? 0, 10));
  const keepPath = makePathFilter(options.include, options.exclude);
  const args = ['--json', '--no-config', '--hidden', '--no-ignore', '--sort', 'path', '--max-filesize', '8M'];
  if (!options.regex) args.push('--fixed-strings');
  args.push(isSmartCaseInsensitive(options) ? '--ignore-case' : '--case-sensitive');
  if (options.wholeWord) args.push('--word-regexp');
  if (context) args.push('--context', String(context));
  if (options.maxPerFile) args.push('--max-count', String(options.maxPerFile));
  args.push('--regexp', options.query, '--', ...targets.map((t) => t.dir));

  const resolvedTargets = targets.map((t) => ({ target: t, root: path.resolve(t.dir) }));
  const locate = (file: string) => {
    const absolute = path.resolve(file);
    for (const { target, root } of resolvedTargets) {
      const relative = path.relative(root, absolute);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return { target, relative: relative.split(path.sep).join('/') };
      }
    }
    return undefined;
  };

  const child = spawn(rgPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < 8000) stderr += chunk;
  });

  const matches: GrepMatch[] = [];
  let truncated = false;
  let fileLines = new Map<number, string>();
  let fileMatches: Array<{ line: number; column: number }> = [];
  let current: ReturnType<typeof locate>;

  const flushFile = () => {
    if (!current) return;
    for (const { line, column } of fileMatches) {
      if (matches.length >= maxResults) {
        truncated = true;
        break;
      }
      const before: string[] = [];
      const after: string[] = [];
      for (let n = line - context; n < line; n++) if (fileLines.has(n)) before.push(fileLines.get(n)!);
      for (let n = line + 1; n <= line + context; n++) if (fileLines.has(n)) after.push(fileLines.get(n)!);
      matches.push({
        projectId: current.target.projectId,
        projectName: current.target.projectName,
        file: current.relative,
        line,
        column,
        text: clipLine(fileLines.get(line) ?? '', column),
        before: before.map((l) => clipLine(l)),
        after: after.map((l) => clipLine(l)),
      });
    }
    fileLines = new Map();
    fileMatches = [];
  };

  const exit = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });

  const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const raw of reader) {
    if (!raw) continue;
    let message: { type: string; data: Record<string, unknown> };
    try {
      message = JSON.parse(raw);
    } catch {
      continue;
    }
    const data = message.data as {
      path?: RgText;
      lines?: RgText;
      line_number?: number;
      submatches?: Array<{ start: number }>;
    };
    if (message.type === 'begin') {
      const located = locate(rgText(data.path));
      current = located && keepPath(located.relative) ? located : undefined;
    } else if ((message.type === 'match' || message.type === 'context') && current && data.line_number) {
      const lineText = rgText(data.lines).replace(/\r?\n$/, '');
      fileLines.set(data.line_number, lineText);
      if (message.type === 'match') {
        const byteStart = data.submatches?.[0]?.start ?? 0;
        const column = Buffer.from(rgText(data.lines)).subarray(0, byteStart).toString('utf8').length + 1;
        fileMatches.push({ line: data.line_number, column });
      }
    } else if (message.type === 'end') {
      flushFile();
      current = undefined;
      if (truncated) {
        child.kill();
        break;
      }
    }
  }
  flushFile();

  const code = await exit;
  if (code === 2 && !matches.length && !truncated) {
    const detail = stderr.trim();
    if (/regex parse error|error parsing regex|look-?around|backreference/i.test(detail)) {
      throw new RipgrepRegexError('INVALID_INPUT', `Invalid regular expression: ${detail}`);
    }
    if (detail) throw new OverleafError('HTTP', `ripgrep failed: ${detail}`);
  }
  return { matches, truncated, engine: 'ripgrep' };
}
