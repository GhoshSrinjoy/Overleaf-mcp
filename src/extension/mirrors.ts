import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { folderProblem, safeFolderName } from '../core/mirror/folders';
import { MirrorLease } from '../core/mirror/lease';
import { MirrorStatus, ProjectMirror, SyncReport } from '../core/mirror/mirror';
import { OverleafService } from '../core/service';
import { errorMessage } from '../core/util/errors';
import { Logger } from '../core/util/log';
import { config } from './auth';

interface Running {
  mirror: ProjectMirror;
  lease: MirrorLease;
  name: string;
}

/** Two-way sync of projects with local folders, so local tools (LaTeX Workshop, git, AI file edits) work on real files. */
export class MirrorManager implements vscode.Disposable {
  private readonly running = new Map<string, Running>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly pushed = new vscode.EventEmitter<string>();
  /** Local edits of a project were sent to Overleaf (fires with the project id). */
  readonly onDidPushLocalChanges = this.pushed.event;
  private readonly status: vscode.StatusBarItem;
  private readonly holder = `vscode-${vscode.env.sessionId}`;

  constructor(
    private readonly service: OverleafService,
    private readonly logger: Logger,
  ) {
    this.status = vscode.window.createStatusBarItem('overleafMcp.sync', vscode.StatusBarAlignment.Left, 19);
    this.status.name = 'Overleaf Sync';
    this.status.command = 'overleafMcp.syncMenu';
  }

  /** Local folder a project is synced to (recorded in shared settings), if any. */
  async dirOf(projectId: string): Promise<string | undefined> {
    return (await this.service.settings.read()).mirrors?.find((m) => m.projectId === projectId)?.dir;
  }

