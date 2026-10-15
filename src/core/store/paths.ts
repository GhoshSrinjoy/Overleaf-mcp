import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Everything the extension and the MCP server processes share lives under one directory
 * (default ~/.overleaf-mcp, override with OVERLEAF_MCP_HOME).
 */
export interface DataPaths {
  root: string;
  /** Session cookie shared with MCP servers started outside VS Code. */
  credentialsFile: string;
  /** Pinned projects and tool locations, written by the extension. */
  settingsFile: string;
  /** Read-only snapshots of project files used for search and outlines. */
  cacheDir: string;
  locksDir: string;
  /** Stable copy of the MCP server so client configs survive extension updates. */
  serverDir: string;
  /** Local two-way mirror folders (default location). */
  mirrorsDir: string;
}

export function defaultDataRoot(): string {
  return process.env.OVERLEAF_MCP_HOME?.trim() || path.join(os.homedir(), '.overleaf-mcp');
}

export function resolveDataPaths(root = defaultDataRoot()): DataPaths {
  return {
    root,
    credentialsFile: path.join(root, 'credentials.json'),
    settingsFile: path.join(root, 'settings.json'),
    cacheDir: path.join(root, 'cache'),
    locksDir: path.join(root, 'locks'),
    serverDir: path.join(root, 'server'),
    mirrorsDir: path.join(root, 'mirrors'),
  };
}
