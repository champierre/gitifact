/**
 * Playwright fixture that launches Chromium with the built extension (dist/) loaded.
 * Build first: `npm run build`. Set HEADED=1 to watch the browser.
 */
import { test as base, chromium, type BrowserContext, type Page, type Frame } from '@playwright/test';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';

const distPath = path.resolve(process.cwd(), 'dist');

export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'gitifact-e2e-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: !process.env.HEADED,
      args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
      viewport: { width: 1400, height: 1000 },
      colorScheme: 'light',
    });
    await use(context);
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  },
  extensionId: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(sw.url().split('/')[2]!);
  },
});

export const expect = test.expect;

/** Opens a GitHub blob page and returns the page once GitHub's sticky header rendered. */
export async function openBlob(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('#repos-sticky-header').waitFor({ state: 'attached' });
}

export function previewTab(page: Page) {
  return page.locator('[data-gitifact="preview-button"]');
}

/** Returns the Playwright frame for the previewed document (github page → preview.html → sandbox.html → srcdoc). */
export async function previewedFrame(page: Page, extensionId: string, timeout = 30_000): Promise<Frame> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const previewFrame = page.frames().find((f) => f.url().startsWith(`chrome-extension://${extensionId}/preview.html`));
    const sandboxFrame = previewFrame && page.frames().find((f) => f.parentFrame() === previewFrame && f.url().includes('sandbox.html'));
    const inner = sandboxFrame && page.frames().find((f) => f.parentFrame() === sandboxFrame);
    if (inner) {
      const ready = await inner.evaluate(() => document.readyState).catch(() => 'loading');
      if (ready === 'complete' && (await inner.evaluate(() => document.body?.innerHTML.length ?? 0).catch(() => 0)) > 0) return inner;
    }
    await page.waitForTimeout(200);
  }
  throw new Error('previewed document did not appear');
}

/** Toggles a preview option and waits until the preview has been re-rendered with it. */
export async function setOption(page: Page, extensionId: string, option: 'js' | 'external', on: boolean): Promise<void> {
  const pf = previewFrame(page, extensionId);
  await page.evaluate(() => window.scrollTo(0, 0));
  await pf.locator('#frame-wrap').evaluate((el) => el.classList.add('loading'));
  await pf.locator(option === 'js' ? '#opt-js' : '#opt-external').setChecked(on);
  await pf.locator('#frame-wrap').evaluate((el) => el.classList.add('loading'));
  await pf.locator('#status').filter({ hasText: option === 'js' ? (on ? 'JavaScript on' : 'JavaScript off') : on ? 'external resources allowed' : 'external resources blocked' }).waitFor();
  await pf.locator('#frame-wrap:not(.loading)').waitFor();
}

export function previewFrame(page: Page, extensionId: string): Frame {
  const f = page.frames().find((f) => f.url().startsWith(`chrome-extension://${extensionId}/preview.html`));
  if (!f) throw new Error('preview frame not found');
  return f;
}
