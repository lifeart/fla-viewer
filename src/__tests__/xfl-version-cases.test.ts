import { describe, it, expect, beforeEach } from 'vitest';
import JSZip from 'jszip';
import { FLAParser, parseMotionTweenRotate } from '../fla-parser';
import { FLARenderer } from '../renderer';
import { readDirectoryEntry, xflFolderToZip, isXFLStub, XFL_STUB_CONTENT, type XFLFolderEntry } from '../xfl-folder';
import type { FLADocument, Shape, SymbolInstance } from '../types';

// Version-specific XFL cases that real Flash CS4..Animate files contain. The XML
// below mirrors what Flash CS5/CS6 writes (attribute names and value spellings
// were checked against real saved files in jindrapetrik/flacomdoc's test data).

async function parseXfl(files: Record<string, string>): Promise<FLADocument> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return new FLAParser().parse(await zip.generateAsync({ type: 'uint8array' }));
}

function domDocument(layers: string, symbols: string[] = []): string {
  const includes = symbols.map((name) => `<Include href="${name}.xml"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<DOMDocument xmlns="http://ns.adobe.com/xfl/2008/" width="550" height="400" frameRate="24" backgroundColor="#FFFFFF" xflVersion="2.0">
  <symbols>${includes}</symbols>
  <timelines><DOMTimeline name="Scene 1"><layers>${layers}</layers></DOMTimeline></timelines>
</DOMDocument>`;
}

function symbolItem(name: string, elements: string): string {
  return `<DOMSymbolItem xmlns="http://ns.adobe.com/xfl/2008/" name="${name}" symbolType="graphic">
  <timeline><DOMTimeline name="${name}"><layers><DOMLayer name="Layer 1"><frames>
    <DOMFrame index="0"><elements>${elements}</elements></DOMFrame>
  </frames></DOMLayer></layers></DOMTimeline></timeline>
</DOMSymbolItem>`;
}

/** A solid rectangle shape (fill style 1) in its own coordinates. */
function rectShape(x: number, y: number, w: number, h: number, color: string): string {
  const t = (v: number) => v * 20; // twips
  return `<DOMShape><fills><FillStyle index="1"><SolidColor color="${color}"/></FillStyle></fills>
  <edges><Edge fillStyle1="1" edges="!${t(x)} ${t(y)}|${t(x + w)} ${t(y)}|${t(x + w)} ${t(y + h)}|${t(x)} ${t(y + h)}|${t(x)} ${t(y)}"/></edges>
</DOMShape>`;
}

function stroked(strokeXml: string): string {
  return `<DOMShape><strokes><StrokeStyle index="1">${strokeXml}</StrokeStyle></strokes>
  <edges><Edge strokeStyle="1" edges="!0 0|2000 0"/></edges></DOMShape>`;
}

function firstShape(doc: FLADocument): Shape {
  return doc.timelines[0].layers[0].frames[0].elements[0] as Shape;
}

const colorAt = (canvas: HTMLCanvasElement, x: number, y: number): string => {
  const s = canvas.width / 550;
  const d = canvas.getContext('2d')!.getImageData(Math.floor(x * s), Math.floor(y * s), 1, 1).data;
  return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
};

describe('classic tween rotation direction', () => {
  it.each([
    ['clockwise', 'cw'],
    ['counter-clockwise', 'ccw'],
    ['cw', 'cw'],
    ['ccw', 'ccw'],
    ['none', 'none'],
    ['auto', undefined],
    [null, undefined],
  ])('maps motionTweenRotate=%s to %s', (value, expected) => {
    expect(parseMotionTweenRotate(value)).toBe(expected);
  });

  describe('renders the spelled-out values Animate writes', () => {
    let canvas: HTMLCanvasElement;
    let renderer: FLARenderer;
    beforeEach(() => {
      canvas = document.createElement('canvas');
      renderer = new FLARenderer(canvas);
    });

    // A 100x10 red bar pivoting at (200,200), rotating from 0deg to 180deg over 10
    // frames. Both directions end at the same matrix; halfway, clockwise (screen,
    // y-down) points the bar down and counter-clockwise points it up.
    async function renderHalfway(direction: string): Promise<void> {
      const doc = await parseXfl({
        'DOMDocument.xml': domDocument(`<DOMLayer name="Bar"><frames>
          <DOMFrame index="0" duration="10" tweenType="motion" motionTweenRotate="${direction}" keyMode="22017">
            <elements><DOMSymbolInstance libraryItemName="Bar" symbolType="graphic"><matrix><Matrix tx="200" ty="200"/></matrix></DOMSymbolInstance></elements>
          </DOMFrame>
          <DOMFrame index="10" duration="1" keyMode="9728">
            <elements><DOMSymbolInstance libraryItemName="Bar" symbolType="graphic"><matrix><Matrix a="-1" d="-1" tx="200" ty="200"/></matrix></DOMSymbolInstance></elements>
          </DOMFrame>
        </frames></DOMLayer>`, ['Bar']),
        'LIBRARY/Bar.xml': symbolItem('Bar', rectShape(0, -5, 100, 10, '#FF0000')),
      });
      await renderer.setDocument(doc);
      renderer.renderFrame(5);
    }

    it('turns a "clockwise" tween clockwise', async () => {
      await renderHalfway('clockwise');
      expect(colorAt(canvas, 200, 260)).toBe('#FF0000');
      expect(colorAt(canvas, 200, 140)).toBe('#FFFFFF');
    });

    it('turns a "counter-clockwise" tween counter-clockwise', async () => {
      await renderHalfway('counter-clockwise');
      expect(colorAt(canvas, 200, 140)).toBe('#FF0000');
      expect(colorAt(canvas, 200, 260)).toBe('#FFFFFF');
    });
  });
});

describe('patterned stroke styles', () => {
  const parseStroke = async (xml: string) =>
    firstShape(await parseXfl({
      'DOMDocument.xml': domDocument(`<DOMLayer name="L"><frames><DOMFrame index="0"><elements>${stroked(xml)}</elements></DOMFrame></frames></DOMLayer>`),
    })).strokes[0];

  const red = '<fill><SolidColor color="#FF0000"/></fill>';

  it('reads the dash1/dash2 lengths Animate writes on DashedStroke', async () => {
    const s = await parseStroke(`<DashedStroke dash1="10" dash2="12" scaleMode="normal" weight="5.5">${red}</DashedStroke>`);
    expect(s).toMatchObject({ type: 'solid', color: '#FF0000', weight: 5.5, dash: [10, 12] });
  });

  it('draws a DottedStroke as round dots spaced by dotSpace', async () => {
    const s = await parseStroke(`<DottedStroke scaleMode="normal" weight="5.5" dotSpace="8">${red}</DottedStroke>`);
    expect(s).toMatchObject({ type: 'solid', color: '#FF0000', weight: 5.5, caps: 'round', dash: [0, 13.5] });
  });

  it('defaults DottedStroke dotSpace to 3', async () => {
    const s = await parseStroke(`<DottedStroke weight="2">${red}</DottedStroke>`);
    expect(s.dash).toEqual([0, 5]);
  });

  it.each([
    '<HatchedStroke scaleMode="normal" weight="5.5" curve="medium curve" hatchThickness="medium" jiggle="loose" length="medium variation" rotate="slight" space="distant">',
    '<RaggedStroke scaleMode="normal" weight="5.5" pattern="random dotted" waveHeight="very wavy" waveLength="medium">',
    '<StippleStroke scaleMode="normal" weight="5.5" dotSize="medium" variation="random sizes" density="very sparse">',
  ])('keeps an artistic stroke as a solid line: %s', async (open) => {
    const tag = open.slice(1, open.indexOf(' '));
    const s = await parseStroke(`${open}${red}</${tag}>`);
    expect(s).toMatchObject({ type: 'solid', color: '#FF0000', weight: 5.5 });
    expect(s.dash).toBeUndefined();
  });

  it('renders a dotted stroke with gaps between the dots', async () => {
    const canvas = document.createElement('canvas');
    const renderer = new FLARenderer(canvas);
    const doc = await parseXfl({
      'DOMDocument.xml': domDocument(`<DOMLayer name="L"><frames><DOMFrame index="0"><elements>
        <DOMShape><matrix><Matrix tx="100" ty="100"/></matrix>
          <strokes><StrokeStyle index="1"><DottedStroke weight="10" dotSpace="10">${red}</DottedStroke></StrokeStyle></strokes>
          <edges><Edge strokeStyle="1" edges="!0 0|4000 0"/></edges></DOMShape>
      </elements></DOMFrame></frames></DOMLayer>`),
    });
    await renderer.setDocument(doc);
    renderer.renderFrame(0);
    // Dots are centred every 20px from x=100; midway between two dots is empty.
    expect(colorAt(canvas, 100, 100)).toBe('#FF0000');
    expect(colorAt(canvas, 120, 100)).toBe('#FF0000');
    expect(colorAt(canvas, 110, 100)).toBe('#FFFFFF');
  });
});

describe('uncompressed XFL folders (CS5+ "Save as XFL")', () => {
  const enc = (text: string) => new TextEncoder().encode(text);
  const folderDoc = domDocument(`<DOMLayer name="L"><frames><DOMFrame index="0"><elements>
    <DOMSymbolInstance libraryItemName="Box" symbolType="graphic"><matrix><Matrix tx="10" ty="20"/></matrix></DOMSymbolInstance>
  </elements></DOMFrame></frames></DOMLayer>`, ['Box']);

  const folder = (prefix: string): XFLFolderEntry[] => [
    { path: `${prefix}Anim.xfl`, data: enc(XFL_STUB_CONTENT) },
    { path: `${prefix}DOMDocument.xml`, data: enc(folderDoc) },
    { path: `${prefix}LIBRARY/Box.xml`, data: new Blob([symbolItem('Box', rectShape(0, 0, 10, 10, '#00FF00'))]) },
    { path: `${prefix}PublishSettings.xml`, data: enc('<PublishSettings/>') },
  ];

  it.each([
    ['at the root', ''],
    ['inside the dropped folder', 'Anim/'],
    ['nested two folders deep with Windows separators', 'Projects\\Anim\\'],
  ])('parses a folder %s', async (_label, prefix) => {
    const doc = await new FLAParser().parse(folder(prefix));
    expect(doc.width).toBe(550);
    expect(doc.symbols.has('Box')).toBe(true);
    const instance = doc.timelines[0].layers[0].frames[0].elements[0] as SymbolInstance;
    expect(instance).toMatchObject({ type: 'symbol', libraryItemName: 'Box' });
    expect(instance.matrix).toMatchObject({ tx: 10, ty: 20 });
  });

  it('uses the shallowest DOMDocument.xml and ignores files outside it', () => {
    const zip = xflFolderToZip([
      ...folder('Anim/'),
      { path: 'Anim/backup/DOMDocument.xml', data: enc('<DOMDocument/>') },
      { path: 'readme.txt', data: enc('outside') },
    ]);
    expect(Object.keys(zip.files).sort()).toEqual(
      ['Anim.xfl', 'DOMDocument.xml', 'LIBRARY/', 'LIBRARY/Box.xml', 'PublishSettings.xml', 'backup/', 'backup/DOMDocument.xml'].sort()
    );
  });

  it('rejects a folder without DOMDocument.xml', async () => {
    await expect(new FLAParser().parse([{ path: 'x/LIBRARY/a.xml', data: enc('<a/>') }]))
      .rejects.toThrow('DOMDocument.xml not found');
  });

  it('explains that the .xfl stub alone cannot be opened', async () => {
    expect(isXFLStub(enc('PROXY-CS5'))).toBe(true);
    expect(isXFLStub(enc('PROXY-CS5\r\n'))).toBe(true);
    expect(isXFLStub(enc('PK\u0003\u0004'))).toBe(false);
    await expect(new FLAParser().parse(new File([enc('PROXY-CS5')], 'Anim.xfl')))
      .rejects.toThrow('Open the whole folder');
  });

  it('reads every file of a dropped directory, across readEntries batches', async () => {
    // Minimal stand-ins for the File and Directory Entries API.
    const fileEntry = (name: string, text: string) => ({
      isFile: true, isDirectory: false, name,
      file: (ok: (f: File) => void) => ok(new File([text], name)),
    });
    const dirEntry = (name: string, children: unknown[][]): unknown => ({
      isFile: false, isDirectory: true, name,
      createReader: () => {
        const batches = [...children, []];
        return { readEntries: (ok: (e: unknown[]) => void) => ok(batches.shift() ?? []) };
      },
    });
    const root = dirEntry('Anim', [
      [fileEntry('DOMDocument.xml', folderDoc)],
      [dirEntry('LIBRARY', [[fileEntry('Box.xml', symbolItem('Box', rectShape(0, 0, 10, 10, '#00FF00')))]])],
    ]);
    const entries = await readDirectoryEntry(root as FileSystemDirectoryEntry);
    expect(entries.map((e) => e.path).sort()).toEqual(['Anim/DOMDocument.xml', 'Anim/LIBRARY/Box.xml']);
    const doc = await new FLAParser().parse(entries);
    expect(doc.symbols.has('Box')).toBe(true);
  });
});

describe('primitive rectangles and ovals (DOMRectangleObject / DOMOvalObject)', () => {
  const RED = '#FF0000';
  const WHITE = '#FFFFFF';
  const layerWith = (elements: string) =>
    domDocument(`<DOMLayer name="L"><frames><DOMFrame index="0"><elements>${elements}</elements></DOMFrame></frames></DOMLayer>`);
  const redFill = `<fill><SolidColor color="${RED}"/></fill>`;

  async function render(elements: string): Promise<HTMLCanvasElement> {
    const canvas = document.createElement('canvas');
    const renderer = new FLARenderer(canvas);
    await renderer.setDocument(await parseXfl({ 'DOMDocument.xml': layerWith(elements) }));
    renderer.renderFrame(0);
    return canvas;
  }

  it('parses a rectangle primitive as a shape with its fill, stroke and matrix', async () => {
    // As written by Flash CS5 (a component skin): x/y is the top-left corner in the
    // element's own space, before <matrix>.
    const doc = await parseXfl({ 'DOMDocument.xml': layerWith(`
      <DOMRectangleObject objectWidth="225" objectHeight="335" x="110" y="-10" lockFlag="true" topLeftRadius="20" topRightRadius="20" bottomLeftRadius="20" bottomRightRadius="20">
        <matrix><Matrix a="1.239990234375" tx="-136.4" ty="10"/></matrix>
        <transformationPoint><Point x="222.5" y="157.5"/></transformationPoint>
        <fill><SolidColor color="#EEEEEE"/></fill>
        <stroke><SolidStroke scaleMode="normal" weight="2"><fill><SolidColor color="#CCCCCC"/></fill></SolidStroke></stroke>
      </DOMRectangleObject>`) });
    const shape = firstShape(doc);
    expect(shape.type).toBe('shape');
    expect(shape.matrix).toMatchObject({ a: 1.239990234375, tx: -136.4, ty: 10 });
    expect(shape.fills).toMatchObject([{ index: 1, type: 'solid', color: '#EEEEEE' }]);
    expect(shape.strokes).toMatchObject([{ index: 1, type: 'solid', color: '#CCCCCC', weight: 2 }]);
    expect(shape.edges).toHaveLength(1);
    expect(shape.edges[0]).toMatchObject({ fillStyle1: 1, strokeStyle: 1 });
    const cmds = shape.edges[0].commands;
    expect(cmds[0]).toEqual({ type: 'M', x: 130, y: -10 });
    // Rounded corners are cubic arcs; the outline ends where it started.
    expect(cmds.filter((c) => c.type === 'C')).toHaveLength(4);
    expect(cmds[cmds.length - 1]).toMatchObject({ x: 130, y: -10 });
  });

  it('finds primitives inside groups', async () => {
    const doc = await parseXfl({ 'DOMDocument.xml': layerWith(`
      <DOMGroup><members>
        <DOMRectangleObject objectWidth="10" objectHeight="10" x="0" y="0">${redFill}</DOMRectangleObject>
        <DOMOvalObject objectWidth="10" objectHeight="10" x="0" y="0">${redFill}</DOMOvalObject>
      </members></DOMGroup>`) });
    const elements = doc.timelines[0].layers[0].frames[0].elements;
    expect(elements.map((e) => e.type)).toEqual(['shape', 'shape']);
  });

  it('draws a rounded rectangle with its corners cut away', async () => {
    const canvas = await render(`<DOMRectangleObject objectWidth="200" objectHeight="100" x="100" y="100" lockFlag="true" topLeftRadius="30">${redFill}</DOMRectangleObject>`);
    expect(colorAt(canvas, 200, 150)).toBe(RED);
    expect(colorAt(canvas, 102, 150)).toBe(RED);
    // lockFlag applies the top-left radius to every corner.
    for (const [x, y] of [[102, 102], [297, 102], [297, 197], [102, 197]]) {
      expect(colorAt(canvas, x, y), `corner ${x},${y}`).toBe(WHITE);
    }
  });

  it('draws square corners when there is no radius', async () => {
    const canvas = await render(`<DOMRectangleObject objectWidth="200" objectHeight="100" x="100" y="100">${redFill}</DOMRectangleObject>`);
    expect(colorAt(canvas, 103, 103)).toBe(RED);
    expect(colorAt(canvas, 296, 196)).toBe(RED);
    expect(colorAt(canvas, 305, 150)).toBe(WHITE);
  });

  it('cuts negative corner radii inwards', async () => {
    const canvas = await render(`<DOMRectangleObject objectWidth="200" objectHeight="100" x="100" y="100" topLeftRadius="-30">${redFill}</DOMRectangleObject>`);
    expect(colorAt(canvas, 110, 110)).toBe(WHITE); // within 30px of the corner
    expect(colorAt(canvas, 128, 128)).toBe(RED);
    expect(colorAt(canvas, 297, 102)).toBe(RED); // other corners stay square
  });

  it('draws an oval primitive as an ellipse', async () => {
    const canvas = await render(`<DOMOvalObject objectWidth="200" objectHeight="100" x="100" y="100">${redFill}</DOMOvalObject>`);
    expect(colorAt(canvas, 200, 150)).toBe(RED);
    expect(colorAt(canvas, 105, 150)).toBe(RED);
    expect(colorAt(canvas, 110, 108)).toBe(WHITE);
  });

  it('leaves the hole of an oval with an inner radius empty', async () => {
    const canvas = await render(`<DOMOvalObject objectWidth="200" objectHeight="100" x="100" y="100" innerRadius="50">${redFill}</DOMOvalObject>`);
    expect(colorAt(canvas, 200, 150)).toBe(WHITE);
    expect(colorAt(canvas, 125, 150)).toBe(RED);
    expect(colorAt(canvas, 275, 150)).toBe(RED);
  });

  it('draws a pie wedge between startAngle and endAngle, clockwise from 3 o\'clock', async () => {
    const canvas = await render(`<DOMOvalObject objectWidth="200" objectHeight="200" x="100" y="100" startAngle="0" endAngle="90">${redFill}</DOMOvalObject>`);
    expect(colorAt(canvas, 250, 250)).toBe(RED); // bottom-right quadrant
    expect(colorAt(canvas, 250, 150)).toBe(WHITE);
    expect(colorAt(canvas, 150, 250)).toBe(WHITE);
  });

  it('strokes but does not fill an open arc (closePath="false")', async () => {
    const doc = await parseXfl({ 'DOMDocument.xml': layerWith(`
      <DOMOvalObject objectWidth="200" objectHeight="200" x="100" y="100" startAngle="0" endAngle="90" closePath="false">
        ${redFill}<stroke><SolidStroke weight="4"><fill><SolidColor color="#0000FF"/></fill></SolidStroke></stroke>
      </DOMOvalObject>`) });
    const shape = firstShape(doc);
    expect(shape.fills).toEqual([]);
    expect(shape.edges[0].fillStyle1).toBeUndefined();
    expect(shape.edges[0].strokeStyle).toBe(1);
  });
});

describe('CS4+ object motion tweens (tweenType="motion object")', () => {
  // A 20x20 red box symbol moved 200px right over a 11-frame span, as Flash CS5
  // saves it: one DOMFrame for the whole span, keys inside <AnimationCore>.
  const motionLayer = (extraBasic = '', colors = '') => `<DOMLayer name="Tween" animationType="motion object"><frames>
    <DOMFrame index="0" duration="11" tweenType="motion object" motionTweenRotate="none" motionTweenScale="false" isMotionObject="true" visibleAnimationKeyframes="2097151" keyMode="8195">
      <motionObjectXML><AnimationCore TimeScale="24000" Version="1" duration="11000"><TimeMap strength="0" type="Quadratic"/><metadata><Settings orientToPath="0" xformPtXOffsetPct="0.5" xformPtYOffsetPct="0.5" xformPtZOffsetPixels="0"/></metadata>
        <PropertyContainer id="headContainer">
          <PropertyContainer id="Basic_Motion">
            <Property enabled="1" id="Motion_X" ignoreTimeMap="0" readonly="0" visible="1"><Keyframe anchor="0,0" next="0,0" previous="0,0" roving="0" timevalue="0"/><Keyframe anchor="0,200" next="0,200" previous="0,200" roving="0" timevalue="10000"/></Property>
            <Property enabled="1" id="Motion_Y" ignoreTimeMap="0" readonly="0" visible="1"><Keyframe anchor="0,0" next="0,0" previous="0,0" roving="0" timevalue="0"/></Property>
            <Property enabled="1" id="Rotation_Z" ignoreTimeMap="0" readonly="0" visible="1"><Keyframe anchor="0,0" next="0,0" previous="0,0" roving="0" timevalue="0"/></Property>
            ${extraBasic}
          </PropertyContainer>
          <PropertyContainer id="Transformation">
            <Property enabled="1" id="Skew_X" ignoreTimeMap="0" readonly="0" visible="1"><Keyframe anchor="0,0" next="0,0" previous="0,0" roving="0" timevalue="0"/></Property>
            <Property enabled="1" id="Skew_Y" ignoreTimeMap="0" readonly="0" visible="1"><Keyframe anchor="0,0" next="0,0" previous="0,0" roving="0" timevalue="0"/></Property>
            <Property enabled="1" id="Scale_X" ignoreTimeMap="0" readonly="0" visible="1"><Keyframe anchor="0,100" next="0,100" previous="0,100" roving="0" timevalue="0"/></Property>
            <Property enabled="1" id="Scale_Y" ignoreTimeMap="0" readonly="0" visible="1"><Keyframe anchor="0,100" next="0,100" previous="0,100" roving="0" timevalue="0"/></Property>
          </PropertyContainer>
          <PropertyContainer id="Colors">${colors}</PropertyContainer><PropertyContainer id="Filters"/>
        </PropertyContainer></AnimationCore></motionObjectXML>
      <elements><DOMSymbolInstance libraryItemName="Box" name="" centerPoint3DX="60" centerPoint3DY="110">
        <matrix><Matrix tx="50" ty="100"/></matrix><transformationPoint><Point x="10" y="10"/></transformationPoint>
      </DOMSymbolInstance></elements>
    </DOMFrame>
  </frames></DOMLayer>`;

  const files = (layer: string) => ({
    'DOMDocument.xml': domDocument(layer, ['Box']),
    'LIBRARY/Box.xml': symbolItem('Box', rectShape(0, 0, 20, 20, '#FF0000')),
  });

  it('parses the AnimationCore onto the frame', async () => {
    const doc = await parseXfl(files(motionLayer()));
    const frame = doc.timelines[0].layers[0].frames[0];
    expect(frame.tweenType).toBe('motion object');
    expect(frame.motionObject?.timeScale).toBe(24000);
    expect(frame.motionObject?.properties.Motion_X.keyframes.map((k) => k.value)).toEqual([0, 200]);
  });

  it.each([
    [0, 60],
    [5, 160],
    [10, 260],
  ])('draws the box at its tweened position on frame %d', async (frameIndex, centerX) => {
    const canvas = document.createElement('canvas');
    const renderer = new FLARenderer(canvas);
    await renderer.setDocument(await parseXfl(files(motionLayer())));
    renderer.renderFrame(frameIndex);
    expect(colorAt(canvas, centerX, 110)).toBe('#FF0000');
    expect(colorAt(canvas, centerX - 15, 110)).toBe('#FFFFFF');
    expect(colorAt(canvas, centerX + 15, 110)).toBe('#FFFFFF');
  });

  it('moves a mask driven by an object tween', async () => {
    const mask = motionLayer().replace('<DOMLayer name="Tween" animationType="motion object">', '<DOMLayer name="Mask" layerType="mask" animationType="motion object">');
    const masked = `<DOMLayer name="Content" layerType="masked" parentLayerIndex="0"><frames><DOMFrame index="0" duration="11"><elements>
      ${rectShape(0, 0, 550, 400, '#0000FF')}
    </elements></DOMFrame></frames></DOMLayer>`;
    const canvas = document.createElement('canvas');
    const renderer = new FLARenderer(canvas);
    await renderer.setDocument(await parseXfl({ ...files(''), 'DOMDocument.xml': domDocument(mask + masked, ['Box']) }));
    renderer.renderFrame(5);
    expect(colorAt(canvas, 160, 110)).toBe('#0000FF');
    expect(colorAt(canvas, 60, 110)).toBe('#FFFFFF'); // where the mask started
  });

  it('fades the instance with an Alpha_Amount curve', async () => {
    const alpha = `<PropertyContainer id="Alpha_ColorXform"><Property enabled="1" id="Alpha_Amount" ignoreTimeMap="0" readonly="0" visible="1">
      <Keyframe anchor="0,100" next="0,100" previous="0,100" roving="0" timevalue="0"/><Keyframe anchor="0,0" next="0,0" previous="0,0" roving="0" timevalue="10000"/>
    </Property></PropertyContainer>`;
    const canvas = document.createElement('canvas');
    const renderer = new FLARenderer(canvas);
    await renderer.setDocument(await parseXfl(files(motionLayer('', alpha))));
    renderer.renderFrame(5);
    // Half transparent red over white.
    const [r, g, b] = Array.from(canvas.getContext('2d')!.getImageData(Math.floor(160 * canvas.width / 550), Math.floor(110 * canvas.width / 550), 1, 1).data);
    expect(r).toBeGreaterThan(245);
    expect(g).toBeGreaterThan(110);
    expect(g).toBeLessThan(145);
    expect(b).toBe(g);
  });
});

describe('reverse graphic loop modes (Animate 2021)', () => {
  // A 3-frame graphic symbol: red, green, blue (one 20x20 box per frame).
  const symbol = `<DOMSymbolItem xmlns="http://ns.adobe.com/xfl/2008/" name="RGB" symbolType="graphic">
    <timeline><DOMTimeline name="RGB"><layers><DOMLayer name="Layer 1"><frames>
      <DOMFrame index="0"><elements>${rectShape(0, 0, 20, 20, '#FF0000')}</elements></DOMFrame>
      <DOMFrame index="1"><elements>${rectShape(0, 0, 20, 20, '#00FF00')}</elements></DOMFrame>
      <DOMFrame index="2"><elements>${rectShape(0, 0, 20, 20, '#0000FF')}</elements></DOMFrame>
    </frames></DOMLayer></layers></DOMTimeline></timeline>
  </DOMSymbolItem>`;

  async function colorsFor(loop: string, firstFrame: number): Promise<string[]> {
    const doc = await parseXfl({
      'DOMDocument.xml': domDocument(`<DOMLayer name="L"><frames><DOMFrame index="0" duration="5"><elements>
        <DOMSymbolInstance libraryItemName="RGB" symbolType="graphic" loop="${loop}" firstFrame="${firstFrame}"><matrix><Matrix tx="100" ty="100"/></matrix></DOMSymbolInstance>
      </elements></DOMFrame></frames></DOMLayer>`, ['RGB']),
      'LIBRARY/RGB.xml': symbol,
    });
    const instance = doc.timelines[0].layers[0].frames[0].elements[0] as SymbolInstance;
    expect(instance.loop).toBe(loop);
    const canvas = document.createElement('canvas');
    const renderer = new FLARenderer(canvas);
    await renderer.setDocument(doc);
    const colors: string[] = [];
    for (let f = 0; f < 5; f++) {
      renderer.renderFrame(f);
      colors.push(colorAt(canvas, 110, 110));
    }
    return colors;
  }

  const R = '#FF0000', G = '#00FF00', B = '#0000FF';

  it('plays a "loop reverse" graphic backwards and wraps', async () => {
    expect(await colorsFor('loop reverse', 2)).toEqual([B, G, R, B, G]);
  });

  it('plays a "play once reverse" graphic backwards and stops on frame 0', async () => {
    expect(await colorsFor('play once reverse', 2)).toEqual([B, G, R, R, R]);
  });
});
