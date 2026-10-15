import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DataPaths } from '../core/store/paths';
import { readJsonFile } from '../core/util/fsx';
import { McpEndpoint } from './mcp';

interface StdioLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

const windows = process.platform === 'win32';

function runVersion(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, ['--version'], { timeout: 5000, windowsHide: true }, (error, stdout) => resolve(error ? undefined : stdout.trim()));
  });
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

/** Absolute path of a Node.js ≥ 20 on PATH (GUI apps like Claude Desktop don't inherit shell PATH). */
async function findNode(): Promise<string | undefined> {
  const exe = windows ? 'node.exe' : 'node';
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (!windows) dirs.push('/usr/local/bin', '/opt/homebrew/bin', '/usr/bin');
  for (const dir of dirs) {
    const candidate = path.join(dir, exe);
    if (!(await exists(candidate))) continue;
    const version = await runVersion(candidate);
    const major = Number(/^v(\d+)/.exec(version ?? '')?.[1]);
    if (major >= 20) return candidate;
  }
  return undefined;
}

/** Whether a command-line tool is installed (on PATH). */
async function onPath(name: string): Promise<boolean> {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const names = windows ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`] : [name];
  for (const dir of dirs) for (const file of names) if (await exists(path.join(dir, file))) return true;
  return false;
}

export async function stdioLaunch(serverPath: string, paths: DataPaths): Promise<StdioLaunch> {
  const node = await findNode();
  const env: Record<string, string> = {};
  if (paths.root !== path.join(os.homedir(), '.overleaf-mcp')) env.OVERLEAF_MCP_HOME = paths.root;
  if (node) return { command: node, args: [serverPath], env: Object.keys(env).length ? env : undefined };
  // No Node.js installed: VS Code's own runtime can run the server.
  return { command: process.execPath, args: [serverPath], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
}

/** Quotes an argument for the setup terminal: cmd.exe on Windows, the default (POSIX) shell elsewhere. */
function shellQuote(arg: string): string {
  if (/^[\w@+=:,./\\-]+$/.test(arg)) return arg;
  return windows ? `"${arg.replace(/"/g, '""')}"` : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Runs setup commands where the person can see them. On Windows this is cmd.exe: PowerShell
 * drops the "--" that separates a tool's options from the server command.
 */
function runInTerminal(commands: string[][]): void {
  const terminal = vscode.window.createTerminal({ name: 'Overleaf MCP setup', ...(windows ? { shellPath: 'cmd.exe' } : {}) });
  terminal.show();
  terminal.sendText(commands.map((argv) => argv.map(shellQuote).join(' ')).join(windows ? ' & ' : '; '));
}

