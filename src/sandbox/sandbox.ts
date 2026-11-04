/**
 * Sandboxed page (unique origin, no extension APIs). It receives already-rewritten HTML from the
 * preview page and renders it inside a nested sandboxed iframe via `srcdoc`. The nested document
 * inherits this page's permissive CSP (from manifest.json) which is then restricted by the <meta>
 * CSP injected by the rewriter.
 */
import type { ToSandbox, FromSandbox } from '../shared/types';

let frame: HTMLIFrameElement | null = null;

function send(msg: FromSandbox): void {
  window.parent.postMessage(msg, '*');
}

function applyWidth(width: number | null): void {
  if (!frame) return;
  if (width) {
    frame.style.width = `${width}px`;
    frame.classList.add('fixed');
    document.body.classList.add('constrained');
  } else {
    frame.style.width = '100%';
    frame.classList.remove('fixed');
    document.body.classList.remove('constrained');
  }
}

function render(html: string, allowScripts: boolean, width: number | null): void {
  frame?.remove();
  frame = document.createElement('iframe');
  // No allow-same-origin: the document gets an opaque origin, no cookies/storage, no DOM access to us.
  // No allow-top-navigation / allow-popups / allow-forms: navigation stays inside the frame.
  frame.setAttribute('sandbox', allowScripts ? 'allow-scripts allow-modals' : '');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('title', 'Gitifact preview');
  frame.addEventListener('load', () => send({ type: 'gitifact:rendered' }));
  frame.srcdoc = html;
  document.body.appendChild(frame);
  applyWidth(width);
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as Record<string, unknown> | null;
  if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;

  if (event.source === window.parent) {
    const msg = data as ToSandbox;
    if (msg.type === 'gitifact:render' && typeof msg.html === 'string') {
      render(msg.html, msg.allowScripts === true, typeof msg.width === 'number' ? msg.width : null);
    } else if (msg.type === 'gitifact:width') {
      applyWidth(typeof msg.width === 'number' ? msg.width : null);
    }
    return;
  }

  // Messages from the previewed document: relay a small allow-list to the preview page, nothing else.
  if (frame && event.source === frame.contentWindow) {
    if (data.type === 'gitifact:navigate' && typeof data.path === 'string') {
      send({ type: 'gitifact:navigate', path: data.path.slice(0, 2000) });
    } else if (data.type === 'gitifact:error' && typeof data.message === 'string') {
      send({ type: 'gitifact:error', message: data.message.slice(0, 1000) } as FromSandbox);
    }
  }
});

send({ type: 'gitifact:sandbox-ready' });
