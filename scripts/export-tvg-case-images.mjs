import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const [elementName, drawingName, outDirArg] = args;

if (!elementName || !drawingName) {
  console.error('Usage: node scripts/export-tvg-case-images.mjs <elementName> <drawingName> [outDir]');
  process.exit(1);
}

const outDir = path.resolve(outDirArg ?? '/tmp/tvg-vision');
const caseSlug = `${elementName}__${drawingName}`.replace(/[\\/]/g, '_');
const browser = await puppeteer.launch({ headless: 'new' });

try {
  await fs.mkdir(outDir, { recursive: true });
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(0);
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async ({ elementName, drawingName }) => {
    const JSZipMod = await import('/node_modules/.vite/deps/jszip.js');
    const tvg = await import('/src/tvg-parser.ts');
    const pal = await import('/src/tpl-palette.ts');
    const bench = await import('/src/tvg-benchmark.ts');
    const tpl = await import('/src/tpl-parser.ts');

    const zip = await JSZipMod.default.loadAsync(
      await (await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip')).arrayBuffer(),
    );
    const xstageXml = new DOMParser().parseFromString(
      await zip.file('CH_Anna_rig_football_suit_V001_V07/scene.xstage').async('text'),
      'text/xml',
    );
    const elements = tpl.parseElements(xstageXml);
    const element = elements.find(entry => entry.name === elementName);
    const viewport = ((element?.fieldChart ?? 12) * tpl.TVG_UNITS_PER_FIELD) || 336;
    const externalColors = pal.flattenExternalPaletteColors(await pal.loadPalettes(zip));
    const base = `CH_Anna_rig_football_suit_V001_V07/elements/${elementName}`;
    const drawing = tvg.parseTVG(await zip.file(`${base}/${drawingName}.tvg`).async('arraybuffer'));
    tvg.resolveExternalPalette(drawing, externalColors);

    const renderCanvas = async (filter) => {
      const canvas = tvg.renderTVGToCanvas(drawing, 160, 160, viewport, filter ? { supersample: 2, artLayerFilter: filter } : { supersample: 2 });
      if (canvas) await tvg.loadBitmapTiles(canvas, drawing.diagnostics);
      return canvas;
    };

    const rendered = await renderCanvas(null);
    const layers = {
      underlay: await renderCanvas('underlay'),
      color: await renderCanvas('color'),
      line: await renderCanvas('line'),
      overlay: await renderCanvas('overlay'),
    };

    const thumbBlob = new Blob(
      [await zip.file(`${base}/.thumbnails/.${drawingName}.tvg.png`).async('arraybuffer')],
      { type: 'image/png' },
    );
    const thumb = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = URL.createObjectURL(thumbBlob);
    });

    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = 160;
    thumbCanvas.height = 160;
    const thumbCtx = thumbCanvas.getContext('2d');
    thumbCtx.fillStyle = '#fff';
    thumbCtx.fillRect(0, 0, 160, 160);
    thumbCtx.drawImage(thumb, 0, 0, 160, 160);

    const toBase64 = (canvas) => {
      if (!canvas) return null;
      return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
    };

    return {
      viewport,
      score: bench.scoreCanvasSources(thumb, rendered, 160),
      diagnostics: drawing.diagnostics,
      images: {
        reference: toBase64(thumbCanvas),
        candidate: toBase64(rendered),
        underlay: toBase64(layers.underlay),
        color: toBase64(layers.color),
        line: toBase64(layers.line),
        overlay: toBase64(layers.overlay),
      },
    };
  }, { elementName, drawingName });

  const writes = Object.entries(result.images)
    .filter(([, base64]) => !!base64)
    .map(async ([name, base64]) => {
      await fs.writeFile(path.join(outDir, `${caseSlug}__${name}.png`), Buffer.from(base64, 'base64'));
    });
  await Promise.all(writes);
  await fs.writeFile(
    path.join(outDir, `${caseSlug}__summary.json`),
    JSON.stringify({
      elementName,
      drawingName,
      viewport: result.viewport,
      score: result.score,
      diagnostics: result.diagnostics,
    }, null, 2),
  );
  console.log(JSON.stringify({
    outDir,
    caseSlug,
    score: result.score,
    diagnostics: result.diagnostics,
  }, null, 2));
} finally {
  await browser.close();
}
