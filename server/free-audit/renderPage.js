import { assertPublicUrl } from './urlGuard.js';

async function renderPageDetails(url) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return { available: false, text: null, loadTimeMs: null, resources: null, consoleErrors: null, screenshotDesktop: null, screenshotMobile: null, cls: null };
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    // Default desktop viewport
    await page.setViewportSize({ width: 1280, height: 800 });

    // Accumulate Cumulative Layout Shift for the "Agentic Browsing" stability
    // check — installed before navigation so it captures shifts from the
    // very first paint, same as how CLS is measured for real users.
    await page.addInitScript(() => {
      window.__clsValue = 0;
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (!entry.hadRecentInput) {
              window.__clsValue += entry.value;
            }
          }
        }).observe({ type: 'layout-shift', buffered: true });
      } catch {}
    });

    const resources = { count: 0, bytes: 0, byType: {} };
    const consoleErrors = [];

    page.on('response', (response) => {
      resources.count += 1;
      const type = response.request().resourceType();
      const len = Number(response.headers()['content-length'] || 0);
      resources.bytes += len;
      resources.byType[type] = (resources.byType[type] || 0) + 1;
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // The page controls what the browser requests next (redirects, scripts,
    // images, iframes). Block anything that isn't a public host.
    await page.route('**/*', async (route) => {
      try {
        await assertPublicUrl(new URL(route.request().url()));
        await route.continue();
      } catch {
        await route.abort('blockedbyclient').catch(() => {});
      }
    });

    const startedAt = Date.now();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 8000 });
    const loadTimeMs = Date.now() - startedAt;

    const text = await page.evaluate(() => document.body.innerText || '');
    const cls = await page.evaluate(() => window.__clsValue || 0);

    // Capture desktop screenshot
    const desktopBuf = await page.screenshot({ type: 'jpeg', quality: 50 });

    // Transition to mobile viewport size and wait for layout adjustments
    await page.setViewportSize({ width: 375, height: 667 });
    await new Promise(resolve => setTimeout(resolve, 500));
    const mobileBuf = await page.screenshot({ type: 'jpeg', quality: 50 });

    return {
      available: true,
      text,
      loadTimeMs,
      resources,
      consoleErrors,
      screenshotDesktop: desktopBuf.toString('base64'),
      screenshotMobile: mobileBuf.toString('base64'),
      cls
    };
  } catch (err) {
    console.error('Playwright render error:', err);
    return { available: true, text: null, loadTimeMs: null, resources: null, consoleErrors: null, screenshotDesktop: null, screenshotMobile: null, cls: null };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

export { renderPageDetails };
