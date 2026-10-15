/* Runs inside a real VS Code extension host (launched by test/extension/run.ts). */
import * as assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as vscode from 'vscode';
import type { OverleafExtensionApi } from '../../src/extension/extension';

const projectId = process.env.OVERLEAF_TEST_PROJECT!;
const home = process.env.OVERLEAF_MCP_HOME!;

async function waitFor(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const tests: Array<[string, (api: OverleafExtensionApi) => Promise<void>]> = [
  ['adopts the session written by the CLI', async (api) => {
    assert.ok(api.auth.current, 'expected a session');
    assert.equal(api.auth.current.serverUrl, process.env.OVERLEAF_TEST_URL);
  }],
  ['registers its commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['overleafMcp.signIn', 'overleafMcp.connectClient', 'overleafMcp.compile', 'overleafMcp.openPdfPreview', 'overleafMcp.syncToPdf', 'overleafMcp.pinProject']) assert.ok(commands.includes(id), id);
  }],
  ['lists projects in the side panel and expands one into files', async (api) => {
    const roots = await api.view.getChildren();
    const project = roots.find((node) => node.kind === 'project' && node.project.id === projectId);
    assert.ok(project, 'test project should be listed');
    const files = await api.view.getChildren(project);
    const names = files.map((node) => (node.kind === 'entry' ? node.entry.path : ''));
    assert.ok(names.includes('main.tex'), names.join(','));
    const item = api.view.getTreeItem(files.find((node) => node.kind === 'entry' && node.entry.path === 'main.tex')!);
    assert.equal(item.description, 'main');
  }],
  ['reads, edits and saves a file through the overleaf: file system', async (api) => {
    const uri = vscode.Uri.parse(`overleaf://${projectId}/main.tex`);
    const document = await vscode.workspace.openTextDocument(uri);
    assert.match(document.getText(), /\\documentclass/);
    const editor = await vscode.window.showTextDocument(document);
    await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), '% saved from VS Code\n'));
    assert.ok(await document.save(), 'save should succeed');
    const remote = await api.service.readFile(projectId, 'main.tex');
    assert.ok(remote.content.text.startsWith('% saved from VS Code\n'), 'the save should reach Overleaf');
  }],
  ['shows a collaborator\'s (or AI\'s) edit live in the open editor', async (api) => {
    const uri = vscode.Uri.parse(`overleaf://${projectId}/main.tex`);
    const document = await vscode.workspace.openTextDocument(uri);
    // Edit through a second, independent connection, like an AI client would.
    await api.service.editFile(projectId, 'main.tex', [{ oldText: '% saved from VS Code', newText: '% changed elsewhere' }]);
    await waitFor(() => document.getText().startsWith('% changed elsewhere'), 'the open document to update');
  }],
  ['merges a save with remote changes made since the file was opened', async (api) => {
    const uri = vscode.Uri.parse(`overleaf://${projectId}/main.tex`);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);
    await editor.edit((builder) => builder.insert(document.lineAt(document.lineCount - 1).range.end, '\n% local tail edit'));
    // Remote change at the other end while the editor has unsaved changes.
    await api.service.editFile(projectId, 'main.tex', [{ oldText: '% changed elsewhere', newText: '% remote head edit' }]);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await document.save();
    const remote = (await api.service.readFile(projectId, 'main.tex')).content.text;
    assert.ok(remote.startsWith('% remote head edit'), 'remote change survives');
    assert.ok(remote.includes('% local tail edit'), 'local change is saved');
  }],
  ['creates files and folders from VS Code', async (api) => {
    await vscode.workspace.fs.writeFile(vscode.Uri.parse(`overleaf://${projectId}/notes/todo.tex`), Buffer.from('\\section{Todo}\n'));
    const files = await api.service.listFiles(projectId);
    assert.ok(files.tree.entries.some((e) => e.path === 'notes/todo.tex' && e.type === 'doc'));
    const listing = await vscode.workspace.fs.readDirectory(vscode.Uri.parse(`overleaf://${projectId}/notes`));
    assert.deepEqual(listing, [['todo.tex', vscode.FileType.File]]);
  }],
  ['compiles the project and draws the PDF in the preview', async (api) => {
    const rendered = new Promise<{ pages: number }>((resolve) => {
      const subscription = api.previews.onDidRender((event) => {
        if (event.projectId !== projectId) return;
        subscription.dispose();
        resolve(event);
      });
    });
    await vscode.commands.executeCommand('overleafMcp.openPdfPreview', vscode.Uri.parse(`overleaf://${projectId}/main.tex`));
    const result = await Promise.race([rendered, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the preview did not draw a PDF in time')), 120_000))]);
    assert.ok(result.pages >= 1, `pages: ${result.pages}`);
    assert.equal(api.compiler.get(projectId)?.status, 'success');
    assert.ok(api.compiler.get(projectId)?.build?.editorId, 'the build is recorded for SyncTeX');
  }],
  ['finds a source line in the PDF and a PDF spot in the source (SyncTeX)', async (api) => {
    const lines = (await api.service.readFile(projectId, 'main.tex')).content.text.split('\n');
    // A line of body text: the first line starting with a letter after \begin{document}.
    const begin = lines.findIndex((line) => line.includes('\\begin{document}'));
    const index = lines.findIndex((line, i) => i > begin && /^[A-Za-z]/.test(line.trim()));
    assert.ok(index > begin, 'expected body text in main.tex');
    const locations = await api.previews.showInPdf({ projectId, path: 'main.tex', line: index + 1, column: 0 });
    assert.ok(locations.length > 0, 'the line should be found in the PDF');
    const [box] = locations;
    const back = await api.service.syncToCode(projectId, api.compiler.get(projectId)!.build!, box.page, box.h + box.width / 2, box.v);
    assert.equal(back?.file, 'main.tex');
    assert.ok(back && back.line > begin, `line ${back?.line}`);
  }],
  ['recompiles by itself when the project changes', async (api) => {
    const before = api.compiler.get(projectId)!.pdfVersion;
    // An edit made through the MCP tools (same as an AI assistant would).
    const text = (await api.service.readFile(projectId, 'main.tex')).content.text;
    await api.service.writeFile(projectId, 'main.tex', text.replace('\\end{document}', 'Added for the automatic recompile test.\n\n\\end{document}'));
    await waitFor(() => (api.compiler.get(projectId)?.pdfVersion ?? 0) > before && !api.compiler.isCompiling(projectId), 'an automatic recompile', 120_000);
    // A compile must not set off another one by itself.
    const settled = api.compiler.get(projectId)!.pdfVersion;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    assert.equal(api.compiler.get(projectId)!.pdfVersion, settled, 'no further compiles without changes');
    assert.equal(api.compiler.isCompiling(projectId), false);
  }],
  ['saves the auto-compile choice made in the preview', async (api) => {
    await api.previews.setAutoCompile('onSave');
    assert.equal(api.previews.autoCompileMode(), 'onSave');
    assert.equal(vscode.workspace.getConfiguration('overleafMcp').get('pdf.autoCompile'), 'onSave');
    await api.previews.setAutoCompile('onChange');
    assert.equal(api.previews.autoCompileMode(), 'onChange');
  }],
  ['serves the MCP tools over the local HTTP endpoint', async (api) => {
    await waitFor(() => api.endpoint.state === 'hosting', 'the HTTP endpoint');
    const client = new Client({ name: 'extension-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(api.endpoint.url), { requestInit: { headers: { Authorization: `Bearer ${api.endpoint.token}` } } }));
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === 'edit_file'));
    const result = (await client.callTool({ name: 'read_file', arguments: { project: projectId, path: 'notes/todo.tex' } })) as { content: Array<{ text?: string }> };
    assert.match(result.content[0].text ?? '', /\\section\{Todo\}/);
    await client.close();
    const rejected = await fetch(api.endpoint.url, { method: 'POST', headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(rejected.status, 401);
  }],
  ['resumes a local folder sync and pushes local saves', async (api) => {
    const dir = path.join(home, 'mirror-test');
    // Resuming never re-creates a folder the person deleted, so it must exist (as it would after a first sync).
    mkdirSync(dir, { recursive: true });
    await api.service.settings.update((settings) => ({ ...settings, mirrors: [{ projectId, dir }] }));
    await api.mirrors.resumeAll();
    await waitFor(() => api.mirrors.isRunning(projectId) && existsSync(path.join(dir, 'main.tex')), 'the project to download');
    const roots = await api.view.getChildren();
    const project = roots.find((node) => node.kind === 'project' && node.project.id === projectId)!;
    assert.match(String(api.view.getTreeItem(project).contextValue), /mirrored/);
    const file = path.join(dir, 'notes', 'todo.tex');
    await waitFor(() => existsSync(file), 'existing files to sync down');
    writeFileSync(file, '\\section{Todo}\nSaved in the local folder.\n');
    await waitFor(async () => (await api.service.readFile(projectId, 'notes/todo.tex')).content.text.includes('Saved in the local folder.'), 'the local save on Overleaf');
    await api.mirrors.stopSync(projectId);
  }],
  ['installs the stable server copy and ripgrep for other apps', async () => {
    await waitFor(() => existsSync(path.join(home, 'server', 'overleaf-mcp.js')), 'the server copy');
    await waitFor(() => existsSync(path.join(home, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg')), 'the ripgrep copy');
  }],
];

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<OverleafExtensionApi>('ghoshsrinjoy.overleaf-mcp');
  assert.ok(extension, 'extension not found');
  const api = await extension.activate();
  const failures: string[] = [];
  for (const [name, test] of tests) {
    try {
      await test(api);
      console.log(`  ✓ ${name}`);
    } catch (error) {
      console.log(`  ✗ ${name}\n    ${(error as Error).stack ?? error}`);
      failures.push(name);
    }
  }
  console.log(`\n${tests.length - failures.length}/${tests.length} extension tests passed`);
  if (failures.length) throw new Error(`${failures.length} extension test(s) failed: ${failures.join('; ')}`);
}
