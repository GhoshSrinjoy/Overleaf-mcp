export interface GrepOptions {
  query: string;
  /** Treat `query` as a regular expression (Rust/ripgrep syntax; JS syntax in the fallback engine). */
  regex?: boolean;
  /** Undefined means smart case: case-insensitive unless the query contains an uppercase letter. */
  caseSensitive?: boolean;
  wholeWord?: boolean;
  /** Glob patterns of files to include, e.g. ["*.tex", "chapters/**"]. Patterns without "/" match file names. */
  include?: string[];
  exclude?: string[];
  contextLines?: number;
  maxResults?: number;
  maxPerFile?: number;
}

export interface SearchTarget {
  projectId: string;
  projectName: string;
  /** Directory holding the project's files. */
  dir: string;
}

export interface GrepMatch {
  projectId: string;
  projectName: string;
  file: string;
  line: number;
  /** 1-based column of the first match on the line. */
  column: number;
  text: string;
  before: string[];
  after: string[];
}

export interface GrepResult {
  matches: GrepMatch[];
  truncated: boolean;
  engine: 'ripgrep' | 'js';
}

export function isSmartCaseInsensitive(options: GrepOptions): boolean {
  if (options.caseSensitive !== undefined) return !options.caseSensitive;
  return !/[A-Z]/.test(options.query);
}
