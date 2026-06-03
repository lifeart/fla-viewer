// Standalone render harness for binary FLAs (issue #8 instance-placement proof).
//
// Bundles the PRODUCTION parser (parseBinaryFLA) + renderer (FLARenderer) with
// esbuild, loads them in a headless Playwright Chromium (a private instance,
// NOT the shared Chrome MCP browser), renders frame 0 of the binary FLA's scene
// to a real <canvas>, and writes the canvas to a PNG for visual inspection.
//
// Usage: node scripts/render-binary-fla.mjs <in.fla> <out.png> [frameIndex]
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'fs';
import { chromium } from 'playwright';

const [, , inPath, outPath, frameArg] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: render-binary-fla.mjs <in.fla> <out.png> [frameIndex]');
  process.exit(1);
}
const frameIndex = frameArg ? parseInt(frameArg, 10) : 0;

// Bundle a tiny entry that exposes the production parser + renderer on window.
const entry = `
import { parseBinaryFLA } from './src/binary-fla-parser';
import { FLARenderer } from './src/renderer';
window.__fla = { parseBinaryFLA, FLARenderer };
`;
const bundled = await build({
  stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  write: false,
  logLevel: 'error',
});
const code = bundled.outputFiles[0].text;

const flaBytes = readFileSync(inPath);
const flaBase64 = flaBytes.toString('base64');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const consoleLines = [];
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));

await page.setContent('<!doctype html><html><body><canvas id="c"></canvas></body></html>');
await page.addScriptTag({ content: code });

const result = await page.evaluate(async ({ flaBase64, frameIndex }) => {
  const { parseBinaryFLA, FLARenderer } = window.__fla;
  const bin = atob(flaBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const doc = parseBinaryFLA(bytes);
  const canvas = document.getElementById('c');
  canvas.width = doc.width;
  canvas.height = doc.height;

  const renderer = new FLARenderer(canvas);
  await renderer.setDocument(doc, /* skipResize */ true);
  renderer.renderFrame(frameIndex);

  // Count non-background pixels for an objective "is anything drawn" signal.
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  // Sample the background color from the corner.
  const bg = [img.data[0], img.data[1], img.data[2], img.data[3]];
  let nonBg = 0;
  const colorHist = {};
  for (let i = 0; i < img.data.length; i += 4) {
    const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2], a = img.data[i + 3];
    if (r !== bg[0] || g !== bg[1] || b !== bg[2] || a !== bg[3]) {
      nonBg++;
      const key = `${r},${g},${b}`;
      colorHist[key] = (colorHist[key] || 0) + 1;
    }
  }
  const topColors = Object.entries(colorHist).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const dataUrl = canvas.toDataURL('image/png');
  return {
    width: doc.width,
    height: doc.height,
    backgroundColor: doc.backgroundColor,
    nonBackgroundPixels: nonBg,
    totalPixels: (img.data.length / 4),
    topColors,
    symbolKeys: [...doc.symbols.keys()],
    sceneElementCounts: doc.timelines.map((t) => ({
      name: t.name,
      layers: t.layers.map((l) => ({ name: l.name, els: l.frames[0]?.elements.length ?? 0, types: (l.frames[0]?.elements ?? []).map((e) => e.type) })),
    })),
    dataUrl,
  };
}, { flaBase64, frameIndex });

await browser.close();

const b64 = result.dataUrl.replace(/^data:image\/png;base64,/, '');
writeFileSync(outPath, Buffer.from(b64, 'base64'));

console.log(JSON.stringify({
  in: inPath, out: outPath, frameIndex,
  width: result.width, height: result.height,
  backgroundColor: result.backgroundColor,
  nonBackgroundPixels: result.nonBackgroundPixels,
  totalPixels: result.totalPixels,
  topColors: result.topColors,
  symbolKeys: result.symbolKeys,
  sceneElementCounts: result.sceneElementCounts,
  consoleLines,
}, null, 2));
