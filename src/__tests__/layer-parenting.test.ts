import { describe, it, expect, beforeEach } from 'vitest';
import { FLARenderer } from '../renderer';
import type { FLADocument } from '../types';
import {
  createMinimalDoc,
  createTimeline,
  createLayer,
  createFrame,
  createRectangleShape,
  createSymbol,
  createSymbolInstance,
} from './test-utils';
import type { Symbol as FlaSymbol } from '../types';

/**
 * Regression guard for Adobe Animate "Layer Parenting" (issue #12 follow-up).
 *
 * EMPIRICAL FINDING (from "The Weird Al Show - Intro.fla", the only true
 * normal-layer parenting rig among the available sample files):
 *
 *   When a NORMAL <DOMLayer> is used as a parent (Animate "Layer Parenting"),
 *   the child layers' stored keyframe matrices are already WORLD-SPACE. Adobe
 *   bakes the parent's transform into every child keyframe at author time, so
 *   the child keyframes (and their motion tweens) carry the parent's motion.
 *
 *   Concretely, over the parent's f274->f289 motion tween in that file:
 *     - parent tx moved 613.05 -> 713.60 (+100.55)
 *     - Left_Arm child tx moved 452.20 -> 552.05 (+99.85)
 *     - Right_Arm child tx moved 426.75 -> 526.60 (+99.85)
 *   i.e. the children already track the parent. Computing
 *   inv(parentWorld) * childWorld yields a ~constant "local" matrix
 *   (tx 248.73 -> 249.44 across the tween), confirming the children are
 *   stored in world space.
 *
 * CONSEQUENCE: the renderer must draw each parented child layer using its
 * stored matrix AS-IS. Composing childWorld = parentWorld * childStored would
 * DOUBLE-transform the rig and break it. These tests fail if such blanket
 * parent->child composition is ever introduced.
 */
