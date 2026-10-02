import { describe, it, expect, beforeEach } from 'vitest';
import JSZip from 'jszip';
import { FLARenderer } from '../renderer';
import { FLAParser } from '../fla-parser';
import { getMaskLayerIndex } from '../layer-utils';
import type { DisplayElement, Layer, MorphCurve, Symbol, Timeline } from '../types';
import {
  createMinimalDoc,
  createTimeline,
  createLayer,
  createFrame,
  createRectangleShape,
  createSymbol,
  createSymbolInstance,
  createTextInstance,
  hasColor,
} from './test-utils';

// Issue #47 "Broken Masking": masked content showed outside the mask. Each test
// places masked content both INSIDE the mask area (must be drawn) and OUTSIDE
// it (must be clipped away), each in a distinct color.
const RED = '#FF0000'; //  masked content inside the mask
const GREEN = '#00FF00'; // masked content outside the mask
const BLUE = '#0000FF';

const rect = (x: number, color: string, y = 0, size = 50) =>
  createRectangleShape({ x, y, width: size, height: size, color });

const maskLayer = (elements: DisplayElement[], overrides: Partial<Layer> = {}) =>
  createLayer({
    name: 'mask',
    layerType: 'mask',
    frames: [createFrame({ elements })],
    ...overrides,
  });

const maskedLayer = (elements: DisplayElement[], overrides: Partial<Layer> = {}) =>
  createLayer({
    name: 'masked',
    layerType: 'masked',
    maskLayerIndex: 0,
    parentLayerIndex: 0,
    frames: [createFrame({ elements, duration: 20 })],
    ...overrides,
  });

