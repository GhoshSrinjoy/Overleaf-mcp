import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { signInWithCookie, signInWithPassword } from '../core/auth';
import { browserSignIn } from '../core/browserLogin';
import { loadGitProjects } from '../core/git/projectsConfig';
import { folderProblem, safeFolderName } from '../core/mirror/folders';
import { MirrorLease } from '../core/mirror/lease';
import { ProjectMirror } from '../core/mirror/mirror';
import { OverleafService } from '../core/service';
import { CredentialStore } from '../core/store/credentials';
import { FileSessionSource } from '../core/store/fileSessionSource';
import { resolveDataPaths } from '../core/store/paths';
import { errorMessage } from '../core/util/errors';
import { createStderrLogger } from '../core/util/log';
import { startHttpHost } from './http';
import { SERVER_VERSION, createMcpServer } from './server';
import { whenToolsIdle } from './tools';

const HELP = `overleaf-mcp ${SERVER_VERSION} — MCP server for Overleaf projects

Usage:
  overleaf-mcp                      Serve MCP over stdio (what AI clients launch)
  overleaf-mcp --http [--port N]    Serve MCP over HTTP on 127.0.0.1 (default port 39847)
  overleaf-mcp login --cookie <value> [--server <url>]
  overleaf-mcp login --browser [--server <url>]      Sign in on the real login page (Chrome/Edge/Brave)
  overleaf-mcp login --email <email> --password <password> [--server <url>]   (self-hosted servers)
  overleaf-mcp logout
  overleaf-mcp status
  overleaf-mcp sync <project> [folder]              Keep a local folder in two-way sync (until Ctrl+C)

Options:
  --home <dir>     Data directory (default ~/.overleaf-mcp or $OVERLEAF_MCP_HOME)
  --projects <f>   Git-token projects file (default $PROJECTS_FILE or <home>/projects.json)
  --token <token>  Bearer token for --http (default $OVERLEAF_MCP_TOKEN, else generated)
  --debug          Verbose logging to stderr

The VS Code extension signs in for you and writes the session to the data directory.
Headless setups can instead set OVERLEAF_COOKIES (or OVERLEAF_SESSION) and OVERLEAF_SERVER_URL,
or list projects with Git tokens in projects.json (Overleaf plans with Git integration).`;

function parseArgs(argv: string[]): { command?: string; positionals: string[]; flags: Map<string, string | true> } {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split(/=(.*)/s);
      const next = argv[i + 1];
      if (inline !== undefined) flags.set(key, inline);
      else if (next !== undefined && !next.startsWith('--')) flags.set(key, argv[++i]);
      else flags.set(key, true);
    } else if (!command) {
      command = arg;
    } else {
      positionals.push(arg);
    }
  }
  return { command, positionals, flags };
}

