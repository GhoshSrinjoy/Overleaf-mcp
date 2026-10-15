// Bundles the VS Code extension and the standalone MCP server into dist/.
// Both bundles are self-contained: the server runs with plain `node dist/mcp-server.js`.
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');
// Only the MCP server (Docker image, npm package).
const serverOnly = process.argv.includes('--server');

/** @type {esbuild.BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: production ? false : 'linked',
  minify: production,
  logLevel: 'info',
  // ws tries these optional native addons inside try/catch.
  external: ['bufferutil', 'utf-8-validate'],
};

const builds = [
  {
    ...common,
    entryPoints: ['src/extension/extension.ts'],
    outfile: 'dist/extension.js',
    external: [...common.external, 'vscode'],
  },
  {
    ...common,
    entryPoints: ['src/mcp/cli.ts'],
    outfile: 'dist/mcp-server.js',
    banner: { js: '#!/usr/bin/env node' },
  },
];

if (serverOnly) builds.splice(0, 1);

if (tests) {
  // In-editor test suite and its launcher (see test/extension).
  builds.push(
    { ...common, entryPoints: ['test/extension/suite.ts'], outfile: 'dist-test/suite.js', external: [...common.external, 'vscode'] },
    { ...common, entryPoints: ['test/extension/run.ts'], outfile: 'dist-test/run.js' },
  );
}

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
