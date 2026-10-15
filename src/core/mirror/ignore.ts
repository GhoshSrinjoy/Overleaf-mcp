import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { globToRegExp } from '../search/glob';

export const IGNORE_FILE = '.overleafignore';
export const STATE_DIR = '.overleaf';

/** Build products of a local LaTeX run (and editor clutter) that must not be uploaded. */
export function defaultIgnore(rootDocPath?: string): string {
  const pdf = rootDocPath ? `/${rootDocPath.replace(/\.tex$/i, '.pdf')}\n` : '';
  return `# Files that stay on this computer and are never synced to Overleaf (gitignore syntax).
# Local LaTeX build output:
*.aux
*.log
*.out
*.toc
*.lof
*.lot
*.fls
*.fdb_latexmk
*.synctex
*.synctex.gz
*.synctex(busy)
*.bbl
*.blg
*.bcf
*.run.xml
*.nav
*.snm
*.vrb
*.xdv
*.dvi
*.idx
*.ilg
*.ind
*.glg
*.glo
*.gls
*.ist
*.acn
*.acr
*.alg
*.loa
*.lol
*.thm
_minted*/
${pdf}# Editor and system files:
.git/
.vscode/
.idea/
.DS_Store
Thumbs.db
desktop.ini
*~
*.swp
`;
}

interface Rule {
  pattern: RegExp;
  negate: boolean;
  directoryOnly: boolean;
}

function compile(lines: string[]): Rule[] {
  const rules: Rule[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    let body = negate ? line.slice(1) : line;
    const directoryOnly = body.endsWith('/');
    if (directoryOnly) body = body.slice(0, -1);
    rules.push({ pattern: globToRegExp(body), negate, directoryOnly });
  }
  return rules;
}

/** Returns a predicate for project-relative paths; the last matching rule wins, as in git. */
export function makeIgnoreMatcher(content: string): (filePath: string) => boolean {
  const rules = compile(content.split(/\r?\n/));
  return (filePath: string) => {
    if (filePath === STATE_DIR || filePath.startsWith(`${STATE_DIR}/`) || filePath === IGNORE_FILE) return true;
    // Never sync git metadata, whatever the ignore file says: a project file at .git/hooks/… would
    // otherwise become an executable hook in a repository on this computer.
    if (filePath.split('/')[0].toLowerCase().replace(/[. ]+$/, '') === '.git') return true;
    const parts = filePath.split('/');
    let ignored = false;
    for (const rule of rules) {
      // A directory rule matches any parent directory of the path.
      const candidates = rule.directoryOnly ? parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/')) : [filePath];
      if (candidates.some((candidate) => rule.pattern.test(candidate))) ignored = !rule.negate;
    }
    return ignored;
  };
}

export async function loadIgnoreMatcher(dir: string): Promise<(filePath: string) => boolean> {
  try {
    return makeIgnoreMatcher(await fs.readFile(path.join(dir, IGNORE_FILE), 'utf8'));
  } catch {
    return makeIgnoreMatcher(defaultIgnore());
  }
}
