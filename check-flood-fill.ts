import puppeteer from 'puppeteer';

async function main() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 });
  await page.setCacheEnabled(false);

  // Capture console messages
  page.on('console', msg => {
    if (msg.text().includes('Flood-fill') || msg.text().includes('flood')) {
      console.log('CONSOLE:', msg.text());
    }
  });

  await page.goto('http://localhost:5174/test-viewport.html?t=' + Date.now(), { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.pair canvas', { timeout: 30000 });
  await new Promise(r => setTimeout(r, 5000));

  await browser.close();
}

main().catch(console.error);
