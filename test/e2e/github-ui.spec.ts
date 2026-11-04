import { test, expect, openBlob, previewTab, ensurePreview, previewedFrame, previewFrame } from './extension';

const MDN_REPO = 'https://github.com/mdn/beginner-html-site-styled';

test('does not add a Preview tab for non-HTML files', async ({ context }) => {
  const page = await context.newPage();
  await openBlob(page, `${MDN_REPO}/blob/main/styles/style.css`);
  await page.waitForTimeout(1000);
  await expect(previewTab(page)).toHaveCount(0);
});

test('follows GitHub soft navigation between files', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await openBlob(page, `${MDN_REPO}/blob/main/README.md`);
  await page.waitForTimeout(500);
  await expect(previewTab(page)).toHaveCount(0);
  // Navigate via the file tree (client-side routing).
  await page.locator('[data-testid="repos-file-tree-container"]').getByText('index.html', { exact: true }).first().click();
  await expect(page).toHaveURL(/blob\/main\/index\.html$/);
  await expect(previewTab(page)).toHaveCount(1);
  await ensurePreview(page);
  const inner = await previewedFrame(page, extensionId);
  await expect(inner.locator('h1')).toContainText('Mozilla is cool');
  // Navigating away removes the preview and the tab.
  await page.locator('[data-testid="repos-file-tree-container"]').getByText('README.md', { exact: true }).first().click();
  await expect(page).toHaveURL(/README\.md$/);
  await expect(page.locator('#gitifact-panel')).toHaveCount(0);
  await expect(previewTab(page)).toHaveCount(0);
});

test('switches viewport width, reloads and exposes an "open in new tab" link', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await openBlob(page, `${MDN_REPO}/blob/main/index.html`);
  await ensurePreview(page);
  await previewedFrame(page, extensionId);
  // Keep GitHub's sticky header from overlapping the preview toolbar.
  await page.evaluate(() => window.scrollTo(0, 0));
  const pf = previewFrame(page, extensionId);
  await pf.locator('#width-mobile').click();
  const sandboxFrame = page.frames().find((f) => f.parentFrame() === pf)!;
  await expect(sandboxFrame.locator('iframe')).toHaveCSS('width', '375px');
  await pf.locator('#width-desktop').click();
  await expect(sandboxFrame.locator('iframe')).not.toHaveCSS('width', '375px');
  await pf.locator('#reload').click();
  await expect(pf.locator('#status')).toContainText('inlined');
  const href = await pf.locator('#newtab').getAttribute('href');
  expect(href).toMatch(new RegExp(`^chrome-extension://${extensionId}/preview.html\\?owner=mdn&repo=beginner-html-site-styled`));
  expect(href).not.toContain('embedded=1');
  // The link works stand-alone in a new tab.
  const tab = await context.newPage();
  await tab.goto(href!);
  const inner = await previewedFrame(tab, extensionId);
  await expect(inner.locator('h1')).toContainText('Mozilla is cool');
});

test('resizes the embedded preview by dragging the handle', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await openBlob(page, `${MDN_REPO}/blob/main/index.html`);
  await ensurePreview(page);
  await previewedFrame(page, extensionId);
  const frame = page.locator('#gitifact-panel iframe');
  const before = (await frame.boundingBox())!.height;
  const handle = page.locator('.gitifact-resizer');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 150, { steps: 5 });
  await page.mouse.up();
  const after = (await frame.boundingBox())!.height;
  expect(Math.round(after - before)).toBeGreaterThanOrEqual(140);
});

test('matches GitHub dark mode', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme: 'dark' });
  await openBlob(page, `${MDN_REPO}/blob/main/index.html`);
  await ensurePreview(page);
  await previewedFrame(page, extensionId);
  const pf = previewFrame(page, extensionId);
  await expect(pf.locator('html')).toHaveAttribute('data-theme', 'dark');
  const bg = await pf.locator('.toolbar').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgb(21, 27, 35)');
});

test('runs repository JavaScript only after the user enables it', async ({ context, extensionId }) => {
  // MDN number guessing game: a single HTML file with an inline <script>.
  const page = await context.newPage();
  await openBlob(page, 'https://github.com/mdn/learning-area/blob/main/javascript/introduction-to-js-1/first-splash/number-guessing-game.html');
  await ensurePreview(page);
  let inner = await previewedFrame(page, extensionId);
  await inner.locator('.guessField').fill('50');
  await inner.locator('.guessSubmit').click();
  await page.waitForTimeout(300);
  await expect(inner.locator('.lastResult')).toHaveText(''); // scripts are off
  await page.evaluate(() => window.scrollTo(0, 0));
  const pf = previewFrame(page, extensionId);
  await pf.locator('#opt-js').check();
  await expect(pf.locator('#status')).toContainText('JavaScript on');
  inner = await previewedFrame(page, extensionId);
  await inner.locator('.guessField').fill('50');
  await inner.locator('.guessSubmit').click();
  await expect(inner.locator('.lastResult')).toHaveText(/Wrong!|Congratulations/);
});
