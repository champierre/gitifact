import { test, openBlob, previewTab, ensurePreview, previewedFrame } from './extension';

// Produces the README screenshots: npm run build && npx playwright test screenshots
test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 to regenerate docs/screenshots');

for (const scheme of ['light', 'dark'] as const) {
  test(`screenshot ${scheme}`, async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: scheme });
    await openBlob(page, 'https://github.com/mdn/beginner-html-site-styled/blob/main/index.html');
    await ensurePreview(page);
    await previewedFrame(page, extensionId);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `docs/screenshots/preview-${scheme}.png`, clip: { x: 320, y: 170, width: 1080, height: 720 } });
  });
}
