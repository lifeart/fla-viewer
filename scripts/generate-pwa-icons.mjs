// Renders public/favicon.svg to the PNG app icons the web app manifest lists.
// Run: node scripts/generate-pwa-icons.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pub = fileURLToPath(new URL('../public/', import.meta.url));
const svg = readFileSync(pub + 'favicon.svg', 'utf8');

const icons = [
  { file: 'pwa-192x192.png', size: 192, maskable: false },
  { file: 'pwa-512x512.png', size: 512, maskable: false },
  // Maskable: full-bleed background, logo inside the 80% safe zone
  { file: 'pwa-maskable-512x512.png', size: 512, maskable: true },
];

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage();
for (const { file, size, maskable } of icons) {
  await page.setViewportSize({ width: size, height: size });
  const logo = maskable ? size * 0.8 : size;
  await page.setContent(`<html><body style="margin:0;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;background:${maskable ? '#2563eb' : 'transparent'}">
    <div style="width:${logo}px;height:${logo}px">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body></html>`);
  await page.screenshot({ path: pub + file, omitBackground: !maskable });
}
await browser.close();