describe('mask rendering (issue #47)', () => {
  let canvas: HTMLCanvasElement;
  let renderer: FLARenderer;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 550;
    canvas.height = 400;
    renderer = new FLARenderer(canvas);
  });

  const render = async (layers: Layer[], symbols: Symbol[] = [], frame = 0) => {
    const doc = createMinimalDoc({
      timelines: [createTimeline({ layers, totalFrames: 20 })],
      symbols: new Map(symbols.map((s) => [s.name, s])),
    });
    await renderer.setDocument(doc);
    renderer.renderFrame(frame);
  };

  it('control: a raw shape mask clips masked content', async () => {
    await render([
      maskLayer([rect(0, '#FFFFFF')]),
      maskedLayer([rect(0, RED), rect(300, GREEN)]),
    ]);
    expect(hasColor(canvas, RED)).toBe(true);
    expect(hasColor(canvas, GREEN)).toBe(false);
  });

  it('clips to the shapes inside a symbol instance used as the mask', async () => {
    // Previously a symbol mask clipped to a 20000px "full rect" fallback, so
    // masked content was never clipped.
    const maskSymbol = createSymbol('MaskShape', {
      timeline: { layers: [createLayer({ frames: [createFrame({ elements: [rect(0, '#FFFFFF')] })] })] },
    });
    await render(
      [
        maskLayer([createSymbolInstance('MaskShape', { matrix: { tx: 100 } })]),
        maskedLayer([rect(100, RED), rect(300, GREEN)]),
      ],
      [maskSymbol]
    );
    expect(hasColor(canvas, RED)).toBe(true);
    expect(hasColor(canvas, GREEN)).toBe(false);
  });

  it('clips to shapes nested two symbols deep (transforms composed)', async () => {
    const inner = createSymbol('Inner', {
      timeline: { layers: [createLayer({ frames: [createFrame({ elements: [rect(0, '#FFFFFF')] })] })] },
    });
    const outer = createSymbol('Outer', {
      timeline: {
        layers: [createLayer({
          frames: [createFrame({ elements: [createSymbolInstance('Inner', { matrix: { tx: 50 } })] })],
        })],
      },
    });
    await render(
      [
        maskLayer([createSymbolInstance('Outer', { matrix: { tx: 100 } })]),
        maskedLayer([rect(150, RED), rect(0, GREEN), rect(300, BLUE)]),
      ],
      [inner, outer]
    );
    expect(hasColor(canvas, RED)).toBe(true);
    expect(hasColor(canvas, GREEN)).toBe(false);
    expect(hasColor(canvas, BLUE)).toBe(false);
  });

  it('unions multiple mask shapes instead of intersecting them', async () => {
    // Previously ctx.clip() ran once per shape, intersecting disjoint mask
    // shapes down to nothing.
    await render([
      maskLayer([rect(0, '#FFFFFF'), rect(300, '#FFFFFF')]),
      maskedLayer([rect(0, RED), rect(300, GREEN), rect(150, BLUE)]),
    ]);
    expect(hasColor(canvas, RED)).toBe(true);
    expect(hasColor(canvas, GREEN)).toBe(true);
    expect(hasColor(canvas, BLUE)).toBe(false);
  });

  it('clips to a text field mask by its bounds', async () => {
    // Previously non-shape/non-symbol mask content was ignored entirely, so
    // the masked layer rendered with no clip at all.
    await render([
      maskLayer([createTextInstance('MASK', { left: 0, width: 50, height: 50, size: 40 })]),
      maskedLayer([rect(0, RED), rect(300, GREEN)]),
    ]);
    expect(hasColor(canvas, RED)).toBe(true);
    expect(hasColor(canvas, GREEN)).toBe(false);
  });

  it('follows a motion-tweened symbol mask', async () => {
    const maskSymbol = createSymbol('MaskShape', {
      timeline: { layers: [createLayer({ frames: [createFrame({ elements: [rect(0, '#FFFFFF')] })] })] },
    });
    const mask = createLayer({
      name: 'mask',
      layerType: 'mask',
      frames: [
        createFrame({
          index: 0,
          duration: 10,
          tweenType: 'motion',
          elements: [createSymbolInstance('MaskShape', { matrix: { tx: 0 } })],
        }),
        createFrame({
          index: 10,
          duration: 10,
          elements: [createSymbolInstance('MaskShape', { matrix: { tx: 300 } })],
        }),
      ],
    });
    // Halfway through the tween the mask sits at x=150.
    await render([mask, maskedLayer([rect(150, RED), rect(0, GREEN)])], [maskSymbol], 5);
    expect(hasColor(canvas, RED)).toBe(true);
    expect(hasColor(canvas, GREEN)).toBe(false);
  });

  it('follows a shape-tweened mask', async () => {
    const line = (ax: number, ay: number, bx: number, by: number): MorphCurve => ({
      controlPointA: { x: ax, y: ay },
      anchorPointA: { x: ax, y: ay },
      controlPointB: { x: bx, y: by },
      anchorPointB: { x: bx, y: by },
      isLine: true,
    });
    const mask = createLayer({
      name: 'mask',
      layerType: 'mask',
      frames: [
        createFrame({
          index: 0,
          duration: 10,
          tweenType: 'shape',
          elements: [rect(0, '#FFFFFF')],
          morphShape: {
            segments: [{
              startPointA: { x: 0, y: 0 },
              startPointB: { x: 300, y: 0 },
              fillIndex1: 1,
              curves: [
                line(50, 0, 350, 0),
                line(50, 50, 350, 50),
                line(0, 50, 300, 50),
                line(0, 0, 300, 0),
              ],
            }],
          },
        }),
        createFrame({ index: 10, duration: 10, elements: [rect(300, '#FFFFFF')] }),
      ],
    });
    await render([mask, maskedLayer([rect(150, RED), rect(0, GREEN)])], [], 5);
    expect(hasColor(canvas, RED)).toBe(true);
    expect(hasColor(canvas, GREEN)).toBe(false);
  });

  it('clips a masked layer that only has layerType="masked" (no index link)', async () => {
    // e.g. binary FLAs record the layer type but not the parent link.
    await render([
      maskLayer([rect(0, '#FFFFFF')]),
      maskedLayer([rect(0, RED), rect(300, GREEN)], {
        maskLayerIndex: undefined,
        parentLayerIndex: undefined,
      }),
    ]);
    expect(hasColor(canvas, RED)).toBe(true);
    expect(hasColor(canvas, GREEN)).toBe(false);
  });

  it('clips layers inside a folder that sits in a mask group', async () => {
    await render([
      maskLayer([rect(0, '#FFFFFF')]),
      createLayer({ name: 'folder', layerType: 'folder', parentLayerIndex: 0 }),
      createLayer({
        name: 'child',
        parentLayerIndex: 1,
        frames: [createFrame({ elements: [rect(0, RED), rect(300, GREEN)] })],
      }),
    ]);
    expect(hasColor(canvas, RED)).toBe(true);
    expect(hasColor(canvas, GREEN)).toBe(false);
  });

  it('keeps the stacking order of multiple masked layers', async () => {
    // Layer 1 is above layer 2, so RED must cover GREEN where they overlap.
    await render([
      maskLayer([rect(0, '#FFFFFF', 0, 100)]),
      maskedLayer([rect(0, RED, 0, 100)]),
      maskedLayer([rect(0, GREEN, 0, 100)]),
    ]);
    expect(hasColor(canvas, RED)).toBe(true);
    expect(hasColor(canvas, GREEN)).toBe(false);
  });

  it('applies masks inside a symbol timeline', async () => {
    const masked = createSymbol('Masked', {
      timeline: {
        layers: [
          maskLayer([rect(0, '#FFFFFF')]),
          maskedLayer([rect(0, RED), rect(300, GREEN)]),
        ],
      },
    });
    await render(
      [createLayer({ frames: [createFrame({ elements: [createSymbolInstance('Masked')] })] })],
      [masked]
    );
    expect(hasColor(canvas, RED)).toBe(true);
    expect(hasColor(canvas, GREEN)).toBe(false);
  });
});

