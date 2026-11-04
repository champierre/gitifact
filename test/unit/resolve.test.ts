import { describe, it, expect } from 'vitest';
import { rewriteHtml, buildCsp } from '../../src/shared/resolve';
import type { FetchResult } from '../../src/shared/types';

const loc = { owner: 'o', repo: 'r', ref: 'refs/heads/main', refName: 'main', path: 'docs/index.html' };

function repo(files: Record<string, string | Uint8Array>) {
  const calls: string[] = [];
  const fetchRepoFile = async (path: string): Promise<FetchResult> => {
    calls.push(path);
    const f = files[path];
    if (f === undefined) return { ok: false, status: 404, error: 'HTTP 404' };
    if (typeof f === 'string') return { ok: true, status: 200, contentType: 'text/plain', encoding: 'text', body: f };
    return { ok: true, status: 200, contentType: 'application/octet-stream', encoding: 'base64', body: Buffer.from(f).toString('base64') };
  };
  return { calls, fetchRepoFile };
}

async function run(html: string, files: Record<string, string | Uint8Array>, opts: Partial<{ allowScripts: boolean; allowExternal: boolean }> = {}) {
  const r = repo(files);
  const out = await rewriteHtml(html, { location: loc, fetchRepoFile: r.fetchRepoFile, allowScripts: false, allowExternal: false, ...opts });
  const doc = new DOMParser().parseFromString(out.html, 'text/html');
  return { ...out, doc, calls: r.calls };
}

