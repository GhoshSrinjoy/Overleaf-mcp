import * as vscode from 'vscode';
import { FileEntry } from '../core/backends/types';
import { ProjectInfo, OverleafService } from '../core/service';
import { errorMessage } from '../core/util/errors';
import { Logger } from '../core/util/log';
import { AuthManager, config } from './auth';
import { overleafUri } from './overleafFs';

export class ProjectNode {
  readonly kind = 'project';
  constructor(readonly project: ProjectInfo) {}
}

export class EntryNode {
  readonly kind = 'entry';
  constructor(
    readonly projectId: string,
    readonly projectName: string,
    readonly entry: FileEntry,
    readonly isRootDoc: boolean,
  ) {}
}

class MessageNode {
  readonly kind = 'message';
  constructor(
    readonly label: string,
    readonly icon = 'info',
    readonly command?: vscode.Command,
  ) {}
}

export type Node = ProjectNode | EntryNode | MessageNode;

function relativeTime(iso?: string): string {
  if (!iso) return '';
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return '';
  const steps: Array<[number, string]> = [[60, 's'], [60, 'm'], [24, 'h'], [30, 'd'], [12, 'mo']];
  let value = seconds;
  for (const [size, unit] of steps) {
    if (Math.abs(value) < size) return `${value}${unit} ago`;
    value = Math.floor(value / size);
  }
  return `${value}y ago`;
}

