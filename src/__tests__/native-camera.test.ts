import { describe, it, expect, beforeEach } from 'vitest';
import JSZip from 'jszip';
import { FLAParser } from '../fla-parser';
import { FLARenderer } from '../renderer';
import { exportSVG } from '../video-exporter';
import {
  LAYER_DEPTH_FOCAL_LENGTH,
  cameraViewMatrix,
  layerZDepthAt,
  stageLayerViews,
} from '../native-camera';
import type { FLADocument, Matrix, SymbolInstance } from '../types';

// Animate's native camera (CC 2017+) and layer depth (Animate 2019+). The XML
// mirrors real Animate saves: eliasku/animate-tests assets/camera_layer (Animate
// 20, attachedToCamera layers), joao-cesar/adobe parallax_effect (Animate 19,
// frameZDepth parallax) and dailybruin lessons-in-laughter (Animate 18, camera
// zoom tween and a frameZDepth tween), whose published HTML5 output gives the
// expected behavior (`_applyLayerZDepth`, `AdobeAn.VirtualCamera`).

const W = 550;
const H = 400;
const RED = '#FF0000';
const BLUE = '#0000FF';
const WHITE = '#FFFFFF';

async function parseXfl(files: Record<string, string>): Promise<FLADocument> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return new FLAParser().parse(await zip.generateAsync({ type: 'uint8array' }));
}

