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

    const diffCanvas = document.createElement('canvas');
    diffCanvas.width = 160 * 3;
    diffCanvas.height = 160;
    const diffCtx = diffCanvas.getContext('2d');
    diffCtx.fillStyle = '#fff';
    diffCtx.fillRect(0, 0, diffCanvas.width, diffCanvas.height);
    diffCtx.drawImage(thumbCanvas, 0, 0);
    diffCtx.drawImage(rendered, 160, 0);

    const refData = thumbCtx.getImageData(0, 0, 160, 160);
    const renderedData = rendered.getContext('2d').getImageData(0, 0, 160, 160);
    const diffData = diffCtx.createImageData(160, 160);
    for (let i = 0; i < refData.data.length; i += 4) {
      const dr = Math.abs(refData.data[i + 0] - renderedData.data[i + 0]);
      const dg = Math.abs(refData.data[i + 1] - renderedData.data[i + 1]);
      const db = Math.abs(refData.data[i + 2] - renderedData.data[i + 2]);
      const refFg = refData.data[i + 0] < 243 || refData.data[i + 1] < 243 || refData.data[i + 2] < 243 || refData.data[i + 3] < 243;
      const renderedFg = renderedData.data[i + 0] < 243 || renderedData.data[i + 1] < 243 || renderedData.data[i + 2] < 243 || renderedData.data[i + 3] < 243;
      if (dr + dg + db <= 30 && refFg === renderedFg) {
        diffData.data[i + 0] = 255;
        diffData.data[i + 1] = 255;
        diffData.data[i + 2] = 255;
      } else if (refFg && !renderedFg) {
        diffData.data[i + 0] = 0;
        diffData.data[i + 1] = 128;
        diffData.data[i + 2] = 255;
      } else if (!refFg && renderedFg) {
        diffData.data[i + 0] = 255;
        diffData.data[i + 1] = 0;
        diffData.data[i + 2] = 0;
      } else {
        diffData.data[i + 0] = 255;
        diffData.data[i + 1] = 180;
        diffData.data[i + 2] = 0;
      }
      diffData.data[i + 3] = 255;
    }
    diffCtx.putImageData(diffData, 160 * 2, 0);

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
        diff: toBase64(diffCanvas),
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
