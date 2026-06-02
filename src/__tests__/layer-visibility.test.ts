import { describe, it, expect, beforeEach } from 'vitest';
import { FLARenderer } from '../renderer';
import {
  createMinimalDoc,
  createTimeline,
  createLayer,
  createFrame,
  createRectangleShape,
  hasColor,
} from './test-utils';

// Issue #12: the renderer must honor the FLA's layer `visible` flag, and a
// hidden folder (group) or hidden parent layer must hide everything linked
// under it via parentLayerIndex. Each layer paints a distinctly-colored
// rectangle so we can assert presence/absence on the canvas.
const RED = '#FF0000'; //   a normal, visible layer
const GREEN = '#00FF00'; // a directly-hidden layer
const BLUE = '#0000FF'; //  a child of a folder
const MAGENTA = '#FF00FF'; // a layer parented to a normal layer

function rectLayer(color: string, x: number, overrides = {}) {
  return createLayer({
    frames: [
      createFrame({
        elements: [createRectangleShape({ x, y: 0, width: 80, height: 80, color })],
      }),
    ],
    ...overrides,
  });
}

describe('layer visibility (issue #12: group / parent-child link)', () => {
  let canvas: HTMLCanvasElement;
  let renderer: FLARenderer;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 550;
    canvas.height = 400;
    renderer = new FLARenderer(canvas);
  });

  const render = async (layers: ReturnType<typeof createLayer>[]) => {
    const doc = createMinimalDoc({
      timelines: [createTimeline({ layers, totalFrames: 1 })],
    });
    await renderer.setDocument(doc);
    renderer.renderFrame(0);
  };

  it('renders visible layers and skips a layer marked visible="false"', async () => {
    await render([
      rectLayer(RED, 0, { visible: true }),
      rectLayer(GREEN, 200, { visible: false }),
    ]);
    expect(hasColor(canvas, RED)).toBe(true); //   visible layer drawn
    expect(hasColor(canvas, GREEN)).toBe(false); // hidden layer skipped
  });

  it('cascades a hidden folder (group) to its child layers', async () => {
    // Layer 0 is a hidden folder; layer 1 is parented under it.
    await render([
      createLayer({ name: 'group', layerType: 'folder', visible: false }),
      rectLayer(BLUE, 0, { name: 'child', parentLayerIndex: 0 }),
    ]);
    expect(hasColor(canvas, BLUE)).toBe(false); // child hidden with its group

    // Control: the same child renders when the folder is visible.
    await render([
      createLayer({ name: 'group', layerType: 'folder', visible: true }),
      rectLayer(BLUE, 0, { name: 'child', parentLayerIndex: 0 }),
    ]);
    expect(hasColor(canvas, BLUE)).toBe(true);
  });

  it('cascades a hidden parent layer to its parented (linked) children', async () => {
    // Layer 0 is a hidden NORMAL parent; layer 1 is parented to it (rig link).
    await render([
      createLayer({ name: 'parent', visible: false }),
      rectLayer(MAGENTA, 0, { name: 'arm', parentLayerIndex: 0 }),
    ]);
    expect(hasColor(canvas, MAGENTA)).toBe(false); // parented child hidden

    // Control: visible parent => parented child renders.
    await render([
      createLayer({ name: 'parent', visible: true }),
      rectLayer(MAGENTA, 0, { name: 'arm', parentLayerIndex: 0 }),
    ]);
    expect(hasColor(canvas, MAGENTA)).toBe(true);
  });

  it('does not over-hide: a visible child under a visible parent renders', async () => {
    await render([
      createLayer({ name: 'parent', visible: true }),
      rectLayer(RED, 0, { name: 'child', parentLayerIndex: 0, visible: true }),
    ]);
    expect(hasColor(canvas, RED)).toBe(true);
  });

  // Mask groups must honor visibility too (the MASK render path previously
  // bypassed the cascade entirely). A masked child's parentLayerIndex points at
  // its mask layer, so isLayerVisibleInFla covers both "child hidden" and
  // (transitively) "mask hidden".
  describe('mask groups honor visibility', () => {
    // Mask covers the whole drawn area; masked content sits inside the clip so
    // it is visible whenever the group is shown.
    const maskLayer = (overrides = {}) =>
      createLayer({
        name: 'mask',
        layerType: 'mask',
        frames: [
          createFrame({
            elements: [
              createRectangleShape({ x: 0, y: 0, width: 300, height: 300, color: '#FFFFFF' }),
            ],
          }),
        ],
        ...overrides,
      });

    const maskedChild = (color: string, overrides = {}) =>
      rectLayer(color, 0, {
        name: 'masked',
        layerType: 'masked',
        maskLayerIndex: 0,
        parentLayerIndex: 0, // masked child is linked under its mask layer
        ...overrides,
      });

    it('hides a whole mask group when the MASK layer is hidden', async () => {
      await render([
        maskLayer({ visible: false }),
        maskedChild(RED, { visible: true }),
      ]);
      // Hidden mask => its masked content must NOT be drawn.
      expect(hasColor(canvas, RED)).toBe(false);
    });

    it('hides the mask group via the MASK guard even without a parent link', async () => {
      // Masked child linked ONLY via maskLayerIndex (no parentLayerIndex), so the
      // parent-visibility cascade cannot help — this isolates the mask-block
      // guard itself (bug #1). A hidden mask must still hide its child.
      await render([
        maskLayer({ visible: false }),
        rectLayer(MAGENTA, 0, {
          name: 'masked',
          layerType: 'masked',
          maskLayerIndex: 0,
          visible: true,
        }),
      ]);
      expect(hasColor(canvas, MAGENTA)).toBe(false);
    });

    it('hides a MASKED child when only the child is hidden (mask visible)', async () => {
      await render([
        maskLayer({ visible: true }),
        maskedChild(GREEN, { visible: false }),
      ]);
      // Hidden masked child => not drawn even though the mask is visible.
      expect(hasColor(canvas, GREEN)).toBe(false);
    });

    it('control: visible mask + visible masked child renders the content', async () => {
      await render([
        maskLayer({ visible: true }),
        maskedChild(BLUE, { visible: true }),
      ]);
      expect(hasColor(canvas, BLUE)).toBe(true);
    });
  });
});
