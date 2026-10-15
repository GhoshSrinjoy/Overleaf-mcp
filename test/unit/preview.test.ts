import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { synctexPath } from '../../src/core/service';
import { previewHtml } from '../../src/extension/previewHtml';
import { SERVER_VERSION } from '../../src/mcp/server';

describe('SyncTeX file names', () => {
  it('names files relative to the main document folder', () => {
    expect(synctexPath('main.tex', 'main.tex')).toBe('main.tex');
    expect(synctexPath('chapters/intro.tex', 'main.tex')).toBe('chapters/intro.tex');
    expect(synctexPath('paper/intro.tex', 'paper/main.tex')).toBe('paper/./intro.tex');
    expect(synctexPath('paper/sections/a.tex', 'paper/main.tex')).toBe('paper/./sections/a.tex');
    expect(synctexPath('other/intro.tex', 'paper/main.tex')).toBe('other/intro.tex');
    expect(synctexPath('intro.tex')).toBe('intro.tex');
  });
});

describe('PDF preview page', () => {
  const page = (projectName: string) =>
    previewHtml({
      cspSource: 'https://webview.example',
      asset: (...parts) => `https://webview.example/media/${parts.join('/')}`,
      nonce: 'n0nce',
      projectId: '0123456789abcdef01234567',
      projectName,
      title: `PDF · ${projectName}`,
      mac: false,
    });

  it('only runs its own script and allows what pdf.js needs', () => {
    const html = page('Thesis');
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-n0nce' https://webview.example 'wasm-unsafe-eval'");
    expect(csp).toContain('worker-src blob:');
    expect(csp.split(/[;\s]+/)).not.toContain("'unsafe-eval'");
    expect(html).toContain('<script type="module" nonce="n0nce" src="https://webview.example/media/preview/preview.js">');
  });

  it('cannot be broken out of by a project name', () => {
    const html = page('</script><script>alert(1)</script> & "quotes"');
    const settings = /<script id="preview-settings" type="application\/json">(.*?)<\/script>/s.exec(html)?.[1] ?? '';
    expect(settings).not.toContain('<');
    expect(JSON.parse(settings).projectName).toBe('</script><script>alert(1)</script> & "quotes"');
    expect(html).toContain('<title>PDF · &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;</title>');
    expect(html.match(/<script/g)).toHaveLength(2);
  });
});

describe('versions', () => {
  it('reports the package version from the MCP server', () => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as { version: string };
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});