/** Adds or replaces `mcpServers.overleaf` in a client's JSON config, keeping a backup. */
async function mergeJsonConfig(file: string, entry: unknown): Promise<void> {
  let current: Record<string, unknown> = {};
  try {
    await fs.access(file);
    const parsed = await readJsonFile<Record<string, unknown>>(file);
    if (!parsed) throw new Error(`${file} is not valid JSON; fix or remove it first.`);
    current = parsed;
    await fs.copyFile(file, `${file}.bak`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const servers = (current.mcpServers as Record<string, unknown> | undefined) ?? {};
  current.mcpServers = { ...servers, overleaf: entry };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(current, null, 2)}\n`);
}

function claudeDesktopConfig(): string {
  if (windows) return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

/** Clients configured by running their own `mcp add` command. */
type CliClient = 'claude-code' | 'codex' | 'copilot-cli';
/** Clients configured by editing their JSON settings file. */
type FileClient = 'claude-desktop' | 'cursor' | 'windsurf' | 'gemini';

const CLI_CLIENTS: Record<CliClient, { label: string; tool: string }> = {
  'claude-code': { label: 'Claude Code', tool: 'claude' },
  codex: { label: 'Codex CLI', tool: 'codex' },
  'copilot-cli': { label: 'GitHub Copilot CLI', tool: 'copilot' },
};

const FILE_CLIENTS: Record<FileClient, { label: string; file: () => string; installed: () => Promise<boolean> }> = {
  'claude-desktop': { label: 'Claude Desktop', file: claudeDesktopConfig, installed: () => exists(path.dirname(claudeDesktopConfig())) },
  cursor: { label: 'Cursor', file: () => path.join(os.homedir(), '.cursor', 'mcp.json'), installed: () => exists(path.join(os.homedir(), '.cursor')) },
  windsurf: {
    label: 'Windsurf',
    file: () => path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
    installed: () => exists(path.join(os.homedir(), '.codeium', 'windsurf')),
  },
  gemini: {
    label: 'Gemini CLI',
    file: () => path.join(os.homedir(), '.gemini', 'settings.json'),
    installed: async () => (await exists(path.join(os.homedir(), '.gemini'))) || onPath('gemini'),
  },
};

/** `<tool> mcp add` commands that register the stdio server (replacing an older entry). */
function cliCommands(client: CliClient, launch: StdioLaunch): string[][] {
  const env = Object.entries(launch.env ?? {});
  const server = [launch.command, ...launch.args];
  switch (client) {
    case 'claude-code':
      // -e takes several values, so it goes after the name and is closed off by "--".
      return [
        ['claude', 'mcp', 'remove', '--scope', 'user', 'overleaf'],
        ['claude', 'mcp', 'add', '--scope', 'user', 'overleaf', ...env.flatMap(([k, v]) => ['-e', `${k}=${v}`]), '--', ...server],
      ];
    case 'codex':
      return [
        ['codex', 'mcp', 'remove', 'overleaf'],
        ['codex', 'mcp', 'add', ...env.flatMap(([k, v]) => ['--env', `${k}=${v}`]), 'overleaf', '--', ...server],
      ];
    case 'copilot-cli':
      return [
        ['copilot', 'mcp', 'remove', 'overleaf'],
        ['copilot', 'mcp', 'add', ...env.flatMap(([k, v]) => ['--env', `${k}=${v}`]), 'overleaf', '--', ...server],
      ];
  }
}

async function detect(): Promise<{ cli: CliClient[]; files: FileClient[] }> {
  const cli = (await Promise.all((Object.keys(CLI_CLIENTS) as CliClient[]).map(async (id) => ((await onPath(CLI_CLIENTS[id].tool)) ? id : undefined)))).filter(
    (id): id is CliClient => !!id,
  );
  const files = (await Promise.all((Object.keys(FILE_CLIENTS) as FileClient[]).map(async (id) => ((await FILE_CLIENTS[id].installed()) ? id : undefined)))).filter(
    (id): id is FileClient => !!id,
  );
  return { cli, files };
}

export async function connectClient(endpoint: McpEndpoint, paths: DataPaths, serverPath: string): Promise<void> {
  const found = await detect();
  const foundLabels = [...found.cli.map((id) => CLI_CLIENTS[id].label), ...found.files.map((id) => FILE_CLIENTS[id].label)];
  const status = (installed: boolean) => (installed ? 'installed' : 'not found on this computer');
  type Item = vscode.QuickPickItem & { id: string };
  const items: Item[] = [
    ...(foundLabels.length ? [{ label: '$(check-all) Every AI tool found on this computer', description: foundLabels.join(', '), id: 'all' }] : []),
    { label: '', kind: vscode.QuickPickItemKind.Separator, id: '' },
    { label: 'Claude Code', description: `stdio · ${status(found.cli.includes('claude-code'))}`, id: 'claude-code' },
    { label: 'Claude Code (HTTP)', description: 'shares this window\'s live connection; needs VS Code running', id: 'claude-code-http' },
    { label: 'Codex CLI', description: `runs codex mcp add · ${status(found.cli.includes('codex'))}`, id: 'codex' },
    { label: 'GitHub Copilot CLI', description: `runs copilot mcp add · ${status(found.cli.includes('copilot-cli'))}`, id: 'copilot-cli' },
    { label: 'Gemini CLI', description: `edits ~/.gemini/settings.json · ${status(found.files.includes('gemini'))}`, id: 'gemini' },
    { label: 'Claude Desktop', description: `edits claude_desktop_config.json · ${status(found.files.includes('claude-desktop'))}`, id: 'claude-desktop' },
    { label: 'Cursor', description: `edits ~/.cursor/mcp.json · ${status(found.files.includes('cursor'))}`, id: 'cursor' },
    { label: 'Windsurf', description: `edits ~/.codeium/windsurf/mcp_config.json · ${status(found.files.includes('windsurf'))}`, id: 'windsurf' },
    { label: 'VS Code (Copilot agent mode)', description: 'already registered automatically', id: 'vscode' },
    { label: '', kind: vscode.QuickPickItemKind.Separator, id: '' },
    { label: 'Copy stdio config (JSON)', description: 'for any other MCP client', id: 'copy-stdio' },
    { label: 'Copy HTTP endpoint and token', description: endpoint.url, id: 'copy-http' },
  ];
  const picked = await vscode.window.showQuickPick(items, { title: 'Connect an AI assistant to your Overleaf projects', matchOnDescription: true });
  if (!picked?.id) return;
  const launch = await stdioLaunch(serverPath, paths);
  const stdioEntry = { command: launch.command, args: launch.args, ...(launch.env ? { env: launch.env } : {}) };
  const httpEntry = { type: 'http', url: endpoint.url, headers: { Authorization: `Bearer ${endpoint.token}` } };

  const writeFile = async (id: FileClient): Promise<string | undefined> => {
    const file = FILE_CLIENTS[id].file();
    try {
      await mergeJsonConfig(file, stdioEntry);
      return file;
    } catch (error) {
      vscode.window.showErrorMessage(`Could not update ${file}: ${(error as Error).message}`);
      return undefined;
    }
  };

  switch (picked.id) {
    case 'all': {
      const written: string[] = [];
      for (const id of found.files) if (await writeFile(id)) written.push(FILE_CLIENTS[id].label);
      if (found.cli.length) runInTerminal(found.cli.flatMap((id) => cliCommands(id, launch)));
      const parts = [
        written.length ? `added "overleaf" to ${written.join(', ')}` : '',
        found.cli.length ? `registering it with ${found.cli.map((id) => CLI_CLIENTS[id].label).join(', ')} in the terminal` : '',
      ].filter(Boolean);
      vscode.window.showInformationMessage(`Overleaf MCP: ${parts.join('; ')}. Restart those apps (or start a new session) to load the tools.`);
      return;
    }
    case 'claude-code':
    case 'codex':
    case 'copilot-cli': {
      runInTerminal(cliCommands(picked.id, launch));
      vscode.window.showInformationMessage(`Registering the Overleaf MCP server with ${CLI_CLIENTS[picked.id].label} in the terminal. Start a new session to use it.`);
      return;
    }
    case 'claude-code-http': {
      if (!endpoint.available) {
        vscode.window.showWarningMessage('The HTTP endpoint is not running. Enable overleafMcp.mcp.httpServer.enabled or use the stdio option.');
        return;
      }
      runInTerminal([
        ['claude', 'mcp', 'remove', '--scope', 'user', 'overleaf'],
        ['claude', 'mcp', 'add', '--transport', 'http', '--scope', 'user', 'overleaf', endpoint.url, '--header', `Authorization: Bearer ${endpoint.token}`],
      ]);
      vscode.window.showInformationMessage('Registering the Overleaf HTTP endpoint with Claude Code in the terminal.');
      return;
    }
    case 'gemini':
    case 'claude-desktop':
    case 'cursor':
    case 'windsurf': {
      const file = await writeFile(picked.id);
      if (!file) return;
      const label = FILE_CLIENTS[picked.id].label;
      const action = await vscode.window.showInformationMessage(`Added "overleaf" to ${label} (${file}). Restart ${label} to load it.`, 'Open Config');
      if (action) await vscode.window.showTextDocument(vscode.Uri.file(file));
      return;
    }
    case 'vscode':
      vscode.window.showInformationMessage('The Overleaf tools are registered with VS Code automatically. In Chat, switch to Agent mode and enable the "Overleaf" tools.');
      return;
    case 'copy-stdio':
      await vscode.env.clipboard.writeText(JSON.stringify({ mcpServers: { overleaf: stdioEntry } }, null, 2));
      vscode.window.showInformationMessage('Copied the stdio MCP config to the clipboard.');
      return;
    case 'copy-http':
      await vscode.env.clipboard.writeText(JSON.stringify({ mcpServers: { overleaf: httpEntry } }, null, 2));
      vscode.window.showInformationMessage(`Copied the HTTP config (${endpoint.url}, with its bearer token) to the clipboard. Keep the token private.`);
      return;
  }
}
