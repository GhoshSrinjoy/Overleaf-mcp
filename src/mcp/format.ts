import { FileEntry } from '../core/backends/types';
import { LogEntry } from '../core/latex/logParser';
import { OutlineEntry } from '../core/latex/outline';
import { ProjectSummary } from '../core/overleaf/types';
import { HistoryUpdate } from '../core/overleaf/webClient';
import { LexicalHit } from '../core/search/lexical';
import { GrepMatch } from '../core/search/types';
import { ProjectInfo } from '../core/service';

export function formatDate(iso?: string | number): string {
  if (iso === undefined) return 'unknown';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function personName(user?: { email?: string; firstName?: string; lastName?: string } | null): string {
  if (!user) return '';
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
  return name || user.email || '';
}

export function projectLabel(project: ProjectSummary): string {
  return `"${project.name}" (${project.id})`;
}

export function formatProjects(projects: ProjectInfo[], total: number): string {
  if (!projects.length) return 'No projects match.';
  const lines = projects.map((p) => {
    const parts = [`${p.pinned ? '📌 ' : ''}${p.name}`, `id ${p.id}`, `updated ${formatDate(p.lastUpdated)}`];
    const by = personName(p.lastUpdatedBy);
    if (by) parts[2] += ` by ${by}`;
    const owner = personName(p.owner);
    if (owner && p.accessLevel !== 'owner') parts.push(`owner ${owner}`);
    if (p.accessLevel) parts.push(`access ${p.accessLevel}`);
    if (p.tags.length) parts.push(`tags ${p.tags.join(', ')}`);
    if (p.localDir) parts.push(`synced to local folder ${p.localDir}`);
    if (p.archived) parts.push('archived');
    if (p.trashed) parts.push('trashed');
    return `- ${parts.join(' · ')}`;
  });
  const more = total > projects.length ? `\n…and ${total - projects.length} more (narrow with query or raise limit).` : '';
  return `${projects.length} project(s):\n${lines.join('\n')}${more}`;
}

export function formatTree(project: ProjectSummary, entries: FileEntry[], rootDocPath?: string, permissionsLevel?: string): string {
  const lines = entries.map((entry) => {
    const depth = entry.path.split('/').length - 1;
    const name = entry.path.split('/').pop();
    const marker = entry.type === 'folder' ? '/' : entry.path === rootDocPath ? '  ← main document' : entry.type === 'file' ? '  (binary/uploaded file)' : '';
    return `${'  '.repeat(depth)}${name}${marker}`;
  });
  const header = `Project ${projectLabel(project)}${permissionsLevel ? ` — your access: ${permissionsLevel}` : ''}\n${entries.filter((e) => e.type !== 'folder').length} files`;
  return `${header}\n${lines.join('\n')}`;
}

export function sliceLines(text: string, startLine?: number, endLine?: number, numbered = false): { body: string; total: number; start: number; end: number } {
  const lines = text.split('\n');
  const total = lines.length;
  const start = Math.max(1, Math.min(startLine ?? 1, total));
  const end = Math.max(start, Math.min(endLine ?? total, total));
  const selected = lines.slice(start - 1, end);
  const width = String(end).length;
  const body = numbered ? selected.map((line, i) => `${String(start + i).padStart(width)}\t${line}`).join('\n') : selected.join('\n');
  return { body, total, start, end };
}

export function formatGrep(matches: GrepMatch[], truncated: boolean, contextLines: number): string {
  if (!matches.length) return 'No matches.';
  const byFile = new Map<string, GrepMatch[]>();
  for (const match of matches) {
    const key = `${match.projectName}\u0000${match.projectId}\u0000${match.file}`;
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push(match);
  }
  const blocks: string[] = [];
  let lastProject = '';
  for (const [key, fileMatches] of byFile) {
    const [projectName, projectId, file] = key.split('\u0000');
    if (projectId !== lastProject) {
      blocks.push(`## ${projectName} (${projectId})`);
      lastProject = projectId;
    }
    const lines: string[] = [];
    let previousEnd = 0;
    for (const match of fileMatches) {
      const first = match.line - match.before.length;
      if (contextLines && previousEnd && first > previousEnd + 1) lines.push('--');
      match.before.forEach((text, i) => {
        const n = first + i;
        if (n > previousEnd) lines.push(`${file}-${n}- ${text}`);
      });
      if (match.line > previousEnd) lines.push(`${file}:${match.line}: ${match.text}`);
      match.after.forEach((text, i) => {
        const n = match.line + 1 + i;
        if (n > previousEnd) lines.push(`${file}-${n}- ${text}`);
      });
      previousEnd = Math.max(previousEnd, match.line + match.after.length);
    }
    blocks.push(lines.join('\n'));
  }
  const files = byFile.size;
  return `${matches.length} match(es) in ${files} file(s)${truncated ? ' (truncated: raise maxResults or narrow the search)' : ''}:\n\n${blocks.join('\n\n')}`;
}

export function formatHits(hits: LexicalHit[]): string {
  if (!hits.length) return 'No relevant passages found. Try other words, or grep for an exact phrase.';
  return hits
    .map((hit, i) => {
      const where = `${hit.file}:${hit.startLine}-${hit.endLine}`;
      const section = hit.section ? ` · section "${hit.section}"` : '';
      const snippet = hit.snippet.map((line) => `    ${line.trim()}`).join('\n');
      return `${i + 1}. ${hit.projectName} (${hit.projectId}) — ${where}${section} · score ${hit.score}\n${snippet}`;
    })
    .join('\n\n');
}

export function formatOutline(entries: OutlineEntry[], rootFile: string, missing: Array<{ file: string; line: number; target: string }>): string {
  if (!entries.length) return `No sectioning commands found starting from ${rootFile}.`;
  const minLevel = Math.min(...entries.map((e) => e.level));
  const lines = entries.map((e) => `${'  '.repeat(e.level - minLevel)}- ${e.title}${e.starred ? ' *' : ''}  [${e.type}, ${e.file}:${e.line}]`);
  const notes = missing.length ? `\n\nUnresolved includes: ${missing.map((m) => `${m.target} (${m.file}:${m.line})`).join(', ')}` : '';
  return `Outline from ${rootFile}:\n${lines.join('\n')}${notes}`;
}

export function formatLogEntries(entries: LogEntry[], limit: number): string {
  return entries
    .slice(0, limit)
    .map((entry) => {
      const where = entry.file ? `${entry.file}${entry.line ? `:${entry.line}` : ''}: ` : entry.line ? `line ${entry.line}: ` : '';
      const context = entry.context ? `\n    ${entry.context.split('\n').join('\n    ')}` : '';
      return `- ${where}${entry.message}${context}`;
    })
    .join('\n');
}

export function formatHistory(updates: HistoryUpdate[]): string {
  if (!updates.length) return 'No history entries found.';
  return updates
    .map((update) => {
      const users = (update.meta.users ?? [])
        .map((u) => (u ? [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || 'unknown' : 'deleted user'))
        .join(', ');
      const files = [...(update.pathnames ?? [])];
      for (const op of update.project_ops ?? []) {
        const describe = op as { add?: { pathname: string }; remove?: { pathname: string }; rename?: { pathname: string; newPathname: string } };
        if (describe.add) files.push(`+${describe.add.pathname}`);
        if (describe.remove) files.push(`-${describe.remove.pathname}`);
        if (describe.rename) files.push(`${describe.rename.pathname} → ${describe.rename.newPathname}`);
      }
      const labels = update.labels?.map((l) => l.comment).filter(Boolean);
      return `- v${update.fromV}→v${update.toV} · ${formatDate(update.meta.end_ts)} · ${users || 'unknown'} · ${files.join(', ') || '(no file changes)'}${labels?.length ? ` · labels: ${labels.join(', ')}` : ''}`;
    })
    .join('\n');
}
