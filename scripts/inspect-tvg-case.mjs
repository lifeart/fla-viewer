import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const summaryOnly = args.includes('--summary');
const positional = args.filter(arg => arg !== '--summary');
const [elementName, drawingName] = positional;

if (!elementName || !drawingName) {
  console.error('Usage: node scripts/inspect-tvg-case.mjs <elementName> <drawingName>');
  process.exit(1);
}

const browser = await puppeteer.launch({ headless: 'new' });

try {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(0);
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async ({ elementName, drawingName }) => {
    const JSZipMod = await import('/node_modules/.vite/deps/jszip.js');
    const tvg = await import('/src/tvg-parser.ts');
    const pal = await import('/src/tpl-palette.ts');
    const bench = await import('/src/tvg-benchmark.ts');
    const preview = await import('/src/tvg-preview.ts');
    const tpl = await import('/src/tpl-parser.ts');

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

    const rawRendered = tvg.renderTVGToCanvas(drawing, 160, 160, viewport, { supersample: 2 });
    if (rawRendered) {
      await tvg.loadBitmapTiles(rawRendered, drawing.diagnostics);
    }

    const rendered = await preview.renderTVGWithEmbeddedThumbnailFallback(
      drawing,
      160,
      160,
      viewport,
      { supersample: 2 },
      thumb,
    );

    const layerCanvases = {
      underlay: tvg.renderTVGToCanvas(drawing, 160, 160, viewport, { supersample: 2, artLayerFilter: 'underlay' }),
      color: tvg.renderTVGToCanvas(drawing, 160, 160, viewport, { supersample: 2, artLayerFilter: 'color' }),
      line: tvg.renderTVGToCanvas(drawing, 160, 160, viewport, { supersample: 2, artLayerFilter: 'line' }),
      overlay: tvg.renderTVGToCanvas(drawing, 160, 160, viewport, { supersample: 2, artLayerFilter: 'overlay' }),
    };
    for (const canvas of Object.values(layerCanvases)) {
      if (canvas) {
        await tvg.loadBitmapTiles(canvas, drawing.diagnostics);
      }
    }

    const score = bench.scoreCanvasSources(thumb, rendered, 160);
    const rawRenderScore = rawRendered
      ? bench.scoreCanvasSources(thumb, rawRendered, 160)
      : null;
    const previewFallbackDelta = rawRenderScore
      ? {
          score: score.score - rawRenderScore.score,
          gateScore: score.gateScore - rawRenderScore.gateScore,
          rawScore: score.rawScore - rawRenderScore.rawScore,
          alignedScore: score.alignedScore - rawRenderScore.alignedScore,
          normalizedScore: score.normalizedScore - rawRenderScore.normalizedScore,
        }
      : null;

    return {
      elementName,
      drawingName,
      viewport,
      score,
      rawRenderScore,
      previewFallbackDelta,
      layerScores: Object.fromEntries(
        Object.entries(layerCanvases).map(([layerType, canvas]) => [
          layerType,
          bench.scoreCanvasSources(thumb, canvas, 160),
        ]),
      ),
      diagnostics: drawing.diagnostics,
      layers: drawing.layers.map((layer, li) => ({
        li,
        type: layer.type,
        shapes: layer.shapes.map((shape, si) => ({
          si,
          componentCount: shape.components.length,
          components: shape.components.map((comp, ci) => ({
            ci,
            componentType: comp.componentType,
            colorId: comp.colorId?.toString() ?? null,
            insideColorId: comp.insideColorId?.toString() ?? null,
            colorName: comp.colorName ?? null,
            paletteName: comp.paletteName ?? null,
            fillPaintSource: comp.fillPaintSource,
            color: comp.color,
            outerPaint: comp.outerPaint,
            insideColor: comp.insideColor,
            strokeWidth: comp.strokeWidth,
            tgtiThickness: comp.tgtiThickness,
            hasThicknessProfile: !!comp.thicknessProfile,
            pathSegments: comp.path?.segments.length ?? 0,
            closed: comp.path?.closed ?? false,
            firstSegment: comp.path?.segments[0] ?? null,
            lastSegment: comp.path?.segments[(comp.path?.segments.length ?? 1) - 1] ?? null,
          })),
        })),
      })),
    };
  }, { elementName, drawingName });

  if (summaryOnly) {
    console.log(JSON.stringify({
      elementName: result.elementName,
      drawingName: result.drawingName,
      viewport: result.viewport,
      score: result.score,
      rawRenderScore: result.rawRenderScore,
      previewFallbackDelta: result.previewFallbackDelta,
      layerScores: result.layerScores,
      diagnostics: result.diagnostics,
      layerShapeCounts: result.layers.map(layer => ({
        type: layer.type,
        shapeCount: layer.shapes.length,
        componentCounts: layer.shapes.map(shape => shape.componentCount),
      })),
    }, null, 2));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
} finally {
  await browser.close();
}
