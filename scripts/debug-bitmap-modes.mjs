import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const [elementName, drawingName] = args;

if (!elementName || !drawingName) {
  console.error('Usage: node scripts/debug-bitmap-modes.mjs <elementName> <drawingName>');
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

    const unpremultiplyCanvas = (canvas) => {
      const ctx = canvas.getContext('2d');
      const src = ctx.getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < src.data.length; i += 4) {
        const a = src.data[i + 3];
        if (a > 0 && a < 255) {
          src.data[i + 0] = Math.min(255, Math.round(src.data[i + 0] * 255 / a));
          src.data[i + 1] = Math.min(255, Math.round(src.data[i + 1] * 255 / a));
          src.data[i + 2] = Math.min(255, Math.round(src.data[i + 2] * 255 / a));
        }
      }
      ctx.putImageData(src, 0, 0);
      return canvas;
    };

    const mapTile = (img, mode) => {
      const sourceCanvas = document.createElement('canvas');
      sourceCanvas.width = img.width;
      sourceCanvas.height = img.height;
      const sourceCtx = sourceCanvas.getContext('2d');
      sourceCtx.drawImage(img, 0, 0);
      if (mode === 'source') return sourceCanvas;
      if (mode === 'sourceUnpremul') return unpremultiplyCanvas(sourceCanvas);

      const src = sourceCtx.getImageData(0, 0, img.width, img.height);
      const tileCanvas = document.createElement('canvas');
      tileCanvas.width = img.width;
      tileCanvas.height = img.height;
      const tileCtx = tileCanvas.getContext('2d');
      const dst = tileCtx.createImageData(img.width, img.height);

      for (let i = 0; i < src.data.length; i += 4) {
        const r = src.data[i + 0];
        const g = src.data[i + 1];
        const b = src.data[i + 2];
        const a = src.data[i + 3];
        if (mode === 'current' || mode === 'currentUnpremul') {
          dst.data[i + 0] = g;
          dst.data[i + 1] = r;
          dst.data[i + 2] = a;
          dst.data[i + 3] = b;
        } else if (mode === 'rbSwap') {
          dst.data[i + 0] = b;
          dst.data[i + 1] = g;
          dst.data[i + 2] = r;
          dst.data[i + 3] = a;
        } else if (mode === 'abgrToRgba') {
          dst.data[i + 0] = a;
          dst.data[i + 1] = b;
          dst.data[i + 2] = g;
          dst.data[i + 3] = r;
        } else if (mode === 'argbToRgba') {
          dst.data[i + 0] = g;
          dst.data[i + 1] = b;
          dst.data[i + 2] = a;
          dst.data[i + 3] = r;
        }
      }

      tileCtx.putImageData(dst, 0, 0);
      if (mode.endsWith('Unpremul')) {
        return unpremultiplyCanvas(tileCanvas);
      }
      return tileCanvas;
    };

    const renderWithMode = async (mode) => {
      const canvas = tvg.renderTVGToCanvas(drawing, 160, 160, viewport, { supersample: 2 });
      const state = canvas.__bitmapState;
      const bounds = state.bounds;
      const ctx = canvas.getContext('2d');
      const width = canvas.width;
      const height = canvas.height;

      const loaded = [];
      for (const tile of drawing.bitmapTiles) {
        const img = await loadTileImage(tile.pngData);
        loaded.push({ tile, img: mapTile(img, mode) });
      }

      const nativeW = Math.max(1, Math.round(bounds.maxX - bounds.minX));
      const nativeH = Math.max(1, Math.round(bounds.maxY - bounds.minY));
      const nativeCanvas = document.createElement('canvas');
      nativeCanvas.width = nativeW;
      nativeCanvas.height = nativeH;
      const nativeCtx = nativeCanvas.getContext('2d');

      for (const { tile, img } of loaded) {
        nativeCtx.drawImage(
          img,
          Math.round(tile.clipX - bounds.minX),
          Math.round(tile.clipY - bounds.minY),
          Math.round(tile.clipW),
          Math.round(tile.clipH),
        );
      }

      const contentExtent = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
      const scale = Math.min(width, height) / Math.max(viewport, contentExtent, 1);
      const centerX = (bounds.minX + bounds.maxX) / 2;
      const centerY = (bounds.minY + bounds.maxY) / 2;
      const dx = width / 2 - (centerX - bounds.minX) * scale;
      const dy = height / 2 - (bounds.maxY - centerY) * scale;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(nativeCanvas, dx, dy, nativeW * scale, nativeH * scale);

      return bench.scoreCanvasSources(thumb, canvas, 160);
    };

    const modes = [
      'source',
      'sourceUnpremul',
      'current',
      'currentUnpremul',
      'rbSwap',
      'abgrToRgba',
      'argbToRgba',
    ];
    const scores = {};
    for (const mode of modes) {
      scores[mode] = await renderWithMode(mode);
    }
    return { viewport, tileCount: drawing.bitmapTiles.length, scores };
  }, { elementName, drawingName });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