  /** The synced project a local file belongs to, with its project path. */
  async projectOfFile(fsPath: string): Promise<{ projectId: string; dir: string; path: string } | undefined> {
    const fold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
    for (const mirror of (await this.service.settings.read()).mirrors ?? []) {
      const relative = path.relative(mirror.dir, fsPath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
      if (fold(path.join(mirror.dir, relative)) !== fold(path.resolve(fsPath))) continue;
      return { projectId: mirror.projectId, dir: mirror.dir, path: relative.split(path.sep).join('/') };
    }
    return undefined;
  }

  isRunning(projectId: string): boolean {
    return this.running.has(projectId);
  }

  private updateStatusBar(): void {
    const states = [...this.running.values()].map((r) => ({ name: r.name, status: r.mirror.status, dir: r.mirror.dir }));
    if (!states.length) {
      this.status.hide();
      return;
    }
    const syncing = states.some((s) => s.status.state === 'syncing' || s.status.state === 'starting');
    const problem = states.some((s) => s.status.state === 'error' || s.status.conflicts.length);
    this.status.text = `${problem ? '$(warning)' : syncing ? '$(sync~spin)' : '$(sync)'} ${states.length === 1 ? states[0].name : `${states.length} projects`}`;
    this.status.tooltip = states
      .map((s) => `${s.name} ⇄ ${s.dir}\n  ${s.status.state}${s.status.lastSync ? `, last sync ${new Date(s.status.lastSync).toLocaleTimeString()}` : ''}${s.status.conflicts.length ? `, conflicts: ${s.status.conflicts.join(', ')}` : ''}${s.status.error ? `, ${s.status.error}` : ''}`)
      .join('\n');
    this.status.show();
  }

  private async remember(projectId: string, dir: string | undefined): Promise<void> {
    await this.service.settings.update((settings) => {
      const mirrors = (settings.mirrors ?? []).filter((m) => m.projectId !== projectId);
      if (dir) mirrors.push({ projectId, dir });
      return { ...settings, mirrors };
    });
    this.changed.fire();
  }

  private async chooseFolder(name: string): Promise<string | undefined> {
    const suggested = path.join(config().get<string>('mirror.defaultParent') || path.join(os.homedir(), 'Overleaf'), safeFolderName(name));
    const picked = await vscode.window.showQuickPick(
      [
        { label: `$(folder) ${suggested}`, description: 'Recommended', dir: suggested },
        { label: '$(folder-opened) Choose another empty folder…', dir: '' },
      ],
      { title: `Where should "${name}" be synced on this computer?` },
    );
    if (!picked) return undefined;
    if (picked.dir) return picked.dir;
    const chosen = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Sync Here' });
    return chosen?.[0]?.fsPath;
  }

  async startSync(project: { id: string; name: string }): Promise<void> {
    const existing = await this.dirOf(project.id);
    if (existing && this.running.has(project.id)) {
      vscode.window.showInformationMessage(`"${project.name}" is already synced with ${existing}.`);
      return;
    }
    const dir = existing ?? (await this.chooseFolder(project.name));
    if (!dir) return;
    const problem = await folderProblem(dir, project.id);
    if (problem) {
      vscode.window.showErrorMessage(`Can't sync into ${dir}: ${problem}. Choose a new or empty folder.`);
      return;
    }
    const started = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Syncing "${project.name}" to ${dir}…` }, () =>
      this.run(project.id, project.name, dir),
    );
    if (!started) return;
    await this.remember(project.id, dir);
    const action = await vscode.window.showInformationMessage(
      `"${project.name}" is synced with ${dir}. Edits on either side now sync automatically.`,
      'Open Folder',
      'Add to Workspace',
    );
    if (action === 'Open Folder') await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir), { forceNewWindow: true });
    if (action === 'Add to Workspace') vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: vscode.Uri.file(dir), name: `${project.name} (Overleaf)` });
  }

  private async run(projectId: string, name: string, dir: string): Promise<boolean> {
    if (this.running.has(projectId)) return true;
    await fs.mkdir(dir, { recursive: true });
    const lease = new MirrorLease(dir, this.holder);
    if (!(await lease.acquire())) {
      // Another VS Code window (or the CLI) is syncing this folder; take over if it stops.
      this.retryLater(projectId, name, dir);
      return true;
    }
    const mirror = new ProjectMirror({
      service: this.service,
      projectId,
      dir,
      logger: this.logger,
      onStatus: (status) => this.onStatus(projectId, status),
      onReport: (report) => this.onReport(projectId, name, dir, report),
    });
    this.running.set(projectId, { mirror, lease, name });
    try {
      await mirror.start();
      this.updateStatusBar();
      this.changed.fire();
      return true;
    } catch (error) {
      this.running.delete(projectId);
      await mirror.stop().catch(() => undefined);
      await lease.release();
      this.logger.error(`Could not sync "${name}"`, error);
      vscode.window.showErrorMessage(`Could not sync "${name}" with ${dir}: ${errorMessage(error)}`);
      return false;
    }
  }

  private retryLater(projectId: string, name: string, dir: string): void {
    clearTimeout(this.retryTimers.get(projectId));
    this.retryTimers.set(
      projectId,
      setTimeout(() => {
        this.retryTimers.delete(projectId);
        void this.run(projectId, name, dir);
      }, 40_000),
    );
  }

  private onStatus(_projectId: string, _status: MirrorStatus): void {
    this.updateStatusBar();
  }

  private onReport(projectId: string, name: string, dir: string, report: SyncReport): void {
    const moved = [...report.pulled, ...report.pushed, ...report.merged, ...report.deletedLocal, ...report.deletedRemote];
    if (report.pushed.length || report.merged.length || report.deletedLocal.length) this.pushed.fire(projectId);
    if (moved.length) vscode.window.setStatusBarMessage(`$(sync) ${name}: synced ${moved.slice(0, 3).join(', ')}${moved.length > 3 ? ` +${moved.length - 3}` : ''}`, 4000);
    for (const file of report.conflicts) {
      void vscode.window
        .showWarningMessage(`Overleaf sync conflict in ${name}/${file}: both sides changed the same lines. Resolve the <<<<<<< markers and save.`, 'Open File')
        .then((choice) => {
          if (choice) void vscode.window.showTextDocument(vscode.Uri.file(path.join(dir, file)));
        });
    }
    if (report.failed.length) {
      vscode.window.showErrorMessage(`Overleaf sync of ${name} could not sync: ${report.failed.map((f) => `${f.path} (${f.error})`).join('; ')}`);
    }
  }

  async stopSync(projectId: string, forget = true): Promise<void> {
    clearTimeout(this.retryTimers.get(projectId));
    this.retryTimers.delete(projectId);
    const running = this.running.get(projectId);
    if (running) {
      this.running.delete(projectId);
      await running.mirror.stop();
      await running.lease.release();
    }
    if (forget) await this.remember(projectId, undefined);
    this.updateStatusBar();
    this.changed.fire();
  }

  async syncNow(projectId: string): Promise<SyncReport | undefined> {
    const running = this.running.get(projectId);
    return running ? running.mirror.syncNow() : undefined;
  }

  /** Restarts the mirrors recorded in settings (e.g. after VS Code starts or the person signs in). */
  async resumeAll(): Promise<void> {
    if (!config().get<boolean>('mirror.autoStart', true)) return;
    const mirrors = (await this.service.settings.read(0)).mirrors ?? [];
    if (!mirrors.length) return;
    const projects = await this.service.listProjects({ includeArchived: true }).catch(() => []);
    for (const { projectId, dir } of mirrors) {
      const name = projects.find((p) => p.id === projectId)?.name ?? projectId;
      try {
        await fs.access(dir);
      } catch {
        this.logger.warn(`Synced folder ${dir} no longer exists; not resuming "${name}"`);
        continue;
      }
      void this.run(projectId, name, dir);
    }
  }

  async stopAll(): Promise<void> {
    for (const projectId of [...this.running.keys(), ...this.retryTimers.keys()]) await this.stopSync(projectId, false);
  }

  async showMenu(): Promise<void> {
    const items = await Promise.all(
      [...this.running.entries()].map(async ([projectId, r]) => ({ label: r.name, description: `${r.mirror.status.state} · ${r.mirror.dir}`, projectId })),
    );
    if (!items.length) {
      vscode.window.showInformationMessage('No projects are synced to local folders. Right-click a project in the Overleaf panel and choose "Sync to Local Folder…".');
      return;
    }
    const picked = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { title: 'Synced Overleaf projects' });
    if (!picked) return;
    const action = await vscode.window.showQuickPick(['Sync Now', 'Open Folder', 'Stop Syncing'], { title: picked.label });
    if (action === 'Sync Now') await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Syncing ${picked.label}…` }, () => this.syncNow(picked.projectId));
    if (action === 'Open Folder') await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(this.running.get(picked.projectId)!.mirror.dir), { forceNewWindow: true });
    if (action === 'Stop Syncing') await this.stopSync(picked.projectId);
  }

  dispose(): void {
    void this.stopAll();
    this.status.dispose();
    this.changed.dispose();
    this.pushed.dispose();
  }
}
