import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LogEntry } from '../core/latex/logParser';
import { safeFolderName } from '../core/mirror/folders';
import { PdfLocation } from '../core/overleaf/types';
import { OverleafService } from '../core/service';
import { errorMessage } from '../core/util/errors';
import { Logger } from '../core/util/log';
import { AuthManager, config } from './auth';
import { CompileController, CompileSnapshot } from './compileController';
import { MirrorManager } from './mirrors';
import { SCHEME, overleafUri, parseOverleafUri } from './overleafFs';
import { previewHtml } from './previewHtml';

export const PREVIEW_VIEW_TYPE = 'overleafMcp.pdfPreview';
const LOG_SCHEME = 'overleaf-log';

export type AutoCompile = 'onChange' | 'onSave' | 'off';

/** The preview's choice when it could not be saved as a setting (see setAutoCompile). */
const AUTO_COMPILE_FALLBACK = 'overleafMcp.pdf.autoCompile';

function asAutoCompile(value: string | undefined): AutoCompile {
  return value === 'onSave' || value === 'off' ? value : 'onChange';
}

/** A position in a project file (line 1-based, column 0-based, as SyncTeX counts). */
export interface SourcePosition {
  projectId: string;
  path: string;
  line: number;
  column: number;
}

interface SavedState {
  projectId?: string;
  projectName?: string;
}

type FromWebview =
  | { type: 'ready' }
  | { type: 'recompile' }
  | { type: 'stop' }
  | { type: 'options'; draft: boolean; stopOnFirstError: boolean }
  | { type: 'autoCompile'; value: AutoCompile }
  | { type: 'syncToCode'; page: number; h: number; v: number }
  | { type: 'open'; file: string; line?: number }
  | { type: 'download' }
  | { type: 'external' }
  | { type: 'log' }
  | { type: 'signIn' }
  | { type: 'rendered'; version: number; pages: number }
  | { type: 'error'; message: string };

class PreviewPanel {
  /** The webview has loaded its script and can take messages. */
  ready = false;
  /** PDF version the webview has been sent. */
  sentVersion = -1;
  /** The project changed while the preview was hidden; recompile when it is shown again. */
  stale = false;
  unwatch?: () => void;
  readonly disposables: vscode.Disposable[] = [];

  constructor(
    readonly projectId: string,
    public projectName: string,
    readonly panel: vscode.WebviewPanel,
  ) {}

