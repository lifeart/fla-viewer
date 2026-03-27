import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const [elementName, drawingName, tileIndexArg, outDirArg] = args;
const tileIndex = Number(tileIndexArg);

if (!elementName || !drawingName || !Number.isFinite(tileIndex)) {
  console.error('Usage: node scripts/export-bitmap-tile.mjs <elementName> <drawingName> <tileIndex> [outDir]');
  process.exit(1);
}

const outDir = path.resolve(outDirArg ?? '/tmp/tvg-vision');
const browser = await puppeteer.launch({ headless: 'new' });

try {
  await fs.mkdir(outDir, { recursive: true });
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(0);
  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async ({ elementName, drawingName, tileIndex }) => {
    const JSZipMod = await import('/node_modules/.vite/deps/jszip.js');
    const tvg = await import('/src/tvg-parser.ts');
    const pal = await import('/src/tpl-palette.ts');

    const zip = await JSZipMod.default.loadAsync(
      await (await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip')).arrayBuffer(),
    );
    const externalColors = pal.flattenExternalPaletteColors(await pal.loadPalettes(zip));
    const base = `CH_Anna_rig_football_suit_V001_V07/elements/${elementName}`;
    const drawing = tvg.parseTVG(await zip.file(`${base}/${drawingName}.tvg`).async('arraybuffer'));
    tvg.resolveExternalPalette(drawing, externalColors);
    const tile = drawing.bitmapTiles[tileIndex];
    if (!tile) throw new Error(`Tile ${tileIndex} not found`);

    const loadTileImage = (data) => new Promise((resolve, reject) => {
      const ab = new ArrayBuffer(data.byteLength);
      new Uint8Array(ab).set(data);
      const blob = new Blob([ab], { type: 'image/png' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load PNG tile'));
      };
      img.src = url;
    });

    const img = await loadTileImage(tile.pngData);

    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = img.width;
    sourceCanvas.height = img.height;
    const sourceCtx = sourceCanvas.getContext('2d');
    sourceCtx.drawImage(img, 0, 0);
    const src = sourceCtx.getImageData(0, 0, img.width, img.height);

    const currentCanvas = document.createElement('canvas');
    currentCanvas.width = img.width;
    currentCanvas.height = img.height;
    const currentCtx = currentCanvas.getContext('2d');
    const dst = currentCtx.createImageData(img.width, img.height);
    for (let i = 0; i < src.data.length; i += 4) {
      const r = src.data[i + 0];
      const g = src.data[i + 1];
      const b = src.data[i + 2];
      const a = src.data[i + 3];
      dst.data[i + 0] = g;
      dst.data[i + 1] = r;
      dst.data[i + 2] = a;
      dst.data[i + 3] = b;
    }
    currentCtx.putImageData(dst, 0, 0);

    const statsFor = (canvas) => {
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let min = 255;
      let max = 0;
      let alphaMin = 255;
      let alphaMax = 0;
      for (let i = 0; i < data.length; i += 4) {
        min = Math.min(min, data[i + 0], data[i + 1], data[i + 2]);
        max = Math.max(max, data[i + 0], data[i + 1], data[i + 2]);
        alphaMin = Math.min(alphaMin, data[i + 3]);
        alphaMax = Math.max(alphaMax, data[i + 3]);
      }
      return { min, max, alphaMin, alphaMax };
    };

    return {
      tile: {
        clipX: tile.clipX,
        clipY: tile.clipY,
        clipW: tile.clipW,
        clipH: tile.clipH,
        bytes: tile.pngData.length,
      },
      source: sourceCanvas.toDataURL('image/png'),
      current: currentCanvas.toDataURL('image/png'),
      sourceStats: statsFor(sourceCanvas),
      currentStats: statsFor(currentCanvas),
    };
  }, { elementName, drawingName, tileIndex });

  const stem = `${elementName}__${drawingName}__tile-${tileIndex}`;
  await fs.writeFile(path.join(outDir, `${stem}__source.png`), Buffer.from(result.source.replace(/^data:image\/png;base64,/, ''), 'base64'));
  await fs.writeFile(path.join(outDir, `${stem}__current.png`), Buffer.from(result.current.replace(/^data:image\/png;base64,/, ''), 'base64'));
  await fs.writeFile(path.join(outDir, `${stem}__meta.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ outDir, stem, tile: result.tile, sourceStats: result.sourceStats, currentStats: result.currentStats }, null, 2));
} finally {
  await browser.close();
}
