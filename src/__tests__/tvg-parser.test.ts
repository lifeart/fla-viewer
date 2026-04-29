import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { flattenExternalPaletteColors, loadPalettes, parsePLT } from '../tpl-palette';
import { scoreCanvasSources } from '../tvg-benchmark';
import type { TVGArtLayer, TVGComponent, TVGDrawing, TVGPath } from '../tvg-parser';
import {
  __borrowMissingPencilPathsForTests,
  __decodeTipTypeForTests,
  __debugBuildContoursForShape,
  __debugBuildLegacyChainsForShape,
  __debugLineFillDecisions,
  __debugLineFillRenderStrategy,
  __debugTraceLegacyChainSelectionsForShape,
  __computeTextLabelRenderLayoutForTests,
  __repairForwardPencilPathRefsForTests,
  __shouldInsetViewportForColorGuideGridDrawingForTests,
  __shouldInsetViewportForLineFillDrawingForTests,
  loadBitmapTiles,
  parseTVG,
  renderTVGToCanvas,
  resolveExternalPalette,
} from '../tvg-parser';

function createPath(segments: TVGPath['segments'], closed = false): TVGPath {
  return {
    segments,
    closed,
    tgrvValue: null,
    directionReversed: null,
  };
}

function createComponent(overrides: Partial<TVGComponent>): TVGComponent {
  return {
    componentType: 0,
    colorId: null,
    contourColorId: null,
    insideColorId: null,
    paletteIndex: null,
    color: null,
    contourColor: null,
    fillPaintSource: null,
    insideColor: null,
    transform: null,
    contourTransform: null,
    path: null,
    strokeWidth: null,
    thicknessProfile: null,
    joinType: 'round',
    fromTipType: 'round',
    toTipType: 'round',
    gradientType: undefined,
    gradientStops: undefined,
    contourGradientType: undefined,
    contourGradientStops: undefined,
    tgtiThickness: null,
    tgtiTextureScaleX: null,
    tgtiTextureScaleY: null,
    tgtiTextureOffset: null,
    tgtiOpacityThickness: null,
    tgtiOpacityScaleX: null,
    tgtiOpacityScaleY: null,
    tgtiOpacityOffset: null,
    tgtiHasTextureFlags: null,
    pathRefHint: null,
    outerPaint: null,
    contourPaint: null,
    innerPaint: null,
    ...overrides,
  };
}

function createDrawing(layers: TVGArtLayer[], palette: TVGDrawing['palette'] = []): TVGDrawing {
  return {
    layers,
    palette,
    bitmapTiles: [],
    diagnostics: { events: [], counts: {} },
  };
}

function samplePixel(canvas: HTMLCanvasElement, x: number, y: number) {
  const ctx = canvas.getContext('2d')!;
  const data = ctx.getImageData(x, y, 1, 1).data;
  return { r: data[0], g: data[1], b: data[2], a: data[3] };
}

function countNonWhitePixels(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')!;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) continue;
    count++;
  }
  return count;
}

function countNonWhitePixelsInRect(canvas: HTMLCanvasElement, x: number, y: number, width: number, height: number) {
  const ctx = canvas.getContext('2d')!;
  const data = ctx.getImageData(x, y, width, height).data;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) continue;
    count++;
  }
  return count;
}

function expectColorNear(
  actual: ReturnType<typeof samplePixel>,
  expected: { r: number; g: number; b: number },
  tolerance = 35,
) {
  expect(Math.abs(actual.r - expected.r)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.g - expected.g)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.b - expected.b)).toBeLessThanOrEqual(tolerance);
}

function ascii(text: string): number[] {
  return Array.from(text).map((char) => char.charCodeAt(0));
}

async function loadImageFromArrayBuffer(data: ArrayBuffer): Promise<HTMLImageElement> {
  const blob = new Blob([data], { type: 'image/png' });
  return await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(image.src);
      resolve(image);
    };
    image.onerror = reject;
    image.src = URL.createObjectURL(blob);
  });
}

