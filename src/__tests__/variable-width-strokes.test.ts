import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { FLAParser } from '../fla-parser';
import { FLARenderer } from '../renderer';
import { exportSVG } from '../video-exporter';
import { variableWidthStrokePolygons, widthProfileAt } from '../variable-width-stroke';
import type { FLADocument, PathCommand, Shape, WidthMarker } from '../types';

// Variable-width strokes (Animate CC Width tool / width profiles). The XML mirrors what
// Animate writes (checked against real saved files on GitHub: F4CF/Creation-Framework's
// TestingMenu ResultIcons, sun-studios/Armed-with-Wings-Rearmed, brotochola/willian):
// <SolidStroke weight=".."><fill/><VariablePointWidth><WidthMarker position left right
// [type="corner"]/>…</VariablePointWidth></SolidStroke>.

const RED = '#FF0000';
const WHITE = '#FFFFFF';

async function parseXfl(elements: string): Promise<FLADocument> {
  const dom = `<?xml version="1.0" encoding="UTF-8"?>
<DOMDocument xmlns="http://ns.adobe.com/xfl/2008/" width="550" height="400" frameRate="24" backgroundColor="#FFFFFF">
  <timelines><DOMTimeline name="Scene 1"><layers><DOMLayer name="L"><frames>
    <DOMFrame index="0"><elements>${elements}</elements></DOMFrame>
  </frames></DOMLayer></layers></DOMTimeline></timelines>
</DOMDocument>`;
  const zip = new JSZip();
  zip.file('DOMDocument.xml', dom);
  return new FLAParser().parse(await zip.generateAsync({ type: 'uint8array' }));
}

const marker = (position: number, left: number, right = left, corner = false) =>
  `<WidthMarker position="${position}" left="${left}" right="${right}"${corner ? ' type="corner"' : ''}/>`;
const profile = (...markers: string[]) => `<VariablePointWidth>${markers.join('')}</VariablePointWidth>`;
// Animate's lens-shaped "Width Profile 1": zero at both ends, full weight in the middle.
const LENS = profile(marker(0, 0, 0, true), marker(0.5, 0.5), marker(1, 0, 0, true));

/** A shape with one red stroke style; `edges` in twips. */
function strokedShape(edges: string, widthProfile: string, attrs = 'weight="40"'): string {
  return `<DOMShape><strokes><StrokeStyle index="1"><SolidStroke scaleMode="normal" ${attrs}>
    <fill><SolidColor color="${RED}"/></fill>${widthProfile}</SolidStroke></StrokeStyle></strokes>
  <edges><Edge strokeStyle="1" edges="${edges}"/></edges></DOMShape>`;
}

async function render(elements: string): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  const renderer = new FLARenderer(canvas);
  await renderer.setDocument(await parseXfl(elements));
  renderer.renderFrame(0);
  return canvas;
}

const colorAt = (canvas: HTMLCanvasElement, x: number, y: number): string => {
  const s = canvas.width / 550;
  const d = canvas.getContext('2d')!.getImageData(Math.floor(x * s), Math.floor(y * s), 1, 1).data;
  return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
};

// A horizontal line from (100, 200) to (500, 200) px.
const LINE = '!2000 4000|10000 4000';

