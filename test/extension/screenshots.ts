/*
 * Takes the README screenshots inside a real VS Code (launched by `npm run screenshots`):
 * sets up each scene through the extension and captures the window over the DevTools protocol.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import WebSocket from 'ws';
import type { OverleafExtensionApi } from '../../src/extension/extension';
import type { DemoProjects } from './demo';

const projects = JSON.parse(process.env.OVERLEAF_DEMO_PROJECTS!) as DemoProjects;
const outDir = process.env.OVERLEAF_SCREENSHOT_DIR!;
const port = process.env.OVERLEAF_SCREENSHOT_PORT!;
const WIDTH = 1680;
const HEIGHT = 960;
/** The title bar of a test window says "[Extension Development Host]"; leave it out. */
const TITLE_BAR = 35;

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A DevTools protocol connection to one page or frame. */
class Cdp {
  private id = 0;
  private readonly pending = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      this.pending.get(message.id)?.(message);
      this.pending.delete(message.id);
    });
  }

  static async open(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return new Cdp(ws);
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) =>
      this.pending.set(id, (message) => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result as T))),
    );
  }

  close(): void {
    this.ws.close();
  }
}

interface Target {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

async function targets(): Promise<Target[]> {
  return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Target[];
}

async function workbench(): Promise<Cdp> {
  const page = (await targets()).find((t) => t.type === 'page' && /workbench/.test(t.url));
  if (!page) throw new Error('VS Code window not found over the DevTools protocol');
  const cdp = await Cdp.open(page.webSocketDebuggerUrl);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  return cdp;
}

/** Clicks an element in the PDF preview of a project (webviews are frames of their own). */
async function clickInPreview(window: Cdp, projectName: string, elementId: string): Promise<boolean> {
  const expression = `(() => {
    const docs = [document, ...[...document.querySelectorAll('iframe')].map((f) => { try { return f.contentDocument; } catch { return null; } })].filter(Boolean);
    const doc = docs.find((d) => d.getElementById(${JSON.stringify(elementId)}) && d.title.includes(${JSON.stringify(projectName)}));
    if (!doc) return false;
    doc.getElementById(${JSON.stringify(elementId)}).click();
    return true;
  })()`;
  // Webviews may run as separate frame targets…
  for (const target of (await targets()).filter((t) => t.url.startsWith('vscode-webview://'))) {
    const frame = await Cdp.open(target.webSocketDebuggerUrl);
    try {
      const { result } = await frame.send<{ result: { value?: boolean } }>('Runtime.evaluate', { expression, returnByValue: true });
      if (result.value) return true;
    } finally {
      frame.close();
    }
  }
  // …or as frames inside the window.
  const { frameTree } = await window.send<{ frameTree: FrameTree }>('Page.getFrameTree');
  for (const frame of flatten(frameTree)) {
    if (!frame.url.startsWith('vscode-webview://')) continue;
    try {
      const { executionContextId } = await window.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'screenshots' });
      const { result } = await window.send<{ result: { value?: boolean } }>('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true });
      if (result.value) return true;
    } catch {
      // not reachable from here
    }
  }
  console.log(`  (could not click #${elementId} in the preview of ${projectName})`);
  return false;
}

interface FrameTree {
  frame: { id: string; url: string };
  childFrames?: FrameTree[];
}

function flatten(tree: FrameTree): Array<{ id: string; url: string }> {
  return [tree.frame, ...(tree.childFrames ?? []).flatMap(flatten)];
}

/** `keepTitleBar` for shots where a quick pick sits over the title bar (and hides its text). */
async function shot(window: Cdp, name: string, keepTitleBar = false): Promise<void> {
  await vscode.commands.executeCommand('notifications.clearAll');
  await settle(300);
  const top = keepTitleBar ? 0 : TITLE_BAR;
  const clip = { x: 0, y: top, width: WIDTH, height: HEIGHT - top, scale: 1 };
  const { data } = await window.send<{ data: string }>('Page.captureScreenshot', { format: 'png', clip });
  writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`  ✓ ${name}.png`);
}

function rendered(api: OverleafExtensionApi, projectId: string, timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      subscription.dispose();
      reject(new Error(`The preview of ${projectId} did not draw in time`));
    }, timeoutMs);
    const subscription = api.previews.onDidRender((event) => {
      if (event.projectId !== projectId) return;
      clearTimeout(timer);
      subscription.dispose();
      resolve();
    });
  });
}

