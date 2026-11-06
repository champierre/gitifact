/** Where a file lives on GitHub. `ref` is the raw-URL-ready ref (e.g. `refs/heads/feat/x`, `refs/tags/v1`, or a commit SHA). */
export interface FileLocation {
  owner: string;
  repo: string;
  /** Ref as used in raw.githubusercontent.com URLs. */
  ref: string;
  /** Human readable ref name shown in the UI (e.g. `feat/x`). */
  refName: string;
  /** Path inside the repository, no leading slash. */
  path: string;
}

/** Messages from extension pages to the service worker. */
export type SwRequest =
  | { type: 'fetch'; url: string }
  | { type: 'probe'; urls: string[] };

export type FetchResult =
  | { ok: true; status: number; contentType: string; encoding: 'text'; body: string }
  | { ok: true; status: number; contentType: string; encoding: 'base64'; body: string }
  | { ok: false; status: number; error: string };

export type ProbeResult = { index: number } | { index: -1 };

/** Messages between the preview page (parent) and the sandbox page (child iframe). */
export type ToSandbox = { type: 'gitifact:render'; html: string; allowScripts: boolean };

export type FromSandbox =
  | { type: 'gitifact:sandbox-ready' }
  | { type: 'gitifact:rendered' }
  | { type: 'gitifact:navigate'; path: string }
  | { type: 'gitifact:error'; message: string };

/** Messages between the GitHub content script (parent) and the embedded preview page. */
export type ToPreviewFrame = { type: 'gitifact:theme'; theme: 'light' | 'dark' } | { type: 'gitifact:height'; height: number };
export type FromPreviewFrame = { type: 'gitifact:ready'; height: number | null };

export const MIN_HEIGHT = 240;
export const DEFAULT_HEIGHT = 640;
