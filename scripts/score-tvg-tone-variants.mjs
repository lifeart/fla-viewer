import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const [elementName, drawingNamesArg] = args;

if (!elementName || !drawingNamesArg) {
  console.error('Usage: node scripts/score-tvg-tone-variants.mjs <elementName> <drawing[,drawing...]>');
  process.exit(1);
}

const drawingNames = drawingNamesArg.split(',').map((name) => name.trim()).filter(Boolean);

const variants = [
  { name: 'baseline' },
  { name: 'interior+4,+12,+12', interiorAdd: [4, 12, 12], maxLuma: 220 },
  { name: 'interior+6,+18,+18', interiorAdd: [6, 18, 18], maxLuma: 220 },
  { name: 'interior+8,+24,+22', interiorAdd: [8, 24, 22], maxLuma: 220 },
  { name: 'interior+4,+20,+20 shadows', interiorAdd: [4, 20, 20], maxLuma: 96 },
  { name: 'interior+8,+24,+22 mid', interiorAdd: [8, 24, 22], minLuma: 64, maxLuma: 180 },
  { name: 'interior+4,+16,+16 dark-mid', interiorAdd: [4, 16, 16], minLuma: 32, maxLuma: 160 },
  { name: 'edge-8,-8,-8', edgeAdd: [-8, -8, -8] },
  { name: 'edge-16,-16,-16', edgeAdd: [-16, -16, -16] },
  { name: 'edge-24,-20,-20', edgeAdd: [-24, -20, -20] },
  { name: 'edge-16 + shadow lift', edgeAdd: [-16, -16, -16], interiorAdd: [4, 20, 20], maxLuma: 96 },
  { name: 'source-edge-16 high-frac', sourceEdgeAdd: [-16, -16, -16], minFractionalAlpha: 1500 },
  { name: 'source-edge-32 high-frac', sourceEdgeAdd: [-32, -32, -32], minFractionalAlpha: 1500 },
  { name: 'source-edge-48 high-frac', sourceEdgeAdd: [-48, -42, -42], minFractionalAlpha: 1500 },
];

const browser = await puppeteer.launch({ headless: 'new' });

