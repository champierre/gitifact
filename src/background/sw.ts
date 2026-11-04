/**
 * Service worker: the only place that talks to the network for repository files.
 * It accepts requests from the extension's own pages only, and only for raw.githubusercontent.com.
 */
import type { SwRequest, FetchResult, ProbeResult } from '../shared/types';
import { bytesToBase64 } from '../shared/encoding';
import { isTextMime, mimeFromPath } from '../shared/mime';
import { MAX_RESOURCE_BYTES } from '../shared/resolve';

const RAW_PREFIX = 'https://raw.githubusercontent.com/';

function isAllowedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'raw.githubusercontent.com' && u.pathname.split('/').length >= 5;
  } catch {
    return false;
  }
}

function isTrustedSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  const origin = chrome.runtime.getURL('');
  // Only the extension's own (non-sandboxed) pages may ask for fetches; content scripts have a github.com URL.
  return typeof sender.url === 'string' && sender.url.startsWith(origin);
}

async function fetchRaw(url: string): Promise<FetchResult> {
  if (!isAllowedUrl(url)) return { ok: false, status: 0, error: `Refusing to fetch ${url}: only ${RAW_PREFIX} is allowed` };
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'omit', redirect: 'follow', cache: 'no-cache' });
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
  if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status} ${res.statusText}` };
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_RESOURCE_BYTES) return { ok: false, status: 0, error: `too large (${len} bytes)` };
  const path = new URL(url).pathname;
  const mime = mimeFromPath(path);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_RESOURCE_BYTES) return { ok: false, status: 0, error: `too large (${buf.byteLength} bytes)` };
  if (isTextMime(mime)) {
    return { ok: true, status: res.status, contentType: mime, encoding: 'text', body: new TextDecoder().decode(buf) };
  }
  return { ok: true, status: res.status, contentType: mime, encoding: 'base64', body: bytesToBase64(buf) };
}

/** Returns the index of the first URL that exists (used to disambiguate branch names containing "/"). */
async function probe(urls: string[]): Promise<ProbeResult> {
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!;
    if (!isAllowedUrl(url)) continue;
    try {
      const res = await fetch(url, { method: 'HEAD', credentials: 'omit', cache: 'no-cache' });
      if (res.ok) return { index: i };
    } catch {
      /* try next */
    }
  }
  return { index: -1 };
}

chrome.runtime.onMessage.addListener((msg: SwRequest, sender, sendResponse) => {
  if (!isTrustedSender(sender) || !msg || typeof msg !== 'object') return false;
  if (msg.type === 'fetch' && typeof msg.url === 'string') {
    fetchRaw(msg.url).then(sendResponse);
    return true;
  }
  if (msg.type === 'probe' && Array.isArray(msg.urls)) {
    probe(msg.urls.filter((u): u is string => typeof u === 'string').slice(0, 20)).then(sendResponse);
    return true;
  }
  return false;
});
