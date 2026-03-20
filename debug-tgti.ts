import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });

  const logs: string[] = [];
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('[tGTI]')) logs.push(text);
  });

  // Load just F-14 to see tGTI data
  await page.goto('http://localhost:5174/test-diag.html?t=' + Date.now(), { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  console.log(`\nFound ${logs.length} tGTI entries:\n`);
  for (const log of logs) {
    console.log(log);
  }

  await browser.close();
}
main().catch(console.error);
