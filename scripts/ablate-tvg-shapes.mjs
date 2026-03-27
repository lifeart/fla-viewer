import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
let layerType = null;
let limit = 20;
let sortMode = 'remove-desc';
let targetShapeIndex = null;
const positional = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--layer') {
    layerType = args[++i] ?? null;
  } else if (arg === '--limit') {
    limit = Number.parseInt(args[++i] ?? '20', 10);
  } else if (arg === '--sort') {
    sortMode = args[++i] ?? 'remove-desc';
  } else if (arg === '--shape') {
    targetShapeIndex = Number.parseInt(args[++i] ?? '-1', 10);
  } else {
    positional.push(arg);
  }
}

const [elementName, drawingName] = positional;

if (!elementName || !drawingName) {
  console.error('Usage: node scripts/ablate-tvg-shapes.mjs <elementName> <drawingName> [--layer underlay|color|line|overlay] [--shape index] [--limit N] [--sort remove-desc|remove-asc|only-desc]');
  process.exit(1);
}

const browser = await puppeteer.launch({ headless: 'new' });

try {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(0);
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async ({ elementName, drawingName, layerType, targetShapeIndex, limit, sortMode }) => {
    const JSZipMod = await import('/node_modules/.vite/deps/jszip.js');
    const tvg = await import('/src/tvg-parser.ts');
    const pal = await import('/src/tpl-palette.ts');
    const bench = await import('/src/tvg-benchmark.ts');
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
          if (data[index + 3] === 0) continue;
          if (data[index] === 255 && data[index + 1] === 255 && data[index + 2] === 255) continue;
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

    function ensureCanvas(canvas, width = 160, height = 160) {
      if (canvas) return canvas;
      const blank = document.createElement('canvas');
      blank.width = width;
      blank.height = height;
      return blank;
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

    const baseCanvas = tvg.renderTVGToCanvas(drawing, 160, 160, viewport, { supersample: 2 });
    if (baseCanvas) await tvg.loadBitmapTiles(baseCanvas, drawing.diagnostics);
    const scoredBaseCanvas = ensureCanvas(baseCanvas);
    const baseScore = bench.scoreCanvasSources(thumb, scoredBaseCanvas, 160);

      const targetLayers = drawing.layers
      .map((layer, index) => ({ layer, index }))
      .filter(entry => !layerType || entry.layer.type === layerType);

      const cases = [];
      for (const { layer, index: layerIndex } of targetLayers) {
        for (let shapeIndex = 0; shapeIndex < layer.shapes.length; shapeIndex++) {
          if (targetShapeIndex !== null && shapeIndex !== targetShapeIndex) continue;
          const removed = {
          ...drawing,
          layers: drawing.layers.map((entry, li) =>
            li === layerIndex
              ? { ...entry, shapes: entry.shapes.filter((_, si) => si !== shapeIndex) }
              : { ...entry },
          ),
        };
        const removedCanvas = tvg.renderTVGToCanvas(removed, 160, 160, viewport, { supersample: 2 });
        if (removedCanvas) await tvg.loadBitmapTiles(removedCanvas, removed.diagnostics);
        const scoredRemovedCanvas = ensureCanvas(removedCanvas);
        const removedScore = bench.scoreCanvasSources(thumb, scoredRemovedCanvas, 160);

        const onlyShape = {
          ...drawing,
          layers: drawing.layers.map((entry, li) =>
            li === layerIndex
              ? { ...entry, shapes: [entry.shapes[shapeIndex]] }
              : { ...entry, shapes: [] },
          ),
        };
        const onlyCanvas = tvg.renderTVGToCanvas(onlyShape, 160, 160, viewport, { supersample: 2 });
        if (onlyCanvas) await tvg.loadBitmapTiles(onlyCanvas, onlyShape.diagnostics);
        const scoredOnlyCanvas = ensureCanvas(onlyCanvas);
        const onlyScore = bench.scoreCanvasSources(thumb, scoredOnlyCanvas, 160);

        cases.push({
          layerType: layer.type,
          layerIndex,
          shapeIndex,
          componentCount: layer.shapes[shapeIndex].components.length,
          removeScore: removedScore.score,
          removeDelta: removedScore.score - baseScore.score,
          onlyScore: onlyScore.score,
          onlyNormalizedScore: onlyScore.normalizedScore,
          onlyBounds: foregroundBounds(scoredOnlyCanvas),
        });
      }
    }

    cases.sort((a, b) => {
      if (sortMode === 'remove-asc') {
        if (a.removeDelta !== b.removeDelta) return a.removeDelta - b.removeDelta;
      } else if (sortMode === 'only-desc') {
        if (b.onlyNormalizedScore !== a.onlyNormalizedScore) return b.onlyNormalizedScore - a.onlyNormalizedScore;
      } else if (b.removeDelta !== a.removeDelta) {
        return b.removeDelta - a.removeDelta;
      }
      if (sortMode !== 'only-desc' && b.onlyNormalizedScore !== a.onlyNormalizedScore) {
        return b.onlyNormalizedScore - a.onlyNormalizedScore;
      }
      if (sortMode === 'only-desc' && b.removeDelta !== a.removeDelta) {
        return b.removeDelta - a.removeDelta;
      }
      return b.onlyNormalizedScore - a.onlyNormalizedScore;
    });

      return {
        elementName,
        drawingName,
        viewport,
        sortMode,
        targetShapeIndex,
        baseScore,
        cases: cases.slice(0, limit),
        totalCases: cases.length,
      };
  }, { elementName, drawingName, layerType, targetShapeIndex, limit, sortMode });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
