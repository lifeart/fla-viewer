import { describe, it, expect, beforeEach } from 'vitest';
import { FLARenderer } from '../renderer';
import type { FLADocument, Frame, Layer, Symbol as FlaSymbol } from '../types';
import { getRigParentIndex, invertMatrix, multiplyMatrices, matricesNearlyEqual } from '../layer-utils';
import {
  createMinimalDoc,
  createTimeline,
  createLayer,
  createFrame,
  createRectangleShape,
  createSymbol,
  createSymbolInstance,
} from './test-utils';

/**
 * Live rig composition BETWEEN child keyframes (issue #12).
 *
 * Model (see getRigCorrection in renderer.ts): a parented child's keyframes are
 * stored world-space (the parent is baked in at author time — see
 * layer-parenting.test.ts), but Animate evaluates the rig live, so between child
 * keyframes the child follows the parent's motion relative to where the parent
 * was at the child keyframe:
 *   world(t) = P(t) * inv(P(k0)) * C0                       (holding child)
 *   world(t) = P(t) * lerp(inv(P(k0))*C0, inv(P(k1))*C1)     (tweening child)
 * It is the identity whenever the parent is static across the child's span, so
 * world-space keys are never double-transformed.
 */
describe('Layer parenting: live rig composition between child keyframes', () => {
  let canvas: HTMLCanvasElement;
  let renderer: FLARenderer;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 550;
    canvas.height = 400;
    renderer = new FLARenderer(canvas);
  });

  function colorAt(x: number, y: number): [number, number, number, number] {
    const ctx = canvas.getContext('2d')!;
    const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  }
  const isRed = (c: [number, number, number, number]) =>
    c[3] > 0 && c[0] > 200 && c[1] < 80 && c[2] < 80;

  // 10x10 blue marker symbol used as the rig parent (the parent must be a
  // single symbol instance for its transform to be determinable).
  function bone(): FlaSymbol {
    const s = createSymbol('Bone');
    s.timeline = createTimeline({
      name: 'Bone',
      totalFrames: 1,
      layers: [createLayer({ frames: [createFrame({ elements: [
        createRectangleShape({ x: 0, y: 0, width: 10, height: 10, color: '#0000FF' }),
      ] })] })],
    });
    return s;
  }
  function redSquareSymbol(): FlaSymbol {
    const s = createSymbol('RedSquare');
    s.timeline = createTimeline({
      name: 'RedSquare',
      totalFrames: 1,
      layers: [createLayer({ frames: [createFrame({ elements: [
        createRectangleShape({ x: 0, y: 0, width: 30, height: 30, color: '#FF0000' }),
      ] })] })],
    });
    return s;
  }

  // Parent layer: a Bone symbol classic-tweened between two matrices over 0..4.
  function tweenedParent(
    from: Record<string, number>,
    to: Record<string, number>,
    extra: Partial<Frame> = {}
  ): Layer {
    return createLayer({
      name: 'Parent',
      layerType: 'normal',
      frames: [
        createFrame({ index: 0, duration: 4, tweenType: 'motion', ...extra,
          elements: [createSymbolInstance('Bone', { matrix: from })] }),
        createFrame({ index: 4, duration: 1,
          elements: [createSymbolInstance('Bone', { matrix: to })] }),
      ],
    });
  }

  // Child layer holding ONE keyframe (0..4) with a red 30x30 shape at world (x,y).
  function holdingChild(x: number, y: number, parentLayerIndex: number): Layer {
    return createLayer({
      name: 'Child',
      layerType: 'normal',
      parentLayerIndex,
      frames: [createFrame({ index: 0, duration: 5, elements: [
        createRectangleShape({ x: 0, y: 0, width: 30, height: 30, color: '#FF0000', matrix: { tx: x, ty: y } }),
      ] })],
    });
  }

  function docOf(layers: Layer[], symbols: FlaSymbol[] = [bone()]): FLADocument {
    return createMinimalDoc({
      symbols: new Map(symbols.map((s) => [s.name, s])),
      timelines: [createTimeline({ totalFrames: 5, layers })],
    });
  }

  it('a holding child follows a tweening parent (translation)', async () => {
    // Parent moves +200 in x over frames 0..4; child holds one keyframe at (50,50).
    const doc = docOf([
      tweenedParent({ tx: 100, ty: 300 }, { tx: 300, ty: 300 }),
      holdingChild(50, 50, 0),
    ]);
    await renderer.setDocument(doc, true);

    renderer.renderFrame(0); // at the child keyframe: stored world matrix, exactly
    expect(isRed(colorAt(65, 65))).toBe(true);

    renderer.renderFrame(2); // parent +100 -> child +100
    expect(isRed(colorAt(165, 65))).toBe(true);
    expect(isRed(colorAt(65, 65))).toBe(false);

    renderer.renderFrame(4); // parent +200 -> child +200
    expect(isRed(colorAt(265, 65))).toBe(true);
  });

  it('a holding child orbits a rotating parent (arc, not chord)', async () => {
    // Parent pivot at (200,200), rotating 0 -> 90deg CW (rotation-aware tween).
    // Child center sits 100px right of the pivot at frame 0: (300,200).
    const doc = docOf([
      tweenedParent(
        { a: 1, b: 0, c: 0, d: 1, tx: 200, ty: 200 },
        { a: 0, b: 1, c: -1, d: 0, tx: 200, ty: 200 },
        { motionTweenRotate: 'cw', motionTweenRotateTimes: 0 },
      ),
      holdingChild(285, 185, 0),
    ]);
    await renderer.setDocument(doc, true);

    renderer.renderFrame(0);
    expect(isRed(colorAt(300, 200))).toBe(true);

    // Frame 2: parent at 45deg -> child center rotated about the pivot:
    // (200 + 100cos45, 200 + 100sin45) = (270.7, 270.7)
    renderer.renderFrame(2);
    expect(isRed(colorAt(270.7, 270.7))).toBe(true);
    expect(isRed(colorAt(300, 200))).toBe(false); // not left behind
    expect(isRed(colorAt(250, 250))).toBe(false); // not on the straight chord
  });

  it('chains: a child of a holding parent follows a tweening grandparent', async () => {
    const holdingParent = createLayer({
      name: 'Mid',
      layerType: 'normal',
      parentLayerIndex: 0,
      frames: [createFrame({ index: 0, duration: 5,
        elements: [createSymbolInstance('Bone', { matrix: { tx: 400, ty: 350 } })] })],
    });
    const doc = docOf([
      tweenedParent({ tx: 100, ty: 300 }, { tx: 300, ty: 300 }),
      holdingParent,
      holdingChild(50, 50, 1),
    ]);
    await renderer.setDocument(doc, true);
    renderer.renderFrame(2);
    expect(isRed(colorAt(165, 65))).toBe(true);
  });

  it('a tweening child with keyframes aligned to the parent is not double-transformed', async () => {
    // Weird-Al topology with a SYMBOL parent: both tween, child keys are world
    // space (parent motion baked in). Must match independent interpolation.
    const child = createLayer({
      name: 'Child',
      layerType: 'normal',
      parentLayerIndex: 0,
      frames: [
        createFrame({ index: 0, duration: 4, tweenType: 'motion',
          elements: [createSymbolInstance('RedSquare', { matrix: { tx: 50, ty: 50 } })] }),
        createFrame({ index: 4, duration: 1,
          elements: [createSymbolInstance('RedSquare', { matrix: { tx: 150, ty: 50 } })] }),
      ],
    });
    const doc = docOf(
      [tweenedParent({ tx: 100, ty: 300 }, { tx: 200, ty: 300 }), child],
      [bone(), redSquareSymbol()],
    );
    await renderer.setDocument(doc, true);

    renderer.renderFrame(2);
    expect(isRed(colorAt(115, 65))).toBe(true);
    expect(isRed(colorAt(165, 65))).toBe(false); // not doubly advanced
    renderer.renderFrame(4);
    expect(isRed(colorAt(165, 65))).toBe(true);
  });

  it('per-frame world-space child keys under a moving parent are drawn as stored', async () => {
    // A child keyed on every frame: each span starts on the current frame, so
    // P(t) == P(k0) and the correction is the identity.
    const frames = [0, 1, 2, 3, 4].map((i) => createFrame({ index: i, duration: 1, elements: [
      createRectangleShape({ x: 0, y: 0, width: 30, height: 30, color: '#FF0000', matrix: { tx: 50 + i * 10, ty: 50 } }),
    ] }));
    const child = createLayer({ name: 'Child', layerType: 'normal', parentLayerIndex: 0, frames });
    const doc = docOf([tweenedParent({ tx: 100, ty: 300 }, { tx: 300, ty: 300 }), child]);
    await renderer.setDocument(doc, true);
    renderer.renderFrame(2);
    expect(isRed(colorAt(85, 65))).toBe(true); // stored tx 70 -> center 85
    expect(isRed(colorAt(185, 65))).toBe(false);
  });

  it('does not compose through a guide (motion guide) parent link', async () => {
    const guide = tweenedParent({ tx: 100, ty: 300 }, { tx: 300, ty: 300 });
    guide.layerType = 'guide';
    const doc = docOf([guide, holdingChild(50, 50, 0)]);
    await renderer.setDocument(doc, true);
    renderer.renderFrame(2);
    expect(isRed(colorAt(65, 65))).toBe(true);
  });

  it('falls back to stored matrices when the parent transform is undeterminable', async () => {
    // Parent frame holds two elements -> no single rig transform.
    const parent = tweenedParent({ tx: 100, ty: 300 }, { tx: 300, ty: 300 });
    parent.frames[0].elements.push(createSymbolInstance('Bone', { matrix: { tx: 10, ty: 380 } }));
    const doc = docOf([parent, holdingChild(50, 50, 0)]);
    await renderer.setDocument(doc, true);
    renderer.renderFrame(2);
    expect(isRed(colorAt(65, 65))).toBe(true);
  });

  it('applies inside symbol timelines too (nested rig)', async () => {
    const rig = createSymbol('Rig');
    rig.timeline = createTimeline({
      name: 'Rig',
      totalFrames: 5,
      layers: [tweenedParent({ tx: 100, ty: 300 }, { tx: 300, ty: 300 }), holdingChild(50, 50, 0)],
    });
    const doc = createMinimalDoc({
      symbols: new Map([['Bone', bone()], ['Rig', rig]]),
      timelines: [createTimeline({ totalFrames: 5, layers: [
        createLayer({ frames: [createFrame({ index: 0, duration: 5,
          elements: [createSymbolInstance('Rig', { loop: 'loop' })] })] }),
      ] })],
    });
    await renderer.setDocument(doc, true);
    renderer.renderFrame(2);
    expect(isRed(colorAt(165, 65))).toBe(true);
  });
});

