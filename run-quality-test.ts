import { chromium } from 'playwright';

async function main() {
  const mode = process.argv[2] || 'full'; // 'target' or 'full'
  console.log(`Running quality test in ${mode} mode...`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });

  // Listen for console messages
  page.on('console', msg => {
    if (msg.type() === 'error') console.error('[browser]', msg.text());
  });

  await page.goto(`http://localhost:5173/test-quality.html?mode=${mode}`, {
    waitUntil: 'networkidle',
    timeout: 120000,
  });

  // Wait for results to be ready (poll for window.__qualityResults)
  console.log('Waiting for quality test to complete...');
  await page.waitForFunction('window.__qualityResults', { timeout: 600000 });

  // Extract results
  const data = await page.evaluate('window.__qualityResults');
  const results = data as any;

  // Print summary
  const pre = await page.textContent('#results');
  console.log('\n' + pre);

  // Print focused results for below-90% drawings
  if (results.below90Count > 0) {
    console.log('\n=== DRAWINGS BELOW 90% ===');
    for (const r of results.results) {
      if (!r.skip && r.overall < 90) {
        console.log(`  ${r.name}: cover=${r.coverage}% color=${r.color}% shape=${r.shape}% overall=${r.overall}%`);
      }
    }
  }

  console.log(`\nFinal: ${results.totalValid} drawings, average=${results.average}%, below90=${results.below90Count}`);

  await browser.close();
  process.exit(results.average >= 90 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