describe('rewriteHtml', () => {
  it('inlines relative stylesheets and resolves url() relative to the CSS file', async () => {
    const { doc, report } = await run('<link rel="stylesheet" href="css/a.css"><p>x</p>', {
      'docs/css/a.css': 'body{background:url(../img/b.png)}',
      'docs/img/b.png': new Uint8Array([1, 2, 3]),
    });
    expect(doc.querySelector('link')).toBeNull();
    const style = doc.querySelector('style')!;
    expect(style.getAttribute('data-gitifact-src')).toBe('docs/css/a.css');
    expect(style.textContent).toContain('url("data:image/png;base64,AQID")');
    expect(report.resolved).toBe(2);
    expect(report.warnings).toEqual([]);
  });

  it('inlines @import as a data: stylesheet and keeps its media list', async () => {
    const { doc } = await run('<link rel="stylesheet" href="a.css">', {
      'docs/a.css': '@import url("b.css") screen;\nh1{color:red}',
      'docs/b.css': 'p{color:blue}',
    });
    const css = doc.querySelector('style')!.textContent!;
    expect(css).toMatch(/@import url\("data:text\/css;base64,[A-Za-z0-9+/=]+"\) screen;/);
    expect(css).toContain('h1{color:red}');
  });

  it('inlines images, srcset, root-relative paths and absolute same-repo URLs', async () => {
    const png = new Uint8Array([137, 80]);
    const { doc, calls } = await run(
      `<img id="a" src="../img/x.png"><img id="b" src="/img/x.png" srcset="../img/x.png 1x, ../img/y.png 2x">
       <img id="c" src="https://raw.githubusercontent.com/o/r/refs/heads/main/img/x.png">
       <img id="d" src="https://github.com/o/r/blob/main/img/x.png">`,
      { 'img/x.png': png, 'img/y.png': png },
    );
    for (const id of ['a', 'b', 'c', 'd']) expect(doc.getElementById(id)!.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    expect(doc.getElementById('b')!.getAttribute('srcset')).toMatch(/^data:image\/png;base64,\S+ 1x, data:image\/png;base64,\S+ 2x$/);
    // Fetched once per path even when referenced many times.
    expect(calls.filter((c) => c === 'img/x.png')).toHaveLength(1);
  });

  it('inlines scripts and keeps a module warning', async () => {
    const { doc, report } = await run('<script src="app.js"></script><script type="module" src="m.js"></script>', {
      'docs/app.js': 'console.log("</script>")',
      'docs/m.js': 'import x from "./x.js"',
    }, { allowScripts: true });
    const scripts = Array.from(doc.querySelectorAll('script[data-gitifact-src]'));
    expect(scripts).toHaveLength(2);
    expect(scripts[0]!.hasAttribute('src')).toBe(false);
    expect(scripts[0]!.textContent).toBe('console.log("<\\/script>")');
    expect(report.warnings.some((w) => w.path === 'docs/m.js' && /module/.test(w.reason))).toBe(true);
  });

  it('injects the CSP first in <head> and the runtime only when scripts are allowed', async () => {
    const off = await run('<title>t</title>', {});
    const metaOff = off.doc.head.firstElementChild!;
    expect(metaOff.tagName).toBe('META');
    expect(metaOff.getAttribute('content')).toContain("script-src 'none'");
    expect(off.doc.querySelector('script[data-gitifact="runtime"]')).toBeNull();

    const on = await run('<title>t</title>', {}, { allowScripts: true, allowExternal: true });
    const csp = on.doc.head.firstElementChild!.getAttribute('content')!;
    expect(csp).toContain("script-src 'unsafe-inline' 'unsafe-eval' data: blob: https:");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(on.doc.querySelector('script[data-gitifact="runtime"]')).not.toBeNull();
  });

  it('removes <base>, meta refresh and preload hints, and honours a relative <base href>', async () => {
    const { doc } = await run(
      '<base href="../assets/"><meta http-equiv="refresh" content="0;url=https://evil.example"><link rel="preload" href="x.woff2" as="font"><img src="pic.png">',
      { 'assets/pic.png': new Uint8Array([1]) },
    );
    expect(doc.querySelector('base')).toBeNull();
    expect(doc.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    expect(doc.querySelector('link[rel="preload"]')).toBeNull();
    expect(doc.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,AQ==');
  });

  it('treats relative refs under an absolute <base> as external', async () => {
    const { doc, report } = await run('<base href="https://cdn.example/site/"><img src="pic.png">', {});
    expect(doc.querySelector('img')!.getAttribute('src')).toBe('pic.png');
    expect(report.warnings[0]!.path).toBe('https://cdn.example/site/pic.png');
  });

  it('reports missing files, blocked external resources and paths escaping the repo', async () => {
    const { doc, report } = await run('<img src="nope.png"><img src="https://cdn.example/a.png"><img src="../../../etc.png">', {});
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        { path: 'docs/nope.png', reason: 'HTTP 404' },
        { path: 'https://cdn.example/a.png', reason: expect.stringContaining('external resource blocked') },
      ]),
    );
    expect(doc.querySelectorAll('img')[2]!.getAttribute('src')).toBe('../../../etc.png');
  });

  it('does not warn about external resources when they are allowed', async () => {
    const { report } = await run('<img src="https://cdn.example/a.png">', {}, { allowExternal: true });
    expect(report.warnings).toEqual([]);
  });

  it('rewrites in-repo links to gitifact navigation links and leaves external ones alone', async () => {
    const { doc } = await run('<a id="a" href="../other.html?x=1#top">o</a><a id="b" href="https://example.com/">e</a><a id="c" href="#frag">f</a>', {});
    const a = doc.getElementById('a')!;
    expect(a.getAttribute('href')).toBe('#');
    expect(a.getAttribute('data-gitifact-path')).toBe('other.html');
    expect(doc.getElementById('b')!.getAttribute('href')).toBe('https://example.com/');
    expect(doc.getElementById('c')!.getAttribute('href')).toBe('#frag');
  });

  it('inlines nested iframes pointing at repository HTML, sandboxed', async () => {
    const { doc } = await run('<iframe src="inner.html"></iframe><iframe id="x" src="https://example.com/"></iframe>', {
      'docs/inner.html': '<p>inner</p><img src="i.png">',
      'docs/i.png': new Uint8Array([9]),
    });
    const frames = doc.querySelectorAll('iframe');
    expect(frames[0]!.hasAttribute('src')).toBe(false);
    expect(frames[0]!.getAttribute('sandbox')).toBe('');
    expect(frames[0]!.getAttribute('srcdoc')).toContain('data:image/png;base64,CQ==');
    expect(frames[0]!.getAttribute('srcdoc')).toContain('Content-Security-Policy');
    expect(frames[1]!.getAttribute('src')).toBe('https://example.com/');
    expect(frames[1]!.getAttribute('sandbox')).toBe('');
  });

  it('rewrites url() inside <style> and style attributes', async () => {
    const { doc } = await run('<style>.a{background:url(\'../img/p.png\')}</style><div style="background: url(../img/p.png)"></div>', {
      'img/p.png': new Uint8Array([1]),
    });
    expect(doc.querySelector('style')!.textContent).toContain('url("data:image/png;base64,AQ==")');
    expect(doc.querySelector('div')!.getAttribute('style')).toContain('url("data:image/png;base64,AQ==")');
  });
});

describe('buildCsp', () => {
  it('blocks everything external and all scripts by default', () => {
    const csp = buildCsp({ allowScripts: false, allowExternal: false });
    expect(csp).not.toContain('https:');
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("object-src 'none'");
  });
});
