const TEXT_EXTENSIONS = new Set([
  'tex', 'latex', 'ltx', 'bib', 'bibtex', 'cls', 'sty', 'bst', 'bbx', 'cbx', 'lbx', 'dbx', 'dtx', 'ins', 'clo', 'cfg', 'def', 'fd', 'ldf',
  'ist', 'gls', 'glo', 'nlo', 'nls', 'acn', 'bbl', 'rnw', 'rtex', 'rmd', 'tikz', 'pgf', 'asy', 'mp', 'lua', 'txt', 'text', 'md', 'markdown',
  'csv', 'tsv', 'dat', 'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm', 'svg', 'css', 'js', 'ts', 'py', 'r', 'm', 'jl', 'sh', 'bat',
  'ps1', 'mk', 'c', 'h', 'cpp', 'hpp', 'java', 'go', 'rs', 'sql', 'ini', 'conf', 'log', 'gitignore', 'latexmkrc', 'editorconfig',
]);

const TEXT_BASENAMES = new Set(['latexmkrc', '.latexmkrc', 'makefile', 'readme', 'license', 'dockerfile', '.gitignore']);

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1);
}

/** Decides from the name alone. `undefined` means "sniff the bytes". */
export function isTextPath(path: string): boolean | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (TEXT_BASENAMES.has(name)) return true;
  const ext = extensionOf(path);
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (['png', 'jpg', 'jpeg', 'gif', 'pdf', 'eps', 'ps', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'tif', 'tiff', 'bmp', 'webp', 'ico',
    'mp4', 'mov', 'avi', 'mp3', 'wav', 'ogg', 'ttf', 'otf', 'woff', 'woff2', 'pfb', 'afm', 'docx', 'xlsx', 'pptx', 'odt', 'heic', 'psd', 'ai',
    'xcf', 'jar', 'exe', 'dll', 'so', 'dylib', 'bin', 'npy', 'npz', 'pkl', 'h5', 'mat', 'fig'].includes(ext)) {
    return false;
  }
  return undefined;
}

/** NUL bytes or invalid UTF-8 in the first 8 KiB mark a file as binary. */
export function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8192);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample.length < bytes.length ? trimPartialUtf8(sample) : sample);
    return true;
  } catch {
    return false;
  }
}

function trimPartialUtf8(sample: Uint8Array): Uint8Array {
  // Don't fail on a multi-byte character cut off at the sample boundary.
  let end = sample.length;
  for (let i = 1; i <= 3 && end - i >= 0; i++) {
    const byte = sample[end - i];
    if ((byte & 0xc0) === 0xc0) return sample.subarray(0, end - i);
    if ((byte & 0x80) === 0) break;
  }
  return sample;
}

export function isTextContent(path: string, bytes: Uint8Array): boolean {
  return isTextPath(path) ?? looksLikeText(bytes);
}

export function decodeText(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8').decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
