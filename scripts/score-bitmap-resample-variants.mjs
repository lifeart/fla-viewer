import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const casesArg = args.find((arg) => !arg.startsWith('--'));

if (!casesArg) {
  console.error('Usage: node scripts/score-bitmap-resample-variants.mjs <element/drawing[,element/drawing...]> [--details]');
  process.exit(1);
}

const includeDetails = args.includes('--details');
const cases = casesArg.split(',').map((entry) => {
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

  const result = await page.evaluate(async ({ cases, includeDetails }) => {
    const JSZipMod = await import('/node_modules/.vite/deps/jszip.js');
    const tvg = await import('/src/tvg-parser.ts');
    const pal = await import('/src/tpl-palette.ts');
    const tpl = await import('/src/tpl-parser.ts');
    const bench = await import('/src/tvg-benchmark.ts');

    const SIZE = 160;
    const SNAPPED_BITMAP_GUTTER_CROP_INSET = 64;

    const zip = await JSZipMod.default.loadAsync(
      await (await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip')).arrayBuffer(),
    );
    const xstageXml = new DOMParser().parseFromString(
      await zip.file('CH_Anna_rig_football_suit_V001_V07/scene.xstage').async('text'),
      'text/xml',
    );
    const elements = tpl.parseElements(xstageXml);
    const externalColors = pal.flattenExternalPaletteColors(await pal.loadPalettes(zip));

    const loadImage = (bytes, mimeType = 'image/png') => new Promise((resolve, reject) => {
      const blob = new Blob([bytes], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = (event) => {
        URL.revokeObjectURL(url);
        reject(event);
      };
      image.src = url;
    });

    const coverageStats = (data) => {
      let opaquePixels = 0;
      let alphaSum = 0;
      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3];
        alphaSum += alpha;
        if (alpha >= 24) opaquePixels++;
      }
      const pixelCount = Math.max(1, data.length / 4);
      return {
        opaquePixels,
        meanAlpha: alphaSum / pixelCount,
      };
    };

    const remapBitmapTile = (img) => {
      const sourceCanvas = document.createElement('canvas');
      sourceCanvas.width = img.width;
      sourceCanvas.height = img.height;
      const sourceCtx = sourceCanvas.getContext('2d');
      sourceCtx.drawImage(img, 0, 0);
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
        dst.data[i + 0] = g;
        dst.data[i + 1] = r;
        dst.data[i + 2] = a;
        dst.data[i + 3] = b;
      }
      const sourceStats = coverageStats(src.data);
      const remappedStats = coverageStats(dst.data);
      const remapCollapsesAlpha = remappedStats.opaquePixels < sourceStats.opaquePixels * 0.75
        || remappedStats.meanAlpha < sourceStats.meanAlpha * 0.75;
      if (remapCollapsesAlpha) return sourceCanvas;
      tileCtx.putImageData(dst, 0, 0);
      return tileCanvas;
    };

    const computeBitmapBounds = (tiles) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const tile of tiles) {
        if (tile.clipW <= 0 || tile.clipH <= 0) continue;
        minX = Math.min(minX, tile.clipX);
        minY = Math.min(minY, tile.clipY);
        maxX = Math.max(maxX, tile.clipX + tile.clipW);
        maxY = Math.max(maxY, tile.clipY + tile.clipH);
      }
      if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return null;
      return { minX, minY, maxX, maxY };
    };

    const computeBitmapCellBounds = (tiles) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const tile of tiles) {
        if (tile.cellX === undefined || tile.cellY === undefined || tile.cellW === undefined || tile.cellH === undefined) {
          continue;
        }
        if (tile.cellW <= 0 || tile.cellH <= 0) continue;
        minX = Math.min(minX, tile.cellX);
        minY = Math.min(minY, tile.cellY);
        maxX = Math.max(maxX, tile.cellX + tile.cellW);
        maxY = Math.max(maxY, tile.cellY + tile.cellH);
      }
      if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return null;
      return { minX, minY, maxX, maxY };
    };

    const snapBitmapBoundsToTileGrid = (bounds, tileSize) => {
      if (tileSize <= 0) return bounds;
      return {
        minX: Math.floor(bounds.minX / tileSize) * tileSize,
        minY: Math.floor(bounds.minY / tileSize) * tileSize,
        maxX: Math.ceil(bounds.maxX / tileSize) * tileSize,
        maxY: Math.ceil(bounds.maxY / tileSize) * tileSize,
      };
    };

    const computeCanvasAlphaBounds = (canvas) => {
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          if (data[(y * canvas.width + x) * 4 + 3] <= 0) continue;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x + 1);
          maxY = Math.max(maxY, y + 1);
        }
      }
      if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return null;
      return { minX, minY, maxX, maxY };
    };

    const cropCanvasToBounds = (source, bounds) => {
      const cropW = Math.max(1, Math.round(bounds.maxX - bounds.minX));
      const cropH = Math.max(1, Math.round(bounds.maxY - bounds.minY));
      const canvas = document.createElement('canvas');
      canvas.width = cropW;
      canvas.height = cropH;
      canvas.getContext('2d').drawImage(
        source,
        Math.round(bounds.minX),
        Math.round(bounds.minY),
        cropW,
        cropH,
        0,
        0,
        cropW,
        cropH,
      );
      return canvas;
    };

    const bitmapFitPadding = (fallbackScanUsed, hasClipRects, loadedCount, aspectRatio) => {
      if (hasClipRects && loadedCount >= 8) {
        if (!fallbackScanUsed && aspectRatio < 1) return 8.5;
        if (fallbackScanUsed && loadedCount >= 32 && loadedCount < 128 && aspectRatio > 1.35) return 5.5;
        if (!fallbackScanUsed && loadedCount === 8 && aspectRatio >= 2) return 6.5;
        if (!fallbackScanUsed && loadedCount === 12 && aspectRatio >= 2.3) return 6.5;
        if (!fallbackScanUsed && aspectRatio > 1.35 && aspectRatio < 1.6) return 7.5;
        if (!fallbackScanUsed && aspectRatio > 1.25 && aspectRatio <= 1.35) return 7.5;
        return aspectRatio <= 1.35 ? 8 : 7;
      }
      if (!fallbackScanUsed) return 4;
      if (hasClipRects) return aspectRatio <= 1.35 ? 8 : 7;
      return 4;
    };

    const shouldTrimSparsePortraitFallbackAtlas = (fallbackScanUsed, hasClipRects, loadedCount, aspectRatio) => (
      fallbackScanUsed && hasClipRects && loadedCount < 32 && aspectRatio < 1
    );

    const downsampleOnce = (source, width, height, quality) => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width));
      canvas.height = Math.max(1, Math.round(height));
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = quality !== 'pixelated';
      if (quality !== 'pixelated') ctx.imageSmoothingQuality = quality;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(source, 0, 0, source.width, source.height, 0, 0, canvas.width, canvas.height);
      return canvas;
    };

    const drawWithResampleVariant = (ctx, source, dx, dy, dw, dh, variant) => {
      const targetW = Math.max(1, Math.round(dw));
      const targetH = Math.max(1, Math.round(dh));

      if (variant.mode === 'direct') {
        ctx.imageSmoothingEnabled = variant.quality !== 'pixelated';
        if (variant.quality !== 'pixelated') ctx.imageSmoothingQuality = variant.quality;
        ctx.drawImage(source, 0, 0, source.width, source.height, dx, dy, dw, dh);
        return;
      }

      if (variant.mode === 'two-step') {
        const mid = downsampleOnce(source, targetW * 2, targetH * 2, variant.quality);
        ctx.imageSmoothingEnabled = variant.quality !== 'pixelated';
        if (variant.quality !== 'pixelated') ctx.imageSmoothingQuality = variant.quality;
        ctx.drawImage(mid, 0, 0, mid.width, mid.height, dx, dy, dw, dh);
        return;
      }

      let current = source;
      while (current.width > targetW * 2 || current.height > targetH * 2) {
        const nextW = Math.max(targetW, Math.ceil(current.width / 2));
        const nextH = Math.max(targetH, Math.ceil(current.height / 2));
        current = downsampleOnce(current, nextW, nextH, variant.quality);
      }
      ctx.imageSmoothingEnabled = variant.quality !== 'pixelated';
      if (variant.quality !== 'pixelated') ctx.imageSmoothingQuality = variant.quality;
      ctx.drawImage(current, 0, 0, current.width, current.height, dx, dy, dw, dh);
    };

    const variants = [
      { name: 'current-progressive-high', mode: 'progressive', quality: 'high' },
      { name: 'progressive-medium', mode: 'progressive', quality: 'medium' },
      { name: 'progressive-low', mode: 'progressive', quality: 'low' },
      { name: 'direct-high', mode: 'direct', quality: 'high' },
      { name: 'direct-medium', mode: 'direct', quality: 'medium' },
      { name: 'direct-low', mode: 'direct', quality: 'low' },
      { name: 'two-step-high', mode: 'two-step', quality: 'high' },
      { name: 'two-step-medium', mode: 'two-step', quality: 'medium' },
      { name: 'pixelated', mode: 'direct', quality: 'pixelated' },
    ];

    const buildNativeBitmapCanvas = async (drawing, viewport) => {
      const stateCanvas = tvg.renderTVGToCanvas(drawing, SIZE, SIZE, viewport, { supersample: 2 });
      const state = stateCanvas.__bitmapState;
      const tiles = stateCanvas.__bitmapTiles;
      const bounds = state?.bounds ?? computeBitmapBounds(tiles) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
      const loaded = [];
      for (const tile of tiles) {
        loaded.push({ tile, img: remapBitmapTile(await loadImage(tile.pngData)) });
      }
      const hasClipRects = isFinite(bounds.minX) && isFinite(bounds.minY)
        && (bounds.maxX - bounds.minX) > 0
        && (bounds.maxY - bounds.minY) > 0;
      const largest = loaded.reduce((a, b) => (a.img.width * a.img.height > b.img.width * b.img.height ? a : b));
      const nativeBounds = hasClipRects
        ? bounds
        : { minX: 0, minY: 0, maxX: largest.img.width, maxY: largest.img.height };
      const fallbackScanUsed = (drawing.diagnostics?.counts?.BITMAP_FALLBACK_SCAN_USED ?? 0) > 0;
      const cellBounds = computeBitmapCellBounds(tiles);
      const shouldUseTileCellBounds = hasClipRects && loaded.length >= 32 && cellBounds !== null;
      const shouldSnapFallbackAtlasBounds = fallbackScanUsed && hasClipRects && loaded.length >= 32 && !shouldUseTileCellBounds;
      const fittedBounds = shouldUseTileCellBounds
        ? cellBounds
        : shouldSnapFallbackAtlasBounds
          ? snapBitmapBoundsToTileGrid(nativeBounds, 256)
          : nativeBounds;

      const nativeW = Math.max(1, Math.round(fittedBounds.maxX - fittedBounds.minX));
      const nativeH = Math.max(1, Math.round(fittedBounds.maxY - fittedBounds.minY));
      const nativeCanvas = document.createElement('canvas');
      nativeCanvas.width = nativeW;
      nativeCanvas.height = nativeH;
      const nativeCtx = nativeCanvas.getContext('2d');

      if (hasClipRects) {
        for (const { tile, img } of loaded) {
          nativeCtx.drawImage(
            img,
            Math.round(tile.clipX - fittedBounds.minX),
            Math.round(tile.clipY - fittedBounds.minY),
            Math.round(tile.clipW),
            Math.round(tile.clipH),
          );
        }
      } else {
        nativeCtx.drawImage(largest.img, 0, 0);
      }

      let renderCanvas = nativeCanvas;
      let renderBounds = fittedBounds;
      if ((fallbackScanUsed || shouldUseTileCellBounds) && hasClipRects) {
        const visibleBounds = computeCanvasAlphaBounds(nativeCanvas);
        if (visibleBounds) {
          const leftInset = visibleBounds.minX;
          const topInset = visibleBounds.minY;
          const rightInset = nativeCanvas.width - visibleBounds.maxX;
          const bottomInset = nativeCanvas.height - visibleBounds.maxY;
          const shouldCropVisibleBounds = Math.max(leftInset, topInset, rightInset, bottomInset) >= SNAPPED_BITMAP_GUTTER_CROP_INSET;
          if (shouldCropVisibleBounds) {
            renderCanvas = cropCanvasToBounds(nativeCanvas, visibleBounds);
            renderBounds = {
              minX: fittedBounds.minX + visibleBounds.minX,
              minY: fittedBounds.minY + visibleBounds.minY,
              maxX: fittedBounds.minX + visibleBounds.maxX,
              maxY: fittedBounds.minY + visibleBounds.maxY,
            };
          }
        }
      }

      const renderW = Math.max(1, Math.round(renderBounds.maxX - renderBounds.minX));
      const renderH = Math.max(1, Math.round(renderBounds.maxY - renderBounds.minY));
      const aspectRatio = renderW / Math.max(renderH, 1);
      const meta = {
        fallbackScanUsed,
        hasClipRects,
        loadedCount: loaded.length,
        aspectRatio,
        renderW,
        renderH,
      };
      const padding = bitmapFitPadding(fallbackScanUsed, hasClipRects, loaded.length, aspectRatio);
      const availW = SIZE - padding * 2;
      const availH = SIZE - padding * 2;
      const scale = Math.min(availW / renderW, availH / renderH);
      let dx = padding + (availW - renderW * scale) / 2;
      let dy = padding + (availH - renderH * scale) / 2;
      let targetH = renderH * scale;
      if (shouldTrimSparsePortraitFallbackAtlas(fallbackScanUsed, hasClipRects, loaded.length, aspectRatio)) {
        dy += 1;
        targetH = Math.max(1, targetH - 2);
      }
      return { renderCanvas, dx, dy, targetW: renderW * scale, targetH, meta: { ...meta, padding } };
    };

    const analyzeCase = async ({ elementName, drawingName }) => {
      const element = elements.find((entry) => entry.name === elementName);
      const viewport = ((element?.fieldChart ?? 12) * tpl.TVG_UNITS_PER_FIELD) || 336;
      const base = `CH_Anna_rig_football_suit_V001_V07/elements/${elementName}`;
      const drawing = tvg.parseTVG(await zip.file(`${base}/${drawingName}.tvg`).async('arraybuffer'));
      tvg.resolveExternalPalette(drawing, externalColors);
      const thumbnail = await loadImage(await zip.file(`${base}/.thumbnails/.${drawingName}.tvg.png`).async('arraybuffer'));
      const native = await buildNativeBitmapCanvas(drawing, viewport);

      const scores = [];
      for (const variant of variants) {
        const canvas = document.createElement('canvas');
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, SIZE, SIZE);
        drawWithResampleVariant(ctx, native.renderCanvas, native.dx, native.dy, native.targetW, native.targetH, variant);
        const score = bench.scoreCanvasSources(thumbnail, canvas, SIZE, { contentKind: 'bitmap' });
        scores.push({
          variant: variant.name,
          score: Number(score.score.toFixed(4)),
          gate: Number(score.gateScore.toFixed(4)),
          raw: Number(score.rawScore.toFixed(4)),
          aligned: Number(score.alignedScore.toFixed(4)),
          focused: Number(score.normalizedScore.toFixed(4)),
          iou: Number(score.foregroundIou.toFixed(4)),
          bestShift: score.bestShift,
          referenceBounds: score.referenceBounds,
          candidateBounds: score.candidateBounds,
          ...(includeDetails ? { meta: { ...native.meta, dx: native.dx, dy: native.dy, targetW: native.targetW, targetH: native.targetH } } : {}),
        });
      }
      scores.sort((a, b) => b.raw - a.raw || b.aligned - a.aligned || b.iou - a.iou);
      return {
        case: `${elementName}/${drawingName}`,
        scores,
      };
    };

    const results = [];
    for (const testCase of cases) {
      results.push(await analyzeCase(testCase));
    }
    return results;
  }, { cases, includeDetails });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
