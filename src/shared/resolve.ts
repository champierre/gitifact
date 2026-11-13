/**
 * Rewrites an HTML document fetched from a GitHub repository so that it can be rendered inside
 * a sandboxed iframe with no network access to the repository:
 *
 *  - relative/root-relative references (CSS, JS, images, fonts, media, nested iframes) are fetched
 *    from the same repository + ref and inlined as `data:` URLs (or inline <style>/<script>),
 *  - `url()` / `@import` inside CSS are resolved the same way,
 *  - a per-preview Content Security Policy is injected to block scripts and/or external resources,
 *  - `<base>` and `<meta http-equiv=refresh>` are removed,
 *  - in-repository links become `data-gitifact-path` links handled by the (optional) runtime script.
 *
 * raw.githubusercontent.com serves every file as `text/plain` with `nosniff`, which is why
 * stylesheets and scripts cannot be referenced by URL and must be inlined.
 */
import type { FetchResult, FileLocation } from './types';
import { dirname, normalizePath, isHtmlPath } from './github-url';
import { mimeFromPath } from './mime';
import { toDataUrl } from './encoding';

export interface RewriteOptions {
  location: FileLocation;
  /** Fetches a file from the same repository/ref. `path` is repo-relative, no leading slash. */
  fetchRepoFile: (path: string) => Promise<FetchResult>;
  allowScripts: boolean;
  allowExternal: boolean;
  /** Parser; defaults to the global DOMParser. */
  parser?: DOMParser;
}

export interface RewriteWarning {
  path: string;
  reason: string;
}

export interface RewriteReport {
  resolved: number;
  warnings: RewriteWarning[];
}

export const MAX_RESOURCE_BYTES = 15 * 1024 * 1024;
const MAX_IFRAME_DEPTH = 2;
const MAX_CSS_DEPTH = 4;

type Resolved =
  | { kind: 'repo'; path: string }
  | { kind: 'external'; url: string }
  | { kind: 'keep' };

interface Ctx extends RewriteOptions {
  report: RewriteReport;
  cache: Map<string, Promise<FetchResult>>;
  /** Absolute <base href>, when the document set one. */
  absoluteBase: string | null;
  /** Path of the document currently being rewritten and the directory its relative refs resolve against. */
  docPath: string;
  baseDir: string;
}

