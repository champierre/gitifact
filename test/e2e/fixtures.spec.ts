import { test, expect, openBlob, previewTab, ensurePreview, previewedFrame, previewFrame } from './extension';

/**
 * These tests render the fixtures under test/fixtures via the real GitHub UI. They need the
 * fixtures to be pushed to GitHub (see test/fixtures/README.md) and skip themselves otherwise.
 */
const REPO = process.env.GITIFACT_E2E_REPO || 'champierre/gitifact';
const BRANCH = process.env.GITIFACT_E2E_BRANCH || 'main';
const SLASH_BRANCH = process.env.GITIFACT_E2E_SLASH_BRANCH || 'e2e/slash-branch';
const FIX = 'test/fixtures';

async function available(ref: string): Promise<boolean> {
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${REPO}/refs/heads/${ref}/${FIX}/single.html`, { method: 'HEAD' });
    return r.ok;
  } catch {
    return false;
  }
}

test.describe('fixtures', () => {
  test.beforeEach(async () => {
    test.skip(!(await available(BRANCH)), `fixtures not reachable on github.com/${REPO}@${BRANCH}; push them first`);
  });
  const url = (file: string, ref = BRANCH) => `https://github.com/${REPO}/blob/${ref}/${FIX}/${file}`;

  test('1. single HTML file', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openBlob(page, url('single.html'));
    await ensurePreview(page);
    const inner = await previewedFrame(page, extensionId);
    await expect(inner.locator('#title')).toHaveText('Single HTML file');
    await expect(previewFrame(page, extensionId).locator('#status')).toContainText('0 resources inlined');
  });

  test('2. inline CSS', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openBlob(page, url('inline-css.html'));
    await ensurePreview(page);
    const inner = await previewedFrame(page, extensionId);
    await expect(inner.locator('#box')).toHaveCSS('background-color', 'rgb(255, 99, 71)');
    await expect(inner.locator('#box')).toHaveCSS('border-top-color', 'rgb(0, 0, 255)');
  });

  test('3. external CSS with @import and url()', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openBlob(page, url('external-css.html'));
    await ensurePreview(page);
    const inner = await previewedFrame(page, extensionId);
    await expect(inner.locator('#title')).toHaveCSS('color', 'rgb(0, 128, 0)');
    await expect(inner.locator('#imported')).toHaveCSS('color', 'rgb(128, 0, 128)');
    await expect(inner.locator('#bg')).toHaveCSS('background-image', /^url\("data:image\/png;base64,/);
  });

  test('4. images (relative, root-relative, srcset, svg, missing, external)', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openBlob(page, url('images.html'));
    await ensurePreview(page);
    const inner = await previewedFrame(page, extensionId);
    for (const id of ['png', 'svg', 'root', 'picture']) {
      expect(await inner.locator(`#${id}`).evaluate((i: HTMLImageElement) => i.naturalWidth), id).toBeGreaterThan(0);
    }
    // External resources are allowed → the avatar loads.
    await expect.poll(() => inner.locator('#external').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
    const pf = previewFrame(page, extensionId);
    await expect(pf.locator('#warnings-summary')).toContainText('1 resource could not be loaded');
    await expect(pf.locator('#warnings-list')).toContainText('does-not-exist.png');
  });

  test('5. JavaScript runs', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openBlob(page, url('script.html'));
    await ensurePreview(page);
    const inner = await previewedFrame(page, extensionId);
    await expect(inner.locator('#out')).toHaveText('JavaScript ran: 4');
    await inner.locator('#btn').click();
    await expect(inner.locator('#out')).toHaveText('clicked');
  });

  test('6. HTML in a subdirectory, with in-preview link navigation', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openBlob(page, url('sub/dir/page.html'));
    await ensurePreview(page);
    const inner = await previewedFrame(page, extensionId);
    await expect(inner.locator('#title')).toHaveCSS('color', 'rgb(0, 128, 0)');
    await expect(inner.locator('#local')).toHaveCSS('color', 'rgb(255, 0, 0)');
    expect(await inner.locator('#up').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
    await inner.locator('#link').click();
    const pf = previewFrame(page, extensionId);
    await expect(pf.locator('#file-link')).toHaveText(`${FIX}/single.html`);
    await pf.locator('#frame-wrap:not(.loading)').waitFor();
    await expect((await previewedFrame(page, extensionId)).locator('h1')).toHaveText('Single HTML file');
  });

  test('7. branch name containing "/"', async ({ context, extensionId }) => {
    test.skip(!(await available(SLASH_BRANCH)), `branch ${SLASH_BRANCH} not found; push it first`);
    const page = await context.newPage();
    await openBlob(page, url('sub/dir/page.html', SLASH_BRANCH));
    await ensurePreview(page);
    const inner = await previewedFrame(page, extensionId);
    await expect(inner.locator('#title')).toHaveCSS('color', 'rgb(0, 128, 0)');
    const pf = previewFrame(page, extensionId);
    await expect(pf.locator('#ref')).toHaveText(SLASH_BRANCH);
    await expect(pf.locator('#file-link')).toHaveText(`${FIX}/sub/dir/page.html`);
  });

  test('10. malicious HTML stays contained inside the preview', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openBlob(page, url('malicious.html'));
    await ensurePreview(page);
    const inner = await previewedFrame(page, extensionId);
    await expect(inner.locator('#results li')).toHaveCount(10);
    const blocked = await inner.locator('#results li').evaluateAll((lis) => lis.map((li) => li.dataset.blocked));
    expect(blocked.every((b) => b === 'true')).toBe(true);
    await expect(page).toHaveURL(/malicious\.html/);
    expect(context.pages().length).toBe(2); // the initial blank page + ours: no popup
  });
});
