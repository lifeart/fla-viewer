import { describe, it, expect, beforeEach } from 'vitest';
import JSZip from 'jszip';
import { FLAParser, parseMotionTweenRotate, parseSymbolType } from '../fla-parser';
import { FLARenderer } from '../renderer';
import { exportSingleFrame, exportSpriteSheet, exportSVG } from '../video-exporter';
import { FLAPlayer } from '../player';
import { readDirectoryEntry, xflFolderToZip, isXFLStub, XFL_STUB_CONTENT, type XFLFolderEntry } from '../xfl-folder';
import { ovalPrimitivePath } from '../primitive-shapes';
import type { FLADocument, Matrix, PathCommand, Shape, SymbolInstance, TextInstance } from '../types';
import { interpolateDecomposed } from '../layer-utils';

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

    it('keeps a turning instance its size without a forced direction', async () => {
      // 0deg to 90deg: halfway the bar points down-right at 45deg, still 100px
      // long. Lerping a..d would shrink it to about 71px.
      const doc = await parseXfl({
        'DOMDocument.xml': domDocument(`<DOMLayer name="Bar"><frames>
          <DOMFrame index="0" duration="10" tweenType="motion" keyMode="22017">
            <elements><DOMSymbolInstance libraryItemName="Bar" symbolType="graphic"><matrix><Matrix tx="200" ty="200"/></matrix></DOMSymbolInstance></elements>
          </DOMFrame>
          <DOMFrame index="10" duration="1" keyMode="9728">
            <elements><DOMSymbolInstance libraryItemName="Bar" symbolType="graphic"><matrix><Matrix a="0" b="1" c="-1" d="0" tx="200" ty="200"/></matrix></DOMSymbolInstance></elements>
          </DOMFrame>
        </frames></DOMLayer>`, ['Bar']),
        'LIBRARY/Bar.xml': symbolItem('Bar', rectShape(0, -5, 100, 10, '#FF0000')),
      });
      await renderer.setDocument(doc);
      renderer.renderFrame(5);
      expect(colorAt(canvas, 265, 265)).toBe('#FF0000');
      expect(colorAt(canvas, 275, 275)).toBe('#FFFFFF');
    });
  });

  describe('interpolating a classic tween\'s matrix', () => {
    const turn = (deg: number, scale = 1) => {
      const r = (deg * Math.PI) / 180;
      return { a: scale * Math.cos(r), b: scale * Math.sin(r), c: -scale * Math.sin(r), d: scale * Math.cos(r), tx: 0, ty: 0 };
    };
    const close = (actual: Matrix, expected: Matrix) => {
      for (const k of ['a', 'b', 'c', 'd', 'tx', 'ty'] as const) expect(actual[k]).toBeCloseTo(expected[k], 9);
    };

    it('turns and scales separately', () => {
      close(interpolateDecomposed(turn(0), turn(90, 2), 0.5), turn(45, 1.5));
      close(interpolateDecomposed(turn(0), turn(90, 2), 0), turn(0));
      close(interpolateDecomposed(turn(0), turn(90, 2), 1), turn(90, 2));
    });

    it('turns the short way round', () => {
      close(interpolateDecomposed(turn(170), turn(-170), 0.5), turn(180));
    });

    it('keeps a mirrored instance mirrored while it turns', () => {
      const mirror = (m: Matrix) => ({ ...m, a: -m.a, b: -m.b });
      close(interpolateDecomposed(mirror(turn(0)), mirror(turn(90)), 0.5), mirror(turn(45)));
    });

    it('keeps the shape through a half turn instead of shearing it flat', () => {
      // A 150% x 100% instance turned 1 degree, tweened to 181 degrees: the
      // determinant stays 1.5, so it never passes through zero width.
      const from = { a: 1.499772, b: 0.026179, c: -0.017452, d: 0.999848, tx: 0, ty: 0 };
      const to = { a: -1.499772, b: -0.026179, c: 0.017452, d: -0.999848, tx: 0, ty: 0 };
      for (const t of [0.25, 0.5, 0.75]) {
        const m = interpolateDecomposed(from, to, t);
        expect(m.a * m.d - m.b * m.c).toBeCloseTo(1.5, 4);
        expect(Math.hypot(m.a, m.b)).toBeCloseTo(1.5, 4);
        expect(m.c).toBeCloseTo(-m.b / 1.5, 4);
        expect(m.d).toBeCloseTo(m.a / 1.5, 4);
      }
      // A skewed half turn keeps its (small) skew rather than flipping.
      const skewed = { a: -1, b: 0.02, c: 0.02, d: -1, tx: 0, ty: 0 };
      for (const t of [0.25, 0.5, 0.75]) {
        const m = interpolateDecomposed(turn(0), skewed, t);
        expect(m.a * m.d - m.b * m.c).toBeGreaterThan(0.99);
      }
    });

    it('spins the given way, with extra whole turns', () => {
      close(interpolateDecomposed(turn(0), turn(90), 0.5, { direction: 'cw', turns: 1 }), turn(225));
      close(interpolateDecomposed(turn(0), turn(90), 0.5, { direction: 'ccw', turns: 0 }), turn(-135));
      close(interpolateDecomposed(turn(0), turn(0, 2), 0.25, { direction: 'cw', turns: 1 }), turn(90, 1.25));
    });

    it('keeps a mirrored instance mirrored while it spins', () => {
      const mirror = (m: Matrix) => ({ ...m, a: -m.a, b: -m.b });
      close(interpolateDecomposed(mirror(turn(0)), mirror(turn(90)), 0.5, { direction: 'cw', turns: 1 }), mirror(turn(225)));
    });

    it('turns a key scaled to nothing from angle 0', () => {
      const zero = { a: 0, b: 0, c: 0, d: 0, tx: 0, ty: 0 };
      close(interpolateDecomposed(zero, turn(90, 2), 0.5), turn(45, 1));
    });

    it('interpolates entry by entry when the tween mirrors the instance', () => {
      const flipped = { a: -1, b: 0, c: 0, d: 1, tx: 10, ty: 0 };
      close(interpolateDecomposed(turn(0), flipped, 0.5), { a: 0, b: 0, c: 0, d: 1, tx: 5, ty: 0 });
    });

    it('matches plain interpolation for scale and position alone', () => {
      const from = { a: 1, b: 0, c: 0, d: 2, tx: 0, ty: 0 };
      const to = { a: 3, b: 0, c: 0, d: 0.5, tx: 40, ty: -20 };
      close(interpolateDecomposed(from, to, 0.25), { a: 1.5, b: 0, c: 0, d: 1.625, tx: 10, ty: -5 });
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
    expect(shape.exactEdges).toBe(true);
    const cmds = shape.edges[0].commands;
    expect(cmds[0]).toEqual({ type: 'M', x: 130, y: -10 });
    // Rounded corners are cubic arcs; the outline ends where it started, then closes.
    expect(cmds.filter((c) => c.type === 'C')).toHaveLength(4);
    expect(cmds[cmds.length - 2]).toMatchObject({ x: 130, y: -10 });
    expect(cmds[cmds.length - 1]).toEqual({ type: 'Z' });
  });

  it('closes every closed contour with Z, but not an open arc', () => {
    const base = { x: 0, y: 0, width: 100, height: 100, startAngle: 0, endAngle: 0, innerRadius: 0, closePath: true };
    const last = (cmds: PathCommand[]) => cmds[cmds.length - 1].type;
    expect(ovalPrimitivePath(base).contours.map(last)).toEqual(['Z']);
    expect(ovalPrimitivePath({ ...base, innerRadius: 50 }).contours.map(last)).toEqual(['Z', 'Z']);
    expect(ovalPrimitivePath({ ...base, endAngle: 90 }).contours.map(last)).toEqual(['Z']);
    expect(ovalPrimitivePath({ ...base, endAngle: 90, innerRadius: 50 }).contours.map(last)).toEqual(['Z']);
    expect(ovalPrimitivePath({ ...base, endAngle: 90, closePath: false }).contours.map(last)).toEqual(['C']);
  });

  it('joins a mitered stroke at the corner where the outline starts', async () => {
    const BLUE = '#0000FF';
    const canvas = await render(`<DOMRectangleObject objectWidth="100" objectHeight="100" x="200" y="200">
      <stroke><SolidStroke weight="20" joints="miter" caps="none"><fill><SolidColor color="${BLUE}"/></fill></SolidStroke></stroke>
    </DOMRectangleObject>`);
    // The outline starts at the top-left corner; all four outer corners are covered.
    for (const [x, y] of [[193, 193], [306, 193], [306, 306], [193, 306]]) {
      expect(colorAt(canvas, x, y), `corner ${x},${y}`).toBe(BLUE);
    }
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

  it('fills a ring thinner than the XFL edge-gap tolerance all the way round', async () => {
    // Outer radius 100, inner 94: a 6px ring. Stitched with the 8px XFL tolerance, the
    // hole joined the outer edge and a wedge of the ring went missing.
    const canvas = await render(`<DOMOvalObject objectWidth="200" objectHeight="200" x="100" y="100" innerRadius="94">${redFill}</DOMOvalObject>`);
    for (const deg of [-5, -15, -60, 90, 180, 270]) {
      const a = (deg * Math.PI) / 180;
      expect(colorAt(canvas, 200 + 97 * Math.cos(a), 200 + 97 * Math.sin(a)), `${deg} degrees`).toBe(RED);
    }
    expect(colorAt(canvas, 200, 200)).toBe(WHITE);
    expect(colorAt(canvas, 280, 200)).toBe(WHITE);
  });

  it('keeps a ring\'s hole in SVG exports (one path for both contours)', async () => {
    const doc = await parseXfl({ 'DOMDocument.xml': layerWith(`<DOMOvalObject objectWidth="200" objectHeight="100" x="100" y="100" innerRadius="50">${redFill}</DOMOvalObject>`) });
    expect(firstShape(doc).edges).toHaveLength(1);
    const svg = await (await exportSVG(doc, 0)).text();
    const paths = svg.match(/<path [^>]*fill="#FF0000"[^>]*>/g) ?? [];
    expect(paths).toHaveLength(1);
    expect(paths[0]?.match(/M/g)).toHaveLength(2);
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
  const motionLayer = (extraBasic = '', colors = '', filters = '', elementFilters = '') => `<DOMLayer name="Tween" animationType="motion object"><frames>
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
          <PropertyContainer id="Colors">${colors}</PropertyContainer><PropertyContainer id="Filters">${filters}</PropertyContainer>
        </PropertyContainer></AnimationCore></motionObjectXML>
      <elements><DOMSymbolInstance libraryItemName="Box" name="" centerPoint3DX="60" centerPoint3DY="110">
        <matrix><Matrix tx="50" ty="100"/></matrix><transformationPoint><Point x="10" y="10"/></transformationPoint>${elementFilters}
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

  // Filter curves as Animate saves them: one <PropertyContainer id="<Kind>_Filter">
  // per filter, constants as keyless <Property value>, colors as 0xRRGGBBAA.
  const curve = (id: string, keys: string) =>
    `<Property enabled="1" id="${id}" ignoreTimeMap="0" readonly="0" visible="1">${keys}</Property>`;
  const keyAt = (t: number, v: number) => `<Keyframe anchor="0,${v}" next="0,${v}" previous="0,${v}" roving="0" timevalue="${t}"/>`;
  const constant = (id: string, value: number) => `<Property enabled="1" id="${id}" readonly="0" value="${value}" visible="1"/>`;

  it('animates a blur filter over the span', async () => {
    const blur = `<PropertyContainer id="Blur_Filter">${curve('Blur_BlurX', keyAt(0, 10) + keyAt(10000, 0))}${curve('Blur_BlurY', keyAt(0, 10) + keyAt(10000, 0))}${constant('Blur_Quality', 3)}</PropertyContainer>`;
    const canvas = document.createElement('canvas');
    const renderer = new FLARenderer(canvas);
    await renderer.setDocument(await parseXfl(files(motionLayer('', '', blur, '<filters><BlurFilter blurX="10" blurY="10" quality="3"/></filters>'))));
    renderer.renderFrame(0);
    expect(colorAt(canvas, 73, 110)).not.toBe('#FFFFFF'); // blurred past the box edge
    renderer.renderFrame(10);
    expect(colorAt(canvas, 260, 110)).toBe('#FF0000');
    expect(colorAt(canvas, 273, 110)).toBe('#FFFFFF'); // sharp again
  });

  it('animates a drop shadow\'s color', async () => {
    const shadow = `<PropertyContainer id="DropShadow_Filter">${curve('DropShadow_BlurX', keyAt(0, 0))}${curve('DropShadow_BlurY', keyAt(0, 0))}${curve('DropShadow_Strength', keyAt(0, 100))}${constant('DropShadow_Quality', 1)}${curve('DropShadow_Angle', keyAt(0, 90))}${curve('DropShadow_Distance', keyAt(0, 30))}${constant('DropShadow_Knockout', 0)}${constant('DropShadow_InnerShadow', 0)}${constant('DropShadow_HideObject', 0)}${curve('DropShadow_Color', '<Keyframe roving="0" timevalue="0" value="0x000000ff"/><Keyframe roving="0" timevalue="10000" value="0x0000ffff"/>')}</PropertyContainer>`;
    const canvas = document.createElement('canvas');
    const renderer = new FLARenderer(canvas);
    await renderer.setDocument(await parseXfl(files(motionLayer('', '', shadow,
      '<filters><DropShadowFilter angle="90" blurX="0" blurY="0" distance="30" quality="1"/></filters>'))));
    // The shadow offset is in canvas pixels, 30 straight down.
    const below = 110 + 30 / (canvas.width / 550);
    renderer.renderFrame(0);
    expect(colorAt(canvas, 60, below)).toBe('#000000');
    renderer.renderFrame(10);
    expect(colorAt(canvas, 260, 110)).toBe('#FF0000');
    expect(colorAt(canvas, 260, below)).toBe('#0000FF');
  });

  // A static shadow on the tween's first frame: 30 (canvas) pixels at `angle`.
  const shadowAt = async (attrs: string, dx: number, dy: number) => {
    const canvas = document.createElement('canvas');
    const renderer = new FLARenderer(canvas);
    await renderer.setDocument(await parseXfl(files(motionLayer('', '', '',
      `<filters><DropShadowFilter blurX="0" blurY="0" distance="30" quality="1" ${attrs}/></filters>`))));
    renderer.renderFrame(0);
    const s = canvas.width / 550;
    return colorAt(canvas, 60 + dx / s, 110 + dy / s);
  };

  it('draws a filter\'s strength as opacity, not spread', async () => {
    const [r, g, b] = (await shadowAt('angle="90" strength="0.5"', 0, 30)).slice(1).match(/../g)!.map((v) => parseInt(v, 16));
    // Half-opaque black over white.
    expect(r).toBeGreaterThan(110);
    expect(r).toBeLessThan(145);
    expect(g).toBe(r);
    expect(b).toBe(r);
  });

  it('casts a shadow at angle 0 straight to the right', async () => {
    expect(await shadowAt('angle="0"', 30, 0)).toBe('#000000');
    expect(await shadowAt('angle="0"', 22, 22)).toBe('#FFFFFF');
  });

  it('does not draw a filter switched off in the Filters panel', async () => {
    expect(await shadowAt('angle="0" isEnabled="false"', 30, 0)).toBe('#FFFFFF');
  });

  it('pairs filter curves with a switched-off filter by position', async () => {
    // Two shadows, the second switched off. Its curves (blue, to the right)
    // stay on the switched-off shadow; the first set (black, down) is drawn.
    const shadowCurves = (angle: number, color: string) => `<PropertyContainer id="DropShadow_Filter">${curve('DropShadow_BlurX', keyAt(0, 0))}${curve('DropShadow_BlurY', keyAt(0, 0))}${curve('DropShadow_Angle', keyAt(0, angle))}${curve('DropShadow_Distance', keyAt(0, 30))}${curve('DropShadow_Color', `<Keyframe roving="0" timevalue="0" value="${color}"/>`)}</PropertyContainer>`;
    const canvas = document.createElement('canvas');
    const renderer = new FLARenderer(canvas);
    await renderer.setDocument(await parseXfl(files(motionLayer('', '', shadowCurves(90, '0x000000ff') + shadowCurves(0, '0x0000ffff'),
      '<filters><DropShadowFilter angle="90" blurX="0" blurY="0" distance="30"/><DropShadowFilter isEnabled="false" blurX="0" blurY="0" distance="30" angle="0" color="#0000FF"/></filters>'))));
    renderer.renderFrame(0);
    const s = canvas.width / 550;
    expect(colorAt(canvas, 60, 110 + 30 / s)).toBe('#000000');
    expect(colorAt(canvas, 60 + 30 / s, 110)).toBe('#FFFFFF');
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

describe('TLF text (DOMTLFText, Flash CS5-CS6)', () => {
  const tlf = (flow: string, attrs = 'right="5480" bottom="1389"', matrix = '<Matrix tx="-126" ty="-20"/>') => `
    <DOMTLFText name="" ${attrs}><matrix>${matrix}</matrix>
      <tlfFonts><TLFFont platformName="Times New Roman" psName="TimesNewRomanPSMT"/></tlfFonts>
      <markup><tlfTextObject type="Point" editPolicy="readSelect" columnCount="1" columnGap="20" verticalAlign="top" firstBaselineOffset="auto" paddingLeft="2" paddingTop="2" paddingRight="2" paddingBottom="2" background="false" multiline="true" antiAliasType="advanced" embedFonts="true">
        <TextFlow blockProgression="tb" lineBreak="explicit" locale="en_US" whiteSpaceCollapse="preserve" xmlns="http://ns.adobe.com/textLayout/2008">${flow}</TextFlow>
      </tlfTextObject></markup>
    </DOMTLFText>`;
  const parseText = async (xml: string) => {
    const doc = await parseXfl({ 'DOMDocument.xml': domDocument(`<DOMLayer name="L"><frames><DOMFrame index="0"><elements>${xml}</elements></DOMFrame></frames></DOMLayer>`) });
    return doc.timelines[0].layers[0].frames[0].elements[0] as TextInstance;
  };

  it('reads a CS5 TLF point text as static text', async () => {
    // As saved by Flash CS5.5 (a game's attack label).
    const text = await parseText(tlf(`<p direction="ltr" paragraphSpaceAfter="0" textAlign="start" textIndent="0"><span color="#000000" fontFamily="Times New Roman" fontSize="72" fontStyle="normal" fontWeight="normal" kerning="auto" lineHeight="120%" textAlpha="1" trackingRight="0%">Ice Spear</span></p>`));
    expect(text).toMatchObject({ type: 'text', textType: 'static', left: 2, width: 270 });
    expect(text.height).toBeCloseTo(1389 / 20 - 4, 9);
    // The box top (top="0" + paddingTop 2) is folded into the matrix.
    expect(text.matrix).toMatchObject({ tx: -126, ty: -18 });
    expect(text.textRuns).toHaveLength(1);
    expect(text.textRuns[0]).toMatchObject({
      characters: 'Ice Spear', size: 72, face: 'Times New Roman', fillColor: '#000000',
      alignment: 'left', bold: false, italic: false,
    });
    expect(text.textRuns[0].lineHeight).toBeCloseTo(86.4, 9);
  });

  it('inherits formats, separates paragraphs and maps alignment and styles', async () => {
    const text = await parseText(tlf(`
      <div fontSize="20" color="#FF0000">
        <p textAlign="center"><span fontWeight="bold">Hello </span><span fontStyle="italic" color="#0000FF" fontSize="inherit">world</span></p>
        <p textAlign="end"><span textDecoration="underline" lineHeight="30" trackingRight="10%">Line<br/>two</span></p>
      </div>`, 'left="200" top="100" right="2200" bottom="1100"', '<Matrix/>'));
    expect(text.left).toBe(12);
    expect(text.width).toBe(96);
    expect(text.matrix.ty).toBe(7);
    expect(text.textRuns.map((r) => r.characters)).toEqual(['Hello ', 'world\r', 'Line', '\n', 'two']);
    expect(text.textRuns[0]).toMatchObject({ size: 20, fillColor: '#FF0000', bold: true, alignment: 'center' });
    expect(text.textRuns[1]).toMatchObject({ size: 20, fillColor: '#0000FF', italic: true, alignment: 'center' });
    expect(text.textRuns[2]).toMatchObject({ alignment: 'right', underline: true, lineHeight: 30, letterSpacing: 2 });
    expect(text.textRuns[4]).toMatchObject({ alignment: 'right', underline: true, size: 20 });
  });

  it('applies textAlpha as the color alpha', async () => {
    const text = await parseText(tlf(`<p><span color="#FF0000" textAlpha="0.5">a</span><span color="#00FF00" textAlpha="1">b</span></p>`));
    expect(text.textRuns.map((r) => r.fillColor)).toEqual(['#FF000080', '#00FF00']);
  });

  it('keeps an empty first paragraph as a blank line in its span\'s format', async () => {
    const text = await parseText(tlf(`<p fontSize="40"><span></span></p><p><span fontSize="30"></span></p><p><span fontSize="10">Text</span></p>`));
    expect(text.textRuns.map((r) => r.characters)).toEqual(['\r', '\r', 'Text']);
    expect(text.textRuns.map((r) => r.size)).toEqual([40, 30, 10]);
  });

  it('writes textAlpha as fill-opacity in SVG exports', async () => {
    const doc = await parseXfl({ 'DOMDocument.xml': domDocument(`<DOMLayer name="L"><frames><DOMFrame index="0"><elements>
      ${tlf('<p><span color="#FF0000" textAlpha="0.5">Half</span></p>')}
    </elements></DOMFrame></frames></DOMLayer>`) });
    const svg = await (await exportSVG(doc, 0)).text();
    expect(svg).toContain('fill="#FF0000" fill-opacity="0.502"');
  });

  it('draws TLF text', async () => {
    const canvas = document.createElement('canvas');
    const renderer = new FLARenderer(canvas);
    const doc = await parseXfl({ 'DOMDocument.xml': domDocument(`<DOMLayer name="L"><frames><DOMFrame index="0"><elements>
      ${tlf('<p><span color="#FF0000" fontSize="72">MMMM</span></p>', 'right="6000" bottom="2000"', '<Matrix tx="50" ty="50"/>')}
    </elements></DOMFrame></frames></DOMLayer>`) });
    await renderer.setDocument(doc);
    renderer.renderFrame(0);
    expect(hasRed(canvas)).toBe(true);
  });
});

function hasRed(canvas: HTMLCanvasElement): boolean {
  const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] < 60) return true;
  }
  return false;
}

describe('movie clip instances (no symbolType attribute)', () => {
  const WHITE = '#FFFFFF';
  it.each([
    [null, 'movieclip'],
    ['movie clip', 'movieclip'],
    ['movieclip', 'movieclip'],
    ['graphic', 'graphic'],
    ['button', 'button'],
  ])('maps symbolType=%s to %s', (value, expected) => {
    expect(parseSymbolType(value)).toBe(expected);
  });

  const R = '#FF0000', G = '#00FF00', B = '#0000FF';

  /**
   * A 3-frame symbol (red, green, blue) as Animate saves a movie clip: no
   * symbolType on the item. `scripts[i]` is frame i's frame script.
   */
  function clipItem(scripts: Record<number, string> = {}): string {
    const frame = (i: number, color: string) => {
      const script = scripts[i] ? `<Actionscript><script><![CDATA[${scripts[i]}]]></script></Actionscript>` : '';
      return `<DOMFrame index="${i}">${script}<elements>${rectShape(0, 0, 20, 20, color)}</elements></DOMFrame>`;
    };
    return `<DOMSymbolItem xmlns="http://ns.adobe.com/xfl/2008/" name="Clip">
      <timeline><DOMTimeline name="Clip"><layers><DOMLayer name="Layer 1"><frames>
        ${frame(0, R)}${frame(1, G)}${frame(2, B)}
      </frames></DOMLayer></layers></DOMTimeline></timeline>
    </DOMSymbolItem>`;
  }

  /** Main timeline: `keyframes` one-frame keyframes, each placing the same Clip instance. */
  async function clipDoc(instanceAttrs = '', scripts: Record<number, string> = {}, keyframes = 1): Promise<FLADocument> {
    const frames = Array.from({ length: keyframes }, (_, i) => `<DOMFrame index="${i}"><elements>
      <DOMSymbolInstance libraryItemName="Clip" ${instanceAttrs}><matrix><Matrix tx="100" ty="100"/></matrix></DOMSymbolInstance>
    </elements></DOMFrame>`).join('');
    return parseXfl({
      'DOMDocument.xml': domDocument(`<DOMLayer name="L"><frames>${frames}</frames></DOMLayer>`, ['Clip']),
      'LIBRARY/Clip.xml': clipItem(scripts),
    });
  }

  /** Colors over `ticks` player ticks on main frame 0 (render, then advance like the player). */
  async function playOnFrame0(doc: FLADocument, ticks = 4): Promise<string[]> {
    const canvas = document.createElement('canvas');
    const renderer = new FLARenderer(canvas);
    await renderer.setDocument(doc);
    const colors: string[] = [];
    for (let i = 0; i < ticks; i++) {
      renderer.renderFrame(0);
      colors.push(colorAt(canvas, 110, 110));
      renderer.advanceMovieClipPlayheads();
    }
    return colors;
  }

  it('reads an instance and a library item without symbolType as movie clips', async () => {
    const doc = await clipDoc();
    const instance = doc.timelines[0].layers[0].frames[0].elements[0] as SymbolInstance;
    expect(instance.symbolType).toBe('movieclip');
    expect(doc.symbols.get('Clip')?.symbolType).toBe('movieclip');
  });

  it('plays a movie clip on a one-frame main timeline', async () => {
    expect(await playOnFrame0(await clipDoc())).toEqual([R, G, B, R]);
  });

  it('keeps a symbolType="graphic" instance in step with its one-frame parent', async () => {
    expect(await playOnFrame0(await clipDoc('symbolType="graphic"'))).toEqual([R, R, R, R]);
  });

  it('holds a movie clip on a frame whose script calls stop()', async () => {
    expect(await playOnFrame0(await clipDoc('', { 1: 'stop();' }))).toEqual([R, G, G, G]);
    expect(await playOnFrame0(await clipDoc('', { 0: 'this.stop();' }))).toEqual([R, R, R, R]);
  });

  it('keeps playing past scripts that stop something else', async () => {
    const scripts = { 1: '// stop();\nsnd.stop();\ngotoAndStop(2);' };
    expect(await playOnFrame0(await clipDoc('', scripts))).toEqual([R, G, B, R]);
  });

  /** A one-layer main timeline from keyframe XML (`clip(tx)` places the Clip instance). */
  const clip = (tx = 100) => `<DOMSymbolInstance libraryItemName="Clip"><matrix><Matrix tx="${tx}" ty="100"/></matrix></DOMSymbolInstance>`;
  const docWith = (layers: string, scripts: Record<number, string> = {}) => parseXfl({
    'DOMDocument.xml': domDocument(layers, ['Clip']),
    'LIBRARY/Clip.xml': clipItem(scripts),
  });

  /** Render frames in order like the player (advance between frames); color at x=110 per frame. */
  async function playFrames(doc: FLADocument, frames: number[], x = 110): Promise<string[]> {
    const canvas = document.createElement('canvas');
    const renderer = new FLARenderer(canvas);
    await renderer.setDocument(doc);
    return frames.map((f, i) => {
      if (i > 0) renderer.advanceMovieClipPlayheads();
      renderer.renderFrame(f);
      return colorAt(canvas, x, 110);
    });
  }

  it('keeps playing a movie clip on a one-frame timeline in the player', async () => {
    // Full-stage frames so the player's canvas size doesn't matter.
    const full = (color: string) => rectShape(0, 0, 550, 400, color);
    const doc = await parseXfl({
      'DOMDocument.xml': domDocument(`<DOMLayer name="L"><frames><DOMFrame index="0"><elements>
        <DOMSymbolInstance libraryItemName="Full"><matrix><Matrix/></matrix></DOMSymbolInstance>
      </elements></DOMFrame></frames></DOMLayer>`, ['Full']),
      'LIBRARY/Full.xml': `<DOMSymbolItem xmlns="http://ns.adobe.com/xfl/2008/" name="Full">
        <timeline><DOMTimeline name="Full"><layers><DOMLayer name="Layer 1"><frames>
          <DOMFrame index="0"><elements>${full(R)}</elements></DOMFrame>
          <DOMFrame index="1"><elements>${full(G)}</elements></DOMFrame>
          <DOMFrame index="2"><elements>${full(B)}</elements></DOMFrame>
        </frames></DOMLayer></layers></DOMTimeline></timeline>
      </DOMSymbolItem>`,
    });
    const canvas = document.createElement('canvas');
    canvas.width = 550;
    canvas.height = 400;
    document.body.appendChild(canvas);
    const player = new FLAPlayer(canvas);
    try {
      await player.setDocument(doc);
      const p = player as unknown as { state: { playing: boolean }; lastFrameTime: number; animate: () => void; animationId: number | null };
      const center = () => {
        const d = canvas.getContext('2d')!.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data;
        return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
      };
      const colors = [center()];
      p.state.playing = true;
      for (let i = 0; i < 3; i++) {
        p.lastFrameTime = performance.now() - 10_000;
        p.animate();
        if (p.animationId !== null) cancelAnimationFrame(p.animationId);
        p.animationId = null;
        colors.push(center());
      }
      expect(colors).toEqual([R, G, B, R]);
    } finally {
      player.stop();
      canvas.remove();
    }
  });

  it('starts a movie clip over when it is placed again after leaving the stage', async () => {
    const doc = await docWith(`<DOMLayer name="L"><frames>
      <DOMFrame index="0"><elements>${clip()}</elements></DOMFrame>
      <DOMFrame index="1"><elements></elements></DOMFrame>
      <DOMFrame index="2" duration="2"><elements>${clip()}</elements></DOMFrame>
    </frames></DOMLayer>`);
    expect(await playFrames(doc, [0, 1, 2, 3])).toEqual([R, WHITE, R, G]);
  });

  it('gives instances on different layers their own playheads', async () => {
    // Same clip, element 0 on two layers; the second appears one frame later.
    const doc = await docWith(`
      <DOMLayer name="A"><frames><DOMFrame index="0" duration="3"><elements>${clip(100)}</elements></DOMFrame></frames></DOMLayer>
      <DOMLayer name="B"><frames>
        <DOMFrame index="0"><elements></elements></DOMFrame>
        <DOMFrame index="1" duration="2"><elements>${clip(300)}</elements></DOMFrame>
      </frames></DOMLayer>`);
    expect(await playFrames(doc, [0, 1, 2], 110)).toEqual([R, G, B]);
    expect(await playFrames(doc, [0, 1, 2], 310)).toEqual([WHITE, R, G]);
  });

  it('starts a clip over when the timeline loops back over a gap', async () => {
    // On at 0-2, gone at 3-5, back at 6-9: after the loop, frame 0 is a new instance.
    const doc = await docWith(`<DOMLayer name="L"><frames>
      <DOMFrame index="0" duration="3"><elements>${clip()}</elements></DOMFrame>
      <DOMFrame index="3" duration="3"><elements></elements></DOMFrame>
      <DOMFrame index="6" duration="4"><elements>${clip()}</elements></DOMFrame>
    </frames></DOMLayer>`);
    const colors = await playFrames(doc, [6, 7, 8, 9, 0]);
    expect(colors).toEqual([R, G, B, R, R]);
  });

  // Main timeline: 10 frames holding Outer at (100,100). Outer's keyframes are
  // `outerFrames`, holding Inner (a 3-frame clip: red, green, blue). Outer is a
  // movie clip unless `outerAttrs` sets a symbolType.
  const innerItem = clipItem().replace(/name="Clip"/g, 'name="Inner"');
  const nested = (outerFrames: string, outerAttrs = '') => parseXfl({
    'DOMDocument.xml': domDocument(`<DOMLayer name="L"><frames><DOMFrame index="0" duration="10"><elements>
      <DOMSymbolInstance libraryItemName="Outer" ${outerAttrs}><matrix><Matrix tx="100" ty="100"/></matrix></DOMSymbolInstance>
    </elements></DOMFrame></frames></DOMLayer>`, ['Outer', 'Inner']),
    'LIBRARY/Inner.xml': innerItem,
    'LIBRARY/Outer.xml': `<DOMSymbolItem xmlns="http://ns.adobe.com/xfl/2008/" name="Outer">
      <timeline><DOMTimeline name="Outer"><layers><DOMLayer name="Layer 1"><frames>${outerFrames}</frames></DOMLayer></layers></DOMTimeline></timeline>
    </DOMSymbolItem>`,
  });
  const inner = '<DOMSymbolInstance libraryItemName="Inner"><matrix><Matrix/></matrix></DOMSymbolInstance>';
  const frames = [...Array(10).keys()];
  /** Each frame rendered by a fresh renderer, as after a seek. */
  const coldColors = async (doc: FLADocument) => {
    const colors: string[] = [];
    for (const f of frames) colors.push(...await playFrames(doc, [f]));
    return colors;
  };
  /** The color in single-frame PNG and SVG exports of `frame` (or which of R/G/B the SVG holds). */
  const exportedColors = async (doc: FLADocument, frame: number) => {
    const bitmap = await createImageBitmap(await exportSingleFrame(doc, frame));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const [r, g, b] = ctx.getImageData(110, 110, 1, 1).data;
    const hex = (v: number) => v.toString(16).padStart(2, '0').toUpperCase();
    const svg = await (await exportSVG(doc, frame)).text();
    return { png: `#${hex(r)}${hex(g)}${hex(b)}`, svg: [R, G, B].filter((c) => svg.includes(c)) };
  };

  describe('movie clips inside movie clips', () => {
    it('agrees between playback and seeking when the outer clip loops', async () => {
      const doc = await nested(`<DOMFrame index="0" duration="4"><elements>${inner}</elements></DOMFrame>`);
      const played = await playFrames(doc, frames);
      expect(played).toEqual([R, G, B, R, G, B, R, G, B, R]);
      expect(await coldColors(doc)).toEqual(played);
    });

    it('restarts the inner clip on each pass when it covers only part of the outer clip', async () => {
      const doc = await nested(`<DOMFrame index="0" duration="2"><elements>${inner}</elements></DOMFrame>
        <DOMFrame index="2" duration="2"><elements></elements></DOMFrame>`);
      const played = await playFrames(doc, frames);
      expect(played).toEqual([R, G, WHITE, WHITE, R, G, WHITE, WHITE, R, G]);
      expect(await coldColors(doc)).toEqual(played);
    });

    it('keeps the inner clip playing while the outer clip holds at stop()', async () => {
      const doc = await nested(`<DOMFrame index="0" duration="4"><Actionscript><script><![CDATA[stop();]]></script></Actionscript><elements>${inner}</elements></DOMFrame>`);
      const played = await playFrames(doc, frames);
      expect(played).toEqual([R, G, B, R, G, B, R, G, B, R]);
      expect(await coldColors(doc)).toEqual(played);
      const bitmap = await createImageBitmap(await exportSingleFrame(doc, 7));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      expect(Array.from(ctx.getImageData(110, 110, 1, 1).data.slice(0, 3))).toEqual([0, 255, 0]);
      const svg = await (await exportSVG(doc, 7)).text();
      expect(svg).toContain(G);
      expect(svg).not.toContain(R);
    });

    it('keeps the inner clip playing when the outer clip is cached as a bitmap', async () => {
      // A cached bitmap of Outer's frame 0 would freeze Inner on every pass.
      const outer = `<DOMFrame index="0" duration="4"><elements>${inner}</elements></DOMFrame>`;
      const plain = await playFrames(await nested(outer), frames);
      expect(await playFrames(await nested(outer, 'cacheAsBitmap="true"'), frames)).toEqual(plain);
      const oneFrame = `<DOMFrame index="0"><elements>${inner}</elements></DOMFrame>`;
      expect(await playFrames(await nested(oneFrame, 'symbolType="graphic" cacheAsBitmap="true"'), frames))
        .toEqual([R, G, B, R, G, B, R, G, B, R]);
    });

    it('finds a clip through a symbol cycle whichever symbol is asked first', async () => {
      // A holds B and Inner, B holds A. Asking about A first reaches B while A
      // is still being searched; B must not be remembered as clip-free.
      const graphicOf = (name: string) => `<DOMSymbolInstance libraryItemName="${name}" symbolType="graphic"><matrix><Matrix/></matrix></DOMSymbolInstance>`;
      const doc = await parseXfl({
        'DOMDocument.xml': domDocument(`<DOMLayer name="L"><frames><DOMFrame index="0"><elements>${graphicOf('A')}</elements></DOMFrame></frames></DOMLayer>`,
          ['A', 'B', 'Inner']),
        'LIBRARY/A.xml': symbolItem('A', graphicOf('B') + inner),
        'LIBRARY/B.xml': symbolItem('B', graphicOf('A')),
        'LIBRARY/Inner.xml': innerItem,
      });
      const renderer = new FLARenderer(document.createElement('canvas'));
      await renderer.setDocument(doc);
      const has = (name: string) => (renderer as any).hasMovieClipInside(doc.symbols.get(name));
      expect(has('A')).toBe(true);
      expect(has('B')).toBe(true);
    });

    it('searches each symbol once when a cycle keeps results from being remembered', async () => {
      // S0..S23 each hold S(i+1) twice and S24 holds S0: without a memo for the
      // search, every path is walked, 2^24 of them.
      const graphicOf = (name: string) => `<DOMSymbolInstance libraryItemName="${name}" symbolType="graphic"><matrix><Matrix/></matrix></DOMSymbolInstance>`;
      const names = Array.from({ length: 25 }, (_, i) => `S${i}`);
      const files: Record<string, string> = {
        'DOMDocument.xml': domDocument(`<DOMLayer name="L"><frames><DOMFrame index="0"><elements></elements></DOMFrame></frames></DOMLayer>`, names),
      };
      names.forEach((name, i) => {
        files[`LIBRARY/${name}.xml`] = symbolItem(name, i < 24 ? graphicOf(`S${i + 1}`) + graphicOf(`S${i + 1}`) : graphicOf('S0'));
      });
      const doc = await parseXfl(files);
      const renderer = new FLARenderer(document.createElement('canvas'));
      await renderer.setDocument(doc);
      const t0 = performance.now();
      expect((renderer as any).hasMovieClipInside(doc.symbols.get('S0'))).toBe(false);
      expect(performance.now() - t0).toBeLessThan(500);
    });
  });

  describe('movie clips inside graphic symbols and buttons', () => {
    const graphic = 'symbolType="graphic" loop="loop"';

    it('keeps a clip playing in a one-frame graphic when seeking and exporting', async () => {
      const doc = await nested(`<DOMFrame index="0"><elements>${inner}</elements></DOMFrame>`, graphic);
      const played = await playFrames(doc, frames);
      expect(played).toEqual([R, G, B, R, G, B, R, G, B, R]);
      expect(await coldColors(doc)).toEqual(played);
      expect(await exportedColors(doc, 7)).toEqual({ png: G, svg: [G] });
    });

    it('keeps the clip across a looping graphic\'s wrap when it covers the whole graphic', async () => {
      const doc = await nested(`<DOMFrame index="0" duration="4"><elements>${inner}</elements></DOMFrame>`, graphic);
      const played = await playFrames(doc, frames);
      expect(played).toEqual([R, G, B, R, G, B, R, G, B, R]);
      expect(await coldColors(doc)).toEqual(played);
      expect(await exportedColors(doc, 8)).toEqual({ png: B, svg: [B] });
    });

    it('restarts the clip on each pass when it covers only part of a looping graphic', async () => {
      const doc = await nested(`<DOMFrame index="0" duration="2"><elements>${inner}</elements></DOMFrame>
        <DOMFrame index="2" duration="2"><elements></elements></DOMFrame>`, graphic);
      const played = await playFrames(doc, frames);
      expect(played).toEqual([R, G, WHITE, WHITE, R, G, WHITE, WHITE, R, G]);
      expect(await coldColors(doc)).toEqual(played);
      expect(await exportedColors(doc, 5)).toEqual({ png: G, svg: [G] });
    });

    it('keeps a clip playing inside a button\'s up state', async () => {
      const doc = await nested(`<DOMFrame index="0"><elements>${inner}</elements></DOMFrame>`, 'symbolType="button"');
      const played = await playFrames(doc, frames);
      expect(played).toEqual([R, G, B, R, G, B, R, G, B, R]);
      expect(await coldColors(doc)).toEqual(played);
      expect(await exportedColors(doc, 4)).toEqual({ png: G, svg: [G] });
    });
  });

  describe('seeking and single-frame exports', () => {
    // Three back-to-back keyframes holding the same instance: one clip instance
    // that has been playing since frame 0.
    const threeKeys = (scripts: Record<number, string> = {}) => docWith(`<DOMLayer name="L"><frames>
      <DOMFrame index="0" duration="2"><elements>${clip()}</elements></DOMFrame>
      <DOMFrame index="2"><elements>${clip()}</elements></DOMFrame>
      <DOMFrame index="3" duration="2"><elements>${clip()}</elements></DOMFrame>
    </frames></DOMLayer>`, scripts);

    it('shows a movie clip where continuous playback would have it', async () => {
      const doc = await threeKeys();
      for (const [frame, color] of [[1, G], [2, B], [3, R], [4, G]] as const) {
        expect(await playFrames(doc, [frame]), `frame ${frame}`).toEqual([color]);
      }
    });

    it('holds at a stop() frame when seeking past it', async () => {
      expect(await playFrames(await threeKeys({ 1: 'stop();' }), [4])).toEqual([G]);
    });

    it('agrees with the sequence in PNG and SVG single-frame exports', async () => {
      const doc = await threeKeys();
      const bitmap = await createImageBitmap(await exportSingleFrame(doc, 2));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      expect(Array.from(ctx.getImageData(110, 110, 1, 1).data.slice(0, 3))).toEqual([0, 0, 255]);

      // SVG counts from the start of the run of keyframes too.
      for (const [frame, color] of [[2, B], [4, G]] as const) {
        const svg = await (await exportSVG(doc, frame)).text();
        expect(svg, `frame ${frame}`).toContain(color);
        expect([R, G, B].filter((c) => c !== color).some((c) => svg.includes(c)), `frame ${frame}`).toBe(false);
      }
    });
  });

  it('advances movie clips frame by frame in exports, across parent keyframes', async () => {
    // Three one-frame keyframes holding the same instance: a graphic would restart
    // at every keyframe (red, red, red); a movie clip keeps playing.
    const doc = await clipDoc('', {}, 3);
    const sheet = await exportSpriteSheet(doc, { includeJson: false });
    const bitmap = await createImageBitmap(sheet.image);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const colors = [0, 1, 2].map((i) => {
      const x = (i % sheet.columns) * sheet.frameWidth + 110;
      const y = Math.floor(i / sheet.columns) * sheet.frameHeight + 110;
      const d = ctx.getImageData(x, y, 1, 1).data;
      return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    });
    expect(colors).toEqual([R, G, B]);
  });
});