function domDocument(layers: string, timelineAttrs = 'cameraLayerEnabled="true" layerDepthEnabled="true"'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<DOMDocument xmlns="http://ns.adobe.com/xfl/2008/" width="${W}" height="${H}" frameRate="24" backgroundColor="#FFFFFF" xflVersion="2.97">
  <timelines><DOMTimeline name="Scene 1" ${timelineAttrs}><layers>${layers}</layers></DOMTimeline></timelines>
</DOMDocument>`;
}

const cameraInstance = (matrix: string) =>
  `<DOMSymbolInstance libraryItemName="__Camera__" name="___camera___instance" isVisible="false">
    <matrix><Matrix ${matrix}/></matrix><transformationPoint><Point/></transformationPoint>
  </DOMSymbolInstance>`;

/** The camera layer as Animate saves it, one keyframe per entry. */
function cameraLayer(keys: { index: number; duration: number; matrix: string; attrs?: string }[]): string {
  const frames = keys.map((k) => `<DOMFrame index="${k.index}" duration="${k.duration}" keyMode="9728" ${k.attrs ?? ''}>
    <elements>${cameraInstance(k.matrix)}</elements></DOMFrame>`).join('');
  return `<DOMLayer name="Camera" color="#0099FF" autoNamed="false" layerType="camera"><frames>${frames}</frames></DOMLayer>`;
}

/** A solid rectangle shape (fill style 1). */
function rectShape(x: number, y: number, w: number, h: number, color: string): string {
  const t = (v: number) => v * 20; // twips
  return `<DOMShape><fills><FillStyle index="1"><SolidColor color="${color}"/></FillStyle></fills>
  <edges><Edge fillStyle1="1" edges="!${t(x)} ${t(y)}|${t(x + w)} ${t(y)}|${t(x + w)} ${t(y + h)}|${t(x)} ${t(y + h)}|${t(x)} ${t(y)}"/></edges>
</DOMShape>`;
}

function contentLayer(name: string, shapes: string, attrs = '', frameAttrs = '', duration = 20): string {
  return `<DOMLayer name="${name}" ${attrs}><frames><DOMFrame index="0" duration="${duration}" keyMode="9728" ${frameAttrs}>
    <elements>${shapes}</elements></DOMFrame></frames></DOMLayer>`;
}

const colorAt = (canvas: HTMLCanvasElement, x: number, y: number): string => {
  const s = canvas.width / W;
  const d = canvas.getContext('2d')!.getImageData(Math.floor(x * s), Math.floor(y * s), 1, 1).data;
  return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
};

const CENTERED = `tx="${W / 2}" ty="${H / 2}"`; // the default camera: stage center, zoom 100%

describe('native camera parsing', () => {
  it('finds the camera layer and keeps it out of the rendered layers', async () => {
    const doc = await parseXfl({
      'DOMDocument.xml': domDocument(
        cameraLayer([{ index: 0, duration: 20, matrix: 'a="1.78900146484375" d="1.78900146484375" tx="31.55" ty="277.55"' }]) +
        contentLayer('Layer_1', rectShape(0, 0, 10, 10, RED))
      ),
    });
    const timeline = doc.timelines[0];
    expect(timeline.nativeCameraLayerIndex).toBe(0);
    expect(timeline.cameraLayerIndex).toBeUndefined();
    expect(timeline.referenceLayers.has(0)).toBe(true);
    const camera = timeline.layers[0].frames[0].elements[0] as SymbolInstance;
    expect(camera.libraryItemName).toBe('__Camera__');
    expect(camera.matrix).toMatchObject({ a: 1.78900146484375, d: 1.78900146484375, tx: 31.55, ty: 277.55 });
  });

  it('ignores a camera the timeline marks disabled', async () => {
    const doc = await parseXfl({
      'DOMDocument.xml': domDocument(cameraLayer([{ index: 0, duration: 1, matrix: CENTERED }]), 'cameraLayerEnabled="false"'),
    });
    expect(doc.timelines[0].nativeCameraLayerIndex).toBeUndefined();
  });

  it('reads attachedToCamera on layers and folders', async () => {
    const doc = await parseXfl({
      'DOMDocument.xml': domDocument(
        cameraLayer([{ index: 0, duration: 1, matrix: CENTERED }]) +
        '<DOMLayer name="Folder 1" color="#009999" layerType="folder"/>' +
        '<DOMLayer name="folder2" color="#FF0000" parentLayerIndex="1" autoNamed="false" layerType="folder" attachedToCamera="true"/>' +
        contentLayer('camera_overlay', rectShape(0, 0, 10, 10, RED), 'parentLayerIndex="2" attachedToCamera="true"') +
        contentLayer('Layer_1', rectShape(0, 0, 10, 10, BLUE))
      ),
    });
    const layers = doc.timelines[0].layers;
    expect(layers[2].attachedToCamera).toBe(true);
    expect(layers[3].attachedToCamera).toBe(true);
    expect(layers[4].attachedToCamera).toBeUndefined();
  });

  it('reads frameZDepth onto keyframes (absent is depth 0)', async () => {
    const doc = await parseXfl({
      'DOMDocument.xml': domDocument(
        `<DOMLayer name="chairs"><frames>
          <DOMFrame index="0" duration="71" tweenType="motion" motionTweenSnap="true" keyMode="22017" frameZDepth="-3"><elements>${rectShape(0, 0, 10, 10, RED)}</elements></DOMFrame>
          <DOMFrame index="71" duration="2" tweenType="motion" motionTweenSnap="true" keyMode="22017" frameZDepth="-39"><elements>${rectShape(0, 0, 10, 10, RED)}</elements></DOMFrame>
        </frames></DOMLayer>` +
        contentLayer('Level_0', rectShape(0, 0, 10, 10, BLUE))
      ),
    });
    const [chairs, level0] = doc.timelines[0].layers;
    expect(chairs.frames.map((f) => f.zDepth)).toEqual([-3, -39]);
    expect(level0.frames[0].zDepth).toBeUndefined();
  });
});

describe('native camera math', () => {
  const identity: Matrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

  it('the default camera at the stage center gives an identity view', () => {
    const view = cameraViewMatrix({ ...identity, tx: W / 2, ty: H / 2 }, W, H)!;
    expect(view.a).toBeCloseTo(1, 9);
    expect(view.d).toBeCloseTo(1, 9);
    expect(view.tx).toBeCloseTo(0, 9);
    expect(view.ty).toBeCloseTo(0, 9);
  });

  it('views every layer through the camera except those attached to it', () => {
    const layer = (attachedToCamera?: boolean) => ({
      name: 'L', color: '#000000', visible: true, locked: false, outline: false,
      ...(attachedToCamera && { attachedToCamera }),
      frames: [{ index: 0, duration: 1, keyMode: 9728, elements: [] }],
    });
    const camera = { matrix: { ...identity, a: 0.5, d: 0.5, tx: W / 2, ty: H / 2 }, zDepth: 0 };
    const views = stageLayerViews([layer(), layer(true)], 0, camera, W, H)!;
    expect(views.matrices[0]).toMatchObject({ a: 2, d: 2, tx: -W / 2, ty: -H / 2 });
    expect(views.matrices[1]).toEqual(identity);
  });

  it('tweens a layer depth linearly across a classic tween, as the runtime tweens `depth`', () => {
    const layer = {
      name: 'chairs', color: '#000000', visible: true, locked: false, outline: false,
      frames: [
        { index: 0, duration: 71, keyMode: 22017, tweenType: 'motion' as const, zDepth: -3, elements: [] },
        { index: 71, duration: 2, keyMode: 22017, tweenType: 'motion' as const, zDepth: -39, elements: [] },
      ],
    };
    expect(layerZDepthAt(layer, 0)).toBe(-3);
    expect(layerZDepthAt(layer, 35)).toBeCloseTo(-3 - 36 * 35 / 71, 9);
    expect(layerZDepthAt(layer, 72)).toBe(-39);
    // Without a tween the depth holds until the next keyframe.
    layer.frames[0].tweenType = 'none' as never;
    expect(layerZDepthAt(layer, 35)).toBe(-3);
  });

  it('offsets layer depth by the camera depth, except for layers attached to the camera', () => {
    const layer = (attachedToCamera?: boolean) => ({
      name: 'L', color: '#000000', visible: true, locked: false, outline: false,
      ...(attachedToCamera && { attachedToCamera }),
      frames: [{ index: 0, duration: 1, keyMode: 9728, elements: [] }],
    });
    const camera = { matrix: { ...identity, tx: W / 2, ty: H / 2 }, zDepth: LAYER_DEPTH_FOCAL_LENGTH / 2 };
    const views = stageLayerViews([layer(), layer(true)], 0, camera, W, H)!;
    // Moving the camera half the focal length into the scene doubles a depth-0 layer...
    expect(views.matrices[0]!.a).toBeCloseTo(LAYER_DEPTH_FOCAL_LENGTH / (LAYER_DEPTH_FOCAL_LENGTH / 2), 9);
    // ...but not one attached to the camera.
    expect(views.matrices[1]!.a).toBeCloseTo(1, 9);
  });

  it('has nothing to do without a camera or layer depth', () => {
    const layer = { name: 'L', color: '#000000', visible: true, locked: false, outline: false, frames: [{ index: 0, duration: 1, keyMode: 9728, elements: [] }] };
    expect(stageLayerViews([layer], 0, null, W, H)).toBeNull();
  });
});

describe('native camera rendering', () => {
  let canvas: HTMLCanvasElement;
  let renderer: FLARenderer;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    renderer = new FLARenderer(canvas);
  });

  async function render(layers: string, frame = 0): Promise<FLADocument> {
    const doc = await parseXfl({ 'DOMDocument.xml': domDocument(layers) });
    await renderer.setDocument(doc);
    renderer.renderFrame(frame);
    return doc;
  }

  // A 20x20 red square centered on the stage center (275, 200).
  const centerSquare = rectShape(265, 190, 20, 20, RED);

  it('draws the stage unchanged through the default camera', async () => {
    await render(cameraLayer([{ index: 0, duration: 20, matrix: CENTERED }]) + contentLayer('Layer_1', centerSquare));
    expect(colorAt(canvas, 275, 200)).toBe(RED);
    expect(colorAt(canvas, 260, 200)).toBe(WHITE);
  });

  it('pans the stage opposite to the camera', async () => {
    // The camera moved 100px right: the square shows 100px further left.
    await render(cameraLayer([{ index: 0, duration: 20, matrix: `tx="${W / 2 + 100}" ty="${H / 2}"` }]) +
      contentLayer('Layer_1', centerSquare));
    expect(colorAt(canvas, 175, 200)).toBe(RED);
    expect(colorAt(canvas, 275, 200)).toBe(WHITE);
  });

  it('zooms about the stage center (camera scale 0.5 is 200% zoom)', async () => {
    await render(cameraLayer([{ index: 0, duration: 20, matrix: `a="0.5" d="0.5" ${CENTERED}` }]) +
      contentLayer('Layer_1', centerSquare));
    // The 20px square is now 40px: 255..295.
    expect(colorAt(canvas, 258, 200)).toBe(RED);
    expect(colorAt(canvas, 292, 200)).toBe(RED);
    expect(colorAt(canvas, 250, 200)).toBe(WHITE);
  });

  it('rotates the view opposite to the camera', async () => {
    // A 100x10 bar right of the center; the camera turned 90deg clockwise
    // (matrix rotation +90) shows it above the center.
    await render(cameraLayer([{ index: 0, duration: 20, matrix: `a="0" b="1" c="-1" d="0" ${CENTERED}` }]) +
      contentLayer('Layer_1', rectShape(285, 195, 100, 10, RED)));
    expect(colorAt(canvas, 275, 150)).toBe(RED);
    expect(colorAt(canvas, 335, 200)).toBe(WHITE);
  });

  it('follows a classic camera tween', async () => {
    await render(
      cameraLayer([
        { index: 0, duration: 10, matrix: CENTERED, attrs: 'tweenType="motion" motionTweenSnap="true"' },
        { index: 10, duration: 10, matrix: `tx="${W / 2 + 100}" ty="${H / 2}"` },
      ]) + contentLayer('Layer_1', centerSquare),
      5
    );
    expect(colorAt(canvas, 225, 200)).toBe(RED);
    expect(colorAt(canvas, 275, 200)).toBe(WHITE);
  });

  it('keeps the zoom while a camera tween turns', async () => {
    // 0deg to 90deg: halfway the view has turned -45deg about the center and a
    // square 100px right of it is still 100px away, at (345.7, 129.3). Lerping
    // the camera matrix would zoom to 141% and show it at (375, 100).
    await render(
      cameraLayer([
        { index: 0, duration: 10, matrix: CENTERED, attrs: 'tweenType="motion"' },
        { index: 10, duration: 10, matrix: `a="0" b="1" c="-1" d="0" ${CENTERED}` },
      ]) + contentLayer('Layer_1', rectShape(370, 195, 10, 10, RED)),
      5
    );
    expect(colorAt(canvas, 346, 129)).toBe(RED);
    expect(colorAt(canvas, 375, 100)).toBe(WHITE);
  });

  it('leaves layers attached to the camera in place', async () => {
    await render(cameraLayer([{ index: 0, duration: 20, matrix: `tx="${W / 2 + 100}" ty="${H / 2}"` }]) +
      contentLayer('camera_overlay', rectShape(20, 20, 20, 20, BLUE), 'attachedToCamera="true"') +
      contentLayer('Layer_1', centerSquare));
    expect(colorAt(canvas, 30, 30)).toBe(BLUE);
    expect(colorAt(canvas, 175, 200)).toBe(RED);
  });

  it('clips a mask and its masked layer in the camera view', async () => {
    // The mask covers the square's stage position; both move with the camera.
    await render(cameraLayer([{ index: 0, duration: 20, matrix: `tx="${W / 2 + 100}" ty="${H / 2}"` }]) +
      contentLayer('Mask', rectShape(255, 180, 40, 40, BLUE), 'layerType="mask"') +
      contentLayer('Masked', centerSquare + rectShape(400, 190, 20, 20, RED), 'layerType="masked" parentLayerIndex="1"'));
    expect(colorAt(canvas, 175, 200)).toBe(RED);
    expect(colorAt(canvas, 310, 200)).toBe(WHITE); // the second square, clipped away
  });

  it('is not offered as a follow-camera layer', async () => {
    await render(cameraLayer([{ index: 0, duration: 20, matrix: CENTERED }]) + contentLayer('Layer_1', centerSquare));
    expect(renderer.getCameraLayers()).toEqual([]);
  });
});

describe('layer depth rendering', () => {
  let canvas: HTMLCanvasElement;
  let renderer: FLARenderer;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    renderer = new FLARenderer(canvas);
  });

  async function render(layers: string, frame = 0): Promise<void> {
    await renderer.setDocument(await parseXfl({ 'DOMDocument.xml': domDocument(layers) }));
    renderer.renderFrame(frame);
  }

  const f = LAYER_DEPTH_FOCAL_LENGTH;
  const centerSquare = rectShape(265, 190, 20, 20, RED);

  it('keeps layer depth in follow camera mode', async () => {
    // A ramka framing the whole stage, followed: the near layer is still twice
    // its size and still drawn over the layer above it.
    const ramka = `<DOMLayer name="ramka" layerType="guide"><frames><DOMFrame index="0" duration="20"><elements>
      <DOMSymbolInstance libraryItemName="Ramka" symbolType="graphic"><matrix><Matrix/></matrix>
        <transformationPoint><Point x="${W / 2}" y="${H / 2}"/></transformationPoint></DOMSymbolInstance>
    </elements></DOMFrame></frames></DOMLayer>`;
    await renderer.setDocument(await parseXfl({ 'DOMDocument.xml': domDocument(ramka +
      contentLayer('Top', rectShape(240, 195, 70, 10, BLUE)) +
      contentLayer('Near', centerSquare, '', `frameZDepth="${-f / 2}"`)) }));
    renderer.setFollowCamera(true);
    expect(renderer.getCameraLayers().map((l) => l.name)).toContain('ramka');
    renderer.renderFrame(0);
    expect(colorAt(canvas, 258, 200)).toBe(RED);
    expect(colorAt(canvas, 250, 200)).toBe(BLUE);
    expect(colorAt(canvas, 250, 210)).toBe(WHITE);
  });

  it('follows a ramka where the native camera shows it', async () => {
    // The native camera zooms 200%, so the ramka framing the stage covers twice
    // the stage on screen. Following it shows the stage at its own size.
    const ramka = `<DOMLayer name="ramka" layerType="guide"><frames><DOMFrame index="0" duration="20"><elements>
      <DOMSymbolInstance libraryItemName="Ramka" symbolType="graphic"><matrix><Matrix/></matrix>
        <transformationPoint><Point x="${W / 2}" y="${H / 2}"/></transformationPoint></DOMSymbolInstance>
    </elements></DOMFrame></frames></DOMLayer>`;
    await renderer.setDocument(await parseXfl({ 'DOMDocument.xml': domDocument(
      cameraLayer([{ index: 0, duration: 20, matrix: `a="0.5" d="0.5" ${CENTERED}` }]) + ramka + contentLayer('Layer_1', centerSquare)) }));
    renderer.setFollowCamera(true);
    renderer.renderFrame(0);
    expect(colorAt(canvas, 275, 200)).toBe(RED);
    expect(colorAt(canvas, 282, 207)).toBe(RED);
    expect(colorAt(canvas, 290, 200)).toBe(WHITE);
  });

  it('follows a ramka to the stage center under a turned native camera', async () => {
    // The camera turns 90 degrees about the stage center; the ramka framing
    // the stage still has its center there, so the center square stays put.
    const ramka = `<DOMLayer name="ramka" layerType="guide"><frames><DOMFrame index="0" duration="20"><elements>
      <DOMSymbolInstance libraryItemName="Ramka" symbolType="graphic"><matrix><Matrix/></matrix>
        <transformationPoint><Point x="${W / 2}" y="${H / 2}"/></transformationPoint></DOMSymbolInstance>
    </elements></DOMFrame></frames></DOMLayer>`;
    for (const turn of [`a="0" b="1" c="-1" d="0"`, `a="0.866025" b="0.5" c="-0.5" d="0.866025"`]) {
      await renderer.setDocument(await parseXfl({ 'DOMDocument.xml': domDocument(
        cameraLayer([{ index: 0, duration: 20, matrix: `${turn} ${CENTERED}` }]) + ramka + contentLayer('Layer_1', centerSquare)) }));
      renderer.setFollowCamera(true);
      renderer.renderFrame(0);
      expect(colorAt(canvas, 275, 200)).toBe(RED);
    }
  });

  it('scales a near layer up about the stage center', async () => {
    // Depth -f/2 doubles the size: the 20px square becomes 40px (255..295).
    await render(contentLayer('Near', centerSquare, '', `frameZDepth="${-f / 2}"`));
    expect(colorAt(canvas, 258, 200)).toBe(RED);
    expect(colorAt(canvas, 250, 200)).toBe(WHITE);
  });

  it('scales a far layer down', async () => {
    // Depth f halves the size: 10px (270..280).
    await render(contentLayer('Far', centerSquare, '', `frameZDepth="${f}"`));
    expect(colorAt(canvas, 275, 200)).toBe(RED);
    expect(colorAt(canvas, 267, 200)).toBe(WHITE);
  });

  it('pans near layers faster than far ones (parallax)', async () => {
    // The camera moves 100px right. A depth-0 square moves 100px left; one at
    // depth -f/2 moves twice as far.
    await render(cameraLayer([{ index: 0, duration: 20, matrix: `tx="${W / 2 + 100}" ty="${H / 2}"` }]) +
      contentLayer('Near', rectShape(270, 100, 10, 10, BLUE), '', `frameZDepth="${-f / 2}"`) +
      contentLayer('Mid', rectShape(270, 300, 10, 10, RED)));
    expect(colorAt(canvas, 175, 305)).toBe(RED);
    // Near: center (275,105) -> 2 * (175 - 275, 105 - 200) + (275, 200) = (75, 10).
    expect(colorAt(canvas, 75, 10)).toBe(BLUE);
  });

  it('stacks layers by depth, furthest first', async () => {
    // The top layer is further away, so the bottom layer covers it.
    await render(
      contentLayer('Top', rectShape(200, 150, 150, 100, RED), '', 'frameZDepth="100"') +
      contentLayer('Bottom', rectShape(200, 150, 150, 100, BLUE))
    );
    expect(colorAt(canvas, 275, 200)).toBe(BLUE);
  });

  it('does not draw a layer behind the camera', async () => {
    await render(contentLayer('Behind', centerSquare, '', `frameZDepth="${-f - 10}"`));
    expect(colorAt(canvas, 275, 200)).toBe(WHITE);
  });

  it('tweens depth across a classic tween', async () => {
    // Depth 0 -> -f/2 over 10 frames: at frame 5 the depth is -f/4, scale 4/3.
    const keyframes = `<DOMLayer name="Zoom"><frames>
      <DOMFrame index="0" duration="10" tweenType="motion" keyMode="22017"><elements>${centerSquare}</elements></DOMFrame>
      <DOMFrame index="10" duration="10" tweenType="motion" keyMode="22017" frameZDepth="${-f / 2}"><elements>${centerSquare}</elements></DOMFrame>
    </frames></DOMLayer>`;
    await render(keyframes, 5);
    // Half-width 10 * 4/3 = 13.3: x 261.7..288.3.
    expect(colorAt(canvas, 263, 200)).toBe(RED);
    expect(colorAt(canvas, 259, 200)).toBe(WHITE);
  });
});

describe('native camera in SVG export', () => {
  it('wraps layers in their camera view', async () => {
    const doc = await parseXfl({
      'DOMDocument.xml': domDocument(
        cameraLayer([{ index: 0, duration: 20, matrix: `tx="${W / 2 + 100}" ty="${H / 2}"` }]) +
        contentLayer('Overlay', rectShape(0, 0, 10, 10, BLUE), 'attachedToCamera="true"') +
        contentLayer('Layer_1', rectShape(0, 0, 10, 10, RED))
      ),
    });
    const svg = await (await exportSVG(doc, 0)).text();
    // Layer_1 pans 100px left.
    expect(svg).toContain('<g transform="matrix(1 0 0 1 -100 0)">');
    // The attached overlay is untransformed: Layer_1's is the only view group.
    expect(svg.match(/<g transform="/g)).toHaveLength(1);
  });

  it('scales layers by depth and stacks them furthest first', async () => {
    const doc = await parseXfl({
      'DOMDocument.xml': domDocument(
        cameraLayer([{ index: 0, duration: 20, matrix: `tx="${W / 2 + 100}" ty="${H / 2}"` }]) +
        contentLayer('Far', rectShape(0, 0, 10, 10, RED), '', `frameZDepth="${LAYER_DEPTH_FOCAL_LENGTH}"`) +
        contentLayer('Overlay', rectShape(0, 0, 10, 10, BLUE), 'attachedToCamera="true"')
      ),
    });
    const svg = await (await exportSVG(doc, 0)).text();
    // Far: scale 0.5 about the center after the -100px pan.
    expect(svg).toContain('<g transform="matrix(0.5 0 0 0.5 87.5 100)">');
    // The far layer is drawn before (under) the overlay even though it is above it.
    expect(svg.indexOf('fill="#FF0000"')).toBeLessThan(svg.indexOf('fill="#0000FF"'));
    // The attached overlay is untransformed: the far layer's is the only view group.
    expect(svg.match(/<g transform="/g)).toHaveLength(1);
  });

  it('stacks masked layers by depth like the canvas does', async () => {
    // Under one mask: the upper masked layer (blue) is further away, so it is
    // drawn first and the lower one (red) covers it in the middle.
    const xml = domDocument(
      contentLayer('Mask', rectShape(0, 0, W, H, '#00FF00'), 'layerType="mask"') +
      contentLayer('Far', rectShape(225, 150, 100, 100, BLUE), 'layerType="masked" parentLayerIndex="0"', 'frameZDepth="100"') +
      contentLayer('Near', rectShape(255, 180, 40, 40, RED), 'layerType="masked" parentLayerIndex="0"')
    );
    const doc = await parseXfl({ 'DOMDocument.xml': xml });
    const canvas = document.createElement('canvas');
    const renderer = new FLARenderer(canvas);
    await renderer.setDocument(doc);
    renderer.renderFrame(0);
    expect(colorAt(canvas, 275, 200)).toBe(RED);
    expect(colorAt(canvas, 240, 200)).toBe(BLUE);
    const svg = await (await exportSVG(doc, 0)).text();
    expect(svg.indexOf('fill="#0000FF"')).toBeGreaterThan(-1);
    expect(svg.indexOf('fill="#0000FF"')).toBeLessThan(svg.indexOf('fill="#FF0000"'));
  });

  it('writes no empty transform for a mask seen through the default camera', async () => {
    const doc = await parseXfl({
      'DOMDocument.xml': domDocument(
        cameraLayer([{ index: 0, duration: 20, matrix: CENTERED }]) +
        contentLayer('Mask', rectShape(0, 0, 100, 100, BLUE), 'layerType="mask"') +
        contentLayer('Masked', rectShape(0, 0, 10, 10, RED), 'layerType="masked" parentLayerIndex="1"')
      ),
    });
    const svg = await (await exportSVG(doc, 0)).text();
    expect(svg).toContain('clip-path="url(#');
    expect(svg).not.toContain('transform=""');
  });
});

describe('ramka camera tweens', () => {
  // A guide layer named "ramka" whose one instance turns from 0deg to 180deg
  // clockwise over 10 frames.
  const ramka = (matrix: string) => `<elements><DOMSymbolInstance libraryItemName="Ramka" symbolType="graphic">
    <matrix><Matrix ${matrix}/></matrix><transformationPoint><Point x="275" y="200"/></transformationPoint>
  </DOMSymbolInstance></elements>`;

  it('tweens the camera the same way with and without follow camera mode', async () => {
    const doc = await parseXfl({
      'DOMDocument.xml': domDocument(`<DOMLayer name="ramka" layerType="guide"><frames>
        <DOMFrame index="0" duration="10" tweenType="motion" motionTweenRotate="clockwise" keyMode="22017">${ramka('')}</DOMFrame>
        <DOMFrame index="10" keyMode="22017">${ramka('a="-1" d="-1" tx="550" ty="400"')}</DOMFrame>
      </frames></DOMLayer>`, ''),
    });
    const renderer = new FLARenderer(document.createElement('canvas'));
    await renderer.setDocument(doc);
    const layer = doc.timelines[0].layers[0];
    const followed: Matrix = (renderer as any).getCameraElement(layer, 5).matrix;
    const transform: Matrix = (renderer as any).getCameraTransform(layer, 5);
    expect(followed).toEqual(transform);
    // A quarter turn clockwise at full size, not the zero matrix a lerp gives.
    expect(followed.b).toBeCloseTo(1, 9);
    expect(followed.c).toBeCloseTo(-1, 9);
    expect(followed.a).toBeCloseTo(0, 9);
  });
});
