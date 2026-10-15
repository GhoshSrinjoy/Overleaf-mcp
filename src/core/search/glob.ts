/**
 * Converts a gitignore-style glob to a RegExp over forward-slash relative paths.
 * Supports **, *, ?, {a,b} and [...] classes. Patterns without a slash match the file name anywhere.
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = glob.trim().replace(/\\/g, '/');
  const anchored = pattern.includes('/') && !pattern.startsWith('**/');
  pattern = pattern.replace(/^\/+/, '');
  let out = '';
  let inBraces = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        const followedBySlash = pattern[i + 2] === '/';
        out += followedBySlash ? '(?:.*/)?' : '.*';
        i += followedBySlash ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) {
        out += '\\[';
      } else {
        let cls = pattern.slice(i + 1, end).replace(/\\/g, '\\\\');
        if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
        out += `[${cls}]`;
        i = end;
      }
    } else if (ch === '{') {
      inBraces++;
      out += '(?:';
    } else if (ch === '}' && inBraces) {
      inBraces--;
      out += ')';
    } else if (ch === ',' && inBraces) {
      out += '|';
    } else {
      out += ch.replace(/[.+^$()|\\]/g, '\\$&');
    }
  }
  return new RegExp(anchored ? `^${out}$` : `(?:^|/)${out}$`, process.platform === 'win32' ? 'i' : '');
}

export function makePathFilter(include: readonly string[] = [], exclude: readonly string[] = []): (path: string) => boolean {
  const includes = include.filter(Boolean).map(globToRegExp);
  const excludes = exclude.filter(Boolean).map(globToRegExp);
  return (path: string) => {
    if (includes.length && !includes.some((re) => re.test(path))) return false;
    return !excludes.some((re) => re.test(path));
  };
}
