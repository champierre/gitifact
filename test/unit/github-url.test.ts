import { describe, it, expect } from 'vitest';
import { parseBlobUrl, refCandidates, pickCandidate, refTypeFromRawHref, toRawRef, rawFileUrl, blobUrl, normalizePath, isHtmlPath, locationFromParams, locationToParams } from '../../src/shared/github-url';

describe('parseBlobUrl', () => {
  it('parses a simple blob URL', () => {
    expect(parseBlobUrl('https://github.com/owner/repo/blob/main/index.html')).toEqual({ owner: 'owner', repo: 'repo', view: 'blob', refAndPath: 'main/index.html' });
  });
  it('treats the blame view as the same file', () => {
    expect(parseBlobUrl('https://github.com/owner/repo/blame/main/index.html')).toEqual({ owner: 'owner', repo: 'repo', view: 'blame', refAndPath: 'main/index.html' });
  });
  it('keeps slashes in ref+path and decodes percent escapes', () => {
    expect(parseBlobUrl('https://github.com/o/r/blob/feature/x/docs/my%20page.html?plain=1#L3')).toEqual({ owner: 'o', repo: 'r', view: 'blob', refAndPath: 'feature/x/docs/my page.html' });
  });
  it('rejects non-blob and non-github URLs', () => {
    expect(parseBlobUrl('https://github.com/o/r/tree/main/docs')).toBeNull();
    expect(parseBlobUrl('https://github.com/o/r')).toBeNull();
    expect(parseBlobUrl('https://gitlab.com/o/r/blob/main/index.html')).toBeNull();
    expect(parseBlobUrl('https://github.com/o/r/blob/main/')).toBeNull();
  });
});

describe('refCandidates / pickCandidate', () => {
  it('lists every ref/path split, shortest ref first', () => {
    expect(refCandidates('feature/x/index.html')).toEqual([
      { refName: 'feature', path: 'x/index.html' },
      { refName: 'feature/x', path: 'index.html' },
    ]);
  });
  it('picks the split that matches a hint from the page', () => {
    const c = refCandidates('feature/x/index.html');
    expect(pickCandidate(c, ['feature/x'])).toEqual({ refName: 'feature/x', path: 'index.html' });
    expect(pickCandidate(c, ['feature'])).toEqual({ refName: 'feature', path: 'x/index.html' });
  });
  it('resolves unambiguous splits without hints and returns null when ambiguous', () => {
    expect(pickCandidate(refCandidates('main/index.html'), [])).toEqual({ refName: 'main', path: 'index.html' });
    expect(pickCandidate(refCandidates('a/b/index.html'), ['nope'])).toBeNull();
  });
});

describe('refs', () => {
  it('detects ref type from the Raw button href', () => {
    expect(refTypeFromRawHref('https://github.com/o/r/raw/refs/heads/main/index.html')).toBe('branch');
    expect(refTypeFromRawHref('/o/r/raw/refs/tags/v1.0/index.html')).toBe('tag');
    expect(refTypeFromRawHref('/o/r/raw/0123456789abcdef0123456789abcdef01234567/index.html')).toBe('commit');
    expect(refTypeFromRawHref(null)).toBeNull();
  });
  it('builds raw and blob URLs', () => {
    const loc = { owner: 'o', repo: 'r', ref: toRawRef('feat/x', 'branch'), refName: 'feat/x', path: 'docs/a b.html' };
    expect(rawFileUrl(loc)).toBe('https://raw.githubusercontent.com/o/r/refs/heads/feat/x/docs/a%20b.html');
    expect(rawFileUrl(loc, 'img/logo.png')).toBe('https://raw.githubusercontent.com/o/r/refs/heads/feat/x/img/logo.png');
    expect(blobUrl(loc)).toBe('https://github.com/o/r/blob/feat/x/docs/a%20b.html');
    expect(toRawRef('abc123', 'commit')).toBe('abc123');
  });
});

describe('paths', () => {
  it('normalises dot segments and rejects escaping the root', () => {
    expect(normalizePath('a/./b/../c.css')).toBe('a/c.css');
    expect(normalizePath('../x')).toBeNull();
    expect(normalizePath('a/../../x')).toBeNull();
  });
  it('detects html files', () => {
    expect(isHtmlPath('x/index.html')).toBe(true);
    expect(isHtmlPath('x/INDEX.HTM')).toBe(true);
    expect(isHtmlPath('x/index.md')).toBe(false);
  });
  it('round-trips through query params and validates them', () => {
    const loc = { owner: 'o', repo: 'r', ref: 'refs/heads/main', refName: 'main', path: 'index.html' };
    expect(locationFromParams(locationToParams(loc))).toEqual(loc);
    expect(locationFromParams(new URLSearchParams({ owner: '../x', repo: 'r', ref: 'main', path: 'a.html' }))).toBeNull();
    expect(locationFromParams(new URLSearchParams({ owner: 'o', repo: 'r', ref: 'main', path: '../a.html' }))).toBeNull();
  });
});