describe('variable-width stroke parsing', () => {
  it('reads the WidthMarker profile Animate writes on a SolidStroke', async () => {
    // A built-in profile as saved by Animate: tapered ends, flat in the middle.
    const doc = await parseXfl(`<DOMShape><strokes><StrokeStyle index="1">
      <SolidStroke scaleMode="normal" weight="3"><fill><SolidColor/></fill>
        <VariablePointWidth>
          <WidthMarker position="0" left="0" right="0" type="corner"/>
          <WidthMarker position="0.12" left="0.5" right="0.5"/>
          <WidthMarker position="0.14" left="0.5" right="0.5"/>
          <WidthMarker position="0.86" left="0.5" right="0.5"/>
          <WidthMarker position="0.88" left="0.5" right="0.5"/>
          <WidthMarker position="1" left="0" right="0" type="corner"/>
        </VariablePointWidth>
      </SolidStroke></StrokeStyle></strokes>
      <edges><Edge strokeStyle="1" edges="!170 378/301 497!301 497/471 120"/></edges></DOMShape>`);
    const stroke = (doc.timelines[0].layers[0].frames[0].elements[0] as Shape).strokes[0];
    expect(stroke).toMatchObject({ type: 'solid', color: '#000000', weight: 3 });
    expect(stroke.widthMarkers).toEqual([
      { position: 0, left: 0, right: 0, corner: true },
      { position: 0.12, left: 0.5, right: 0.5 },
      { position: 0.14, left: 0.5, right: 0.5 },
      { position: 0.86, left: 0.5, right: 0.5 },
      { position: 0.88, left: 0.5, right: 0.5 },
      { position: 1, left: 0, right: 0, corner: true },
    ]);
  });

  it('sorts the markers and leaves a constant-width stroke without a profile', async () => {
    const doc = await parseXfl(
      strokedShape(LINE, profile(marker(1, 0.25), marker(0, 0.5, 0.1), marker(0.4, 0.3))) +
      strokedShape(LINE, ''),
    );
    const [variable, constant] = doc.timelines[0].layers[0].frames[0].elements as Shape[];
    expect(variable.strokes[0].widthMarkers?.map((m) => m.position)).toEqual([0, 0.4, 1]);
    expect(variable.strokes[0].widthMarkers?.[0]).toEqual({ position: 0, left: 0.5, right: 0.1 });
    expect(constant.strokes[0].widthMarkers).toBeUndefined();
  });
});

describe('widthProfileAt', () => {
  const plateau: WidthMarker[] = [
    { position: 0, left: 0, right: 0, corner: true },
    { position: 0.12, left: 0.5, right: 0.5 },
    { position: 0.14, left: 0.5, right: 0.5 },
    { position: 0.86, left: 0.5, right: 0.5 },
    { position: 0.88, left: 0.5, right: 0.5 },
    { position: 1, left: 0, right: 0, corner: true },
  ];
  const lens: WidthMarker[] = [
    { position: 0, left: 0, right: 0, corner: true },
    { position: 0.5, left: 0.5, right: 0.5 },
    { position: 1, left: 0, right: 0, corner: true },
  ];

  it('passes through every marker and holds the end widths outside them', () => {
    for (const m of plateau) expect(widthProfileAt(plateau, m.position)).toEqual({ left: m.left, right: m.right });
    const short: WidthMarker[] = [{ position: 0.2, left: 0.3, right: 0.1 }, { position: 0.6, left: 0.5, right: 0.5 }];
    expect(widthProfileAt(short, 0)).toEqual({ left: 0.3, right: 0.1 });
    expect(widthProfileAt(short, 1)).toEqual({ left: 0.5, right: 0.5 });
  });

  it('keeps the span between equal markers flat', () => {
    for (const s of [0.2, 0.35, 0.5, 0.65, 0.8]) expect(widthProfileAt(plateau, s).left).toBeCloseTo(0.5, 9);
  });

  it('curves between markers and keeps a symmetric profile symmetric', () => {
    const quarter = widthProfileAt(lens, 0.25).left;
    expect(quarter).toBeGreaterThan(0.25); // a straight ramp would give 0.25
    expect(quarter).toBeLessThan(0.5);
    expect(widthProfileAt(lens, 0.75).left).toBeCloseTo(quarter, 9);
  });

  it('treats sides independently', () => {
    const asym: WidthMarker[] = [{ position: 0, left: 0.5, right: 0 }, { position: 1, left: 0.1, right: 0.3 }];
    const mid = widthProfileAt(asym, 0.5);
    expect(mid.left).toBeCloseTo(0.3, 9);
    expect(mid.right).toBeCloseTo(0.15, 9);
  });

  it('is uniform without markers', () => {
    expect(widthProfileAt([], 0.3)).toEqual({ left: 0.5, right: 0.5 });
  });
});

