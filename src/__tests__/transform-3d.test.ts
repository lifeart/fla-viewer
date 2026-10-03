import { describe, it, expect, beforeEach } from 'vitest';
import JSZip from 'jszip';
import { FLAParser } from '../fla-parser';
import { FLARenderer } from '../renderer';
import { documentPerspective, projectedInstanceMatrix, rotation3D, withInstanceMatrix } from '../transform-3d';
import { applyIKPose } from '../ik-pose';
import type { FLADocument, Frame, Matrix, SymbolInstance } from '../types';

// 3D symbol instances (Flash CS4+). The instance XML mirrors real saves: a
// panel turned -25 degrees about Y whose 2D matrix is only a translation, with
// its 3D center at the transformation point and Flash's `matrix3D` beside it
// (UI menus saved by Animate CC 2017), and an unrotated instance moved toward the
// viewer (`centerPoint3DZ`, Flash CS5). Document perspective attributes are
// from real DOMDocument.xml files.

const W = 550;
const H = 400;
const RED = '#FF0000';
const WHITE = '#FFFFFF';

// matrix3D of a real instance with rotationY="-25" (column-major, translation last).
const REAL_MATRIX_3D = [
  0.906307756900787, 0, 0.422618269920349, 0, 0, 1, 0, 0, -0.422618269920349, 0, 0.906307756900787, 0,
  163.9638671875, -600, -2092.8056640625, 1,
];

async function parseXfl(files: Record<string, string>): Promise<FLADocument> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return new FLAParser().parse(await zip.generateAsync({ type: 'uint8array' }));
}

