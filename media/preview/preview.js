// PDF preview of an Overleaf project. Runs inside a VS Code webview: pdf.js draws the PDF,
// the extension compiles on Overleaf and sends each new PDF here.
const vscode = acquireVsCodeApi();
const settings = JSON.parse(document.getElementById('preview-settings').textContent);
const persisted = vscode.getState() ?? {};
vscode.setState({ ...persisted, projectId: settings.projectId, projectName: settings.projectName });

const $ = (id) => document.getElementById(id);
const container = $('viewerContainer');
const ui = {
  recompile: $('recompile'),
  stop: $('stop'),
  menuButton: $('menuButton'),
  menu: $('menu'),
  status: $('status'),
  problemsButton: $('problemsButton'),
  errorCount: $('errorCount'),
  warningCount: $('warningCount'),
  problems: $('problems'),
  problemList: $('problemList'),
  progress: $('progress'),
  pageNumber: $('pageNumber'),
  pageCount: $('pageCount'),
  zoomSelect: $('zoomSelect'),
  customZoom: $('customZoom'),
  empty: $('empty'),
  emptyText: $('emptyText'),
  emptyAction: $('emptyAction'),
  hint: $('hint'),
  draft: $('draft'),
  stopOnFirstError: $('stopOnFirstError'),
};

const post = (message) => vscode.postMessage(message);
const report = (error) => post({ type: 'error', message: String(error?.stack ?? error?.message ?? error) });
window.addEventListener('error', (event) => report(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => report(event.reason));

let pdfjsLib;
let viewer;
let workerUrl;
/** The document on screen: { task, worker, port, version, doc, reported }. */
let current = null;
/** A document still loading. */
let loading = null;
/** View to restore once the next document's pages exist. */
let restoreView = null;
let pendingHighlight = null;
let highlights = [];
let highlightTimer;
let lastState = null;
let problemsOpen = false;

/* ------------------------------------------------------------------ messages */

window.addEventListener('message', (event) => {
  const message = event.data;
  switch (message?.type) {
    case 'state':
      renderState(message);
      break;
    case 'pdf':
      void showPdf(message.data, message.version);
      break;
    case 'highlight':
      showHighlights(message.locations, message.version);
      break;
    case 'reset':
      void closeDocument();
      break;
  }
});

/* ------------------------------------------------------------------ pdf.js */

const viewerReady = (async () => {
  pdfjsLib = await import(`${settings.pdfjs}/pdf.min.mjs`);
  // pdf_viewer.mjs reads the library from this global.
  globalThis.pdfjsLib = pdfjsLib;
  const { EventBus, PDFLinkService, PDFViewer, LinkTarget } = await import(`${settings.pdfjs}/pdf_viewer.mjs`);
  // Webviews cannot start workers from extension files directly, so start it from a blob.
  const source = await (await fetch(`${settings.pdfjs}/pdf.worker.min.mjs`)).text();
  workerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));

  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK });
  viewer = new PDFViewer({
    container,
    viewer: $('viewer'),
    eventBus,
    linkService,
    textLayerMode: 1,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE,
  });
  linkService.setViewer(viewer);

  eventBus.on('pagesinit', () => {
    const view = restoreView;
    restoreView = null;
    viewer.currentScaleValue = view?.scale ?? 'page-width';
    if (view) {
      container.scrollTop = view.top;
      container.scrollLeft = view.left;
    }
    ui.pageCount.textContent = `/ ${viewer.pagesCount}`;
    ui.pageNumber.max = String(viewer.pagesCount);
    updateEmpty();
    if (pendingHighlight) showHighlights(pendingHighlight.locations, pendingHighlight.version);
  });
  eventBus.on('pagerendered', (event) => {
    if (event.error) report(event.error);
    if (current && !current.reported) {
      current.reported = true;
      post({ type: 'rendered', version: current.version, pages: viewer.pagesCount });
      maybeShowHint();
    }
  });
  eventBus.on('pagechanging', (event) => {
    ui.pageNumber.value = String(event.pageNumber);
  });
  eventBus.on('scalechanging', (event) => {
    showZoom(event.presetValue ?? event.scale);
    rememberView();
  });
  return linkService;
})();

