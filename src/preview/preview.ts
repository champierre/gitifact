/**
 * Preview page (trusted extension page). Fetches the HTML through the service worker, rewrites it
 * with the resolver, and hands the result to the sandboxed page. Never evaluates repository content.
 */
import type { FetchResult, FileLocation, FromPreviewFrame, FromSandbox, ProbeResult, ToPreviewFrame, ToSandbox } from '../shared/types';
import { blobUrl, isHtmlPath, locationFromParams, locationToParams, normalizePath, rawFileUrl } from '../shared/github-url';
import { rewriteHtml, type RewriteReport } from '../shared/resolve';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const params = new URLSearchParams(location.search);
const embedded = params.get('embedded') === '1';
const sandbox = $<HTMLIFrameElement>('sandbox');
const frameWrap = $('frame-wrap');
const optJs = $<HTMLInputElement>('opt-js');
const optExternal = $<HTMLInputElement>('opt-external');
const statusEl = $('status');
const errorEl = $('error');
const warningsEl = $<HTMLDetailsElement>('warnings');
const MOBILE_WIDTH = 375;
const GITHUB_ORIGIN = 'https://github.com';

let loc: FileLocation | null = null;
let sandboxReady = false;
let pendingRender: ToSandbox | null = null;
let width: number | null = localStorage.getItem('gitifact.width') === 'mobile' ? MOBILE_WIDTH : null;
let generation = 0;

// ---------- theme ----------
function applyTheme(theme: string | null): void {
  const t = theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
}
applyTheme(params.get('theme'));
if (!params.get('theme')) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(null));

// ---------- messaging ----------
function toSandbox(msg: ToSandbox): void {
  // The sandbox has an opaque origin, so '*' is the only possible target; the message carries no secrets.
  sandbox.contentWindow?.postMessage(msg, '*');
}

function toParentFrame(msg: FromPreviewFrame): void {
  if (embedded && window.parent !== window) window.parent.postMessage(msg, GITHUB_ORIGIN);
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as Record<string, unknown> | null;
  if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;

  if (event.source === sandbox.contentWindow) {
    const msg = data as FromSandbox;
    if (msg.type === 'gitifact:sandbox-ready') {
      sandboxReady = true;
      if (pendingRender) {
        toSandbox(pendingRender);
        pendingRender = null;
      }
    } else if (msg.type === 'gitifact:rendered') {
      frameWrap.classList.remove('loading');
    } else if (msg.type === 'gitifact:navigate' && typeof msg.path === 'string') {
      navigateTo(msg.path);
    } else if (msg.type === 'gitifact:error' && typeof msg.message === 'string') {
      showError(`Script error in preview: ${msg.message}`, true);
    }
    return;
  }

  if (embedded && event.origin === GITHUB_ORIGIN && event.source === window.parent) {
    const msg = data as ToPreviewFrame;
    if (msg.type === 'gitifact:theme') applyTheme(msg.theme === 'dark' ? 'dark' : 'light');
    else if (msg.type === 'gitifact:height' && typeof msg.height === 'number') localStorage.setItem('gitifact.height', String(msg.height));
  }
});

function swRequest<T>(msg: object): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res: T) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

// ---------- UI helpers ----------
function setStatus(text: string | null): void {
  statusEl.hidden = !text;
  statusEl.textContent = text ?? '';
}
function showError(text: string | null, append = false): void {
  if (!text) {
    errorEl.hidden = true;
    errorEl.textContent = '';
    return;
  }
  errorEl.hidden = false;
  errorEl.textContent = append && errorEl.textContent ? `${errorEl.textContent}\n${text}` : text;
}
function showWarnings(report: RewriteReport | null): void {
  const list = $('warnings-list');
  list.replaceChildren();
  if (!report || report.warnings.length === 0) {
    warningsEl.hidden = true;
    return;
  }
  $('warnings-summary').textContent = `${report.warnings.length} resource${report.warnings.length === 1 ? '' : 's'} could not be loaded`;
  for (const w of report.warnings) {
    const li = document.createElement('li');
    li.textContent = `${w.path} — ${w.reason}`;
    list.appendChild(li);
  }
  warningsEl.hidden = false;
}
function updateHeader(): void {
  if (!loc) return;
  const link = $<HTMLAnchorElement>('file-link');
  link.textContent = loc.path;
  link.href = blobUrl(loc);
  $('ref').textContent = loc.refName;
  document.title = `${loc.path} · ${loc.owner}/${loc.repo} — Gitifact`;
  $<HTMLAnchorElement>('newtab').href = chrome.runtime.getURL(`preview.html?${locationToParams(loc, { theme: document.documentElement.dataset.theme || 'light' })}`);
}
function setWidth(w: number | null): void {
  width = w;
  $('width-desktop').setAttribute('aria-pressed', String(w === null));
  $('width-mobile').setAttribute('aria-pressed', String(w !== null));
  localStorage.setItem('gitifact.width', w === null ? 'desktop' : 'mobile');
  toSandbox({ type: 'gitifact:width', width: w });
}

