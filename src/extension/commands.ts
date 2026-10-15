import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LogEntry } from '../core/latex/logParser';
import { OverleafService } from '../core/service';
import { DataPaths } from '../core/store/paths';
import { errorMessage } from '../core/util/errors';
import { Logger } from '../core/util/log';
import { AuthManager } from './auth';
import { connectClient } from './clientSetup';
import { McpEndpoint } from './mcp';
import { MirrorManager } from './mirrors';
import { overleafUri, parseOverleafUri } from './overleafFs';
import { EntryNode, Node, ProjectNode, ProjectsView } from './projectsView';

export interface CommandContext {
  context: vscode.ExtensionContext;
  service: OverleafService;
  auth: AuthManager;
  view: ProjectsView;
  endpoint: McpEndpoint;
  mirrors: MirrorManager;
  paths: DataPaths;
  serverPath: () => string | undefined;
  logger: Logger;
}

async function pickProject(service: OverleafService, placeHolder = 'Choose a project'): Promise<{ id: string; name: string } | undefined> {
  const projects = await service.listProjects();
  const picked = await vscode.window.showQuickPick(
    projects.map((p) => ({ label: `${p.pinned ? '$(pinned) ' : ''}${p.name}`, description: p.id, project: p })),
    { placeHolder, matchOnDescription: true },
  );
  return picked?.project;
}

function projectOf(node?: Node): { id: string; name: string } | undefined {
  if (node instanceof ProjectNode) return node.project;
  if (node instanceof EntryNode) return { id: node.projectId, name: node.projectName };
  return undefined;
}

/** Folder that new files go into, given the node that was right-clicked. */
function targetFolder(node?: Node): string {
  if (node instanceof EntryNode) {
    if (node.entry.type === 'folder') return node.entry.path;
    const slash = node.entry.path.lastIndexOf('/');
    return slash === -1 ? '' : node.entry.path.slice(0, slash);
  }
  return '';
}

function validName(value: string): string | undefined {
  if (!value.trim()) return 'Enter a name';
  if (/[\\]/.test(value) || value.split('/').some((p) => p === '..')) return 'Use forward slashes and no ".."';
  return undefined;
}

