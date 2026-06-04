import puppeteer from 'puppeteer';

const SIZE = 160;

const args = process.argv.slice(2);
const caseArg = args.find(arg => !arg.startsWith('--'));
const summaryOnly = args.includes('--summary-only');

if (!caseArg) {
  console.error('Usage: node scripts/score-tvg-pencil-variants.mjs <element/drawing[,element/drawing...]> [--summary-only]');
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

  const result = await page.evaluate(async ({ cases, summaryOnly, size }) => {
    const JSZipMod = await import('/node_modules/.vite/deps/jszip.js');
    const tvg = await import('/src/tvg-parser.ts');
    const pal = await import('/src/tpl-palette.ts');
    const tpl = await import('/src/tpl-parser.ts');
    const bench = await import('/src/tvg-benchmark.ts');

    const variants = [
      { name: 'baseline', scale: 1, axisOnly: false },
      { name: 'all-pencil-width-0.70', scale: 0.7, axisOnly: false },
      { name: 'all-pencil-width-0.80', scale: 0.8, axisOnly: false },
      { name: 'all-pencil-width-0.90', scale: 0.9, axisOnly: false },
      { name: 'all-pencil-width-1.10', scale: 1.1, axisOnly: false },
      { name: 'axis-pencil-width-0.70', scale: 0.7, axisOnly: true },
      { name: 'axis-pencil-width-0.80', scale: 0.8, axisOnly: true },
      { name: 'axis-pencil-width-0.90', scale: 0.9, axisOnly: true },
      { name: 'axis-pencil-width-1.10', scale: 1.1, axisOnly: true },
    ];

    const zip = await JSZipMod.default.loadAsync(
      await (await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip')).arrayBuffer(),
    );
    const xstageXml = new DOMParser().parseFromString(
      await zip.file('CH_Anna_rig_football_suit_V001_V07/scene.xstage').async('text'),
      'text/xml',
    );
    const elements = tpl.parseElements(xstageXml);
    const externalColors = pal.flattenExternalPaletteColors(await pal.loadPalettes(zip));

    function isStraightAxisPath(path) {
      if (!path || path.closed || path.segments.length !== 2) return false;
      const [start, end] = path.segments;
      if (start.type !== 'M' || end.type !== 'L') return false;
      const dx = Math.abs(start.x - end.x);
      const dy = Math.abs(start.y - end.y);
      return dx <= 0.001 || dy <= 0.001;
    }

    function scaleThicknessProfile(profile, scale) {
      if (!profile) return profile;
      return {
        ...profile,
        points: profile.points.map(point => ({
          ...point,
          leftOffset: point.leftOffset * scale,
          rightOffset: point.rightOffset * scale,
          leftCtrlBack: { ...point.leftCtrlBack, y: point.leftCtrlBack.y * scale },
          leftCtrlFwd: { ...point.leftCtrlFwd, y: point.leftCtrlFwd.y * scale },
          rightCtrlBack: { ...point.rightCtrlBack, y: point.rightCtrlBack.y * scale },
          rightCtrlFwd: { ...point.rightCtrlFwd, y: point.rightCtrlFwd.y * scale },
        })),
      };
    }

    function scalePencils(drawing, variant) {
      if (variant.scale === 1) return drawing;
      const clone = structuredClone(drawing);
      for (const layer of clone.layers) {
        for (const shape of layer.shapes) {
          for (const comp of shape.components) {
            if (comp.componentType !== 4) continue;
            if (variant.axisOnly && !isStraightAxisPath(comp.path)) continue;
            if (comp.strokeWidth !== null) comp.strokeWidth *= variant.scale;
            if (comp.tgtiThickness !== null) comp.tgtiThickness *= variant.scale;
            comp.thicknessProfile = scaleThicknessProfile(comp.thicknessProfile, variant.scale);
          }
        }
      }
      return clone;
    }

    async function loadImage(bytes) {
      const blob = new Blob([bytes], { type: 'image/png' });
      return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = URL.createObjectURL(blob);
      });
    }

    async function loadCase(testCase) {
      const element = elements.find(entry => entry.name === testCase.elementName);
      const viewport = ((element?.fieldChart ?? 12) * tpl.TVG_UNITS_PER_FIELD) || 336;
      const base = `CH_Anna_rig_football_suit_V001_V07/elements/${testCase.elementName}`;
      const drawing = tvg.parseTVG(await zip.file(`${base}/${testCase.drawingName}.tvg`).async('arraybuffer'));
      tvg.resolveExternalPalette(drawing, externalColors);
      const thumb = await loadImage(await zip.file(`${base}/.thumbnails/.${testCase.drawingName}.tvg.png`).async('arraybuffer'));
      return { viewport, drawing, thumb };
    }

    const perCase = [];
    const aggregate = new Map();
    for (const testCase of cases) {
      const { viewport, drawing, thumb } = await loadCase(testCase);
      const rows = [];
      let baseline = null;
      for (const variant of variants) {
        const candidateDrawing = scalePencils(drawing, variant);
        const canvas = tvg.renderTVGToCanvas(candidateDrawing, size, size, viewport, { supersample: 2 });
        if (canvas) await tvg.loadBitmapTiles(canvas, candidateDrawing.diagnostics);
        const score = bench.scoreCanvasSources(thumb, canvas, size);
        const row = {
          variant: variant.name,
          raw: score.rawScore,
          aligned: score.alignedScore,
          focused: score.normalizedScore,
          iou: score.foregroundIou,
        };
        rows.push(row);
        if (variant.name === 'baseline') baseline = row;
      }
      for (const row of rows) {
        const entry = aggregate.get(row.variant) ?? {
          variant: row.variant,
          count: 0,
          rawDeltaSum: 0,
          minRawDelta: Infinity,
          maxRawDelta: -Infinity,
          regressions: 0,
        };
        const rawDelta = row.raw - baseline.raw;
        entry.count += 1;
        entry.rawDeltaSum += rawDelta;
        entry.minRawDelta = Math.min(entry.minRawDelta, rawDelta);
        entry.maxRawDelta = Math.max(entry.maxRawDelta, rawDelta);
        if (rawDelta < -0.0001) entry.regressions += 1;
        aggregate.set(row.variant, entry);
      }
      perCase.push({
        case: `${testCase.elementName}/${testCase.drawingName}`,
        viewport,
        diagnostics: summaryOnly ? undefined : drawing.diagnostics,
        rows: rows.map(row => ({
          ...row,
          rawDelta: row.raw - baseline.raw,
          alignedDelta: row.aligned - baseline.aligned,
          focusedDelta: row.focused - baseline.focused,
          iouDelta: row.iou - baseline.iou,
        })),
      });
    }

    const summary = Array.from(aggregate.values())
      .map(entry => ({
        variant: entry.variant,
        averageRawDelta: entry.rawDeltaSum / entry.count,
        minRawDelta: entry.minRawDelta,
        maxRawDelta: entry.maxRawDelta,
        regressions: entry.regressions,
      }))
      .sort((a, b) => b.averageRawDelta - a.averageRawDelta || a.regressions - b.regressions);

    return { cases: perCase, summary };
  }, { cases, summaryOnly, size: SIZE });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
