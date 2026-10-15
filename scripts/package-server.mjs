// Builds the ready-to-download forms of the MCP server into build/release:
//   overleaf-mcp.js        one file; run it with `node overleaf-mcp.js` (Node.js 20+)
//   overleaf-live-mcp.tgz  the npm package (`npx -y <url or name>`, `npm install -g`)
//   overleaf-mcp.mcpb      Claude Desktop extension bundle (double-click to install)
//   overleaf-mcp.vsix      the VS Code extension (with --vsix)
// Names carry no version, so .../releases/latest/download/<name> always points at the newest.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { strToU8, zipSync } from 'fflate';

const REPO = 'https://github.com/GhoshSrinjoy/Overleaf-mcp';
const NPM_NAME = 'overleaf-live-mcp';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const out = 'build';
const release = `${out}/release`;
const windows = process.platform === 'win32';

rmSync(out, { recursive: true, force: true });
mkdirSync(release, { recursive: true });

execFileSync(process.execPath, ['esbuild.mjs', '--server', '--production'], { stdio: 'inherit' });
const server = readFileSync('dist/mcp-server.js');
writeFileSync(`${release}/overleaf-mcp.js`, server);

// The tool list comes from the server itself, so the bundle manifest cannot drift from it.
const home = mkdtempSync(path.join(tmpdir(), 'overleaf-mcp-package-'));
const client = new Client({ name: 'packager', version: pkg.version });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/mcp-server.js', '--home', home], stderr: 'ignore' }));
const { tools } = await client.listTools();
await client.close();
rmSync(home, { recursive: true, force: true });
const firstSentence = (text = '') => (/^.*?[.!?](\s|$)/s.exec(text.trim())?.[0] ?? text).trim();

/* ------------------------------------------------------------------ npm package */

const npmDir = `${out}/npm`;
mkdirSync(npmDir, { recursive: true });
writeFileSync(`${npmDir}/overleaf-mcp.js`, server);
cpSync('LICENSE', `${npmDir}/LICENSE`);
cpSync('packaging/README.npm.md', `${npmDir}/README.md`);
writeFileSync(
  `${npmDir}/package.json`,
  `${JSON.stringify(
    {
      name: NPM_NAME,
      version: pkg.version,
      description: 'MCP server for Overleaf: search, read, edit and compile your Overleaf projects live from any AI assistant.',
      keywords: ['overleaf', 'latex', 'mcp', 'mcp-server', 'model-context-protocol'],
      license: pkg.license,
      author: pkg.author,
      repository: { type: 'git', url: `git+${REPO}.git` },
      homepage: `${REPO}#readme`,
      bugs: `${REPO}/issues`,
      bin: { [NPM_NAME]: 'overleaf-mcp.js' },
      files: ['overleaf-mcp.js', 'README.md', 'LICENSE'],
      engines: { node: '>=20' },
    },
    null,
    2,
  )}\n`,
);
// npm is a .cmd script on Windows, which needs a shell.
execFileSync('npm', ['pack', '--silent'], { cwd: npmDir, stdio: ['ignore', 'pipe', 'inherit'], shell: windows });
const tarball = readdirSync(npmDir).find((file) => file.endsWith('.tgz'));
renameSync(`${npmDir}/${tarball}`, `${release}/${NPM_NAME}.tgz`);

/* ------------------------------------------------------------------ Claude Desktop bundle */

const manifest = {
  manifest_version: '0.2',
  name: 'overleaf-mcp',
  display_name: 'Overleaf',
  version: pkg.version,
  description: 'Search, read, edit and compile your Overleaf projects, live.',
  long_description:
    'Gives Claude live access to your Overleaf projects: list and search them, read files and outlines, make exact edits (optionally as tracked changes), upload files, compile with errors reported as file:line, and browse history. Edits merge with collaborators in real time.\n\nAfter installing, ask Claude to sign in to Overleaf: it opens the Overleaf login page in your browser. Works with overleaf.com and self-hosted Overleaf.',
  author: { name: pkg.author, url: 'https://github.com/GhoshSrinjoy' },
  repository: { type: 'git', url: REPO },
  homepage: REPO,
  documentation: `${REPO}#readme`,
  support: `${REPO}/issues`,
  icon: 'icon.png',
  server: {
    type: 'node',
    entry_point: 'server/overleaf-mcp.js',
    mcp_config: { command: 'node', args: ['${__dirname}/server/overleaf-mcp.js'], env: {} },
  },
  tools: tools.map((tool) => ({ name: tool.name, description: firstSentence(tool.description) })),
  keywords: ['overleaf', 'latex', 'papers', 'writing'],
  license: pkg.license,
  compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: '>=20.0.0' } },
};
const mcpbDir = `${out}/mcpb`;
mkdirSync(`${mcpbDir}/server`, { recursive: true });
writeFileSync(`${mcpbDir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(`${mcpbDir}/server/overleaf-mcp.js`, server);
cpSync('media/icon.png', `${mcpbDir}/icon.png`);
cpSync('LICENSE', `${mcpbDir}/LICENSE`);
writeFileSync(
  `${release}/overleaf-mcp.mcpb`,
  zipSync(
    {
      'manifest.json': strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
      'server/overleaf-mcp.js': server,
      'icon.png': readFileSync('media/icon.png'),
      LICENSE: readFileSync('LICENSE'),
    },
    { level: 9 },
  ),
);

/* ------------------------------------------------------------------ VS Code extension */

if (process.argv.includes('--vsix')) {
  execFileSync('npx', ['vsce', 'package', '--no-dependencies', '-o', `${release}/overleaf-mcp.vsix`], { stdio: 'inherit', shell: windows });
}

console.log(`\nRelease files in ${release}:`);
for (const file of readdirSync(release)) console.log(`  ${file}`);
