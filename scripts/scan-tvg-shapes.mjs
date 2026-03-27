import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const [elementName, drawingName, layerType = 'line'] = args;

if (!elementName || !drawingName) {
  console.error('Usage: node scripts/scan-tvg-shapes.mjs <elementName> <drawingName> [layerType]');
  process.exit(1);
}

const browser = await puppeteer.launch({ headless: 'new' });

try {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(0);
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async ({ elementName, drawingName, layerType }) => {
    const JSZipMod = await import('/node_modules/.vite/deps/jszip.js');
    const tvg = await import('/src/tvg-parser.ts');
    const pal = await import('/src/tpl-palette.ts');
    const tpl = await import('/src/tpl-parser.ts');

    function foregroundBounds(canvas) {
      if (!canvas) return null;
      const ctx = canvas.getContext('2d');
      const { width, height } = canvas;
      const data = ctx.getImageData(0, 0, width, height).data;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      let count = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const index = (y * width + x) * 4;
          const alpha = data[index + 3];
          if (alpha === 0) continue;
          const r = data[index];
          const g = data[index + 1];
          const b = data[index + 2];
          if (r === 255 && g === 255 && b === 255) continue;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
          count++;
        }
      }
      if (maxX < minX || maxY < minY) return null;
      return { minX, minY, maxX, maxY, count };
    }

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

    const layer = drawing.layers.find(entry => entry.type === layerType);
    if (!layer) {
      return { viewport, layerType, shapes: [] };
    }

      const shapes = [];
      for (let index = 0; index < layer.shapes.length; index++) {
      const single = {
        ...drawing,
        layers: drawing.layers.map(entry =>
          entry === layer ? { ...entry, shapes: [layer.shapes[index]] } : { ...entry, shapes: [] },
        ),
      };
      const canvas = tvg.renderTVGToCanvas(single, 160, 160, viewport, { supersample: 2 });
      if (canvas) {
        await tvg.loadBitmapTiles(canvas, single.diagnostics);
      }
      const bounds = foregroundBounds(canvas);
      if (!bounds) continue;
        const paintKeys = new Map();
        const fillPaintSources = new Map();
        for (const comp of layer.shapes[index].components) {
          const key = comp.outerPaint ? JSON.stringify(comp.outerPaint) : 'null';
          paintKeys.set(key, (paintKeys.get(key) ?? 0) + 1);
          const sourceKey = comp.fillPaintSource ?? 'null';
          fillPaintSources.set(sourceKey, (fillPaintSources.get(sourceKey) ?? 0) + 1);
        }
        shapes.push({
          index,
        bounds,
        componentCount: layer.shapes[index].components.length,
        componentTypes: layer.shapes[index].components.map(comp => comp.componentType),
        contourDebug: (() => {
          const debug = tvg.__debugBuildContoursForShape(layer.shapes[index], layer.type, index);
          return {
            fragmentCount: debug.fragments.length,
            contourCount: debug.contours.length,
            unresolvedCount: debug.unresolvedChains.length,
            contourSummaries: debug.contours.slice(0, 8),
            unresolvedSummaries: debug.unresolvedChains.slice(0, 8),
          };
        })(),
          paintGroups: Array.from(paintKeys.entries())
            .map(([key, count]) => ({ key, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 8),
          fillPaintSources: Array.from(fillPaintSources.entries())
            .map(([source, count]) => ({ source, count }))
            .sort((a, b) => b.count - a.count),
        });
      }

    shapes.sort((a, b) => b.bounds.count - a.bounds.count);
    return { viewport, layerType, shapes: shapes.slice(0, 30) };
  }, { elementName, drawingName, layerType });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
