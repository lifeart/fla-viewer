import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const [elementName, drawingNamesArg] = args;

if (!elementName || !drawingNamesArg) {
  console.error('Usage: node scripts/score-tvg-tone-variants.mjs <elementName> <drawing[,drawing...]> [--summary-only] [--variants=name[;name...]]');
  process.exit(1);
}

const summaryOnly = args.includes('--summary-only');
const variantsArg = args.find((arg) => arg.startsWith('--variants='));
const drawingNames = drawingNamesArg.split(',').map((name) => name.trim()).filter(Boolean);

const allVariants = [
  { name: 'baseline' },
  { name: 'no-dense-post', renderOptions: { disableDenseLineFillAdjustment: true } },
  { name: 'bg-post-before-dense', renderOptions: { backgroundCompositeTiming: 'post-downsample-before-dense' } },
  { name: 'bg-post-after-dense', renderOptions: { backgroundCompositeTiming: 'post-downsample-after-dense' } },
  { name: 'dense-edge-alpha-1.00', renderOptions: { denseLineFillTuning: { edgeAlphaScale: 1.0 } } },
  { name: 'dense-edge-alpha-1.05', renderOptions: { denseLineFillTuning: { edgeAlphaScale: 1.05 } } },
  { name: 'dense-edge-alpha-1.10', renderOptions: { denseLineFillTuning: { edgeAlphaScale: 1.1 } } },
  { name: 'dense-edge-alpha-1.12', renderOptions: { denseLineFillTuning: { edgeAlphaScale: 1.12 } } },
  { name: 'dense-edge-alpha-1.14', renderOptions: { denseLineFillTuning: { edgeAlphaScale: 1.14 } } },
  { name: 'dense-edge-alpha-1.15', renderOptions: { denseLineFillTuning: { edgeAlphaScale: 1.15 } } },
  { name: 'dense-edge-alpha-1.16', renderOptions: { denseLineFillTuning: { edgeAlphaScale: 1.16 } } },
  { name: 'dense-edge-alpha-1.18', renderOptions: { denseLineFillTuning: { edgeAlphaScale: 1.18 } } },
  { name: 'dense-edge-alpha-1.20', renderOptions: { denseLineFillTuning: { edgeAlphaScale: 1.2 } } },
  { name: 'dense-expansion-0.70', renderOptions: { denseLineFillTuning: { exteriorEdgeExpansionScale: 0.7 } } },
  { name: 'dense-expansion-0.80', renderOptions: { denseLineFillTuning: { exteriorEdgeExpansionScale: 0.8 } } },
  { name: 'dense-expansion-1.00', renderOptions: { denseLineFillTuning: { exteriorEdgeExpansionScale: 1.0 } } },
  { name: 'dense-edge-tone-0', renderOptions: { denseLineFillTuning: { edgeToneSubtract: 0 } } },
  { name: 'dense-edge-tone-16', renderOptions: { denseLineFillTuning: { edgeToneSubtract: 16 } } },
  { name: 'dense-edge-tone-24', renderOptions: { denseLineFillTuning: { edgeToneSubtract: 24 } } },
  { name: 'dense-edge-tone-40', renderOptions: { denseLineFillTuning: { edgeToneSubtract: 40 } } },
  {
    name: 'dense-alpha1.05-tone24',
    renderOptions: { denseLineFillTuning: { edgeAlphaScale: 1.05, edgeToneSubtract: 24 } },
  },
  {
    name: 'dense-alpha1.15-tone40',
    renderOptions: { denseLineFillTuning: { edgeAlphaScale: 1.15, edgeToneSubtract: 40 } },
  },
  { name: 'interior+4,+12,+12', interiorAdd: [4, 12, 12], maxLuma: 220 },
  { name: 'interior+6,+18,+18', interiorAdd: [6, 18, 18], maxLuma: 220 },
  { name: 'interior+8,+24,+22', interiorAdd: [8, 24, 22], maxLuma: 220 },
  { name: 'interior+4,+20,+20 shadows', interiorAdd: [4, 20, 20], maxLuma: 96 },
  { name: 'interior+8,+24,+22 mid', interiorAdd: [8, 24, 22], minLuma: 64, maxLuma: 180 },
  { name: 'interior+4,+16,+16 dark-mid', interiorAdd: [4, 16, 16], minLuma: 32, maxLuma: 160 },
  { name: 'sat-green+10,+28,+24', interiorAdd: [10, 28, 24], minLuma: 105, maxLuma: 185, maxR: 80, minG: 115, minChroma: 70 },
  { name: 'sat-green+14,+36,+30', interiorAdd: [14, 36, 30], minLuma: 105, maxLuma: 185, maxR: 80, minG: 115, minChroma: 70 },
  { name: 'sat-green+18,+44,+36', interiorAdd: [18, 44, 36], minLuma: 105, maxLuma: 185, maxR: 90, minG: 115, minChroma: 70 },
  { name: 'dark-cyan+0,-12,-12', interiorAdd: [0, -12, -12], minLuma: 32, maxLuma: 95, maxR: 55, minG: 40, minB: 40, maxChroma: 90 },
  { name: 'dark-cyan-2,-20,-16', interiorAdd: [-2, -20, -16], minLuma: 32, maxLuma: 95, maxR: 60, minG: 40, minB: 40, maxChroma: 100 },
  { name: 'sat-green+14 plus dark-cyan-12', multiInterior: [
    { interiorAdd: [14, 36, 30], minLuma: 105, maxLuma: 185, maxR: 80, minG: 115, minChroma: 70 },
    { interiorAdd: [0, -12, -12], minLuma: 32, maxLuma: 95, maxR: 55, minG: 40, minB: 40, maxChroma: 90 },
  ] },
  { name: 'edge-8,-8,-8', edgeAdd: [-8, -8, -8] },
  { name: 'edge-16,-16,-16', edgeAdd: [-16, -16, -16] },
  { name: 'edge-24,-20,-20', edgeAdd: [-24, -20, -20] },
  { name: 'edge-luma120-8', edgeAdd: [-8, -8, -8], minLuma: 120 },
  { name: 'edge-luma120-16', edgeAdd: [-16, -16, -16], minLuma: 120 },
  { name: 'edge-luma140-16', edgeAdd: [-16, -16, -16], minLuma: 140 },
  { name: 'edge-luma140-24', edgeAdd: [-24, -20, -20], minLuma: 140 },
  { name: 'edge-sat-luma120-16', edgeAdd: [-16, -16, -16], minLuma: 120, minChroma: 40 },
  {
    name: 'paint-solid15-edge-8',
    sourcePaintEdgeKeys: ['solid:15,46,48,255'],
    sourcePaintEdgeAdd: [-8, -8, -8],
  },
  {
    name: 'paint-solid15-edge-16',
    sourcePaintEdgeKeys: ['solid:15,46,48,255'],
    sourcePaintEdgeAdd: [-16, -16, -16],
  },
  {
    name: 'paint-solid15-edge-24',
    sourcePaintEdgeKeys: ['solid:15,46,48,255'],
    sourcePaintEdgeAdd: [-24, -24, -24],
  },
  {
    name: 'paint-solid22-edge-16',
    sourcePaintEdgeKeys: ['solid:22,198,133,255'],
    sourcePaintEdgeAdd: [-16, -16, -16],
  },
  {
    name: 'paint-solid15+22-edge-16',
    sourcePaintEdgeKeys: ['solid:15,46,48,255', 'solid:22,198,133,255'],
    sourcePaintEdgeAdd: [-16, -16, -16],
  },
  { name: 'edge-16 + shadow lift', edgeAdd: [-16, -16, -16], interiorAdd: [4, 20, 20], maxLuma: 96 },
  { name: 'source-edge-16 high-frac', sourceEdgeAdd: [-16, -16, -16], minFractionalAlpha: 1500 },
  { name: 'source-edge-32 high-frac', sourceEdgeAdd: [-32, -32, -32], minFractionalAlpha: 1500 },
  { name: 'source-edge-48 high-frac', sourceEdgeAdd: [-48, -42, -42], minFractionalAlpha: 1500 },
];