describe('layer-utils rig helpers', () => {
  it('getRigParentIndex only links normal -> normal layers', () => {
    const layers: Layer[] = [
      createLayer({ layerType: 'normal' }),
      createLayer({ layerType: 'folder' }),
      createLayer({ layerType: 'guide' }),
      createLayer({ layerType: 'normal', parentLayerIndex: 0 }),
      createLayer({ layerType: 'normal', parentLayerIndex: 1 }),
      createLayer({ layerType: 'normal', parentLayerIndex: 2 }),
      createLayer({ layerType: 'normal', parentLayerIndex: 6 }), // self
      createLayer({ layerType: 'masked', parentLayerIndex: 0, maskLayerIndex: 0 }),
    ];
    expect(getRigParentIndex(layers, 3)).toBe(0);
    expect(getRigParentIndex(layers, 4)).toBeUndefined();
    expect(getRigParentIndex(layers, 5)).toBeUndefined();
    expect(getRigParentIndex(layers, 6)).toBeUndefined();
    expect(getRigParentIndex(layers, 7)).toBeUndefined();
    expect(getRigParentIndex(layers, 0)).toBeUndefined();
  });

  it('invertMatrix / multiplyMatrices round-trip to identity', () => {
    const m = { a: 0.8, b: 0.6, c: -1.2, d: 1.6, tx: 37, ty: -12 };
    const inv = invertMatrix(m)!;
    expect(matricesNearlyEqual(multiplyMatrices(m, inv), { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 })).toBe(true);
    expect(invertMatrix({ a: 0, b: 0, c: 0, d: 0, tx: 1, ty: 1 })).toBeNull();
  });
});
