/** Markup of the PDF preview webview (no VS Code imports, so it can be rendered outside VS Code). */
export interface PreviewPage {
  /** Origin(s) the webview may load extension files from (Webview.cspSource). */
  cspSource: string;
  /** URL of a file under media/. */
  asset: (...parts: string[]) => string;
  nonce: string;
  projectId: string;
  projectName: string;
  title: string;
  mac: boolean;
}

const svg = (body: string) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const ICONS = {
  refresh: svg('<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/>'),
  stop: svg('<rect x="4" y="4" width="8" height="8" rx="1"/>'),
  chevron: svg('<path d="M4 6l4 4 4-4"/>'),
  error: svg('<circle cx="8" cy="8" r="6"/><path d="M6 6l4 4M10 6l-4 4"/>'),
  warning: svg('<path d="M8 2l6.5 11.5h-13z"/><path d="M8 6.5v3M8 11.6v.1"/>'),
  zoomIn: svg('<path d="M3.5 8h9M8 3.5v9"/>'),
  zoomOut: svg('<path d="M3.5 8h9"/>'),
  log: svg('<path d="M3 3.5h10M3 6.5h10M3 9.5h6M3 12.5h8"/>'),
  download: svg('<path d="M8 2.5v8M4.5 7L8 10.5 11.5 7"/><path d="M3 13.5h10"/>'),
  external: svg('<path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5"/><path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/>'),
};

const escape = (value: string) => value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function previewHtml(page: PreviewPage): string {
  const { asset, cspSource, nonce } = page;
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} blob: data:`,
    `font-src ${cspSource} blob: data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    // pdf.js decodes some images with WebAssembly.
    `script-src 'nonce-${nonce}' ${cspSource} 'wasm-unsafe-eval'`,
    'worker-src blob:',
    `connect-src ${cspSource} blob: data:`,
  ].join('; ');
  const settings = { projectId: page.projectId, projectName: page.projectName, pdfjs: asset('pdfjs'), mac: page.mac };
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset('pdfjs', 'pdf_viewer.css')}">
<link rel="stylesheet" href="${asset('preview', 'preview.css')}">
<title>${escape(page.title)}</title>
</head>
<body>
<header id="toolbar" role="toolbar" aria-label="PDF preview">
  <div class="group">
    <button id="recompile" class="primary" title="Recompile (${page.mac ? '⌘' : 'Ctrl'}+Enter)">${ICONS.refresh}<span>Recompile</span></button>
    <button id="stop" class="icon" title="Stop compiling" hidden>${ICONS.stop}</button>
    <button id="menuButton" class="icon" title="Compile options" aria-haspopup="true" aria-expanded="false">${ICONS.chevron}</button>
    <span id="status" class="status" role="status" aria-live="polite"></span>
  </div>
  <button id="problemsButton" class="chip" title="Errors and warnings" aria-expanded="false" hidden>
    <span class="count error">${ICONS.error}<b id="errorCount">0</b></span>
    <span class="count warning">${ICONS.warning}<b id="warningCount">0</b></span>
  </button>
  <div class="spacer"></div>
  <div class="group" id="navigation">
    <input id="pageNumber" type="number" min="1" value="1" aria-label="Page number"><span id="pageCount" class="muted">/ –</span>
    <button id="zoomOut" class="icon" title="Zoom out">${ICONS.zoomOut}</button>
    <select id="zoomSelect" aria-label="Zoom">
      <option value="auto">Automatic</option>
      <option value="page-width">Page width</option>
      <option value="page-fit">Whole page</option>
      <option value="0.5">50%</option>
      <option value="0.75">75%</option>
      <option value="1">100%</option>
      <option value="1.25">125%</option>
      <option value="1.5">150%</option>
      <option value="2">200%</option>
      <option value="3">300%</option>
      <option id="customZoom" value="custom" hidden></option>
    </select>
    <button id="zoomIn" class="icon" title="Zoom in">${ICONS.zoomIn}</button>
  </div>
  <div class="group">
    <button id="logButton" class="icon" title="Show the raw compile log">${ICONS.log}</button>
    <button id="downloadButton" class="icon" title="Save the PDF…">${ICONS.download}</button>
    <button id="externalButton" class="icon" title="Open in your PDF viewer">${ICONS.external}</button>
  </div>
</header>
<div id="menu" class="menu" role="menu" hidden>
  <div class="menu-title">Recompile automatically</div>
  <label><input type="radio" name="autoCompile" value="onChange"> On any change <small>your saves, collaborators, AI edits</small></label>
  <label><input type="radio" name="autoCompile" value="onSave"> When you save</label>
  <label><input type="radio" name="autoCompile" value="off"> Never</label>
  <div class="menu-separator"></div>
  <div class="menu-title">Compile options</div>
  <label><input type="checkbox" id="draft"> Draft mode <small>faster, leaves images out</small></label>
  <label><input type="checkbox" id="stopOnFirstError"> Stop on first error</label>
</div>
<section id="problems" aria-label="Errors and warnings" hidden><ul id="problemList"></ul></section>
<div id="progress" hidden></div>
<div id="stage">
  <div id="viewerContainer" tabindex="0"><div id="viewer" class="pdfViewer"></div></div>
  <div id="empty"><p id="emptyText">Loading the viewer…</p><button id="emptyAction" class="primary" hidden></button></div>
</div>
<div id="hint" class="hint" hidden>Double-click the PDF to jump to the source.</div>
<script id="preview-settings" type="application/json">${JSON.stringify(settings).replace(/</g, '\\u003c')}</script>
<script type="module" nonce="${nonce}" src="${asset('preview', 'preview.js')}"></script>
</body>
</html>`;
}
