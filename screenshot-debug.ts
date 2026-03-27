import puppeteer from 'puppeteer';

async function main() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 2 });
  await page.setCacheEnabled(false);

  // Use a minimal inline test page that imports the module directly
  const testHtml = `
<!DOCTYPE html><html><body>
<div id="status">Loading...</div>
<div id="canvases"></div>
<script type="module">
import JSZip from 'jszip';
import { parseTVG, renderTVGToCanvas, resolveExternalPalette } from './src/tvg-parser.ts';
import { loadPalettes, flattenExternalPaletteColors } from './src/tpl-palette.ts';

const resp = await fetch('sample/toon/CH_Anna_rig_football_suit_V001_V07.zip');
const zip = await JSZip.loadAsync(await resp.arrayBuffer());
const externalColors = flattenExternalPaletteColors(await loadPalettes(zip));

let tvgPath = null;
zip.forEach(p => { if (p.includes('F-Hand_OL_1_F-11.tvg')) tvgPath = p; });
const buf = await zip.file(tvgPath).async('arraybuffer');
const drawing = parseTVG(buf);
if (externalColors.length > 0) resolveExternalPalette(drawing, externalColors);

// Check if renderTVGToCanvas signature has viewportSize param
const fnStr = renderTVGToCanvas.toString().substring(0, 200);
document.getElementById('status').textContent = 'Function sig: ' + fnStr.substring(0, 100);

const canvas = renderTVGToCanvas(drawing, 320, 320, 336);
if (canvas) {
  canvas.style.border = '1px solid red';
  document.getElementById('canvases').appendChild(canvas);
}
</script>
</body></html>`;

  // Write test page
  const fs = await import('fs');
  fs.writeFileSync('/Users/lifeart/Repos/fla-viewer/test-debug.html', testHtml);

  console.log('Loading...');
  await page.goto('http://localhost:5174/test-debug.html?t=' + Date.now(), { waitUntil: 'networkidle0', timeout: 60000 });
  await new Promise(r => setTimeout(r, 5000));

  // Get status text
  const status = await page.$eval('#status', el => el.textContent);
  console.log('Status:', status);

  // Get console messages
  page.on('console', msg => console.log('CONSOLE:', msg.text()));

  await page.screenshot({ path: '/tmp/debug-render.png' });
  console.log('Screenshot: /tmp/debug-render.png');

  await browser.close();
}

main().catch(console.error);
