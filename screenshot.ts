import puppeteer from 'puppeteer';

async function main() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 2400, deviceScaleFactor: 1 });

  console.log('Loading test page...');
  await page.goto('http://localhost:5174/test-viewport.html', { waitUntil: 'networkidle0', timeout: 60000 });

  // Wait for rendering to complete
  await page.waitForSelector('.pair canvas', { timeout: 30000 });
  // Wait a bit more for all drawings to render
  await new Promise(r => setTimeout(r, 3000));

  console.log('Taking screenshot...');
  await page.screenshot({ path: '/tmp/viewport-test.png', fullPage: true });

  // Also capture the info text
  const info = await page.$eval('#info', el => el.textContent);
  console.log('Info:\n' + info);

  await browser.close();
  console.log('Screenshot saved to /tmp/viewport-test.png');
}

main().catch(console.error);
