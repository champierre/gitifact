import { test, expect, openBlob, previewTab, ensurePreview, previewedFrame, previewFrame } from './extension';

// Public, stable MDN example repository: index.html + styles/style.css + images/firefox-icon.png
const MDN = 'https://github.com/mdn/beginner-html-site-styled/blob/main/index.html';

test('adds a Preview tab on an HTML blob page, opens it automatically and renders CSS + images', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await openBlob(page, MDN);
  const tab = previewTab(page);
  await expect(tab).toBeVisible();
  await expect(tab).toHaveCount(1);
  // Opens without a click.
  await expect(page.locator('#gitifact-panel')).toHaveCount(1);
  await expect(tab).toHaveAttribute('aria-pressed', 'true');
  const inner = await previewedFrame(page, extensionId);
  await expect(inner.locator('h1')).toContainText('Mozilla is cool');
  // External stylesheet was inlined and applied.
  const bodyWidth = await inner.locator('body').evaluate((b) => getComputedStyle(b).width);
  expect(bodyWidth).toBe('600px');
  // Relative image was inlined as data: URL and decoded.
  const img = inner.locator('img').first();
  await expect(img).toHaveAttribute('src', /^data:image\/png;base64,/);
  expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  // The toolbar only offers Reload and Open in new tab.
  const pf = previewFrame(page, extensionId);
  await expect(pf.locator('.toolbar-right > *')).toHaveText(['Reload', 'Open in new tab']);
  await expect(pf.locator('#status')).toContainText('inlined');
  // Back to code.
  await page.locator('ul[aria-label="File view"] button', { hasText: /^Code$/ }).click();
  await expect(page.locator('#gitifact-panel')).toHaveCount(0);
  await expect(page.locator('#read-only-cursor-text-area')).toBeVisible();
  // Clicking the Preview tab re-opens it.
  await tab.click();
  await expect(page.locator('#gitifact-panel')).toHaveCount(1);
});
