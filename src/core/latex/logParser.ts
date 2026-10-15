export type LogLevel = 'error' | 'warning' | 'typesetting';

export interface LogEntry {
  level: LogLevel;
  message: string;
  file?: string;
  line?: number;
  /** Extra lines TeX printed after the message (context, help text). */
  context?: string;
}

export interface ParsedLog {
  errors: LogEntry[];
  warnings: LogEntry[];
  typesetting: LogEntry[];
  /** e.g. "Output written on output.pdf (10 pages, 12345 bytes)." */
  outputSummary?: string;
  pages?: number;
  /** TeX gave up ("Emergency stop" / "Fatal error occurred"); no PDF was produced. */
  fatal?: boolean;
}

/** TeX's follow-up lines after a fatal error; they repeat the real error, so fold them into it. */
function absorbFatalFollowUps(result: ParsedLog): void {
  const kept: LogEntry[] = [];
  for (const entry of result.errors) {
    const followUp = /^(Emergency stop\.?|==> Fatal error occurred, no output PDF file produced!|\*\*\* \(job aborted, no legal \\end found\))$/.test(entry.message);
    if (!followUp) {
      kept.push(entry);
      continue;
    }
    result.fatal = true;
    const previous = kept[kept.length - 1];
    if (previous && previous.line === undefined && entry.line !== undefined) {
      previous.line = entry.line;
      previous.file ??= entry.file;
      previous.context ??= entry.context;
    } else if (!previous) {
      kept.push(entry);
    }
  }
  result.errors = kept;
}

/** TeX hard-wraps log lines at max_print_line (79 by default). */
function unwrapLines(log: string, width = 79): string[] {
  const raw = log.replace(/\r\n?/g, '\n').split('\n');
  const lines: string[] = [];
  let buffer = '';
  for (const line of raw) {
    buffer += line;
    if (line.length === width && !/^(! |l\.\d+ )/.test(line)) continue;
    lines.push(buffer);
    buffer = '';
  }
  if (buffer) lines.push(buffer);
  return lines;
}

const FILE_TOKEN = /^(?:\.{1,2}\/|\/|[A-Za-z]:[\\/])[^\s()]*|^[^\s()/]+\.(?:tex|sty|cls|clo|cfg|def|fd|bbl|aux|toc|lof|lot|out|ldf|ltx|bbx|cbx|lbx|dict|code\.tex|mkii|mkiv|pfg|pgf|tikz)(?![^\s()])/;

