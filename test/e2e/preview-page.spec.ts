import { test, expect, previewedFrame } from './extension';

test('resolves an ambiguous ref/path split by probing candidates', async ({ context, extensionId }) => {
  // Simulates /blob/mai/n/index.html-style ambiguity: the first candidate does not exist, the second does.
  const candidates = JSON.stringify([
    { ref: 'refs/heads/mai', refName: 'mai', path: 'n/index.html' },
    { ref: 'refs/heads/main', refName: 'main', path: 'index.html' },
  ]);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/preview.html?owner=mdn&repo=beginner-html-site-styled&candidates=${encodeURIComponent(candidates)}`);
  const inner = await previewedFrame(page, extensionId);
  await expect(inner.locator('h1')).toContainText('Mozilla is cool');
  await expect(page.locator('#ref')).toHaveText('main');
  await expect(page).toHaveURL(/ref=refs%2Fheads%2Fmain&refName=main&path=index\.html/);
});

test('shows an error for files that do not exist', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/preview.html?owner=mdn&repo=beginner-html-site-styled&ref=refs%2Fheads%2Fmain&refName=main&path=nope.html`);
  await expect(page.locator('#error')).toBeVisible();
  await expect(page.locator('#error')).toContainText('HTTP 404');
});

test('rejects invalid preview parameters', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/preview.html?owner=..%2Fx&repo=r&ref=main&path=a.html`);
  await expect(page.locator('#error')).toContainText('Invalid preview URL');
});