describe('variable-width stroke outlines', () => {
  const style = { weight: 40, caps: 'round' as const, joints: 'round' as const, widthMarkers: [
    { position: 0, left: 0.5, right: 0.5 }, { position: 1, left: 0.5, right: 0.5 },
  ] };
  const line = (x0: number, y0: number, x1: number, y1: number): PathCommand[] =>
    [{ type: 'M', x: x0, y: y0 }, { type: 'L', x: x1, y: y1 }];

  it('makes one outline per open path and an outside plus an inside per closed path', () => {
    expect(variableWidthStrokePolygons(line(0, 0, 100, 0), style)).toHaveLength(1);
    // Two separate paths in one edge.
    expect(variableWidthStrokePolygons([...line(0, 0, 100, 0), ...line(0, 50, 100, 50)], style)).toHaveLength(2);
    // Records that join end to start are one path.
    expect(variableWidthStrokePolygons([...line(0, 0, 100, 0), ...line(100, 0, 100, 100)], style)).toHaveLength(1);
    const square: PathCommand[] = [
      { type: 'M', x: 0, y: 0 }, { type: 'L', x: 100, y: 0 }, { type: 'L', x: 100, y: 100 },
      { type: 'L', x: 0, y: 100 }, { type: 'L', x: 0, y: 0 },
    ];
    expect(variableWidthStrokePolygons(square, style)).toHaveLength(2);
  });

  it('draws a zero-length path as a dot and a dab shorter than the join tolerance as an open path', () => {
    const reach = (poly: number[], x: number, y: number) => {
      let r = 0;
      for (let i = 0; i < poly.length; i += 2) r = Math.max(r, Math.hypot(poly[i] - x, poly[i + 1] - y));
      return r;
    };
    const [dot, ...more] = variableWidthStrokePolygons(line(5, 5, 5, 5), style);
    expect(more).toEqual([]);
    expect(reach(dot, 5, 5)).toBeCloseTo(20, 9);
    expect(dot.length).toBeGreaterThan(16);
    expect(variableWidthStrokePolygons(line(5, 5, 5, 5), { ...style, caps: 'none' })).toEqual([]);
    // Ends 0.3px apart: one capped outline, not a loop with no length.
    const dab = variableWidthStrokePolygons(line(5, 5, 5.3, 5), style);
    expect(dab).toHaveLength(1);
    expect(reach(dab[0], 5.15, 5)).toBeCloseTo(20.15, 6);
    // The same when the dab is closed explicitly.
    const closedDab: PathCommand[] = [
      { type: 'M', x: 5, y: 5 }, { type: 'L', x: 5.6, y: 5 }, { type: 'L', x: 5.05, y: 5.3 }, { type: 'Z' },
    ];
    expect(variableWidthStrokePolygons(closedDab, style)).toHaveLength(1);
  });

  it('keeps every coordinate finite', () => {
    const curvy: PathCommand[] = [
      { type: 'M', x: 0, y: 0 }, { type: 'Q', cx: 50, cy: -80, x: 100, y: 0 },
      { type: 'C', c1x: 120, c1y: 40, c2x: 80, c2y: 60, x: 100, y: 0 }, { type: 'L', x: 0, y: 0 },
    ];
    for (const poly of variableWidthStrokePolygons(curvy, { ...style, widthMarkers: [
      { position: 0, left: 0, right: 0, corner: true }, { position: 0.5, left: 2, right: 0.1 }, { position: 1, left: 0, right: 0, corner: true },
    ] })) {
      expect(poly.length).toBeGreaterThanOrEqual(6);
      expect(poly.every(Number.isFinite)).toBe(true);
    }
  });
});

