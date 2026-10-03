import { describe, it, expect, beforeEach } from 'vitest';
import JSZip from 'jszip';
import { FLAParser } from '../fla-parser';
import { FLARenderer } from '../renderer';
import { exportSVG } from '../video-exporter';
import { cameraViewMatrix, stageLayerViews } from '../native-camera';
import type { FLADocument, Matrix, SymbolInstance } from '../types';

// Animate's native camera (CC 2017+). The XML mirrors real Animate saves:
// eliasku/animate-tests assets/camera_layer (Animate 20, attachedToCamera
// layers) and dailybruin lessons-in-laughter (Animate 18, camera zoom tween),
// whose published HTML5 output gives the expected behavior
// (`_applyLayerZDepth`, `AdobeAn.VirtualCamera`).

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
    const views = stageLayerViews([layer(), layer(true)], { matrix: { ...identity, a: 0.5, d: 0.5, tx: W / 2, ty: H / 2 } }, W, H)!;
    expect(views.matrices[0]).toMatchObject({ a: 2, d: 2, tx: -W / 2, ty: -H / 2 });
    expect(views.matrices[1]).toEqual(identity);
  });

  it('has nothing to do without a camera', () => {
    const layer = { name: 'L', color: '#000000', visible: true, locked: false, outline: false, frames: [{ index: 0, duration: 1, keyMode: 9728, elements: [] }] };
    expect(stageLayerViews([layer], null, W, H)).toBeNull();
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
});
