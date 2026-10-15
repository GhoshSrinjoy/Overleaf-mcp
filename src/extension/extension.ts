import * as vscode from 'vscode';
import { vscodeRipgrepCandidates } from '../core/search/ripgrep';
import { OverleafService } from '../core/service';
import { resolveDataPaths } from '../core/store/paths';
import { AuthManager } from './auth';
import { registerCommands } from './commands';
import { CompileController } from './compileController';
import { createOutputLogger } from './logger';
import { McpEndpoint, installRipgrep, installServerCopy, registerWithVsCode } from './mcp';
import { MirrorManager } from './mirrors';
import { OverleafFileSystem, SCHEME } from './overleafFs';
import { PdfPreviewManager } from './pdfPreview';
import { Node, ProjectsView } from './projectsView';

export interface OverleafExtensionApi {
  service: OverleafService;
  auth: AuthManager;
  endpoint: McpEndpoint;
  view: ProjectsView;
  treeView: vscode.TreeView<Node>;
  mirrors: MirrorManager;
  compiler: CompileController;
  previews: PdfPreviewManager;
}

export async function activate(context: vscode.ExtensionContext): Promise<OverleafExtensionApi> {
  const channel = vscode.window.createOutputChannel('Overleaf MCP', { log: true });
  const logger = createOutputLogger(channel);
  const paths = resolveDataPaths();

  const auth = new AuthManager(context, paths, logger);
  await auth.initialize();
  const service = new OverleafService({
    paths,
    logger,
    session: auth.sessionSource,
    ripgrepCandidates: vscodeRipgrepCandidates(vscode.env.appRoot),
  });

  const fileSystem = new OverleafFileSystem(service, logger);
  const view = new ProjectsView(service, auth, logger);
  const treeView = vscode.window.createTreeView('overleafMcp.projects', { treeDataProvider: view, showCollapseAll: true });
  const endpoint = new McpEndpoint(context, service, logger);
  const mirrors = new MirrorManager(service, logger);
  // Compile problems also show on synced local copies.
  const compiler = new CompileController(service, context.globalState, logger, async (projectId) => (mirrors.isRunning(projectId) ? mirrors.dirOf(projectId) : undefined));
  const previews = new PdfPreviewManager(context, service, auth, compiler, mirrors, logger);
  let serverPath: string | undefined;

  context.subscriptions.push(
    channel,
    auth,
    view,
    treeView,
    endpoint,
    mirrors,
    compiler,
    previews,
    fileSystem,
    vscode.workspace.registerFileSystemProvider(SCHEME, fileSystem, { isCaseSensitive: true }),
    { dispose: () => service.dispose() },
  );

  registerCommands({ context, service, auth, view, endpoint, mirrors, compiler, previews, paths, serverPath: () => serverPath, logger });
  registerWithVsCode(context, endpoint, auth, paths, () => serverPath);

  const status = vscode.window.createStatusBarItem('overleafMcp.account', vscode.StatusBarAlignment.Left, 20);
  status.name = 'Overleaf';
  status.command = 'overleafMcp.accountMenu';
  context.subscriptions.push(status);

  const updateUi = () => {
    const session = auth.current;
    void vscode.commands.executeCommand('setContext', 'overleafMcp.signedIn', !!session);
    status.text = session ? '$(book) Overleaf' : '$(book) Overleaf: Sign in';
    status.tooltip = session
      ? `Signed in to ${new URL(session.serverUrl).host} as ${session.email ?? session.userId}\nMCP endpoint: ${endpoint.available ? endpoint.url : 'off'}`
      : 'Sign in to Overleaf';
    status.show();
    treeView.description = view.filterText ? `filter: ${view.filterText}` : undefined;
  };
  updateUi();

  context.subscriptions.push(
    auth.onDidChange((session) => {
      void mirrors.stopAll().then(() => {
        service.dispose();
        fileSystem.reset();
        previews.reconnect();
        view.refresh();
        updateUi();
        if (session) void mirrors.resumeAll();
      });
    }),
    mirrors.onDidChange(() => view.refresh()),
    endpoint.onDidChange(updateUi),
    view.onDidChangeTreeData(updateUi),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('overleafMcp.mcp.httpServer')) void endpoint.restart();
      if (event.affectsConfiguration('overleafMcp.mcp.shareSessionWithExternalClients')) void auth.syncSharedFile();
      if (event.affectsConfiguration('overleafMcp.projects')) view.refresh();
    }),
  );

  // Slower setup runs in the background so the panel appears immediately.
  void endpoint.start().catch((error) => logger.error('MCP endpoint failed to start', error));
  void installServerCopy(context, paths, logger)
    .then((installed) => {
      serverPath = installed;
    })
    .catch((error) => logger.error('Could not install the MCP server copy', error));
  void installRipgrep(paths, service, logger).catch((error) => logger.warn('ripgrep setup failed; the built-in search will be used', error));
  if (auth.current) void mirrors.resumeAll().catch((error) => logger.warn('Could not resume local syncs', error));

  return { service, auth, endpoint, view, treeView, mirrors, compiler, previews };
}

export function deactivate(): void {
  // Disposables registered on the context clean everything up.
}