function canvasToPngBytes(canvas: HTMLCanvasElement): Uint8Array {
  const dataUrl = canvas.toDataURL('image/png');
  const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const decoded = atob(encoded);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

function innerTag(tag: string, payload: number[] | Uint8Array): number[] {
  const bytes = Array.from(payload);
  if (bytes.length <= 0xff) {
    return [...ascii(tag), 0x01, bytes.length, ...bytes];
  }
  if (bytes.length <= 0xffff) {
    return [...ascii(tag), 0x02, bytes.length & 0xff, (bytes.length >> 8) & 0xff, ...bytes];
  }
  return [
    ...ascii(tag),
    0x07,
    bytes.length & 0xff,
    (bytes.length >> 8) & 0xff,
    (bytes.length >> 16) & 0xff,
    ...bytes,
  ];
}

describe('tpl-palette', () => {
  it('parses solids and multiline gradients', () => {
    const palette = parsePLT(
      [
        'PaletteFile 1',
        'Solid Skin 0x1 255 200 150 255',
        'Gradient Glow 0x2 Linear',
        '{',
        '  0 10 20 30 255,',
        '  50 40 50 60 255,',
        '  100 70 80 90 255',
        '}',
      ].join('\n'),
      'palette-library/test.plt',
    );

    expect(palette).not.toBeNull();
    expect(palette?.colors).toHaveLength(2);
    expect(palette?.colors[0]).toMatchObject({
      type: 'solid',
      name: 'Skin',
      id: '0x1',
      r: 255,
      g: 200,
      b: 150,
      a: 255,
    });
    expect(palette?.colors[1]).toMatchObject({
      type: 'gradient',
      name: 'Glow',
      id: '0x2',
      gradientType: 'linear',
    });
    expect(palette?.colors[1].stops).toHaveLength(3);
  });

  it('parses quoted palette names with spaces', () => {
    const palette = parsePLT(
      [
        'ToonBoomAnimationInc PaletteFile 2',
        'Solid "New 0" 0xabc 255 33 74 255',
        'Gradient "Soft Glow" 0xdef Radial',
        '{',
        '  0 10 20 30 255,',
        '  100 40 50 60 255',
        '}',
      ].join('\n'),
      'palette-library/quoted.plt',
    );

    expect(palette).not.toBeNull();
    expect(palette?.colors).toHaveLength(2);
    expect(palette?.colors[0]).toMatchObject({
      type: 'solid',
      name: 'New 0',
      id: '0xabc',
      r: 255,
      g: 33,
      b: 74,
      a: 255,
    });
    expect(palette?.colors[1]).toMatchObject({
      type: 'gradient',
      name: 'Soft Glow',
      id: '0xdef',
      gradientType: 'radial',
    });
  });

  it('rejects non-palette input', () => {
    expect(parsePLT('not a palette', 'palette-library/bad.plt')).toBeNull();
  });
});

describe('tvg rendering', () => {
  it('decodes tGTB cap enum values using Harmony tip semantics', () => {
    expect(__decodeTipTypeForTests(0)).toBe('butt');
    expect(__decodeTipTypeForTests(1)).toBe('round');
    expect(__decodeTipTypeForTests(2)).toBe('square');
  });

  it('uses support-only fill fragments to complete an explicitly styled contour', () => {
    const drawing = createDrawing([{
      type: 'line',
      shapes: [{
        shapeType: 2,
        components: [
          createComponent({
            componentType: 0,
            colorId: 1n,
            color: { r: 40, g: 160, b: 90, a: 255 },
            fillPaintSource: 'explicit',
            outerPaint: { kind: 'solid', rgba: { r: 40, g: 160, b: 90, a: 255 } },
            path: createPath([
              { type: 'M', x: -20, y: -20 },
              { type: 'L', x: 20, y: -20 },
            ]),
          }),
          createComponent({
            componentType: 0,
            paletteIndex: 0,
            path: createPath([
              { type: 'M', x: 20, y: -20 },
              { type: 'L', x: 20, y: 20 },
            ]),
          }),
          createComponent({
            componentType: 0,
            paletteIndex: 0,
            path: createPath([
              { type: 'M', x: 20, y: 20 },
              { type: 'L', x: -20, y: 20 },
            ]),
          }),
          createComponent({
            componentType: 0,
            paletteIndex: 0,
            path: createPath([
              { type: 'M', x: -20, y: 20 },
              { type: 'L', x: -20, y: -20 },
            ]),
          }),
        ],
      }],
    }]);

    const canvas = renderTVGToCanvas(drawing, 100, 100, 80);
    expect(canvas).not.toBeNull();
    const pixel = samplePixel(canvas!, 50, 50);
    expectColorNear(pixel, { r: 40, g: 160, b: 90 }, 50);
  });

  it('crops transparent fallback-atlas gutters before fitting bitmap tiles', async () => {
    const tileCanvas = document.createElement('canvas');
    tileCanvas.width = 240;
    tileCanvas.height = 160;
    const tileCtx = tileCanvas.getContext('2d')!;
    tileCtx.clearRect(0, 0, 240, 160);
    tileCtx.fillStyle = '#ff5533';
    tileCtx.fillRect(80, 40, 80, 80);

    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 100;
    (canvas as any).__bitmapTiles = [{
      clipX: 0,
      clipY: 0,
      clipW: 240,
      clipH: 160,
      pngData: canvasToPngBytes(tileCanvas),
    }];
    (canvas as any).__bitmapState = {
      bounds: { minX: 0, minY: 0, maxX: 240, maxY: 160 },
      viewport: 0,
      centerOnOrigin: false,
      diagnostics: { events: [], counts: { BITMAP_FALLBACK_SCAN_USED: 1 } },
    };

    const loaded = await loadBitmapTiles(canvas, (canvas as any).__bitmapState.diagnostics);
    expect(loaded).toBe(true);
    expectColorNear(samplePixel(canvas, 10, 50), { r: 255, g: 85, b: 51 }, 30);
    expectColorNear(samplePixel(canvas, 90, 50), { r: 255, g: 85, b: 51 }, 30);
  });

  it('applies framing padding for clipped bitmap atlases without fallback scan', async () => {
    const tileCanvas = document.createElement('canvas');
    tileCanvas.width = 60;
    tileCanvas.height = 40;
    const tileCtx = tileCanvas.getContext('2d')!;
    tileCtx.fillStyle = '#33bb66';
    tileCtx.fillRect(0, 0, 60, 40);

    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 100;
    (canvas as any).__bitmapTiles = Array.from({ length: 16 }, (_, index) => ({
      clipX: (index % 4) * 60,
      clipY: Math.floor(index / 4) * 40,
      clipW: 60,
      clipH: 40,
      pngData: canvasToPngBytes(tileCanvas),
    }));
    (canvas as any).__bitmapState = {
      bounds: { minX: 0, minY: 0, maxX: 240, maxY: 160 },
      viewport: 0,
      centerOnOrigin: false,
      backgroundComposite: false,
      diagnostics: { events: [], counts: {} },
    };

    const loaded = await loadBitmapTiles(canvas, (canvas as any).__bitmapState.diagnostics);
    expect(loaded).toBe(true);
    expect(samplePixel(canvas, 3, 50).a).toBeLessThanOrEqual(5);
    expect(samplePixel(canvas, 50, 10).a).toBeLessThanOrEqual(5);
    expectColorNear(samplePixel(canvas, 10, 50), { r: 51, g: 187, b: 102 }, 20);
    expectColorNear(samplePixel(canvas, 50, 30), { r: 51, g: 187, b: 102 }, 20);
  });

  it('uses a tighter fit for dense portrait clipped bitmap atlases', async () => {
    const tileCanvas = document.createElement('canvas');
    tileCanvas.width = 10;
    tileCanvas.height = 20;
    const tileCtx = tileCanvas.getContext('2d')!;
    tileCtx.fillStyle = '#33bb66';
    tileCtx.fillRect(0, 0, 10, 20);

    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 100;
    (canvas as any).__bitmapTiles = Array.from({ length: 256 }, (_, index) => ({
      clipX: (index % 16) * 10,
      clipY: Math.floor(index / 16) * 20,
      clipW: 10,
      clipH: 20,
      pngData: canvasToPngBytes(tileCanvas),
    }));
    (canvas as any).__bitmapState = {
      bounds: { minX: 0, minY: 0, maxX: 160, maxY: 320 },
      viewport: 0,
      centerOnOrigin: false,
      backgroundComposite: false,
      diagnostics: { events: [], counts: {} },
    };

    const loaded = await loadBitmapTiles(canvas, (canvas as any).__bitmapState.diagnostics);
    expect(loaded).toBe(true);
    expect(samplePixel(canvas, 50, 8).a).toBeLessThanOrEqual(5);
    expect(samplePixel(canvas, 50, 9).a).toBeGreaterThan(50);
  });

  it('uses the portrait fit for non-dense clipped bitmap atlases', async () => {
    const tileCanvas = document.createElement('canvas');
    tileCanvas.width = 10;
    tileCanvas.height = 20;
    const tileCtx = tileCanvas.getContext('2d')!;
    tileCtx.fillStyle = '#33bb66';
    tileCtx.fillRect(0, 0, 10, 20);

    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 100;
    (canvas as any).__bitmapTiles = Array.from({ length: 24 }, (_, index) => ({
      clipX: (index % 4) * 10,
      clipY: Math.floor(index / 4) * 20,
      clipW: 10,
      clipH: 20,
      pngData: canvasToPngBytes(tileCanvas),
    }));
    (canvas as any).__bitmapState = {
      bounds: { minX: 0, minY: 0, maxX: 40, maxY: 120 },
      viewport: 0,
      centerOnOrigin: false,
      backgroundComposite: false,
      diagnostics: { events: [], counts: {} },
    };

    const loaded = await loadBitmapTiles(canvas, (canvas as any).__bitmapState.diagnostics);
    expect(loaded).toBe(true);
    expect(samplePixel(canvas, 50, 8).a).toBeLessThanOrEqual(5);
    expect(samplePixel(canvas, 50, 9).a).toBeGreaterThan(50);
  });

  it('uses a tighter fit for medium fallback-scanned landscape bitmap atlases', async () => {
    const tileCanvas = document.createElement('canvas');
    tileCanvas.width = 15;
    tileCanvas.height = 20;
    const tileCtx = tileCanvas.getContext('2d')!;
    tileCtx.fillStyle = '#33bb66';
    tileCtx.fillRect(0, 0, 15, 20);

    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 100;
    (canvas as any).__bitmapTiles = Array.from({ length: 98 }, (_, index) => {
      const col = index % 14;
      const row = Math.floor(index / 14);
      return {
        clipX: col * 15,
        clipY: row * 20,
        clipW: 15,
        clipH: 20,
        cellX: col * 15,
        cellY: row * 20,
        cellW: 15,
        cellH: 20,
        pngData: canvasToPngBytes(tileCanvas),
      };
    });
    (canvas as any).__bitmapState = {
      bounds: { minX: 0, minY: 0, maxX: 210, maxY: 140 },
      viewport: 0,
      centerOnOrigin: false,
      backgroundComposite: false,
      diagnostics: { events: [], counts: { BITMAP_FALLBACK_SCAN_USED: 1 } },
    };

    const loaded = await loadBitmapTiles(canvas, (canvas as any).__bitmapState.diagnostics);
    expect(loaded).toBe(true);
    expect(samplePixel(canvas, 5, 50).a).toBeLessThanOrEqual(5);
    expect(samplePixel(canvas, 6, 50).a).toBeGreaterThan(50);
  });

  it('parses top-level TBBM bitmap tiles with TBBH metadata', async () => {
    const tileCanvas = document.createElement('canvas');
    tileCanvas.width = 8;
    tileCanvas.height = 8;
    const tileCtx = tileCanvas.getContext('2d')!;
    tileCtx.fillStyle = '#ff3300';
    tileCtx.fillRect(0, 0, 8, 8);

    const tbbh = innerTag('TBBH', [
      ...innerTag('TBBD', u32le(32)),
      ...innerTag('TBBC', [...u32le(-16), ...u32le(-8), ...u32le(32), ...u32le(16)]),
      ...innerTag('TBBA', [...u32le(-12), ...u32le(-4), ...u32le(8), ...u32le(8)]),
    ]);
    const tbbm = innerTag('TBBM', [0x01, ...tbbh, ...canvasToPngBytes(tileCanvas)]);
    const bytes = Uint8Array.from([
      ...ascii('OTVGfull'),
      ...u32le(1009),
      ...u32le(2),
      ...u32le(1),
      ...tbbm,
    ]);

    const drawing = parseTVG(bytes.buffer);
    expect(drawing.bitmapTiles).toHaveLength(1);
    expect(drawing.bitmapTiles[0]).toMatchObject({
      clipX: -12,
      clipY: -4,
      clipW: 8,
      clipH: 8,
      cellX: -16,
      cellY: -8,
      cellW: 32,
      cellH: 16,
      bitmapDepth: 32,
    });
    expect(drawing.diagnostics.counts.UNKNOWN_TOP_LEVEL_TAG).toBeUndefined();
    expect(drawing.diagnostics.counts.BITMAP_FALLBACK_SCAN_USED).toBeUndefined();

    const canvas = renderTVGToCanvas(drawing, 32, 32);
    expect(canvas).not.toBeNull();
    await loadBitmapTiles(canvas!);
    expect(samplePixel(canvas!, 0, 0)).toEqual({ r: 255, g: 255, b: 255, a: 255 });

    const transparentCanvas = renderTVGToCanvas(drawing, 32, 32, undefined, { skipBackgroundComposite: true });
    expect(transparentCanvas).not.toBeNull();
    await loadBitmapTiles(transparentCanvas!);
    expect(samplePixel(transparentCanvas!, 0, 0).a).toBe(0);
  });

  it('renders explicit type-1 fill carriers like regular fills', () => {
    const type1Paint = { kind: 'solid' as const, rgba: { r: 246, g: 215, b: 58, a: 255 } };
    const drawing = createDrawing([{
      type: 'line',
      shapes: [{
        shapeType: 2,
        components: [
          createComponent({
            componentType: 1,
            color: { ...type1Paint.rgba },
            fillPaintSource: 'explicit',
            outerPaint: type1Paint,
            path: createPath([
              { type: 'M', x: -20, y: -20 },
              { type: 'L', x: 20, y: -20 },
            ]),
          }),
          createComponent({
            componentType: 1,
            color: { ...type1Paint.rgba },
            fillPaintSource: 'explicit',
            outerPaint: type1Paint,
            path: createPath([
              { type: 'M', x: 20, y: -20 },
              { type: 'L', x: 20, y: 20 },
            ]),
          }),
          createComponent({
            componentType: 1,
            color: { ...type1Paint.rgba },
            fillPaintSource: 'explicit',
            outerPaint: type1Paint,
            path: createPath([
              { type: 'M', x: 20, y: 20 },
              { type: 'L', x: -20, y: 20 },
            ]),
          }),
          createComponent({
            componentType: 1,
            color: { ...type1Paint.rgba },
            fillPaintSource: 'explicit',
            outerPaint: type1Paint,
            path: createPath([
              { type: 'M', x: -20, y: 20 },
              { type: 'L', x: -20, y: -20 },
            ]),
          }),
        ],
      }],
    }]);

    const canvas = renderTVGToCanvas(drawing, 100, 100, 80);
    expect(canvas).not.toBeNull();
    const pixel = samplePixel(canvas!, 50, 50);
    expectColorNear(pixel, type1Paint.rgba, 50);
  });

  it('keeps same-style nested contours as holes instead of repainting them', () => {
    const ringPaint = { kind: 'solid' as const, rgba: { r: 22, g: 198, b: 133, a: 255 } };
    const drawing = createDrawing([{
      type: 'line',
      shapes: [{
        shapeType: 2,
        components: [
          createComponent({
            componentType: 0,
            colorId: 1n,
            color: { ...ringPaint.rgba },
            fillPaintSource: 'explicit',
            outerPaint: ringPaint,
            path: createPath([
              { type: 'M', x: -30, y: -30 },
              { type: 'L', x: 30, y: -30 },
              { type: 'L', x: 30, y: 30 },
              { type: 'L', x: -30, y: 30 },
              { type: 'L', x: -30, y: -30 },
            ]),
          }),
          createComponent({
            componentType: 0,
            colorId: 1n,
            color: { ...ringPaint.rgba },
            fillPaintSource: 'explicit',
            outerPaint: ringPaint,
            path: createPath([
              { type: 'M', x: -12, y: -12 },
              { type: 'L', x: -12, y: 12 },
              { type: 'L', x: 12, y: 12 },
              { type: 'L', x: 12, y: -12 },
              { type: 'L', x: -12, y: -12 },
            ]),
          }),
        ],
      }],
    }]);

    const contourDebug = __debugBuildContoursForShape(drawing.layers[0].shapes[0], 'line', 0);
    expect(contourDebug.contours).toHaveLength(2);
    expect(contourDebug.contours.some(contour => contour.childCount === 1)).toBe(true);

    const canvas = renderTVGToCanvas(drawing, 100, 100, 80);
    expect(canvas).not.toBeNull();
    expect(countNonWhitePixels(canvas!)).toBeGreaterThan(200);
    expect(samplePixel(canvas!, 50, 50)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
  });

  it('keeps tiny same-style nested details filled inside large line carriers', () => {
    const fillPaint = { kind: 'solid' as const, rgba: { r: 22, g: 198, b: 133, a: 255 } };
    const points: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= 5; i++) points.push({ x: -40 + i * 16, y: -40 });
    for (let i = 1; i <= 5; i++) points.push({ x: 40, y: -40 + i * 16 });
    for (let i = 1; i <= 5; i++) points.push({ x: 40 - i * 16, y: 40 });
    for (let i = 1; i <= 5; i++) points.push({ x: -40, y: 40 - i * 16 });

    const components = points.slice(0, -1).map((point, index) => createComponent({
      componentType: 0,
      colorId: 1n,
      color: { ...fillPaint.rgba },
      fillPaintSource: 'explicit',
      outerPaint: fillPaint,
      path: createPath([
        { type: 'M', x: point.x, y: point.y },
        { type: 'L', x: points[index + 1].x, y: points[index + 1].y },
      ]),
    }));
    components.push(createComponent({
      componentType: 0,
      colorId: 1n,
      color: { ...fillPaint.rgba },
      fillPaintSource: 'explicit',
      outerPaint: fillPaint,
      path: createPath([
        { type: 'M', x: -5, y: -5 },
        { type: 'L', x: -5, y: 5 },
        { type: 'L', x: 5, y: 5 },
        { type: 'L', x: 5, y: -5 },
        { type: 'L', x: -5, y: -5 },
      ]),
    }));

    const drawing = createDrawing([{
      type: 'line',
      shapes: [{
        shapeType: 2,
        components,
      }],
    }]);

    const contourDebug = __debugBuildContoursForShape(drawing.layers[0].shapes[0], 'line', 0);
    expect(contourDebug.contours).toHaveLength(2);
    expect(contourDebug.contours.some(contour => contour.childCount === 1)).toBe(true);

    const canvas = renderTVGToCanvas(drawing, 100, 100, 100);
    expect(canvas).not.toBeNull();
    expectColorNear(samplePixel(canvas!, 50, 50), fillPaint.rgba, 50);
  });

  it('does not suppress resolved near-black line fills that overlap colored siblings', () => {
    const greenPaint = { kind: 'solid' as const, rgba: { r: 40, g: 180, b: 110, a: 255 } };
    const blackPaint = { kind: 'solid' as const, rgba: { r: 8, g: 8, b: 8, a: 255 } };
    const rectEdges = (half: number, paint: typeof greenPaint | typeof blackPaint) => ([
      createComponent({
        componentType: 0,
        color: { ...paint.rgba },
        fillPaintSource: 'explicit',
        outerPaint: paint,
        path: createPath([
          { type: 'M', x: -half, y: -half },
          { type: 'L', x: half, y: -half },
        ]),
      }),
      createComponent({
        componentType: 0,
        color: { ...paint.rgba },
        fillPaintSource: 'explicit',
        outerPaint: paint,
        path: createPath([
          { type: 'M', x: half, y: -half },
          { type: 'L', x: half, y: half },
        ]),
      }),
      createComponent({
        componentType: 0,
        color: { ...paint.rgba },
        fillPaintSource: 'explicit',
        outerPaint: paint,
        path: createPath([
          { type: 'M', x: half, y: half },
          { type: 'L', x: -half, y: half },
        ]),
      }),
      createComponent({
        componentType: 0,
        color: { ...paint.rgba },
        fillPaintSource: 'explicit',
        outerPaint: paint,
        path: createPath([
          { type: 'M', x: -half, y: half },
          { type: 'L', x: -half, y: -half },
        ]),
      }),
    ]);

    const drawing = createDrawing([{
      type: 'line',
      shapes: [
        { shapeType: 2, components: rectEdges(180, greenPaint) },
        { shapeType: 2, components: rectEdges(130, blackPaint) },
      ],
    }]);

    const canvas = renderTVGToCanvas(drawing, 120, 120, 400);
    expect(canvas).not.toBeNull();
    const pixel = samplePixel(canvas!, 60, 60);
    expectColorNear(pixel, blackPaint.rgba, 20);
  });

  it('keeps open single-pencil color shapes as strokes instead of contour fills', () => {
    const orangePaint = { kind: 'solid' as const, rgba: { r: 255, g: 180, b: 63, a: 255 } };
    const drawing = createDrawing([{
      type: 'color',
      shapes: [{
        shapeType: 2,
        components: [
          createComponent({
            componentType: 4,
            color: { ...orangePaint.rgba },
            contourColor: { ...orangePaint.rgba },
            outerPaint: orangePaint,
            contourPaint: orangePaint,
            strokeWidth: 4,
            path: createPath([
              { type: 'M', x: -20, y: -20 },
              { type: 'L', x: 20, y: -20 },
              { type: 'L', x: 20, y: 20 },
              { type: 'L', x: -20, y: 20 },
            ]),
          }),
        ],
      }],
    }]);

    const canvas = renderTVGToCanvas(drawing, 120, 120, 120);
    expect(canvas).not.toBeNull();
    expect(samplePixel(canvas!, 60, 60)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
    expect(countNonWhitePixels(canvas!)).toBeGreaterThan(0);
  });

  it('renders inherited-only fill shapes through the legacy fallback', () => {
    const inheritedPaint = { kind: 'solid' as const, rgba: { r: 32, g: 188, b: 126, a: 255 } };
    const drawing = createDrawing([{
      type: 'line',
      shapes: [{
        shapeType: 2,
        components: [
          createComponent({
            componentType: 0,
            color: { ...inheritedPaint.rgba },
            fillPaintSource: 'inherited',
            outerPaint: inheritedPaint,
            path: createPath([
              { type: 'M', x: -20, y: -20 },
              { type: 'L', x: 20, y: -20 },
            ]),
          }),
          createComponent({
            componentType: 0,
            color: { ...inheritedPaint.rgba },
            fillPaintSource: 'inherited',
            outerPaint: inheritedPaint,
            path: createPath([
              { type: 'M', x: 20, y: -20 },
              { type: 'L', x: 20, y: 20 },
            ]),
          }),
          createComponent({
            componentType: 0,
            color: { ...inheritedPaint.rgba },
            fillPaintSource: 'inherited',
            outerPaint: inheritedPaint,
            path: createPath([
              { type: 'M', x: 20, y: 20 },
              { type: 'L', x: -20, y: 20 },
            ]),
          }),
          createComponent({
            componentType: 0,
            color: { ...inheritedPaint.rgba },
            fillPaintSource: 'inherited',
            outerPaint: inheritedPaint,
            path: createPath([
              { type: 'M', x: -20, y: 20 },
              { type: 'L', x: -20, y: -20 },
            ]),
          }),
        ],
      }],
    }]);

    const canvas = renderTVGToCanvas(drawing, 100, 100, 80);
    expect(canvas).not.toBeNull();
    const pixel = samplePixel(canvas!, 50, 50);
    expectColorNear(pixel, inheritedPaint.rgba, 50);
  });

  it('keeps same-style nested legacy chains as holes instead of repainting them', () => {
    const inheritedPaint = { kind: 'solid' as const, rgba: { r: 32, g: 188, b: 126, a: 255 } };
    const drawing = createDrawing([{
      type: 'line',
      shapes: [{
        shapeType: 2,
        components: [
          createComponent({
            componentType: 0,
            color: { ...inheritedPaint.rgba },
            fillPaintSource: 'inherited',
            outerPaint: inheritedPaint,
            path: createPath([
              { type: 'M', x: -30, y: -30 },
              { type: 'L', x: 30, y: -30 },
              { type: 'L', x: 30, y: 30 },
              { type: 'L', x: -30, y: 30 },
              { type: 'L', x: -30, y: -30 },
            ]),
          }),
          createComponent({
            componentType: 0,
            color: { ...inheritedPaint.rgba },
            fillPaintSource: 'inherited',
            outerPaint: inheritedPaint,
            path: createPath([
              { type: 'M', x: -12, y: -12 },
              { type: 'L', x: -12, y: 12 },
              { type: 'L', x: 12, y: 12 },
              { type: 'L', x: 12, y: -12 },
              { type: 'L', x: -12, y: -12 },
            ]),
          }),
        ],
      }],
    }]);

    const legacy = __debugBuildLegacyChainsForShape(drawing.layers[0].shapes[0]);
    expect(legacy.groups).toHaveLength(1);
    expect(legacy.groups[0].drawableChains).toHaveLength(2);
    expect(legacy.groups[0].drawableChains[0].parent).toBe(-1);
    expect(legacy.groups[0].drawableChains[1].parent).toBe(0);

    const canvas = renderTVGToCanvas(drawing, 100, 100, 80);
    expect(canvas).not.toBeNull();
    expect(countNonWhitePixels(canvas!)).toBeGreaterThan(200);
    expect(samplePixel(canvas!, 50, 50)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
  });

  it('renders default-only fill shapes through the legacy fallback', () => {
    const defaultPaint = { kind: 'solid' as const, rgba: { r: 15, g: 46, b: 48, a: 255 } };
    const drawing = createDrawing([{
      type: 'line',
      shapes: [{
        shapeType: 2,
        components: [
          createComponent({
            componentType: 0,
            color: { ...defaultPaint.rgba },
            fillPaintSource: 'default',
            outerPaint: defaultPaint,
            path: createPath([
              { type: 'M', x: -20, y: -20 },
              { type: 'L', x: 20, y: -20 },
            ]),
          }),
          createComponent({
            componentType: 0,
            color: { ...defaultPaint.rgba },
            fillPaintSource: 'default',
            outerPaint: defaultPaint,
            path: createPath([
              { type: 'M', x: 20, y: -20 },
              { type: 'L', x: 20, y: 20 },
            ]),
          }),
          createComponent({
            componentType: 0,
            color: { ...defaultPaint.rgba },
            fillPaintSource: 'default',
            outerPaint: defaultPaint,
            path: createPath([
              { type: 'M', x: 20, y: 20 },
              { type: 'L', x: -20, y: 20 },
            ]),
          }),
          createComponent({
            componentType: 0,
            color: { ...defaultPaint.rgba },
            fillPaintSource: 'default',
            outerPaint: defaultPaint,
            path: createPath([
              { type: 'M', x: -20, y: 20 },
              { type: 'L', x: -20, y: -20 },
            ]),
          }),
        ],
      }],
    }]);

    const canvas = renderTVGToCanvas(drawing, 100, 100, 80);
    expect(canvas).not.toBeNull();
    const pixel = samplePixel(canvas!, 50, 50);
    expectColorNear(pixel, defaultPaint.rgba, 50);
  });

  it('does not let the legacy fallback share inherited support across paint groups', () => {
    const greenPaint = { kind: 'solid' as const, rgba: { r: 22, g: 198, b: 133, a: 255 } };
    const darkPaint = { kind: 'solid' as const, rgba: { r: 15, g: 46, b: 48, a: 255 } };
    const drawing = createDrawing([{
      type: 'line',
      shapes: [{
        shapeType: 2,
        components: [
          createComponent({
            componentType: 0,
            color: { ...greenPaint.rgba },
            fillPaintSource: 'explicit',
            outerPaint: greenPaint,
            path: createPath([
              { type: 'M', x: -5, y: -5 },
              { type: 'L', x: 5, y: -5 },
            ]),
          }),
          createComponent({
            componentType: 0,
            color: { ...darkPaint.rgba },
            fillPaintSource: 'explicit',
            outerPaint: darkPaint,
            path: createPath([
              { type: 'M', x: -20, y: -20 },
              { type: 'L', x: -20, y: 20 },
            ]),
          }),
          createComponent({
            componentType: 0,
            color: { ...greenPaint.rgba },
            fillPaintSource: 'inherited',
            outerPaint: greenPaint,
            path: createPath([
              { type: 'M', x: -20, y: -20 },
              { type: 'L', x: 20, y: -20 },
            ]),
          }),
          createComponent({
            componentType: 0,
            color: { ...greenPaint.rgba },
            fillPaintSource: 'inherited',
            outerPaint: greenPaint,
            path: createPath([
              { type: 'M', x: 20, y: -20 },
              { type: 'L', x: 20, y: 20 },
            ]),
          }),
          createComponent({
            componentType: 0,
            color: { ...greenPaint.rgba },
            fillPaintSource: 'inherited',
            outerPaint: greenPaint,
            path: createPath([
              { type: 'M', x: 20, y: 20 },
              { type: 'L', x: -20, y: 20 },
            ]),
          }),
          createComponent({
            componentType: 0,
            color: { ...greenPaint.rgba },
            fillPaintSource: 'inherited',
            outerPaint: greenPaint,
            path: createPath([
              { type: 'M', x: -20, y: 20 },
              { type: 'L', x: -20, y: -20 },
            ]),
          }),
        ],
      }],
    }]);

    const canvas = renderTVGToCanvas(drawing, 100, 100, 80);
    expect(canvas).not.toBeNull();
    const center = samplePixel(canvas!, 50, 50);
    expectColorNear(center, greenPaint.rgba, 50);
  });

  it('keeps one dominant near-closed legacy carrier when closed islands also exist', () => {
    const greenPaint = { kind: 'solid' as const, rgba: { r: 22, g: 198, b: 133, a: 255 } };
    const drawing = createDrawing([{
      type: 'line',
      shapes: [{
        shapeType: 2,
        components: [
          createComponent({
            componentType: 0,
            color: { ...greenPaint.rgba },
            fillPaintSource: 'explicit',
            outerPaint: greenPaint,
            path: createPath([
              { type: 'M', x: -40, y: -40 },
              { type: 'L', x: 0, y: -40 },
            ]),
          }),
          createComponent({
            componentType: 0,
            color: { ...greenPaint.rgba },
            fillPaintSource: 'inherited',
            outerPaint: greenPaint,
            path: createPath([
              { type: 'M', x: 0, y: -40 },
              { type: 'L', x: 40, y: -40 },
            ]),
          }),
          createComponent({
            componentType: 0,
            color: { ...greenPaint.rgba },
            fillPaintSource: 'inherited',
            outerPaint: greenPaint,
            path: createPath([
              { type: 'M', x: 40, y: -40 },
              { type: 'L', x: 40, y: 0 },
            ]),
          }),
          createComponent({
            componentType: 0,
            color: { ...greenPaint.rgba },
            fillPaintSource: 'inherited',
            outerPaint: greenPaint,
            path: createPath([
              { type: 'M', x: 40, y: 0 },
              { type: 'L', x: 40, y: 40 },
            ]),
          }),
          createComponent({
            componentType: 0,
            color: { ...greenPaint.rgba },
            fillPaintSource: 'inherited',
            outerPaint: greenPaint,
            path: createPath([
              { type: 'M', x: 40, y: 40 },
              { type: 'L', x: 0, y: 40 },
            ]),
          }),
          createComponent({
            componentType: 0,
            color: { ...greenPaint.rgba },
            fillPaintSource: 'inherited',
            outerPaint: greenPaint,
            path: createPath([
              { type: 'M', x: 0, y: 40 },
              { type: 'L', x: -40, y: 40 },
            ]),
          }),
          createComponent({
            componentType: 0,
            color: { ...greenPaint.rgba },
            fillPaintSource: 'inherited',
            outerPaint: greenPaint,
            path: createPath([
              { type: 'M', x: -40, y: 40 },
              { type: 'L', x: -40, y: 0 },
            ]),
          }),
          createComponent({
            componentType: 0,
            color: { ...greenPaint.rgba },
            fillPaintSource: 'inherited',
            outerPaint: greenPaint,
            path: createPath([
              { type: 'M', x: -40, y: 0 },
              { type: 'L', x: -40, y: -36 },
            ]),
          }),
          createComponent({
            componentType: 0,
            color: { ...greenPaint.rgba },
            fillPaintSource: 'inherited',
            outerPaint: greenPaint,
            path: createPath([
              { type: 'M', x: 18, y: 18 },
              { type: 'L', x: 28, y: 18 },
              { type: 'L', x: 28, y: 28 },
              { type: 'L', x: 18, y: 28 },
              { type: 'L', x: 18, y: 18 },
            ], true),
          }),
        ],
      }],
    }]);

    const canvas = renderTVGToCanvas(drawing, 120, 120, 120);
    expect(canvas).not.toBeNull();
    expectColorNear(samplePixel(canvas!, 60, 60), greenPaint.rgba, 50);
  });

  it('renders small pure-open line-layer carriers through the legacy fallback', () => {
    const blackPaint = { kind: 'solid' as const, rgba: { r: 0, g: 0, b: 0, a: 255 } };
    const drawing = createDrawing([{
      type: 'line',
      shapes: [{
        shapeType: 2,
        components: [
          createComponent({
            componentType: 0,
            color: { ...blackPaint.rgba },
            fillPaintSource: 'explicit',
            outerPaint: blackPaint,
            path: createPath([
              { type: 'M', x: -30, y: -30 },
              { type: 'L', x: 30, y: -30 },
            ]),
          }),
          createComponent({
            componentType: 0,
            color: { ...blackPaint.rgba },
            fillPaintSource: 'inherited',
            outerPaint: blackPaint,
            path: createPath([
              { type: 'M', x: 30, y: -30 },
              { type: 'L', x: 36, y: 24 },
            ]),
          }),
          createComponent({
            componentType: 0,
            color: { ...blackPaint.rgba },
            fillPaintSource: 'inherited',
            outerPaint: blackPaint,
            path: createPath([
              { type: 'M', x: 36, y: 24 },
              { type: 'L', x: -22, y: 32 },
            ]),
          }),
          createComponent({
            componentType: 0,
            color: { ...blackPaint.rgba },
            fillPaintSource: 'inherited',
            outerPaint: blackPaint,
            path: createPath([
              { type: 'M', x: -22, y: 32 },
              { type: 'L', x: -30, y: -12 },
            ]),
          }),
        ],
      }],
    }]);

    const canvas = renderTVGToCanvas(drawing, 120, 120, 120);
    expect(canvas).not.toBeNull();
    expect(countNonWhitePixelsInRect(canvas!, 38, 38, 44, 44)).toBeGreaterThan(150);
  });

  it('prefers the legacy fallback for dominant unresolved line-layer carriers mixed with resolved contours', () => {
    const darkPaint = { kind: 'solid' as const, rgba: { r: 15, g: 46, b: 48, a: 255 } };
    const bigOpenPoints: Array<[number, number]> = [];
    for (let x = -40; x <= 40; x += 8) bigOpenPoints.push([x, -40]);
    for (let y = -32; y <= 40; y += 8) bigOpenPoints.push([40, y]);
    for (let x = 32; x >= -40; x -= 8) bigOpenPoints.push([x, 40]);
    for (let y = 32; y >= -16; y -= 8) bigOpenPoints.push([-40, y]);
    bigOpenPoints.push([-40, -12]);
    const components = bigOpenPoints.slice(0, -1).map(([x1, y1], index) => {
      const [x2, y2] = bigOpenPoints[index + 1];
      return createComponent({
        componentType: 0,
        color: { ...darkPaint.rgba },
        fillPaintSource: index === 0 ? 'explicit' : 'inherited',
        outerPaint: darkPaint,
        path: createPath([
          { type: 'M', x: x1, y: y1 },
          { type: 'L', x: x2, y: y2 },
        ]),
      });
    });
    const resolvedContourPoints = [
      [18, -8],
      [28, -8],
      [28, 2],
      [18, 2],
      [18, -8],
    ] as const;
    for (let index = 0; index < resolvedContourPoints.length - 1; index++) {
      const [x1, y1] = resolvedContourPoints[index];
      const [x2, y2] = resolvedContourPoints[index + 1];
      components.push(createComponent({
        componentType: 0,
        color: { ...darkPaint.rgba },
        fillPaintSource: 'inherited',
        outerPaint: darkPaint,
        path: createPath([
          { type: 'M', x: x1, y: y1 },
          { type: 'L', x: x2, y: y2 },
        ], true),
      }));
    }

    const drawing = createDrawing([{
      type: 'line',
      shapes: [{
        shapeType: 2,
        components,
      }],
    }]);

    const canvas = renderTVGToCanvas(drawing, 120, 120, 120);
    expect(canvas).not.toBeNull();
    expect(countNonWhitePixelsInRect(canvas!, 45, 45, 30, 30)).toBeGreaterThan(300);
  });

  it('prefers smoother legacy chain continuation over source-order ties', () => {
    const darkPaint = { kind: 'solid' as const, rgba: { r: 15, g: 46, b: 48, a: 255 } };
    const shape = {
      shapeType: 2,
      components: [
        createComponent({
          componentType: 0,
          color: { ...darkPaint.rgba },
          fillPaintSource: 'explicit',
          outerPaint: darkPaint,
          path: createPath([
            { type: 'M', x: 0, y: 0 },
            { type: 'L', x: 10, y: 0 },
          ]),
        }),
        createComponent({
          componentType: 0,
          color: { ...darkPaint.rgba },
          fillPaintSource: 'inherited',
          outerPaint: darkPaint,
          path: createPath([
            { type: 'M', x: 10, y: 0 },
            { type: 'L', x: 10, y: 10 },
          ]),
        }),
        createComponent({
          componentType: 0,
          color: { ...darkPaint.rgba },
          fillPaintSource: 'inherited',
          outerPaint: darkPaint,
          path: createPath([
            { type: 'M', x: 10, y: 0 },
            { type: 'L', x: 20, y: 0 },
          ]),
        }),
        createComponent({
          componentType: 0,
          color: { ...darkPaint.rgba },
          fillPaintSource: 'inherited',
          outerPaint: darkPaint,
          path: createPath([
            { type: 'M', x: 20, y: 0 },
            { type: 'L', x: 20, y: 10 },
          ]),
        }),
        createComponent({
          componentType: 0,
          color: { ...darkPaint.rgba },
          fillPaintSource: 'inherited',
          outerPaint: darkPaint,
          path: createPath([
            { type: 'M', x: 20, y: 10 },
            { type: 'L', x: 0, y: 10 },
          ]),
        }),
        createComponent({
          componentType: 0,
          color: { ...darkPaint.rgba },
          fillPaintSource: 'inherited',
          outerPaint: darkPaint,
          path: createPath([
            { type: 'M', x: 0, y: 10 },
            { type: 'L', x: 0, y: 0 },
          ]),
        }),
      ],
    };

    const debug = __debugBuildLegacyChainsForShape(shape);
    const group = debug.groups.find(entry => entry.key.includes('solid:15,46,48,255'));
    expect(group).toBeTruthy();
    expect(group!.chains[0].componentIndexes.slice(0, 5)).toEqual([0, 2, 3, 4, 5]);

    const trace = __debugTraceLegacyChainSelectionsForShape(shape);
    const traceGroup = trace.groups.find(entry => entry.key.includes('solid:15,46,48,255'));
    expect(traceGroup).toBeTruthy();
    expect(traceGroup!.picks[0].selectedComponentIndex).toBe(2);
    expect(traceGroup!.picks[0].candidates.some(candidate =>
      candidate.componentIndex === 1 && candidate.decision === 'considered',
    )).toBe(true);
  });

  it('does not inset simple closed line-fill drawings', () => {
    const orangePaint = { kind: 'solid' as const, rgba: { r: 255, g: 180, b: 63, a: 255 } };
    const drawing = createDrawing([{
      type: 'line',
      shapes: [{
        shapeType: 2,
        components: [
          createComponent({
            componentType: 0,
            color: { ...orangePaint.rgba },
            fillPaintSource: 'explicit',
            outerPaint: orangePaint,
            path: createPath([
              { type: 'M', x: -16, y: -16 },
              { type: 'L', x: 16, y: -16 },
              { type: 'L', x: 16, y: 16 },
              { type: 'L', x: -16, y: 16 },
              { type: 'L', x: -16, y: -16 },
            ], true),
          }),
          createComponent({
            componentType: 0,
            color: { ...orangePaint.rgba },
            fillPaintSource: 'inherited',
            outerPaint: orangePaint,
            path: createPath([
              { type: 'M', x: -8, y: -8 },
              { type: 'L', x: 8, y: -8 },
              { type: 'L', x: 8, y: 8 },
              { type: 'L', x: -8, y: 8 },
              { type: 'L', x: -8, y: -8 },
            ], true),
          }),
        ],
      }],
    }]);

    expect(__shouldInsetViewportForLineFillDrawingForTests(drawing)).toBe(false);
  });

  it('insets complex inherited unresolved line-fill carriers', () => {
    const darkPaint = { kind: 'solid' as const, rgba: { r: 15, g: 46, b: 48, a: 255 } };
    const bigOpenPoints: Array<[number, number]> = [];
    for (let x = -40; x <= 40; x += 8) bigOpenPoints.push([x, -40]);
    for (let y = -32; y <= 40; y += 8) bigOpenPoints.push([40, y]);
    for (let x = 32; x >= -40; x -= 8) bigOpenPoints.push([x, 40]);
    for (let y = 32; y >= -16; y -= 8) bigOpenPoints.push([-40, y]);
    bigOpenPoints.push([-40, -12]);

    const drawing = createDrawing([{
      type: 'line',
      shapes: [{
        shapeType: 2,
        components: bigOpenPoints.slice(0, -1).map(([x1, y1], index) => {
          const [x2, y2] = bigOpenPoints[index + 1];
          return createComponent({
            componentType: 0,
            color: { ...darkPaint.rgba },
            fillPaintSource: index === 0 ? 'explicit' : 'inherited',
            outerPaint: darkPaint,
            path: createPath([
              { type: 'M', x: x1, y: y1 },
              { type: 'L', x: x2, y: y2 },
            ]),
          });
        }),
      }],
    }]);

    expect(__shouldInsetViewportForLineFillDrawingForTests(drawing)).toBe(true);
  });

  it('insets dense color-art guide grids with panel labels', () => {
    const guidePaint = { kind: 'solid' as const, rgba: { r: 255, g: 180, b: 63, a: 255 } };
    const panelPaint = { kind: 'solid' as const, rgba: { r: 240, g: 210, b: 130, a: 255 } };
    const shapes: TVGArtLayer['shapes'] = [];

    for (let index = 0; index < 16; index++) {
      const x = index * 40;
      shapes.push({
        shapeType: 6,
        components: [createComponent({
          componentType: 4,
          color: { ...guidePaint.rgba },
          outerPaint: guidePaint,
          strokeWidth: 5,
          tgtiThickness: 0.015,
          path: createPath([
            { type: 'M', x, y: -200 },
            { type: 'L', x, y: 300 },
          ]),
        })],
      });
    }
    for (let index = 0; index < 2; index++) {
      const x = index * 520;
      shapes.push({
        shapeType: 4,
        components: [createComponent({
          componentType: 0,
          color: { ...panelPaint.rgba },
          fillPaintSource: 'explicit',
          outerPaint: panelPaint,
          path: createPath([
            { type: 'M', x, y: 0 },
            { type: 'L', x: x + 480, y: 0 },
            { type: 'L', x: x + 480, y: 220 },
            { type: 'L', x, y: 220 },
            { type: 'L', x, y: 0 },
          ], true),
        })],
      });
    }

    const drawing = createDrawing([{
      type: 'color',
      shapes,
      textLabels: [],
    }, {
      type: 'line',
      shapes: [],
      textLabels: [
        { text: 'A', fontFamily: 'Arial', fontSize: 16, x: 0, y: 0, scaleX: 1, scaleY: 1 },
        { text: 'B', fontFamily: 'Arial', fontSize: 16, x: 0, y: 0, scaleX: 1, scaleY: 1 },
        { text: 'C', fontFamily: 'Arial', fontSize: 16, x: 0, y: 0, scaleX: 1, scaleY: 1 },
        { text: 'D', fontFamily: 'Arial', fontSize: 16, x: 0, y: 0, scaleX: 1, scaleY: 1 },
      ],
    }]);

    expect(__shouldInsetViewportForColorGuideGridDrawingForTests(drawing)).toBe(true);
  });

  it('treats non-target inherited legacy fills as support-only geometry in mixed groups', () => {
    const greenPaint = { kind: 'solid' as const, rgba: { r: 22, g: 198, b: 133, a: 255 } };
    const darkPaint = { kind: 'solid' as const, rgba: { r: 15, g: 46, b: 48, a: 255 } };
    const shape = {
      shapeType: 2,
      components: [
        createComponent({
          componentType: 0,
          color: { ...greenPaint.rgba },
          fillPaintSource: 'explicit',
          outerPaint: greenPaint,
          path: createPath([
            { type: 'M', x: 0, y: 0 },
            { type: 'L', x: 10, y: 0 },
          ]),
        }),
        createComponent({
          componentType: 0,
          color: { ...greenPaint.rgba },
          fillPaintSource: 'inherited',
          outerPaint: greenPaint,
          path: createPath([
            { type: 'M', x: 10, y: 0 },
            { type: 'L', x: 10, y: 10 },
          ]),
        }),
        createComponent({
          componentType: 0,
          color: { ...darkPaint.rgba },
          fillPaintSource: 'explicit',
          outerPaint: darkPaint,
          path: createPath([
            { type: 'M', x: 10, y: 10 },
            { type: 'L', x: 0, y: 10 },
          ]),
        }),
        createComponent({
          componentType: 0,
          color: { ...darkPaint.rgba },
          fillPaintSource: 'inherited',
          outerPaint: darkPaint,
          path: createPath([
            { type: 'M', x: 0, y: 10 },
            { type: 'L', x: 0, y: 0 },
          ]),
        }),
      ],
    };

    const plain = __debugBuildLegacyChainsForShape(shape);
    expect(plain.allChainComponents.filter(comp => comp.componentIndex === -1)).toHaveLength(0);

    const supportAware = __debugBuildLegacyChainsForShape(shape, [], { supportInheritedCrossPaint: true });
    expect(supportAware.allChainComponents.filter(comp => comp.componentIndex === -1 && !comp.hasPaint)).toHaveLength(2);
    expect(supportAware.groups).toHaveLength(2);
    for (const group of supportAware.groups) {
      expect(group.componentIndexes.filter(index => index === -1)).toHaveLength(1);
    }
  });

  it('does not share null-painted fill carriers across filtered legacy color groups', () => {
    const greenPaint = { kind: 'solid' as const, rgba: { r: 22, g: 198, b: 133, a: 255 } };
    const darkPaint = { kind: 'solid' as const, rgba: { r: 15, g: 46, b: 48, a: 255 } };
    const shape = {
      shapeType: 2,
      components: [
        createComponent({
          componentType: 0,
          color: { ...greenPaint.rgba },
          fillPaintSource: 'explicit',
          outerPaint: greenPaint,
          path: createPath([
            { type: 'M', x: 0, y: 0 },
            { type: 'L', x: 10, y: 0 },
          ]),
        }),
        createComponent({
          componentType: 0,
          path: createPath([
            { type: 'M', x: 10, y: 0 },
            { type: 'L', x: 10, y: 10 },
          ]),
        }),
        createComponent({
          componentType: 0,
          color: { ...darkPaint.rgba },
          fillPaintSource: 'explicit',
          outerPaint: darkPaint,
          path: createPath([
            { type: 'M', x: 10, y: 10 },
            { type: 'L', x: 0, y: 10 },
          ]),
        }),
      ],
    };

    const shared = __debugBuildLegacyChainsForShape(shape);
    expect(shared.groups).toHaveLength(2);
    for (const group of shared.groups) {
      expect(group.componentIndexes).toContain(1);
    }

    const filtered = __debugBuildLegacyChainsForShape(shape, [], { includeNullPaintFillBoundaries: false });
    expect(filtered.groups).toHaveLength(2);
    for (const group of filtered.groups) {
      expect(group.componentIndexes).not.toContain(1);
    }
  });

  it('keeps large mixed line-layer carriers on the full pre-render path ahead of overlapping detail fills', () => {
    const greenPaint = { kind: 'solid' as const, rgba: { r: 22, g: 198, b: 133, a: 255 } };
    const darkPaint = { kind: 'solid' as const, rgba: { r: 15, g: 46, b: 48, a: 255 } };
    const purplePaint = { kind: 'solid' as const, rgba: { r: 106, g: 52, b: 238, a: 255 } };
    const greenPoints: Array<[number, number]> = [];
    for (let x = -48; x <= 48; x += 6) greenPoints.push([x, -48]);
    for (let y = -42; y <= 48; y += 6) greenPoints.push([48, y]);
    for (let x = 42; x >= -48; x -= 6) greenPoints.push([x, 48]);
    for (let y = 42; y >= -12; y -= 6) greenPoints.push([-48, y]);
    greenPoints.push([-48, -48]);
    const darkPoints: Array<[number, number]> = [];
    for (let x = -52; x <= 52; x += 8) darkPoints.push([x, -52]);
    for (let y = -44; y <= -8; y += 6) darkPoints.push([52, y]);
    for (let x = 44; x >= -52; x -= 8) darkPoints.push([x, -8]);
    for (let y = -14; y >= -40; y -= 6) darkPoints.push([-52, y]);
    darkPoints.push([-52, -34]);
    const carrierComponents = [
      ...greenPoints.slice(0, -1).map(([x1, y1], index) => {
        const [x2, y2] = greenPoints[index + 1];
        return createComponent({
          componentType: 0,
          color: { ...greenPaint.rgba },
          fillPaintSource: index === 0 ? 'explicit' : 'inherited',
          outerPaint: greenPaint,
          path: createPath([
            { type: 'M', x: x1, y: y1 },
            { type: 'L', x: x2, y: y2 },
          ]),
        });
      }),
      ...darkPoints.slice(0, -1).map(([x1, y1], index) => {
        const [x2, y2] = darkPoints[index + 1];
        return createComponent({
          componentType: 0,
          color: { ...darkPaint.rgba },
          fillPaintSource: index === 0 ? 'explicit' : 'inherited',
          outerPaint: darkPaint,
          path: createPath([
            { type: 'M', x: x1, y: y1 },
            { type: 'L', x: x2, y: y2 },
          ]),
        });
      }),
    ];
    const detailShape = {
      shapeType: 2 as const,
      components: [
        createComponent({
          componentType: 0,
          color: { ...purplePaint.rgba },
          fillPaintSource: 'explicit',
          outerPaint: purplePaint,
          path: createPath([
            { type: 'M', x: -6, y: -6 },
            { type: 'L', x: 6, y: -6 },
          ]),
        }),
        createComponent({
          componentType: 0,
          color: { ...purplePaint.rgba },
          fillPaintSource: 'inherited',
          outerPaint: purplePaint,
          path: createPath([
            { type: 'M', x: 6, y: -6 },
            { type: 'L', x: 6, y: 6 },
          ]),
        }),
        createComponent({
          componentType: 0,
          color: { ...purplePaint.rgba },
          fillPaintSource: 'inherited',
          outerPaint: purplePaint,
          path: createPath([
            { type: 'M', x: 6, y: 6 },
            { type: 'L', x: -6, y: 6 },
          ]),
        }),
        createComponent({
          componentType: 0,
          color: { ...purplePaint.rgba },
          fillPaintSource: 'inherited',
          outerPaint: purplePaint,
          path: createPath([
            { type: 'M', x: -6, y: 6 },
            { type: 'L', x: -6, y: -6 },
          ]),
        }),
      ],
    };

    const drawing = createDrawing([{
      type: 'line',
      shapes: [
        detailShape,
        { shapeType: 2, components: carrierComponents },
      ],
    }]);

    const decisions = __debugLineFillDecisions(drawing.layers[0]);
    expect(decisions[0]?.preRenderPriority).toBe(0);
    expect(decisions[1]?.preRenderPriority).toBeGreaterThan(0);
    expect(decisions[1]?.preRenderMode).toBe('full');

    const canvas = renderTVGToCanvas(drawing, 120, 120, 140);
    expect(canvas).not.toBeNull();
  });

  it('fills boundary-only shapes using the default boundary color', () => {
    const boundaryPath = createPath([
      { type: 'M', x: -20, y: -20 },
      { type: 'L', x: 20, y: -20 },
      { type: 'L', x: 20, y: 20 },
      { type: 'L', x: -20, y: 20 },
    ], true);

    const drawing = createDrawing(
      [{
        type: 'color',
        shapes: [{
          shapeType: 2,
          components: [
            createComponent({
              componentType: 2,
              path: boundaryPath,
            }),
          ],
        }],
      }],
      [{ name: 'fill', id: 1n, paletteName: 'default', r: 32, g: 180, b: 96, a: 255 }],
    );

    const canvas = renderTVGToCanvas(drawing, 100, 100, 80);
    expect(canvas).not.toBeNull();
    const pixel = samplePixel(canvas!, 50, 50);
    expectColorNear(pixel, { r: 32, g: 180, b: 96 });
  });

  it('does not use sparse boundary markers from sibling layers as clip masks', () => {
    const fillPaint = { kind: 'solid' as const, rgba: { r: 255, g: 180, b: 63, a: 255 } };
    const markerPaint = { kind: 'solid' as const, rgba: { r: 0, g: 0, b: 0, a: 255 } };
    const drawing = createDrawing([
      {
        type: 'color',
        shapes: [{
          shapeType: 2,
          components: [
            createComponent({
              componentType: 0,
              color: { ...fillPaint.rgba },
              fillPaintSource: 'explicit',
              outerPaint: fillPaint,
              path: createPath([
                { type: 'M', x: -40, y: -20 },
                { type: 'L', x: 40, y: -20 },
              ]),
            }),
            createComponent({
              componentType: 0,
              color: { ...fillPaint.rgba },
              fillPaintSource: 'explicit',
              outerPaint: fillPaint,
              path: createPath([
                { type: 'M', x: 40, y: -20 },
                { type: 'L', x: 40, y: 20 },
              ]),
            }),
            createComponent({
              componentType: 0,
              color: { ...fillPaint.rgba },
              fillPaintSource: 'explicit',
              outerPaint: fillPaint,
              path: createPath([
                { type: 'M', x: 40, y: 20 },
                { type: 'L', x: -40, y: 20 },
              ]),
            }),
            createComponent({
              componentType: 0,
              color: { ...fillPaint.rgba },
              fillPaintSource: 'explicit',
              outerPaint: fillPaint,
              path: createPath([
                { type: 'M', x: -40, y: 20 },
                { type: 'L', x: -40, y: -20 },
              ]),
            }),
          ],
        }],
      },
      {
        type: 'line',
        shapes: [{
          shapeType: 7,
          components: [
            createComponent({
              componentType: 2,
              color: { ...markerPaint.rgba },
              outerPaint: markerPaint,
              path: createPath([
                { type: 'M', x: -55, y: -28 },
                { type: 'C', c1x: -62, c1y: -8, c2x: -62, c2y: 8, x: -55, y: 28 },
              ]),
            }),
          ],
        }],
      },
    ]);

    const canvas = renderTVGToCanvas(drawing, 120, 120);
    expect(canvas).not.toBeNull();
    expectColorNear(samplePixel(canvas!, 20, 60), fillPaint.rgba, 40);
    expectColorNear(samplePixel(canvas!, 60, 60), fillPaint.rgba, 40);
  });

  it('renders dual-sided strokes with separate outer and inner colors', () => {
    const drawing = createDrawing([{
      type: 'line',
      shapes: [{
        shapeType: 3,
        components: [
          createComponent({
            componentType: 2,
            strokeWidth: 60,
            path: createPath([
              { type: 'M', x: -30, y: 0 },
              { type: 'L', x: 30, y: 0 },
            ]),
            outerPaint: { kind: 'solid', rgba: { r: 220, g: 30, b: 30, a: 255 } },
            innerPaint: { kind: 'solid', rgba: { r: 40, g: 80, b: 220, a: 255 } },
          }),
        ],
      }],
    }]);

    const canvas = renderTVGToCanvas(drawing, 120, 120, 120);
    expect(canvas).not.toBeNull();

    const topPixel = samplePixel(canvas!, 60, 50);
    const bottomPixel = samplePixel(canvas!, 60, 66);
    expectColorNear(topPixel, { r: 220, g: 30, b: 30 }, 50);
    expectColorNear(bottomPixel, { r: 40, g: 80, b: 220 }, 50);
  });

  it('auto-fits horizontal stroke-only drawings without a viewport', () => {
    const drawing = createDrawing([{
      type: 'line',
      shapes: [{
        shapeType: 3,
        components: [
          createComponent({
            componentType: 2,
            strokeWidth: 12,
            outerPaint: { kind: 'solid', rgba: { r: 24, g: 24, b: 24, a: 255 } },
            path: createPath([
              { type: 'M', x: -30, y: 0 },
              { type: 'L', x: 30, y: 0 },
            ]),
          }),
        ],
      }],
    }]);

    const canvas = renderTVGToCanvas(drawing, 120, 120);
    expect(canvas).not.toBeNull();
    const pixel = samplePixel(canvas!, 60, 60);
    expect(pixel.a).toBeGreaterThan(0);
  });

  it('renders widthless type-2 line-art strokes for shapeType 7 on line layers', () => {
    const drawing = createDrawing([{
      type: 'line',
      shapes: [{
        shapeType: 7,
        components: [
          createComponent({
            componentType: 2,
            outerPaint: { kind: 'solid', rgba: { r: 0, g: 0, b: 0, a: 255 } },
            color: { r: 0, g: 0, b: 0, a: 255 },
            path: createPath([
              { type: 'M', x: -30, y: 0 },
              { type: 'L', x: 30, y: 0 },
            ]),
          }),
        ],
      }],
    }]);

    const viewportCanvas = renderTVGToCanvas(drawing, 120, 120, 120);
    expect(viewportCanvas).not.toBeNull();
    expect(samplePixel(viewportCanvas!, 60, 60).a).toBeGreaterThan(0);

    const autoFitCanvas = renderTVGToCanvas(drawing, 120, 120);
    expect(autoFitCanvas).not.toBeNull();
    expect(samplePixel(autoFitCanvas!, 60, 60).a).toBeGreaterThan(0);
  });

  it('renders chained single-segment widthless type-2 strokes split across shapeType 7 shapes', () => {
    const blackPaint = { kind: 'solid' as const, rgba: { r: 0, g: 0, b: 0, a: 255 } };
    const split = createDrawing([{
      type: 'line',
      shapes: [
        {
          shapeType: 7,
          components: [
            createComponent({
              componentType: 2,
              outerPaint: blackPaint,
              color: { ...blackPaint.rgba },
              path: createPath([
                { type: 'M', x: -40, y: -20 },
                { type: 'L', x: 0, y: -20 },
              ]),
            }),
          ],
        },
        {
          shapeType: 7,
          components: [
            createComponent({
              componentType: 2,
              outerPaint: blackPaint,
              color: { ...blackPaint.rgba },
              path: createPath([
                { type: 'M', x: 0, y: -20 },
                { type: 'L', x: 20, y: 0 },
              ]),
            }),
          ],
        },
        {
          shapeType: 7,
          components: [
            createComponent({
              componentType: 2,
              outerPaint: blackPaint,
              color: { ...blackPaint.rgba },
              path: createPath([
                { type: 'M', x: 20, y: 0 },
                { type: 'L', x: 20, y: 30 },
              ]),
            }),
          ],
        },
      ],
    }]);

    const splitCanvas = renderTVGToCanvas(split, 120, 120, 120);
    expect(splitCanvas).not.toBeNull();
    expect(samplePixel(splitCanvas!, 36, 44).a).toBeGreaterThan(0);
    expect(samplePixel(splitCanvas!, 60, 60).a).toBeGreaterThan(0);
    expect(samplePixel(splitCanvas!, 68, 78).a).toBeGreaterThan(0);
  });

  it('does not render widthless boundary carriers when an active color fill owns the same path', () => {
    const bluePaint = { kind: 'solid' as const, rgba: { r: 60, g: 91, b: 203, a: 255 } };
    const blackPaint = { kind: 'solid' as const, rgba: { r: 0, g: 0, b: 0, a: 255 } };
    const drawing = createDrawing([
      {
        type: 'color',
        shapes: [{
          shapeType: 1,
          components: [
            createComponent({
              componentType: 0,
              outerPaint: bluePaint,
              color: { ...bluePaint.rgba },
              fillPaintSource: 'explicit',
              path: createPath([
                { type: 'M', x: -30, y: -30 },
                { type: 'L', x: 30, y: -30 },
              ]),
            }),
            createComponent({
              componentType: 0,
              outerPaint: bluePaint,
              color: { ...bluePaint.rgba },
              fillPaintSource: 'inherited',
              path: createPath([
                { type: 'M', x: 30, y: -30 },
                { type: 'L', x: 30, y: 30 },
              ]),
            }),
            createComponent({
              componentType: 0,
              outerPaint: bluePaint,
              color: { ...bluePaint.rgba },
              fillPaintSource: 'inherited',
              path: createPath([
                { type: 'M', x: 30, y: 30 },
                { type: 'L', x: -30, y: 30 },
              ]),
            }),
            createComponent({
              componentType: 0,
              outerPaint: bluePaint,
              color: { ...bluePaint.rgba },
              fillPaintSource: 'inherited',
              path: createPath([
                { type: 'M', x: -30, y: 30 },
                { type: 'L', x: -30, y: -30 },
              ]),
            }),
          ],
        }],
      },
      {
        type: 'line',
        shapes: [
          {
            shapeType: 7,
            components: [
              createComponent({
                componentType: 2,
                outerPaint: blackPaint,
                color: { ...blackPaint.rgba },
                path: createPath([
                  { type: 'M', x: -30, y: -30 },
                  { type: 'L', x: 30, y: -30 },
                ]),
              }),
            ],
          },
          {
            shapeType: 7,
            components: [
              createComponent({
                componentType: 2,
                outerPaint: blackPaint,
                color: { ...blackPaint.rgba },
                path: createPath([
                  { type: 'M', x: 30, y: -30 },
                  { type: 'L', x: 30, y: 30 },
                ]),
              }),
            ],
          },
          {
            shapeType: 7,
            components: [
              createComponent({
                componentType: 2,
                outerPaint: blackPaint,
                color: { ...blackPaint.rgba },
                path: createPath([
                  { type: 'M', x: 30, y: 30 },
                  { type: 'L', x: -30, y: 30 },
                ]),
              }),
            ],
          },
          {
            shapeType: 7,
            components: [
              createComponent({
                componentType: 2,
                outerPaint: blackPaint,
                color: { ...blackPaint.rgba },
                path: createPath([
                  { type: 'M', x: -30, y: 30 },
                  { type: 'L', x: -30, y: -30 },
                ]),
              }),
            ],
          },
        ],
      },
    ]);

    const fullCanvas = renderTVGToCanvas(drawing, 100, 100, 80);
    const colorOnlyCanvas = renderTVGToCanvas(drawing, 100, 100, 80, { artLayerFilter: 'color' });
    const lineOnlyCanvas = renderTVGToCanvas(drawing, 100, 100, 80, { artLayerFilter: 'line' });

    expect(fullCanvas).not.toBeNull();
    expect(colorOnlyCanvas).not.toBeNull();
    expect(lineOnlyCanvas).not.toBeNull();
    expectColorNear(samplePixel(fullCanvas!, 50, 50), bluePaint.rgba, 60);
    expect(scoreCanvasSources(colorOnlyCanvas!, fullCanvas!, 100).rawScore).toBeGreaterThan(99.9);
    expect(countNonWhitePixels(lineOnlyCanvas!)).toBeGreaterThan(20);
  });

  it('renders widthless type-2 strokes when they accompany a visible stroke with the same paint', () => {
    const blackPaint = { kind: 'solid' as const, rgba: { r: 0, g: 0, b: 0, a: 255 } };
    const drawing = createDrawing([{
      type: 'line',
      shapes: [{
        shapeType: 0,
        components: [
          createComponent({
            componentType: 4,
            strokeWidth: 12,
            outerPaint: blackPaint,
            color: { ...blackPaint.rgba },
            path: createPath([
              { type: 'M', x: 0, y: -30 },
              { type: 'L', x: 0, y: 30 },
            ]),
          }),
          createComponent({
            componentType: 2,
            outerPaint: blackPaint,
            color: { ...blackPaint.rgba },
            path: createPath([
              { type: 'M', x: -30, y: 0 },
              { type: 'L', x: 30, y: 0 },
            ]),
          }),
        ],
      }],
    }]);

    const canvas = renderTVGToCanvas(drawing, 120, 120, 120);
    expect(canvas).not.toBeNull();
    expect(samplePixel(canvas!, 75, 60).a).toBeGreaterThan(0);
  });

  it('does not implicitly fill open unresolved line-layer fill chains', () => {
    const blackPaint = { kind: 'solid' as const, rgba: { r: 0, g: 0, b: 0, a: 255 } };
    const drawing = createDrawing([{
      type: 'line',
      shapes: [{
        shapeType: 2,
        components: [
          createComponent({
            componentType: 0,
            color: { ...blackPaint.rgba },
            fillPaintSource: 'explicit',
            outerPaint: blackPaint,
            path: createPath([
              { type: 'M', x: -30, y: -20 },
              { type: 'L', x: 30, y: -20 },
            ]),
          }),
          createComponent({
            componentType: 0,
            color: { ...blackPaint.rgba },
            fillPaintSource: 'explicit',
            outerPaint: blackPaint,
            path: createPath([
              { type: 'M', x: 30, y: -20 },
              { type: 'L', x: 0, y: 24 },
            ]),
          }),
          createComponent({
            componentType: 0,
            color: { ...blackPaint.rgba },
            fillPaintSource: 'explicit',
            outerPaint: blackPaint,
            path: createPath([
              { type: 'M', x: 0, y: 24 },
              { type: 'L', x: -18, y: 10 },
            ]),
          }),
        ],
      }],
    }]);

    const canvas = renderTVGToCanvas(drawing, 120, 120, 120);
    expect(canvas).not.toBeNull();
    expectColorNear(samplePixel(canvas!, 60, 56), { r: 255, g: 255, b: 255 }, 5);
  });

  it('borrows missing pencil paths from the previous fill shape for matching shapeType-1 outlines', () => {
    const pathA = createPath([
      { type: 'M', x: -20, y: -20 },
      { type: 'L', x: 20, y: -20 },
    ]);
    const pathB = createPath([
      { type: 'M', x: 20, y: -20 },
      { type: 'L', x: 20, y: 20 },
    ]);
    const layer: TVGArtLayer = {
      type: 'line',
      shapes: [
        {
          shapeType: 1,
          components: [
            createComponent({ componentType: 0, path: pathA }),
            createComponent({ componentType: 0, path: pathB }),
          ],
        },
        {
          shapeType: 1,
          components: [
            createComponent({ componentType: 4, strokeWidth: 4, path: null }),
            createComponent({ componentType: 4, strokeWidth: 4, path: null }),
          ],
        },
      ],
    };

    __borrowMissingPencilPathsForTests(layer);

    expect(layer.shapes[1].components[0].path).toBe(pathA);
    expect(layer.shapes[1].components[1].path).toBe(pathB);
  });

  it('uses captured path reference hints when borrowing missing pencil paths', () => {
    const paths = [
      createPath([{ type: 'M', x: -30, y: 0 }, { type: 'L', x: -10, y: 0 }]),
      createPath([{ type: 'M', x: -10, y: 0 }, { type: 'L', x: 10, y: 0 }]),
      createPath([{ type: 'M', x: 10, y: 0 }, { type: 'L', x: 30, y: 0 }]),
      createPath([{ type: 'M', x: 30, y: 0 }, { type: 'L', x: 50, y: 0 }]),
      createPath([{ type: 'M', x: 50, y: 0 }, { type: 'L', x: 70, y: 0 }]),
    ];
    const layer: TVGArtLayer = {
      type: 'line',
      shapes: [
        {
          shapeType: 1,
          components: paths.map(path => createComponent({ componentType: 0, path })),
        },
        {
          shapeType: 4,
          components: [
            createComponent({ componentType: 4, strokeWidth: 4, path: null, pathRefHint: 5 }),
            createComponent({ componentType: 4, strokeWidth: 4, path: null, pathRefHint: 2 }),
          ],
        },
      ],
    };

    __borrowMissingPencilPathsForTests(layer);

    expect(layer.shapes[1].components[0].path).toBe(paths[4]);
    expect(layer.shapes[1].components[1].path).toBe(paths[1]);
  });

  it('repairs local shapeType-5 pencil paths from immediate forward fill references on line layers', () => {
    const skinPaint = { kind: 'solid' as const, rgba: { r: 250, g: 194, b: 167, a: 255 } };
    const blackPaint = { kind: 'solid' as const, rgba: { r: 0, g: 0, b: 0, a: 255 } };
    const previousFill = createPath([
      { type: 'M', x: -80, y: -80 },
      { type: 'C', c1x: -70, c1y: -80, c2x: -70, c2y: -60, x: -60, y: -60 },
    ]);
    const stalePencilPath = createPath([
      { type: 'M', x: 0, y: 0 },
      { type: 'C', c1x: 10, c1y: 0, c2x: 10, c2y: 20, x: 20, y: 20 },
    ]);
    const referencedFill = createPath([
      { type: 'M', x: 5, y: 5 },
      { type: 'C', c1x: 15, c1y: 5, c2x: 15, c2y: 25, x: 25, y: 25 },
    ]);
    const layer: TVGArtLayer = {
      type: 'line',
      shapes: [
        {
          shapeType: 1,
          components: [
            createComponent({ componentType: 0, outerPaint: skinPaint, path: previousFill }),
          ],
        },
        {
          shapeType: 5,
          components: [
            createComponent({
              componentType: 4,
              outerPaint: blackPaint,
              strokeWidth: 4,
              path: stalePencilPath,
              pathRefHint: 2,
            }),
          ],
        },
        {
          shapeType: 1,
          components: [
            createComponent({ componentType: 0, outerPaint: skinPaint, path: referencedFill }),
          ],
        },
      ],
    };

    __repairForwardPencilPathRefsForTests(layer);

    expect(layer.shapes[1].components[0].path).toBe(referencedFill);
  });

  it('does not apply forward pencil path references to open overlay chains', () => {
    const skinPaint = { kind: 'solid' as const, rgba: { r: 250, g: 194, b: 167, a: 255 } };
    const blackPaint = { kind: 'solid' as const, rgba: { r: 0, g: 0, b: 0, a: 255 } };
    const stalePencilPath = createPath([
      { type: 'M', x: 0, y: 0 },
      { type: 'C', c1x: 10, c1y: 0, c2x: 10, c2y: 20, x: 20, y: 20 },
    ]);
    const referencedFill = createPath([
      { type: 'M', x: 5, y: 5 },
      { type: 'C', c1x: 15, c1y: 5, c2x: 15, c2y: 25, x: 25, y: 25 },
    ]);
    const layer: TVGArtLayer = {
      type: 'overlay',
      shapes: [
        {
          shapeType: 5,
          components: [
            createComponent({
              componentType: 4,
              outerPaint: blackPaint,
              strokeWidth: 4,
              path: stalePencilPath,
              pathRefHint: 1,
            }),
          ],
        },
        {
          shapeType: 1,
          components: [
            createComponent({ componentType: 0, outerPaint: skinPaint, path: referencedFill }),
          ],
        },
      ],
    };

    __repairForwardPencilPathRefsForTests(layer);

    expect(layer.shapes[0].components[0].path).toBe(stalePencilPath);
  });

  it('repairs small closed overlay pencil chains from immediate forward fill references', () => {
    const skinPaint = { kind: 'solid' as const, rgba: { r: 250, g: 194, b: 167, a: 255 } };
    const blackPaint = { kind: 'solid' as const, rgba: { r: 0, g: 0, b: 0, a: 255 } };
    const firstEdge = createPath([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 20, y: 0 },
    ]);
    const secondEdge = createPath([
      { type: 'M', x: 20, y: 0 },
      { type: 'L', x: 10, y: 20 },
    ]);
    const thirdEdge = createPath([
      { type: 'M', x: 10, y: 20 },
      { type: 'L', x: 0, y: 0 },
    ]);
    const referencedFill = createPath([
      { type: 'M', x: 100, y: 100 },
      { type: 'C', c1x: 108, c1y: 100, c2x: 108, c2y: 116, x: 116, y: 116 },
    ]);
    const layer: TVGArtLayer = {
      type: 'overlay',
      shapes: [
        {
          shapeType: 5,
          components: [
            createComponent({ componentType: 4, outerPaint: blackPaint, strokeWidth: 4, path: firstEdge, pathRefHint: 1 }),
            createComponent({ componentType: 4, outerPaint: blackPaint, strokeWidth: 4, path: secondEdge }),
            createComponent({ componentType: 4, outerPaint: blackPaint, strokeWidth: 4, path: thirdEdge }),
          ],
        },
        {
          shapeType: 1,
          components: [
            createComponent({ componentType: 0, outerPaint: skinPaint, path: referencedFill }),
          ],
        },
      ],
    };

    __repairForwardPencilPathRefsForTests(layer);

    expect(layer.shapes[0].components[0].path).toBe(referencedFill);
  });

  it('does not repair closed shapeType-5 pencil chains from path references', () => {
    const skinPaint = { kind: 'solid' as const, rgba: { r: 250, g: 194, b: 167, a: 255 } };
    const blackPaint = { kind: 'solid' as const, rgba: { r: 0, g: 0, b: 0, a: 255 } };
    const firstEdge = createPath([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 20, y: 0 },
    ]);
    const secondEdge = createPath([
      { type: 'M', x: 20, y: 0 },
      { type: 'L', x: 10, y: 20 },
    ]);
    const thirdEdge = createPath([
      { type: 'M', x: 10, y: 20 },
      { type: 'L', x: 0, y: 0 },
    ]);
    const referencedFill = createPath([
      { type: 'M', x: 5, y: 5 },
      { type: 'C', c1x: 15, c1y: 5, c2x: 15, c2y: 25, x: 25, y: 25 },
    ]);
    const layer: TVGArtLayer = {
      type: 'line',
      shapes: [
        {
          shapeType: 5,
          components: [
            createComponent({ componentType: 4, outerPaint: blackPaint, strokeWidth: 4, path: firstEdge, pathRefHint: 1 }),
            createComponent({ componentType: 4, outerPaint: blackPaint, strokeWidth: 4, path: secondEdge }),
            createComponent({ componentType: 4, outerPaint: blackPaint, strokeWidth: 4, path: thirdEdge }),
          ],
        },
        {
          shapeType: 1,
          components: [
            createComponent({ componentType: 0, outerPaint: skinPaint, path: referencedFill }),
          ],
        },
      ],
    };

    __repairForwardPencilPathRefsForTests(layer);

    expect(layer.shapes[0].components[0].path).toBe(firstEdge);
  });

  it('does not synthesize fills for thick closed pencil loops on line layers', () => {
    const drawing = createDrawing([{
      type: 'line',
      shapes: [{
        shapeType: 3,
        components: [
          createComponent({
            componentType: 4,
            strokeWidth: 12,
            outerPaint: { kind: 'solid', rgba: { r: 244, g: 81, b: 38, a: 255 } },
            path: createPath([
              { type: 'M', x: -24, y: -24 },
              { type: 'L', x: 24, y: -24 },
              { type: 'L', x: 24, y: 24 },
              { type: 'L', x: -24, y: 24 },
              { type: 'L', x: -24, y: -24 },
            ]),
            fromTipType: 'butt',
            toTipType: 'round',
          }),
        ],
      }],
    }]);

    const canvas = renderTVGToCanvas(drawing, 120, 120, 120);
    expect(canvas).not.toBeNull();
    const center = samplePixel(canvas!, 60, 60);
    const edge = samplePixel(canvas!, 60, 28);
    expectColorNear(center, { r: 255, g: 255, b: 255 }, 10);
    expect(edge.a).toBeGreaterThan(0);
  });

  it('synthesizes fills for thin closed pencil loops on line layers', () => {
    const drawing = createDrawing([{
      type: 'line',
      shapes: [{
        shapeType: 3,
        components: [
          createComponent({
            componentType: 4,
            strokeWidth: 4,
            outerPaint: { kind: 'solid', rgba: { r: 197, g: 153, b: 132, a: 255 } },
            path: createPath([
              { type: 'M', x: -24, y: -8 },
              { type: 'C', c1x: -24, c1y: 8, c2x: 0, c2y: 24, x: 24, y: 8 },
            ]),
          }),
          createComponent({
            componentType: 4,
            strokeWidth: 4,
            outerPaint: { kind: 'solid', rgba: { r: 197, g: 153, b: 132, a: 255 } },
            path: createPath([
              { type: 'M', x: 24, y: 8 },
              { type: 'C', c1x: 16, c1y: -16, c2x: -12, c2y: -20, x: -24, y: -8 },
            ]),
          }),
        ],
      }],
    }]);

    const canvas = renderTVGToCanvas(drawing, 120, 120, 120);
    expect(canvas).not.toBeNull();
    const center = samplePixel(canvas!, 60, 60);
    const edge = samplePixel(canvas!, 60, 40);
    expectColorNear(center, { r: 197, g: 153, b: 132 }, 20);
    expect(edge.a).toBeGreaterThan(0);
  });

  it('synthesizes fills for thin single-path closed black pencil loops', () => {
    const blackPaint = { kind: 'solid' as const, rgba: { r: 0, g: 0, b: 0, a: 255 } };
    const drawing = createDrawing([{
      type: 'line',
      shapes: [{
        shapeType: 3,
        components: [
          createComponent({
            componentType: 4,
            strokeWidth: 2,
            outerPaint: blackPaint,
            path: createPath([
              { type: 'M', x: -24, y: -8 },
              { type: 'C', c1x: -12, c1y: 18, c2x: 20, c2y: 18, x: 24, y: 0 },
              { type: 'C', c1x: 12, c1y: -18, c2x: -18, c2y: -18, x: -24, y: -8 },
            ], true),
          }),
        ],
      }],
    }]);

    const canvas = renderTVGToCanvas(drawing, 120, 120, 120);
    expect(canvas).not.toBeNull();
    expectColorNear(samplePixel(canvas!, 60, 60), blackPaint.rgba, 20);
  });

  it('preserves contour-painted pencil loop interiors and outer strokes', () => {
    const outerPaint = { kind: 'solid' as const, rgba: { r: 122, g: 211, b: 235, a: 255 } };
    const interiorPaint = { kind: 'solid' as const, rgba: { r: 186, g: 217, b: 225, a: 255 } };
    const drawing = createDrawing([{
      type: 'line',
      shapes: [{
        shapeType: 3,
        components: [
          createComponent({
            componentType: 4,
            strokeWidth: 4,
            outerPaint,
            contourPaint: interiorPaint,
            path: createPath([
              { type: 'M', x: -24, y: -24 },
              { type: 'L', x: 24, y: -24 },
            ]),
            fromTipType: 'butt',
            toTipType: 'butt',
          }),
          createComponent({
            componentType: 4,
            strokeWidth: 4,
            outerPaint,
            path: createPath([
              { type: 'M', x: 24, y: -24 },
              { type: 'L', x: 24, y: 24 },
            ]),
            fromTipType: 'butt',
            toTipType: 'butt',
          }),
          createComponent({
            componentType: 4,
            strokeWidth: 4,
            outerPaint,
            path: createPath([
              { type: 'M', x: 24, y: 24 },
              { type: 'L', x: -24, y: 24 },
            ]),
            fromTipType: 'butt',
            toTipType: 'butt',
          }),
          createComponent({
            componentType: 4,
            strokeWidth: 4,
            outerPaint,
            path: createPath([
              { type: 'M', x: -24, y: 24 },
              { type: 'L', x: -24, y: -24 },
            ]),
            fromTipType: 'butt',
            toTipType: 'butt',
          }),
        ],
      }],
    }]);

    const canvas = renderTVGToCanvas(drawing, 120, 120, 120);
    expect(canvas).not.toBeNull();
    expectColorNear(samplePixel(canvas!, 60, 60), interiorPaint.rgba, 20);
    expectColorNear(samplePixel(canvas!, 60, 50), outerPaint.rgba, 35);
  });

  it('synthesizes fills for thin multi-segment pencil loops through legacy chaining', () => {
    const fillColor = { r: 197, g: 153, b: 132, a: 255 };
    const paint = { kind: 'solid' as const, rgba: { ...fillColor } };
    const drawing = createDrawing([{
      type: 'line',
      shapes: [{
        shapeType: 3,
        components: [
          createComponent({
            componentType: 4,
            strokeWidth: 4,
            outerPaint: paint,
            color: { ...fillColor },
            path: createPath([
              { type: 'M', x: -24, y: -20 },
              { type: 'L', x: 24, y: -12 },
            ]),
          }),
          createComponent({
            componentType: 4,
            strokeWidth: 4,
            outerPaint: paint,
            color: { ...fillColor },
            path: createPath([
              { type: 'M', x: 24, y: -12 },
              { type: 'L', x: 8, y: 24 },
            ]),
          }),
          createComponent({
            componentType: 4,
            strokeWidth: 4,
            outerPaint: paint,
            color: { ...fillColor },
            path: createPath([
              { type: 'M', x: 8, y: 24 },
              { type: 'L', x: -24, y: -20 },
            ]),
          }),
        ],
      }],
    }]);

    const canvas = renderTVGToCanvas(drawing, 120, 120, 120);
    expect(canvas).not.toBeNull();
    expectColorNear(samplePixel(canvas!, 60, 56), fillColor, 25);
  });

  it('renders semi-transparent explicit fills instead of dropping them', () => {
    const drawing = createDrawing([{
      type: 'color',
      shapes: [{
        shapeType: 2,
        components: [
          createComponent({
            componentType: 0,
            colorId: 1n,
            color: { r: 215, g: 0, b: 175, a: 60 },
            fillPaintSource: 'explicit',
            outerPaint: { kind: 'solid', rgba: { r: 215, g: 0, b: 175, a: 60 } },
            path: createPath([
              { type: 'M', x: -20, y: -20 },
              { type: 'L', x: 20, y: -20 },
              { type: 'L', x: 20, y: 20 },
              { type: 'L', x: -20, y: 20 },
              { type: 'L', x: -20, y: -20 },
            ], true),
          }),
        ],
      }],
    }]);

    const canvas = renderTVGToCanvas(drawing, 120, 120, 120);
    expect(canvas).not.toBeNull();
    const pixel = samplePixel(canvas!, 60, 60);
    expect(pixel.g).toBeLessThan(240);
    expect(pixel.r).toBeGreaterThan(pixel.g);
    expect(pixel.b).toBeGreaterThan(pixel.g);
  });

  it('suppresses large near-black line fills when an overlapping color sibling exists', () => {
    const blackPaint = { kind: 'solid' as const, rgba: { r: 0, g: 0, b: 0, a: 255 } };
    const greenPaint = { kind: 'solid' as const, rgba: { r: 28, g: 210, b: 146, a: 255 } };
    const drawing = createDrawing([{
      type: 'line',
      shapes: [
        {
          shapeType: 2,
          components: [
            createComponent({
              componentType: 0,
              color: { ...blackPaint.rgba },
              fillPaintSource: 'explicit',
              outerPaint: blackPaint,
              path: createPath([
                { type: 'M', x: -150, y: -150 },
                { type: 'L', x: 150, y: -150 },
                { type: 'L', x: 150, y: 150 },
                { type: 'L', x: -150, y: 150 },
                { type: 'L', x: -150, y: -150 },
              ], true),
            }),
          ],
        },
        {
          shapeType: 1,
          components: [
            createComponent({
              componentType: 0,
              color: { ...greenPaint.rgba },
              fillPaintSource: 'explicit',
              outerPaint: greenPaint,
              path: createPath([
                { type: 'M', x: -100, y: -100 },
                { type: 'L', x: 100, y: -100 },
                { type: 'L', x: 100, y: 100 },
                { type: 'L', x: -100, y: 100 },
                { type: 'L', x: -100, y: -100 },
              ], true),
            }),
          ],
        },
      ],
    }]);

    const canvas = renderTVGToCanvas(drawing, 160, 160, 360);
    expect(canvas).not.toBeNull();
    const corner = samplePixel(canvas!, 16, 16);
    const center = samplePixel(canvas!, 80, 80);
    expectColorNear(corner, { r: 255, g: 255, b: 255 }, 10);
    expectColorNear(center, greenPaint.rgba, 35);
  });

  it('uses inline pencil brush size when real samples omit a TGTB profile', async () => {
    const response = await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip');
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const tvgData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/Collar/Collar-1.tvg')!.async('arraybuffer');
    const drawing = parseTVG(tvgData);
    const pencilWidths = drawing.layers
      .flatMap(layer => layer.shapes)
      .flatMap(shape => shape.components)
      .filter(comp => comp.componentType === 4)
      .map(comp => comp.strokeWidth);

    expect(pencilWidths.length).toBeGreaterThan(0);
    expect(pencilWidths.every(width => (width ?? 0) > 1)).toBe(true);

    const canvas = renderTVGToCanvas(drawing, 160, 160, 336);
    expect(canvas).not.toBeNull();
    expect(countNonWhitePixels(canvas!)).toBeGreaterThan(200);
  });

  it('matches the thumbnail for recovered pure-pencil fill-only line shapes', async () => {
    const response = await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip');
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const externalColors = flattenExternalPaletteColors(await loadPalettes(zip));
    const tvgData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/Shadow_Neck/Shadow_Neck-1.tvg')!.async('arraybuffer');
    const thumbData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/Shadow_Neck/.thumbnails/.Shadow_Neck-1.tvg.png')!.async('arraybuffer');
    const drawing = parseTVG(tvgData);
    resolveExternalPalette(drawing, externalColors);

    const canvas = renderTVGToCanvas(drawing, 160, 160, 336);
    expect(canvas).not.toBeNull();
    const reference = await loadImageFromArrayBuffer(thumbData);
    const score = scoreCanvasSources(reference, canvas!, 160);
    expect(score.rawScore).toBeGreaterThan(99);
    expect(score.gateScore).toBe(100);
  });

  it('matches the thumbnail for recovered pure-pencil fill-only color shapes', async () => {
    const response = await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip');
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const externalColors = flattenExternalPaletteColors(await loadPalettes(zip));
    const tvgData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/Collar/Collar-1.tvg')!.async('arraybuffer');
    const thumbData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/Collar/.thumbnails/.Collar-1.tvg.png')!.async('arraybuffer');
    const drawing = parseTVG(tvgData);
    resolveExternalPalette(drawing, externalColors);

    const canvas = renderTVGToCanvas(drawing, 160, 160, 336);
    expect(canvas).not.toBeNull();
    const reference = await loadImageFromArrayBuffer(thumbData);
    const score = scoreCanvasSources(reference, canvas!, 160);
    expect(score.rawScore).toBeGreaterThan(99);
    expect(score.gateScore).toBe(100);
  });

  it('keeps filtered color renders isolated from inactive layer clipping', async () => {
    const response = await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip');
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const externalColors = flattenExternalPaletteColors(await loadPalettes(zip));
    const tvgData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/Number_Body/Number_Body-1.tvg')!.async('arraybuffer');
    const drawing = parseTVG(tvgData);
    resolveExternalPalette(drawing, externalColors);

    const filteredCanvas = renderTVGToCanvas(drawing, 160, 160, 336, { artLayerFilter: 'color' });
    const isolatedCanvas = renderTVGToCanvas(
      { ...drawing, layers: drawing.layers.filter((layer) => layer.type === 'color') },
      160,
      160,
      336,
    );

    expect(filteredCanvas).not.toBeNull();
    expect(isolatedCanvas).not.toBeNull();
    const score = scoreCanvasSources(isolatedCanvas!, filteredCanvas!, 160);
    expect(score.rawScore).toBeGreaterThan(99.9);
    expect(score.gateScore).toBe(100);
  });

  it('keeps Number_Body widthless line carriers from overpainting the color thumbnail', async () => {
    const response = await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip');
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const externalColors = flattenExternalPaletteColors(await loadPalettes(zip));
    const tvgData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/Number_Body/Number_Body-1.tvg')!.async('arraybuffer');
    const thumbData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/Number_Body/.thumbnails/.Number_Body-1.tvg.png')!.async('arraybuffer');
    const drawing = parseTVG(tvgData);
    resolveExternalPalette(drawing, externalColors);

    const canvas = renderTVGToCanvas(drawing, 160, 160, 336);
    expect(canvas).not.toBeNull();
    const reference = await loadImageFromArrayBuffer(thumbData);
    const score = scoreCanvasSources(reference, canvas!, 160);
    expect(score.score).toBe(100);
    expect(score.gateScore).toBe(100);
  });

  it('keeps underlay mask palette hints from overriding matte fill color', async () => {
    const response = await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip');
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const externalColors = flattenExternalPaletteColors(await loadPalettes(zip));
    const tvgData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/Line_body/Line_body-1.tvg')!.async('arraybuffer');
    const thumbData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/Line_body/.thumbnails/.Line_body-1.tvg.png')!.async('arraybuffer');
    const drawing = parseTVG(tvgData);
    resolveExternalPalette(drawing, externalColors);

    const underlayFillColors = drawing.layers[0].shapes[0].components
      .filter(comp => comp.componentType === 0)
      .map(comp => comp.color);
    expect(underlayFillColors.every(color => color?.r === 1 && color.g === 255 && color.b === 0)).toBe(true);

    const canvas = renderTVGToCanvas(drawing, 160, 160, 336);
    expect(canvas).not.toBeNull();
    const reference = await loadImageFromArrayBuffer(thumbData);
    const score = scoreCanvasSources(reference, canvas!, 160);
    expect(score.gateScore).toBe(100);
    expect(score.rawScore).toBeGreaterThan(98);
  });

  it('uses same-layer underlay boundary strokes as support-only fill closure', async () => {
    const response = await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip');
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const externalColors = flattenExternalPaletteColors(await loadPalettes(zip));
    const tvgData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/sole_line_B/sole_line_B-2.tvg')!.async('arraybuffer');
    const thumbData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/sole_line_B/.thumbnails/.sole_line_B-2.tvg.png')!.async('arraybuffer');
    const drawing = parseTVG(tvgData);
    resolveExternalPalette(drawing, externalColors);

    const canvas = renderTVGToCanvas(drawing, 160, 160, 336);
    expect(canvas).not.toBeNull();
    const reference = await loadImageFromArrayBuffer(thumbData);
    const score = scoreCanvasSources(reference, canvas!, 160);
    expect(score.gateScore).toBe(100);
    expect(score.rawScore).toBeGreaterThan(99);
  });

  it('does not export open-only construction guide strokes', async () => {
    const response = await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip');
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const externalColors = flattenExternalPaletteColors(await loadPalettes(zip));
    const tvgData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/Drawing_1/Drawing_1-1.tvg')!.async('arraybuffer');
    const thumbData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/Drawing_1/.thumbnails/.Drawing_1-1.tvg.png')!.async('arraybuffer');
    const drawing = parseTVG(tvgData);
    resolveExternalPalette(drawing, externalColors);

    const canvas = renderTVGToCanvas(drawing, 160, 160, 336);
    expect(canvas).not.toBeNull();
    const reference = await loadImageFromArrayBuffer(thumbData);
    const score = scoreCanvasSources(reference, canvas!, 160);
    expect(score.gateScore).toBe(100);
    expect(score.rawScore).toBe(100);
  });

  it('insets mixed construction guide drawings to match thumbnail framing', async () => {
    const response = await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip');
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const externalColors = flattenExternalPaletteColors(await loadPalettes(zip));
    const tvgData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/Drawing_1/Drawing_1-3.tvg')!.async('arraybuffer');
    const thumbData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/Drawing_1/.thumbnails/.Drawing_1-3.tvg.png')!.async('arraybuffer');
    const drawing = parseTVG(tvgData);
    resolveExternalPalette(drawing, externalColors);

    const canvas = renderTVGToCanvas(drawing, 160, 160, 336);
    expect(canvas).not.toBeNull();
    const reference = await loadImageFromArrayBuffer(thumbData);
    const score = scoreCanvasSources(reference, canvas!, 160);
    expect(score.gateScore).toBe(100);
    expect(score.rawScore).toBeGreaterThan(99.5);
  });

  it('fills closed colored pencil loops instead of rendering only their stroke outlines', async () => {
    const response = await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip');
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const externalColors = flattenExternalPaletteColors(await loadPalettes(zip));
    const tvgData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/Eyebrow/Eyebrow-1.tvg')!.async('arraybuffer');
    const thumbData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/Eyebrow/.thumbnails/.Eyebrow-1.tvg.png')!.async('arraybuffer');
    const drawing = parseTVG(tvgData);
    resolveExternalPalette(drawing, externalColors);

    const canvas = renderTVGToCanvas(drawing, 160, 160, 336);
    expect(canvas).not.toBeNull();
    const reference = await loadImageFromArrayBuffer(thumbData);
    const score = scoreCanvasSources(reference, canvas!, 160);
    expect(score.gateScore).toBe(100);
    expect(score.rawScore).toBeGreaterThan(99);
  });

  it('fills closed black line loops with the non-utility palette fill color', async () => {
    const response = await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip');
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const externalColors = flattenExternalPaletteColors(await loadPalettes(zip));
    const tvgData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/F-Sleeve_bk_F/F-Sleeve_bk_F-1.tvg')!.async('arraybuffer');
    const thumbData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/F-Sleeve_bk_F/.thumbnails/.F-Sleeve_bk_F-1.tvg.png')!.async('arraybuffer');
    const drawing = parseTVG(tvgData);
    resolveExternalPalette(drawing, externalColors);

    const canvas = renderTVGToCanvas(drawing, 160, 160, 336);
    expect(canvas).not.toBeNull();
    const reference = await loadImageFromArrayBuffer(thumbData);
    const score = scoreCanvasSources(reference, canvas!, 160);
    expect(score.gateScore).toBeGreaterThan(99.5);
    expect(score.rawScore).toBeGreaterThan(98);
  });

  it('renders the recovered blue block from embedded TGCO colors inside long pencil TGSD blocks', async () => {
    const response = await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip');
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const tvgData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/B_Shadow_LoLeg/B_Shadow_LoLeg-1.tvg')!.async('arraybuffer');
    const drawing = parseTVG(tvgData);
    const canvas = renderTVGToCanvas(drawing, 160, 160, 336);

    expect(canvas).not.toBeNull();
    const top = samplePixel(canvas!, 80, 66);
    const bottom = samplePixel(canvas!, 80, 94);
    expectColorNear(top, { r: 250, g: 194, b: 167 }, 30);
    expectColorNear(bottom, { r: 60, g: 91, b: 203 }, 35);
  });

  it('keeps zero-scale trailing text labels hidden', () => {
    const strokePaint = { kind: 'solid' as const, rgba: { r: 0, g: 0, b: 0, a: 255 } };
    const baseLayer: TVGArtLayer = {
      type: 'line',
      shapes: [{
        shapeType: 7,
        components: [createComponent({
          componentType: 2,
          color: { ...strokePaint.rgba },
          outerPaint: strokePaint,
          strokeWidth: 1,
          path: createPath([
            { type: 'M', x: -20, y: 24 },
            { type: 'L', x: 20, y: 24 },
          ]),
        })],
      }],
      textLabels: [],
    };
    const visible = createDrawing([{
      ...baseLayer,
      textLabels: [{ text: 'Visible', fontFamily: 'Arial', fontSize: 24, x: -12, y: -8, scaleX: 1.5, scaleY: 1.5 }],
    }]);
    const hidden = createDrawing([{
      ...baseLayer,
      textLabels: [{ text: 'Hidden', fontFamily: 'Arial', fontSize: 24, x: -12, y: -8, scaleX: 0, scaleY: 0 }],
    }]);

    const visibleCanvas = renderTVGToCanvas(visible, 120, 60, 80);
    const hiddenCanvas = renderTVGToCanvas(hidden, 120, 60, 80);

    expect(visibleCanvas).not.toBeNull();
    expect(hiddenCanvas).not.toBeNull();
    expect(countNonWhitePixelsInRect(visibleCanvas!, 30, 10, 60, 30))
      .toBeGreaterThan(countNonWhitePixelsInRect(hiddenCanvas!, 30, 10, 60, 30) + 20);
  });

  it('renders trailing TGTL labels with off-diagonal transform terms', () => {
    const strokePaint = { kind: 'solid' as const, rgba: { r: 0, g: 0, b: 0, a: 255 } };
    const baseLayer: TVGArtLayer = {
      type: 'line' as const,
      shapes: [{
        shapeType: 7,
        components: [createComponent({
          componentType: 2,
          color: { ...strokePaint.rgba },
          outerPaint: strokePaint,
          strokeWidth: 1,
          path: createPath([
            { type: 'M', x: -20, y: -20 },
            { type: 'L', x: 20, y: 20 },
          ]),
        })],
      }],
      textLabels: [],
    };
    const vertical = createDrawing([{
      ...baseLayer,
      textLabels: [{
        text: 'SIDE',
        fontFamily: 'Arial',
        fontSize: 24,
        x: -10,
        y: -12,
        scaleX: 0,
        scaleY: 0,
        matrixB: 1.2,
        matrixC: -1.2,
      }],
    }]);
    const hidden = createDrawing([{
      ...baseLayer,
      textLabels: [{
        text: 'SIDE',
        fontFamily: 'Arial',
        fontSize: 24,
        x: -10,
        y: -12,
        scaleX: 0,
        scaleY: 0,
        matrixB: 0,
        matrixC: 0,
      }],
    }]);

    const canvas = renderTVGToCanvas(vertical, 120, 120, 80);
    const hiddenCanvas = renderTVGToCanvas(hidden, 120, 120, 80);
    expect(canvas).not.toBeNull();
    expect(hiddenCanvas).not.toBeNull();
    expect(countNonWhitePixelsInRect(canvas!, 0, 0, 120, 120))
      .toBeGreaterThan(countNonWhitePixelsInRect(hiddenCanvas!, 0, 0, 120, 120) + 5);
  });

  it('extracts trailing TGTL text labels from line-layer payload tails', async () => {
    const response = await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip');
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const tvgData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/MC_Lipsync_All/Lipsync_MC_HNDL_1-3.tvg')!.async('arraybuffer');
    const drawing = parseTVG(tvgData);
    const lineLayer = drawing.layers.find(layer => layer.type === 'line');

    expect(lineLayer).toBeDefined();
    expect(lineLayer?.textLabels?.length ?? 0).toBeGreaterThan(5);
    expect(lineLayer?.textLabels?.some(label => label.text.includes('Head_turn'))).toBe(true);
    expect(lineLayer?.textLabels?.some(label => label.text.includes('Character_turn'))).toBe(true);
    expect(lineLayer?.textLabels?.some(label => label.text.includes('M\rClose'))).toBe(true);
    expect(lineLayer?.textLabels?.some(label => /Arial/i.test(label.fontFamily))).toBe(true);
    expect(lineLayer?.textLabels?.some(label => /[ĀḄᔄ]/u.test(label.text))).toBe(false);
    const characterTurn = lineLayer?.textLabels?.find(label => label.text.includes('Character_turn'));
    expect(characterTurn?.fontFamily).toMatch(/Arial/i);
    const normal = lineLayer?.textLabels?.find(label => label.text === 'NORMAL');
    const sad = lineLayer?.textLabels?.find(label => label.text === 'SAD');
    expect(normal?.matrixB && Math.abs(normal.matrixB) > 3).toBe(true);
    expect(normal?.matrixC && Math.abs(normal.matrixC) > 3).toBe(true);
    expect(sad?.matrixB && Math.abs(sad.matrixB) > 3).toBe(true);
    expect(sad?.matrixC && Math.abs(sad.matrixC) > 3).toBe(true);
  });

  it('resolves TGTL label colors through the palette style token', async () => {
    const response = await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip');
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const tvgData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/BASE_Ctrl/BASE_Ctrl-1.tvg')!.async('arraybuffer');
    const drawing = parseTVG(tvgData);
    resolveExternalPalette(drawing, flattenExternalPaletteColors(await loadPalettes(zip)));
    const lineLayer = drawing.layers.find(layer => layer.type === 'line');

    expect(lineLayer?.textLabels).toHaveLength(2);
    expect(lineLayer?.textLabels?.map(label => label.styleToken)).toEqual([0x0c394861, 0x0c394861]);
    expect(lineLayer?.textLabels?.every(label => label.color?.r === 241 && label.color?.g === 138 && label.color?.b === 255 && label.color?.a === 138)).toBe(true);
  });

  it('recovers malformed CREA-wrapped SIGN footers in the Lipsync sample', async () => {
    const response = await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip');
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const tvgData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/MC_Lipsync_All/Lipsync_MC_HNDL_1-3.tvg')!.async('arraybuffer');
    const drawing = parseTVG(tvgData);

    expect(drawing.diagnostics.counts.UNKNOWN_TOP_LEVEL_TAG ?? 0).toBe(0);
    expect(drawing.diagnostics.counts.SCAN_FORWARD_RECOVERY ?? 0).toBe(0);
  });

  it('frames dense Lipsync color guide grids against the source thumbnail', async () => {
    const response = await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip');
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const externalColors = flattenExternalPaletteColors(await loadPalettes(zip));
    const tvgData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/MC_Lipsync_All/Lipsync_MC_HNDL_1-3.tvg')!.async('arraybuffer');
    const thumbData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/MC_Lipsync_All/.thumbnails/.Lipsync_MC_HNDL_1-3.tvg.png')!.async('arraybuffer');
    const drawing = parseTVG(tvgData);
    resolveExternalPalette(drawing, externalColors);

    expect(__shouldInsetViewportForColorGuideGridDrawingForTests(drawing)).toBe(true);

    const canvas = renderTVGToCanvas(drawing, 160, 160, 336);
    expect(canvas).not.toBeNull();
    const reference = await loadImageFromArrayBuffer(thumbData);
    const score = scoreCanvasSources(reference, canvas!, 160);
    expect(score.rawScore).toBeGreaterThan(98);
    expect(score.candidateBounds).toEqual(score.referenceBounds);
  });

  it('keeps unresolved-only color-13 carriers off the full pre-render path', async () => {
    const response = await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip');
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const tvgData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/color.101/color-13.tvg')!.async('arraybuffer');
    const drawing = parseTVG(tvgData);
    resolveExternalPalette(drawing, flattenExternalPaletteColors(await loadPalettes(zip)));
    const lineLayer = drawing.layers.find(layer => layer.type === 'line');

    expect(lineLayer).toBeTruthy();
    const decisions = __debugLineFillDecisions(lineLayer!);
    const shape19 = decisions.find(entry => entry.shapeIndex === 19);
    const shape21 = decisions.find(entry => entry.shapeIndex === 21);

    expect(shape19).toBeTruthy();
    expect(shape19?.preRenderPriority).toBe(0);
    expect(shape19?.preRenderMode).toBe('full');

    expect(shape21).toBeTruthy();
    expect(shape21?.preRenderPriority).toBe(0);
    expect(shape21?.preRenderMode).toBe('full');
    expect(shape21?.preRenderPaintKey).toBeNull();
  });

  it('does not bottom-fill color-13 through unsafe open legacy chains', async () => {
    const response = await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip');
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const externalColors = flattenExternalPaletteColors(await loadPalettes(zip));
    const tvgData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/color.101/color-13.tvg')!.async('arraybuffer');
    const thumbData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/color.101/.thumbnails/.color-13.tvg.png')!.async('arraybuffer');
    const drawing = parseTVG(tvgData);
    resolveExternalPalette(drawing, externalColors);

    const canvas = renderTVGToCanvas(drawing, 160, 160, 336);
    expect(canvas).not.toBeNull();
    const reference = await loadImageFromArrayBuffer(thumbData);
    const score = scoreCanvasSources(reference, canvas!, 160);

    expect(score.rawScore).toBeGreaterThan(83.2);
    expect(score.candidateBounds?.maxY).toBeLessThanOrEqual(143);
  });

  it('resynchronizes padded TTOC chunks before trailing top-level metadata', async () => {
    const response = await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip');
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const tvgData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/color.101/color-13.tvg')!.async('arraybuffer');
    const drawing = parseTVG(tvgData);

    expect(drawing.diagnostics.counts.UNKNOWN_TOP_LEVEL_TAG ?? 0).toBe(0);
    expect(drawing.diagnostics.counts.UNKNOWN_MAIN_DATA_TAG ?? 0).toBe(0);
  });

  it('routes color-13 shape21 through legacy after treating component80 as explicit-build support', async () => {
    const response = await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip');
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const tvgData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/color.101/color-13.tvg')!.async('arraybuffer');
    const drawing = parseTVG(tvgData);
    resolveExternalPalette(drawing, flattenExternalPaletteColors(await loadPalettes(zip)));
    const lineLayer = drawing.layers.find(layer => layer.type === 'line');

    expect(lineLayer).toBeTruthy();

    const contourDebug = __debugBuildContoursForShape(lineLayer!.shapes[21], lineLayer!.type, 21);
    const component80Fragments = contourDebug.fragments.filter(fragment => fragment.componentIndex === 80);
    expect(component80Fragments).toHaveLength(1);
    expect(component80Fragments[0]).toMatchObject({
      styleKey: null,
      supportOnly: true,
    });
    expect(contourDebug.unresolvedChains).toHaveLength(2);
    expect(contourDebug.unresolvedChains.every(chain =>
      chain.styledFragmentCount === 1 && chain.supportFragmentCount >= 40,
    )).toBe(true);

    const strategy = __debugLineFillRenderStrategy(lineLayer!, 21, drawing.layers);
    expect(strategy.preRenderPlan.priority).toBe(0);
    expect(strategy.preRenderPlan.mode).toBe('full');
    expect(strategy.primaryCandidate).toBe('legacy');
    expect(strategy.unresolvedChainCount).toBe(2);
    expect(strategy.siblingBoundaryMaskShapeCount).toBe(0);
  });

  it('recovers a nested legacy parent sample point for color-13 shape21', async () => {
    const response = await fetch('/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip');
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const tvgData = await zip.file('CH_Anna_rig_football_suit_V001_V07/elements/color.101/color-13.tvg')!.async('arraybuffer');
    const drawing = parseTVG(tvgData);
    resolveExternalPalette(drawing, flattenExternalPaletteColors(await loadPalettes(zip)));
    const lineLayer = drawing.layers.find(layer => layer.type === 'line');

    expect(lineLayer).toBeTruthy();

    const legacy = __debugBuildLegacyChainsForShape(lineLayer!.shapes[21]);
    const greenGroup = legacy.groups.find(group => group.key === 'solid:22,198,133,255');
    const nestedChain = greenGroup?.drawableChains.find(chain =>
      chain.componentIndexes.length === 1 && chain.componentIndexes[0] === 74,
    );

    expect(nestedChain?.samplePoint).toBeTruthy();
    expect(nestedChain?.parent).toBe(0);
  });

  it('uses right alignment for mirrored horizontal TGTL labels', () => {
    const layout = __computeTextLabelRenderLayoutForTests({
      text: 'FR',
      fontFamily: 'Arial',
      fontSize: 24,
      x: 100,
      y: 50,
      scaleX: -1,
      scaleY: 1,
      matrixB: 0,
      matrixC: 0,
    });

    expect(layout).not.toBeNull();
    expect(layout?.textAlign).toBe('right');
    expect(layout?.textBaseline).toBe('alphabetic');
    expect(layout?.hasOffDiagonalTransform).toBe(false);
    expect(layout?.transform).toEqual({ a: -1, b: 0, c: 0, d: -1, e: 100, f: 50 });
  });

  it('keeps off-diagonal TGTL labels centered', () => {
    const layout = __computeTextLabelRenderLayoutForTests({
      text: 'NORMAL',
      fontFamily: 'Arial',
      fontSize: 24,
      x: 0,
      y: 0,
      scaleX: 0,
      scaleY: 0,
      matrixB: 4.8,
      matrixC: -4.8,
    });

    expect(layout).not.toBeNull();
    expect(layout?.textAlign).toBe('center');
    expect(layout?.textBaseline).toBe('alphabetic');
    expect(layout?.hasOffDiagonalTransform).toBe(true);
    expect(Math.abs(layout?.baseY ?? 1)).toBe(0);
  });

  it('caps oversized TGTL transform magnitudes while preserving orientation', () => {
    const layout = __computeTextLabelRenderLayoutForTests({
      text: 'Head_turn',
      fontFamily: 'Arial',
      fontSize: 25,
      x: 0,
      y: 0,
      scaleX: 3.128926960824394,
      scaleY: 3.128926960824428,
      matrixB: 0,
      matrixC: 0,
    });

    expect(layout).not.toBeNull();
    expect(layout?.transform.a).toBeCloseTo(1.3, 6);
    expect(layout?.transform.d).toBeCloseTo(-1.3, 6);
    expect(layout?.lines).toEqual(['Head turn']);
    expect(layout?.font).toContain('25px');
  });

});

describe('tvg diagnostics', () => {
  it('records unknown top-level tags instead of failing silently', () => {
    const bytes = new Uint8Array([
      ...ascii('OTVGfull'),
      ...u32le(1009),
      ...u32le(2),
      ...u32le(1),
      ...ascii('ABCD'),
      ...ascii('ENDT'),
    ]);

    const drawing = parseTVG(bytes.buffer);
    expect(drawing.diagnostics.counts.UNKNOWN_TOP_LEVEL_TAG).toBe(1);
  });
});
