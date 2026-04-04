import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const [elementName, drawingName, layerType = 'line', limitArg] = args;

if (!elementName || !drawingName) {
  console.error('Usage: node scripts/rank-tvg-shapes-by-recovery.mjs <elementName> <drawingName> [layerType] [limit]');
  process.exit(1);
}

const limit = Number.parseInt(limitArg ?? '20', 10);
const browser = await puppeteer.launch({ headless: 'new' });

try {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(0);
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async ({ elementName, drawingName, layerType, limit }) => {
    const JSZipMod = await import('/node_modules/.vite/deps/jszip.js');
    const tvg = await import('/src/tvg-parser.ts');
    const pal = await import('/src/tpl-palette.ts');
    const tpl = await import('/src/tpl-parser.ts');
    const bench = await import('/src/tvg-benchmark.ts');

    const isForeground = (data, index) => (
      Math.abs(data[index + 0] - 255) > 12
      || Math.abs(data[index + 1] - 255) > 12
      || Math.abs(data[index + 2] - 255) > 12
      || data[index + 3] < 243
    );

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
    const refCanvas = document.createElement('canvas');
    refCanvas.width = 160;
    refCanvas.height = 160;
    const refCtx = refCanvas.getContext('2d');
    refCtx.fillStyle = '#fff';
    refCtx.fillRect(0, 0, 160, 160);
    refCtx.drawImage(thumb, 0, 0, 160, 160);
    const refData = refCtx.getImageData(0, 0, 160, 160).data;

    const fullCanvas = tvg.renderTVGToCanvas(drawing, 160, 160, viewport, { supersample: 2 });
    if (fullCanvas) await tvg.loadBitmapTiles(fullCanvas, drawing.diagnostics);
    const fullData = fullCanvas.getContext('2d').getImageData(0, 0, 160, 160).data;
    const score = bench.scoreCanvasSources(thumb, fullCanvas, 160);

    const shiftedData = new Uint8ClampedArray(fullData.length);
    shiftedData.fill(255);
    for (let i = 3; i < shiftedData.length; i += 4) shiftedData[i] = 255;
    for (let y = 0; y < 160; y++) {
      for (let x = 0; x < 160; x++) {
        const sx = x - score.bestShift.x;
        const sy = y - score.bestShift.y;
        const dstIndex = (y * 160 + x) * 4;
        if (sx < 0 || sx >= 160 || sy < 0 || sy >= 160) continue;
        const srcIndex = (sy * 160 + sx) * 4;
        shiftedData[dstIndex + 0] = fullData[srcIndex + 0];
        shiftedData[dstIndex + 1] = fullData[srcIndex + 1];
        shiftedData[dstIndex + 2] = fullData[srcIndex + 2];
        shiftedData[dstIndex + 3] = fullData[srcIndex + 3];
      }
    }

    const layer = drawing.layers.find(entry => entry.type === layerType);
    if (!layer) return { viewport, score, shapes: [] };

    const rows = [];
    for (let index = 0; index < layer.shapes.length; index++) {
      const single = {
        ...drawing,
        layers: drawing.layers.map(entry =>
          entry === layer ? { ...entry, shapes: [layer.shapes[index]] } : { ...entry, shapes: [] },
        ),
      };
      const canvas = tvg.renderTVGToCanvas(single, 160, 160, viewport, { supersample: 2 });
      if (!canvas) continue;
      await tvg.loadBitmapTiles(canvas, single.diagnostics);
      const data = canvas.getContext('2d').getImageData(0, 0, 160, 160).data;
      let area = 0;
      let recoverableOverlap = 0;
      let usefulMatch = 0;
      let candidateOnly = 0;
      for (let y = 0; y < 160; y++) {
        for (let x = 0; x < 160; x++) {
          const idx = (y * 160 + x) * 4;
          if (!isForeground(data, idx)) continue;
          area++;
          const refFg = isForeground(refData, idx);
          const candFg = isForeground(shiftedData, idx);
          if (refFg && !candFg) {
            recoverableOverlap++;
          } else if (refFg && candFg) {
            usefulMatch++;
          } else if (!refFg) {
            candidateOnly++;
          }
        }
      }
      if (area === 0) continue;
      rows.push({
        index,
        area,
        recoverableOverlap,
        usefulMatch,
        candidateOnly,
        recoverableRatio: recoverableOverlap / area,
        componentCount: layer.shapes[index].components.length,
      });
    }

    rows.sort((a, b) => b.recoverableOverlap - a.recoverableOverlap || b.recoverableRatio - a.recoverableRatio || a.candidateOnly - b.candidateOnly);
    return { viewport, score, shapes: rows.slice(0, limit) };
  }, { elementName, drawingName, layerType, limit });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
