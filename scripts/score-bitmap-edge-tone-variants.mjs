import puppeteer from 'puppeteer';

const SIZE = 160;

const args = process.argv.slice(2);
const caseArg = args.find((arg) => !arg.startsWith('--'));

if (!caseArg) {
  console.error('Usage: node scripts/score-bitmap-edge-tone-variants.mjs <element/drawing[,element/drawing...]>');
  process.exit(1);
}

const cases = caseArg.split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [elementName, drawingName] = entry.split('/');
    if (!elementName || !drawingName) {
      throw new Error(`Invalid case "${entry}". Expected element/drawing.`);
    }
    return { elementName, drawingName };
  });

const browser = await puppeteer.launch({ headless: 'new' });

try {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(0);
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async ({ cases, size }) => {
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
    const externalColors = pal.flattenExternalPaletteColors(await pal.loadPalettes(zip));

    function loadImage(bytes, mimeType = 'image/png') {
      return new Promise((resolve, reject) => {
        const blob = new Blob([bytes], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const image = new Image();
        image.onload = () => {
          URL.revokeObjectURL(url);
          resolve(image);
        };
        image.onerror = (event) => {
          URL.revokeObjectURL(url);
          reject(event);
        };
        image.src = url;
      });
    }

    function computeBitmapBounds(tiles) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const tile of tiles) {
        if (tile.clipW <= 0 || tile.clipH <= 0) continue;
        minX = Math.min(minX, tile.clipX);
        minY = Math.min(minY, tile.clipY);
        maxX = Math.max(maxX, tile.clipX + tile.clipW);
        maxY = Math.max(maxY, tile.clipY + tile.clipH);
      }
      if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return null;
      return { minX, minY, maxX, maxY };
    }

    function canvasBounds(canvas) {
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const index = (y * canvas.width + x) * 4;
          const foreground = Math.abs(data[index] - 255) > 12
            || Math.abs(data[index + 1] - 255) > 12
            || Math.abs(data[index + 2] - 255) > 12
            || data[index + 3] < 243;
          if (!foreground) continue;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x + 1);
          maxY = Math.max(maxY, y + 1);
        }
      }
      if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return null;
      return { minX, minY, maxX, maxY };
    }

    async function loadDrawing(base, drawingName) {
      const drawing = tvg.parseTVG(await zip.file(`${base}/${drawingName}.tvg`).async('arraybuffer'));
      tvg.resolveExternalPalette(drawing, externalColors);
      return drawing;
    }

    async function renderAndScore({ base, drawingName, viewport, thumbnail, renderOptions }) {
      const drawing = await loadDrawing(base, drawingName);
      const canvas = tvg.renderTVGToCanvas(drawing, size, size, viewport, { supersample: 2, ...renderOptions });
      if (canvas) await tvg.loadBitmapTiles(canvas, drawing.diagnostics);
      const score = bench.scoreCanvasSources(thumbnail, canvas, size);
      return {
        raw: score.rawScore,
        aligned: score.alignedScore,
        focused: score.normalizedScore,
        iou: score.foregroundIou,
        bounds: canvas ? canvasBounds(canvas) : null,
      };
    }

    const rows = [];
    for (const testCase of cases) {
      const element = elements.find((entry) => entry.name === testCase.elementName);
      const viewport = ((element?.fieldChart ?? 12) * tpl.TVG_UNITS_PER_FIELD) || 336;
      const base = `CH_Anna_rig_football_suit_V001_V07/elements/${testCase.elementName}`;
      const thumbnail = await loadImage(
        await zip.file(`${base}/.thumbnails/.${testCase.drawingName}.tvg.png`).async('arraybuffer'),
      );

      const metadataDrawing = await loadDrawing(base, testCase.drawingName);
      const bounds = computeBitmapBounds(metadataDrawing.bitmapTiles);
      const hasClipRects = bounds !== null && bounds.maxX > bounds.minX && bounds.maxY > bounds.minY;
      const renderW = bounds ? Math.max(1, Math.round(bounds.maxX - bounds.minX)) : null;
      const renderH = bounds ? Math.max(1, Math.round(bounds.maxY - bounds.minY)) : null;
      const metadata = {
        loadedCount: metadataDrawing.bitmapTiles.length,
        hasClipRects,
        fallbackScanUsed: (metadataDrawing.diagnostics.counts.BITMAP_FALLBACK_SCAN_USED ?? 0) > 0,
        renderW,
        renderH,
        aspectRatio: renderW !== null && renderH !== null ? renderW / Math.max(renderH, 1) : null,
      };

      const production = await renderAndScore({
        base,
        drawingName: testCase.drawingName,
        viewport,
        thumbnail,
        renderOptions: {},
      });
      const noEdgeTone = await renderAndScore({
        base,
        drawingName: testCase.drawingName,
        viewport,
        thumbnail,
        renderOptions: { disableBitmapAtlasEdgeTone: true },
      });
      rows.push({
        case: `${testCase.elementName}/${testCase.drawingName}`,
        metadata,
        production,
        noEdgeTone,
        deltaNoEdgeRaw: noEdgeTone.raw - production.raw,
        deltaNoEdgeAligned: noEdgeTone.aligned - production.aligned,
      });
    }

    const aggregate = rows.reduce((entry, row) => {
      entry.count += 1;
      entry.averageNoEdgeRawDelta += row.deltaNoEdgeRaw;
      entry.averageNoEdgeAlignedDelta += row.deltaNoEdgeAligned;
      entry.rawRegressions += row.deltaNoEdgeRaw < -0.0001 ? 1 : 0;
      entry.rawImprovements += row.deltaNoEdgeRaw > 0.0001 ? 1 : 0;
      entry.minNoEdgeRawDelta = Math.min(entry.minNoEdgeRawDelta, row.deltaNoEdgeRaw);
      entry.maxNoEdgeRawDelta = Math.max(entry.maxNoEdgeRawDelta, row.deltaNoEdgeRaw);
      return entry;
    }, {
      count: 0,
      averageNoEdgeRawDelta: 0,
      averageNoEdgeAlignedDelta: 0,
      rawRegressions: 0,
      rawImprovements: 0,
      minNoEdgeRawDelta: Infinity,
      maxNoEdgeRawDelta: -Infinity,
    });
    if (aggregate.count > 0) {
      aggregate.averageNoEdgeRawDelta /= aggregate.count;
      aggregate.averageNoEdgeAlignedDelta /= aggregate.count;
    }

    rows.sort((a, b) => a.deltaNoEdgeRaw - b.deltaNoEdgeRaw);
    return { aggregate, cases: rows };
  }, { cases, size: SIZE });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
