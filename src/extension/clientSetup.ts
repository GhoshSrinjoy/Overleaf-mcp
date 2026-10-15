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

function runVersion(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, ['--version'], { timeout: 5000, windowsHide: true }, (error, stdout) => resolve(error ? undefined : stdout.trim()));
  });
}

/** Absolute path of a Node.js ≥ 20 on PATH (GUI apps like Claude Desktop don't inherit shell PATH). */
async function findNode(): Promise<string | undefined> {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (process.platform !== 'win32') dirs.push('/usr/local/bin', '/opt/homebrew/bin', '/usr/bin');
  for (const dir of dirs) {
    const candidate = path.join(dir, exe);
    try {
      await fs.access(candidate);
    } catch {
      continue;
    }
    const version = await runVersion(candidate);
    const major = Number(/^v(\d+)/.exec(version ?? '')?.[1]);
    if (major >= 20) return candidate;
  }
  return undefined;
}

export async function stdioLaunch(serverPath: string, paths: DataPaths): Promise<StdioLaunch> {
  const node = await findNode();
  const env: Record<string, string> = {};
  if (paths.root !== path.join(os.homedir(), '.overleaf-mcp')) env.OVERLEAF_MCP_HOME = paths.root;
  if (node) return { command: node, args: [serverPath], env: Object.keys(env).length ? env : undefined };
  // No Node.js installed: VS Code's own runtime can run the server.
  return { command: process.execPath, args: [serverPath], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
}

function quote(arg: string): string {
  return /[\s"'&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
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
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

function runInTerminal(commands: string[]): void {
  const shell = vscode.env.shell.toLowerCase();
  const separator = shell.includes('cmd.exe') ? ' & ' : '; ';
  const terminal = vscode.window.createTerminal({ name: 'Overleaf MCP setup' });
  terminal.show();
  terminal.sendText(commands.join(separator));
}

export async function connectClient(endpoint: McpEndpoint, paths: DataPaths, serverPath: string): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: 'Claude Code', description: 'stdio · works with or without VS Code open', id: 'claude-code' },
      { label: 'Claude Code (HTTP)', description: 'shares this window\'s live connection; needs VS Code running', id: 'claude-code-http' },
      { label: 'Claude Desktop', description: 'edits claude_desktop_config.json', id: 'claude-desktop' },
      { label: 'Cursor', description: 'edits ~/.cursor/mcp.json', id: 'cursor' },
      { label: 'Windsurf', description: 'edits ~/.codeium/windsurf/mcp_config.json', id: 'windsurf' },
      { label: 'VS Code (Copilot agent mode)', description: 'already registered automatically', id: 'vscode' },
      { label: 'Copy stdio config (JSON)', description: 'for any other MCP client', id: 'copy-stdio' },
      { label: 'Copy HTTP endpoint and token', description: endpoint.url, id: 'copy-http' },
    ],
    { title: 'Connect an AI client to your Overleaf projects' },
  );
  if (!picked) return;
  const launch = await stdioLaunch(serverPath, paths);
  const stdioEntry = { command: launch.command, args: launch.args, ...(launch.env ? { env: launch.env } : {}) };
  const httpEntry = { type: 'http', url: endpoint.url, headers: { Authorization: `Bearer ${endpoint.token}` } };

  switch (picked.id) {
    case 'claude-code': {
      // -e takes several values, so it goes after the name and is closed off by "--".
      const envArgs = Object.entries(launch.env ?? {}).map(([k, v]) => ` -e ${k}=${quote(v)}`).join('');
      runInTerminal([
        'claude mcp remove --scope user overleaf',
        `claude mcp add --scope user overleaf${envArgs} -- ${quote(launch.command)} ${launch.args.map(quote).join(' ')}`,
      ]);
      vscode.window.showInformationMessage('Registering the Overleaf MCP server with Claude Code in the terminal. Start a new Claude Code session to use it.');
      return;
    }
    case 'claude-code-http': {
      if (!endpoint.available) {
        vscode.window.showWarningMessage('The HTTP endpoint is not running. Enable overleafMcp.mcp.httpServer.enabled or use the stdio option.');
        return;
      }
      runInTerminal([
        'claude mcp remove --scope user overleaf',
        `claude mcp add --transport http --scope user overleaf ${endpoint.url} --header "Authorization: Bearer ${endpoint.token}"`,
      ]);
      vscode.window.showInformationMessage('Registering the Overleaf HTTP endpoint with Claude Code in the terminal.');
      return;
    }
    case 'claude-desktop':
    case 'cursor':
    case 'windsurf': {
      const file =
        picked.id === 'claude-desktop'
          ? claudeDesktopConfig()
          : picked.id === 'cursor'
            ? path.join(os.homedir(), '.cursor', 'mcp.json')
            : path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json');
      try {
        await mergeJsonConfig(file, stdioEntry);
      } catch (error) {
        vscode.window.showErrorMessage(`Could not update ${file}: ${(error as Error).message}`);
        return;
      }
      const action = await vscode.window.showInformationMessage(`Added "overleaf" to ${picked.label} (${file}). Restart ${picked.label} to load it.`, 'Open Config');
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
