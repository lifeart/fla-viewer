/**
 * Generate OG image for social sharing using Playwright
 * Run with: npx tsx scripts/generate-og-image.ts
 *
 * Make sure to start the dev server first: npm run dev
 */
import { chromium } from 'playwright';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// Try multiple ports in case some are in use
const PORTS_TO_TRY = [5173, 3000, 3001, 3002, 3003, 4173];

async function findRunningServer(): Promise<string | null> {
  for (const port of PORTS_TO_TRY) {
    try {
      const url = `http://localhost:${port}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        return url;
      }
    } catch {
      // Port not available
    }
  }
  return null;
}

async function generateOGImage(): Promise<void> {
  // Find running dev server
  console.log('Looking for dev server...');
  const serverUrl = await findRunningServer();

  if (!serverUrl) {
    console.error('No dev server found! Please start it with: npm run dev');
    process.exit(1);
  }

  console.log(`Found dev server at: ${serverUrl}`);

  // Launch browser
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 2, // Retina for crisp image
  });
  const page = await context.newPage();

  try {
    // Navigate to the app
    await page.goto(serverUrl);
    console.log('Page loaded');

    // Click the sample button to load the sample animation
    await page.click('#load-sample-btn');
    console.log('Loading sample FLA...');

    // Wait for the viewer to become active (animation loaded)
    await page.waitForSelector('#viewer.active', { timeout: 30000 });
    console.log('Animation loaded');

    // Wait for the first frame to render
    await page.waitForTimeout(500);

    // Click play to start the animation
    await page.click('#play-btn');
    await page.waitForTimeout(800);

    // Pause for a clean screenshot
    await page.click('#play-btn');
    await page.waitForTimeout(200);

    // Take the screenshot
    const outputPath = join(projectRoot, 'public', 'og-image.png');
    await page.screenshot({
      path: outputPath,
      type: 'png',
    });
    console.log(`OG image saved to: ${outputPath}`);
  } finally {
    await browser.close();
  }
}

generateOGImage().catch(console.error);
