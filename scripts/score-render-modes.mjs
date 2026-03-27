import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const [elementName, drawingName] = args;

if (!elementName || !drawingName) {
  console.error('Usage: node scripts/score-render-modes.mjs <elementName> <drawingName>');
  process.exit(1);
}

const browser = await puppeteer.launch({ headless: 'new' });

try {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(0);
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async ({ elementName, drawingName }) => {
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

    async function scoreCanvas(canvas) {
      if (canvas) {
        await tvg.loadBitmapTiles(canvas, drawing.diagnostics);
      }
      return bench.scoreCanvasSources(thumb, canvas, 160);
    }

    const normal = tvg.renderTVGToCanvas(drawing, 160, 160, viewport, { supersample: 2 });
    const normalScore = await scoreCanvas(normal);
    const centered = tvg.renderTVGToCanvas(drawing, 160, 160, viewport, { supersample: 2, centerOnOrigin: true });
    const centeredScore = await scoreCanvas(centered);
    const autoFit = tvg.renderTVGToCanvas(drawing, 160, 160, undefined, { supersample: 2 });
    const autoFitScore = await scoreCanvas(autoFit);

    const layerTypes = ['underlay', 'color', 'line', 'overlay'];
    const perShape = document.createElement('canvas');
    perShape.width = 160;
    perShape.height = 160;
    const perShapeCtx = perShape.getContext('2d');
    perShapeCtx.fillStyle = '#ffffff';
    perShapeCtx.fillRect(0, 0, 160, 160);

    for (const layerType of layerTypes) {
      for (let li = 0; li < drawing.layers.length; li++) {
        const layer = drawing.layers[li];
        if (layer.type !== layerType) continue;
        for (let si = 0; si < layer.shapes.length; si++) {
          const oneShape = {
            ...drawing,
            layers: drawing.layers.map((entry, entryIndex) =>
              entryIndex === li
                ? { ...entry, shapes: [entry.shapes[si]] }
                : { ...entry, shapes: [] },
            ),
          };
          const shapeCanvas = tvg.renderTVGToCanvas(oneShape, 160, 160, viewport, { supersample: 2 });
          if (shapeCanvas) {
            await tvg.loadBitmapTiles(shapeCanvas, oneShape.diagnostics);
            perShapeCtx.drawImage(shapeCanvas, 0, 0);
          }
        }
      }
    }

    const perShapeScore = bench.scoreCanvasSources(thumb, perShape, 160);

    return {
      viewport,
      normalScore,
      centeredScore,
      autoFitScore,
      perShapeScore,
    };
  }, { elementName, drawingName });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
