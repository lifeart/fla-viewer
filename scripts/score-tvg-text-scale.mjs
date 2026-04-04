import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const [elementName, drawingName, scalesArg] = args;

if (!elementName || !drawingName || !scalesArg) {
  console.error('Usage: node scripts/score-tvg-text-scale.mjs <elementName> <drawingName> <scale,scale,...>');
  process.exit(1);
}

const scales = scalesArg
  .split(',')
  .map(value => Number.parseFloat(value))
  .filter(value => Number.isFinite(value) && value > 0);

if (scales.length === 0) {
  console.error('Provide at least one positive scale value.');
  process.exit(1);
}

const browser = await puppeteer.launch({ headless: 'new' });

try {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(0);
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async ({
    elementName,
    drawingName,
    scales,
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

    async function scoreForScale(scale) {
      const scaled = {
        ...drawing,
        layers: drawing.layers.map(layer => ({
          ...layer,
          textLabels: (layer.textLabels ?? []).map(label => ({
            ...label,
            fontSize: Math.max(1, label.fontSize * scale),
          })),
        })),
      };
      const canvas = tvg.renderTVGToCanvas(scaled, 160, 160, viewport, { supersample: 2 });
      if (canvas) {
        await tvg.loadBitmapTiles(canvas, scaled.diagnostics);
      }
      return bench.scoreCanvasSources(thumb, canvas, 160);
    }

    const rows = [];
    for (const scale of scales) {
      rows.push({ scale, score: await scoreForScale(scale) });
    }
    return rows;
  }, { elementName, drawingName, scales });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
