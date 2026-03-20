import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 2000 }, deviceScaleFactor: 2 });
  await page.goto('http://localhost:5174/test-viewport.html?t=' + Date.now(), { waitUntil: 'networkidle' });
  await page.waitForSelector('.pair canvas', { timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: '/tmp/tvg-comparison-v3.png', fullPage: true });

  // Zoom into specific pairs
  for (const name of ['F_3_symbol-1', 'F-Hand_OL_1_F-14', 'F-Hand_OL_1_F-11']) {
    const pair = page.locator('.pair', { has: page.locator(`h3:text("${name}")`) });
    if (await pair.count() > 0) {
      await pair.screenshot({ path: `/tmp/detail-${name}.png` });
    }
  }

  console.log('done');
  await browser.close();
}
main().catch(console.error);