describe('rendering variable-width strokes', () => {
  it('tapers a lens profile to points at both ends of a line', async () => {
    const canvas = await render(strokedShape(LINE, LENS));
    expect(colorAt(canvas, 300, 200)).toBe(RED);
    expect(colorAt(canvas, 300, 212)).toBe(RED); // full weight (40) in the middle
    expect(colorAt(canvas, 300, 188)).toBe(RED);
    expect(colorAt(canvas, 150, 200)).toBe(RED); // narrower towards the ends
    expect(colorAt(canvas, 150, 212)).toBe(WHITE);
    expect(colorAt(canvas, 110, 212)).toBe(WHITE);
    expect(colorAt(canvas, 490, 188)).toBe(WHITE);
  });

  it('spreads the profile over records that join end to start', async () => {
    // Two records meeting at x=300: one path, so x=300 is its middle (full width).
    const canvas = await render(strokedShape('!2000 4000|6000 4000!6000 4000|10000 4000', LENS));
    expect(colorAt(canvas, 300, 212)).toBe(RED);
    expect(colorAt(canvas, 290, 212)).toBe(RED);
    expect(colorAt(canvas, 110, 212)).toBe(WHITE);
  });

  it('gives each separate path in an edge its own profile', async () => {
    // 100..300 and, after a jump, 400..500 (y=300).
    const canvas = await render(strokedShape('!2000 6000|6000 6000!8000 6000|10000 6000', LENS));
    expect(colorAt(canvas, 200, 312)).toBe(RED);
    expect(colorAt(canvas, 293, 312)).toBe(WHITE);
    expect(colorAt(canvas, 450, 312)).toBe(RED);
    expect(colorAt(canvas, 407, 312)).toBe(WHITE);
  });

  it('starts a closed path\'s profile at its first record', async () => {
    // Square 100..300 drawn clockwise from the top-left corner; thick at the start and
    // end, thin halfway round (the bottom-right corner).
    const square = '!2000 2000|6000 2000!6000 2000|6000 6000!6000 6000|2000 6000!2000 6000|2000 2000';
    const canvas = await render(strokedShape(square, profile(marker(0, 0.5), marker(0.5, 0.05), marker(1, 0.5))));
    expect(colorAt(canvas, 115, 88)).toBe(RED); // just after the start
    expect(colorAt(canvas, 88, 115)).toBe(RED); // just before the end
    expect(colorAt(canvas, 300, 285)).toBe(RED); // centre line near the bottom-right
    expect(colorAt(canvas, 312, 285)).toBe(WHITE); // but only a sliver wide there
    expect(colorAt(canvas, 285, 312)).toBe(WHITE);
    expect(colorAt(canvas, 200, 200)).toBe(WHITE); // the inside stays empty
  });

  it('puts the left half-width on the left of the path direction and the right on the right', async () => {
    const oneSided = profile(marker(0, 0.5, 0), marker(1, 0.5, 0));
    const rightward = await render(strokedShape(LINE, oneSided));
    expect(colorAt(rightward, 300, 188)).toBe(RED);
    expect(colorAt(rightward, 300, 212)).toBe(WHITE);
    const leftward = await render(strokedShape('!10000 4000|2000 4000', oneSided));
    expect(colorAt(leftward, 300, 188)).toBe(WHITE);
    expect(colorAt(leftward, 300, 212)).toBe(RED);
  });

  it('draws a click of the brush (a zero-length stroke) as a dot, like a constant-width stroke', async () => {
    const flat = profile(marker(0, 0.5), marker(1, 0.5));
    const canvas = await render(strokedShape('!6000 4000|6000 4000', flat));
    expect(colorAt(canvas, 300, 200)).toBe(RED);
    expect(colorAt(canvas, 314, 200)).toBe(RED);
    expect(colorAt(canvas, 300, 186)).toBe(RED);
    expect(colorAt(canvas, 326, 200)).toBe(WHITE);
    expect(colorAt(canvas, 316, 216)).toBe(WHITE);
  });

  it('caps a short dab the edge decoder closes instead of joining it as a loop', async () => {
    // Ends 0.05px from its start, so the edge decoder closes it.
    const flat = profile(marker(0, 0.5), marker(1, 0.5));
    const doc = await parseXfl(strokedShape('!6000 4000|6012 4000|6001 4006', flat));
    const shape = doc.timelines[0].layers[0].frames[0].elements[0] as Shape;
    const commands = shape.edges[0].commands;
    expect(commands[commands.length - 1].type).toBe('Z');
    expect(variableWidthStrokePolygons(commands, shape.strokes[0])).toHaveLength(1);
  });

  it('caps an open end at the end width', async () => {
    // Constant half the weight: 20px wide, so a round cap has a 10px radius.
    const half = profile(marker(0, 0.25), marker(1, 0.25));
    const round = await render(strokedShape(LINE, half));
    expect(colorAt(round, 505, 200)).toBe(RED);
    expect(colorAt(round, 515, 200)).toBe(WHITE);
    expect(colorAt(round, 508, 208)).toBe(WHITE);
    const square = await render(strokedShape(LINE, half, 'weight="40" caps="square"'));
    expect(colorAt(square, 508, 207)).toBe(RED);
    expect(colorAt(square, 515, 200)).toBe(WHITE);
    const none = await render(strokedShape(LINE, half, 'weight="40" caps="none"'));
    expect(colorAt(none, 505, 200)).toBe(WHITE);
    expect(colorAt(none, 495, 207)).toBe(RED);
  });

  it('keeps drawing constant-width strokes of the same shape as before', async () => {
    const canvas = await render(`<DOMShape><strokes>
        <StrokeStyle index="1"><SolidStroke weight="40"><fill><SolidColor color="${RED}"/></fill>${LENS}</SolidStroke></StrokeStyle>
        <StrokeStyle index="2"><SolidStroke weight="40" caps="none"><fill><SolidColor color="#0000FF"/></fill></SolidStroke></StrokeStyle>
      </strokes><edges>
        <Edge strokeStyle="1" edges="${LINE}"/>
        <Edge strokeStyle="2" edges="!2000 6000|10000 6000"/>
      </edges></DOMShape>`);
    expect(colorAt(canvas, 110, 212)).toBe(WHITE);
    expect(colorAt(canvas, 110, 312)).toBe('#0000FF');
    expect(colorAt(canvas, 300, 312)).toBe('#0000FF');
  });
});

