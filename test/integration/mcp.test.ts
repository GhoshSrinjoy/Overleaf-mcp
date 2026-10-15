import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CredentialStore } from '../../src/core/store/credentials';
import { resolveDataPaths } from '../../src/core/store/paths';
import { SERVER_URL, serverAvailable, testSession } from './helpers';

const SERVER_BUNDLE = path.resolve(__dirname, '../../dist/mcp-server.js');
const available = (await serverAvailable()) && (() => {
  try {
    return statSync(SERVER_BUNDLE).isFile();
  } catch {
    return false;
  }
})();

type ToolResult = { content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean };

describe.skipIf(!available)('MCP server end to end (stdio)', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'overleaf-mcp-test-'));
  let client: Client;
  const projectName = `mcp-e2e-${Date.now()}`;

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  const textOf = (result: ToolResult) => result.content.map((c) => c.text ?? '').join('\n');

  beforeAll(async () => {
    const session = await testSession();
    await new CredentialStore(resolveDataPaths(home).credentialsFile).write(session);
    client = new Client({ name: 'overleaf-mcp-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER_BUNDLE, '--home', home], stderr: 'ignore' }));
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('advertises the tool set', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of ['status', 'list_projects', 'read_file', 'edit_file', 'write_file', 'grep', 'search', 'get_outline', 'compile', 'history']) {
      expect(names).toContain(expected);
    }
  });

  it('reports the signed-in account', async () => {
    expect(textOf(await call('status'))).toContain(`Signed in to ${SERVER_URL}`);
  });

  it('signs in through the sign_in tool with a pasted session cookie', async () => {
    const session = await testSession();
    const result = await call('sign_in', { cookie: session.cookies, server: SERVER_URL });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain(`Signed in to ${SERVER_URL}`);
    expect(textOf(await call('status'))).toContain(`Signed in to ${SERVER_URL}`);
  });

  it('creates a project, pins it, and works without naming it', async () => {
    expect(textOf(await call('create_project', { name: projectName, template: 'example' }))).toContain(projectName);
    expect(textOf(await call('pin_projects', { projects: [projectName] }))).toContain(projectName);
    const files = textOf(await call('list_files'));
    expect(files).toContain('main.tex  ← main document');
    expect(textOf(await call('list_projects', { query: projectName }))).toContain('📌');
  });

  it('reads files with line ranges', async () => {
    const result = textOf(await call('read_file', { path: 'main.tex', startLine: 1, endLine: 3, lineNumbers: true }));
    expect(result).toMatch(/lines 1-3 of \d+/);
    expect(result).toContain('1\t\\documentclass');
  });

  it('edits with exact replacement, refuses ambiguity, and supports suggest mode', async () => {
    const dry = textOf(await call('edit_file', { path: 'main.tex', edits: [{ oldText: '\\documentclass', newText: '\\documentclass' }], dryRun: true }));
    expect(dry).toMatch(/identical/);

    const ambiguous = await call('edit_file', { path: 'main.tex', edits: [{ oldText: '\\', newText: '/' }] });
    expect(ambiguous.isError).toBe(true);
    expect(textOf(ambiguous)).toMatch(/occurs \d+ times/);

    const edited = textOf(await call('edit_file', { path: 'main.tex', edits: [{ oldText: '\\begin{document}', newText: '\\begin{document}\n% MCP-EDIT-MARKER' }] }));
    expect(edited).toMatch(/Edited main\.tex .*1 replacement/);
    expect(edited).toContain('+% MCP-EDIT-MARKER');

    const suggested = textOf(await call('edit_file', { path: 'main.tex', edits: [{ oldText: '% MCP-EDIT-MARKER', newText: '% MCP-SUGGESTED-MARKER' }], suggest: true }));
    expect(suggested).toContain('Suggested changes to main.tex');
    expect(textOf(await call('read_file', { path: 'main.tex', startLine: 1, endLine: 2 }))).toMatch(/pending tracked change/);
  });

  it('writes new files into new folders and outlines across \\input', async () => {
    const created = textOf(await call('write_file', { path: 'chapters/extra.tex', content: '\\section{Extra Chapter}\nUnique phrase zebra-quantum-lattice.\n\\subsection{Deeper}\nMore text.\n' }));
    expect(created).toContain('Created chapters/extra.tex');
    await call('edit_file', { path: 'main.tex', edits: [{ oldText: '\\end{document}', newText: '\\input{chapters/extra}\n\\end{document}' }] });
    const outline = textOf(await call('get_outline'));
    expect(outline).toMatch(/- Extra Chapter\s+\[section, chapters\/extra\.tex:1\]/);
    expect(outline).toMatch(/Deeper\s+\[subsection, chapters\/extra\.tex:3\]/);
    const section = textOf(await call('get_section', { title: 'extra chapter' }));
    expect(section).toContain('chapters/extra.tex lines 1-4');
    expect(section).toContain('\\subsection{Deeper}');
  });

  it('greps and ranks passages across projects', async () => {
    const grep = textOf(await call('grep', { query: 'zebra-quantum-lattice', refresh: true }));
    expect(grep).toMatch(/chapters\/extra\.tex:2: Unique phrase zebra-quantum-lattice/);
    const regex = textOf(await call('grep', { query: '\\\\section\\{[A-Z]', regex: true, include: ['*.tex'] }));
    expect(regex).toMatch(/match\(es\)/);
    const ranked = textOf(await call('search', { query: 'quantum lattice zebra' }));
    expect(ranked).toMatch(/^1\. .*chapters\/extra\.tex:1-/m);
  });

  it('compiles and reports a planted error with file and line', async () => {
    const ok = textOf(await call('compile'));
    expect(ok).toMatch(/: success, \d+ page/);
    await call('edit_file', { path: 'chapters/extra.tex', edits: [{ oldText: 'More text.', newText: 'More text \\undefinedmacro.' }] });
    await new Promise((r) => setTimeout(r, 1200));
    const failing = textOf(await call('compile'));
    expect(failing).toMatch(/Errors \(\d+\):/);
    expect(failing).toMatch(/chapters\/extra\.tex:4: Undefined control sequence/);
  }, 240_000);

  it('moves and deletes files', async () => {
    expect(textOf(await call('move_file', { from: 'chapters/extra.tex', to: 'parts/renamed.tex' }))).toContain('Moved');
    expect(textOf(await call('list_files'))).toContain('renamed.tex');
    expect(textOf(await call('delete_file', { path: 'parts/renamed.tex' }))).toContain('Deleted');
    const missing = await call('read_file', { path: 'parts/renamed.tex' });
    expect(missing.isError).toBe(true);
  });

  it('shows project history and diffs', async () => {
    const history = textOf(await call('history', { limit: 5 }));
    expect(history).toMatch(/v\d+→v\d+/);
    const match = /v(\d+)→v(\d+)/.exec(history)!;
    const diff = await call('history_diff', { path: 'main.tex', fromVersion: 0, toVersion: Number(match[2]) });
    expect(diff.isError).toBeFalsy();
  });

  it('returns images as image content', async () => {
    const image = await call('read_file', { path: 'frog.jpg' });
    expect(image.content.some((c) => c.type === 'image' && (c.data?.length ?? 0) > 1000)).toBe(true);
  });
});
