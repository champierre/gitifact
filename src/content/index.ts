/**
 * Content script for github.com: detects HTML blob pages, adds a "Preview" tab next to GitHub's
 * "Code | Blame" control, and swaps the code view for an embedded extension page (preview.html).
 * It never touches repository content itself; everything untrusted runs inside the sandboxed page.
 */
import { DEFAULT_HEIGHT, MIN_HEIGHT, type FromPreviewFrame, type ToPreviewFrame } from '../shared/types';
import { isHtmlPath, parseBlobUrl, pickCandidate, refCandidates, refTypeFromRawHref, toRawRef, locationToParams } from '../shared/github-url';
import type { FileLocation } from '../shared/types';

const TAB_ID = 'gitifact-tab';
const PANEL_ID = 'gitifact-panel';
const EXT_ORIGIN = new URL(chrome.runtime.getURL('')).origin;

interface PageTarget {
  previewUrl: string;
  key: string;
}

let currentKey: string | null = null;
let panel: HTMLElement | null = null;
let hiddenEls: Element[] = [];
let frame: HTMLIFrameElement | null = null;
let height = DEFAULT_HEIGHT;

// ---------- page analysis ----------
function currentTheme(): 'light' | 'dark' {
  const html = document.documentElement;
  const mode = html.getAttribute('data-color-mode') || 'light';
  if (mode === 'auto') return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return mode === 'dark' ? 'dark' : 'light';
}

function refHints(owner: string, repo: string): string[] {
  const hints: string[] = [];
  const picker = document.querySelector('#branch-picker-repos-header-ref-selector, [data-hotkey="w"]');
  if (picker?.textContent) hints.push(picker.textContent.trim());
  // Title looks like "repo/path/to/file.html at feature/x · owner/repo"
  const suffix = ` · ${owner}/${repo}`;
  const title = document.title.replace(/ · GitHub$/, '');
  if (title.endsWith(suffix)) {
    const t = title.slice(0, -suffix.length);
    const i = t.lastIndexOf(' at ');
    if (i > 0) hints.push(t.slice(i + 4));
  }
  return hints;
}

function analyze(): PageTarget | null {
  const parts = parseBlobUrl(location.href);
  if (!parts || !isHtmlPath(parts.refAndPath)) return null;
  const cands = refCandidates(parts.refAndPath);
  if (cands.length === 0) return null;
  const rawHref = document.querySelector<HTMLAnchorElement>('a[data-testid="raw-button"]')?.getAttribute('href');
  const refType = refTypeFromRawHref(rawHref) ?? 'branch';
  const picked = pickCandidate(cands, refHints(parts.owner, parts.repo));
  const common = { theme: currentTheme(), embedded: '1' };
  let params: URLSearchParams;
  if (picked) {
    const loc: FileLocation = { owner: parts.owner, repo: parts.repo, ref: toRawRef(picked.refName, refType), refName: picked.refName, path: picked.path };
    params = locationToParams(loc, common);
  } else {
    params = new URLSearchParams({
      owner: parts.owner,
      repo: parts.repo,
      candidates: JSON.stringify(cands.map((c) => ({ ref: toRawRef(c.refName, refType), refName: c.refName, path: c.path }))),
      ...common,
    });
  }
  return { previewUrl: chrome.runtime.getURL(`preview.html?${params}`), key: location.pathname };
}

// ---------- DOM hooks ----------
function findSegmentedControl(): HTMLUListElement | null {
  const ul = document.querySelector<HTMLUListElement>('ul[aria-label="File view"]');
  if (ul && ul.closest('#repos-sticky-header')) return ul;
  return null;
}

function findStickyHeader(): HTMLElement | null {
  return document.getElementById('repos-sticky-header');
}

function injectTab(target: PageTarget): void {
  if (document.getElementById(TAB_ID)) return;
  const ul = findSegmentedControl();
  const sticky = findStickyHeader();
  if (!sticky) return;

  let button: HTMLButtonElement;
  if (ul && ul.firstElementChild) {
    const li = ul.firstElementChild.cloneNode(true) as HTMLLIElement;
    li.id = TAB_ID;
    li.removeAttribute('data-selected');
    const btn = li.querySelector('button');
    if (!btn) return;
    btn.setAttribute('aria-pressed', 'false');
    btn.removeAttribute('id');
    btn.style.setProperty('--separator-color', 'transparent');
    const textEl = btn.querySelector('[class*="Text"]') ?? btn;
    textEl.textContent = 'Preview';
    button = btn;
    ul.insertBefore(li, ul.firstElementChild);
    // Clicking GitHub's own Code/Blame tabs leaves the preview.
    ul.addEventListener('click', (e) => {
      const t = e.target as Element | null;
      if (t && !li.contains(t) && t.closest('button')) deactivate();
    }, true);
  } else {
    const actions = sticky.querySelector('.react-blob-header-edit-and-raw-actions') ?? sticky;
    button = document.createElement('button');
    button.type = 'button';
    button.id = TAB_ID;
    button.className = 'gitifact-fallback-btn';
    button.textContent = 'Preview';
    button.setAttribute('aria-pressed', 'false');
    actions.insertBefore(button, actions.firstChild);
  }
  button.setAttribute('data-gitifact', 'preview-button');
  button.title = 'Preview this HTML file with Gitifact';
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (panel) deactivate();
    else activate(target);
  });
}

