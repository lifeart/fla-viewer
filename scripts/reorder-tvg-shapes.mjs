import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const [elementName, drawingName, layerType, movesArg] = args;

if (!elementName || !drawingName || !layerType || !movesArg) {
  console.error('Usage: node scripts/reorder-tvg-shapes.mjs <elementName> <drawingName> <layerType> <from:to,from:to,...>');
  process.exit(1);
}

const moves = movesArg
  .split(',')
  .map(entry => entry.trim())
  .filter(Boolean)
  .map(entry => {
    const [fromText, toText] = entry.split(':');
    const from = Number.parseInt(fromText, 10);
    const to = Number.parseInt(toText, 10);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new Error(`Invalid move "${entry}"`);
    }
    return { from, to };
  });

const browser = await puppeteer.launch({ headless: 'new' });

try {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(0);
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async ({
    elementName,
    drawingName,
    layerType,
    moves,
  }) => {
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

    async function renderAndScore(sourceDrawing) {
      const canvas = tvg.renderTVGToCanvas(sourceDrawing, 160, 160, viewport, { supersample: 2 });
      if (canvas) {
        await tvg.loadBitmapTiles(canvas, sourceDrawing.diagnostics);
      }
      return bench.scoreCanvasSources(thumb, canvas, 160);
    }

    const baseScore = await renderAndScore(drawing);
    const moved = {
      ...drawing,
      layers: drawing.layers.map(layer => {
        if (layer.type !== layerType) return { ...layer };
        const shapes = [...layer.shapes];
        for (const move of moves) {
          if (move.from < 0 || move.from >= shapes.length) continue;
          const [picked] = shapes.splice(move.from, 1);
          if (!picked) continue;
          const insertAt = Math.max(0, Math.min(move.to, shapes.length));
          shapes.splice(insertAt, 0, picked);
        }
        return { ...layer, shapes };
      }),
    };
    const movedScore = await renderAndScore(moved);

    return {
      viewport,
      moves,
      baseScore,
      movedScore,
      delta: {
        score: movedScore.score - baseScore.score,
        rawScore: movedScore.rawScore - baseScore.rawScore,
        alignedScore: movedScore.alignedScore - baseScore.alignedScore,
        normalizedScore: movedScore.normalizedScore - baseScore.normalizedScore,
      },
    };
  }, { elementName, drawingName, layerType, moves });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