describe('mask relationships in the XFL parser (issue #47)', () => {
  const parse = async (layersXml: string) => {
    const zip = new JSZip();
    zip.file('DOMDocument.xml', `<?xml version="1.0" encoding="UTF-8"?>
<DOMDocument width="550" height="400" frameRate="24">
  <timelines><DOMTimeline name="Scene 1"><layers>${layersXml}</layers></DOMTimeline></timelines>
</DOMDocument>`);
    const blob = await zip.generateAsync({ type: 'blob' });
    const doc = await new FLAParser().parse(new File([blob], 'test.fla'));
    return doc.timelines[0].layers;
  };
  const empty = '<frames><DOMFrame index="0"><elements/></DOMFrame></frames>';

  it('masks the children of a folder nested in a mask group, keeping the folder a folder', async () => {
    const layers = await parse(`
      <DOMLayer name="Mask" layerType="mask">${empty}</DOMLayer>
      <DOMLayer name="Folder" layerType="folder" parentLayerIndex="0"/>
      <DOMLayer name="Child" parentLayerIndex="1">${empty}</DOMLayer>`);
    expect(layers[1].layerType).toBe('folder');
    expect(layers[1].maskLayerIndex).toBeUndefined();
    expect(layers[2].layerType).toBe('masked');
    expect(layers[2].maskLayerIndex).toBe(0);
  });

  it('does not turn a guide layer under a mask into renderable masked content', async () => {
    const layers = await parse(`
      <DOMLayer name="Mask" layerType="mask">${empty}</DOMLayer>
      <DOMLayer name="Guide" layerType="guide" parentLayerIndex="0">${empty}</DOMLayer>
      <DOMLayer name="Masked" layerType="masked" parentLayerIndex="0">${empty}</DOMLayer>`);
    expect(layers[1].layerType).toBe('guide');
    expect(layers[1].maskLayerIndex).toBeUndefined();
    expect(layers[2].maskLayerIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Review coverage for the #47 masking change: every behaviour case of the mask
// path builder and the mask-group render loops, sampled at exact pixels.
// ---------------------------------------------------------------------------

const WHITE = '#FFFFFF';

// A rectangle whose fill is on fillStyle0 with the edges running clockwise on
// screen — its fill contour winds OPPOSITE to createRectangleShape and
// Path2D.rect(). Real Animate data produces both orientations.
const reversedRect = (x: number, y = 0, size = 50): DisplayElement => ({
  type: 'shape',
  matrix: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
  fills: [{ index: 1, type: 'solid', color: WHITE }],
  strokes: [],
  edges: [{
    fillStyle0: 1,
    commands: [
      { type: 'M', x, y },
      { type: 'L', x: x + size, y },
      { type: 'L', x: x + size, y: y + size },
      { type: 'L', x, y: y + size },
      { type: 'Z' },
    ],
  }],
});

// A shape whose only style is a stroke (no fill area).
const strokeOnlyRect = (x: number): DisplayElement => ({
  type: 'shape',
  matrix: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
  fills: [],
  strokes: [{ index: 1, type: 'solid', color: '#000000', weight: 20 }],
  edges: [{
    strokeStyle: 1,
    commands: [
      { type: 'M', x, y: 0 },
      { type: 'L', x: x + 50, y: 0 },
      { type: 'L', x: x + 50, y: 50 },
      { type: 'L', x, y: 50 },
      { type: 'Z' },
    ],
  }],
});

const symbolOf = (name: string, layers: Layer[], totalFrames = 1) =>
  createSymbol(name, { timeline: { layers, totalFrames } });

// A symbol whose single shape sits at x=0 on frames [0, switchAt) and at
// x=300 on frames [switchAt, totalFrames).
const movingSymbol = (name: string, switchAt: number, totalFrames: number) =>
  symbolOf(name, [createLayer({
    frames: [
      createFrame({ index: 0, duration: switchAt, elements: [rect(0, WHITE)] }),
      createFrame({ index: switchAt, duration: totalFrames - switchAt, elements: [rect(300, WHITE)] }),
    ],
  })], totalFrames);

// Colour at document coordinate (x, y); the canvas is scaled to fit the window.
const colorAtDoc = (canvas: HTMLCanvasElement, x: number, y: number): string => {
  const s = canvas.width / 550;
  const d = canvas.getContext('2d')!.getImageData(Math.floor(x * s), Math.floor(y * s), 1, 1).data;
  return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
};

describe('mask rendering: review coverage (issue #47)', () => {
  let canvas: HTMLCanvasElement;
  let renderer: FLARenderer;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    renderer = new FLARenderer(canvas);
  });

  const docOf = (layers: Layer[], symbols: Symbol[] = [], extra: Partial<Timeline> = {}) =>
    createMinimalDoc({
      timelines: [createTimeline({ layers, totalFrames: 20, ...extra })],
      symbols: new Map(symbols.map((s) => [s.name, s])),
    });

  const render = async (layers: Layer[], symbols: Symbol[] = [], frame = 0, extra: Partial<Timeline> = {}) => {
    await renderer.setDocument(docOf(layers, symbols, extra));
    renderer.renderFrame(frame);
  };

  const colorAt = (x: number, y: number) => colorAtDoc(canvas, x, y);

  // Masked content in three 50px cells at x=0, 150 and 300 (y 0..50).
  const cells = (overrides: Partial<Layer> = {}) =>
    maskedLayer([rect(0, RED), rect(150, GREEN), rect(300, BLUE)], overrides);
  const visible = () => [colorAt(25, 25), colorAt(175, 25), colorAt(325, 25)];
  const maskWith = (elements: DisplayElement[], overrides: Partial<Layer> = {}) =>
    maskLayer([], { frames: [createFrame({ duration: 20, elements })], ...overrides });

  it('clips in camera space when an auto-detected camera layer is active', async () => {
    // The camera pans 100px right: the mask at doc x=150 must land on screen
    // x=50..100 together with the masked content (clip and content share the CTM).
    await render(
      [
        maskWith([rect(150, WHITE)]),
        cells(),
        createLayer({
          name: 'camera', layerType: 'guide',
          frames: [createFrame({ duration: 20, elements: [createSymbolInstance('Cam', { matrix: { tx: 100 } })] })],
        }),
      ],
      [symbolOf('Cam', [])], 0, { cameraLayerIndex: 2 }
    );
    expect(colorAt(75, 25)).toBe(GREEN);
    expect(colorAt(175, 25)).toBe(WHITE); // where GREEN would be without the camera
    expect(hasColor(canvas, RED)).toBe(false);
    expect(hasColor(canvas, BLUE)).toBe(false);
  });

  it('clips in the zoomed view space', async () => {
    await renderer.setDocument(docOf([maskWith([rect(150, WHITE)]), cells()]));
    renderer.zoomIn();
    renderer.renderFrame(0);
    expect(hasColor(canvas, GREEN)).toBe(true);
    expect(hasColor(canvas, RED)).toBe(false);
    expect(hasColor(canvas, BLUE)).toBe(false);
  });

  it('uses the frame a looping graphic symbol mask shows at a later parent frame', async () => {
    await render([maskWith([createSymbolInstance('Moving')]), cells()], [movingSymbol('Moving', 3, 6)], 4);
    expect(visible()).toEqual([WHITE, WHITE, BLUE]);
  });

  it('clamps a play-once symbol mask at its last frame', async () => {
    await render(
      [maskWith([createSymbolInstance('Moving', { loop: 'play once' })]), cells()],
      [movingSymbol('Moving', 2, 3)], 15
    );
    expect(visible()).toEqual([WHITE, WHITE, BLUE]);
  });

  it('holds a single-frame symbol mask on its firstFrame', async () => {
    await render(
      [maskWith([createSymbolInstance('Moving', { loop: 'single frame', firstFrame: 0 })]), cells()],
      [movingSymbol('Moving', 2, 3)], 15
    );
    expect(visible()).toEqual([RED, WHITE, WHITE]);
  });

  it('offsets a looping symbol mask from its own keyframe start, not frame 0', async () => {
    // The mask keyframe starts at 10, so at parent frame 11 the symbol is on frame 1.
    await render([
      maskLayer([], { frames: [
        createFrame({ index: 0, duration: 10, elements: [rect(150, WHITE)] }),
        createFrame({ index: 10, duration: 10, elements: [createSymbolInstance('Moving')] }),
      ] }),
      cells(),
    ], [movingSymbol('Moving', 2, 4)], 11);
    expect(visible()).toEqual([RED, WHITE, WHITE]);
  });

  it('starts a movieclip mask on its own playhead (frame 0)', async () => {
    await render(
      [maskWith([createSymbolInstance('Moving', { symbolType: 'movieclip' })]), cells()],
      [movingSymbol('Moving', 2, 4)], 15
    );
    expect(visible()).toEqual([RED, WHITE, WHITE]);
  });

  it('renders masked layers unclipped on an empty mask keyframe', async () => {
    await render([
      maskLayer([], { frames: [
        createFrame({ index: 0, duration: 5, elements: [rect(150, WHITE)] }),
        createFrame({ index: 5, duration: 15, elements: [] }),
      ] }),
      cells(),
    ], [], 7);
    expect(visible()).toEqual([RED, GREEN, BLUE]);
  });

  it('renders masked layers unclipped after the mask layer ends', async () => {
    await render([maskLayer([], { frames: [createFrame({ duration: 5, elements: [rect(150, WHITE)] })] }), cells()], [], 10);
    expect(visible()).toEqual([RED, GREEN, BLUE]);
  });

  it('hides the masked content when the mask holds only a stroke (no fill area)', async () => {
    await render([maskWith([strokeOnlyRect(150)]), cells()]);
    expect(visible()).toEqual([WHITE, WHITE, WHITE]);
    expect(hasColor(canvas, '#000000')).toBe(false); // the mask itself never draws
  });

  it('hides the whole group when the mask layer is hidden', async () => {
    await render([maskWith([rect(150, WHITE)], { visible: false }), cells()]);
    expect(visible()).toEqual([WHITE, WHITE, WHITE]);
  });

  it('honors UI-hidden masked layers with and without mask content', async () => {
    renderer.setHiddenLayers(new Set([1]));
    await render([maskWith([rect(150, WHITE)]), cells()]);
    expect(visible()).toEqual([WHITE, WHITE, WHITE]);
    await render([maskWith([]), cells()]);
    expect(visible()).toEqual([WHITE, WHITE, WHITE]);
  });

  it('keeps two mask groups in one timeline independent', async () => {
    await render([
      maskWith([rect(0, WHITE)]),
      maskedLayer([rect(0, RED), rect(150, RED)]),
      maskWith([rect(300, WHITE)]),
      maskedLayer([rect(150, GREEN), rect(300, GREEN)], { maskLayerIndex: 2, parentLayerIndex: 2 }),
      createLayer({ name: 'plain', frames: [createFrame({ duration: 20, elements: [rect(150, BLUE, 60)] })] }),
    ]);
    expect(visible()).toEqual([RED, WHITE, GREEN]);
    expect(colorAt(175, 85)).toBe(BLUE); // the unmasked layer is clipped by neither
  });

  it('stops an unlinked masked run at an interrupting normal layer (binary FLA)', async () => {
    const unlinked = { maskLayerIndex: undefined, parentLayerIndex: undefined };
    await render([
      maskWith([rect(0, WHITE)]),
      maskedLayer([rect(0, RED), rect(150, RED)], unlinked),
      createLayer({ name: 'normal', frames: [createFrame({ duration: 20, elements: [rect(150, GREEN, 60)] })] }),
      maskedLayer([rect(300, BLUE)], unlinked),
    ]);
    expect(colorAt(25, 25)).toBe(RED);
    expect(colorAt(175, 25)).toBe(WHITE);
    expect(colorAt(175, 85)).toBe(GREEN);
    // Outside the run the trailing 'masked' layer has no mask: drawn plainly.
    expect(colorAt(325, 25)).toBe(BLUE);
  });

  it('still draws a masked layer whose maskLayerIndex points at a non-mask layer', async () => {
    await render([
      createLayer({ name: 'normal', frames: [createFrame({ duration: 20, elements: [rect(0, GREEN, 60)] })] }),
      maskedLayer([rect(0, RED)]),
    ]);
    expect(colorAt(25, 25)).toBe(RED);
    expect(colorAt(25, 85)).toBe(GREEN);
  });

  it('unions overlapping mask shapes whose fill contours wind oppositely', async () => {
    // In ONE nonzero path, opposite windings cancel where they overlap.
    await render([
      maskWith([rect(100, WHITE, 0, 100), reversedRect(150, 0, 100)]),
      maskedLayer([rect(0, RED, 0, 300)]),
    ]);
    expect(colorAt(125, 50)).toBe(RED);
    expect(colorAt(175, 50)).toBe(RED); // overlap
    expect(colorAt(225, 50)).toBe(RED);
    expect(colorAt(50, 50)).toBe(WHITE);
    expect(colorAt(275, 50)).toBe(WHITE);
  });

  it('unions a text-bounds mask with an overlapping oppositely-wound shape', async () => {
    await render([
      maskWith([
        reversedRect(100, 0, 100),
        createTextInstance('T', { left: 0, width: 100, height: 100, matrix: { tx: 150 } }),
      ]),
      maskedLayer([rect(0, RED, 0, 300)]),
    ]);
    expect(colorAt(125, 50)).toBe(RED);
    expect(colorAt(175, 50)).toBe(RED); // overlap
    expect(colorAt(225, 50)).toBe(RED);
  });

  it('unions a mirrored symbol mask instance with an overlapping unmirrored one', async () => {
    const sq = symbolOf('Sq', [createLayer({ frames: [createFrame({ elements: [rect(0, WHITE, 0, 100)] })] })]);
    await render([
      maskWith([
        createSymbolInstance('Sq', { matrix: { tx: 100 } }), // 100..200
        createSymbolInstance('Sq', { matrix: { a: -1, tx: 250 } }), // 150..250
      ]),
      maskedLayer([rect(0, RED, 0, 300)]),
    ], [sq]);
    expect(colorAt(125, 50)).toBe(RED);
    expect(colorAt(175, 50)).toBe(RED); // overlap
    expect(colorAt(225, 50)).toBe(RED);
  });

  it('unions a shape-tween mask with an overlapping oppositely-wound shape', async () => {
    const line = (x: number, y: number): MorphCurve => ({
      controlPointA: { x, y }, anchorPointA: { x, y }, controlPointB: { x, y }, anchorPointB: { x, y }, isLine: true,
    });
    const mask = maskLayer([], { frames: [
      createFrame({
        index: 0, duration: 10, tweenType: 'shape',
        elements: [
          rect(100, WHITE, 0, 100),
          createTextInstance('T', { left: 0, width: 100, height: 100, matrix: { tx: 150 } }),
        ],
        // Counter-clockwise on screen, unlike Path2D.rect() for the text bounds.
        morphShape: { segments: [{
          startPointA: { x: 100, y: 0 }, startPointB: { x: 100, y: 0 }, fillIndex1: 1,
          curves: [line(100, 100), line(200, 100), line(200, 0), line(100, 0)],
        }] },
      }),
      createFrame({ index: 10, duration: 10, elements: [rect(100, WHITE, 0, 100)] }),
    ] });
    // The shape becomes the morph (100..200); the text bounds cover 150..250.
    await render([mask, maskedLayer([rect(0, RED, 0, 300)])], [], 5);
    expect(colorAt(125, 50)).toBe(RED);
    expect(colorAt(175, 50)).toBe(RED); // overlap
    expect(colorAt(225, 50)).toBe(RED);
    expect(colorAt(275, 50)).toBe(WHITE);
  });

  it('ignores fill regions whose style index has no FillStyle (they are never painted)', async () => {
    const orphan = { ...rect(150, WHITE), fills: [] } as DisplayElement;
    await render([maskWith([rect(0, WHITE), orphan]), cells()]);
    expect(visible()).toEqual([RED, WHITE, WHITE]);
  });

  it('places text, bitmap and video mask bounds with their matrices', async () => {
    const doc = docOf([
      maskWith([
        createTextInstance('T', { left: 10, width: 30, height: 50, matrix: { tx: -10 } }), // 0..30
        { type: 'bitmap', libraryItemName: 'bmp', matrix: { a: 1, b: 0, c: 0, d: 1, tx: 150, ty: 0 } }, // 150..170
        { type: 'video', libraryItemName: 'vid', width: 25, height: 50, matrix: { a: 2, b: 0, c: 0, d: 1, tx: 300, ty: 0 } }, // 300..350
      ]),
      cells(),
    ]);
    doc.bitmaps.set('bmp', { name: 'bmp', href: 'bmp', width: 20, height: 50 });
    await renderer.setDocument(doc);
    renderer.renderFrame(0);
    expect(colorAt(5, 25)).toBe(RED);
    expect(colorAt(40, 25)).toBe(WHITE);
    expect(colorAt(165, 25)).toBe(GREEN);
    expect(colorAt(185, 25)).toBe(WHITE);
    expect(colorAt(345, 25)).toBe(BLUE);
  });

  it('follows a rotating motion-tween mask (motionTweenRotate)', async () => {
    // A 100x10 bar pivoting at (200,100) rotates 0 -> 90deg; halfway it points
    // down-right at 45deg.
    const bar = symbolOf('Bar', [createLayer({ frames: [createFrame({
      elements: [createRectangleShape({ x: 0, y: -5, width: 100, height: 10, color: WHITE })],
    })] })]);
    const mask = maskLayer([], { frames: [
      createFrame({
        index: 0, duration: 10, tweenType: 'motion', motionTweenRotate: 'cw', motionTweenRotateTimes: 0,
        elements: [createSymbolInstance('Bar', { matrix: { tx: 200, ty: 100 } })],
      }),
      createFrame({
        index: 10, duration: 10,
        elements: [createSymbolInstance('Bar', { matrix: { a: 0, b: 1, c: -1, d: 0, tx: 200, ty: 100 } })],
      }),
    ] });
    await render([mask, maskedLayer([createRectangleShape({ x: 0, y: 0, width: 550, height: 400, color: RED })])], [bar], 5);
    expect(colorAt(200 + 50 * Math.SQRT1_2, 100 + 50 * Math.SQRT1_2)).toBe(RED);
    expect(colorAt(250, 100)).toBe(WHITE);
    expect(colorAt(200, 150)).toBe(WHITE);
  });

  it("ignores a nested mask layer's own shapes inside a symbol used as a mask", async () => {
    const nested = symbolOf('Nested', [maskLayer([rect(300, WHITE)]), maskedLayer([rect(0, WHITE)])]);
    await render([maskWith([createSymbolInstance('Nested')]), cells()], [nested]);
    expect(visible()).toEqual([RED, WHITE, WHITE]);
  });

  it('does not hang on a symbol mask that contains itself', async () => {
    const loop = symbolOf('Loop', [createLayer({ frames: [createFrame({
      elements: [rect(0, WHITE), createSymbolInstance('Loop', { matrix: { ty: 1 } })],
    })] })]);
    await render([maskWith([createSymbolInstance('Loop')]), cells()], [loop]);
    expect(colorAt(25, 25)).toBe(RED);
    expect(colorAt(325, 25)).toBe(WHITE);
  });

  it('keeps masked stacking with layerOrder forward', async () => {
    renderer.setLayerOrder('forward');
    await render([
      maskWith([rect(0, WHITE, 0, 100)]),
      maskedLayer([rect(0, RED, 0, 100)]),
      maskedLayer([rect(0, GREEN, 0, 100)]),
    ]);
    // 'forward' paints index 0 first, so the higher index (GREEN) ends on top.
    expect(colorAt(50, 50)).toBe(GREEN);
  });
});

describe('non-mask drawing is unchanged by the mask refactor', () => {
  let canvas: HTMLCanvasElement;
  let renderer: FLARenderer;
  beforeEach(() => {
    canvas = document.createElement('canvas');
    renderer = new FLARenderer(canvas);
  });

  // Symbol 'Moving' (3 frames): RED at x=0 on frames 0-1, at x=300 on frame 2.
  const renderFrames = async (frames: ReturnType<typeof createFrame>[], frame: number) => {
    const moving = createSymbol('Moving', { timeline: { totalFrames: 3, layers: [createLayer({ frames: [
      createFrame({ index: 0, duration: 2, elements: [rect(0, RED)] }),
      createFrame({ index: 2, duration: 1, elements: [rect(300, RED)] }),
    ] })] } });
    await renderer.setDocument(createMinimalDoc({
      timelines: [createTimeline({ totalFrames: 20, layers: [createLayer({ frames })] })],
      symbols: new Map([['Moving', moving]]),
    }));
    renderer.renderFrame(frame);
  };
  const renderInst = (inst: DisplayElement, frame: number) =>
    renderFrames([createFrame({ duration: 20, elements: [inst] })], frame);
  const sample = () => [colorAtDoc(canvas, 25, 25), colorAtDoc(canvas, 325, 25)];

  it('graphic loop / play once / single frame / movieclip pick the same symbol frames', async () => {
    await renderInst(createSymbolInstance('Moving'), 4); // (0 + 4) % 3 = 1
    expect(sample()).toEqual([RED, WHITE]);
    await renderInst(createSymbolInstance('Moving'), 5); // 2
    expect(sample()).toEqual([WHITE, RED]);
    await renderInst(createSymbolInstance('Moving', { loop: 'play once' }), 15);
    expect(sample()).toEqual([WHITE, RED]);
    await renderInst(createSymbolInstance('Moving', { loop: 'single frame', firstFrame: 2 }), 0);
    expect(sample()).toEqual([WHITE, RED]);
    await renderInst(createSymbolInstance('Moving', { symbolType: 'movieclip' }), 15);
    expect(sample()).toEqual([RED, WHITE]);
  });

  it('interpolates motion-tweened symbol matrices as before', async () => {
    await renderFrames([
      createFrame({ index: 0, duration: 10, tweenType: 'motion',
        elements: [createSymbolInstance('Moving', { loop: 'single frame', matrix: { tx: 0 } })] }),
      createFrame({ index: 10, duration: 10,
        elements: [createSymbolInstance('Moving', { loop: 'single frame', matrix: { tx: 100 } })] }),
    ], 5);
    expect(colorAtDoc(canvas, 75, 25)).toBe(RED); // shifted by 50: 50..100
    expect(colorAtDoc(canvas, 25, 25)).toBe(WHITE);
  });
});

describe('getMaskLayerIndex', () => {
  const L = (o: Partial<Layer> = {}): Layer => createLayer(o);

  it('resolves a direct child, a folder-nested child and an explicit link', () => {
    const layers = [
      L({ layerType: 'mask' }),
      L({ parentLayerIndex: 0 }),
      L({ layerType: 'folder', parentLayerIndex: 0 }),
      L({ parentLayerIndex: 2 }),
      L({ layerType: 'masked', maskLayerIndex: 0 }),
    ];
    expect(getMaskLayerIndex(layers, 0)).toBeUndefined(); // the mask itself
    expect(getMaskLayerIndex(layers, 1)).toBe(0);
    expect(getMaskLayerIndex(layers, 2)).toBeUndefined(); // folders are never masked
    expect(getMaskLayerIndex(layers, 3)).toBe(0);
    expect(getMaskLayerIndex(layers, 4)).toBe(0);
    expect(getMaskLayerIndex(layers, 9)).toBeUndefined();
  });

  it('never masks guide layers', () => {
    expect(getMaskLayerIndex([L({ layerType: 'mask' }), L({ layerType: 'guide', parentLayerIndex: 0 })], 1)).toBeUndefined();
  });

  it('terminates on a parentLayerIndex cycle', () => {
    const layers = [
      L({ layerType: 'folder', parentLayerIndex: 1 }),
      L({ layerType: 'folder', parentLayerIndex: 0 }),
      L({ parentLayerIndex: 0 }),
    ];
    expect(getMaskLayerIndex(layers, 2)).toBeUndefined();
    expect(getMaskLayerIndex([L({ parentLayerIndex: 0 })], 0)).toBeUndefined(); // self-parent
  });

  it('ignores an explicit maskLayerIndex that is not a mask layer or out of range', () => {
    expect(getMaskLayerIndex([L(), L({ layerType: 'masked', maskLayerIndex: 0 })], 1)).toBeUndefined();
    expect(getMaskLayerIndex([L({ layerType: 'masked', maskLayerIndex: 7 })], 0)).toBeUndefined();
    expect(getMaskLayerIndex([L({ layerType: 'masked', maskLayerIndex: 0 })], 0)).toBeUndefined();
  });

  it('resolves an unlinked masked run and stops at an interrupting layer', () => {
    const layers = [
      L({ layerType: 'mask' }),
      L({ layerType: 'masked' }),
      L({ layerType: 'masked' }),
      L(),
      L({ layerType: 'masked' }),
    ];
    expect(getMaskLayerIndex(layers, 1)).toBe(0);
    expect(getMaskLayerIndex(layers, 2)).toBe(0);
    expect(getMaskLayerIndex(layers, 3)).toBeUndefined();
    expect(getMaskLayerIndex(layers, 4)).toBeUndefined();
  });

  it('does not treat a layer parented to a normal layer (rig) as masked', () => {
    expect(getMaskLayerIndex([L(), L({ parentLayerIndex: 0 })], 1)).toBeUndefined();
  });
});