describe('Layer parenting (normal-layer parent) transform composition', () => {
  let canvas: HTMLCanvasElement;
  let renderer: FLARenderer;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 550;
    canvas.height = 400;
    renderer = new FLARenderer(canvas);
  });

  // Read a single pixel as [r,g,b,a]. With setDocument(doc, true) the renderer
  // uses scale=1, dpr=1, so document coordinates map 1:1 to canvas pixels.
  function colorAt(x: number, y: number): [number, number, number, number] {
    const ctx = canvas.getContext('2d')!;
    const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  }
  const isRed = (c: [number, number, number, number]) =>
    c[3] > 0 && c[0] > 200 && c[1] < 80 && c[2] < 80;

  /**
   * Builds a 2-layer scene mirroring the Weird Al rig topology:
   *   layer[0] = NORMAL parent, translated +300 in x (a blue marker)
   *   layer[1] = child, parentLayerIndex=0, a red 30x30 square whose stored
   *              (world-space) matrix places it near the top-left at (50,50).
   */
  function buildParentedScene(): FLADocument {
    const parentLayer = createLayer({
      name: 'Parent',
      layerType: 'normal',
      frames: [
        createFrame({
          duration: 1,
          elements: [
            // Blue 20x20 marker, translated far to the right.
            createRectangleShape({
              x: 0,
              y: 0,
              width: 20,
              height: 20,
              color: '#0000FF',
              fillIndex: 1,
              matrix: { tx: 300, ty: 300 },
            }),
          ],
        }),
      ],
    });

    const childLayer = createLayer({
      name: 'Child',
      layerType: 'normal',
      parentLayerIndex: 0,
      frames: [
        createFrame({
          duration: 1,
          elements: [
            // Red 30x30 square at world-space (50,50).
            createRectangleShape({
              x: 0,
              y: 0,
              width: 30,
              height: 30,
              color: '#FF0000',
              fillIndex: 1,
              matrix: { tx: 50, ty: 50 },
            }),
          ],
        }),
      ],
    });

    return createMinimalDoc({
      timelines: [
        createTimeline({
          totalFrames: 1,
          layers: [parentLayer, childLayer],
        }),
      ],
    });
  }

  it('draws a parented child at its stored world-space position (no parent composition)', async () => {
    const doc = buildParentedScene();
    await renderer.setDocument(doc, /* skipResize */ true);
    renderer.renderFrame(0);

    // Child's world-space center is (65,65). It MUST render there.
    expect(isRed(colorAt(65, 65))).toBe(true);

    // If blanket composition (parentWorld * childStored) were applied, the
    // child would be shifted by the parent's +300 tx and land near (365,65).
    // The original spot would then be empty. Assert the child is NOT shifted.
    expect(isRed(colorAt(365, 65))).toBe(false);
  });

  it('would mis-place the child if parent translation were composed in (documents the trap)', async () => {
    // This test makes the failure mode explicit: it computes where naive
    // composition WOULD put the child and asserts nothing red is rendered
    // there, proving the renderer does not compose.
    const doc = buildParentedScene();
    await renderer.setDocument(doc, true);
    renderer.renderFrame(0);

    // Composed position would be child(50) + parent(300) = 350, center ~365.
    const composedSpotEmpty = !isRed(colorAt(360, 60)) && !isRed(colorAt(365, 65)) && !isRed(colorAt(370, 70));
    expect(composedSpotEmpty).toBe(true);
  });

  it('keeps a tweened child glued to a tweened parent under independent interpolation', async () => {
    // Mirrors the Weird Al f274->f289 segment: both parent and child carry a
    // motion tween whose world-space keyframes move by the same amount. The
    // renderer interpolates each layer independently; because both keyframe
    // sets are world-space, the child stays at a fixed offset from the parent
    // throughout the tween (the rig does not drift apart).
    //
    // The Weird Al rig parts are SYMBOL instances (motion-tween matrix
    // interpolation only runs for symbols), so this test uses a library symbol
    // that draws a 30x30 red square.
    const redSquare: FlaSymbol = createSymbol('RedSquare');
    redSquare.timeline = createTimeline({
      name: 'RedSquare',
      totalFrames: 1,
      layers: [
        createLayer({
          frames: [
            createFrame({
              elements: [
                createRectangleShape({
                  x: 0, y: 0, width: 30, height: 30, color: '#FF0000',
                }),
              ],
            }),
          ],
        }),
      ],
    });

    const parentLayer = createLayer({
      name: 'Parent',
      layerType: 'normal',
      frames: [
        createFrame({
          index: 0,
          duration: 4,
          tweenType: 'motion',
          elements: [
            createRectangleShape({
              x: 0, y: 0, width: 20, height: 20, color: '#0000FF',
              matrix: { tx: 100, ty: 200 },
            }),
          ],
        }),
        createFrame({
          index: 4,
          duration: 1,
          elements: [
            createRectangleShape({
              x: 0, y: 0, width: 20, height: 20, color: '#0000FF',
              matrix: { tx: 200, ty: 200 }, // parent moves +100 in x
            }),
          ],
        }),
      ],
    });

    const childLayer = createLayer({
      name: 'Child',
      layerType: 'normal',
      parentLayerIndex: 0,
      frames: [
        createFrame({
          index: 0,
          duration: 4,
          tweenType: 'motion',
          elements: [
            // world-space; child origin at (50,50), offset -50 from parent in x
            createSymbolInstance('RedSquare', { matrix: { tx: 50, ty: 50 } }),
          ],
        }),
        createFrame({
          index: 4,
          duration: 1,
          elements: [
            // child ALSO moves +100 (parent motion baked into child keyframe)
            createSymbolInstance('RedSquare', { matrix: { tx: 150, ty: 50 } }),
          ],
        }),
      ],
    });

    const doc = createMinimalDoc({
      symbols: new Map([['RedSquare', redSquare]]),
      timelines: [
        createTimeline({ totalFrames: 5, layers: [parentLayer, childLayer] }),
      ],
    });

    await renderer.setDocument(doc, true);

    // At frame 0: child at world tx=50 -> center ~(65,65).
    renderer.renderFrame(0);
    expect(isRed(colorAt(65, 65))).toBe(true);

    // At frame 2 (mid-tween, progress 0.5): child world tx = 100 -> center ~(115,65).
    renderer.renderFrame(2);
    expect(isRed(colorAt(115, 65))).toBe(true);
    // It must NOT still be at the start position only, nor doubly-advanced.
    expect(isRed(colorAt(215, 65))).toBe(false);

    // At frame 4 (end): child world tx=150 -> center ~(165,65).
    renderer.renderFrame(4);
    expect(isRed(colorAt(165, 65))).toBe(true);
  });
});