viewerReady.catch((error) => {
  report(error);
  showEmpty(`The PDF viewer could not start: ${error?.message ?? error}`);
});

async function showPdf(data, version) {
  let linkService;
  try {
    linkService = await viewerReady;
  } catch {
    return;
  }
  if (current?.version === version || loading?.version === version) return;
  const port = new Worker(workerUrl, { type: 'module' });
  const worker = new pdfjsLib.PDFWorker({ port });
  const task = pdfjsLib.getDocument({
    data,
    worker,
    cMapUrl: `${settings.pdfjs}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${settings.pdfjs}/standard_fonts/`,
    wasmUrl: `${settings.pdfjs}/wasm/`,
    // Fetch fonts and maps here rather than in the worker (webview resource URLs).
    useWorkerFetch: false,
    enableXfa: false,
  });
  const next = { task, worker, port, version, doc: null, reported: false };
  if (loading) release(loading);
  loading = next;
  updateEmpty();
  try {
    next.doc = await task.promise;
  } catch (error) {
    release(next);
    if (loading === next) {
      loading = null;
      report(error);
      if (!current) showEmpty(`The PDF could not be opened: ${error?.message ?? error}`);
    }
    return;
  }
  if (loading !== next) {
    release(next);
    return;
  }
  loading = null;
  const previous = current;
  restoreView = previous ? captureView() : persisted.view ?? null;
  current = next;
  clearHighlights();
  viewer.setDocument(next.doc);
  linkService.setDocument(next.doc, null);
  if (previous) release(previous);
}

function release(entry) {
  void entry.task
    .destroy()
    .catch(() => undefined)
    .finally(() => {
      entry.worker.destroy();
      entry.port.terminate();
    });
}

async function closeDocument() {
  if (loading) release(loading);
  loading = null;
  if (!current) return;
  const previous = current;
  current = null;
  clearHighlights();
  viewer.setDocument(null);
  (await viewerReady).setDocument(null, null);
  release(previous);
  ui.pageCount.textContent = '/ –';
  updateEmpty();
}

function captureView() {
  return { scale: viewer.currentScaleValue, top: container.scrollTop, left: container.scrollLeft };
}

let rememberTimer;
function rememberView() {
  clearTimeout(rememberTimer);
  rememberTimer = setTimeout(() => {
    if (!current) return;
    vscode.setState({ ...(vscode.getState() ?? {}), view: captureView() });
  }, 300);
}
container.addEventListener('scroll', rememberView, { passive: true });

/* ------------------------------------------------------------------ SyncTeX */

// Double-click a spot in the PDF to open the source that produced it.
container.addEventListener('dblclick', (event) => {
  if (!current || !viewer) return;
  const page = event.target.closest?.('.page');
  if (!page) return;
  const pageNumber = Number(page.dataset.pageNumber);
  const pageView = viewer.getPageView(pageNumber - 1);
  if (!pageView?.viewport) return;
  const rect = page.getBoundingClientRect();
  const [x, y] = pageView.viewport.convertToPdfPoint(event.clientX - rect.left - page.clientLeft, event.clientY - rect.top - page.clientTop);
  // SyncTeX measures from the top left of the page, in PDF points.
  post({ type: 'syncToCode', page: pageNumber, h: x, v: pageView.viewport.viewBox[3] - y });
  window.getSelection()?.removeAllRanges();
});

