import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { RIPGREP_EXECUTABLE, locateRipgrep, vscodeRipgrepCandidates } from '../core/search/ripgrep';
import { OverleafService } from '../core/service';
import { DataPaths } from '../core/store/paths';
import { isErrno } from '../core/util/errors';
import { Logger } from '../core/util/log';
import { HttpHost, startHttpHost } from '../mcp/http';
import { SERVER_VERSION, createMcpServer } from '../mcp/server';
import { AuthManager, config } from './auth';

const TOKEN_KEY = 'overleafMcp.httpToken';

async function sameContent(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
    return createHash('sha256').update(left).digest('hex') === createHash('sha256').update(right).digest('hex');
  } catch {
    return false;
  }
}

/**
 * Copies the bundled server to ~/.overleaf-mcp/server so AI-client configs point at a path that
 * survives extension updates.
 */
export async function installServerCopy(context: vscode.ExtensionContext, paths: DataPaths, logger: Logger): Promise<string> {
  const source = path.join(context.extensionPath, 'dist', 'mcp-server.js');
  const target = path.join(paths.serverDir, 'overleaf-mcp.js');
  if (!(await sameContent(source, target))) {
    await fs.mkdir(paths.serverDir, { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    await fs.copyFile(source, temp);
    await fs.rename(temp, target);
    logger.info(`Installed MCP server at ${target}`);
  }
  return target;
}

/**
 * Copies VS Code's ripgrep next to the server: VS Code keeps it in a folder that changes with
 * every update, and MCP servers launched by other apps must still find it.
 */
export async function installRipgrep(paths: DataPaths, service: OverleafService, logger: Logger): Promise<string | undefined> {
  const bundled = await locateRipgrep(vscodeRipgrepCandidates(vscode.env.appRoot));
  const target = path.join(paths.root, 'bin', RIPGREP_EXECUTABLE);
  try {
    if (bundled && !(await sameContent(bundled, target))) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temp = `${target}.${process.pid}.tmp`;
      await fs.copyFile(bundled, temp);
      if (process.platform !== 'win32') await fs.chmod(temp, 0o755);
      await fs.rename(temp, target);
    }
  } catch (error) {
    // Another window may be copying, or the binary is in use; the existing copy is fine.
    if (!isErrno(error, 'EBUSY', 'EPERM', 'EACCES', 'ETXTBSY')) logger.warn('Could not copy ripgrep', error);
  }
  const usable = await locateRipgrep([target, bundled]);
  if (usable) await service.settings.update((settings) => ({ ...settings, ripgrepPath: usable }));
  return usable;
}

export async function httpToken(context: vscode.ExtensionContext): Promise<string> {
  let token = await context.secrets.get(TOKEN_KEY);
  if (!token) {
    token = randomBytes(24).toString('base64url');
    await context.secrets.store(TOKEN_KEY, token);
  }
  return token;
}

export type EndpointState = 'off' | 'hosting' | 'shared' | 'port-busy';

/**
 * The local HTTP MCP endpoint. Exactly one VS Code window hosts it; other windows notice it is
 * already running, share it, and take over if the hosting window closes.
 */
export class McpEndpoint implements vscode.Disposable {
  private host?: HttpHost;
  private retryTimer?: NodeJS.Timeout;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  state: EndpointState = 'off';
  token = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: OverleafService,
    private readonly logger: Logger,
  ) {}

  get port(): number {
    return config().get<number>('mcp.httpServer.port', 39847);
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  get available(): boolean {
    return this.state === 'hosting' || this.state === 'shared';
  }

  async start(): Promise<void> {
    this.token = await httpToken(this.context);
    if (!config().get<boolean>('mcp.httpServer.enabled', true)) return this.setState('off');
    await this.tryHost();
  }

  private setState(state: EndpointState): void {
    if (this.state === state) return;
    this.state = state;
    this.changed.fire();
  }

  private async tryHost(): Promise<void> {
    clearTimeout(this.retryTimer);
    if (this.host) return;
    try {
      this.host = await startHttpHost({
        port: this.port,
        token: this.token,
        logger: this.logger,
        createServer: () => createMcpServer(this.service, this.logger),
      });
      this.setState('hosting');
      return;
    } catch (error) {
      if (!isErrno(error, 'EADDRINUSE')) {
        this.logger.error('Could not start the MCP HTTP endpoint', error);
        return this.setState('off');
      }
    }
    // The port is taken: by another VS Code window running this extension, or by something else.
    const ours = await this.probe();
    if (!ours && this.state !== 'port-busy') {
      void vscode.window.showWarningMessage(
        `Port ${this.port} is used by another program, so the Overleaf MCP HTTP endpoint is off. Choose another port in settings (overleafMcp.mcp.httpServer.port).`,
      );
    }
    this.setState(ours ? 'shared' : 'port-busy');
    this.retryTimer = setTimeout(() => void this.tryHost(), 30_000);
  }

  private async probe(): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(2000) });
      return response.ok && (await response.text()) === 'ok';
    } catch {
      return false;
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    clearTimeout(this.retryTimer);
    await this.host?.close();
    this.host = undefined;
    this.setState('off');
  }

  dispose(): void {
    void this.stop();
    this.changed.dispose();
  }
}

/** Registers the server with VS Code's own MCP support, so Copilot agent mode sees the tools. */
export function registerWithVsCode(
  context: vscode.ExtensionContext,
  endpoint: McpEndpoint,
  auth: AuthManager,
  paths: DataPaths,
  serverPath: () => string | undefined,
): void {
  const lm = vscode.lm as typeof vscode.lm & { registerMcpServerDefinitionProvider?: typeof vscode.lm.registerMcpServerDefinitionProvider };
  if (typeof lm.registerMcpServerDefinitionProvider !== 'function') return;
  const changed = new vscode.EventEmitter<void>();
  context.subscriptions.push(
    changed,
    endpoint.onDidChange(() => changed.fire()),
    auth.onDidChange(() => changed.fire()),
    lm.registerMcpServerDefinitionProvider('overleafMcp.servers', {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions: () => {
        if (endpoint.available) {
          return [new vscode.McpHttpServerDefinition('Overleaf', vscode.Uri.parse(endpoint.url), { Authorization: `Bearer ${endpoint.token}` }, SERVER_VERSION)];
        }
        const script = serverPath();
        if (!script) return [];
        return [new vscode.McpStdioServerDefinition('Overleaf', process.execPath, [script], { ELECTRON_RUN_AS_NODE: '1', OVERLEAF_MCP_HOME: paths.root }, SERVER_VERSION)];
      },
      resolveMcpServerDefinition: (definition) => {
        // Without the shared credentials file, hand the session to the stdio server directly.
        if (definition instanceof vscode.McpStdioServerDefinition && auth.current && !auth.sharesWithExternalClients) {
          definition.env = { ...definition.env, OVERLEAF_COOKIES: auth.current.cookies, OVERLEAF_SERVER_URL: auth.current.serverUrl };
        }
        return definition;
      },
    }),
  );
}