async function main(): Promise<void> {
  const { command, positionals, flags } = parseArgs(process.argv.slice(2));
  if (flags.has('help') || command === 'help') {
    process.stderr.write(`${HELP}\n`);
    return;
  }
  if (flags.has('version')) {
    process.stderr.write(`${SERVER_VERSION}\n`);
    return;
  }

  const logger = createStderrLogger(flags.has('debug') ? 'debug' : 'info');
  const paths = resolveDataPaths(typeof flags.get('home') === 'string' ? (flags.get('home') as string) : undefined);
  const store = new CredentialStore(paths.credentialsFile);
  const server = typeof flags.get('server') === 'string' ? (flags.get('server') as string) : undefined;

  if (command === 'login') {
    const cookie = flags.get('cookie');
    const email = flags.get('email');
    const password = flags.get('password');
    const signedIn =
      typeof cookie === 'string'
        ? await signInWithCookie(server, cookie, logger)
        : typeof email === 'string' && typeof password === 'string'
          ? await signInWithPassword(server, email, password, logger)
          : flags.has('browser')
            ? await browserSignIn({ serverUrl: server, logger })
            : undefined;
    if (!signedIn) throw new Error('Pass --browser, --cookie <value>, or --email and --password');
    const method = typeof cookie === 'string' ? 'cookie' : flags.has('browser') ? 'browser' : 'password';
    await store.write({ ...signedIn.session, method });
    process.stderr.write(`Signed in to ${signedIn.session.serverUrl} as ${signedIn.info.email ?? signedIn.info.userId}.\n`);
    return;
  }
  if (command === 'logout') {
    await store.clear();
    process.stderr.write('Signed out (credentials removed).\n');
    return;
  }

  const projectsFile = (typeof flags.get('projects') === 'string' ? (flags.get('projects') as string) : undefined) ?? process.env.PROJECTS_FILE ?? path.join(paths.root, 'projects.json');
  const gitProjects = await loadGitProjects(projectsFile);
  const service = new OverleafService({ paths, logger, session: new FileSessionSource(store, paths.credentialsFile, logger), gitProjects });

  if (command === 'status') {
    const status = await service.status();
    process.stderr.write(
      `${status.signedIn ? `Signed in to ${status.serverUrl} as ${status.email ?? status.userId}` : `Not signed in: ${status.error}`}\n` +
        `Git-token projects: ${status.gitProjects}\nPinned: ${status.pinned.map((p) => p.name).join(', ') || 'none'}\nSearch: ${status.ripgrep ?? 'built-in'}\nData: ${status.dataDir}\n`,
    );
    service.dispose();
    return;
  }

  let shuttingDown = false;
  if (command === 'sync') {
    const ref = positionals[0];
    if (!ref) throw new Error('Usage: overleaf-mcp sync <project name or id> [folder]');
    const project = await service.resolveProject(ref);
    const dir = path.resolve(positionals[1] ?? path.join(os.homedir(), 'Overleaf', safeFolderName(project.name)));
    const problem = await folderProblem(dir, project.id);
    if (problem) throw new Error(`Can't sync into ${dir}: ${problem}. Choose a new or empty folder.`);
    const lease = new MirrorLease(dir, 'cli');
    await fs.mkdir(dir, { recursive: true });
    if (!(await lease.acquire())) throw new Error(`${dir} is already being synced by another process (VS Code or another CLI)`);
    const mirror = new ProjectMirror({
      service,
      projectId: project.id,
      dir,
      logger,
      onReport: (report) => {
        const lines = [
          ...report.pulled.map((f) => `  ↓ ${f}`),
          ...report.pushed.map((f) => `  ↑ ${f}`),
          ...report.merged.map((f) => `  ⇅ ${f} (merged)`),
          ...report.deletedLocal.map((f) => `  ✕ ${f} (deleted here)`),
          ...report.deletedRemote.map((f) => `  ✕ ${f} (deleted on Overleaf)`),
          ...report.conflicts.map((f) => `  ! ${f}: conflict, resolve the markers and save`),
          ...report.failed.map((f) => `  ! ${f.path}: ${f.error}`),
        ];
        if (lines.length) process.stderr.write(`${new Date().toLocaleTimeString()}\n${lines.join('\n')}\n`);
      },
    });
    await mirror.start();
    await service.settings.update((settings) => ({ ...settings, mirrors: [...(settings.mirrors ?? []).filter((m) => m.projectId !== project.id), { projectId: project.id, dir }] }));
    process.stderr.write(`Syncing "${project.name}" with ${dir}. Press Ctrl+C to stop.\n`);
    const stop = async () => {
      await mirror.stop();
      await lease.release();
      service.dispose();
      process.exit(0);
    };
    process.on('SIGINT', () => void stop());
    process.on('SIGTERM', () => void stop());
    return;
  }

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Let tool calls already in progress send their replies before exiting.
    void whenToolsIdle(30_000).then(() => {
      service.dispose();
      setTimeout(() => process.exit(0), 50);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (reason) => logger.error('Unhandled rejection', reason));

  if (flags.has('http')) {
    const token = (typeof flags.get('token') === 'string' ? (flags.get('token') as string) : undefined) ?? process.env.OVERLEAF_MCP_TOKEN ?? randomBytes(24).toString('base64url');
    const port = Number(flags.get('port') ?? process.env.OVERLEAF_MCP_PORT ?? 39847);
    const host = typeof flags.get('host') === 'string' ? (flags.get('host') as string) : '127.0.0.1';
    const http = await startHttpHost({ port, host, token, logger, createServer: () => createMcpServer(service, logger) });
    if (!flags.has('token') && !process.env.OVERLEAF_MCP_TOKEN) process.stderr.write(`Bearer token: ${token}\n`);
    process.stderr.write(`Listening on ${http.url}\n`);
    return;
  }

  const mcp = createMcpServer(service, logger);
  const transport = new StdioServerTransport();
  transport.onclose = shutdown;
  process.stdin.on('end', shutdown);
  await mcp.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`overleaf-mcp: ${errorMessage(error)}\n`);
  process.exit(1);
});