const splitVariantNames = (value) => {
  if (allVariants.some((variant) => variant.name === value)) return [value];
  const separator = value.includes(';') ? ';' : value.includes('|') ? '|' : ',';
  return value.split(separator).map((name) => name.trim()).filter(Boolean);
};
const selectedVariantNames = variantsArg
  ? new Set(splitVariantNames(variantsArg.slice('--variants='.length)))
  : null;
const variants = selectedVariantNames
  ? allVariants.filter((variant) => variant.name === 'baseline' || selectedVariantNames.has(variant.name))
  : allVariants;
const missingVariantNames = selectedVariantNames
  ? [...selectedVariantNames].filter((name) => !allVariants.some((variant) => variant.name === name))
  : [];
if (missingVariantNames.length > 0) {
  console.error(`Unknown variants: ${missingVariantNames.join(', ')}`);
  process.exit(1);
}

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

    const pixelMatchesVariant = (data, index, variant) => {
      const pixelLuma = luma(data, index);
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (variant.minLuma !== undefined && pixelLuma < variant.minLuma) return false;
      if (variant.maxLuma !== undefined && pixelLuma > variant.maxLuma) return false;
      if (variant.minR !== undefined && r < variant.minR) return false;
      if (variant.maxR !== undefined && r > variant.maxR) return false;
      if (variant.minG !== undefined && g < variant.minG) return false;
      if (variant.maxG !== undefined && g > variant.maxG) return false;
      if (variant.minB !== undefined && b < variant.minB) return false;
      if (variant.maxB !== undefined && b > variant.maxB) return false;
      if (variant.minChroma !== undefined && chroma < variant.minChroma) return false;
      if (variant.maxChroma !== undefined && chroma > variant.maxChroma) return false;
      return true;
    };

    const applyInteriorAdjustment = (data, index, variant) => {
      data[index] = clamp(data[index] + variant.interiorAdd[0]);
      data[index + 1] = clamp(data[index + 1] + variant.interiorAdd[1]);
      data[index + 2] = clamp(data[index + 2] + variant.interiorAdd[2]);
    };

    const paintKeyForPaint = (paint) => {
      if (!paint) return null;
      if (paint.kind === 'solid') {
        const { r, g, b, a } = paint.rgba;
        return `solid:${r},${g},${b},${a}`;
      }
      return JSON.stringify(paint);
    };

    const collectLinePaints = (drawing, requiredKeys) => {
      const paints = new Map();
      for (const layer of drawing.layers) {
        if (layer.type !== 'line') continue;
        for (const shape of layer.shapes) {
          for (const comp of shape.components) {
            const key = paintKeyForPaint(comp.outerPaint);
            if (!key || !requiredKeys.has(key) || paints.has(key)) continue;
            paints.set(key, comp.outerPaint);
          }
        }
      }
      return [...paints.entries()].map(([key, paint]) => ({ key, paint }));
    };

    const drawingForLinePaintKey = (drawing, targetKey) => {
      const clone = structuredClone(drawing);
      for (const layer of clone.layers) {
        if (layer.type !== 'line') {
          layer.shapes = [];
          continue;
        }
        layer.shapes = layer.shapes
          .map((shape) => {
            const hasTargetPaint = shape.components.some(comp => paintKeyForPaint(comp.outerPaint) === targetKey);
            if (!hasTargetPaint) return null;
            return {
              ...shape,
              components: shape.components.filter(comp =>
                paintKeyForPaint(comp.outerPaint) === targetKey
                || (comp.outerPaint === null && comp.path && comp.path.segments.length > 0),
              ),
            };
          })
          .filter(Boolean);
      }
      return clone;
    };

    const buildPaintMasks = async (drawing) => {
      const requiredKeys = new Set(
        variants.flatMap((variant) => variant.sourcePaintEdgeKeys ?? []),
      );
      if (requiredKeys.size === 0) return [];

      const masks = [];
      for (const paint of collectLinePaints(drawing, requiredKeys)) {
        const paintDrawing = drawingForLinePaintKey(drawing, paint.key);
        const canvas = tvg.renderTVGToCanvas(
          paintDrawing,
          SIZE,
          SIZE,
          viewport,
          {
            supersample: 2,
            skipBackgroundComposite: true,
            disableDenseLineFillAdjustment: true,
          },
        );
        if (!canvas) continue;
        await tvg.loadBitmapTiles(canvas, paintDrawing.diagnostics);
        masks.push({
          key: paint.key,
          data: canvas.getContext('2d').getImageData(0, 0, SIZE, SIZE).data,
        });
      }
      return masks;
    };

    const dominantPaintKey = (paintMasks, index) => {
      let bestKey = null;
      let bestAlpha = 0;
      for (const mask of paintMasks) {
        const alpha = mask.data[index + 3];
        if (alpha <= bestAlpha) continue;
        bestKey = mask.key;
        bestAlpha = alpha;
      }
      return bestAlpha > 0 ? bestKey : null;
    };

    const applyVariant = (canvas, alphaData, variant, fractionalAlphaCount, paintMasks) => {
      if (variant.renderOptions) return canvas;
      if (!variant.interiorAdd
        && !variant.edgeAdd
        && !variant.sourceEdgeAdd
        && !variant.sourcePaintEdgeAdd
        && !variant.multiInterior) return canvas;
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
          if (isEdge && variant.sourcePaintEdgeAdd) {
            const dominantKey = dominantPaintKey(paintMasks, index);
            if (!dominantKey || !variant.sourcePaintEdgeKeys.includes(dominantKey)) continue;
            if (!pixelMatchesVariant(data, index, variant)) continue;
            data[index] = clamp(data[index] + variant.sourcePaintEdgeAdd[0]);
            data[index + 1] = clamp(data[index + 1] + variant.sourcePaintEdgeAdd[1]);
            data[index + 2] = clamp(data[index + 2] + variant.sourcePaintEdgeAdd[2]);
            continue;
          }
          if (isEdge && variant.sourceEdgeAdd) {
            const alpha = alphaData[index + 3] / 255;
            data[index] = clamp((clamp(alphaData[index] + variant.sourceEdgeAdd[0]) * alpha) + 255 * (1 - alpha));
            data[index + 1] = clamp((clamp(alphaData[index + 1] + variant.sourceEdgeAdd[1]) * alpha) + 255 * (1 - alpha));
            data[index + 2] = clamp((clamp(alphaData[index + 2] + variant.sourceEdgeAdd[2]) * alpha) + 255 * (1 - alpha));
            continue;
          }
          if (isEdge && variant.edgeAdd) {
            if (!pixelMatchesVariant(data, index, variant)) continue;
            data[index] = clamp(data[index] + variant.edgeAdd[0]);
            data[index + 1] = clamp(data[index + 1] + variant.edgeAdd[1]);
            data[index + 2] = clamp(data[index + 2] + variant.edgeAdd[2]);
            continue;
          }
          if (isEdge || alphaData[index + 3] !== 255) continue;
          const interiorVariants = variant.multiInterior ?? (variant.interiorAdd ? [variant] : []);
          for (const interiorVariant of interiorVariants) {
            if (!pixelMatchesVariant(data, index, interiorVariant)) continue;
            applyInteriorAdjustment(data, index, interiorVariant);
            break;
          }
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
      const paintMasks = await buildPaintMasks(drawing);
      const rows = [];
      for (const variant of variants) {
        const canvas = variant.renderOptions
          ? tvg.renderTVGToCanvas(drawing, SIZE, SIZE, viewport, { supersample: 2, ...variant.renderOptions })
          : variant.name === 'baseline'
          ? candidate
          : applyVariant(candidate, alphaData, variant, fractionalAlphaCount, paintMasks);
        if (variant.renderOptions && canvas) await tvg.loadBitmapTiles(canvas, drawing.diagnostics);
        const score = bench.scoreCanvasSources(thumb, canvas, SIZE);
        rows.push({
          variant: variant.name,
          rawScore: score.rawScore,
          alignedScore: score.alignedScore,
          normalizedScore: score.normalizedScore,
          foregroundIou: score.foregroundIou,
        });
      }
      return rows;
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

  console.log(JSON.stringify(summaryOnly ? { summary: result.summary } : result, null, 2));
} finally {
  await browser.close();
}
