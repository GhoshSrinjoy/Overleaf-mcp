import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { extensionOf, isTextPath } from '../core/search/textFiles';
import { OverleafService, ProjectSelector } from '../core/service';
import { OverleafError, errorMessage } from '../core/util/errors';
import { Logger } from '../core/util/log';
import { diffStats } from '../core/util/unifiedDiff';
import {
  formatGrep,
  formatHistory,
  formatHits,
  formatLogEntries,
  formatOutline,
  formatProjects,
  formatTree,
  projectLabel,
  sliceLines,
} from './format';

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_READ_CHARS = 400_000;

const project = z
  .string()
  .optional()
  .describe('Project name, id or Overleaf URL. May be omitted when exactly one project is pinned.');

const projects = z
  .union([z.array(z.string()), z.literal('all')])
  .optional()
  .describe('Projects to cover: a list of names/ids, or "all". Defaults to the pinned projects, or the 25 most recently updated if none are pinned.');

function text(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }] };
}

function withNotes(body: string, notes: string[]): string {
  return notes.length ? `${body}\n\nNotes:\n${notes.map((n) => `- ${n}`).join('\n')}` : body;
}

let activeCalls = 0;
const idleWaiters = new Set<() => void>();

/** Resolves once no tool call is running (or after `timeoutMs`), so shutdown can finish replies. */
export function whenToolsIdle(timeoutMs: number): Promise<void> {
  if (!activeCalls) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      idleWaiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    idleWaiters.add(done);
  });
}

/** Turns failures into tool errors the model can read and recover from. */
function guard<A>(logger: Logger, name: string, handler: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    activeCalls++;
    try {
      return await handler(args);
    } catch (error) {
      if (!(error instanceof OverleafError)) logger.error(`Tool ${name} failed`, error);
      return { isError: true, content: [{ type: 'text', text: `Error: ${errorMessage(error)}` }] };
    } finally {
      if (--activeCalls === 0) for (const done of [...idleWaiters]) done();
    }
  };
}

function selection(value: string[] | 'all' | undefined): ProjectSelector {
  return value;
}