// ---------- loading ----------
async function resolveLocation(): Promise<FileLocation> {
  const direct = locationFromParams(params);
  if (direct) return direct;
  // Ambiguous ref/path split: probe the candidates (shortest ref first) until one exists.
  const owner = params.get('owner') || '', repo = params.get('repo') || '';
  let cands: Array<{ ref: string; refName: string; path: string }> = [];
  try {
    cands = JSON.parse(params.get('candidates') || '[]');
  } catch {
    /* ignore */
  }
  cands = cands.filter((c) => c && typeof c.ref === 'string' && typeof c.path === 'string' && normalizePath(c.path));
  if (!owner || !repo || cands.length === 0) throw new Error('Invalid preview URL: missing owner/repo/ref/path');
  setStatus('Resolving branch name…');
  const urls = cands.map((c) => rawFileUrl({ owner, repo, ref: c.ref, refName: c.refName, path: c.path }));
  const res = await swRequest<ProbeResult>({ type: 'probe', urls });
  if (res.index < 0) throw new Error(`Could not find the file on GitHub. Tried:\n${urls.join('\n')}`);
  const c = cands[res.index]!;
  return { owner, repo, ref: c.ref, refName: c.refName || c.ref, path: normalizePath(c.path)! };
}

async function load(): Promise<void> {
  const gen = ++generation;
  showError(null);
  showWarnings(null);
  frameWrap.classList.add('loading');
  try {
    if (!loc) {
      loc = await resolveLocation();
      history.replaceState(null, '', `?${locationToParams(loc, embedded ? { embedded: '1', theme: document.documentElement.dataset.theme || 'light' } : { theme: document.documentElement.dataset.theme || 'light' })}`);
    }
    const current = loc;
    updateHeader();
    setStatus(`Fetching ${current.path}…`);
    const main = await swRequest<FetchResult>({ type: 'fetch', url: rawFileUrl(current) });
    if (gen !== generation) return;
    if (!main.ok) throw new Error(`Could not fetch ${rawFileUrl(current)}\n${main.error}${main.status === 404 ? '\n(Private repositories are not supported yet.)' : ''}`);
    if (main.encoding !== 'text') throw new Error('The file is not a text file.');
    setStatus('Resolving resources…');
    const { html, report } = await rewriteHtml(main.body, {
      location: current,
      allowScripts: optJs.checked,
      allowExternal: optExternal.checked,
      fetchRepoFile: (path) => swRequest<FetchResult>({ type: 'fetch', url: rawFileUrl(current, path) }),
    });
    if (gen !== generation) return;
    const msg: ToSandbox = { type: 'gitifact:render', html, allowScripts: optJs.checked, width };
    if (sandboxReady) toSandbox(msg);
    else pendingRender = msg;
    const parts = [`${report.resolved} resource${report.resolved === 1 ? '' : 's'} inlined`];
    parts.push(optJs.checked ? 'JavaScript on' : 'JavaScript off');
    parts.push(optExternal.checked ? 'external resources allowed' : 'external resources blocked');
    setStatus(parts.join(' · '));
    showWarnings(report);
  } catch (e) {
    if (gen !== generation) return;
    frameWrap.classList.remove('loading');
    setStatus(null);
    showError(e instanceof Error ? e.message : String(e));
  }
}

function navigateTo(path: string): void {
  if (!loc) return;
  const norm = normalizePath(path);
  if (!norm) return;
  if (isHtmlPath(norm)) {
    loc = { ...loc, path: norm };
    history.replaceState(null, '', `?${locationToParams(loc, embedded ? { embedded: '1' } : {})}`);
    void load();
  } else {
    window.open(blobUrl(loc, norm), '_blank', 'noopener');
  }
}

// ---------- wire up ----------
$('reload').addEventListener('click', () => void load());
optJs.addEventListener('change', () => void load());
optExternal.addEventListener('change', () => void load());
$('width-desktop').addEventListener('click', () => setWidth(null));
$('width-mobile').addEventListener('click', () => setWidth(MOBILE_WIDTH));
setWidth(width);
if (embedded) {
  $('newtab').hidden = false;
  const saved = Number(localStorage.getItem('gitifact.height'));
  toParentFrame({ type: 'gitifact:ready', height: Number.isFinite(saved) && saved > 0 ? saved : null });
}
void load();
