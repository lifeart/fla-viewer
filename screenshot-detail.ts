import puppeteer from 'puppeteer';

async function main() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 });

  // Force cache bypass
  await page.setCacheEnabled(false);

  console.log('Loading test page...');
  await page.goto('http://localhost:5174/test-viewport.html?t=' + Date.now(), { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.pair canvas', { timeout: 30000 });
  await new Promise(r => setTimeout(r, 5000));

  const pairs = await page.$$('.pair');
  for (let i = 0; i < Math.min(pairs.length, 5); i++) {
    const pair = pairs[i];
    const title = await pair.$eval('h3', el => el.textContent || '');
    await pair.screenshot({ path: `/tmp/detail_${i}_${title.replace(/[^a-zA-Z0-9_-]/g, '')}.png` });
    console.log(`Captured pair ${i}: ${title}`);
  }

  // Also capture the full page
  await page.screenshot({ path: '/tmp/viewport-test-v2.png', fullPage: true });

  await browser.close();
}

main().catch(console.error);
