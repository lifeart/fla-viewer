import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const [elementName, drawingNamesArg] = args;

if (!elementName || !drawingNamesArg) {
  console.error('Usage: node scripts/analyze-tvg-residuals.mjs <elementName> <drawing[,drawing...]> [--details] [--paint-buckets]');
  process.exit(1);
}

const includeDetails = args.includes('--details');
const includePaintBuckets = args.includes('--paint-buckets');
const drawingNames = drawingNamesArg.split(',').map((name) => name.trim()).filter(Boolean);

const browser = await puppeteer.launch({ headless: 'new' });

try {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(0);
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async ({ elementName, drawingNames, includeDetails, includePaintBuckets }) => {
    const JSZipMod = await import('/node_modules/.vite/deps/jszip.js');
    const tvg = await import('/src/tvg-parser.ts');
    const pal = await import('/src/tpl-palette.ts');
    const tpl = await import('/src/tpl-parser.ts');
    const bench = await import('/src/tvg-benchmark.ts');

    const SIZE = 160;
    const BACKGROUND_TOLERANCE = 12;
    const BAD_DELTA_THRESHOLD = 50;

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

    const isForeground = (data, index) => (
      Math.abs(data[index] - 255) > BACKGROUND_TOLERANCE
      || Math.abs(data[index + 1] - 255) > BACKGROUND_TOLERANCE
      || Math.abs(data[index + 2] - 255) > BACKGROUND_TOLERANCE
      || data[index + 3] < 255 - BACKGROUND_TOLERANCE
    );

    const luma = (data, index) => (
      0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2]
    );

    const emptyBucket = () => ({
      count: 0,
      meanRef: [0, 0, 0],
      meanCandidate: [0, 0, 0],
      meanDelta: [0, 0, 0],
      meanAbsDelta: 0,
    });

    const addToBucket = (bucket, refData, candidateData, index) => {
      bucket.count += 1;
      for (let channel = 0; channel < 3; channel++) {
        const ref = refData[index + channel];
        const candidate = candidateData[index + channel];
        bucket.meanRef[channel] += ref;
        bucket.meanCandidate[channel] += candidate;
        bucket.meanDelta[channel] += candidate - ref;
      }
      bucket.meanAbsDelta += Math.abs(candidateData[index] - refData[index])
        + Math.abs(candidateData[index + 1] - refData[index + 1])
        + Math.abs(candidateData[index + 2] - refData[index + 2]);
    };

    const finalizeBucket = (bucket) => {
      if (bucket.count === 0) return bucket;
      const divisor = bucket.count;
      return {
        count: bucket.count,
        meanRef: bucket.meanRef.map((value) => Number((value / divisor).toFixed(2))),
        meanCandidate: bucket.meanCandidate.map((value) => Number((value / divisor).toFixed(2))),
        meanDelta: bucket.meanDelta.map((value) => Number((value / divisor).toFixed(2))),
        meanAbsDelta: Number((bucket.meanAbsDelta / divisor).toFixed(2)),
      };
    };

    const boundsForMask = (points) => {
      if (points.length === 0) return null;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const point of points) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }
      return { minX, minY, maxX, maxY };
    };

    const rowCounts = (points) => {
      const rows = new Map();
      for (const point of points) {
        rows.set(point.y, (rows.get(point.y) ?? 0) + 1);
      }
      return [...rows.entries()]
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .slice(0, 8)
        .map(([y, count]) => ({ y, count }));
    };

    const alphaSummary = (points, alphaData) => {
      if (points.length === 0) {
        return { positive: 0, mean: 0, max: 0, buckets: [] };
      }
      const buckets = new Map();
      let positive = 0;
      let sum = 0;
      let max = 0;
      for (const point of points) {
        const alpha = alphaData[(point.y * SIZE + point.x) * 4 + 3];
        if (alpha > 0) positive += 1;
        sum += alpha;
        max = Math.max(max, alpha);
        const bucketStart = Math.floor(alpha / 32) * 32;
        const bucket = `${bucketStart}-${Math.min(255, bucketStart + 31)}`;
        buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
      }
      return {
        positive,
        mean: Number((sum / points.length).toFixed(2)),
        max,
        buckets: [...buckets.entries()]
          .sort(([a], [b]) => Number(a.split('-')[0]) - Number(b.split('-')[0]))
          .map(([range, count]) => ({ range, count })),
      };
    };

    const loadImage = (bytes) => new Promise((resolve, reject) => {
      const blob = new Blob([bytes], { type: 'image/png' });
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = URL.createObjectURL(blob);
    });

    const paintKeyForPaint = (paint) => {
      if (!paint) return null;
      if (paint.kind === 'solid') {
        const { r, g, b, a } = paint.rgba;
        return `solid:${r},${g},${b},${a}`;
      }
      return JSON.stringify(paint);
    };

    const paintLabel = (paint) => {
      if (!paint) return 'none';
      if (paint.kind === 'solid') {
        const { r, g, b, a } = paint.rgba;
        return `solid(${r},${g},${b},${a})`;
      }
      return paint.kind;
    };

    const collectLinePaints = (drawing) => {
      const paints = new Map();
      for (const layer of drawing.layers) {
        if (layer.type !== 'line') continue;
        for (const shape of layer.shapes) {
          for (const comp of shape.components) {
            const key = paintKeyForPaint(comp.outerPaint);
            if (!key || paints.has(key)) continue;
            paints.set(key, comp.outerPaint);
          }
        }
      }
      return [...paints.entries()].map(([key, paint]) => ({ key, paint, label: paintLabel(paint) }));
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
      if (!includePaintBuckets) return [];
      const paints = collectLinePaints(drawing).slice(0, 16);
      const masks = [];
      for (const paint of paints) {
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
          ...paint,
          data: canvas.getContext('2d').getImageData(0, 0, SIZE, SIZE).data,
        });
      }
      return masks;
    };

    const dominantPaintMask = (paintMasks, index) => {
      let best = null;
      let bestAlpha = 0;
      for (const mask of paintMasks) {
        const alpha = mask.data[index + 3];
        if (alpha <= bestAlpha) continue;
        best = mask;
        bestAlpha = alpha;
      }
      return bestAlpha > 0 ? best : null;
    };

    const finalizePaintBuckets = (paintBuckets) => [...paintBuckets.entries()]
      .map(([key, bucket]) => ({ key, ...finalizeBucket(bucket) }))
      .sort((a, b) => b.count - a.count || b.meanAbsDelta - a.meanAbsDelta)
      .slice(0, 32);

    const compositeTraceSnapshot = (snapshot) => {
      const current = new Uint8ClampedArray(snapshot.data.length);
      for (let index = 0; index < snapshot.data.length; index += 4) {
        const alpha = snapshot.data[index + 3] / 255;
        current[index] = Math.round(snapshot.data[index] * alpha + 255 * (1 - alpha));
        current[index + 1] = Math.round(snapshot.data[index + 1] * alpha + 255 * (1 - alpha));
        current[index + 2] = Math.round(snapshot.data[index + 2] * alpha + 255 * (1 - alpha));
        current[index + 3] = 255;
      }
      return current;
    };

    const pixelError = (data, refData, index) => (
      Math.abs(data[index] - refData[index])
      + Math.abs(data[index + 1] - refData[index + 1])
      + Math.abs(data[index + 2] - refData[index + 2])
    );

    const summarizeDenseLineFillCohorts = (trace, refData) => {
      const beforeSnapshot = trace.stages['before-density'];
      const densitySnapshot = trace.stages['after-density'];
      const shadowSnapshot = trace.stages['after-interior-shadow'];
      const finalSnapshot = trace.stages['after-edge-tone'];
      const coverageSnapshot = trace.stages['after-edge-coverage'];
      if (!beforeSnapshot || !densitySnapshot || !shadowSnapshot || !finalSnapshot || !coverageSnapshot) return [];

      const before = compositeTraceSnapshot(beforeSnapshot);
      const density = compositeTraceSnapshot(densitySnapshot);
      const shadow = compositeTraceSnapshot(shadowSnapshot);
      const final = compositeTraceSnapshot(finalSnapshot);
      const cohorts = new Map();
      for (let index = 0; index < before.length; index += 4) {
        if (before[index] === density[index]
          && before[index + 1] === density[index + 1]
          && before[index + 2] === density[index + 2]) continue;

        const beforeLuma = luma(before, index);
        const chroma = Math.max(before[index], before[index + 1], before[index + 2])
          - Math.min(before[index], before[index + 1], before[index + 2]);
        const lumaStart = Math.floor(beforeLuma / 16) * 16;
        const chromaStart = Math.floor(chroma / 32) * 32;
        const coverageAlpha = coverageSnapshot.data[index + 3];
        const coverageClass = coverageAlpha === 255 ? 'interior' : coverageAlpha > 0 ? 'edge' : 'outside';
        const key = `${coverageClass}/${lumaStart}-${Math.min(255, lumaStart + 15)}/${chromaStart}-${Math.min(255, chromaStart + 31)}`;
        const cohort = cohorts.get(key) ?? {
          coverageClass,
          lumaRange: `${lumaStart}-${Math.min(255, lumaStart + 15)}`,
          chromaRange: `${chromaStart}-${Math.min(255, chromaStart + 31)}`,
          count: 0,
          densityImproved: 0,
          densityWorsened: 0,
          shadowImproved: 0,
          beforeToleranceFailures: 0,
          densityToleranceRepairs: 0,
          densityToleranceRegressions: 0,
          finalToleranceRepairs: 0,
          finalToleranceRegressions: 0,
          finalBetterThanBefore: 0,
          finalWorseThanBefore: 0,
          beforeError: 0,
          densityError: 0,
          finalError: 0,
          desiredDeltaFromBefore: [0, 0, 0],
          desiredDeltaFromFinal: [0, 0, 0],
        };
        const beforeError = pixelError(before, refData, index);
        const densityError = pixelError(density, refData, index);
        const shadowError = pixelError(shadow, refData, index);
        const finalError = pixelError(final, refData, index);
        const failsTolerance = data => (
          Math.abs(data[index] - refData[index]) > BAD_DELTA_THRESHOLD
          || Math.abs(data[index + 1] - refData[index + 1]) > BAD_DELTA_THRESHOLD
          || Math.abs(data[index + 2] - refData[index + 2]) > BAD_DELTA_THRESHOLD
        );
        const beforeFailsTolerance = failsTolerance(before);
        const densityFailsTolerance = failsTolerance(density);
        const finalFailsTolerance = failsTolerance(final);
        cohort.count++;
        if (densityError < beforeError) cohort.densityImproved++;
        else if (densityError > beforeError) cohort.densityWorsened++;
        if (shadowError < densityError) cohort.shadowImproved++;
        if (beforeFailsTolerance) cohort.beforeToleranceFailures++;
        if (beforeFailsTolerance && !densityFailsTolerance) cohort.densityToleranceRepairs++;
        else if (!beforeFailsTolerance && densityFailsTolerance) cohort.densityToleranceRegressions++;
        if (beforeFailsTolerance && !finalFailsTolerance) cohort.finalToleranceRepairs++;
        else if (!beforeFailsTolerance && finalFailsTolerance) cohort.finalToleranceRegressions++;
        if (finalError < beforeError) cohort.finalBetterThanBefore++;
        else if (finalError > beforeError) cohort.finalWorseThanBefore++;
        cohort.beforeError += beforeError;
        cohort.densityError += densityError;
        cohort.finalError += finalError;
        for (let channel = 0; channel < 3; channel++) {
          cohort.desiredDeltaFromBefore[channel] += refData[index + channel] - before[index + channel];
          cohort.desiredDeltaFromFinal[channel] += refData[index + channel] - final[index + channel];
        }
        cohorts.set(key, cohort);
      }

      return [...cohorts.values()]
        .map((cohort) => ({
          ...cohort,
          meanBeforeError: Number((cohort.beforeError / cohort.count).toFixed(2)),
          meanDensityError: Number((cohort.densityError / cohort.count).toFixed(2)),
          meanFinalError: Number((cohort.finalError / cohort.count).toFixed(2)),
          meanDesiredDeltaFromBefore: cohort.desiredDeltaFromBefore
            .map(value => Number((value / cohort.count).toFixed(2))),
          meanDesiredDeltaFromFinal: cohort.desiredDeltaFromFinal
            .map(value => Number((value / cohort.count).toFixed(2))),
        }))
        .sort((a, b) => b.finalWorseThanBefore - a.finalWorseThanBefore || b.count - a.count)
        .slice(0, 32)
        .map(({ beforeError, densityError, finalError, desiredDeltaFromBefore, desiredDeltaFromFinal, ...cohort }) => cohort);
    };

    const summarizeDenseLineFillTrace = (trace, refData) => {
      if (!trace.applied) return { applied: false, stages: [] };
      const stageOrder = [
        'before-edge-coverage',
        'after-edge-coverage',
        'before-density',
        'after-density',
        'after-interior-shadow',
        'after-edge-tone',
      ];
      let previous = null;
      const stages = [];
      for (const stage of stageOrder) {
        const snapshot = trace.stages[stage];
        if (!snapshot) continue;
        const current = compositeTraceSnapshot(snapshot);
        let changedPixels = 0;
        let improvedPixels = 0;
        let worsenedPixels = 0;
        let channelToleranceFailures = 0;
        let absoluteError = 0;
        for (let index = 0; index < current.length; index += 4) {
          const currentError = pixelError(current, refData, index);
          absoluteError += currentError;
          if (Math.abs(current[index] - refData[index]) > BAD_DELTA_THRESHOLD
            || Math.abs(current[index + 1] - refData[index + 1]) > BAD_DELTA_THRESHOLD
            || Math.abs(current[index + 2] - refData[index + 2]) > BAD_DELTA_THRESHOLD) {
            channelToleranceFailures++;
          }
          if (!previous) continue;
          const changed = current[index] !== previous[index]
            || current[index + 1] !== previous[index + 1]
            || current[index + 2] !== previous[index + 2];
          if (!changed) continue;
          changedPixels++;
          const previousError = pixelError(previous, refData, index);
          if (currentError < previousError) improvedPixels++;
          else if (currentError > previousError) worsenedPixels++;
        }
        stages.push({
          stage,
          changedPixels,
          improvedPixels,
          worsenedPixels,
          netImprovedPixels: improvedPixels - worsenedPixels,
          channelToleranceFailures,
          meanAbsoluteError: Number((absoluteError / (current.length / 4)).toFixed(3)),
          score: (() => {
            const score = bench.scorePixelBuffers(
              { width: SIZE, height: SIZE, data: refData },
              { width: snapshot.width, height: snapshot.height, data: current },
            );
            return {
              raw: score.rawScore,
              aligned: score.alignedScore,
              focused: score.normalizedScore,
              foregroundIou: score.foregroundIou,
            };
          })(),
        });
        previous = current;
      }
      return {
        applied: true,
        usePriority2CarrierTone: trace.usePriority2CarrierTone,
        outputFractionalAlphaPixels: trace.outputFractionalAlphaPixels,
        stages,
        densityCohorts: summarizeDenseLineFillCohorts(trace, refData),
      };
    };

    const analyzeCase = async (drawingName) => {
      const drawing = tvg.parseTVG(await zip.file(`${base}/${drawingName}.tvg`).async('arraybuffer'));
      tvg.resolveExternalPalette(drawing, externalColors);

      const thumbnail = await loadImage(await zip.file(`${base}/.thumbnails/.${drawingName}.tvg.png`).async('arraybuffer'));
      const refCanvas = document.createElement('canvas');
      refCanvas.width = SIZE;
      refCanvas.height = SIZE;
      const refCtx = refCanvas.getContext('2d');
      refCtx.fillStyle = '#fff';
      refCtx.fillRect(0, 0, SIZE, SIZE);
      refCtx.drawImage(thumbnail, 0, 0, SIZE, SIZE);
      const refData = refCtx.getImageData(0, 0, SIZE, SIZE).data;

      const denseLineFillTrace = {
        applied: false,
        usePriority2CarrierTone: false,
        outputFractionalAlphaPixels: 0,
        stages: {},
      };
      const candidate = tvg.renderTVGToCanvas(drawing, SIZE, SIZE, viewport, {
        supersample: 2,
        denseLineFillTrace,
      });
      if (candidate) await tvg.loadBitmapTiles(candidate, drawing.diagnostics);
      const transparent = tvg.renderTVGToCanvas(
        drawing,
        SIZE,
        SIZE,
        viewport,
        { supersample: 2, skipBackgroundComposite: true },
      );
      if (transparent) await tvg.loadBitmapTiles(transparent, drawing.diagnostics);

      const candidateData = candidate.getContext('2d').getImageData(0, 0, SIZE, SIZE).data;
      const alphaData = transparent.getContext('2d').getImageData(0, 0, SIZE, SIZE).data;
      const score = bench.scoreCanvasSources(thumbnail, candidate, SIZE);
      const paintMasks = await buildPaintMasks(drawing);

      const buckets = {
        bothForegroundEdge: emptyBucket(),
        bothForegroundInterior: emptyBucket(),
        bothForegroundBadEdge: emptyBucket(),
        bothForegroundBadInterior: emptyBucket(),
      };
      const lumaBuckets = new Map();
      const paintBuckets = new Map();
      const refOnly = [];
      const candidateOnly = [];
      let bothForeground = 0;
      let badBothForeground = 0;
      let channelToleranceFailures = 0;
      let edgeForeground = 0;
      let interiorForeground = 0;

      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          const index = (y * SIZE + x) * 4;
          const refFg = isForeground(refData, index);
          const candidateFg = isForeground(candidateData, index);
          const alpha = alphaData[index + 3];
          const isEdge = alpha > 0 && alpha < 255;
          const dominantPaint = includePaintBuckets ? dominantPaintMask(paintMasks, index) : null;
          const paintBucketPrefix = dominantPaint?.label ?? 'unclassified';

          if (refFg && !candidateFg) {
            refOnly.push({ x, y });
            if (includePaintBuckets) {
              const key = `${paintBucketPrefix}|ref-only`;
              if (!paintBuckets.has(key)) paintBuckets.set(key, emptyBucket());
              addToBucket(paintBuckets.get(key), refData, candidateData, index);
            }
            continue;
          }
          if (!refFg && candidateFg) {
            candidateOnly.push({ x, y });
            if (includePaintBuckets) {
              const key = `${paintBucketPrefix}|candidate-only`;
              if (!paintBuckets.has(key)) paintBuckets.set(key, emptyBucket());
              addToBucket(paintBuckets.get(key), refData, candidateData, index);
            }
            continue;
          }
          if (!refFg || !candidateFg) continue;

          bothForeground += 1;
          if (isEdge) edgeForeground += 1;
          else interiorForeground += 1;

          const bucket = isEdge ? buckets.bothForegroundEdge : buckets.bothForegroundInterior;
          addToBucket(bucket, refData, candidateData, index);
          if (includePaintBuckets) {
            const key = `${paintBucketPrefix}|${isEdge ? 'edge' : 'interior'}`;
            if (!paintBuckets.has(key)) paintBuckets.set(key, emptyBucket());
            addToBucket(paintBuckets.get(key), refData, candidateData, index);
          }

          const absDelta = Math.abs(candidateData[index] - refData[index])
            + Math.abs(candidateData[index + 1] - refData[index + 1])
            + Math.abs(candidateData[index + 2] - refData[index + 2]);
          const channelToleranceFail = Math.abs(candidateData[index] - refData[index]) > BAD_DELTA_THRESHOLD
            || Math.abs(candidateData[index + 1] - refData[index + 1]) > BAD_DELTA_THRESHOLD
            || Math.abs(candidateData[index + 2] - refData[index + 2]) > BAD_DELTA_THRESHOLD;
          const refLumaBucket = `${Math.floor(luma(refData, index) / 32) * 32}-${Math.floor(luma(refData, index) / 32) * 32 + 31}`;
          if (!lumaBuckets.has(refLumaBucket)) lumaBuckets.set(refLumaBucket, emptyBucket());
          addToBucket(lumaBuckets.get(refLumaBucket), refData, candidateData, index);

          if (channelToleranceFail) {
            channelToleranceFailures += 1;
            if (includePaintBuckets) {
              const key = `${paintBucketPrefix}|tolerance-fail-${isEdge ? 'edge' : 'interior'}`;
              if (!paintBuckets.has(key)) paintBuckets.set(key, emptyBucket());
              addToBucket(paintBuckets.get(key), refData, candidateData, index);
            }
          }

          if (absDelta > BAD_DELTA_THRESHOLD) {
            badBothForeground += 1;
            const badBucket = isEdge ? buckets.bothForegroundBadEdge : buckets.bothForegroundBadInterior;
            addToBucket(badBucket, refData, candidateData, index);
            if (includePaintBuckets) {
              const key = `${paintBucketPrefix}|bad-${isEdge ? 'edge' : 'interior'}`;
              if (!paintBuckets.has(key)) paintBuckets.set(key, emptyBucket());
              addToBucket(paintBuckets.get(key), refData, candidateData, index);
            }
          }
        }
      }

      return {
        drawingName,
        viewport,
        score,
        counts: {
          bothForeground,
          badBothForeground,
          channelToleranceFailures,
          edgeForeground,
          interiorForeground,
          refOnly: refOnly.length,
          candidateOnly: candidateOnly.length,
        },
        buckets: Object.fromEntries(
          Object.entries(buckets).map(([key, bucket]) => [key, finalizeBucket(bucket)]),
        ),
        lumaBuckets: [...lumaBuckets.entries()]
          .sort(([a], [b]) => Number(a.split('-')[0]) - Number(b.split('-')[0]))
          .map(([range, bucket]) => ({ range, ...finalizeBucket(bucket) })),
        paintBuckets: includePaintBuckets ? finalizePaintBuckets(paintBuckets) : undefined,
        denseLineFillTrace: summarizeDenseLineFillTrace(denseLineFillTrace, refData),
        refOnlySummary: {
          bounds: boundsForMask(refOnly),
          topRows: rowCounts(refOnly),
          alpha: alphaSummary(refOnly, alphaData),
        },
        candidateOnlySummary: {
          bounds: boundsForMask(candidateOnly),
          topRows: rowCounts(candidateOnly),
          alpha: alphaSummary(candidateOnly, alphaData),
        },
        details: includeDetails
          ? {
              sampleRefOnly: refOnly.slice(0, 20),
              sampleCandidateOnly: candidateOnly.slice(0, 20),
            }
          : undefined,
      };
    };

    return Promise.all(drawingNames.map(analyzeCase));
  }, { elementName, drawingNames, includeDetails, includePaintBuckets });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
