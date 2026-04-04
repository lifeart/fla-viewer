import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const [elementName, drawingName] = args;

if (!elementName || !drawingName) {
  console.error('Usage: node scripts/dump-tvg-text-labels.mjs <elementName> <drawingName>');
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

    const zip = await JSZipMod.default.loadAsync(
      await (await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip')).arrayBuffer(),
    );
    const externalColors = pal.flattenExternalPaletteColors(await pal.loadPalettes(zip));
    const base = `CH_Anna_rig_football_suit_V001_V07/elements/${elementName}`;
    const drawing = tvg.parseTVG(await zip.file(`${base}/${drawingName}.tvg`).async('arraybuffer'));
    tvg.resolveExternalPalette(drawing, externalColors);

    return drawing.layers.map((layer, layerIndex) => ({
      layerIndex,
      type: layer.type,
      textLabels: (layer.textLabels ?? []).map(label => ({
        text: label.text,
        fontFamily: label.fontFamily,
        fontSize: label.fontSize,
        x: label.x,
        y: label.y,
        scaleX: label.scaleX,
        scaleY: label.scaleY,
        matrixB: label.matrixB ?? 0,
        matrixC: label.matrixC ?? 0,
      })),
    })).filter(layer => layer.textLabels.length > 0);
  }, { elementName, drawingName });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
