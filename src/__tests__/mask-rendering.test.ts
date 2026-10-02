import { describe, it, expect, beforeEach } from 'vitest';
import JSZip from 'jszip';
import { FLARenderer } from '../renderer';
import { FLAParser } from '../fla-parser';
import type { DisplayElement, Layer, MorphCurve, Symbol } from '../types';
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
