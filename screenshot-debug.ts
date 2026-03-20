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

const resp = await fetch('sample/toon/CH_Anna_rig_football_suit_V001_V07.zip');
const zip = await JSZip.loadAsync(await resp.arrayBuffer());

// Load palettes
const palettes = [];
const pltPaths = [];
zip.forEach(p => { if (p.endsWith('.plt') && p.includes('palette-library/')) pltPaths.push(p); });
for (const p of pltPaths) {
  const text = await zip.file(p).async('text');
  for (const line of text.split('\\n')) {
    const m = line.match(/^Solid\\s+(\\S+)\\s+(0x\\w+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)/);
    if (m) palettes.push({ r: +m[3], g: +m[4], b: +m[5], a: +m[6], id: m[2] });
  }
}

let tvgPath = null;
zip.forEach(p => { if (p.includes('F-Hand_OL_1_F-11.tvg')) tvgPath = p; });
const buf = await zip.file(tvgPath).async('arraybuffer');
const drawing = parseTVG(buf);
resolveExternalPalette(drawing, palettes);

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
