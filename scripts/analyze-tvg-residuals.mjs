import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const [elementName, drawingNamesArg] = args;

if (!elementName || !drawingNamesArg) {
  console.error('Usage: node scripts/analyze-tvg-residuals.mjs <elementName> <drawing[,drawing...]> [--details]');
  process.exit(1);
}

const includeDetails = args.includes('--details');
const drawingNames = drawingNamesArg.split(',').map((name) => name.trim()).filter(Boolean);

const browser = await puppeteer.launch({ headless: 'new' });

try {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(0);
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async ({ elementName, drawingNames, includeDetails }) => {
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

      const candidateData = candidate.getContext('2d').getImageData(0, 0, SIZE, SIZE).data;
      const alphaData = transparent.getContext('2d').getImageData(0, 0, SIZE, SIZE).data;
      const score = bench.scoreCanvasSources(thumbnail, candidate, SIZE);

      const buckets = {
        bothForegroundEdge: emptyBucket(),
        bothForegroundInterior: emptyBucket(),
        bothForegroundBadEdge: emptyBucket(),
        bothForegroundBadInterior: emptyBucket(),
      };
      const lumaBuckets = new Map();
      const refOnly = [];
      const candidateOnly = [];
      let bothForeground = 0;
      let badBothForeground = 0;
      let edgeForeground = 0;
      let interiorForeground = 0;

      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          const index = (y * SIZE + x) * 4;
          const refFg = isForeground(refData, index);
          const candidateFg = isForeground(candidateData, index);
          const alpha = alphaData[index + 3];
          const isEdge = alpha > 0 && alpha < 255;

          if (refFg && !candidateFg) {
            refOnly.push({ x, y });
            continue;
          }
          if (!refFg && candidateFg) {
            candidateOnly.push({ x, y });
            continue;
          }
          if (!refFg || !candidateFg) continue;

          bothForeground += 1;
          if (isEdge) edgeForeground += 1;
          else interiorForeground += 1;

          const bucket = isEdge ? buckets.bothForegroundEdge : buckets.bothForegroundInterior;
          addToBucket(bucket, refData, candidateData, index);

          const absDelta = Math.abs(candidateData[index] - refData[index])
            + Math.abs(candidateData[index + 1] - refData[index + 1])
            + Math.abs(candidateData[index + 2] - refData[index + 2]);
          const refLumaBucket = `${Math.floor(luma(refData, index) / 32) * 32}-${Math.floor(luma(refData, index) / 32) * 32 + 31}`;
          if (!lumaBuckets.has(refLumaBucket)) lumaBuckets.set(refLumaBucket, emptyBucket());
          addToBucket(lumaBuckets.get(refLumaBucket), refData, candidateData, index);

          if (absDelta > BAD_DELTA_THRESHOLD) {
            badBothForeground += 1;
            const badBucket = isEdge ? buckets.bothForegroundBadEdge : buckets.bothForegroundBadInterior;
            addToBucket(badBucket, refData, candidateData, index);
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
  }, { elementName, drawingNames, includeDetails });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
