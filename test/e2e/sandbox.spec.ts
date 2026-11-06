import { test, expect } from './extension';
import { readFile } from 'node:fs/promises';
import { rewriteHtml } from '../../src/shared/resolve';
import { JSDOM } from 'jsdom';

/**
 * Isolation test that needs no network: renders test/fixtures/malicious.html through the real
 * rewriter + sandbox page and checks that every escape attempt is blocked.
 */
test('malicious HTML cannot escape the sandbox even with JavaScript enabled', async ({ context, extensionId }) => {
  const source = await readFile('test/fixtures/malicious.html', 'utf8');
  const dom = new JSDOM('');
  const { html, report } = await rewriteHtml(source, {
    location: { owner: 'o', repo: 'r', ref: 'refs/heads/main', refName: 'main', path: 'malicious.html' },
    fetchRepoFile: async () => ({ ok: false, status: 404, error: 'HTTP 404' }),
    allowScripts: true,
    allowExternal: false,
    parser: new dom.window.DOMParser(),
  });
  expect(report.warnings).toEqual([]);

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sandbox.html`);
  // Top-level page: window.parent === window, so posting to ourselves is accepted as "from parent".
  await page.evaluate((h) => window.postMessage({ type: 'gitifact:render', html: h, allowScripts: true }, '*'), html);
  const inner = page.frameLocator('iframe');
  await expect(inner.locator('#results li')).toHaveCount(10);
  const rows = await inner.locator('#results li').evaluateAll((lis) => lis.map((li) => [li.dataset.test, li.dataset.blocked, li.textContent]));
  for (const [name, blocked, text] of rows) expect(blocked, String(text)).toBe('true');
  expect(rows.map((r) => r[0]).sort()).toEqual(['parent DOM', 'top DOM', 'cookies', 'localStorage', 'chrome.runtime', 'top navigation', 'window.open', 'fetch external', 'fetch github.com', 'origin'].sort());
  // Still on the sandbox page: no meta refresh / top navigation happened.
  expect(page.url()).toContain('sandbox.html');
  // Forms cannot be submitted.
  await inner.locator('#form button').click();
  await page.waitForTimeout(300);
  expect(page.url()).toContain('sandbox.html');
  await expect(inner.locator('h1')).toHaveText('Malicious test page');
});

test('scripts do not run unless allowed', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sandbox.html`);
  const html = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="script-src 'none'"></head><body><p id="p">static</p><script>document.getElementById('p').textContent='ran'</script></body></html>`;
  await page.evaluate((h) => window.postMessage({ type: 'gitifact:render', html: h, allowScripts: false }, '*'), html);
  const inner = page.frameLocator('iframe');
  await expect(inner.locator('#p')).toHaveText('static');
  await page.waitForTimeout(300);
  await expect(inner.locator('#p')).toHaveText('static');
});

test('in-repository links are relayed to the parent as navigation requests, nothing else is', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sandbox.html`);
  await page.evaluate(() => {
    (window as unknown as { received: unknown[] }).received = [];
    // Only messages the sandbox page itself relays (source === its own window), not ones posted straight from the document.
    window.addEventListener('message', (e) => { if (e.source === window) (window as unknown as { received: unknown[] }).received.push(e.data); });
  });
  const dom = new JSDOM('');
  const { html } = await rewriteHtml('<a id="l" href="other.html">x</a><script>parent.postMessage({type:"gitifact:render", html:"<p>pwned</p>"}, "*"); parent.postMessage({type:"gitifact:navigate", path: 123}, "*");</script>', {
    location: { owner: 'o', repo: 'r', ref: 'refs/heads/main', refName: 'main', path: 'index.html' },
    fetchRepoFile: async () => ({ ok: false, status: 404, error: 'HTTP 404' }),
    allowScripts: true,
    allowExternal: false,
    parser: new dom.window.DOMParser(),
  });
  await page.evaluate((h) => window.postMessage({ type: 'gitifact:render', html: h, allowScripts: true }, '*'), html);
  const inner = page.frameLocator('iframe');
  await expect(inner.locator('#l')).toBeVisible();
  await inner.locator('#l').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { received: { type: string }[] }).received.filter((m) => m.type === 'gitifact:navigate'))).toEqual([{ type: 'gitifact:navigate', path: 'other.html' }]);
  // The forged render/navigate messages from the document were not relayed.
  await expect(inner.locator('p')).toHaveCount(0);
});
