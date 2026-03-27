import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const [elementName, drawingName, layerType, maxAlphaArg, multiplierArg, colorFilterArg] = args;

if (!elementName || !drawingName || !layerType || !maxAlphaArg || !multiplierArg) {
  console.error('Usage: node scripts/scale-fill-alpha.mjs <elementName> <drawingName> <layerType> <maxAlpha> <multiplier> [r,g,b]');
  process.exit(1);
}

const maxAlpha = Number.parseInt(maxAlphaArg, 10);
const multiplier = Number.parseFloat(multiplierArg);
const colorFilter = colorFilterArg
  ? colorFilterArg.split(',').map(part => Number.parseInt(part, 10))
  : null;

const browser = await puppeteer.launch({ headless: 'new' });

try {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(0);
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async ({
    elementName,
    drawingName,
    layerType,
    maxAlpha,
    multiplier,
    colorFilter,
  }) => {
    const JSZipMod = await import('/node_modules/.vite/deps/jszip.js');
    const tvg = await import('/src/tvg-parser.ts');
    const pal = await import('/src/tpl-palette.ts');
    const tpl = await import('/src/tpl-parser.ts');
    const bench = await import('/src/tvg-benchmark.ts');

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

    async function renderAndScore(sourceDrawing) {
      const canvas = tvg.renderTVGToCanvas(sourceDrawing, 160, 160, viewport, { supersample: 2 });
      if (canvas) {
        await tvg.loadBitmapTiles(canvas, sourceDrawing.diagnostics);
      }
      return bench.scoreCanvasSources(thumb, canvas, 160);
    }

    const baseScore = await renderAndScore(drawing);
    let changed = 0;
    for (const layer of drawing.layers) {
      if (layer.type !== layerType) continue;
      for (const shape of layer.shapes) {
        for (const comp of shape.components) {
          if ((comp.componentType !== 0 && comp.componentType !== 1) || !comp.outerPaint) continue;
          if (comp.outerPaint.kind !== 'solid' || comp.outerPaint.rgba.a > maxAlpha) continue;
          if (colorFilter
            && (comp.outerPaint.rgba.r !== colorFilter[0]
              || comp.outerPaint.rgba.g !== colorFilter[1]
              || comp.outerPaint.rgba.b !== colorFilter[2])) {
            continue;
          }
          comp.outerPaint = {
            ...comp.outerPaint,
            rgba: {
              ...comp.outerPaint.rgba,
              a: Math.max(0, Math.min(255, Math.round(comp.outerPaint.rgba.a * multiplier))),
            },
          };
          if (comp.color) {
            comp.color = {
              ...comp.color,
              a: Math.max(0, Math.min(255, Math.round(comp.color.a * multiplier))),
            };
          }
          changed++;
        }
      }
    }
    const scaledScore = await renderAndScore(drawing);

    return {
      viewport,
      changed,
      baseScore,
      scaledScore,
      delta: scaledScore.score - baseScore.score,
    };
  }, { elementName, drawingName, layerType, maxAlpha, multiplier, colorFilter });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