export function registerTools(server: McpServer, service: OverleafService, logger: Logger): void {
  const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

  server.registerTool(
    'status',
    {
      title: 'Overleaf connection status',
      description: 'Shows which Overleaf account is signed in, the server, pinned projects and the search engine in use. Call this first if other tools report sign-in problems.',
      annotations: readOnly,
    },
    guard(logger, 'status', async () => {
      const status = await service.status();
      const lines = [
        status.signedIn ? `Signed in to ${status.serverUrl} as ${status.email ?? status.userId}.` : `Not signed in: ${status.error}`,
        `Pinned projects: ${status.pinned.length ? status.pinned.map(projectLabel).join(', ') : 'none'}`,
        ...(status.gitProjects ? [`Git-token projects configured: ${status.gitProjects}`] : []),
        `Search engine: ${status.ripgrep ? `ripgrep (${status.ripgrep})` : 'built-in JavaScript search'}`,
        `Data directory: ${status.dataDir}`,
      ];
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'list_projects',
    {
      title: 'List Overleaf projects',
      description: 'Lists the projects in the Overleaf account (newest first, pinned first), with ids, last update, owner, access level and tags.',
      inputSchema: {
        query: z.string().optional().describe('Only projects whose name contains this text'),
        tag: z.string().optional().describe('Only projects in this Overleaf tag/folder'),
        includeArchived: z.boolean().optional(),
        includeTrashed: z.boolean().optional(),
        limit: z.number().int().min(1).max(500).optional().describe('Default 50'),
        refresh: z.boolean().optional().describe('Bypass the 30-second project list cache'),
      },
      annotations: readOnly,
    },
    guard(logger, 'list_projects', async (args) => {
      const list = await service.listProjects(args);
      return text(formatProjects(list.slice(0, args.limit ?? 50), list.length));
    }),
  );

  server.registerTool(
    'pin_projects',
    {
      title: 'Pin projects for AI work',
      description: 'Pins (or unpins) projects. Pinned projects are the default scope for grep/search, and a single pinned project lets other tools omit "project". Pins are shared with the VS Code panel.',
      inputSchema: {
        projects: z.array(z.string()).min(1).describe('Project names or ids'),
        unpin: z.boolean().optional().describe('Remove the pins instead of adding them'),
      },
      annotations: { idempotentHint: true, openWorldHint: false },
    },
    guard(logger, 'pin_projects', async (args) => {
      const pinned = await service.setPinned(args.projects, !args.unpin);
      return text(`Pinned projects now: ${pinned.length ? pinned.map(projectLabel).join(', ') : 'none'}`);
    }),
  );

  server.registerTool(
    'create_project',
    {
      title: 'Create an Overleaf project',
      description: 'Creates a new Overleaf project, either blank (with an empty main.tex) or from Overleaf\'s example template.',
      inputSchema: {
        name: z.string().min(1).max(150),
        template: z.enum(['blank', 'example']).optional().describe('Default blank'),
      },
      annotations: { openWorldHint: true },
    },
    guard(logger, 'create_project', async (args) => {
      const created = await service.createProject(args.name, args.template === 'example' ? 'example' : 'none');
      return text(`Created project ${projectLabel(created)}.`);
    }),
  );

  server.registerTool(
    'list_files',
    {
      title: 'List project files',
      description: 'Shows the file tree of a project, marking the main document. Docs are editable text; "binary/uploaded" files are images, PDFs and other uploads.',
      inputSchema: { project },
      annotations: readOnly,
    },
    guard(logger, 'list_files', async (args) => {
      const { project: resolved, tree } = await service.listFiles(args.project);
      const localDir = (await service.settings.read()).mirrors?.find((m) => m.projectId === resolved.id)?.dir;
      const mirrorNote = localDir ? `\n\nThis project is also synced two-way with the local folder ${localDir}; edits to files there reach Overleaf automatically.` : '';
      return text(`${formatTree(resolved, tree.entries, tree.rootDocPath, tree.permissionsLevel)}${mirrorNote}`);
    }),
  );

  server.registerTool(
    'read_file',
    {
      title: 'Read a project file',
      description:
        'Reads a file live from Overleaf (always the latest content, including collaborators\' unsaved typing). Optionally a line range. Images (png/jpg/gif/webp) are returned as images.',
      inputSchema: {
        project,
        path: z.string().describe('File path inside the project, e.g. "main.tex" or "sections/intro.tex"'),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
        lineNumbers: z.boolean().optional().describe('Prefix lines with their numbers (do not copy these into edits)'),
      },
      annotations: readOnly,
    },
    guard(logger, 'read_file', async (args) => {
      const mime = IMAGE_TYPES[extensionOf(args.path)];
      if (mime) {
        const { project: resolved, path: filePath, data } = await service.readBinaryFile(args.project, args.path);
        if (data.byteLength > MAX_IMAGE_BYTES) return text(`${filePath} in ${projectLabel(resolved)} is an image of ${data.byteLength} bytes, too large to return.`);
        return {
          content: [
            { type: 'text', text: `${filePath} from ${projectLabel(resolved)} (${data.byteLength} bytes):` },
            { type: 'image', data: Buffer.from(data).toString('base64'), mimeType: mime },
          ],
        };
      }
      if (isTextPath(args.path) === false) {
        const { project: resolved, path: filePath, data } = await service.readBinaryFile(args.project, args.path);
        return text(`${filePath} in ${projectLabel(resolved)} is a binary file (${data.byteLength} bytes). Use download_file to save it locally.`);
      }
      const { project: resolved, path: filePath, content } = await service.readFile(args.project, args.path);
      const slice = sliceLines(content.text, args.startLine, args.endLine, args.lineNumbers);
      const ranged = args.startLine || args.endLine;
      let body = slice.body;
      let clipped = '';
      if (body.length > MAX_READ_CHARS) {
        body = body.slice(0, MAX_READ_CHARS);
        clipped = `\n… truncated at ${MAX_READ_CHARS} characters; read the rest with startLine/endLine.`;
      }
      const extras = [
        content.version !== undefined ? `version ${content.version}` : '',
        content.trackedChanges ? `${content.trackedChanges} pending tracked change(s)` : '',
        content.comments ? `${content.comments} comment thread(s)` : '',
      ].filter(Boolean);
      const header = `${filePath} from ${projectLabel(resolved)} — ${ranged ? `lines ${slice.start}-${slice.end} of ${slice.total}` : `${slice.total} lines`}${extras.length ? `, ${extras.join(', ')}` : ''}`;
      return text(`${header}\n\n${body}${clipped}`);
    }),
  );

  server.registerTool(
    'grep',
    {
      title: 'Grep across projects',
      description:
        'Exact text or regex search (ripgrep) across one or many projects, with file:line results and optional context. Uses local snapshots that refresh automatically when Overleaf reports changes. For topic-style questions use "search" instead.',
      inputSchema: {
        query: z.string().min(1).describe('Text to find, or a regex when regex is true'),
        projects,
        regex: z.boolean().optional(),
        caseSensitive: z.boolean().optional().describe('Default: smart case (case-insensitive unless the query has capitals)'),
        wholeWord: z.boolean().optional(),
        include: z.array(z.string()).optional().describe('Glob patterns of files to search, e.g. ["*.tex"] or ["chapters/**"]'),
        exclude: z.array(z.string()).optional(),
        contextLines: z.number().int().min(0).max(10).optional().describe('Lines of context around each match (default 1)'),
        maxResults: z.number().int().min(1).max(2000).optional().describe('Default 100'),
        refresh: z.boolean().optional().describe('Re-download the projects before searching'),
      },
      annotations: readOnly,
    },
    guard(logger, 'grep', async (args) => {
      const contextLines = args.contextLines ?? 1;
      const { result, notes } = await service.grep({ ...args, projects: selection(args.projects), contextLines, maxResults: args.maxResults ?? 100 });
      return text(withNotes(formatGrep(result.matches, result.truncated, contextLines), notes));
    }),
  );

  server.registerTool(
    'search',
    {
      title: 'Ranked search across projects',
      description:
        'Relevance-ranked full-text search (BM25 with fuzzy and prefix matching) that finds passages about a topic, e.g. "related work on diffusion models", across one or many projects. Returns file:line ranges with snippets; read_file or get_section can then fetch the text.',
      inputSchema: {
        query: z.string().min(1),
        projects,
        limit: z.number().int().min(1).max(100).optional().describe('Default 10'),
        matchAll: z.boolean().optional().describe('Require every query word to appear'),
        refresh: z.boolean().optional(),
      },
      annotations: readOnly,
    },
    guard(logger, 'search', async (args) => {
      const { hits, notes } = await service.search(args.query, { projects: selection(args.projects), limit: args.limit ?? 10, matchAll: args.matchAll, refresh: args.refresh });
      return text(withNotes(formatHits(hits), notes));
    }),
  );

  server.registerTool(
    'get_outline',
    {
      title: 'Document outline',
      description: 'Outline of a LaTeX project (parts, chapters, sections, …) following \\input/\\include from the main document, with file:line for each heading.',
      inputSchema: {
        project,
        rootFile: z.string().optional().describe('Start from this file instead of the project\'s main document'),
      },
      annotations: readOnly,
    },
    guard(logger, 'get_outline', async (args) => {
      const { project: resolved, outline } = await service.outline(args.project, { rootFile: args.rootFile });
      return text(`${projectLabel(resolved)}\n${formatOutline(outline.entries, outline.rootFile, outline.missing)}`);
    }),
  );

  server.registerTool(
    'get_section',
    {
      title: 'Read one section',
      description: 'Returns the LaTeX of one section (up to the next heading of the same or higher level), found by title anywhere in the document.',
      inputSchema: {
        project,
        title: z.string().min(1).describe('Section title, matched case-insensitively (exact first, then unique partial match)'),
        file: z.string().optional().describe('Look only in this file'),
      },
      annotations: readOnly,
    },
    guard(logger, 'get_section', async (args) => {
      const { project: resolved, file, slice } = await service.section(args.project, args.title, { file: args.file });
      return text(`[${slice.heading.type}] "${slice.heading.title}" — ${file} lines ${slice.startLine}-${slice.endLine} in ${projectLabel(resolved)}\n\n${slice.content}`);
    }),
  );

  const editSchema = z.object({
    oldText: z.string().min(1).describe('Exact existing text to replace (copy it from read_file; must be unique unless replaceAll)'),
    newText: z.string().describe('Replacement text'),
    replaceAll: z.boolean().optional(),
  });

  server.registerTool(
    'edit_file',
    {
      title: 'Edit a file',
      description:
        'Applies exact search-and-replace edits to a file, live: collaborators see the change instantly and concurrent typing is merged, not overwritten. All edits apply together or not at all. With suggest=true the edits become tracked changes the author can accept or reject in Overleaf\'s review panel.',
      inputSchema: {
        project,
        path: z.string(),
        edits: z.array(editSchema).min(1).describe('Applied in order, each to the result of the previous one'),
        suggest: z.boolean().optional().describe('Record as tracked changes (suggestions) instead of direct edits'),
        dryRun: z.boolean().optional().describe('Show the diff without changing anything'),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    guard(logger, 'edit_file', async (args) => {
      const { project: resolved, result, replacements, diff } = await service.editFile(args.project, args.path, args.edits, { dryRun: args.dryRun, suggest: args.suggest });
      const stats = diffStats(result.before, result.after);
      const verb = args.dryRun ? 'Would change' : args.suggest ? 'Suggested changes to' : 'Edited';
      const version = result.version !== undefined && !args.dryRun ? `, now at version ${result.version}` : '';
      return text(`${verb} ${result.path} in ${projectLabel(resolved)}: ${replacements} replacement(s), +${stats.added}/-${stats.removed} lines${version}.\n\n${diff}`);
    }),
  );

  server.registerTool(
    'write_file',
    {
      title: 'Create or overwrite a file',
      description:
        'Writes the full content of a text file, creating it (and missing folders) if needed. Existing docs are updated in place via a minimal live diff, so collaborators keep their cursors. Prefer edit_file for small changes.',
      inputSchema: {
        project,
        path: z.string(),
        content: z.string(),
        overwrite: z.boolean().optional().describe('Set false to refuse replacing an existing file (default true)'),
        suggest: z.boolean().optional().describe('Record changes to an existing doc as tracked changes'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    guard(logger, 'write_file', async (args) => {
      const { project: resolved, result, diff } = await service.writeFile(args.project, args.path, args.content, { overwrite: args.overwrite, suggest: args.suggest });
      if (result.created) return text(`Created ${result.path} in ${projectLabel(resolved)} (${result.after.split('\n').length} lines).`);
      if (!result.changed) return text(`${result.path} already had exactly this content; nothing changed.`);
      const stats = diffStats(result.before, result.after);
      return text(`Updated ${result.path} in ${projectLabel(resolved)}: +${stats.added}/-${stats.removed} lines.\n\n${diff}`);
    }),
  );

  server.registerTool(
    'delete_file',
    {
      title: 'Delete a file or folder',
      description: 'Deletes a file or folder (with its contents) from a project. Overleaf keeps it in project history.',
      inputSchema: { project, path: z.string() },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    guard(logger, 'delete_file', async (args) => {
      const resolved = await service.deleteFile(args.project, args.path);
      return text(`Deleted ${args.path} from ${projectLabel(resolved)}.`);
    }),
  );

  server.registerTool(
    'move_file',
    {
      title: 'Move or rename',
      description: 'Moves and/or renames a file or folder inside a project, creating target folders as needed.',
      inputSchema: { project, from: z.string(), to: z.string() },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    guard(logger, 'move_file', async (args) => {
      const resolved = await service.moveFile(args.project, args.from, args.to);
      return text(`Moved ${args.from} → ${args.to} in ${projectLabel(resolved)}.`);
    }),
  );

  server.registerTool(
    'create_folder',
    {
      title: 'Create a folder',
      description: 'Creates a folder (and any missing parents) in a project.',
      inputSchema: { project, path: z.string() },
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    guard(logger, 'create_folder', async (args) => {
      const resolved = await service.createFolder(args.project, args.path);
      return text(`Folder ${args.path} exists in ${projectLabel(resolved)}.`);
    }),
  );

  server.registerTool(
    'upload_file',
    {
      title: 'Upload a local file',
      description: 'Uploads a file from this computer (e.g. a generated figure or .bib) into a project, replacing any file with the same path.',
      inputSchema: {
        project,
        localPath: z.string().describe('Absolute path of the file on this computer'),
        path: z.string().optional().describe('Destination path in the project (default: the file name in the root folder)'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    guard(logger, 'upload_file', async (args) => {
      const data = await fs.readFile(path.resolve(args.localPath));
      const destination = args.path ?? path.basename(args.localPath);
      const { project: resolved, path: filePath } = await service.uploadFile(args.project, destination, data);
      return text(`Uploaded ${args.localPath} to ${filePath} in ${projectLabel(resolved)} (${data.byteLength} bytes).`);
    }),
  );

  server.registerTool(
    'download_file',
    {
      title: 'Download a project file',
      description: 'Saves a project file (any type) to a path on this computer.',
      inputSchema: {
        project,
        path: z.string(),
        localPath: z.string().describe('Absolute destination path on this computer'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guard(logger, 'download_file', async (args) => {
      const { project: resolved, path: filePath, data } = await service.readBinaryFile(args.project, args.path);
      const destination = path.resolve(args.localPath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, data);
      return text(`Saved ${filePath} from ${projectLabel(resolved)} to ${destination} (${data.byteLength} bytes).`);
    }),
  );

  server.registerTool(
    'compile',
    {
      title: 'Compile with Overleaf',
      description:
        'Compiles the project on Overleaf\'s servers and reports LaTeX errors and warnings with file:line, so they can be fixed with edit_file. Optionally saves the PDF locally.',
      inputSchema: {
        project,
        rootFile: z.string().optional().describe('Compile this file instead of the main document'),
        draft: z.boolean().optional().describe('Faster draft mode (no images)'),
        stopOnFirstError: z.boolean().optional(),
        savePdfTo: z.string().optional().describe('Absolute local path to save output.pdf to'),
        maxWarnings: z.number().int().min(0).max(200).optional().describe('Default 15'),
      },
      // Not read-only: savePdfTo writes a file on this computer.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(logger, 'compile', async (args) => {
      const result = await service.compile(args.project, args);
      const { log, bibtex } = result;
      const lines = [`Compile of ${projectLabel(result.project)}: ${result.status}${log.pages !== undefined ? `, ${log.pages} page(s)` : ''}.`];
      const errors = [...log.errors, ...bibtex.filter((e) => e.level === 'error')];
      const warnings = [...log.warnings, ...bibtex.filter((e) => e.level === 'warning')];
      if (errors.length) lines.push(`\nErrors (${errors.length}):\n${formatLogEntries(errors, 30)}`);
      if (warnings.length) lines.push(`\nWarnings (${warnings.length}${warnings.length > (args.maxWarnings ?? 15) ? `, first ${args.maxWarnings ?? 15}` : ''}):\n${formatLogEntries(warnings, args.maxWarnings ?? 15)}`);
      if (log.typesetting.length) lines.push(`\n${log.typesetting.length} overfull/underfull box warning(s).`);
      if (result.status === 'too-recently-compiled') lines.push('Overleaf compiled this project moments ago; wait a second and retry.');
      if (result.logTail) lines.push(`\nEnd of the log:\n${result.logTail}`);
      if (result.pdfPath) lines.push(`\nPDF saved to ${result.pdfPath}`);
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'history',
    {
      title: 'Project history',
      description: 'Recent changes recorded in Overleaf\'s project history: versions, authors, times and touched files. Use history_diff to see what changed between versions.',
      inputSchema: {
        project,
        limit: z.number().int().min(1).max(200).optional().describe('Default 20'),
        path: z.string().optional().describe('Only changes touching this file'),
      },
      annotations: readOnly,
    },
    guard(logger, 'history', async (args) => {
      const { project: resolved, updates } = await service.history(args.project, args);
      return text(`History of ${projectLabel(resolved)} (newest first):\n${formatHistory(updates)}`);
    }),
  );

  server.registerTool(
    'history_diff',
    {
      title: 'Diff between versions',
      description: 'Unified diff of one file between two history versions (from the history tool\'s vFrom→vTo numbers).',
      inputSchema: {
        project,
        path: z.string(),
        fromVersion: z.number().int().min(0),
        toVersion: z.number().int().min(0),
      },
      annotations: readOnly,
    },
    guard(logger, 'history_diff', async (args) => {
      const { project: resolved, diff, binary } = await service.historyDiff(args.project, args.path, args.fromVersion, args.toVersion);
      if (binary) return text(`${args.path} is a binary file; no text diff available.`);
      return text(diff ? `${args.path} in ${projectLabel(resolved)}, v${args.fromVersion}→v${args.toVersion}:\n\n${diff}` : 'No changes between these versions.');
    }),
  );
}

export const SERVER_INSTRUCTIONS = `Tools for the user's Overleaf (LaTeX) projects, connected live to overleaf.com or a self-hosted Overleaf.
- Find projects with list_projects; refer to them by name or id. If exactly one project is pinned, "project" can be omitted.
- Explore with list_files, get_outline, get_section and read_file. grep finds exact text or regexes across projects; search ranks passages by topic.
- Edit with edit_file (exact oldText → newText; copy oldText from read_file without line numbers). Edits are live and merge with collaborators' typing.
- Use suggest=true when the author should review changes: they appear as tracked changes in Overleaf.
- Overleaf documents cannot contain emoji or other non-BMP characters.
- A project marked "synced to local folder" can also be edited through those local files; the sync pushes them.
- After editing LaTeX, compile reports errors with file:line so they can be fixed.`;
