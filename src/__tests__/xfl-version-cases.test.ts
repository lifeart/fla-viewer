import { describe, it, expect, beforeEach } from 'vitest';
import JSZip from 'jszip';
import { FLAParser, parseMotionTweenRotate } from '../fla-parser';
import { FLARenderer } from '../renderer';
import type { FLADocument, Shape } from '../types';

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