function setTabPressed(pressed: boolean): void {
  const tab = document.getElementById(TAB_ID);
  if (!tab) return;
  const btn = tab.tagName === 'LI' ? tab.querySelector('button') : (tab as HTMLButtonElement);
  btn?.setAttribute('aria-pressed', String(pressed));
  if (tab.tagName === 'LI') {
    if (pressed) tab.setAttribute('data-selected', '');
    else tab.removeAttribute('data-selected');
    for (const sib of Array.from(tab.parentElement?.children ?? [])) {
      if (sib === tab) continue;
      if (pressed) {
        sib.removeAttribute('data-selected');
        sib.querySelector('button')?.setAttribute('aria-pressed', 'false');
      }
    }
  }
}

function activate(target: PageTarget): void {
  const sticky = findStickyHeader();
  const container = sticky?.parentElement;
  if (!sticky || !container) return;
  deactivate();

  hiddenEls = Array.from(container.children).filter((c) => c !== sticky);
  for (const el of hiddenEls) el.classList.add('gitifact-hidden');

  panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.className = 'gitifact-panel';
  frame = document.createElement('iframe');
  frame.className = 'gitifact-frame';
  frame.src = target.previewUrl;
  frame.title = 'Gitifact preview';
  frame.style.height = `${height}px`;
  const resizer = document.createElement('div');
  resizer.className = 'gitifact-resizer';
  resizer.title = 'Drag to resize';
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-orientation', 'horizontal');
  resizer.addEventListener('mousedown', startResize);
  panel.append(frame, resizer);
  sticky.insertAdjacentElement('afterend', panel);
  offsetBelowHeader(sticky);
  setTabPressed(true);
}

/**
 * GitHub's file header is absolutely positioned inside a zero-height sticky wrapper, so content that
 * follows it has to leave room for it (GitHub's own code view does this with padding).
 */
function offsetBelowHeader(sticky: HTMLElement): void {
  if (!panel) return;
  const h = sticky.firstElementChild?.getBoundingClientRect().height ?? 0;
  panel.style.marginTop = `${Math.round(h) + 8}px`;
}

function deactivate(): void {
  if (!panel) return;
  panel.remove();
  panel = null;
  frame = null;
  for (const el of hiddenEls) el.classList.remove('gitifact-hidden');
  hiddenEls = [];
  setTabPressed(false);
}

function teardown(): void {
  deactivate();
  document.getElementById(TAB_ID)?.remove();
}

// ---------- resize ----------
function startResize(e: MouseEvent): void {
  if (!frame) return;
  e.preventDefault();
  const startY = e.clientY;
  const startH = frame.getBoundingClientRect().height;
  const overlay = document.createElement('div');
  overlay.className = 'gitifact-drag-overlay';
  document.body.appendChild(overlay);
  const move = (ev: MouseEvent) => {
    height = Math.max(MIN_HEIGHT, Math.round(startH + ev.clientY - startY));
    if (frame) frame.style.height = `${height}px`;
  };
  const up = () => {
    overlay.remove();
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    postToFrame({ type: 'gitifact:height', height });
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function postToFrame(msg: ToPreviewFrame): void {
  frame?.contentWindow?.postMessage(msg, EXT_ORIGIN);
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.origin !== EXT_ORIGIN || !frame || event.source !== frame.contentWindow) return;
  const msg = event.data as FromPreviewFrame;
  if (msg && msg.type === 'gitifact:ready') {
    if (typeof msg.height === 'number' && msg.height >= MIN_HEIGHT) {
      height = Math.round(msg.height);
      frame.style.height = `${height}px`;
    }
    postToFrame({ type: 'gitifact:theme', theme: currentTheme() });
  }
});

// ---------- lifecycle / SPA navigation ----------
function ensure(): void {
  const target = analyze();
  if (!target) {
    if (currentKey !== null) {
      teardown();
      currentKey = null;
    }
    return;
  }
  if (currentKey !== target.key) {
    teardown();
    currentKey = target.key;
  }
  injectTab(target);
  // GitHub re-rendered the content area underneath an active preview: re-hide it.
  if (panel && panel.isConnected) {
    const sticky = findStickyHeader();
    if (sticky) offsetBelowHeader(sticky);
    const container = panel.parentElement;
    if (container) {
      for (const c of Array.from(container.children)) {
        if (c !== panel && c.id !== 'repos-sticky-header' && !c.classList.contains('gitifact-hidden')) {
          c.classList.add('gitifact-hidden');
          hiddenEls.push(c);
        }
      }
    }
  } else if (panel && !panel.isConnected) {
    deactivate();
  }
}

let scheduled: number | null = null;
function schedule(): void {
  if (scheduled !== null) return;
  scheduled = window.setTimeout(() => {
    scheduled = null;
    ensure();
  }, 120);
}

new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
new MutationObserver(() => postToFrame({ type: 'gitifact:theme', theme: currentTheme() })).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-color-mode', 'data-light-theme', 'data-dark-theme'],
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => postToFrame({ type: 'gitifact:theme', theme: currentTheme() }));
for (const ev of ['popstate', 'turbo:load', 'turbo:render', 'pjax:end']) window.addEventListener(ev, schedule);
ensure();