  dispose(): void {
    this.unwatch?.();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

function panelTitle(projectName: string): string {
  return `PDF · ${projectName}`;
}

function problem(entry: LogEntry): { level: string; message: string; file?: string; line?: number } {
  return { level: entry.level, message: entry.message, file: entry.file, line: entry.line };
}

/**
 * PDF previews of Overleaf projects inside VS Code: compile and recompile, automatic
 * recompiles when the project changes, errors with links to the source, and SyncTeX in both
 * directions (double-click the PDF to jump to the source; "Show in PDF" from the editor).
 */
export class PdfPreviewManager implements vscode.Disposable, vscode.WebviewPanelSerializer<SavedState> {
  private readonly panels = new Map<string, PreviewPanel>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly logChanged = new vscode.EventEmitter<vscode.Uri>();
  private readonly rendered = new vscode.EventEmitter<{ projectId: string; version: number; pages: number }>();
  /** The webview finished drawing a PDF (used by tests and for diagnostics). */
  readonly onDidRender = this.rendered.event;
  private active?: PreviewPanel;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: OverleafService,
    private readonly auth: AuthManager,
    private readonly compiler: CompileController,
    private readonly mirrors: MirrorManager,
    private readonly logger: Logger,
  ) {
    this.disposables.push(
      this.logChanged,
      this.rendered,
      vscode.window.registerWebviewPanelSerializer(PREVIEW_VIEW_TYPE, this),
      vscode.workspace.registerTextDocumentContentProvider(LOG_SCHEME, {
        onDidChange: this.logChanged.event,
        provideTextDocumentContent: (uri) => this.compiler.get(uri.authority)?.rawLog ?? 'There is no compile log yet.',
      }),
      compiler.onDidChange((snapshot) => {
        const entry = this.panels.get(snapshot.projectId);
        if (entry) this.post(entry);
        if (snapshot.state !== 'compiling') this.logChanged.fire(this.logUri(snapshot.projectId, snapshot.projectName));
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.scheme === SCHEME) this.projectChanged(parseOverleafUri(document.uri).projectId, 'save');
      }),
      // A local copy was saved and the sync sent it to Overleaf.
      mirrors.onDidPushLocalChanges((projectId) => this.projectChanged(projectId, 'save')),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('overleafMcp.pdf')) return;
        // A setting changed by hand replaces a choice the preview had to keep for itself.
        if (event.affectsConfiguration('overleafMcp.pdf.autoCompile')) void this.context.globalState.update(AUTO_COMPILE_FALLBACK, undefined);
        for (const entry of this.panels.values()) this.post(entry);
      }),
    );
  }

  /** When previews recompile by themselves (the `overleafMcp.pdf.autoCompile` setting). */
  autoCompileMode(): AutoCompile {
    return asAutoCompile(this.context.globalState.get<string>(AUTO_COMPILE_FALLBACK) ?? config().get<string>('pdf.autoCompile'));
  }

  async setAutoCompile(value: AutoCompile): Promise<void> {
    try {
      await config().update('pdf.autoCompile', value, vscode.ConfigurationTarget.Global);
      await this.context.globalState.update(AUTO_COMPILE_FALLBACK, undefined);
    } catch (error) {
      // VS Code only learns new settings when the window reloads, so right after an update
      // the setting can't be written yet. Keep the choice here instead.
      this.logger.info(`Keeping the auto-compile choice without the setting: ${errorMessage(error)}`);
      await this.context.globalState.update(AUTO_COMPILE_FALLBACK, value);
    }
    for (const entry of this.panels.values()) this.post(entry);
  }

  /** Project of the preview that has focus, if any. */
  get activeProjectId(): string | undefined {
    return this.active?.panel.active ? this.active.projectId : undefined;
  }

  isOpen(projectId: string): boolean {
    return this.panels.has(projectId);
  }

  private webviewOptions(): vscode.WebviewOptions & vscode.WebviewPanelOptions {
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      enableFindWidget: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
  }

  /** Opens (or reveals) the preview of a project; compiles if there is no PDF yet. */
  async open(project: { id: string; name?: string }, options: { compile?: boolean; focus?: boolean } = {}): Promise<void> {
    let entry = this.panels.get(project.id);
    if (entry) {
      entry.panel.reveal(undefined, !options.focus);
    } else {
      const name = project.name ?? (await this.service.resolveProject(project.id).then((p) => p.name, () => project.id));
      const panel = vscode.window.createWebviewPanel(PREVIEW_VIEW_TYPE, panelTitle(name), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: !options.focus }, this.webviewOptions());
      entry = this.adopt(panel, project.id, name);
    }
    if (!this.auth.current) return;
    const snapshot = this.compiler.get(project.id);
    if (options.compile || !snapshot) void this.compiler.compile(project.id);
  }

  /** Restores a preview after VS Code restarts. */
  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: SavedState | undefined): Promise<void> {
    if (!state?.projectId) {
      panel.dispose();
      return;
    }
    const existing = this.panels.get(state.projectId);
    if (existing) {
      // A preview of this project is already open; keep one.
      panel.dispose();
      return;
    }
    this.adopt(panel, state.projectId, state.projectName ?? state.projectId);
  }

  private adopt(panel: vscode.WebviewPanel, projectId: string, projectName: string): PreviewPanel {
    const entry = new PreviewPanel(projectId, projectName, panel);
    this.panels.set(projectId, entry);
    panel.title = panelTitle(projectName);
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pdf-light.svg'),
      dark: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pdf-dark.svg'),
    };
    panel.webview.options = this.webviewOptions();
    panel.webview.html = this.html(panel.webview, projectId, projectName);
    entry.disposables.push(
      panel.webview.onDidReceiveMessage((message: FromWebview) => void this.onMessage(entry, message)),
      panel.onDidChangeViewState(() => {
        if (panel.active) this.active = entry;
        if (panel.visible && entry.stale) {
          entry.stale = false;
          void this.compiler.compile(projectId);
        }
      }),
      panel.onDidDispose(() => {
        entry.dispose();
        if (this.panels.get(projectId) === entry) this.panels.delete(projectId);
        if (this.active === entry) this.active = undefined;
      }),
    );
    if (panel.active) this.active = entry;
    void this.watch(entry);
    return entry;
  }

  /** Listens for edits to the project (yours, collaborators', AI tools') for automatic recompiles. */
  private async watch(entry: PreviewPanel): Promise<void> {
    entry.unwatch?.();
    entry.unwatch = undefined;
    if (!this.auth.current) return;
    try {
      const backend = await this.service.sessionBackend();
      if (this.panels.get(entry.projectId) !== entry) return;
      const changed = () => this.projectChanged(entry.projectId, 'change');
      entry.unwatch = backend.pool.subscribe(entry.projectId, { docChanged: changed, treeChanged: changed, reconnected: changed });
      await backend.pool.get(entry.projectId);
    } catch (error) {
      this.logger.debug(`Live updates for the PDF preview of ${entry.projectId} are unavailable`, error);
    }
  }

  /** After signing in, out or switching accounts. */
  reconnect(): void {
    this.compiler.reset();
    for (const entry of this.panels.values()) {
      entry.sentVersion = -1;
      if (entry.ready) void entry.panel.webview.postMessage({ type: 'reset' });
      void this.watch(entry);
      this.post(entry);
      if (this.auth.current && entry.panel.visible) void this.compiler.compile(entry.projectId);
    }
  }

  private projectChanged(projectId: string, kind: 'change' | 'save'): void {
    const entry = this.panels.get(projectId);
    if (!entry) return;
    const mode = this.autoCompileMode();
    if (mode === 'off' || (mode === 'onSave' && kind !== 'save')) return;
    if (!entry.panel.visible) {
      entry.stale = true;
      return;
    }
    this.compiler.schedule(projectId);
  }

  private post(entry: PreviewPanel): void {
    if (!entry.ready) return;
    const snapshot = this.compiler.get(entry.projectId);
    if (snapshot && snapshot.projectName !== snapshot.projectId && snapshot.projectName !== entry.projectName) {
      entry.projectName = snapshot.projectName;
      entry.panel.title = panelTitle(snapshot.projectName);
    }
    const options = this.compiler.options(entry.projectId);
    void entry.panel.webview.postMessage({
      type: 'state',
      projectId: entry.projectId,
      projectName: entry.projectName,
      signedIn: !!this.auth.current,
      state: snapshot?.state ?? 'idle',
      status: snapshot?.status,
      message: snapshot?.message,
      compiledAt: snapshot?.compiledAt,
      pages: snapshot?.pages,
      hasPdf: !!snapshot?.pdf,
      errors: (snapshot?.errors ?? []).map(problem),
      warnings: (snapshot?.warnings ?? []).map(problem),
      typesetting: snapshot?.typesetting.length ?? 0,
      autoCompile: this.autoCompileMode(),
      draft: !!options.draft,
      stopOnFirstError: !!options.stopOnFirstError,
    });
    if (snapshot?.pdf && snapshot.pdfVersion !== entry.sentVersion) {
      entry.sentVersion = snapshot.pdfVersion;
      // A fresh copy: the webview hands the bytes to pdf.js, which takes ownership of them.
      void entry.panel.webview.postMessage({ type: 'pdf', version: snapshot.pdfVersion, data: new Uint8Array(snapshot.pdf) });
    }
  }

  private async onMessage(entry: PreviewPanel, message: FromWebview): Promise<void> {
    try {
      switch (message.type) {
        case 'ready': {
          entry.ready = true;
          entry.sentVersion = -1;
          this.post(entry);
          const snapshot = this.compiler.get(entry.projectId);
          if (this.auth.current && !snapshot) void this.compiler.compile(entry.projectId);
          return;
        }
        case 'recompile':
          if (!this.auth.current) return void vscode.commands.executeCommand('overleafMcp.signIn');
          void this.compiler.compile(entry.projectId);
          return;
        case 'stop':
          await this.compiler.stop(entry.projectId);
          return;
        case 'options':
          await this.compiler.setOptions(entry.projectId, message);
          void this.compiler.compile(entry.projectId);
          return;
        case 'autoCompile':
          await this.setAutoCompile(asAutoCompile(message.value));
          return;
        case 'syncToCode':
          await this.syncToCode(entry.projectId, message.page, message.h, message.v);
          return;
        case 'open':
          await this.openSource(entry, message.file, message.line);
          return;
        case 'download':
          await this.download(entry.projectId);
          return;
        case 'external':
          await this.openExternally(entry.projectId);
          return;
        case 'log':
          await this.showLog(entry.projectId);
          return;
        case 'signIn':
          await vscode.commands.executeCommand('overleafMcp.signIn');
          return;
        case 'rendered':
          this.rendered.fire({ projectId: entry.projectId, version: message.version, pages: message.pages });
          return;
        case 'error':
          this.logger.warn(`PDF preview of ${entry.projectName}: ${message.message}`);
          return;
      }
    } catch (error) {
      this.logger.warn(`PDF preview action "${message.type}" failed`, error);
      void vscode.window.showErrorMessage(errorMessage(error));
    }
  }

  /** The project and position under the cursor of the active editor (Overleaf file or synced local copy). */
  async activePosition(): Promise<SourcePosition | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const { line, character } = editor.selection.active;
    const uri = editor.document.uri;
    if (uri.scheme === SCHEME) {
      const { projectId, path: filePath } = parseOverleafUri(uri);
      return { projectId, path: filePath, line: line + 1, column: character };
    }
    if (uri.scheme === 'file') {
      const owner = await this.mirrors.projectOfFile(uri.fsPath);
      if (owner) return { projectId: owner.projectId, path: owner.path, line: line + 1, column: character };
    }
    return undefined;
  }

  /** SyncTeX forward search: highlights where a source position ended up in the PDF. */
  async showInPdf(position: SourcePosition): Promise<PdfLocation[]> {
    await this.open({ id: position.projectId });
    const entry = this.panels.get(position.projectId)!;
    let snapshot = this.compiler.get(position.projectId);
    if (this.compiler.isCompiling(position.projectId) || !snapshot?.build) snapshot = await this.compiler.whenDone(position.projectId);
    if (!snapshot?.build) throw new Error(snapshot?.message ?? 'There is no PDF to search yet.');
    const locations = await this.service.syncToPdf(position.projectId, snapshot.build, position.path, position.line, position.column, snapshot.rootPath);
    if (!locations.length) {
      vscode.window.setStatusBarMessage(`$(info) Line ${position.line} of ${position.path} has no position in the PDF`, 4000);
      return [];
    }
    entry.panel.reveal(undefined, true);
    void entry.panel.webview.postMessage({ type: 'highlight', version: snapshot.pdfVersion, locations });
    return locations;
  }

  /** SyncTeX inverse search: opens the source behind a point in the PDF. */
  private async syncToCode(projectId: string, page: number, h: number, v: number): Promise<void> {
    const snapshot = this.compiler.get(projectId);
    if (!snapshot?.build) return;
    const location = await this.service.syncToCode(projectId, snapshot.build, page, h, v);
    if (!location) {
      vscode.window.setStatusBarMessage('$(info) No source position for that spot in the PDF', 4000);
      return;
    }
    const entry = this.panels.get(projectId);
    if (entry) await this.openSource(entry, location.file, location.line, location.column);
  }

  /** Opens a project file at a line: the synced local copy if there is one, else the Overleaf file. */
  private async openSource(entry: PreviewPanel, file: string, line?: number, column?: number): Promise<void> {
    let uri = overleafUri(entry.projectId, file);
    const dir = this.mirrors.isRunning(entry.projectId) ? await this.mirrors.dirOf(entry.projectId) : undefined;
    if (dir) {
      const local = vscode.Uri.file(path.join(dir, file));
      if (await vscode.workspace.fs.stat(local).then(() => true, () => false)) uri = local;
    }
    const position = new vscode.Position(Math.max(0, (line ?? 1) - 1), Math.max(0, column ?? 0));
    const visible = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === uri.toString());
    const viewColumn = visible?.viewColumn ?? (entry.panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One);
    const editor = await vscode.window.showTextDocument(uri, { viewColumn, selection: new vscode.Range(position, position) });
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private requirePdf(projectId: string): CompileSnapshot & { pdf: Uint8Array } {
    const snapshot = this.compiler.get(projectId);
    if (!snapshot?.pdf) throw new Error('There is no PDF yet. Recompile first.');
    return snapshot as CompileSnapshot & { pdf: Uint8Array };
  }

  async download(projectId: string): Promise<void> {
    if (!this.compiler.get(projectId)?.pdf) await this.compiler.whenDone(projectId);
    const snapshot = this.requirePdf(projectId);
    const downloads = path.join(os.homedir(), 'Downloads');
    const parent = (await this.mirrors.dirOf(projectId)) ?? ((await fs.stat(downloads).then((s) => s.isDirectory(), () => false)) ? downloads : os.homedir());
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(parent, `${safeFolderName(snapshot.projectName)}.pdf`)),
      filters: { PDF: ['pdf'] },
      title: `Save the PDF of ${snapshot.projectName}`,
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, snapshot.pdf);
    vscode.window.setStatusBarMessage(`$(check) Saved ${path.basename(target.fsPath)}`, 4000);
  }

  private async openExternally(projectId: string): Promise<void> {
    const snapshot = this.requirePdf(projectId);
    const file = path.join(os.tmpdir(), 'overleaf-mcp', `${safeFolderName(snapshot.projectName)}-${projectId.slice(-6)}.pdf`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, snapshot.pdf);
    await vscode.env.openExternal(vscode.Uri.file(file));
  }

  private logUri(projectId: string, projectName: string): vscode.Uri {
    return vscode.Uri.from({ scheme: LOG_SCHEME, authority: projectId, path: `/${safeFolderName(projectName)}.log` });
  }

  async showLog(projectId: string): Promise<void> {
    const snapshot = this.compiler.get(projectId);
    if (!snapshot?.rawLog) throw new Error('There is no compile log yet. Recompile first.');
    const document = await vscode.workspace.openTextDocument(this.logUri(projectId, snapshot.projectName));
    await Promise.resolve(vscode.languages.setTextDocumentLanguage(document, 'log')).catch(() => undefined);
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private html(webview: vscode.Webview, projectId: string, projectName: string): string {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    return previewHtml({
      cspSource: webview.cspSource,
      asset: (...parts) => webview.asWebviewUri(vscode.Uri.joinPath(media, ...parts)).toString(),
      nonce: randomBytes(16).toString('base64'),
      projectId,
      projectName,
      title: panelTitle(projectName),
      mac: process.platform === 'darwin',
    });
  }

  dispose(): void {
    for (const entry of this.panels.values()) entry.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