function personName(user?: { email?: string; firstName?: string; lastName?: string } | null): string | undefined {
  if (!user) return undefined;
  return [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;
}

/** The "Projects" side panel: every project in the account, expandable into its live file tree. */
export class ProjectsView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private filter = '';
  private trees = new Map<string, { entries: FileEntry[]; rootDocPath?: string }>();
  private readonly subscriptions = new Map<string, () => void>();
  private projectNodes = new Map<string, ProjectNode>();
  private warnedAboutSession = false;

  constructor(
    private readonly service: OverleafService,
    private readonly auth: AuthManager,
    private readonly logger: Logger,
  ) {}

  get filterText(): string {
    return this.filter;
  }

  setFilter(text: string): void {
    this.filter = text.trim();
    void vscode.commands.executeCommand('setContext', 'overleafMcp.filtered', !!this.filter);
    this.refresh();
  }

  refresh(node?: Node): void {
    if (!node) {
      this.trees.clear();
      for (const unsubscribe of this.subscriptions.values()) unsubscribe();
      this.subscriptions.clear();
    } else if (node instanceof ProjectNode) {
      this.trees.delete(node.project.id);
    }
    this.changed.fire(node);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node instanceof MessageNode) {
      const item = new vscode.TreeItem(node.label);
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.command = node.command;
      return item;
    }
    if (node instanceof ProjectNode) {
      const p = node.project;
      const item = new vscode.TreeItem(p.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `project:${p.id}`;
      const owner = p.accessLevel !== 'owner' ? personName(p.owner) : undefined;
      item.description = [p.localDir && '⇄ local', relativeTime(p.lastUpdated), owner && `by ${owner}`, p.archived && 'archived', p.trashed && 'trashed'].filter(Boolean).join(' · ');
      item.iconPath = new vscode.ThemeIcon(p.pinned ? 'pinned' : p.accessLevel === 'owner' ? 'book' : 'organization');
      item.contextValue = `project${p.pinned ? '.pinned' : ''}${p.localDir ? '.mirrored' : ''}`;
      const tooltip = new vscode.MarkdownString(undefined, true);
      tooltip.appendMarkdown(`**${p.name.replace(/[*_`[\]]/g, '\\$&')}**\n\n`);
      tooltip.appendMarkdown(`- Id: \`${p.id}\`\n- Your access: ${p.accessLevel ?? 'unknown'}\n`);
      if (p.owner) tooltip.appendMarkdown(`- Owner: ${personName(p.owner) ?? ''}\n`);
      if (p.lastUpdated) tooltip.appendMarkdown(`- Updated: ${new Date(p.lastUpdated).toLocaleString()}${p.lastUpdatedBy ? ` by ${personName(p.lastUpdatedBy)}` : ''}\n`);
      if (p.tags.length) tooltip.appendMarkdown(`- Tags: ${p.tags.join(', ')}\n`);
      if (p.localDir) tooltip.appendMarkdown(`- Synced with: \`${p.localDir}\`\n`);
      tooltip.appendMarkdown(p.pinned ? '\n$(pinned) Pinned: AI tools use this project by default.' : '\nPin it to make it the default for AI tools.');
      item.tooltip = tooltip;
      return item;
    }
    const { entry } = node;
    const uri = overleafUri(node.projectId, entry.path);
    const name = entry.path.split('/').pop() ?? entry.path;
    if (entry.type === 'folder') {
      const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `entry:${node.projectId}:${entry.path}`;
      item.label = name;
      item.iconPath = vscode.ThemeIcon.Folder;
      item.contextValue = 'entry.folder';
      return item;
    }
    const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
    item.id = `entry:${node.projectId}:${entry.path}`;
    item.label = name;
    item.iconPath = vscode.ThemeIcon.File;
    item.description = node.isRootDoc ? 'main' : undefined;
    item.contextValue = entry.type === 'doc' ? 'entry.doc' : 'entry.file';
    item.tooltip = `${node.projectName}/${entry.path}${entry.type === 'file' ? ' (uploaded file)' : ''}`;
    item.command = { command: 'vscode.open', title: 'Open', arguments: [uri] };
    return item;
  }

  getParent(node: Node): Node | undefined {
    if (!(node instanceof EntryNode)) return undefined;
    const slash = node.entry.path.lastIndexOf('/');
    if (slash === -1) return this.projectNodes.get(node.projectId);
    const parentPath = node.entry.path.slice(0, slash);
    const tree = this.trees.get(node.projectId);
    const parent = tree?.entries.find((e) => e.path === parentPath);
    return parent ? new EntryNode(node.projectId, node.projectName, parent, false) : undefined;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!this.auth.current) return [];
    try {
      if (!node) return await this.projectList();
      if (node instanceof ProjectNode) return await this.entries(node.project.id, node.project.name, '');
      if (node instanceof EntryNode && node.entry.type === 'folder') return await this.entries(node.projectId, node.projectName, node.entry.path);
      return [];
    } catch (error) {
      this.logger.warn('Could not load the Overleaf tree', error);
      const message = errorMessage(error);
      if (/not signed in|session has expired/i.test(message)) {
        if (!this.warnedAboutSession) {
          this.warnedAboutSession = true;
          void vscode.window.showWarningMessage('Your Overleaf session has expired.', 'Sign In').then((choice) => {
            if (choice) void vscode.commands.executeCommand('overleafMcp.signIn');
          });
        }
        return [new MessageNode('Session expired: sign in again', 'warning', { command: 'overleafMcp.signIn', title: 'Sign In' })];
      }
      return [new MessageNode(`Error: ${message}`, 'error', { command: 'overleafMcp.refresh', title: 'Retry' })];
    }
  }

  private async projectList(): Promise<Node[]> {
    this.warnedAboutSession = false;
    const projects = await this.service.listProjects({
      query: this.filter || undefined,
      includeArchived: config().get<boolean>('projects.showArchived', false),
      includeTrashed: config().get<boolean>('projects.showTrashed', false),
    });
    this.projectNodes = new Map(projects.map((p) => [p.id, new ProjectNode(p)]));
    if (!projects.length) return [new MessageNode(this.filter ? `No projects match "${this.filter}"` : 'No projects yet', 'info')];
    return [...this.projectNodes.values()];
  }

  private async entries(projectId: string, projectName: string, folder: string): Promise<Node[]> {
    let tree = this.trees.get(projectId);
    if (!tree) {
      const { tree: info } = await this.service.listFiles(projectId);
      tree = { entries: info.entries, rootDocPath: info.rootDocPath };
      this.trees.set(projectId, tree);
      this.watch(projectId);
    }
    const prefix = folder ? `${folder}/` : '';
    const children = tree.entries.filter((e) => e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes('/'));
    children.sort((a, b) => Number(b.type === 'folder') - Number(a.type === 'folder') || a.path.localeCompare(b.path));
    if (!children.length && !folder) return [new MessageNode('Empty project', 'info')];
    return children.map((e) => new EntryNode(projectId, projectName, e, e.path === tree!.rootDocPath));
  }

  /** Re-renders a project's files when collaborators (or AI tools) add, remove or rename them. */
  private watch(projectId: string): void {
    if (this.subscriptions.has(projectId)) return;
    void this.service.sessionBackend().then((backend) => {
      if (this.subscriptions.has(projectId)) return;
      let timer: NodeJS.Timeout | undefined;
      const refreshSoon = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const node = this.projectNodes.get(projectId);
          if (node) this.refresh(node);
        }, 300);
      };
      const unsubscribe = backend.pool.subscribe(projectId, { treeChanged: refreshSoon, reconnected: refreshSoon });
      this.subscriptions.set(projectId, unsubscribe);
    });
  }

  findProject(projectId: string): ProjectNode | undefined {
    return this.projectNodes.get(projectId);
  }

  dispose(): void {
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.changed.dispose();
  }
}