try {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(0);
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async ({ elementName, drawingNames, variants }) => {
    const JSZipMod = await import('/node_modules/.vite/deps/jszip.js');
    const tvg = await import('/src/tvg-parser.ts');
    const pal = await import('/src/tpl-palette.ts');
    const tpl = await import('/src/tpl-parser.ts');
    const bench = await import('/src/tvg-benchmark.ts');

    const SIZE = 160;
    const BACKGROUND_TOLERANCE = 12;
    const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));
    const luma = (data, index) => (
      0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2]
    );
    const isForeground = (data, index) => (
      Math.abs(data[index] - 255) > BACKGROUND_TOLERANCE
      || Math.abs(data[index + 1] - 255) > BACKGROUND_TOLERANCE
      || Math.abs(data[index + 2] - 255) > BACKGROUND_TOLERANCE
      || data[index + 3] < 255 - BACKGROUND_TOLERANCE
    );

    const zip = await JSZipMod.default.loadAsync(
      await (await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip')).arrayBuffer(),
    );
    const xstageXml = new DOMParser().parseFromString(
      await zip.file('CH_Anna_rig_football_suit_V001_V07/scene.xstage').async('text'),
      'text/xml',
    );
    const elements = tpl.parseElements(xstageXml);
    const element = elements.find((entry) => entry.name === elementName);
    const viewport = ((element?.fieldChart ?? 12) * tpl.TVG_UNITS_PER_FIELD) || 336;
    const externalColors = pal.flattenExternalPaletteColors(await pal.loadPalettes(zip));
    const base = `CH_Anna_rig_football_suit_V001_V07/elements/${elementName}`;

    const loadImage = (bytes) => new Promise((resolve, reject) => {
      const blob = new Blob([bytes], { type: 'image/png' });
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = URL.createObjectURL(blob);
    });

    const cloneCanvas = (source) => {
      const canvas = document.createElement('canvas');
      canvas.width = source.width;
      canvas.height = source.height;
      canvas.getContext('2d').drawImage(source, 0, 0);
      return canvas;
    };

    const countFractionalAlpha = (alphaData) => {
      let count = 0;
      for (let index = 3; index < alphaData.length; index += 4) {
        if (alphaData[index] > 0 && alphaData[index] < 255) count++;
      }
      return count;
    };

    const applyVariant = (canvas, alphaData, variant, fractionalAlphaCount) => {
      if (!variant.interiorAdd && !variant.edgeAdd && !variant.sourceEdgeAdd) return canvas;
      if (variant.minFractionalAlpha !== undefined && fractionalAlphaCount < variant.minFractionalAlpha) return canvas;

      const output = cloneCanvas(canvas);
      const ctx = output.getContext('2d');
      const image = ctx.getImageData(0, 0, output.width, output.height);
      const data = image.data;
      for (let y = 0; y < output.height; y++) {
        for (let x = 0; x < output.width; x++) {
          const index = (y * output.width + x) * 4;
          if (!isForeground(data, index)) continue;
          const isEdge = alphaData[index + 3] > 0 && alphaData[index + 3] < 255;
          if (isEdge && variant.sourceEdgeAdd) {
            const alpha = alphaData[index + 3] / 255;
            data[index] = clamp((clamp(alphaData[index] + variant.sourceEdgeAdd[0]) * alpha) + 255 * (1 - alpha));
            data[index + 1] = clamp((clamp(alphaData[index + 1] + variant.sourceEdgeAdd[1]) * alpha) + 255 * (1 - alpha));
            data[index + 2] = clamp((clamp(alphaData[index + 2] + variant.sourceEdgeAdd[2]) * alpha) + 255 * (1 - alpha));
            continue;
          }
          if (isEdge && variant.edgeAdd) {
            data[index] = clamp(data[index] + variant.edgeAdd[0]);
            data[index + 1] = clamp(data[index + 1] + variant.edgeAdd[1]);
            data[index + 2] = clamp(data[index + 2] + variant.edgeAdd[2]);
            continue;
          }
          if (isEdge || alphaData[index + 3] !== 255 || !variant.interiorAdd) continue;
          const pixelLuma = luma(data, index);
          if (variant.minLuma !== undefined && pixelLuma < variant.minLuma) continue;
          if (variant.maxLuma !== undefined && pixelLuma > variant.maxLuma) continue;
          data[index] = clamp(data[index] + variant.interiorAdd[0]);
          data[index + 1] = clamp(data[index + 1] + variant.interiorAdd[1]);
          data[index + 2] = clamp(data[index + 2] + variant.interiorAdd[2]);
        }
      }
      ctx.putImageData(image, 0, 0);
      return output;
    };

    const analyzeDrawing = async (drawingName) => {
      const drawing = tvg.parseTVG(await zip.file(`${base}/${drawingName}.tvg`).async('arraybuffer'));
      tvg.resolveExternalPalette(drawing, externalColors);

      const thumb = await loadImage(await zip.file(`${base}/.thumbnails/.${drawingName}.tvg.png`).async('arraybuffer'));
      const candidate = tvg.renderTVGToCanvas(drawing, SIZE, SIZE, viewport, { supersample: 2 });
      if (candidate) await tvg.loadBitmapTiles(candidate, drawing.diagnostics);
      const transparent = tvg.renderTVGToCanvas(
        drawing,
        SIZE,
        SIZE,
        viewport,
        { supersample: 2, skipBackgroundComposite: true },
      );
      if (transparent) await tvg.loadBitmapTiles(transparent, drawing.diagnostics);

      const alphaData = transparent.getContext('2d').getImageData(0, 0, SIZE, SIZE).data;
      const fractionalAlphaCount = countFractionalAlpha(alphaData);
      return variants.map((variant) => {
        const canvas = variant.name === 'baseline'
          ? candidate
          : applyVariant(candidate, alphaData, variant, fractionalAlphaCount);
        const score = bench.scoreCanvasSources(thumb, canvas, SIZE);
        return {
          variant: variant.name,
          rawScore: score.rawScore,
          alignedScore: score.alignedScore,
          normalizedScore: score.normalizedScore,
          foregroundIou: score.foregroundIou,
        };
      });
    };

    const byDrawing = {};
    for (const drawingName of drawingNames) {
      byDrawing[drawingName] = await analyzeDrawing(drawingName);
    }

    const summary = variants.map((variant) => {
      const rows = drawingNames.map((drawingName) => {
        const baseline = byDrawing[drawingName].find((entry) => entry.variant === 'baseline');
        const score = byDrawing[drawingName].find((entry) => entry.variant === variant.name);
        return {
          drawingName,
          rawDelta: score.rawScore - baseline.rawScore,
          alignedDelta: score.alignedScore - baseline.alignedScore,
          normalizedDelta: score.normalizedScore - baseline.normalizedScore,
          iouDelta: score.foregroundIou - baseline.foregroundIou,
        };
      });
      return {
        variant: variant.name,
        averageRawDelta: rows.reduce((sum, row) => sum + row.rawDelta, 0) / rows.length,
        minRawDelta: Math.min(...rows.map((row) => row.rawDelta)),
        maxRawDelta: Math.max(...rows.map((row) => row.rawDelta)),
        rows,
      };
    });

    return { byDrawing, summary };
  }, { elementName, drawingNames, variants });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
