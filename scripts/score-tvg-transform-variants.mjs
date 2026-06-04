import puppeteer from 'puppeteer';

const SIZE = 160;

const args = process.argv.slice(2);
const caseArg = args.find(arg => !arg.startsWith('--'));
const topArg = args.find(arg => arg.startsWith('--top='));
const maxTop = topArg ? Math.max(1, Number.parseInt(topArg.slice('--top='.length), 10) || 8) : 8;
const summaryOnly = args.includes('--summary-only');

if (!caseArg) {
  console.error('Usage: node scripts/score-tvg-transform-variants.mjs <element/drawing[,element/drawing...]> [--top=8] [--summary-only]');
  process.exit(1);
}

const cases = caseArg.split(',')
  .map(entry => entry.trim())
  .filter(Boolean)
  .map(entry => {
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

  const result = await page.evaluate(async ({ cases, maxTop, summaryOnly, size }) => {
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

    const shifts = [-1, -0.5, 0, 0.5, 1];
    const scales = [0.99, 0.995, 1, 1.005, 1.01];
    const variants = [];
    for (const scale of scales) {
      for (const dx of shifts) {
        for (const dy of shifts) {
          variants.push({ name: `post-s${scale.toFixed(3)}-dx${dx}-dy${dy}`, scale, dx, dy });
        }
      }
    }

    function isForeground(data, index) {
      return Math.abs(data[index + 0] - 255) > 12
        || Math.abs(data[index + 1] - 255) > 12
        || Math.abs(data[index + 2] - 255) > 12
        || data[index + 3] < 243;
    }

    function rawFixedScore(referenceCanvas, candidateCanvas) {
      const reference = referenceCanvas.getContext('2d').getImageData(0, 0, size, size).data;
      const candidate = candidateCanvas.getContext('2d').getImageData(0, 0, size, size).data;
      let matched = 0;
      let unionForeground = 0;
      let intersectForeground = 0;
      const total = size * size;
      for (let i = 0; i < reference.length; i += 4) {
        const refForeground = isForeground(reference, i);
        const candidateForeground = isForeground(candidate, i);
        if (refForeground || candidateForeground) unionForeground++;
        if (refForeground && candidateForeground) intersectForeground++;
        if (Math.abs(reference[i + 0] - candidate[i + 0]) <= 50
          && Math.abs(reference[i + 1] - candidate[i + 1]) <= 50
          && Math.abs(reference[i + 2] - candidate[i + 2]) <= 50) {
          matched++;
        }
      }
      return {
        raw: (matched / total) * 100,
        iou: unionForeground > 0 ? (intersectForeground / unionForeground) * 100 : 100,
      };
    }

    function transformedCanvas(source, variant) {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, size, size);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      const renderSize = size * variant.scale;
      const origin = (size - renderSize) / 2;
      ctx.drawImage(source, origin + variant.dx, origin + variant.dy, renderSize, renderSize);
      return canvas;
    }

    async function loadCase(elementName, drawingName) {
      const element = elements.find(entry => entry.name === elementName);
      const viewport = ((element?.fieldChart ?? 12) * tpl.TVG_UNITS_PER_FIELD) || 336;
      const base = `CH_Anna_rig_football_suit_V001_V07/elements/${elementName}`;
      const drawing = tvg.parseTVG(await zip.file(`${base}/${drawingName}.tvg`).async('arraybuffer'));
      tvg.resolveExternalPalette(drawing, externalColors);
      const candidate = tvg.renderTVGToCanvas(drawing, size, size, viewport, { supersample: 2 });
      if (candidate) await tvg.loadBitmapTiles(candidate, drawing.diagnostics);
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
      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = size;
      thumbCanvas.height = size;
      const thumbCtx = thumbCanvas.getContext('2d');
      thumbCtx.fillStyle = '#fff';
      thumbCtx.fillRect(0, 0, size, size);
      thumbCtx.drawImage(thumb, 0, 0, size, size);
      return { viewport, drawing, candidate, thumb, thumbCanvas };
    }

    const perCase = [];
    const aggregate = new Map();
    for (const testCase of cases) {
      const { viewport, drawing, candidate, thumb, thumbCanvas } = await loadCase(testCase.elementName, testCase.drawingName);
      const baseline = bench.scoreCanvasSources(thumb, candidate, size);
      const fastBaseline = rawFixedScore(thumbCanvas, candidate);
      const scored = [];
      for (const variant of variants) {
        const transformed = transformedCanvas(candidate, variant);
        const score = rawFixedScore(thumbCanvas, transformed);
        scored.push({
          ...variant,
          raw: score.raw,
          rawDelta: score.raw - fastBaseline.raw,
          focused: null,
          focusedDelta: null,
          iou: score.iou,
        });
        const aggregateEntry = aggregate.get(variant.name) ?? {
          ...variant,
          count: 0,
          rawDeltaSum: 0,
          focusedDeltaSum: 0,
          minRawDelta: Infinity,
          maxRawDelta: -Infinity,
          regressions: 0,
        };
        aggregateEntry.count += 1;
        aggregateEntry.rawDeltaSum += score.raw - fastBaseline.raw;
        aggregateEntry.focusedDeltaSum += 0;
        aggregateEntry.minRawDelta = Math.min(aggregateEntry.minRawDelta, score.raw - fastBaseline.raw);
        aggregateEntry.maxRawDelta = Math.max(aggregateEntry.maxRawDelta, score.raw - fastBaseline.raw);
        if (score.raw < fastBaseline.raw - 0.0001) aggregateEntry.regressions += 1;
        aggregate.set(variant.name, aggregateEntry);
      }
      scored.sort((a, b) => b.raw - a.raw || b.focused - a.focused);
      const top = scored.slice(0, maxTop);
      const best = top[0];
      perCase.push({
        case: `${testCase.elementName}/${testCase.drawingName}`,
        viewport,
        diagnostics: summaryOnly ? undefined : drawing.diagnostics,
        baseline: {
          raw: baseline.rawScore,
          fastRaw: fastBaseline.raw,
          fastRawDeltaFromBenchmark: fastBaseline.raw - baseline.rawScore,
          focused: baseline.normalizedScore,
          iou: baseline.foregroundIou,
        },
        best,
        top,
      });
    }

    const aggregateResults = Array.from(aggregate.values())
      .map(entry => ({
        name: entry.name,
        scale: entry.scale,
        dx: entry.dx,
        dy: entry.dy,
        averageRawDelta: entry.rawDeltaSum / entry.count,
        averageFocusedDelta: entry.focusedDeltaSum / entry.count,
        minRawDelta: entry.minRawDelta,
        maxRawDelta: entry.maxRawDelta,
        regressions: entry.regressions,
      }))
      .sort((a, b) => b.averageRawDelta - a.averageRawDelta || a.regressions - b.regressions)
      .slice(0, maxTop);

    return { cases: perCase, aggregate: aggregateResults };
  }, { cases, maxTop, summaryOnly, size: SIZE });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
