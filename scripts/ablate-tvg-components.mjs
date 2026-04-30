import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
let layerType = null;
let shapeIndex = null;
let limit = 20;
let sortMode = 'remove-desc';
let componentIndexes = null;
let skipOnly = false;
let groupRemoval = false;
let includeDetails = false;
const positional = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--layer') {
    layerType = args[++i] ?? null;
  } else if (arg === '--shape') {
    shapeIndex = Number.parseInt(args[++i] ?? '-1', 10);
  } else if (arg === '--limit') {
    limit = Number.parseInt(args[++i] ?? '20', 10);
  } else if (arg === '--sort') {
    sortMode = args[++i] ?? 'remove-desc';
  } else if (arg === '--components') {
    componentIndexes = (args[++i] ?? '')
      .split(',')
      .map(value => Number.parseInt(value, 10))
      .filter(value => Number.isFinite(value));
  } else if (arg === '--skip-only') {
    skipOnly = true;
  } else if (arg === '--group' || arg === '--remove-components-as-group') {
    groupRemoval = true;
  } else if (arg === '--details' || arg === '--component-details') {
    includeDetails = true;
  } else {
    positional.push(arg);
  }
}

const [elementName, drawingName] = positional;

if (!elementName || !drawingName || !layerType || shapeIndex === null || Number.isNaN(shapeIndex)) {
  console.error('Usage: node scripts/ablate-tvg-components.mjs <elementName> <drawingName> --layer underlay|color|line|overlay --shape N [--components 1,2,3] [--limit N] [--sort remove-desc|remove-asc|raw-desc|raw-asc|aligned-desc|aligned-asc|only-desc] [--skip-only] [--group] [--details]');
  process.exit(1);
}

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 0 });

