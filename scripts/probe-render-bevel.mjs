// Render ONLY Symbol 2 shape[1] (the bevel frame) via the PRODUCTION renderer
// and report nonzero pixel counts per fill color, so we can SEE which of the 4
// bevels paint. Writes a PNG for visual inspection.
// Usage: node scripts/probe-render-bevel.mjs [out.png]
import { readFileSync, writeFileSync } from 'fs';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const outPath = process.argv[2] ?? 'test-results/bevel-current.png';

const entry = `
import { OLE2File } from './src/ole2-reader';
import { decodeStreamShapes } from './src/binary-shape-decoder';
import { FLARenderer } from './src/renderer';
window.__fla = { OLE2File, decodeStreamShapes, FLARenderer };
`;
const bundled = await build({
  stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'error',
});
const code = bundled.outputFiles[0].text;
const flaBase64 = readFileSync('src/__tests__/fixtures/btnstrob.fla').toString('base64');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const consoleLines = [];
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));
await page.setContent('<!doctype html><html><body><canvas id="c"></canvas></body></html>');
await page.addScriptTag({ content: code });

const result = await page.evaluate(async ({ flaBase64 }) => {
  const { OLE2File, decodeStreamShapes, FLARenderer } = window.__fla;
  const bin = atob(flaBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ole = new OLE2File(bytes);
  const res = decodeStreamShapes(ole.readStream('Symbol 2'));
  const shape = res.shapes[1];

  // The shape coords are centered ~(0,0), spanning x:-140..140 y:-60..60.
  // Wrap it with a translate so it sits in a 320x160 canvas.
  const W = 320, H = 160;
  const canvas = document.getElementById('c');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#888888'; ctx.fillRect(0, 0, W, H); // neutral gray bg

  // Drive the PRODUCTION region builder directly (getOrComputeShapePaths) and
  // paint each fill path with the shape's real fill colors — exactly what
  // renderShape does, minus the timeline plumbing.
  const renderer = new FLARenderer(canvas);
  const cached = renderer.getOrComputeShapePaths(shape);
  const fillStyleById = new Map(shape.fills.map((f) => [f.index, f]));

  ctx.save();
  ctx.translate(W / 2, H / 2);
  const sortedFills = Array.from(cached.fillPaths.entries()).sort((a, b) => a[0] - b[0]);
  const paintedFills = [];
  for (const [styleIndex, path] of sortedFills) {
    const fill = fillStyleById.get(styleIndex);
    if (!fill) continue;
    paintedFills.push(styleIndex);
    ctx.fillStyle = renderer.getFillStyle(fill);
    ctx.fill(path, 'nonzero');
  }
  ctx.restore();

  const img = ctx.getImageData(0, 0, W, H);
  // The 4 bevel colors over the gray bg blend; report mean brightness in a band
  // ON each bevel (top/bottom/left/right). A bevel that PAINTS shifts its band
  // away from the bg brightness (white >136, black <136); a MISSING bevel stays
  // ~136. Pre-fix, left & right read ~136 (blank); post-fix they paint.
  function meanBrightness(x0, y0, x1, y1) {
    let sum = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      sum += (img.data[i] + img.data[i+1] + img.data[i+2]) / 3; n++;
    }
    return +(sum / n).toFixed(1);
  }
  const cx = W / 2, cy = H / 2;
  // Sample bands ON each bevel: top band, bottom band, left band, right band.
  const regions = {
    top: meanBrightness(cx - 60, cy - 55, cx + 60, cy - 45),
    bottom: meanBrightness(cx - 60, cy + 45, cx + 60, cy + 55),
    left: meanBrightness(cx - 135, cy - 30, cx - 125, cy + 30),
    right: meanBrightness(cx + 125, cy - 30, cx + 135, cy + 30),
  };
  return {
    fills: shape.fills.map((f) => ({ index: f.index, color: f.color, alpha: f.alpha })),
    edgeRefs: shape.edges.map((e) => ({ f0: e.fillStyle0 ?? 0, f1: e.fillStyle1 ?? 0 })),
    paintedFillIndices: paintedFills,
    fillPathCount: cached.fillPaths.size,
    regionBrightness: regions,
    bgBrightness: 136, // 0x88
    dataUrl: canvas.toDataURL('image/png'),
    consoleTail: [],
  };
}, { flaBase64 });
await browser.close();

writeFileSync(outPath, Buffer.from(result.dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
console.log(JSON.stringify({ out: outPath, ...result, dataUrl: undefined }, null, 2));
console.log('\nInterpretation: bg gray=136. A bevel that PAINTS shifts its band away from 136');
console.log('(white bevels brighter >136, black bevels darker <136). A MISSING bevel stays ~136.');
console.log('consoleLines:', consoleLines.slice(-10).join('\n'));