describe('SVG export of variable-width strokes', () => {
  async function svgCanvas(doc: FLADocument): Promise<{ svg: string; canvas: HTMLCanvasElement }> {
    const blob = await exportSVG(doc, 0);
    const svg = await blob.text();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const img = new Image();
    img.src = url;
    await img.decode();
    URL.revokeObjectURL(url);
    const canvas = document.createElement('canvas');
    canvas.width = 550;
    canvas.height = 400;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = WHITE;
    ctx.fillRect(0, 0, 550, 400);
    ctx.drawImage(img, 0, 0);
    return { svg, canvas };
  }

  it('writes the outline as a filled path instead of a constant stroke-width', async () => {
    const { svg, canvas } = await svgCanvas(await parseXfl(strokedShape(LINE, LENS)));
    expect(svg).not.toMatch(/stroke="#FF0000"/);
    expect(svg).toMatch(/<path d="M[^"]+Z" fill="#FF0000"\/>/);
    expect(colorAt(canvas, 300, 212)).toBe(RED);
    expect(colorAt(canvas, 110, 200)).toBe(RED);
    expect(colorAt(canvas, 110, 212)).toBe(WHITE);
  });

  it('keeps the fill of an edge that also carries a variable stroke', async () => {
    const doc = await parseXfl(`<DOMShape>
      <fills><FillStyle index="1"><SolidColor color="#00FF00"/></FillStyle></fills>
      <strokes><StrokeStyle index="1"><SolidStroke weight="10"><fill><SolidColor color="${RED}"/></fill>${LENS}</SolidStroke></StrokeStyle></strokes>
      <edges><Edge fillStyle1="1" strokeStyle="1" edges="!2000 2000|8000 2000|8000 8000|2000 8000|2000 2000"/></edges></DOMShape>`);
    const { svg, canvas } = await svgCanvas(doc);
    expect(svg).toMatch(/fill="#00FF00"/);
    expect(colorAt(canvas, 250, 250)).toBe('#00FF00');
  });
});
