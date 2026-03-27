import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const [elementName, drawingName, layerType, shapeIndexArg, componentList, outDirArg] = args;

if (!elementName || !drawingName || !layerType || !shapeIndexArg || !componentList) {
  console.error('Usage: node scripts/export-tvg-components.mjs <elementName> <drawingName> <layerType> <shapeIndex> <componentIds> [outDir]');
  process.exit(1);
}

const shapeIndex = Number.parseInt(shapeIndexArg, 10);
const componentIds = componentList.split(',').map(value => Number.parseInt(value, 10)).filter(Number.isFinite);
if (!Number.isFinite(shapeIndex) || componentIds.length === 0) {
  console.error('shapeIndex and componentIds must be numeric');
  process.exit(1);
}

const outDir = path.resolve(outDirArg ?? '/tmp/tvg-vision');
const caseSlug = `${elementName}__${drawingName}__${layerType}__shape-${shapeIndex}`.replace(/[\\/]/g, '_');
const browser = await puppeteer.launch({ headless: 'new' });

try {
  await fs.mkdir(outDir, { recursive: true });
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(0);
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async ({ elementName, drawingName, layerType, shapeIndex, componentIds }) => {
    const JSZipMod = await import('/node_modules/.vite/deps/jszip.js');
    const tvg = await import('/src/tvg-parser.ts');
    const pal = await import('/src/tpl-palette.ts');
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
    const source = tvg.parseTVG(await zip.file(`${base}/${drawingName}.tvg`).async('arraybuffer'));
    tvg.resolveExternalPalette(source, externalColors);

    const clone = structuredClone(source);
    for (const layer of clone.layers) {
      if (layer.type !== layerType) {
        layer.shapes = [];
        continue;
      }
      layer.shapes = layer.shapes
        .map((shape, index) => {
          if (index !== shapeIndex) return null;
          return {
            ...shape,
            components: shape.components.filter((_, componentIndex) => componentIds.includes(componentIndex)),
          };
        })
        .filter(Boolean);
    }

    const canvas = tvg.renderTVGToCanvas(clone, 160, 160, viewport, { supersample: 2 });
    if (canvas) await tvg.loadBitmapTiles(canvas, clone.diagnostics);
    return canvas ? canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '') : null;
  }, { elementName, drawingName, layerType, shapeIndex, componentIds });

  if (!result) {
    console.error('No canvas produced for requested components');
    process.exit(2);
  }

  await fs.writeFile(
    path.join(outDir, `${caseSlug}__components-${componentIds.join('-')}.png`),
    Buffer.from(result, 'base64'),
  );
  console.log(JSON.stringify({ outDir, caseSlug, shapeIndex, componentIds }, null, 2));
} finally {
  await browser.close();
}
