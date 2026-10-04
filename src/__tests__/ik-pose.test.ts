import { describe, it, expect, beforeEach } from 'vitest';
import JSZip from 'jszip';
import { FLAParser } from '../fla-parser';
import { FLARenderer } from '../renderer';
import { exportSVG } from '../video-exporter';
import { applyIKPose } from '../ik-pose';
import type { FLADocument, Frame, Matrix, SymbolInstance } from '../types';

// IK pose spans (Bone tool armatures). The XML mirrors what Flash CS5/CS6 write
// (checked against real saves: the shape armature in jindrapetrik/flacomdoc's
// 0023_inverse_kinematics test, and a public CS6 project with four animated
// symbol armatures): the pose layer's span is one `tweenType="IK pose"`
// keyframe holding the armature in its first pose, and
// `<betweenFrameMatrixList>` holds one matrix per element per frame,
// element-major, applied on top of each element's matrix in the parent's space.

async function parseXfl(files: Record<string, string>): Promise<FLADocument> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return new FLAParser().parse(await zip.generateAsync({ type: 'uint8array' }));
}

function domDocument(layers: string, symbols: string[]): string {
  const includes = symbols.map((name) => `<Include href="${name}.xml"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<DOMDocument xmlns="http://ns.adobe.com/xfl/2008/" width="550" height="400" frameRate="24" backgroundColor="#FFFFFF" xflVersion="2.2">
  <symbols>${includes}</symbols>
  <timelines><DOMTimeline name="Scene 1"><layers>${layers}</layers></DOMTimeline></timelines>
</DOMDocument>`;
}

function symbolItem(name: string, layers: string): string {
  return `<DOMSymbolItem xmlns="http://ns.adobe.com/xfl/2008/" name="${name}" symbolType="graphic">
  <timeline><DOMTimeline name="${name}"><layers>${layers}</layers></DOMTimeline></timeline>
</DOMSymbolItem>`;
}

/** A symbol holding one solid rectangle shape, in its own coordinates. */
function rectSymbol(name: string, x: number, y: number, w: number, h: number, color: string): string {
  const t = (v: number) => v * 20; // twips
  return symbolItem(name, `<DOMLayer name="Layer 1"><frames><DOMFrame index="0"><elements>
    <DOMShape><fills><FillStyle index="1"><SolidColor color="${color}"/></FillStyle></fills>
    <edges><Edge fillStyle1="1" edges="!${t(x)} ${t(y)}|${t(x + w)} ${t(y)}|${t(x + w)} ${t(y + h)}|${t(x)} ${t(y + h)}|${t(x)} ${t(y)}"/></edges></DOMShape>
  </elements></DOMFrame></frames></DOMLayer>`);
}

function matrixXml(m: Partial<Matrix>): string {
  const attrs = Object.entries(m).map(([k, v]) => `${k}="${v}"`).join(' ');
  return `<Matrix${attrs ? ' ' + attrs : ''}/>`;
}

function instanceXml(name: string, ref: string, m: Partial<Matrix>): string {
  return `<DOMSymbolInstance libraryItemName="${name}" name="ikNode_${ref}" referenceID="${ref}" symbolType="graphic">
    <matrix>${matrixXml(m)}</matrix><transformationPoint><Point/></transformationPoint></DOMSymbolInstance>`;
}

/**
 * An IK pose keyframe. `poses[e][f]` is element e's matrix for frame f of the
 * span; the list is written element-major like Flash does. The IK tree carries
 * matrices of its own, which must not be read as poses.
 */
function ikPoseFrame(index: number, elements: string, poses: Partial<Matrix>[][]): string {
  const duration = poses[0]?.length ?? 1;
  return `<DOMFrame index="${index}" duration="${duration}" tweenType="IK pose" keyMode="9732" isIKPose="true" poseLocations="0,${duration - 1}">
    <elements>${elements}</elements>
    <betweenFrameMatrixList>${poses.flat().map(matrixXml).join('')}</betweenFrameMatrixList>
    <IKTree name="Armature_1" treeName="ikTreeName2">
      <IKNode name="ikNode_1" boneName="ikBoneName1" referenceID="A" speed="1">
        <worldMatrix><Matrix tx="999" ty="999"/></worldMatrix>
        <childNodes><ChildNode name="ikNode_2" boneName="ikBoneName2" referenceID="B" xArray="0" yArray="0" angleArray="0" speed="1">
          <states><State duration="${duration}" x="1600" y="0"/></states>
          <worldMatrix><Matrix a="-1" d="-1"/></worldMatrix>
        </ChildNode></childNodes>
      </IKNode>
      <states><IKState duration="${duration}"/></states>
    </IKTree>
  </DOMFrame>`;
}

// A two-bone arm: Upper (red, 80x10) from its joint at (150,150) to the elbow at
// (230,150), Lower (blue) from the elbow on. Each bar's transformation point is
// its joint at the bar's left end. Over the span the shoulder turns 45 then 90
// degrees clockwise and the lower bone ends horizontal again:
//   frame 0: rest pose, both bars along y = 150
//   frame 1: both turned 45 degrees about the shoulder
//   frame 2: Upper points down to the elbow at (150,230); Lower runs right from it.
const R45 = Math.SQRT1_2;
const upperPoses: Partial<Matrix>[] = [
  {},
  { a: R45, b: R45, c: -R45, d: R45, tx: 150, ty: 150 - 300 * R45 },
  { a: 0, b: 1, c: -1, d: 0, tx: 300 },
];
const lowerPoses: Partial<Matrix>[] = [{}, upperPoses[1], { tx: -80, ty: 80 }];

function armLayer(index = 0): string {
  const blank = index > 0 ? `<DOMFrame index="0" duration="${index}" keyMode="9728"><elements/></DOMFrame>` : '';
  return `<DOMLayer name="Armature_1" color="#9933CC" animationType="IK pose"><frames>${blank}
    ${ikPoseFrame(index, instanceXml('Upper', 'A', { tx: 150, ty: 150 }) + instanceXml('Lower', 'B', { tx: 230, ty: 150 }), [upperPoses, lowerPoses])}
  </frames></DOMLayer>`;
}

const armSymbols = {
  'LIBRARY/Upper.xml': rectSymbol('Upper', 0, -5, 80, 10, '#FF0000'),
  'LIBRARY/Lower.xml': rectSymbol('Lower', 0, -5, 80, 10, '#0000FF'),
};

const colorAt = (canvas: HTMLCanvasElement, x: number, y: number): string => {
  const s = canvas.width / 550;
  const d = canvas.getContext('2d')!.getImageData(Math.floor(x * s), Math.floor(y * s), 1, 1).data;
  return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
};

const ikFrame = (doc: FLADocument): Frame =>
  doc.timelines[0].layers[0].frames.find((f) => f.tweenType === 'IK pose')!;

describe('IK pose span parsing', () => {
  it('splits betweenFrameMatrixList per element, element-major', async () => {
    const poses = [0, 1].map((e) => [0, 1, 2].map((f) => ({ tx: 10 * e + f })));
    const doc = await parseXfl({
      'DOMDocument.xml': domDocument(`<DOMLayer name="Armature_1" animationType="IK pose"><frames>
        ${ikPoseFrame(0, instanceXml('Upper', 'A', { tx: 150 }) + instanceXml('Lower', 'B', { tx: 230 }), poses)}
      </frames></DOMLayer>`, ['Upper', 'Lower']),
      ...armSymbols,
    });
    const frame = ikFrame(doc);
    expect(frame.tweenType).toBe('IK pose');
    expect(frame.ikPoseMatrices?.map((list) => list.map((m) => m.tx))).toEqual([[0, 1, 2], [10, 11, 12]]);
    expect(frame.ikPoseMatrices?.[1][2]).toEqual({ a: 1, b: 0, c: 0, d: 1, tx: 12, ty: 0 });
    // The keyframe keeps the armature's first pose as its element matrices.
    expect((frame.elements[1] as SymbolInstance).matrix.tx).toBe(230);
  });

  it('reads a rotated pose (a="0" is not the default a=1)', async () => {
    const doc = await parseXfl({ 'DOMDocument.xml': domDocument(armLayer(), ['Upper', 'Lower']), ...armSymbols });
    expect(ikFrame(doc).ikPoseMatrices?.[0][2]).toEqual({ a: 0, b: 1, c: -1, d: 0, tx: 300, ty: 0 });
  });

  it('ignores a list whose length is not elements x duration', async () => {
    const doc = await parseXfl({
      'DOMDocument.xml': domDocument(`<DOMLayer name="Armature_1" animationType="IK pose"><frames>
        ${ikPoseFrame(0, instanceXml('Upper', 'A', {}) + instanceXml('Lower', 'B', {}), [[{}, {}, {}], [{}, {}]])}
      </frames></DOMLayer>`, ['Upper', 'Lower']),
      ...armSymbols,
    });
    const frame = ikFrame(doc);
    expect(frame.elements).toHaveLength(2);
    expect(frame.ikPoseMatrices).toBeUndefined();
  });

  it('ignores the list when <elements> does not parse one-to-one', async () => {
    // One XML element (a group) flattens to two display elements, so the
    // per-element blocks can't be lined up with frame.elements.
    const group = `<DOMGroup><members>${instanceXml('Upper', 'A', {})}${instanceXml('Lower', 'B', {})}</members></DOMGroup>`;
    const doc = await parseXfl({
      'DOMDocument.xml': domDocument(`<DOMLayer name="Armature_1" animationType="IK pose"><frames>
        ${ikPoseFrame(0, group, [[{ tx: 1 }, { tx: 2 }, { tx: 3 }]])}
      </frames></DOMLayer>`, ['Upper', 'Lower']),
      ...armSymbols,
    });
    const frame = ikFrame(doc);
    expect(frame.elements).toHaveLength(2);
    expect(frame.ikPoseMatrices).toBeUndefined();
  });
});

describe('applyIKPose', () => {
  const element = {
    type: 'symbol', libraryItemName: 'Upper', symbolType: 'graphic', loop: 'loop',
    matrix: { a: 1, b: 0, c: 0, d: 1, tx: 100, ty: 0 }, transformationPoint: { x: 0, y: 0 },
  } as SymbolInstance;
  const quarterTurn: Matrix = { a: 0, b: 1, c: -1, d: 0, tx: 0, ty: 0 };
  const frame = {
    index: 5, duration: 2, keyMode: 9732, tweenType: 'IK pose', elements: [element],
    ikPoseMatrices: [[{ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, quarterTurn]],
  } as Frame;

  it('applies the pose in the parent space, on top of the element matrix', () => {
    // pose * matrix turns the element about the parent origin: (100,0) -> (0,100).
    // (matrix * pose would turn it in place and leave it at (100,0).)
    expect(applyIKPose(frame, element, 0, 6).matrix).toEqual({ a: 0, b: 1, c: -1, d: 0, tx: 0, ty: 100 });
  });

  it('indexes the list from the span keyframe', () => {
    expect(applyIKPose(frame, element, 0, 5).matrix).toEqual(element.matrix);
  });

  it('passes elements through when there is no pose for them', () => {
    expect(applyIKPose(frame, element, 1, 6)).toBe(element);
    expect(applyIKPose({ ...frame, ikPoseMatrices: undefined }, element, 0, 6)).toBe(element);
  });
});

describe('IK pose rendering', () => {
  let canvas: HTMLCanvasElement;
  let renderer: FLARenderer;
  beforeEach(() => {
    canvas = document.createElement('canvas');
    renderer = new FLARenderer(canvas);
  });

  it('draws each frame of the span in its baked pose', async () => {
    // The span starts at frame 2, after two blank frames.
    const doc = await parseXfl({ 'DOMDocument.xml': domDocument(armLayer(2), ['Upper', 'Lower']), ...armSymbols });
    await renderer.setDocument(doc);

    renderer.renderFrame(2); // rest pose
    expect(colorAt(canvas, 190, 150)).toBe('#FF0000');
    expect(colorAt(canvas, 270, 150)).toBe('#0000FF');

    renderer.renderFrame(3); // both bones turned 45 degrees about the shoulder
    expect(colorAt(canvas, 150 + 40 * R45, 150 + 40 * R45)).toBe('#FF0000');
    expect(colorAt(canvas, 150 + 120 * R45, 150 + 120 * R45)).toBe('#0000FF');
    expect(colorAt(canvas, 190, 150)).toBe('#FFFFFF');

    renderer.renderFrame(4); // upper arm down, forearm level from the elbow
    expect(colorAt(canvas, 150, 190)).toBe('#FF0000');
    expect(colorAt(canvas, 190, 230)).toBe('#0000FF');
    expect(colorAt(canvas, 190, 150)).toBe('#FFFFFF');
    expect(colorAt(canvas, 270, 150)).toBe('#FFFFFF');
  });

  it('poses an armature used as a mask', async () => {
    // A graphic symbol holding the arm masks a green field: only the posed arm
    // shows green.
    const doc = await parseXfl({
      'DOMDocument.xml': domDocument(`
        <DOMLayer name="Mask" layerType="mask"><frames><DOMFrame index="0" duration="3"><elements>
          <DOMSymbolInstance libraryItemName="Arm" symbolType="graphic" loop="loop"><matrix><Matrix/></matrix></DOMSymbolInstance>
        </elements></DOMFrame></frames></DOMLayer>
        <DOMLayer name="Field" layerType="masked" parentLayerIndex="0"><frames><DOMFrame index="0" duration="3"><elements>
          <DOMSymbolInstance libraryItemName="Field" symbolType="graphic"><matrix><Matrix/></matrix></DOMSymbolInstance>
        </elements></DOMFrame></frames></DOMLayer>`, ['Arm', 'Upper', 'Lower', 'Field']),
      'LIBRARY/Arm.xml': symbolItem('Arm', armLayer()),
      'LIBRARY/Field.xml': rectSymbol('Field', 0, 0, 550, 400, '#00FF00'),
      ...armSymbols,
    });
    await renderer.setDocument(doc);

    renderer.renderFrame(2);
    expect(colorAt(canvas, 150, 190)).toBe('#00FF00');
    expect(colorAt(canvas, 190, 230)).toBe('#00FF00');
    expect(colorAt(canvas, 190, 150)).toBe('#FFFFFF');
    expect(colorAt(canvas, 270, 150)).toBe('#FFFFFF');
  });

  it('moves a layer rig-parented to a posed element', async () => {
    // A green marker on the elbow end of a one-element pose layer, parented to
    // it (Animate layer parenting), follows the element as it is posed.
    const doc = await parseXfl({
      'DOMDocument.xml': domDocument(`
        <DOMLayer name="Marker" parentLayerIndex="1"><frames><DOMFrame index="0" duration="3"><elements>
          <DOMSymbolInstance libraryItemName="Marker" symbolType="graphic"><matrix><Matrix tx="220" ty="145"/></matrix></DOMSymbolInstance>
        </elements></DOMFrame></frames></DOMLayer>
        <DOMLayer name="Armature_1" animationType="IK pose"><frames>
          ${ikPoseFrame(0, instanceXml('Upper', 'A', { tx: 150, ty: 150 }), [upperPoses])}
        </frames></DOMLayer>`, ['Upper', 'Marker']),
      'LIBRARY/Marker.xml': rectSymbol('Marker', 0, 0, 10, 10, '#00FF00'),
      ...armSymbols,
    });
    await renderer.setDocument(doc);

    renderer.renderFrame(0);
    expect(colorAt(canvas, 225, 150)).toBe('#00FF00');

    renderer.renderFrame(2); // the marker turned with the bone to (150,225)
    expect(colorAt(canvas, 150, 225)).toBe('#00FF00');
    expect(colorAt(canvas, 225, 150)).toBe('#FFFFFF');
  });

  it('exports the posed matrices to SVG', async () => {
    const doc = await parseXfl({ 'DOMDocument.xml': domDocument(armLayer(), ['Upper', 'Lower']), ...armSymbols });
    const svg = await (await exportSVG(doc, 2)).text();
    expect(svg).toContain('transform="matrix(0 1 -1 0 150 150)"');
    expect(svg).toContain('transform="matrix(1 0 0 1 150 230)"');
    expect(svg).not.toContain('transform="matrix(1 0 0 1 230 150)"');
  });

  it('plays a shape armature from its "ik container" symbol', async () => {
    // Bones inside a shape: Flash moves the shape into an "ik container" symbol
    // with one baked keyframe per frame of the span, placed as a play-once
    // graphic with identity poses (flacomdoc 0023 and an Animate 20.5 save).
    // This already worked before IK pose spans were read; it guards that path.
    const t = (v: number) => v * 20;
    const bakedFrame = (i: number, x: number) => `<DOMFrame index="${i}" keyMode="9728"><elements>
      <DOMShape><fills><FillStyle index="1"><SolidColor color="#FF0000"/></FillStyle></fills>
      <edges><Edge fillStyle1="1" edges="!${t(x)} 0|${t(x + 20)} 0|${t(x + 20)} ${t(20)}|${t(x)} ${t(20)}|${t(x)} 0"/></edges></DOMShape>
    </elements></DOMFrame>`;
    const doc = await parseXfl({
      'DOMDocument.xml': domDocument(`<DOMLayer name="Armature_6" animationType="IK pose"><frames>
        ${ikPoseFrame(0, `<DOMSymbolInstance libraryItemName="lsd_1" name="" symbolType="graphic" loop="play once">
          <matrix><Matrix tx="100" ty="100"/></matrix><transformationPoint><Point/></transformationPoint></DOMSymbolInstance>`, [[{}, {}, {}]])}
      </frames></DOMLayer>`, ['lsd_1']),
      'LIBRARY/lsd_1.xml': `<DOMSymbolItem xmlns="http://ns.adobe.com/xfl/2008/" name="lsd_1" symbolType="ik container">
        <timeline><DOMTimeline name="lsd_1"><layers><DOMLayer name="Layer 1"><frames>
          ${bakedFrame(0, 0)}${bakedFrame(1, 50)}${bakedFrame(2, 100)}
        </frames></DOMLayer></layers></DOMTimeline></timeline>
      </DOMSymbolItem>`,
    });
    await renderer.setDocument(doc);

    renderer.renderFrame(0);
    expect(colorAt(canvas, 110, 110)).toBe('#FF0000');
    renderer.renderFrame(2);
    expect(colorAt(canvas, 210, 110)).toBe('#FF0000');
    expect(colorAt(canvas, 110, 110)).toBe('#FFFFFF');
  });
});
