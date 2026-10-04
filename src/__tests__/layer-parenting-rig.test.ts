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
 * A holding child under a static parent is drawn as stored, so world-space
 * keys are never double-transformed.
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

  // --- Edge cases (review of #12) -------------------------------------------

  function boneLayer(frames: Frame[], extra: Partial<Layer> = {}): Layer {
    return createLayer({ name: 'Parent', layerType: 'normal', frames, ...extra });
  }
  function boneKey(index: number, duration: number, matrix: Record<string, number>, extra: Partial<Frame> = {}): Frame {
    return createFrame({ index, duration, ...extra, elements: [createSymbolInstance('Bone', { matrix })] });
  }
  function redKey(index: number, duration: number, x: number, y: number, extra: Partial<Frame> = {}): Frame {
    return createFrame({ index, duration, ...extra, elements: [
      createRectangleShape({ x: 0, y: 0, width: 30, height: 30, color: '#FF0000', matrix: { tx: x, ty: y } }),
    ] });
  }
  function docN(totalFrames: number, layers: Layer[], symbols: FlaSymbol[] = [bone()]): FLADocument {
    return createMinimalDoc({
      symbols: new Map(symbols.map((s) => [s.name, s])),
      timelines: [createTimeline({ totalFrames, layers })],
    });
  }

  it('falls back to stored matrices when the parent matrix is singular (scale 0)', async () => {
    const doc = docOf([
      tweenedParent({ a: 0, d: 0, tx: 100, ty: 300 }, { tx: 300, ty: 300 }),
      holdingChild(50, 50, 0),
    ]);
    await renderer.setDocument(doc, true);
    renderer.renderFrame(2);
    expect(isRed(colorAt(65, 65))).toBe(true);
  });

  it('parent layer shorter than the child: composes while the parent exists, stored after', async () => {
    const doc = docOf([
      boneLayer([
        boneKey(0, 2, { tx: 100, ty: 300 }, { tweenType: 'motion' }),
        boneKey(2, 1, { tx: 300, ty: 300 }),
      ]),
      holdingChild(50, 50, 0),
    ]);
    await renderer.setDocument(doc, true);
    renderer.renderFrame(1); // parent +100
    expect(isRed(colorAt(165, 65))).toBe(true);
    renderer.renderFrame(2); // parent +200 (its last frame)
    expect(isRed(colorAt(265, 65))).toBe(true);
    renderer.renderFrame(4); // parent has no frame -> stored world matrix
    expect(isRed(colorAt(65, 65))).toBe(true);
    expect(isRed(colorAt(265, 65))).toBe(false);
  });

  it('parent with an empty keyframe: stored matrices on that frame, composes again after', async () => {
    const doc = docOf([
      boneLayer([
        boneKey(0, 2, { tx: 100, ty: 300 }),
        createFrame({ index: 2, duration: 1, elements: [] }),
        boneKey(3, 2, { tx: 300, ty: 300 }),
      ]),
      holdingChild(50, 50, 0),
    ]);
    await renderer.setDocument(doc, true);
    renderer.renderFrame(2);
    expect(isRed(colorAt(65, 65))).toBe(true);
    renderer.renderFrame(4); // parent +200 since the child keyframe
    expect(isRed(colorAt(265, 65))).toBe(true);
  });

  it('child keyframe inside a parent tween: spans switch exactly at the child key', async () => {
    // Parent tweens tx 100 -> 500 over 0..8 (+50/frame). Child keys at 0 and 4.
    const doc = docN(9, [
      boneLayer([
        boneKey(0, 8, { tx: 100, ty: 300 }, { tweenType: 'motion' }),
        boneKey(8, 1, { tx: 500, ty: 300 }),
      ]),
      createLayer({ name: 'Child', layerType: 'normal', parentLayerIndex: 0, frames: [
        redKey(0, 4, 50, 50),
        redKey(4, 5, 60, 200),
      ] }),
    ]);
    await renderer.setDocument(doc, true);
    renderer.renderFrame(3); // span [0,4): +150 relative to k0
    expect(isRed(colorAt(215, 65))).toBe(true);
    renderer.renderFrame(4); // exactly at the child key: stored
    expect(isRed(colorAt(75, 215))).toBe(true);
    expect(isRed(colorAt(265, 65))).toBe(false);
    renderer.renderFrame(6); // span [4,..): +100 relative to k=4
    expect(isRed(colorAt(175, 215))).toBe(true);
  });

  it('child keyed at exactly the parent keyframe, parent static afterwards: drawn as stored', async () => {
    const doc = docN(9, [
      boneLayer([
        boneKey(0, 4, { tx: 100, ty: 300 }, { tweenType: 'motion' }),
        boneKey(4, 5, { tx: 300, ty: 300 }),
      ]),
      createLayer({ name: 'Child', layerType: 'normal', parentLayerIndex: 0, frames: [
        redKey(0, 4, 50, 50),
        redKey(4, 5, 250, 50),
      ] }),
    ]);
    await renderer.setDocument(doc, true);
    renderer.renderFrame(2);
    expect(isRed(colorAt(165, 65))).toBe(true);
    renderer.renderFrame(6);
    expect(isRed(colorAt(265, 65))).toBe(true);
  });

  it('tweening child with keyframes NOT aligned to the parent interpolates in parent space', async () => {
    // Parent: tx 100 -> 300 over 0..2, then holds to 4. Child tweens 0..4 with
    // world-space keys (50,50) and (350,50) = +100 local motion under a +200 parent.
    const child = createLayer({ name: 'Child', layerType: 'normal', parentLayerIndex: 0, frames: [
      createFrame({ index: 0, duration: 4, tweenType: 'motion',
        elements: [createSymbolInstance('RedSquare', { matrix: { tx: 50, ty: 50 } })] }),
      createFrame({ index: 4, duration: 1,
        elements: [createSymbolInstance('RedSquare', { matrix: { tx: 350, ty: 50 } })] }),
    ] });
    const doc = docOf([
      boneLayer([
        boneKey(0, 2, { tx: 100, ty: 300 }, { tweenType: 'motion' }),
        boneKey(2, 3, { tx: 300, ty: 300 }),
      ]),
      child,
    ], [bone(), redSquareSymbol()]);
    await renderer.setDocument(doc, true);
    // Frame 1: P = +100, local lerp(-50, 50, .25) = -25 -> tx 175 -> center 190.
    renderer.renderFrame(1);
    expect(isRed(colorAt(190, 65))).toBe(true);
    expect(isRed(colorAt(140, 65))).toBe(false); // independent world lerp would be 125
    renderer.renderFrame(4);
    expect(isRed(colorAt(365, 65))).toBe(true);
  });

  it('follows the parent with the parent tween easing', async () => {
    // quadIn: progress at 2/4 is 0.25 -> parent +50, not +100.
    const doc = docOf([
      tweenedParent({ tx: 100, ty: 300 }, { tx: 300, ty: 300 },
        { tweens: [{ target: 'all', method: 'quadIn' }] }),
      holdingChild(50, 50, 0),
    ]);
    await renderer.setDocument(doc, true);
    renderer.renderFrame(2);
    expect(isRed(colorAt(115, 65))).toBe(true);
    expect(isRed(colorAt(165, 65))).toBe(false);
  });

  it('follows a parent that rotates and scales', async () => {
    // Pivot (150,100): identity -> rotate 90deg CW and scale 2. Child center
    // is 50px right of the pivot.
    const doc = docOf([
      tweenedParent(
        { a: 1, b: 0, c: 0, d: 1, tx: 150, ty: 100 },
        { a: 0, b: 2, c: -2, d: 0, tx: 150, ty: 100 },
        { motionTweenRotate: 'cw', motionTweenRotateTimes: 0 },
      ),
      holdingChild(185, 85, 0),
    ]);
    await renderer.setDocument(doc, true);
    renderer.renderFrame(2); // 45deg, scale 1.5 -> offset 75 along 45deg
    expect(isRed(colorAt(150 + 75 * Math.SQRT1_2, 100 + 75 * Math.SQRT1_2))).toBe(true);
    expect(isRed(colorAt(200, 100))).toBe(false);
    renderer.renderFrame(4); // 90deg, scale 2 -> (150, 200); square is now 60x60
    expect(isRed(colorAt(150, 200))).toBe(true);
    expect(isRed(colorAt(150, 226))).toBe(true);
  });

  it('a holding SYMBOL child follows the parent too', async () => {
    const child = createLayer({ name: 'Child', layerType: 'normal', parentLayerIndex: 0, frames: [
      createFrame({ index: 0, duration: 5,
        elements: [createSymbolInstance('RedSquare', { matrix: { tx: 50, ty: 50 } })] }),
    ] });
    const doc = docOf([tweenedParent({ tx: 100, ty: 300 }, { tx: 300, ty: 300 }), child],
      [bone(), redSquareSymbol()]);
    await renderer.setDocument(doc, true);
    renderer.renderFrame(2);
    expect(isRed(colorAt(165, 65))).toBe(true);
    expect(isRed(colorAt(65, 65))).toBe(false);
  });

  it('three-level chain with tweens: rotating grandparent, tweening parent, holding child', async () => {
    // Grandparent: pivot (200,200) rotating 0 -> 90deg CW over 0..4.
    // Parent: world keys T(300,200) at 0 and GP(4)*T(150,0) at 4, i.e. local
    // T(100,0) -> T(150,0). Child holds with its center 30px right of the parent.
    const parent = createLayer({ name: 'Mid', layerType: 'normal', parentLayerIndex: 0, frames: [
      boneKey(0, 4, { tx: 300, ty: 200 }, { tweenType: 'motion' }),
      boneKey(4, 1, { a: 0, b: 1, c: -1, d: 0, tx: 200, ty: 350 }),
    ] });
    const doc = docOf([
      tweenedParent(
        { tx: 200, ty: 200 },
        { a: 0, b: 1, c: -1, d: 0, tx: 200, ty: 200 },
        { motionTweenRotate: 'cw', motionTweenRotateTimes: 0 },
      ),
      parent,
      holdingChild(315, 185, 1),
    ]);
    await renderer.setDocument(doc, true);
    renderer.renderFrame(0);
    expect(isRed(colorAt(330, 200))).toBe(true);
    // Frame 2: Mid = T(200,200) R45 T(125,0); child local offset (30,0)
    // -> 155px from the pivot along 45deg.
    renderer.renderFrame(2);
    const r = 155 * Math.SQRT1_2;
    expect(isRed(colorAt(200 + r, 200 + r))).toBe(true);
    expect(isRed(colorAt(330, 200))).toBe(false);
  });

  it('a rig cycle (A <-> B) renders both layers at their stored matrices without hanging', async () => {
    const a = tweenedParent({ tx: 100, ty: 300 }, { tx: 300, ty: 300 });
    a.parentLayerIndex = 1;
    const b = createLayer({ name: 'B', layerType: 'normal', parentLayerIndex: 0, frames: [
      boneKey(0, 5, { tx: 400, ty: 100 }),
    ] });
    const doc = docOf([a, b, holdingChild(50, 50, 1)]);
    await renderer.setDocument(doc, true);
    renderer.renderFrame(2);
    expect(isRed(colorAt(65, 65))).toBe(true);
  });

  it('a deep tweening chain renders quickly (rig matrices are memoized)', async () => {
    // Every level tweens, so each level needs its parent at t, k0 and k1:
    // without memoization this is 3^depth evaluations per frame.
    const depth = 30;
    const layers: Layer[] = [tweenedParent({ tx: 100, ty: 300 }, { tx: 300, ty: 300 })];
    for (let i = 1; i < depth; i++) {
      layers.push(boneLayer([
        boneKey(0, 4, { tx: 400, ty: 300 + i }, { tweenType: 'motion' }),
        boneKey(4, 1, { tx: 600, ty: 300 + i }),
      ], { parentLayerIndex: i - 1 }));
    }
    layers.push(holdingChild(50, 50, depth - 1));
    const doc = docOf(layers);
    await renderer.setDocument(doc, true);
    const t0 = performance.now();
    renderer.renderFrame(2);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(isRed(colorAt(165, 65))).toBe(true);
  });

  it('a child turning under a static stretched parent turns in the parent\'s space', async () => {
    // Parent stretched 200% x 100%, static. Child world keys are the parent
    // times its local keys: T(100,100) and T(100,100) R90. Halfway the child is
    // P * T(100,100) R45, whose x axis points along atan(0.5) = 26.6 degrees,
    // not a 45 degree turn of the world keys.
    const bar = createSymbol('Bar');
    bar.timeline = createTimeline({ name: 'Bar', totalFrames: 1, layers: [createLayer({ frames: [createFrame({
      elements: [createRectangleShape({ x: 0, y: -5, width: 100, height: 10, color: '#FF0000' })],
    })] })] });
    const child = createLayer({ name: 'Child', layerType: 'normal', parentLayerIndex: 0, frames: [
      createFrame({ index: 0, duration: 4, tweenType: 'motion',
        elements: [createSymbolInstance('Bar', { matrix: { a: 2, d: 1, tx: 200, ty: 100 } })] }),
      createFrame({ index: 4, duration: 1,
        elements: [createSymbolInstance('Bar', { matrix: { a: 0, b: 1, c: -2, d: 0, tx: 200, ty: 100 } })] }),
    ] });
    const doc = docOf([boneLayer([boneKey(0, 5, { a: 2, d: 1, tx: 0, ty: 0 })]), child], [bone(), bar]);
    await renderer.setDocument(doc, true);
    renderer.renderFrame(2);
    // Local x = 80 along the bar: P * (100 + 80 cos45, 100 + 80 sin45).
    expect(isRed(colorAt(200 + 160 * Math.SQRT1_2, 100 + 80 * Math.SQRT1_2))).toBe(true);
    expect(isRed(colorAt(200 + 120 * Math.SQRT1_2, 100 + 120 * Math.SQRT1_2))).toBe(false);
  });

  it('a non-parented timeline renders identically to the same timeline with a static parent', async () => {
    const render = async (parentLayerIndex: number | undefined, parentMoves: boolean) => {
      const parent = parentMoves
        ? tweenedParent({ tx: 100, ty: 300 }, { tx: 300, ty: 300 })
        : boneLayer([boneKey(0, 5, { tx: 100, ty: 300 })]);
      const child = holdingChild(50, 50, 0);
      child.parentLayerIndex = parentLayerIndex;
      await renderer.setDocument(docOf([parent, child]), true);
      renderer.renderFrame(2);
      return Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data);
    };
    const unparentedMoving = await render(undefined, true);
    expect(isRed(colorAt(65, 65))).toBe(true); // tweening sibling does not drag it
    const unparentedStatic = await render(undefined, false);
    const parentedStatic = await render(0, false);
    expect(parentedStatic).toEqual(unparentedStatic);
    expect(unparentedMoving.length).toBe(unparentedStatic.length);
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

  it('getRigParentIndex breaks rig cycles but keeps a tail that leads into one', () => {
    const layers: Layer[] = [
      createLayer({ layerType: 'normal', parentLayerIndex: 1 }), // 0 -> 1
      createLayer({ layerType: 'normal', parentLayerIndex: 2 }), // 1 -> 2
      createLayer({ layerType: 'normal', parentLayerIndex: 0 }), // 2 -> 0 (cycle)
      createLayer({ layerType: 'normal', parentLayerIndex: 1 }), // 3 -> into the cycle
    ];
    expect(getRigParentIndex(layers, 0)).toBeUndefined();
    expect(getRigParentIndex(layers, 1)).toBeUndefined();
    expect(getRigParentIndex(layers, 2)).toBeUndefined();
    expect(getRigParentIndex(layers, 3)).toBe(1);
  });

  it('multiplyMatrices uses the Flash [a c tx; b d ty] convention (m1 applied last)', () => {
    const rot90 = { a: 0, b: 1, c: -1, d: 0, tx: 0, ty: 0 };
    const move = { a: 1, b: 0, c: 0, d: 1, tx: 10, ty: 0 };
    // rotate after moving: (10,0) -> (0,10)
    expect(matricesNearlyEqual(multiplyMatrices(rot90, move), { a: 0, b: 1, c: -1, d: 0, tx: 0, ty: 10 })).toBe(true);
    // move after rotating
    expect(matricesNearlyEqual(multiplyMatrices(move, rot90), { a: 0, b: 1, c: -1, d: 0, tx: 10, ty: 0 })).toBe(true);
  });

  it('invertMatrix / multiplyMatrices round-trip to identity', () => {
    const m = { a: 0.8, b: 0.6, c: -1.2, d: 1.6, tx: 37, ty: -12 };
    const inv = invertMatrix(m)!;
    expect(matricesNearlyEqual(multiplyMatrices(m, inv), { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 })).toBe(true);
    expect(invertMatrix({ a: 0, b: 0, c: 0, d: 0, tx: 1, ty: 1 })).toBeNull();
  });
});