function domDocument(layers: string, docAttrs = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<DOMDocument xmlns="http://ns.adobe.com/xfl/2008/" width="${W}" height="${H}" frameRate="24" backgroundColor="#FFFFFF" xflVersion="2.2" ${docAttrs}>
  <symbols><Include href="Panel.xml"/></symbols>
  <timelines><DOMTimeline name="Scene 1"><layers>${layers}</layers></DOMTimeline></timelines>
</DOMDocument>`;
}

function rectShape(x: number, y: number, w: number, h: number, color: string): string {
  const t = (v: number) => v * 20; // twips
  return `<DOMShape><fills><FillStyle index="1"><SolidColor color="${color}"/></FillStyle></fills>
  <edges><Edge fillStyle1="1" edges="!${t(x)} ${t(y)}|${t(x + w)} ${t(y)}|${t(x + w)} ${t(y + h)}|${t(x)} ${t(y + h)}|${t(x)} ${t(y)}"/></edges>
</DOMShape>`;
}

/** A 100x60 red panel; its transformation point is its center (50, 30). */
const panelSymbol = `<DOMSymbolItem xmlns="http://ns.adobe.com/xfl/2008/" name="Panel">
  <timeline><DOMTimeline name="Panel"><layers><DOMLayer name="Layer 1"><frames>
    <DOMFrame index="0"><elements>${rectShape(0, 0, 100, 60, RED)}</elements></DOMFrame>
  </frames></DOMLayer></layers></DOMTimeline></timeline>
</DOMSymbolItem>`;

/** The panel turned -25 degrees about Y with its center at (cx, cy), as Flash saves it. */
function panelInstance(cx: number, cy: number): string {
  return `<DOMSymbolInstance libraryItemName="Panel" name="menu0" matrix3D="${REAL_MATRIX_3D.join(' ')}" rotationY="-25" centerPoint3DX="${cx}" centerPoint3DY="${cy}">
    <matrix><Matrix tx="${cx - 50}" ty="${cy - 30}"/></matrix>
    <transformationPoint><Point x="50" y="30"/></transformationPoint>
  </DOMSymbolInstance>`;
}

/** The panel moved 100px toward the viewer, centered on the vanishing point. */
const nearPanel = `<DOMSymbolInstance libraryItemName="Panel" name="" matrix3D="1 0 0 0 0 1 0 0 0 0 1 0 -120 2310 -2000 1" centerPoint3DX="275" centerPoint3DY="200" centerPoint3DZ="-100">
    <matrix><Matrix tx="225" ty="170"/></matrix>
    <transformationPoint><Point x="50" y="30"/></transformationPoint>
  </DOMSymbolInstance>`;

const layer = (elements: string) =>
  `<DOMLayer name="Layer 1"><frames><DOMFrame index="0" duration="11" keyMode="9728"><elements>${elements}</elements></DOMFrame></frames></DOMLayer>`;

const colorAt = (canvas: HTMLCanvasElement, x: number, y: number): string => {
  const s = canvas.width / W;
  const d = canvas.getContext('2d')!.getImageData(Math.floor(x * s), Math.floor(y * s), 1, 1).data;
  return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
};

const apply = (m: Matrix, x: number, y: number) => ({ x: m.a * x + m.c * y + m.tx, y: m.b * x + m.d * y + m.ty });

describe('3D document perspective', () => {
  it('reads viewAngle3D and the vanishing point from DOMDocument', async () => {
    const doc = await parseXfl({
      'DOMDocument.xml': domDocument('', 'viewAngle3D="122.353661987282" vanishingPoint3DX="960" vanishingPoint3DY="540"'),
      'LIBRARY/Panel.xml': panelSymbol,
    });
    expect(doc.viewAngle3D).toBeCloseTo(122.353661987282, 9);
    expect(doc.vanishingPoint3D).toEqual({ x: 960, y: 540 });
  });

  it('leaves them unset when the document has none', async () => {
    const doc = await parseXfl({ 'DOMDocument.xml': domDocument(''), 'LIBRARY/Panel.xml': panelSymbol });
    expect(doc.viewAngle3D).toBeUndefined();
    expect(doc.vanishingPoint3D).toBeUndefined();
  });

  it('derives the focal length from the perspective angle and stage width', () => {
    // Flash's default 55 degrees on a 550px stage, and a real 1920px document
    // whose angle Animate adjusted to keep the same focal length.
    expect(documentPerspective({ width: 550, height: 400 }).focalLength).toBeCloseTo(528.27, 2);
    expect(documentPerspective({ width: 1920, height: 1080, viewAngle3D: 122.353661987282 }).focalLength).toBeCloseTo(528.27, 2);
    expect(documentPerspective({ width: 550, height: 400 }).center).toEqual({ x: 275, y: 200 });
  });
});

describe('3D instance parsing', () => {
  it('reads the rotation, the 3D center and the depth', async () => {
    const doc = await parseXfl({
      'DOMDocument.xml': domDocument(layer(panelInstance(275, 200) + nearPanel)),
      'LIBRARY/Panel.xml': panelSymbol,
    });
    const [turned, near] = doc.timelines[0].layers[0].frames[0].elements as SymbolInstance[];
    expect(turned.rotationY).toBe(-25);
    expect(turned.centerPoint3D).toEqual({ x: 275, y: 200 });
    expect(turned.z).toBeUndefined();
    expect(near.z).toBe(-100);
  });

  it('ignores malformed rotations and 3D centers', async () => {
    const doc = await parseXfl({
      'DOMDocument.xml': domDocument(layer(panelInstance(275, 200)
        .replace('rotationY="-25"', 'rotationY="abc" rotationX="" rotationZ="NaN"')
        .replace('centerPoint3DX="275"', 'centerPoint3DX="x"'))),
      'LIBRARY/Panel.xml': panelSymbol,
    });
    const [panel] = doc.timelines[0].layers[0].frames[0].elements as SymbolInstance[];
    expect([panel.rotationX, panel.rotationY, panel.rotationZ, panel.centerPoint3D]).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe('3D rotation and projection math', () => {
  it('turns about Y the way the matrix3D Flash saves does', () => {
    const r = rotation3D(0, -25, 0);
    // rawData is column-major: element (row i, column j) is at j * 4 + i.
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) expect(r[i][j]).toBeCloseTo(REAL_MATRIX_3D[j * 4 + i], 6);
    }
  });

  it('applies X first, then Y, then Z (fl.motion.Animator3D order)', () => {
    // X 90 turns +y into +z, which Z 90 then leaves alone. Z first would
    // turn +y into -x instead.
    const r = rotation3D(90, 0, 90);
    expect(r[0][1]).toBeCloseTo(0, 9);
    expect(r[1][1]).toBeCloseTo(0, 9);
    expect(r[2][1]).toBeCloseTo(1, 9);
  });

  it('is the plain matrix without rotation or depth', () => {
    const matrix: Matrix = { a: 1.5, b: 0.2, c: -0.3, d: 0.8, tx: 40, ty: 70 };
    const toStage: Matrix = { a: 2, b: 0, c: 0, d: 2, tx: 10, ty: 20 };
    const m = projectedInstanceMatrix(matrix, { x: 60, y: 90 }, rotation3D(), 0, toStage, documentPerspective({ width: W, height: H }))!;
    for (const key of ['a', 'b', 'c', 'd', 'tx', 'ty'] as const) expect(m[key]).toBeCloseTo(matrix[key], 9);
  });

  it('matches the exact perspective projection at the 3D center, to first order', () => {
    // A nested instance: its parent is scaled and moved on the stage.
    const toStage: Matrix = { a: 1.2, b: 0.1, c: -0.2, d: 0.9, tx: 30, ty: -15 };
    const perspective = { focalLength: 500, center: { x: 300, y: 180 } };
    const r = rotation3D(20, -35, 10);
    const pivot = { x: 140, y: 90 };
    const z = 40;
    const matrix: Matrix = { a: 1, b: 0, c: 0, d: 1, tx: 120, ty: 70 };
    const exact = (x: number, y: number) => {
      // Rotate the parent-space point about the pivot, move it z away, put it on
      // the stage and project it toward the vanishing point.
      const q = apply(matrix, x, y);
      const u = [q.x - pivot.x, q.y - pivot.y, 0];
      const rx = pivot.x + r[0][0] * u[0] + r[0][1] * u[1];
      const ry = pivot.y + r[1][0] * u[0] + r[1][1] * u[1];
      const depth = z + r[2][0] * u[0] + r[2][1] * u[1];
      const s = apply(toStage, rx, ry);
      const k = perspective.focalLength / (perspective.focalLength + depth);
      return { x: perspective.center.x + (s.x - perspective.center.x) * k, y: perspective.center.y + (s.y - perspective.center.y) * k };
    };
    const m = projectedInstanceMatrix(matrix, pivot, r, z, toStage, perspective)!;
    const drawn = (x: number, y: number) => apply(toStage, apply(m, x, y).x, apply(m, x, y).y);
    const local = { x: pivot.x - 120, y: pivot.y - 70 }; // the pivot in the instance's own space
    expect(drawn(local.x, local.y).x).toBeCloseTo(exact(local.x, local.y).x, 6);
    expect(drawn(local.x, local.y).y).toBeCloseTo(exact(local.x, local.y).y, 6);
    const h = 1e-3;
    for (const [dx, dy] of [[h, 0], [0, h]]) {
      const slope = (p: (x: number, y: number) => { x: number; y: number }) => ({
        x: (p(local.x + dx, local.y + dy).x - p(local.x - dx, local.y - dy).x) / (2 * h),
        y: (p(local.x + dx, local.y + dy).y - p(local.x - dx, local.y - dy).y) / (2 * h),
      });
      expect(slope(drawn).x).toBeCloseTo(slope(exact).x, 5);
      expect(slope(drawn).y).toBeCloseTo(slope(exact).y, 5);
    }
  });

  it('draws nothing at or behind the viewer', () => {
    const perspective = documentPerspective({ width: W, height: H });
    const identity: Matrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
    expect(projectedInstanceMatrix(identity, { x: 0, y: 0 }, rotation3D(), -perspective.focalLength, identity, perspective)).toBeNull();
  });
});

describe('3D instance rendering', () => {
  let canvas: HTMLCanvasElement;
  let renderer: FLARenderer;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    renderer = new FLARenderer(canvas);
  });

  async function render(layers: string, docAttrs = '', frame = 0): Promise<void> {
    await renderer.setDocument(await parseXfl({ 'DOMDocument.xml': domDocument(layers, docAttrs), 'LIBRARY/Panel.xml': panelSymbol }));
    renderer.renderFrame(frame);
  }

  it('turns the instance about its 3D center and foreshortens it', async () => {
    // Centered on the vanishing point (275, 200). Flash's exact projection spans
    // x 227.8..318.6 at the center row; the 2D matrix alone would be 225..325.
    await render(layer(panelInstance(275, 200)));
    expect(colorAt(canvas, 275, 200)).toBe(RED);
    expect(colorAt(canvas, 233, 200)).toBe(RED);
    expect(colorAt(canvas, 316, 200)).toBe(RED);
    expect(colorAt(canvas, 226, 200)).toBe(WHITE);
    expect(colorAt(canvas, 323, 200)).toBe(WHITE);
    expect(colorAt(canvas, 275, 173)).toBe(RED);
    expect(colorAt(canvas, 275, 167)).toBe(WHITE);
  });

  it('shifts the instance toward the vanishing point by its depth', async () => {
    // 100px right of the vanishing point the panel's right side recedes: the
    // exact projection spans 332.0..414.7, a plain cosine squeeze 329.7..420.3.
    await render(layer(panelInstance(375, 200)));
    expect(colorAt(canvas, 336, 200)).toBe(RED);
    expect(colorAt(canvas, 412, 200)).toBe(RED);
    expect(colorAt(canvas, 330, 200)).toBe(WHITE);
    expect(colorAt(canvas, 418, 200)).toBe(WHITE);
  });

  it("uses the document's vanishing point", async () => {
    // With the vanishing point on the panel's center the squeeze is symmetric.
    await render(layer(panelInstance(375, 200)), 'vanishingPoint3DX="375" vanishingPoint3DY="200"');
    expect(colorAt(canvas, 332, 200)).toBe(RED);
    expect(colorAt(canvas, 417, 200)).toBe(RED);
    expect(colorAt(canvas, 326, 200)).toBe(WHITE);
    expect(colorAt(canvas, 423, 200)).toBe(WHITE);
  });

  it('scales an instance by its depth about the vanishing point', async () => {
    // z = -100: 528.27 / 428.27 = 1.234 times larger, x 213.3..336.7, y 163..237.
    await render(layer(nearPanel));
    expect(colorAt(canvas, 217, 200)).toBe(RED);
    expect(colorAt(canvas, 333, 200)).toBe(RED);
    expect(colorAt(canvas, 275, 166)).toBe(RED);
    expect(colorAt(canvas, 209, 200)).toBe(WHITE);
    expect(colorAt(canvas, 341, 200)).toBe(WHITE);
    expect(colorAt(canvas, 275, 159)).toBe(WHITE);
  });

  it('draws an instance whose 3D values are not numbers at its 2D matrix', async () => {
    const doc = await parseXfl({ 'DOMDocument.xml': domDocument(layer(panelInstance(375, 200))), 'LIBRARY/Panel.xml': panelSymbol });
    (doc.timelines[0].layers[0].frames[0].elements[0] as SymbolInstance).rotationY = NaN;
    await renderer.setDocument(doc);
    renderer.renderFrame(0);
    expect(colorAt(canvas, 375, 200)).toBe(RED);
    expect(colorAt(canvas, 30, 20)).toBe(WHITE); // not at the parent's origin
  });

  it('keeps the 3D center with the instance through a classic tween', async () => {
    // From (175, 200) to (375, 200); halfway it must match a panel placed at (275, 200).
    const tweened = `<DOMLayer name="Layer 1"><frames>
      <DOMFrame index="0" duration="10" tweenType="motion" keyMode="22017"><elements>${panelInstance(175, 200)}</elements></DOMFrame>
      <DOMFrame index="10" keyMode="22017"><elements>${panelInstance(375, 200)}</elements></DOMFrame>
    </frames></DOMLayer>`;
    await render(tweened, '', 5);
    const pixels = (c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const halfway = pixels(canvas);
    await render(layer(panelInstance(275, 200)));
    const placed = pixels(canvas);
    let differing = 0;
    for (let i = 0; i < placed.length; i += 4) if (Math.abs(placed[i + 1] - halfway[i + 1]) > 8) differing++;
    expect(differing).toBe(0);
    expect(colorAt(canvas, 316, 200)).toBe(RED);
  });

  it('keeps the 3D center with the instance through a classic tween under a layer parent', async () => {
    // The parent (off stage) moves 200px right with the child, so the child
    // tweens in the parent's space.
    const parentAt = (tx: number) => `<elements><DOMSymbolInstance libraryItemName="Panel">
      <matrix><Matrix tx="${tx}" ty="-1000"/></matrix><transformationPoint><Point x="50" y="30"/></transformationPoint>
    </DOMSymbolInstance></elements>`;
    const parent = `<DOMLayer name="Parent"><frames>
      <DOMFrame index="0" duration="10" tweenType="motion" keyMode="22017">${parentAt(100)}</DOMFrame>
      <DOMFrame index="10" keyMode="22017">${parentAt(300)}</DOMFrame>
    </frames></DOMLayer>`;
    const child = (frames: string) => `<DOMLayer name="Child" parentLayerIndex="0"><frames>${frames}</frames></DOMLayer>`;
    await render(parent + child(`
      <DOMFrame index="0" duration="10" tweenType="motion" keyMode="22017"><elements>${panelInstance(175, 200)}</elements></DOMFrame>
      <DOMFrame index="10" keyMode="22017"><elements>${panelInstance(375, 200)}</elements></DOMFrame>`), '', 5);
    const pixels = (c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const halfway = pixels(canvas);
    await render(parent + child(`<DOMFrame index="0" duration="11"><elements>${panelInstance(275, 200)}</elements></DOMFrame>`));
    const placed = pixels(canvas);
    let differing = 0;
    for (let i = 0; i < placed.length; i += 4) if (Math.abs(placed[i + 1] - halfway[i + 1]) > 8) differing++;
    expect(differing).toBe(0);
    expect(colorAt(canvas, 316, 200)).toBe(RED);
  });

  it('projects in stage space under a ramka camera, which only frames the view', async () => {
    // A ramka zooming 200% on the top-left quarter of the stage must show what
    // the viewer's own 200% zoom shows there.
    const ramka = `<DOMLayer name="ramka" layerType="guide"><frames><DOMFrame index="0" duration="11"><elements>
      <DOMSymbolInstance libraryItemName="Ramka" symbolType="graphic"><matrix><Matrix a="0.5" d="0.5"/></matrix>
        <transformationPoint><Point x="275" y="200"/></transformationPoint></DOMSymbolInstance>
    </elements></DOMFrame></frames></DOMLayer>`;
    const pixels = () => canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    await render(ramka + layer(panelInstance(137.5, 100)));
    const framed = pixels();
    await renderer.setDocument(await parseXfl({ 'DOMDocument.xml': domDocument(layer(panelInstance(137.5, 100))), 'LIBRARY/Panel.xml': panelSymbol }));
    (renderer as unknown as { zoomLevel: number }).zoomLevel = 2;
    renderer.renderFrame(0);
    const zoomed = pixels();
    // Pixels drawn in both (the background may cover different areas) whose
    // green differs, red against white.
    const differing = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      let count = a.length === b.length ? 0 : Infinity;
      for (let i = 0; i < a.length; i += 4) if (a[i + 3] === 255 && b[i + 3] === 255 && Math.abs(a[i + 1] - b[i + 1]) > 8) count++;
      return count;
    };
    expect(differing(zoomed, framed)).toBe(0);
    expect(colorAt(canvas, 275, 200)).toBe(RED); // the panel's center, zoomed
    // Follow camera mode frames the same ramka differently (centered, in a
    // 1100x800 viewport), but the panel must still project in stage space: it
    // matches the stage drawn at the same scale and offset.
    await renderer.setDocument(await parseXfl({ 'DOMDocument.xml': domDocument(ramka + layer(panelInstance(137.5, 100))), 'LIBRARY/Panel.xml': panelSymbol }));
    renderer.setFollowCamera(true);
    renderer.renderFrame(0);
    const followed = pixels();
    const followScale = (renderer as unknown as { scale: number }).scale;
    renderer.setFollowCamera(false);
    // Follow mode draws stage x at followScale * (550 + 2 * (x - 137.5)).
    await renderer.setDocument(await parseXfl({ 'DOMDocument.xml': domDocument(layer(panelInstance(137.5, 100))), 'LIBRARY/Panel.xml': panelSymbol }));
    const view = renderer as unknown as { scale: number; panX: number; panY: number };
    expect(view.scale).toBeCloseTo(2 * followScale, 9);
    view.panX = 275 * followScale;
    view.panY = 200 * followScale;
    renderer.renderFrame(0);
    expect(differing(pixels(), followed)).toBe(0);
    expect(colorAt(canvas, 275, 200)).toBe(RED); // drawn at stage (275, 200) in both
  });

  it('moves the 3D center with an IK pose and a matrix replaced for a rig', () => {
    const panel = {
      type: 'symbol', libraryItemName: 'Panel', symbolType: 'graphic', rotationY: -25,
      matrix: { a: 1, b: 0, c: 0, d: 1, tx: 225, ty: 170 }, transformationPoint: { x: 50, y: 30 },
      centerPoint3D: { x: 275, y: 200 },
    } as SymbolInstance;
    const moved = withInstanceMatrix(panel, { a: 1, b: 0, c: 0, d: 1, tx: 245, ty: 160 });
    expect(moved.centerPoint3D).toEqual({ x: 295, y: 190 });
    expect(moved.matrix.tx).toBe(245);
    const pose = { a: 0, b: 1, c: -1, d: 0, tx: 0, ty: 0 }; // a quarter turn about the parent's origin
    const frame = { index: 0, duration: 1, elements: [panel], ikPoseMatrices: [[pose]] } as unknown as Frame;
    expect(applyIKPose(frame, panel, 0, 0).centerPoint3D).toEqual({ x: -200, y: 275 });
    expect(withInstanceMatrix({ ...panel, centerPoint3D: undefined }, pose).centerPoint3D).toBeUndefined();
    // A center 25px right of the transformation point turns with the instance.
    const offCenter = { ...panel, centerPoint3D: { x: 300, y: 200 } };
    const turned = applyIKPose({ ...frame, elements: [offCenter] } as Frame, offCenter, 0, 0).centerPoint3D!;
    expect(turned.x).toBeCloseTo(-200, 9);
    expect(turned.y).toBeCloseTo(300, 9);
    // From a matrix scaled to nothing, it moves with the transformation point.
    const flat = { ...panel, matrix: { a: 0, b: 0, c: 0, d: 0, tx: 275, ty: 200 } };
    expect(withInstanceMatrix(flat, { a: 1, b: 0, c: 0, d: 1, tx: 245, ty: 160 }).centerPoint3D).toEqual({ x: 295, y: 190 });
  });

  it('keeps the 3D center with the instance through an object motion tween', async () => {
    // A 20x20 box moved 200px right; its 3D center starts at (60, 110).
    const prop = (id: string, values: string) => `<Property enabled="1" id="${id}" ignoreTimeMap="0" readonly="0" visible="1">${values}</Property>`;
    const key = (time: number, value: number) => `<Keyframe anchor="0,${value}" next="0,${value}" previous="0,${value}" roving="0" timevalue="${time}"/>`;
    const tween = `<DOMLayer name="Tween" animationType="motion object"><frames>
      <DOMFrame index="0" duration="11" tweenType="motion object" isMotionObject="true" keyMode="8195">
        <motionObjectXML><AnimationCore TimeScale="24000" Version="1" duration="11000"><TimeMap strength="0" type="Quadratic"/>
          <PropertyContainer id="headContainer"><PropertyContainer id="Basic_Motion">
            ${prop('Motion_X', key(0, 0) + key(10000, 200))}${prop('Motion_Y', key(0, 0))}
          </PropertyContainer></PropertyContainer></AnimationCore></motionObjectXML>
        <elements><DOMSymbolInstance libraryItemName="Box" rotationY="-25" centerPoint3DX="60" centerPoint3DY="110">
          <matrix><Matrix tx="50" ty="100"/></matrix><transformationPoint><Point x="10" y="10"/></transformationPoint>
        </DOMSymbolInstance></elements>
      </DOMFrame>
    </frames></DOMLayer>`;
    const box = `<DOMSymbolItem xmlns="http://ns.adobe.com/xfl/2008/" name="Box" symbolType="graphic">
      <timeline><DOMTimeline name="Box"><layers><DOMLayer name="Layer 1"><frames>
        <DOMFrame index="0"><elements>${rectShape(0, 0, 20, 20, RED)}</elements></DOMFrame>
      </frames></DOMLayer></layers></DOMTimeline></timeline>
    </DOMSymbolItem>`;
    const doc = await parseXfl({
      'DOMDocument.xml': domDocument(tween).replace('<Include href="Panel.xml"/>', '<Include href="Box.xml"/>'),
      'LIBRARY/Box.xml': box,
    });
    await renderer.setDocument(doc);
    renderer.renderFrame(10);
    // Centered on (260, 110), about 18px wide.
    expect(colorAt(canvas, 260, 110)).toBe(RED);
    expect(colorAt(canvas, 254, 110)).toBe(RED);
    expect(colorAt(canvas, 246, 110)).toBe(WHITE);
    expect(colorAt(canvas, 274, 110)).toBe(WHITE);
  });
});