function showHighlights(locations, version) {
  if (!current || current.version !== version || !viewer?.pagesCount) {
    pendingHighlight = { locations, version };
    return;
  }
  pendingHighlight = null;
  clearHighlights();
  let first = null;
  for (const location of locations) {
    const pageView = viewer.getPageView(location.page - 1);
    if (!pageView?.viewport) continue;
    const { viewport, div } = pageView;
    // Same placement as Overleaf's own preview.
    const viewBoxHeight = viewport.viewBox[3] + 10;
    const [x1, y1] = viewport.convertToViewportPoint(location.h, viewBoxHeight - (location.v + location.height));
    const [x2, y2] = viewport.convertToViewportPoint(location.h + location.width, viewBoxHeight - location.v);
    const left = Math.max(Math.min(x1, x2), 0);
    const right = Math.min(Math.max(x1, x2), div.clientWidth);
    const top = Math.max(Math.min(y1, y2), 0);
    const bottom = Math.min(Math.max(y1, y2), div.clientHeight);
    const box = document.createElement('div');
    box.className = 'synctex-highlight';
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${Math.max(right - left, 2)}px`;
    box.style.height = `${Math.max(bottom - top, 2)}px`;
    div.appendChild(box);
    highlights.push(box);
    first ??= box;
  }
  first?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
  clearTimeout(highlightTimer);
  highlightTimer = setTimeout(clearHighlights, 4000);
}

function clearHighlights() {
  for (const box of highlights) box.remove();
  highlights = [];
}

function maybeShowHint() {
  if ((vscode.getState() ?? {}).hintShown) return;
  vscode.setState({ ...(vscode.getState() ?? {}), hintShown: true });
  ui.hint.hidden = false;
  setTimeout(() => (ui.hint.hidden = true), 6000);
}

/* ------------------------------------------------------------------ toolbar */

function renderState(state) {
  lastState = state;
  const compiling = state.state === 'compiling';
  ui.recompile.classList.toggle('busy', compiling);
  ui.stop.hidden = !compiling;
  ui.progress.hidden = !compiling;

  let status = '';
  let failed = false;
  if (!state.signedIn) status = 'Not signed in';
  else if (compiling) status = 'Compiling…';
  else if (state.state === 'failed') {
    status = state.message ?? 'The compile failed';
    failed = true;
  } else if (state.compiledAt) {
    status = `Compiled ${new Date(state.compiledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${state.draft ? ' · draft' : ''}`;
    if (state.message) status += ` · ${state.message}`;
  }
  ui.status.textContent = status;
  ui.status.title = status;
  ui.status.classList.toggle('error', failed);

  const problems = [...state.errors, ...state.warnings];
  ui.problemsButton.hidden = problems.length === 0;
  ui.errorCount.textContent = String(state.errors.length);
  ui.warningCount.textContent = String(state.warnings.length);
  ui.problemsButton.title = `${state.errors.length} error(s), ${state.warnings.length} warning(s)${state.typesetting ? `, ${state.typesetting} layout note(s) (overfull/underfull boxes) in the Problems panel` : ''}`;
  renderProblems(problems);
  // Errors and no PDF: show them right away.
  if (!state.hasPdf && state.errors.length && !compiling) setProblemsOpen(true);
  if (!problems.length) setProblemsOpen(false);

  for (const radio of document.querySelectorAll('input[name="autoCompile"]')) radio.checked = radio.value === state.autoCompile;
  ui.draft.checked = state.draft;
  ui.stopOnFirstError.checked = state.stopOnFirstError;
  updateEmpty();
}

function renderProblems(problems) {
  ui.problemList.replaceChildren(
    ...problems.map((problem) => {
      const item = document.createElement('li');
      item.className = problem.level;
      const message = document.createElement('span');
      message.className = 'message';
      message.textContent = problem.message;
      item.append(message);
      if (problem.file) {
        const location = document.createElement('span');
        location.className = 'location';
        location.textContent = problem.line ? `${problem.file}:${problem.line}` : problem.file;
        item.append(location);
        item.tabIndex = 0;
        item.title = 'Open in the editor';
        const open = () => post({ type: 'open', file: problem.file, line: problem.line });
        item.addEventListener('click', open);
        item.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open();
          }
        });
      }
      return item;
    }),
  );
}

function setProblemsOpen(open) {
  problemsOpen = open;
  ui.problems.hidden = !open;
  ui.problemsButton.setAttribute('aria-expanded', String(open));
}

function showEmpty(text, action) {
  ui.empty.hidden = false;
  ui.emptyText.textContent = text;
  ui.emptyAction.hidden = !action;
  if (action) ui.emptyAction.textContent = action;
}

function updateEmpty() {
  if (current) {
    ui.empty.hidden = true;
    return;
  }
  const state = lastState;
  if (!state) return showEmpty('Loading…');
  if (!state.signedIn) return showEmpty(`Sign in to Overleaf to compile ${state.projectName}.`, 'Sign In');
  if (loading || state.hasPdf) return showEmpty('Opening the PDF…');
  if (state.state === 'compiling') return showEmpty(`Compiling ${state.projectName}…`);
  if (state.state === 'failed') return showEmpty(state.message ?? 'The compile failed.', 'Recompile');
  return showEmpty(`${state.projectName} has not been compiled yet.`, 'Compile');
}

function showZoom(value) {
  const preset = [...ui.zoomSelect.options].find((option) => option.value === String(value));
  if (preset && preset !== ui.customZoom) {
    ui.customZoom.hidden = true;
    ui.zoomSelect.value = preset.value;
    return;
  }
  ui.customZoom.hidden = false;
  ui.customZoom.textContent = `${Math.round(Number(value) * 100)}%`;
  ui.zoomSelect.value = 'custom';
}

const recompile = () => post({ type: 'recompile' });
ui.recompile.addEventListener('click', recompile);
ui.stop.addEventListener('click', () => post({ type: 'stop' }));
ui.emptyAction.addEventListener('click', () => (lastState?.signedIn ? recompile() : post({ type: 'signIn' })));
ui.problemsButton.addEventListener('click', () => setProblemsOpen(!problemsOpen));
$('logButton').addEventListener('click', () => post({ type: 'log' }));
$('downloadButton').addEventListener('click', () => post({ type: 'download' }));
$('externalButton').addEventListener('click', () => post({ type: 'external' }));

ui.menuButton.addEventListener('click', (event) => {
  event.stopPropagation();
  const open = ui.menu.hidden;
  ui.menu.hidden = !open;
  ui.menuButton.setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', (event) => {
  if (!ui.menu.hidden && !ui.menu.contains(event.target)) {
    ui.menu.hidden = true;
    ui.menuButton.setAttribute('aria-expanded', 'false');
  }
});
for (const radio of document.querySelectorAll('input[name="autoCompile"]')) {
  radio.addEventListener('change', () => radio.checked && post({ type: 'autoCompile', value: radio.value }));
}
for (const box of [ui.draft, ui.stopOnFirstError]) {
  box.addEventListener('change', () => post({ type: 'options', draft: ui.draft.checked, stopOnFirstError: ui.stopOnFirstError.checked }));
}

ui.pageNumber.addEventListener('change', () => {
  if (!viewer?.pagesCount) return;
  const page = Math.min(Math.max(1, Math.round(Number(ui.pageNumber.value)) || 1), viewer.pagesCount);
  viewer.currentPageNumber = page;
  ui.pageNumber.value = String(page);
});
ui.zoomSelect.addEventListener('change', () => {
  if (viewer?.pagesCount && ui.zoomSelect.value !== 'custom') viewer.currentScaleValue = ui.zoomSelect.value;
});
$('zoomIn').addEventListener('click', () => viewer?.pagesCount && viewer.increaseScale());
$('zoomOut').addEventListener('click', () => viewer?.pagesCount && viewer.decreaseScale());
// Ctrl/Cmd + wheel (and trackpad pinch) zooms around the pointer.
container.addEventListener(
  'wheel',
  (event) => {
    if (!(event.ctrlKey || event.metaKey) || !viewer?.pagesCount) return;
    event.preventDefault();
    viewer.updateScale({ steps: event.deltaY < 0 ? 1 : -1, origin: [event.clientX, event.clientY], drawingDelay: 250 });
  },
  { passive: false },
);
document.addEventListener('keydown', (event) => {
  if ((settings.mac ? event.metaKey : event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    recompile();
  }
  if (event.key === 'Escape') {
    ui.menu.hidden = true;
    ui.menuButton.setAttribute('aria-expanded', 'false');
  }
});

updateEmpty();
post({ type: 'ready' });
