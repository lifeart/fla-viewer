import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { parsePLT } from '../tpl-palette';
import type { TVGArtLayer, TVGComponent, TVGDrawing, TVGPath } from '../tvg-parser';
import { __borrowMissingPencilPathsForTests, parseTVG, renderTVGToCanvas } from '../tvg-parser';

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
    insideColorId: null,
    paletteIndex: null,
    color: null,
    fillPaintSource: null,
    insideColor: null,
    transform: null,
    path: null,
    strokeWidth: null,
    thicknessProfile: null,
    joinType: 'round',
    fromTipType: 'round',
    toTipType: 'round',
    gradientType: undefined,
    gradientStops: undefined,
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

function u32le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
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

  it('does not synthesize fills for closed pencil loops on line layers', () => {
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