try {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(0);
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async ({ elementName, drawingName, layerType, shapeIndex, componentIndexes, limit, sortMode, skipOnly, groupRemoval, includeDetails }) => {
    const JSZipMod = await import('/node_modules/.vite/deps/jszip.js');
    const tvg = await import('/src/tvg-parser.ts');
    const pal = await import('/src/tpl-palette.ts');
    const bench = await import('/src/tvg-benchmark.ts');
    const tpl = await import('/src/tpl-parser.ts');

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

    const targetLayerIndex = drawing.layers.findIndex(entry => entry.type === layerType);
    if (targetLayerIndex < 0) {
      return { error: `Layer ${layerType} not found` };
    }
    const targetLayer = drawing.layers[targetLayerIndex];
    const targetShape = targetLayer.shapes[shapeIndex];
    if (!targetShape) {
      return { error: `Shape ${shapeIndex} not found in layer ${layerType}` };
    }

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
    const baseScore = bench.scoreCanvasSources(thumb, ensureCanvas(baseCanvas), 160);

    const cases = [];
    const indexes = componentIndexes && componentIndexes.length > 0
      ? componentIndexes.filter(index => index >= 0 && index < targetShape.components.length)
      : Array.from({ length: targetShape.components.length }, (_, index) => index);
    const indexGroups = groupRemoval ? [indexes] : indexes.map(index => [index]);

    for (const componentGroup of indexGroups) {
      if (componentGroup.length === 0) continue;
      const removedIndexes = new Set(componentGroup);
      const removed = {
        ...drawing,
        layers: drawing.layers.map((layer, li) =>
          li === targetLayerIndex
            ? {
                ...layer,
                shapes: layer.shapes.map((shape, si) =>
                  si === shapeIndex
                    ? { ...shape, components: shape.components.filter((_, ci) => !removedIndexes.has(ci)) }
                    : { ...shape },
                ),
              }
            : { ...layer },
        ),
      };
      const removedCanvas = tvg.renderTVGToCanvas(removed, 160, 160, viewport, { supersample: 2 });
      if (removedCanvas) await tvg.loadBitmapTiles(removedCanvas, removed.diagnostics);
      const removedScore = bench.scoreCanvasSources(thumb, ensureCanvas(removedCanvas), 160);

      let onlyScore = null;
      if (!skipOnly) {
        const only = {
          ...drawing,
          layers: drawing.layers.map((layer, li) =>
            li === targetLayerIndex
              ? {
                ...layer,
                shapes: layer.shapes.map((shape, si) =>
                  si === shapeIndex
                    ? { ...shape, components: shape.components.filter((_, ci) => removedIndexes.has(ci)) }
                    : { ...shape, components: [] },
                ),
              }
              : { ...layer, shapes: [] },
          ),
        };
        const onlyCanvas = tvg.renderTVGToCanvas(only, 160, 160, viewport, { supersample: 2 });
        if (onlyCanvas) await tvg.loadBitmapTiles(onlyCanvas, only.diagnostics);
        onlyScore = bench.scoreCanvasSources(thumb, ensureCanvas(onlyCanvas), 160);
      }

      const componentIndex = componentGroup.length === 1 ? componentGroup[0] : null;
      const component = targetShape.components[componentGroup[0]];
      const componentSummaries = includeDetails
        ? componentGroup.map(index => {
            const entry = targetShape.components[index];
            return {
              componentIndex: index,
              componentType: entry.componentType,
              fillPaintSource: entry.fillPaintSource,
              color: entry.color,
              outerPaint: entry.outerPaint,
              insideColor: entry.insideColor,
              strokeWidth: entry.strokeWidth,
              pathSegments: entry.path?.segments.length ?? 0,
              closed: entry.path?.closed ?? false,
            };
          })
        : null;
      cases.push({
        componentIndex,
        componentIndexes: componentGroup,
        componentCount: componentGroup.length,
        ...(componentSummaries ? { components: componentSummaries } : {}),
        componentType: component.componentType,
        fillPaintSource: component.fillPaintSource,
        color: component.color,
        outerPaint: component.outerPaint,
        insideColor: component.insideColor,
        strokeWidth: component.strokeWidth,
        pathSegments: component.path?.segments.length ?? 0,
        closed: component.path?.closed ?? false,
        removeScore: removedScore.score,
        removeDelta: removedScore.score - baseScore.score,
        removeAlignedScore: removedScore.alignedScore,
        removeAlignedDelta: removedScore.alignedScore - baseScore.alignedScore,
        removeRawScore: removedScore.rawScore,
        removeRawDelta: removedScore.rawScore - baseScore.rawScore,
        removeNormalizedDelta: removedScore.normalizedScore - baseScore.normalizedScore,
        onlyScore: onlyScore?.score ?? null,
        onlyAlignedScore: onlyScore?.alignedScore ?? null,
        onlyRawScore: onlyScore?.rawScore ?? null,
        onlyNormalizedScore: onlyScore?.normalizedScore ?? null,
      });
    }

    cases.sort((a, b) => {
      if (sortMode === 'raw-desc') {
        if (b.removeRawDelta !== a.removeRawDelta) return b.removeRawDelta - a.removeRawDelta;
      } else if (sortMode === 'raw-asc') {
        if (a.removeRawDelta !== b.removeRawDelta) return a.removeRawDelta - b.removeRawDelta;
      } else if (sortMode === 'aligned-desc') {
        if (b.removeAlignedDelta !== a.removeAlignedDelta) return b.removeAlignedDelta - a.removeAlignedDelta;
      } else if (sortMode === 'aligned-asc') {
        if (a.removeAlignedDelta !== b.removeAlignedDelta) return a.removeAlignedDelta - b.removeAlignedDelta;
      } else if (sortMode === 'remove-asc') {
        if (a.removeDelta !== b.removeDelta) return a.removeDelta - b.removeDelta;
      } else if (sortMode === 'only-desc') {
        if ((b.onlyNormalizedScore ?? -Infinity) !== (a.onlyNormalizedScore ?? -Infinity)) {
          return (b.onlyNormalizedScore ?? -Infinity) - (a.onlyNormalizedScore ?? -Infinity);
        }
      } else if (b.removeDelta !== a.removeDelta) {
        return b.removeDelta - a.removeDelta;
      }
      if (sortMode !== 'only-desc' && (b.onlyNormalizedScore ?? -Infinity) !== (a.onlyNormalizedScore ?? -Infinity)) {
        return (b.onlyNormalizedScore ?? -Infinity) - (a.onlyNormalizedScore ?? -Infinity);
      }
      if (sortMode === 'only-desc' && b.removeDelta !== a.removeDelta) {
        return b.removeDelta - a.removeDelta;
      }
      return (a.componentIndex ?? a.componentIndexes[0]) - (b.componentIndex ?? b.componentIndexes[0]);
    });

    return {
      elementName,
      drawingName,
      layerType,
      shapeIndex,
      viewport,
      sortMode,
      skipOnly,
      groupRemoval,
      includeDetails,
      baseScore,
      cases: cases.slice(0, limit),
      totalCases: cases.length,
    };
  }, { elementName, drawingName, layerType, shapeIndex, componentIndexes, limit, sortMode, skipOnly, groupRemoval, includeDetails });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