export function buildCsp(opts: { allowScripts: boolean; allowExternal: boolean }): string {
  const ext = opts.allowExternal ? ' https:' : '';
  const script = opts.allowScripts ? `'unsafe-inline' 'unsafe-eval' data: blob:${ext}` : `'none'`;
  return [
    `default-src 'none'`,
    `script-src ${script}`,
    `style-src 'unsafe-inline' data: blob:${ext}`,
    `img-src data: blob:${ext}${opts.allowExternal ? ' http:' : ''}`,
    `font-src data: blob:${ext}`,
    `media-src data: blob:${ext}`,
    `connect-src data: blob:${ext}`,
    `frame-src data: blob: about:${ext}`,
    `worker-src data: blob:`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`,
  ].join('; ');
}

/** Script injected into the previewed document when JavaScript is enabled. Only talks to its parent via postMessage. */
export const RUNTIME_SCRIPT = `(function(){
  // Opaque origins have no Web Storage; give scripts an in-memory stand-in so they do not crash.
  function memoryStorage(){
    var m = new Map();
    var s = {
      get length(){ return m.size; },
      key: function(i){ return Array.from(m.keys())[i] === undefined ? null : Array.from(m.keys())[i]; },
      getItem: function(k){ return m.has(String(k)) ? m.get(String(k)) : null; },
      setItem: function(k, v){ m.set(String(k), String(v)); },
      removeItem: function(k){ m.delete(String(k)); },
      clear: function(){ m.clear(); }
    };
    return s;
  }
  ['localStorage', 'sessionStorage'].forEach(function(name){
    try { void window[name]; } catch (e) {
      try { Object.defineProperty(window, name, { value: memoryStorage(), configurable: true }); } catch (e2) {}
    }
  });
  document.addEventListener('click', function(e){
    var t = e.target; if (!t || !t.closest) return;
    var a = t.closest('a[data-gitifact-path]');
    if (a) {
      e.preventDefault();
      parent.postMessage({ type: 'gitifact:navigate', path: a.getAttribute('data-gitifact-path') }, '*');
      return;
    }
    // ページ内リンク (#id)。srcdoc の文書は親ページの URL を基準に解決するため、そのままだと
    // sandbox.html#id への遷移になり真っ白になる。ここで横取りして文書内の移動として扱う。
    var h = t.closest('a[href], area[href]'); if (!h) return;
    var raw = h.getAttribute('href') || '';
    if (raw.charAt(0) !== '#') return;
    e.preventDefault();
    var id = raw.slice(1);
    try { id = decodeURIComponent(id); } catch (e2) {}
    var target = id ? (document.getElementById(id) || document.getElementsByName(id)[0] || null) : null;
    // location.hash は about:srcdoc 自身を基準にするので同一文書内の移動になる (:target / hashchange も効く)。
    try { if (location.hash !== raw) location.hash = raw; } catch (e3) {}
    if (target) target.scrollIntoView();
    else if (!id || id.toLowerCase() === 'top') window.scrollTo(0, 0);
  }, true);
  window.addEventListener('error', function(e){
    parent.postMessage({ type: 'gitifact:error', message: String(e.message || e.error || 'Script error') }, '*');
  });
  window.addEventListener('unhandledrejection', function(e){
    parent.postMessage({ type: 'gitifact:error', message: 'Unhandled promise rejection: ' + String(e.reason) }, '*');
  });
})();`;

export async function rewriteHtml(html: string, opts: RewriteOptions): Promise<{ html: string; report: RewriteReport }> {
  const report: RewriteReport = { resolved: 0, warnings: [] };
  const ctx: Ctx = { ...opts, report, cache: new Map(), absoluteBase: null, docPath: opts.location.path, baseDir: dirname(opts.location.path) };
  const parser = opts.parser ?? new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  await rewriteDocument(doc, opts.location.path, ctx, 0);
  return { html: '<!DOCTYPE html>\n' + doc.documentElement.outerHTML, report };
}

async function rewriteDocument(doc: Document, docPath: string, ctx: Ctx, iframeDepth: number): Promise<void> {
  const head = doc.head ?? doc.documentElement.insertBefore(doc.createElement('head'), doc.documentElement.firstChild);
  const docCtx: Ctx = { ...ctx, docPath, baseDir: dirname(docPath), absoluteBase: null };

  // <base>: honour it for resolution, then drop it (base-uri 'none' would reject it anyway).
  for (const base of Array.from(doc.querySelectorAll('base'))) {
    const href = base.getAttribute('href');
    if (href) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
        docCtx.absoluteBase = href.startsWith('//') ? 'https:' + href : href;
      } else {
        const r = resolveRef(href, docPath, docCtx);
        if (r.kind === 'repo') docCtx.baseDir = href.replace(/[?#].*$/, '').endsWith('/') ? r.path + '/' : dirname(r.path);
      }
    }
    base.remove();
  }
  for (const m of Array.from(doc.querySelectorAll('meta[http-equiv]'))) {
    const eq = (m.getAttribute('http-equiv') || '').toLowerCase();
    if (eq === 'refresh') m.remove();
  }
  for (const l of Array.from(doc.querySelectorAll('link[rel]'))) {
    const rel = (l.getAttribute('rel') || '').toLowerCase().split(/\s+/);
    if (rel.some((r) => ['preload', 'modulepreload', 'prefetch', 'manifest', 'prerender', 'dns-prefetch', 'preconnect'].includes(r))) l.remove();
  }

  const tasks: Promise<void>[] = [];

  // Stylesheets → inline <style>
  for (const link of Array.from(doc.querySelectorAll('link[rel][href]'))) {
    const rel = (link.getAttribute('rel') || '').toLowerCase().split(/\s+/);
    if (!rel.includes('stylesheet')) continue;
    const r = resolveRef(link.getAttribute('href') || '', docPath, docCtx);
    if (r.kind !== 'repo') {
      if (r.kind === 'external') noteExternal(docCtx, r.url);
      continue;
    }
    tasks.push(
      (async () => {
        const res = await fetchRepo(r.path, docCtx);
        if (!res.ok) return;
        const style = doc.createElement('style');
        const media = link.getAttribute('media');
        if (media) style.setAttribute('media', media);
        style.setAttribute('data-gitifact-src', r.path);
        style.textContent = await rewriteCss(res.body, r.path, docCtx, 0);
        link.replaceWith(style);
      })(),
    );
  }

  // Inline styles
  for (const style of Array.from(doc.querySelectorAll('style'))) {
    const css = style.textContent || '';
    if (!/url\(|@import/i.test(css)) continue;
    tasks.push(rewriteCss(css, docPath, docCtx, 0).then((out) => { style.textContent = out; }));
  }
  for (const el of Array.from(doc.querySelectorAll('[style]'))) {
    const css = el.getAttribute('style') || '';
    if (!/url\(/i.test(css)) continue;
    tasks.push(rewriteCss(css, docPath, docCtx, 0).then((out) => el.setAttribute('style', out)));
  }

  // Scripts
  for (const script of Array.from(doc.querySelectorAll('script[src]'))) {
    const r = resolveRef(script.getAttribute('src') || '', docPath, docCtx);
    if (r.kind !== 'repo') {
      if (r.kind === 'external') noteExternal(docCtx, r.url);
      continue;
    }
    tasks.push(
      (async () => {
        const res = await fetchRepo(r.path, docCtx);
        if (!res.ok) return;
        script.removeAttribute('src');
        script.setAttribute('data-gitifact-src', r.path);
        if ((script.getAttribute('type') || '').toLowerCase() === 'module' && /^\s*(import|export)\s|\bimport\s*\(|from\s+['"]\.{0,2}\//m.test(res.body)) {
          warn(docCtx, r.path, 'module scripts that import relative files are not supported yet');
        }
        script.textContent = res.body.replace(/<\/script/gi, '<\\/script');
      })(),
    );
  }

  // URL attributes
  const attrTargets: Array<[string, string]> = [
    ['img', 'src'], ['source', 'src'], ['video', 'src'], ['audio', 'src'], ['track', 'src'],
    ['video', 'poster'], ['input[type="image"]', 'src'], ['embed', 'src'],
  ];
  for (const [sel, attr] of attrTargets) {
    for (const el of Array.from(doc.querySelectorAll(`${sel}[${attr}]`))) {
      tasks.push(rewriteUrlAttr(el, attr, docPath, docCtx));
    }
  }
  for (const el of Array.from(doc.querySelectorAll('img[srcset], source[srcset]'))) {
    tasks.push(rewriteSrcset(el, docPath, docCtx));
  }
  // SVG <image href> / <use href>
  for (const el of Array.from(doc.querySelectorAll('image[href], image[xlink\\:href]'))) {
    const attr = el.hasAttribute('href') ? 'href' : 'xlink:href';
    tasks.push(rewriteUrlAttr(el, attr, docPath, docCtx));
  }

  // Nested iframes pointing at repository HTML
  for (const frame of Array.from(doc.querySelectorAll('iframe[src]'))) {
    const r = resolveRef(frame.getAttribute('src') || '', docPath, docCtx);
    if (r.kind !== 'repo') {
      if (r.kind === 'external') noteExternal(docCtx, r.url);
      frame.setAttribute('sandbox', sandboxAttr(docCtx.allowScripts));
      continue;
    }
    frame.removeAttribute('src');
    frame.setAttribute('sandbox', sandboxAttr(docCtx.allowScripts));
    if (iframeDepth >= MAX_IFRAME_DEPTH || !isHtmlPath(r.path)) {
      warn(docCtx, r.path, iframeDepth >= MAX_IFRAME_DEPTH ? 'nested iframes deeper than 2 levels are skipped' : 'iframe does not point at an HTML file');
      continue;
    }
    tasks.push(
      (async () => {
        const res = await fetchRepo(r.path, docCtx);
        if (!res.ok) return;
        const parser = ctx.parser ?? new DOMParser();
        const sub = parser.parseFromString(res.body, 'text/html');
        await rewriteDocument(sub, r.path, ctx, iframeDepth + 1);
        frame.setAttribute('srcdoc', '<!DOCTYPE html>\n' + sub.documentElement.outerHTML);
      })(),
    );
  }

  // Links
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href') || '';
    const r = resolveRef(href, docPath, docCtx);
    if (r.kind !== 'repo') continue;
    a.setAttribute('data-gitifact-path', r.path);
    a.setAttribute('data-gitifact-href', href);
    a.setAttribute('href', '#');
    if (!isHtmlPath(r.path)) a.setAttribute('title', `Repository file: ${r.path}`);
  }

  await Promise.all(tasks);

  // CSP first in <head> so it applies to everything that follows.
  const meta = doc.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', buildCsp(docCtx));
  head.insertBefore(meta, head.firstChild);
  if (docCtx.allowScripts) {
    const rt = doc.createElement('script');
    rt.setAttribute('data-gitifact', 'runtime');
    rt.textContent = RUNTIME_SCRIPT;
    head.insertBefore(rt, meta.nextSibling);
  }
}

export function sandboxAttr(allowScripts: boolean): string {
  return allowScripts ? 'allow-scripts allow-modals' : '';
}

async function rewriteUrlAttr(el: Element, attr: string, docPath: string, ctx: Ctx): Promise<void> {
  const r = resolveRef(el.getAttribute(attr) || '', docPath, ctx);
  if (r.kind === 'external') noteExternal(ctx, r.url);
  if (r.kind !== 'repo') return;
  const url = await repoDataUrl(r.path, ctx);
  if (url) el.setAttribute(attr, url);
}

async function rewriteSrcset(el: Element, docPath: string, ctx: Ctx): Promise<void> {
  const srcset = el.getAttribute('srcset') || '';
  const parts = srcset.split(/\s*,\s*(?=[^\s,]+(?:\s+[\d.]+[wx])?\s*(?:,|$))/);
  const out = await Promise.all(
    parts.map(async (part) => {
      const m = part.trim().match(/^(\S+)(\s+.+)?$/);
      if (!m) return part;
      const r = resolveRef(m[1]!, docPath, ctx);
      if (r.kind !== 'repo') return part;
      const url = await repoDataUrl(r.path, ctx);
      return url ? url + (m[2] || '') : part;
    }),
  );
  el.setAttribute('srcset', out.join(', '));
}

const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/g;
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)|"([^"]*)"|'([^']*)')([^;]*);/g;

export async function rewriteCss(css: string, cssPath: string, ctx: Ctx, depth: number): Promise<string> {
  // @import first (so the imported sheet's own urls are resolved relative to itself).
  css = await replaceAsync(css, CSS_IMPORT_RE, async (m, a, b, c, d, e, rest) => {
    const ref = a ?? b ?? c ?? d ?? e ?? '';
    const r = resolveRef(ref, cssPath, ctx);
    if (r.kind === 'external') noteExternal(ctx, r.url);
    if (r.kind !== 'repo') return m;
    if (depth >= MAX_CSS_DEPTH) {
      warn(ctx, r.path, '@import nesting too deep');
      return '';
    }
    const res = await fetchRepo(r.path, ctx);
    if (!res.ok) return '';
    const inner = await rewriteCss(res.body, r.path, ctx, depth + 1);
    return `@import url("${toDataUrl('text/css', inner, 'text')}")${rest};`;
  });
  return replaceAsync(css, CSS_URL_RE, async (m, a, b, c) => {
    const ref = a ?? b ?? c ?? '';
    const r = resolveRef(ref, cssPath, ctx);
    if (r.kind === 'external') noteExternal(ctx, r.url);
    if (r.kind !== 'repo') return m;
    const url = await repoDataUrl(r.path, ctx);
    return url ? `url("${url}")` : m;
  });
}

async function replaceAsync(s: string, re: RegExp, fn: (...m: string[]) => Promise<string>): Promise<string> {
  const matches = Array.from(s.matchAll(re));
  const repl = await Promise.all(matches.map((m) => fn(...(m as unknown as string[]))));
  let out = '', last = 0;
  matches.forEach((m, i) => {
    out += s.slice(last, m.index!) + repl[i]!;
    last = m.index! + m[0].length;
  });
  return out + s.slice(last);
}

async function repoDataUrl(path: string, ctx: Ctx): Promise<string | null> {
  const res = await fetchRepo(path, ctx);
  if (!res.ok) return null;
  const mime = mimeFromPath(path);
  if (mime === 'image/svg+xml' && res.encoding === 'text') {
    // SVG may itself reference files; resolve one level of url() / href.
    const body = await rewriteCss(res.body, path, ctx, MAX_CSS_DEPTH);
    return toDataUrl(mime, body, 'text');
  }
  return toDataUrl(mime, res.body, res.encoding);
}

function fetchRepo(path: string, ctx: Ctx): Promise<FetchResult> {
  let p = ctx.cache.get(path);
  if (!p) {
    p = ctx
      .fetchRepoFile(path)
      .catch((e: unknown): FetchResult => ({ ok: false, status: 0, error: e instanceof Error ? e.message : String(e) }))
      .then((res) => {
        if (!res.ok) warn(ctx, path, res.status ? `HTTP ${res.status}` : res.error);
        else if (res.body.length > MAX_RESOURCE_BYTES * 1.4) {
          warn(ctx, path, `larger than ${MAX_RESOURCE_BYTES / 1024 / 1024} MB, skipped`);
          return { ok: false, status: 0, error: 'too large' } as FetchResult;
        } else ctx.report.resolved++;
        return res;
      });
    ctx.cache.set(path, p);
  }
  return p;
}

function warn(ctx: Ctx, path: string, reason: string): void {
  if (!ctx.report.warnings.some((w) => w.path === path && w.reason === reason)) ctx.report.warnings.push({ path, reason });
}

function noteExternal(ctx: Ctx, url: string): void {
  if (!ctx.allowExternal) warn(ctx, url, 'external resource blocked');
}

/** Classifies a reference found in the document relative to `fromPath` (a repo path). */
export function resolveRef(ref: string, fromPath: string, ctx: Pick<Ctx, 'location' | 'absoluteBase' | 'baseDir' | 'docPath'>): Resolved {
  const raw = ref.trim();
  if (!raw || raw.startsWith('#')) return { kind: 'keep' };
  if (/^(data|blob|javascript|mailto|tel|about):/i.test(raw)) return { kind: 'keep' };
  const schemeMatch = raw.match(/^([a-z][a-z0-9+.-]*):/i);
  if (raw.startsWith('//')) return classifyAbsolute('https:' + raw, ctx);
  if (schemeMatch) return classifyAbsolute(raw, ctx);

  if (ctx.absoluteBase && !raw.startsWith('/')) {
    try {
      return classifyAbsolute(new URL(raw, ctx.absoluteBase).href, ctx);
    } catch {
      return { kind: 'keep' };
    }
  }
  const noQuery = raw.replace(/[?#].*$/, '');
  if (!noQuery) return { kind: 'keep' };
  let decoded = noQuery;
  try {
    decoded = decodeURIComponent(noQuery);
  } catch {
    /* keep as is */
  }
  const joined = decoded.startsWith('/') ? decoded.slice(1) : (fromPath === ctx.docPath ? ctx.baseDir : dirname(fromPath)) + decoded;
  const norm = normalizePath(joined);
  if (norm === null || norm === '') return { kind: 'keep' };
  return { kind: 'repo', path: norm };
}

function classifyAbsolute(href: string, ctx: Pick<Ctx, 'location'>): Resolved {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return { kind: 'keep' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { kind: 'keep' };
  const { owner, repo } = ctx.location;
  // Absolute links into the same repository are treated as repository files.
  if (u.hostname === 'raw.githubusercontent.com') {
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(.+)$/);
    if (m && m[1] === owner && m[2] === repo) {
      const rest = m[3]!.replace(/^refs\/(heads|tags)\//, '');
      const path = rest.split('/').slice(1).join('/');
      if (path) return { kind: 'repo', path };
    }
  }
  if (u.hostname === 'github.com') {
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
    if (m && m[1] === owner && m[2] === repo) {
      const rest = m[3]!.replace(/^refs\/(heads|tags)\//, '');
      const path = rest.split('/').slice(1).join('/');
      if (path) return { kind: 'repo', path };
    }
  }
  return { kind: 'external', url: u.href };
}
