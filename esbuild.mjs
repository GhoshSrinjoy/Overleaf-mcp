// Bundles the VS Code extension and the standalone MCP server into dist/.
// Both bundles are self-contained: the server runs with plain `node dist/mcp-server.js`.
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
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

/** pdf.js for the PDF preview, copied into media/pdfjs (it runs in the webview as-is). */
async function copyPdfjs() {
  const from = 'node_modules/pdfjs-dist';
  const to = 'media/pdfjs';
  rmSync(to, { recursive: true, force: true });
  mkdirSync(`${to}/wasm`, { recursive: true });
  for (const [source, target] of [
    ['build/pdf.min.mjs', 'pdf.min.mjs'],
    ['build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
    ['web/pdf_viewer.css', 'pdf_viewer.css'],
    ['web/images', 'images'],
    ['cmaps', 'cmaps'],
    ['standard_fonts', 'standard_fonts'],
    ['LICENSE', 'LICENSE'],
  ]) {
    cpSync(`${from}/${source}`, `${to}/${target}`, { recursive: true });
  }
  // Image decoders; the scripting engine is left out (scripts in PDFs are not run).
  for (const file of readdirSync(`${from}/wasm`)) {
    if (/^(openjpeg|jbig2|qcms_bg)\.wasm$|^LICENSE/.test(file)) cpSync(`${from}/wasm/${file}`, `${to}/wasm/${file}`);
  }
  // The viewer ships unminified.
  await esbuild.build({ entryPoints: [`${from}/web/pdf_viewer.mjs`], outfile: `${to}/pdf_viewer.mjs`, minify: true, format: 'esm', target: 'esnext', logLevel: 'warning' });
}

if (!serverOnly) await copyPdfjs();

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
