import type { FileLocation } from './types';

export const HTML_EXT = /\.html?$/i;

export interface BlobUrlParts {
  owner: string;
  repo: string;
  /** `blob` (Code view) or `blame`. */
  view: 'blob' | 'blame';
  /** Everything after `/blob/` (ref and path, undivided), URL-decoded. */
  refAndPath: string;
}

/** Parses `https://github.com/{owner}/{repo}/blob/{ref...}/{path...}` (also `/blame/`). Returns null for other URLs. */
export function parseBlobUrl(url: string): BlobUrlParts | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== 'github.com') return null;
  const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|blame)\/(.+)$/);
  if (!m) return null;
  const refAndPath = safeDecode(m[3]!);
  if (!refAndPath || refAndPath.endsWith('/')) return null;
  const view = u.pathname.includes('/blame/') && !u.pathname.match(/\/blob\//) ? 'blame' : 'blob';
  return { owner: safeDecode(m[1]!), repo: safeDecode(m[2]!), view, refAndPath };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export interface RefCandidate {
  refName: string;
  path: string;
}

/**
 * All ways to split `refAndPath` into a ref and a path. Branch names may contain `/`,
 * so `feature/x/index.html` could be (`feature`, `x/index.html`) or (`feature/x`, `index.html`).
 * Ordered shortest ref first.
 */
export function refCandidates(refAndPath: string): RefCandidate[] {
  const segs = refAndPath.split('/');
  const out: RefCandidate[] = [];
  for (let i = 1; i < segs.length; i++) {
    out.push({ refName: segs.slice(0, i).join('/'), path: segs.slice(i).join('/') });
  }
  return out;
}

export type RefType = 'branch' | 'tag' | 'commit';

/** Converts a human ref name into the form accepted by raw.githubusercontent.com. */
export function toRawRef(refName: string, refType: RefType): string {
  if (refType === 'branch') return `refs/heads/${refName}`;
  if (refType === 'tag') return `refs/tags/${refName}`;
  return refName;
}

/**
 * Picks the split whose ref matches a known ref name (from the page UI), if any.
 * Returns null when the page gives no usable hint and the split is ambiguous.
 */
export function pickCandidate(candidates: RefCandidate[], hints: string[]): RefCandidate | null {
  const clean = hints.map((h) => h.trim()).filter(Boolean);
  for (const c of candidates) if (clean.includes(c.refName)) return c;
  if (candidates.length === 1) return candidates[0]!;
  return null;
}

/** Detects the ref type from GitHub's "Raw" button href (`/owner/repo/raw/refs/heads/…`, `/raw/refs/tags/…`, `/raw/<sha>/…`). */
export function refTypeFromRawHref(href: string | null | undefined): RefType | null {
  if (!href) return null;
  const m = href.match(/\/raw\/(refs\/heads\/|refs\/tags\/|[0-9a-f]{40}\/)/);
  if (!m) return null;
  if (m[1] === 'refs/heads/') return 'branch';
  if (m[1] === 'refs/tags/') return 'tag';
  return 'commit';
}

export function rawRootUrl(loc: Pick<FileLocation, 'owner' | 'repo' | 'ref'>): string {
  return `https://raw.githubusercontent.com/${enc(loc.owner)}/${enc(loc.repo)}/${loc.ref.split('/').map(enc).join('/')}/`;
}

export function rawFileUrl(loc: FileLocation, path = loc.path): string {
  return rawRootUrl(loc) + path.split('/').map(enc).join('/');
}

export function blobUrl(loc: FileLocation, path = loc.path): string {
  return `https://github.com/${enc(loc.owner)}/${enc(loc.repo)}/blob/${loc.refName.split('/').map(enc).join('/')}/${path.split('/').map(enc).join('/')}`;
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

export function isHtmlPath(path: string): boolean {
  return HTML_EXT.test(path);
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i + 1);
}

/** Normalises `a/./b/../c` → `a/c`; returns null if the path escapes the repository root. */
export function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

/** Serialises a location into preview.html query params. */
export function locationToParams(loc: FileLocation, extra: Record<string, string> = {}): URLSearchParams {
  const p = new URLSearchParams({ owner: loc.owner, repo: loc.repo, ref: loc.ref, refName: loc.refName, path: loc.path, ...extra });
  return p;
}

export function locationFromParams(p: URLSearchParams): FileLocation | null {
  const owner = p.get('owner'), repo = p.get('repo'), ref = p.get('ref'), path = p.get('path');
  if (!owner || !repo || !ref || !path) return null;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  const norm = normalizePath(path);
  if (norm === null || norm === '') return null;
  return { owner, repo, ref, refName: p.get('refName') || ref, path: norm };
}