async function edit(api: OverleafExtensionApi, projectId: string, replacements: Array<[string, string]>): Promise<void> {
  const text = (await api.service.readFile(projectId, 'main.tex')).content.text;
  // The demo account is reused between runs: skip edits that are already in place.
  const edits = replacements.filter(([from, to]) => text.includes(from) && !text.includes(to)).map(([oldText, newText]) => ({ oldText, newText }));
  if (edits.length) await api.service.editFile(projectId, 'main.tex', edits);
}

/** Opens main.tex of a project with the cursor on the first line containing `marker`. */
async function openMain(projectId: string, marker: string, viewColumn = vscode.ViewColumn.One): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: 'overleaf', authority: projectId, path: '/main.tex' }));
  const line = Math.max(0, document.getText().split('\n').findIndex((text) => text.includes(marker)));
  const editor = await vscode.window.showTextDocument(document, { viewColumn });
  editor.selection = new vscode.Selection(line, 0, line, document.lineAt(line).text.length);
  editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
  return editor;
}

async function cleanSlate(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('workbench.action.closePanel');
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
}

export async function run(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const extension = vscode.extensions.getExtension<OverleafExtensionApi>('ghoshsrinjoy.overleaf-mcp')!;
  const api = await extension.activate();
  const window = await workbench();
  try {
    // Demo content.
    await edit(api, projects.paper, [
      ['\\title{Your Paper}', '\\title{Learning Robust Policies from Few Demonstrations}'],
      ['\\author{You}', '\\author{Ada Example \\and Ben Sample}'],
      ['Your abstract.', 'We show how a handful of demonstrations can be turned into robust control policies. A simple augmentation scheme halves the error of strong baselines on three benchmarks.'],
    ]);
    await edit(api, projects.notes, [
      ['\\title{Your Paper}', '\\title{Lecture Notes: Linear Algebra}'],
      ['Your introduction goes here!', 'Your introduction goes here! As shown in \\reff{fig:frog}, the frog is green.'],
    ]);
    await api.service.setPinned([projects.paper], true);
    api.view.refresh();
    await settle(1500);

    // 1. Overview: projects panel, a live Overleaf file, and its PDF.
    await cleanSlate();
    await vscode.commands.executeCommand('workbench.view.extension.overleafMcp');
    await settle(1500);
    const roots = await api.view.getChildren();
    const paper = roots.find((node) => node.kind === 'project' && node.project.id === projects.paper);
    if (paper) await api.treeView.reveal(paper, { expand: true, select: true, focus: false });
    await openMain(projects.paper, '\\section{Introduction}');
    const paperRendered = rendered(api, projects.paper);
    await vscode.commands.executeCommand('overleafMcp.openPdfPreview', vscode.Uri.from({ scheme: 'overleaf', authority: projects.paper, path: '/main.tex' }));
    await paperRendered;
    await settle(7000); // let the first-run hint fade
    await shot(window, 'overview');

    // 2. SyncTeX: a source line highlighted in the PDF.
    const editor = await openMain(projects.paper, 'Your introduction goes here');
    const line = editor.selection.active.line + 1;
    await api.previews.showInPdf({ projectId: projects.paper, path: 'main.tex', line, column: 0 });
    await settle(1200);
    await shot(window, 'synctex');

    // 3. Compile options.
    if (await clickInPreview(window, 'Workshop Paper', 'menuButton')) {
      await settle(600);
      await shot(window, 'compile-options');
      await clickInPreview(window, 'Workshop Paper', 'menuButton');
    }

    // 4. Connecting assistants.
    await cleanSlate();
    await openMain(projects.paper, '\\section{Introduction}');
    await vscode.commands.executeCommand('overleafMcp.openPdfPreview', vscode.Uri.from({ scheme: 'overleaf', authority: projects.paper, path: '/main.tex' }));
    await settle(4000);
    void vscode.commands.executeCommand('overleafMcp.connectClient');
    await settle(2500);
    await shot(window, 'connect', true);
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');

    // 5. Errors: squiggles in the editor, the Problems panel and the preview's list.
    await cleanSlate();
    await openMain(projects.notes, '\\reff');
    const notesRendered = rendered(api, projects.notes).catch(() => undefined);
    await vscode.commands.executeCommand('overleafMcp.openPdfPreview', vscode.Uri.from({ scheme: 'overleaf', authority: projects.notes, path: '/main.tex' }));
    await notesRendered;
    await settle(7000);
    await vscode.commands.executeCommand('workbench.actions.view.problems');
    await clickInPreview(window, 'Lecture Notes', 'problemsButton');
    await settle(1000);
    await shot(window, 'errors');
  } finally {
    window.close();
  }
}