export function registerCommands(ctx: CommandContext): vscode.DiagnosticCollection {
  const { context, service, auth, view, endpoint, mirrors, paths, logger } = ctx;
  const diagnostics = vscode.languages.createDiagnosticCollection('overleaf');
  const register = (id: string, handler: (...args: never[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: never[]) => {
        try {
          await handler(...args);
        } catch (error) {
          logger.error(`Command ${id} failed`, error);
          vscode.window.showErrorMessage(errorMessage(error));
        }
      }),
    );

  register('overleafMcp.signIn', () => auth.signIn());
  register('overleafMcp.signOut', () => auth.signOut());
  register('overleafMcp.changeServer', async () => {
    if ((await auth.changeServer()) && auth.current?.serverUrl !== auth.serverUrl) await auth.signIn();
  });
  register('overleafMcp.refresh', () => view.refresh());
  register('overleafMcp.filter', async () => {
    const text = await vscode.window.showInputBox({ title: 'Filter projects by name', value: view.filterText });
    if (text !== undefined) view.setFilter(text);
  });
  register('overleafMcp.clearFilter', () => view.setFilter(''));

  const setPinned = async (node: Node | undefined, pinned: boolean) => {
    const project = projectOf(node) ?? (await pickProject(service, pinned ? 'Pin which project for AI tools?' : 'Unpin which project?'));
    if (!project) return;
    await service.setPinned([project.id], pinned);
    view.refresh();
  };
  register('overleafMcp.pinProject', (node?: Node) => setPinned(node, true));
  register('overleafMcp.unpinProject', (node?: Node) => setPinned(node, false));

  register('overleafMcp.openInBrowser', async (node?: Node) => {
    const project = projectOf(node) ?? (await pickProject(service));
    if (project) await vscode.env.openExternal(vscode.Uri.parse(`${auth.current?.serverUrl ?? auth.serverUrl}/project/${project.id}`));
  });
  register('overleafMcp.copyProjectId', async (node?: Node) => {
    const project = projectOf(node) ?? (await pickProject(service));
    if (!project) return;
    await vscode.env.clipboard.writeText(project.id);
    vscode.window.setStatusBarMessage(`Copied the id of "${project.name}"`, 3000);
  });

  register('overleafMcp.newProject', async () => {
    const name = await vscode.window.showInputBox({ title: 'New Overleaf project', prompt: 'Project name', validateInput: (v) => (v.trim() ? undefined : 'Enter a name') });
    if (!name) return;
    const template = await vscode.window.showQuickPick([{ label: 'Blank project', id: 'none' as const }, { label: 'Example project', id: 'example' as const }], { title: 'Start from' });
    if (!template) return;
    const created = await service.createProject(name.trim(), template.id);
    view.refresh();
    const open = await vscode.window.showInformationMessage(`Created "${created.name}".`, 'Open main.tex');
    if (open) await vscode.window.showTextDocument(overleafUri(created.id, 'main.tex'));
  });

  register('overleafMcp.newFile', async (node?: Node) => {
    const project = projectOf(node) ?? (await pickProject(service));
    if (!project) return;
    const folder = targetFolder(node);
    const name = await vscode.window.showInputBox({ title: `New file in ${project.name}${folder ? `/${folder}` : ''}`, value: 'section.tex', validateInput: validName });
    if (!name) return;
    const uri = overleafUri(project.id, folder ? `${folder}/${name}` : name);
    await vscode.workspace.fs.writeFile(uri, new Uint8Array());
    await vscode.window.showTextDocument(uri);
  });
  register('overleafMcp.newFolder', async (node?: Node) => {
    const project = projectOf(node) ?? (await pickProject(service));
    if (!project) return;
    const folder = targetFolder(node);
    const name = await vscode.window.showInputBox({ title: `New folder in ${project.name}${folder ? `/${folder}` : ''}`, validateInput: validName });
    if (name) await vscode.workspace.fs.createDirectory(overleafUri(project.id, folder ? `${folder}/${name}` : name));
  });
  register('overleafMcp.uploadFiles', async (node?: Node) => {
    const project = projectOf(node) ?? (await pickProject(service));
    if (!project) return;
    const files = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Upload to Overleaf' });
    if (!files?.length) return;
    const folder = targetFolder(node);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Uploading to ${project.name}` }, async (progress) => {
      for (const file of files) {
        progress.report({ message: path.basename(file.fsPath) });
        const name = path.basename(file.fsPath);
        await service.uploadFile(project.id, folder ? `${folder}/${name}` : name, await fs.readFile(file.fsPath));
      }
    });
  });
  register('overleafMcp.rename', async (node?: EntryNode) => {
    if (!(node instanceof EntryNode)) return;
    const current = node.entry.path;
    const target = await vscode.window.showInputBox({ title: `Rename or move ${current}`, value: current, validateInput: validName });
    if (!target || target === current) return;
    await vscode.workspace.fs.rename(overleafUri(node.projectId, current), overleafUri(node.projectId, target));
  });
  register('overleafMcp.delete', async (node?: EntryNode) => {
    if (!(node instanceof EntryNode)) return;
    const confirm = await vscode.window.showWarningMessage(
      `Delete ${node.entry.path} from "${node.projectName}"? It stays recoverable in Overleaf's history.`,
      { modal: true },
      'Delete',
    );
    if (confirm) await vscode.workspace.fs.delete(overleafUri(node.projectId, node.entry.path), { recursive: true });
  });
  register('overleafMcp.download', async (node?: EntryNode) => {
    if (!(node instanceof EntryNode) || node.entry.type === 'folder') return;
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(os.homedir(), path.basename(node.entry.path))) });
    if (!target) return;
    const { data } = await service.readBinaryFile(node.projectId, node.entry.path);
    await fs.writeFile(target.fsPath, data);
  });

  register('overleafMcp.compile', async (node?: Node) => {
    const editorUri = vscode.window.activeTextEditor?.document.uri;
    const project =
      projectOf(node) ??
      (editorUri?.scheme === 'overleaf' ? { id: parseOverleafUri(editorUri).projectId, name: parseOverleafUri(editorUri).projectId } : undefined) ??
      (await pickProject(service, 'Compile which project?'));
    if (!project) return;
    const pdfPath = path.join(os.tmpdir(), 'overleaf-mcp', `${project.id}.pdf`);
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Compiling ${project.name}…` }, () =>
      service.compile(project.id, { savePdfTo: pdfPath }),
    );
    const byFile = new Map<string, vscode.Diagnostic[]>();
    const add = (entry: LogEntry, severity: vscode.DiagnosticSeverity) => {
      if (!entry.file) return;
      const line = Math.max(0, (entry.line ?? 1) - 1);
      const diagnostic = new vscode.Diagnostic(new vscode.Range(line, 0, line, 1000), entry.message, severity);
      diagnostic.source = 'Overleaf';
      const key = overleafUri(project.id, entry.file).toString();
      byFile.set(key, [...(byFile.get(key) ?? []), diagnostic]);
    };
    for (const entry of [...result.log.errors, ...result.bibtex.filter((e) => e.level === 'error')]) add(entry, vscode.DiagnosticSeverity.Error);
    for (const entry of [...result.log.warnings, ...result.bibtex.filter((e) => e.level === 'warning')]) add(entry, vscode.DiagnosticSeverity.Warning);
    for (const entry of result.log.typesetting) add(entry, vscode.DiagnosticSeverity.Information);
    for (const [uri] of diagnostics) if (parseOverleafUri(uri).projectId === project.id) diagnostics.delete(uri);
    for (const [uri, list] of byFile) diagnostics.set(vscode.Uri.parse(uri), list);

    const summary = `${result.project.name}: ${result.status} — ${result.log.errors.length} error(s), ${result.log.warnings.length} warning(s)`;
    const actions = result.pdfPath ? ['Open PDF', 'Show Problems'] : ['Show Problems'];
    const choice = await (result.log.errors.length || result.status !== 'success' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(summary, ...actions);
    if (choice === 'Open PDF' && result.pdfPath) await vscode.env.openExternal(vscode.Uri.file(result.pdfPath));
    if (choice === 'Show Problems') await vscode.commands.executeCommand('workbench.actions.view.problems');
  });

  register('overleafMcp.search', async () => {
    const query = await vscode.window.showInputBox({ title: 'Search Overleaf projects', prompt: 'Exact text across pinned projects (all projects if none are pinned)' });
    if (!query) return;
    const { result, notes } = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Searching for "${query}"…` }, () =>
      service.grep({ query, maxResults: 500 }),
    );
    if (notes.length) logger.info(notes.join(' '));
    if (!result.matches.length) {
      vscode.window.showInformationMessage(`No matches for "${query}".`);
      return;
    }
    const picked = await vscode.window.showQuickPick(
      result.matches.map((m) => ({ label: m.text.trim() || '(blank line)', description: `${m.projectName} · ${m.file}:${m.line}`, match: m })),
      { title: `${result.matches.length}${result.truncated ? '+' : ''} matches for "${query}"`, matchOnDescription: true },
    );
    if (!picked) return;
    const position = new vscode.Position(picked.match.line - 1, picked.match.column - 1);
    await vscode.window.showTextDocument(overleafUri(picked.match.projectId, picked.match.file), { selection: new vscode.Range(position, position) });
  });

  register('overleafMcp.syncToFolder', async (node?: Node) => {
    const project = projectOf(node) ?? (await pickProject(service, 'Sync which project to a local folder?'));
    if (project) await mirrors.startSync(project);
  });
  register('overleafMcp.stopSync', async (node?: Node) => {
    const project = projectOf(node);
    if (!project) return mirrors.showMenu();
    const confirm = await vscode.window.showInformationMessage(`Stop syncing "${project.name}"? The local folder stays as it is.`, 'Stop Syncing');
    if (confirm) await mirrors.stopSync(project.id);
  });
  register('overleafMcp.syncNow', async (node?: Node) => {
    const project = projectOf(node);
    if (!project) return mirrors.showMenu();
    const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Syncing ${project.name}…` }, () => mirrors.syncNow(project.id));
    if (!report) vscode.window.showInformationMessage(`"${project.name}" is being synced by another VS Code window.`);
  });
  register('overleafMcp.openMirrorFolder', async (node?: Node) => {
    const project = projectOf(node);
    const dir = project && (await mirrors.dirOf(project.id));
    if (dir) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir), { forceNewWindow: true });
  });
  register('overleafMcp.syncMenu', () => mirrors.showMenu());

  register('overleafMcp.connectClient', async () => {
    const serverPath = ctx.serverPath();
    if (!serverPath) throw new Error('The MCP server is still being installed; try again in a moment.');
    await connectClient(endpoint, paths, serverPath);
  });

  register('overleafMcp.showMcpInfo', async () => {
    const states: Record<string, string> = {
      hosting: `running in this window at ${endpoint.url}`,
      shared: `running in another VS Code window at ${endpoint.url}`,
      'port-busy': `off: port ${endpoint.port} is used by another program`,
      off: 'off',
    };
    const choice = await vscode.window.showInformationMessage(
      `Overleaf MCP — HTTP endpoint ${states[endpoint.state]}. Stdio server: ${ctx.serverPath() ?? 'installing…'}`,
      'Connect AI Client…',
      'Copy Endpoint URL',
      'Copy Token',
    );
    if (choice === 'Connect AI Client…') await vscode.commands.executeCommand('overleafMcp.connectClient');
    if (choice === 'Copy Endpoint URL') await vscode.env.clipboard.writeText(endpoint.url);
    if (choice === 'Copy Token') await vscode.env.clipboard.writeText(endpoint.token);
  });

  register('overleafMcp.accountMenu', async () => {
    if (!auth.current) return auth.signIn();
    const picked = await vscode.window.showQuickPick(
      [
        { label: '$(plug) Connect an AI client…', id: 'connect' },
        { label: '$(search) Search projects…', id: 'search' },
        { label: '$(info) MCP connection details', id: 'info' },
        { label: '$(server) Change Overleaf server…', id: 'server' },
        { label: '$(gear) Settings', id: 'settings' },
        { label: '$(sign-out) Sign out', id: 'signout' },
      ],
      { title: `Overleaf: ${auth.current.email ?? auth.current.userId} on ${new URL(auth.current.serverUrl).host}` },
    );
    const commands: Record<string, string> = {
      connect: 'overleafMcp.connectClient',
      search: 'overleafMcp.search',
      info: 'overleafMcp.showMcpInfo',
      server: 'overleafMcp.changeServer',
      settings: 'overleafMcp.openSettings',
      signout: 'overleafMcp.signOut',
    };
    if (picked) await vscode.commands.executeCommand(commands[picked.id]);
  });
  register('overleafMcp.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:ghoshsrinjoy.overleaf-mcp'));

  context.subscriptions.push(diagnostics);
  return diagnostics;
}