function cleanFile(file: string): string {
  return file.replace(/^\.\//, '').replace(/^\/compile\//, '');
}

const MESSAGE_START = /^(! |LaTeX (?:\w+ )?Warning:|Package \S+ (?:Warning|Info):|Class \S+ Warning:|(?:Over|Under)full \\[hv]box|pdfTeX warning|Missing character:|l\.\d+ )/;

export function parseLatexLog(log: string): ParsedLog {
  const lines = unwrapLines(log);
  const result: ParsedLog = { errors: [], warnings: [], typesetting: [] };
  const stack: Array<string | null> = [];
  const currentFile = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i]) return stack[i] ?? undefined;
    return undefined;
  };

  const trackFiles = (line: string) => {
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '(') {
        const match = FILE_TOKEN.exec(line.slice(i + 1));
        if (match) {
          stack.push(cleanFile(match[0]));
          i += match[0].length;
        } else {
          stack.push(null);
        }
      } else if (ch === ')') {
        stack.pop();
      }
    }
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    const fileLine = /^((?:\.{0,2}\/)?[^:\s()][^:()]*\.\w+):(\d+): (.*)$/.exec(line);
    if (fileLine) {
      const context = collectErrorContext(lines, index + 1);
      result.errors.push({
        level: 'error',
        file: cleanFile(fileLine[1]),
        line: Number(fileLine[2]),
        message: fileLine[3].trim(),
        context: context.text || undefined,
      });
      index = context.nextIndex - 1;
      continue;
    }

    if (line.startsWith('! ')) {
      let message = line.slice(2).trim();
      let cursor = index + 1;
      // LaTeX/package errors continue on lines that start with spaces or "(pkg)".
      while (cursor < lines.length && /^(\(\S+\)\s+|\s{2,})\S/.test(lines[cursor]) && !/^l\.\d+/.test(lines[cursor])) {
        message += ` ${lines[cursor].replace(/^\(\S+\)\s+/, '').trim()}`;
        cursor++;
      }
      const context = collectErrorContext(lines, cursor);
      result.errors.push({
        level: 'error',
        file: currentFile(),
        line: context.lineNumber,
        message,
        context: context.text || undefined,
      });
      index = context.nextIndex - 1;
      continue;
    }

    const warning = /^(LaTeX(?: \w+)? Warning|Package (\S+) Warning|Class (\S+) Warning): (.*)$/.exec(line);
    if (warning) {
      const owner = warning[2] ?? warning[3];
      let message = warning[4].trim();
      let cursor = index + 1;
      const continuation = owner ? new RegExp(`^\\(${owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\s+`) : /^\s{4,}/;
      while (cursor < lines.length && lines[cursor].trim() && (continuation.test(lines[cursor]) || /^\s{4,}\S/.test(lines[cursor]))) {
        message += ` ${lines[cursor].replace(continuation, '').trim()}`;
        cursor++;
      }
      const lineMatch = /on input line (\d+)/.exec(message);
      result.warnings.push({
        level: 'warning',
        file: currentFile(),
        line: lineMatch ? Number(lineMatch[1]) : undefined,
        message: owner ? `${owner}: ${message}` : message,
      });
      index = cursor - 1;
      continue;
    }

    const box = /^((?:Over|Under)full \\[hv]box .*?)(?: (?:in paragraph |in alignment |detected )?at lines? (\d+)(?:--(\d+))?)?$/.exec(line);
    if (box && /^(Over|Under)full/.test(line)) {
      result.typesetting.push({
        level: 'typesetting',
        file: currentFile(),
        line: box[2] ? Number(box[2]) : undefined,
        message: line.trim(),
      });
      continue;
    }

    const output = /^Output written on (.+) \((\d+) pages?/.exec(line);
    if (output) {
      result.outputSummary = line.trim();
      result.pages = Number(output[2]);
      continue;
    }
    if (/^No pages of output\./.test(line)) {
      result.outputSummary = line.trim();
      result.pages = 0;
      continue;
    }

    if (!MESSAGE_START.test(line)) trackFiles(line);
  }

  absorbFatalFollowUps(result);
  return result;
}

/** TeX's interactive prompts and help boilerplate, meaningless for a server-side compile. */
const INTERACTIVE_NOISE =
  /^(See the .* (manual|documentation)|Type {1,2}[HX] <return>|Type X to quit|or enter new name|Enter file name:|<read \*>|\*\*\* \(cannot \\read from terminal|You're in trouble|\.\.\.$|For immediate help type H)/;

function collectErrorContext(lines: string[], start: number): { lineNumber?: number; text: string; nextIndex: number } {
  const context: string[] = [];
  let lineNumber: number | undefined;
  let cursor = start;
  for (; cursor < lines.length && cursor < start + 12; cursor++) {
    const line = lines[cursor];
    const at = /^l\.(\d+) ?(.*)$/.exec(line);
    if (at) {
      lineNumber = Number(at[1]);
      context.push(line);
      // TeX prints the rest of the offending line on the next line.
      if (cursor + 1 < lines.length && lines[cursor + 1].trim() && !MESSAGE_START.test(lines[cursor + 1])) {
        context.push(lines[cursor + 1]);
        cursor++;
      }
      cursor++;
      break;
    }
    if (MESSAGE_START.test(line) && !line.startsWith('l.')) break;
    if (line.trim() && !INTERACTIVE_NOISE.test(line.trim())) context.push(line);
  }
  return { lineNumber, text: context.join('\n').trim(), nextIndex: cursor };
}

/** BibTeX writes problems to the .blg file rather than the main log. */
export function parseBibtexLog(blg: string): LogEntry[] {
  const entries: LogEntry[] = [];
  const lines = blg.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const warning = /^Warning--(.*)$/.exec(line);
    if (warning) {
      entries.push({ level: 'warning', message: `BibTeX: ${warning[1].trim()}` });
      continue;
    }
    const error = /^(.*)---line (\d+) of file (.*)$/.exec(line);
    if (error) {
      entries.push({ level: 'error', message: `BibTeX: ${error[1].trim()}`, line: Number(error[2]), file: cleanFile(error[3].trim()) });
      continue;
    }
    const biber = /^\[\d+\] .*?> (ERROR|WARN) - (.*)$/.exec(line);
    if (biber) {
      entries.push({ level: biber[1] === 'ERROR' ? 'error' : 'warning', message: `Biber: ${biber[2].trim()}` });
    }
  }
  return entries;
}
