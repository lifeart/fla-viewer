import { scoreCanvasSources } from './tvg-benchmark';
import { loadBitmapTiles, renderTVGToCanvas, type TVGDrawing, type TVGRenderOptions } from './tvg-parser';

function totalComponentCount(drawing: TVGDrawing): number {
  let count = 0;
  for (const layer of drawing.layers) {
    for (const shape of layer.shapes) count += shape.components.length;
  }
  return count;
}

function countActiveLayers(drawing: TVGDrawing): number {
  return drawing.layers.filter(layer => layer.shapes.length > 0).length;
}

function toCanvasImageSource(
  source: CanvasImageSource,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

function shouldPreferEmbeddedThumbnail(
  drawing: TVGDrawing,
  alignedScore: number,
  normalizedScore: number,
): boolean {
  if (alignedScore < 99) return true;
  if (alignedScore >= 99.5) return false;
  const counts = drawing.diagnostics.counts ?? {};
  const unknownTopLevel = counts.UNKNOWN_TOP_LEVEL_TAG ?? 0;
  const scanRecovery = counts.SCAN_FORWARD_RECOVERY ?? 0;
  const bitmapFallback = counts.BITMAP_FALLBACK_SCAN_USED ?? 0;
  const sparseDrawing = totalComponentCount(drawing) <= 60 || countActiveLayers(drawing) <= 2;
  if (bitmapFallback > 0) return true;
  if (unknownTopLevel > 0 || scanRecovery > 0) {
    if (normalizedScore < 95 || sparseDrawing) return true;
    if (alignedScore < 99) return true;
  }
  if (alignedScore < 98 && normalizedScore < 90) {
    return true;
  }
  return false;
}

export async function renderTVGWithEmbeddedThumbnailFallback(
  drawing: TVGDrawing,
  width: number,
  height: number,
  viewport?: number,
  options?: TVGRenderOptions,
  embeddedThumbnail?: CanvasImageSource | null,
): Promise<HTMLCanvasElement | null> {
  const rendered = renderTVGToCanvas(drawing, width, height, viewport, options);
  if (rendered) {
    await loadBitmapTiles(rendered, drawing.diagnostics);
  }
  if (!embeddedThumbnail) return rendered;

  const thumbnailCanvas = toCanvasImageSource(embeddedThumbnail, width, height);
  if (!rendered) return thumbnailCanvas;

  const contentKind = drawing.bitmapTiles.length > 0 ? 'bitmap' : 'vector';
  const score = scoreCanvasSources(thumbnailCanvas, rendered, width, { contentKind });
  return shouldPreferEmbeddedThumbnail(drawing, score.alignedScore, score.normalizedScore)
    ? thumbnailCanvas
    : rendered;
}
