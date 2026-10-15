/*
 * Launches VS Code with the extension under development and runs test/extension/suite.ts in it.
 * Needs the local Overleaf from test/overleaf-ce/docker-compose.yml.
 *   npm run test:extension
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';
import { OverleafWebClient } from '../../src/core/overleaf/webClient';
import { CredentialStore } from '../../src/core/store/credentials';
import { resolveDataPaths } from '../../src/core/store/paths';
import { SERVER_URL, logger, testSession } from '../integration/helpers';
import { demoAccount } from './demo';

/** --screenshots: take the README screenshots (test/extension/screenshots.ts) instead of running the tests. */
const screenshots = process.argv.includes('--screenshots');
const DEVTOOLS_PORT = 9339;

/** A tidy window for the screenshots. */
const SCREENSHOT_SETTINGS = {
  'workbench.colorTheme': 'Default Dark Modern',
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'workbench.layoutControl.enabled': false,
  'chat.disableAIFeatures': true,
  'editor.minimap.enabled': false,
  'editor.wordWrap': 'on',
  'editor.fontSize': 13,
  'breadcrumbs.enabled': false,
  'update.mode': 'none',
  'extensions.ignoreRecommendations': true,
  'git.enabled': false,
};

/** The repository root: the nearest folder whose package.json is this extension's. */
function findRoot(start: string): string {
  for (let dir = start; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === 'overleaf-mcp') return dir;
  }
  throw new Error(`Could not find the extension root above ${start}`);
}

async function main(): Promise<void> {
  const root = findRoot(__dirname);
  const scratch = mkdtempSync(path.join(tmpdir(), 'overleaf-mcp-ext-'));
  const home = path.join(scratch, 'home');
  const userData = path.join(scratch, 'user-data');
  mkdirSync(path.join(userData, 'User'), { recursive: true });
  writeFileSync(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify({ 'overleafMcp.serverUrl': SERVER_URL, 'overleafMcp.mcp.httpServer.port': 39848, ...(screenshots ? SCREENSHOT_SETTINGS : {}) }, null, 2),
  );

  // Sign in the way `overleaf-mcp login` would; the extension adopts this session on startup.
  const env: Record<string, string> = { OVERLEAF_MCP_HOME: home, OVERLEAF_TEST_URL: SERVER_URL };
  let session;
  if (screenshots) {
    const demo = await demoAccount();
    session = demo.session;
    env.OVERLEAF_DEMO_PROJECTS = JSON.stringify(demo.projects);
    env.OVERLEAF_SCREENSHOT_DIR = path.join(root, 'assets', 'screenshots');
    env.OVERLEAF_SCREENSHOT_PORT = String(DEVTOOLS_PORT);
  } else {
    session = await testSession();
    const web = new OverleafWebClient({ serverUrl: SERVER_URL, cookies: session.cookies, logger });
    env.OVERLEAF_TEST_PROJECT = await web.createProject(`vscode-e2e-${Date.now()}`, 'example');
  }
  await new CredentialStore(resolveDataPaths(home).credentialsFile).write({ ...session, method: 'cli' });

  // When launched from a VS Code terminal this is inherited and would make Code.exe behave as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const extensionsDir = path.join(scratch, 'extensions');
  // --vsix: test the packaged extension as installed, not the source folder.
  const vsix = process.argv.find((arg) => arg.endsWith('.vsix'));
  let developmentPath = root;
  const launchArgs = ['--user-data-dir', userData, '--extensions-dir', extensionsDir, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'];
  if (vsix) {
    const executable = process.env.VSCODE_EXECUTABLE || (await downloadAndUnzipVSCode());
    const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable);
    execFileSync(cli, [...cliArgs, '--extensions-dir', extensionsDir, '--install-extension', path.resolve(vsix)], { stdio: 'inherit', shell: process.platform === 'win32' });
    // runTests needs some development extension; an empty one leaves the installed package in charge.
    developmentPath = path.join(scratch, 'placeholder-extension');
    mkdirSync(developmentPath, { recursive: true });
    writeFileSync(path.join(developmentPath, 'package.json'), JSON.stringify({ name: 'placeholder', publisher: 'test', version: '0.0.0', engines: { vscode: '*' } }));
  } else if (!screenshots) {
    // (Screenshots use an empty extensions folder anyway, and this flag shows a notification.)
    launchArgs.push('--disable-extensions');
  }
  if (screenshots) launchArgs.push(`--remote-debugging-port=${DEVTOOLS_PORT}`);
  try {
    await runTests({
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || undefined,
      extensionDevelopmentPath: developmentPath,
      extensionTestsPath: path.join(root, 'dist-test', screenshots ? 'screenshots.js' : 'suite.js'),
      extensionTestsEnv: env,
      launchArgs,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
