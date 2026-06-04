import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const [elementName, drawingNamesArg, layerTypeArg] = args;

if (!elementName || !drawingNamesArg) {
  console.error('Usage: node scripts/analyze-tvg-shape-residuals.mjs <elementName> <drawing[,drawing...]> [layerType] [--top=12] [--details]');
  process.exit(1);
}

const layerType = layerTypeArg && !layerTypeArg.startsWith('--') ? layerTypeArg : 'line';
const topArg = args.find((arg) => arg.startsWith('--top='));
const top = topArg ? Math.max(1, Number.parseInt(topArg.slice('--top='.length), 10) || 12) : 12;
const includeDetails = args.includes('--details');
const drawingNames = drawingNamesArg.split(',').map((name) => name.trim()).filter(Boolean);

const browser = await puppeteer.launch({ headless: 'new' });

try {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(0);
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async ({ elementName, drawingNames, layerType, top, includeDetails }) => {
    const JSZipMod = await import('/node_modules/.vite/deps/jszip.js');
    const tvg = await import('/src/tvg-parser.ts');
    const pal = await import('/src/tpl-palette.ts');
    const tpl = await import('/src/tpl-parser.ts');
    const bench = await import('/src/tvg-benchmark.ts');

    const SIZE = 160;
    const BACKGROUND_TOLERANCE = 12;
    const CHANNEL_TOLERANCE = 50;
    const BAD_SUM_DELTA = 50;

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

    const isForeground = (data, index) => (
      Math.abs(data[index] - 255) > BACKGROUND_TOLERANCE
      || Math.abs(data[index + 1] - 255) > BACKGROUND_TOLERANCE
      || Math.abs(data[index + 2] - 255) > BACKGROUND_TOLERANCE
      || data[index + 3] < 255 - BACKGROUND_TOLERANCE
    );

    const deltaInfo = (refData, candidateData, index) => {
      const dr = candidateData[index] - refData[index];
      const dg = candidateData[index + 1] - refData[index + 1];
      const db = candidateData[index + 2] - refData[index + 2];
      return {
        dr,
        dg,
        db,
        sumAbs: Math.abs(dr) + Math.abs(dg) + Math.abs(db),
        channelFail: Math.abs(dr) > CHANNEL_TOLERANCE
          || Math.abs(dg) > CHANNEL_TOLERANCE
          || Math.abs(db) > CHANNEL_TOLERANCE,
      };
    };

    const paintKeyForShape = (shape) => {
      const counts = new Map();
      for (const comp of shape.components) {
        const paint = comp.outerPaint;
        if (!paint || paint.kind !== 'solid') continue;
        const { r, g, b, a } = paint.rgba;
        const key = `solid:${r},${g},${b},${a}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    };

    const emptyBucket = (shapeIndex, metadata) => ({
      shapeIndex,
      metadata,
      pixels: 0,
      bothForeground: 0,
      badBothForeground: 0,
      channelToleranceFailures: 0,
      refOnly: 0,
      candidateOnly: 0,
      edgePixels: 0,
      interiorPixels: 0,
      alphaSum: 0,
      meanDelta: [0, 0, 0],
      meanAbsDelta: 0,
    });

    const boundsArea = (bounds) => {
      if (!bounds) return 0;
      return Math.max(0, bounds.maxX - bounds.minX) * Math.max(0, bounds.maxY - bounds.minY);
    };

    const summarizeContourDebug = (shape, contourDebug) => ({
      componentCount: shape.components.length,
      fragmentCount: contourDebug.fragments.length,
      contourCount: contourDebug.contours.length,
      unresolvedChainCount: contourDebug.unresolvedChains.length,
      contourChildCount: contourDebug.contours.reduce((sum, contour) => sum + contour.childCount, 0),
      styledFragmentCount: contourDebug.contours.reduce((sum, contour) => sum + contour.styledFragmentCount, 0)
        + contourDebug.unresolvedChains.reduce((sum, chain) => sum + chain.styledFragmentCount, 0),
      supportFragmentCount: contourDebug.contours.reduce((sum, contour) => sum + contour.supportFragmentCount, 0)
        + contourDebug.unresolvedChains.reduce((sum, chain) => sum + chain.supportFragmentCount, 0),
    });

    const lineFillRenderOrder = (layer, decisions) => {
      const entries = layer.shapes.map((shape, shapeIndex) => {
        const decision = decisions.get(shapeIndex);
        return {
          shapeIndex,
          shape,
          preRenderPriority: decision?.preRenderPriority ?? 0,
          boundsArea: 0,
          baseCarrier: false,
        };
      });

      for (const entry of entries) {
        const fillKeys = new Set();
        for (const comp of entry.shape.components) {
          if ((comp.componentType !== 0 && comp.componentType !== 1) || !comp.path || !comp.outerPaint) continue;
          fillKeys.add(paintKeyForShape({ components: [comp] }));
        }
        entry.baseCarrier = entry.shape.components.length >= 20 && fillKeys.size === 1;
        const contourDebug = tvg.__debugBuildContoursForShape(entry.shape, layer.type, entry.shapeIndex);
        const boxes = [
          ...contourDebug.contours.map((contour) => contour.bbox),
          ...contourDebug.unresolvedChains.map((chain) => chain.bbox),
        ];
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const box of boxes) {
          minX = Math.min(minX, box.minX);
          minY = Math.min(minY, box.minY);
          maxX = Math.max(maxX, box.maxX);
          maxY = Math.max(maxY, box.maxY);
        }
        entry.boundsArea = isFinite(minX) ? boundsArea({ minX, minY, maxX, maxY }) : 0;
      }

      if (entries.every((entry) => entry.preRenderPriority === 0)) {
        entries.sort((a, b) => {
          const aOrder = a.baseCarrier ? 0 : 1;
          const bOrder = b.baseCarrier ? 0 : 1;
          if (aOrder !== bOrder) return aOrder - bOrder;
          if (aOrder === 0) return b.boundsArea - a.boundsArea || a.shapeIndex - b.shapeIndex;
          return a.shapeIndex - b.shapeIndex;
        });
      } else {
        entries.sort((a, b) => a.shapeIndex - b.shapeIndex);
      }

      return entries.map((entry) => entry.shapeIndex);
    };

    const finalizeBucket = (bucket) => {
      if (bucket.pixels === 0) return bucket;
      return {
        ...bucket,
        meanAlpha: Number((bucket.alphaSum / bucket.pixels).toFixed(2)),
        meanDelta: bucket.meanDelta.map((value) => Number((value / bucket.pixels).toFixed(2))),
        meanAbsDelta: Number((bucket.meanAbsDelta / bucket.pixels).toFixed(2)),
        alphaSum: undefined,
      };
    };

    const analyzeDrawing = async (drawingName) => {
      const drawing = tvg.parseTVG(await zip.file(`${base}/${drawingName}.tvg`).async('arraybuffer'));
      tvg.resolveExternalPalette(drawing, externalColors);
      const layer = drawing.layers.find((entry) => entry.type === layerType);
      if (!layer) return { drawingName, viewport, score: null, shapes: [] };

      const thumb = await loadImage(await zip.file(`${base}/.thumbnails/.${drawingName}.tvg.png`).async('arraybuffer'));
      const refCanvas = document.createElement('canvas');
      refCanvas.width = SIZE;
      refCanvas.height = SIZE;
      const refCtx = refCanvas.getContext('2d');
      refCtx.fillStyle = '#fff';
      refCtx.fillRect(0, 0, SIZE, SIZE);
      refCtx.drawImage(thumb, 0, 0, SIZE, SIZE);
      const refData = refCtx.getImageData(0, 0, SIZE, SIZE).data;

      const fullCanvas = tvg.renderTVGToCanvas(drawing, SIZE, SIZE, viewport, { supersample: 2 });
      if (!fullCanvas) return { drawingName, viewport, score: null, shapes: [] };
      await tvg.loadBitmapTiles(fullCanvas, drawing.diagnostics);
      const score = bench.scoreCanvasSources(thumb, fullCanvas, SIZE);
      const candidateData = fullCanvas.getContext('2d').getImageData(0, 0, SIZE, SIZE).data;

      const decisions = new Map(tvg.__debugLineFillDecisions(layer).map((entry) => [entry.shapeIndex, entry]));
      const renderOrder = lineFillRenderOrder(layer, decisions);
      const shapeMasks = [];
      for (let shapeIndex = 0; shapeIndex < layer.shapes.length; shapeIndex++) {
        const shape = layer.shapes[shapeIndex];
        const single = {
          ...drawing,
          layers: drawing.layers.map((entry) =>
            entry === layer ? { ...entry, shapes: [shape] } : { ...entry, shapes: [] },
          ),
        };
        const canvas = tvg.renderTVGToCanvas(single, SIZE, SIZE, viewport, {
          supersample: 2,
          skipBackgroundComposite: true,
          disableDenseLineFillAdjustment: true,
        });
        if (!canvas) continue;
        await tvg.loadBitmapTiles(canvas, single.diagnostics);
        const data = canvas.getContext('2d').getImageData(0, 0, SIZE, SIZE).data;
        const contourDebug = tvg.__debugBuildContoursForShape(shape, layer.type, shapeIndex);
        shapeMasks.push({
          shapeIndex,
          data,
          metadata: {
            ...(decisions.get(shapeIndex) ?? {}),
            dominantPaintKey: paintKeyForShape(shape),
            renderStrategy: tvg.__debugLineFillRenderStrategy(layer, shapeIndex, drawing.layers),
            contourSummary: summarizeContourDebug(shape, contourDebug),
            ...(includeDetails ? { contourDebug } : {}),
          },
        });
      }

      const shapeMaskByIndex = new Map(shapeMasks.map((mask) => [mask.shapeIndex, mask]));
      const buckets = new Map();
      const unassigned = emptyBucket(-1, { dominantPaintKey: null });
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          const index = (y * SIZE + x) * 4;
          const refForeground = isForeground(refData, index);
          const candidateForeground = isForeground(candidateData, index);
          if (!refForeground && !candidateForeground) continue;

          const delta = deltaInfo(refData, candidateData, index);
          if (refForeground && candidateForeground && delta.sumAbs <= BAD_SUM_DELTA && !delta.channelFail) continue;

          let topmost = null;
          let topmostAlpha = 0;
          for (const shapeIndex of renderOrder) {
            const mask = shapeMaskByIndex.get(shapeIndex);
            if (!mask) continue;
            const alpha = mask.data[index + 3];
            if (alpha <= 0) continue;
            topmost = mask;
            topmostAlpha = alpha;
          }

          const bucketKey = topmost?.shapeIndex ?? -1;
          const bucket = bucketKey === -1
            ? unassigned
            : (buckets.get(bucketKey) ?? emptyBucket(topmost.shapeIndex, topmost.metadata));
          bucket.pixels += 1;
          bucket.alphaSum += topmostAlpha;
          bucket.meanDelta[0] += delta.dr;
          bucket.meanDelta[1] += delta.dg;
          bucket.meanDelta[2] += delta.db;
          bucket.meanAbsDelta += delta.sumAbs;
          if (topmostAlpha > 0 && topmostAlpha < 255) bucket.edgePixels += 1;
          if (topmostAlpha === 255) bucket.interiorPixels += 1;
          if (refForeground && candidateForeground) {
            bucket.bothForeground += 1;
            if (delta.sumAbs > BAD_SUM_DELTA) bucket.badBothForeground += 1;
            if (delta.channelFail) bucket.channelToleranceFailures += 1;
          } else if (refForeground) {
            bucket.refOnly += 1;
          } else {
            bucket.candidateOnly += 1;
          }
          if (bucketKey !== -1) buckets.set(bucketKey, bucket);
        }
      }

      const shapes = [...buckets.values()]
        .map(finalizeBucket)
        .sort((a, b) => b.channelToleranceFailures - a.channelToleranceFailures || b.pixels - a.pixels)
        .slice(0, top);
      const unassignedFinal = finalizeBucket(unassigned);
      return {
        drawingName,
        viewport,
        score,
        renderOrder,
        unassigned: unassignedFinal.pixels > 0 ? unassignedFinal : null,
        shapes,
      };
    };

    return Promise.all(drawingNames.map(analyzeDrawing));
  }, { elementName, drawingNames, layerType, top, includeDetails });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
