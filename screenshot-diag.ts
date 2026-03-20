import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 2 });
  // Compare F-12 side by side
  await page.goto('http://localhost:5174/test-viewport.html?t=' + Date.now(), { waitUntil: 'networkidle' });
  await page.waitForSelector('.pair canvas', { timeout: 30000 });
  await page.waitForTimeout(3000);
  for (const name of ['F-Hand_OL_1_F-12', 'F-Hand_OL_1_F-24']) {
    const pair = page.locator('.pair', { has: page.locator(`h3:text("${name}")`) });
    if (await pair.count() > 0) {
      await pair.screenshot({ path: `/tmp/detail-${name}.png` });
    }
  }

  await browser.close();
}
main().catch(console.error);
