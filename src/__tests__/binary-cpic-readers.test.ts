import { describe, expect, it } from 'vitest';
import { CArchiveReader, type CArchiveObjectHeader } from '../binary-carchive';
import { readCPicObjBase, readCPicObjLeafBase } from '../binary-cpic-object';
import {
  findCPicFrameTailProbeInRange,
  readCPicFrameTailProbeAt,
} from '../binary-cpic-frame-tail';
import { readCPicPlacement } from '../binary-cpic-placement';
import { readCPicText } from '../binary-cpic-text';
import { parseSwfFilterStack } from '../binary-swf-filters';

const u8 = (...v: number[]): number[] => v.map((n) => n & 0xff);
const u16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
const u32 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
const s32 = (v: number): number[] => u32(v < 0 ? v + 0x100000000 : v);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const utf16 = (s: string): number[] => [...s].flatMap((c) => u16(c.charCodeAt(0)));
const flashStr = (s: string): number[] => [0xff, 0xfe, 0xff, s.length, ...utf16(s)];
const decl = (name: string) => [0xff, 0xff, ...u16(1), ...u16(name.length), ...ascii(name)];
const fixed = (v: number) => s32(Math.round(v * 65536));

const NULL_TAG = [0, 0];
const INT_MIN = s32(-0x80000000);

const readerAt = (bytes: number[], pos = 0) => new CArchiveReader(Uint8Array.from(bytes), pos);
const header = (className: string, bodyStart = 0): CArchiveObjectHeader => ({
  tagStart: Math.max(0, bodyStart - 2),
  bodyStart,
  className,
  referenceKind: 'class_backref',
});

describe('readCPicObjBase', () => {
  it('reads the point and the extras each schema adds', () => {
    const body = (schema: number, extras: number[]) => [...u8(schema, 0), ...NULL_TAG, ...s32(-20), ...s32(40), ...extras, 0xee];
    for (const [schema, extras] of [[1, []], [3, [7]], [4, [7, 8]], [6, [7, 8, 9]]] as const) {
      const r = readerAt(body(schema, [...extras]));
      const base = readCPicObjLeafBase(r);
      expect(base).toMatchObject({ schema, flags: 0, registrationPoint: { x: -20, y: 40 } });
      expect([base.extra1, base.extra2, base.extra3].filter((v) => v !== undefined)).toEqual(extras);
      expect(r.data[r.pos]).toBe(0xee);
    }
    // Schema 0 has no point.
    const r = readerAt([0, 0, ...NULL_TAG, 0xee]);
    expect(readCPicObjLeafBase(r).registrationPoint).toBeUndefined();
    expect(r.pos).toBe(4);
  });

  it('hands each child to the reader and records where it ends', () => {
    const r = readerAt([...u8(1, 0), ...decl('CPicShape'), 0xaa, 0xbb, ...NULL_TAG, ...INT_MIN, ...INT_MIN]);
    const base = readCPicObjBase(r, (h, reader) => {
      expect(h.className).toBe('CPicShape');
      return reader.readU16();
    });
    expect(base.children).toHaveLength(1);
    expect(base.children[0]).toMatchObject({ value: 0xbbaa, bodyEnd: 2 + 15 + 2 });
    expect(base.bodyEnd).toBe(r.data.length);
  });

  it('stops before a listed sibling class without consuming its tag', () => {
    const bytes = [...u8(1, 0), ...decl('CPicLayer'), 0x11];
    const r = readerAt(bytes);
    const base = readCPicObjBase(r, () => 0, { stopBeforeChildClasses: ['CPicLayer'] });
    expect(base.children).toHaveLength(0);
    expect(r.pos).toBe(2);
  });

  it('a leaf base refuses children', () => {
    expect(() => readCPicObjLeafBase(readerAt([...u8(1, 0), ...decl('CPicShape')]))).toThrow(/expected leaf/);
  });
});

/** A schema-29 frame tail with an empty label and a format-0 timeline. */
function frameTail(opts: { schema?: number; duration?: number; keyMode?: number; entries?: number; format?: number } = {}): number[] {
  return [
    ...u8(opts.schema ?? 29), ...u16(opts.duration ?? 3), ...u16(opts.keyMode ?? 0x2200),
    ...u16(0), ...u16(0), ...u16(opts.entries ?? 0),
    ...u16(0), ...u8(0), ...u32(0), ...u32(0), ...u16(0),
    ...flashStr(''),
    ...u32(0), ...u32(opts.format ?? 0),
    ...new Array(16).fill(0),
  ];
}

describe('readCPicFrameTailProbeAt', () => {
  it('accepts a plausible modern frame tail', () => {
    const data = Uint8Array.from([0xaa, ...frameTail({ duration: 12, keyMode: 0x4601 })]);
    expect(readCPicFrameTailProbeAt(data, 1)).toEqual({ pos: 1, frameSchema: 29, duration: 12, keyMode: 0x4601 });
    expect(findCPicFrameTailProbeInRange(data, 0, data.length)?.pos).toBe(1);
  });

  it('rejects tails that do not fit the layout', () => {
    const probe = (bytes: number[]) => readCPicFrameTailProbeAt(Uint8Array.from(bytes), 0);
    expect(probe(frameTail({ schema: 18 }))).toBeNull(); // pre-19 frames have no probe
    expect(probe(frameTail({ duration: 0 }))).toBeNull();
    expect(probe(frameTail({ keyMode: 0x1234 }))).toBeNull(); // unknown key mode
    expect(probe(frameTail({ entries: 1 }))).toBeNull(); // entry table not decoded
    expect(probe(frameTail({ format: 7 }))).toBeNull();
    expect(probe(frameTail().slice(0, 20))).toBeNull();
  });
});

/** A legacy (symbol schema < 22) CPicSprite body. */
function spriteBody(opts: { a?: number; d?: number; name?: string; mediaRef?: number; colorTransform?: boolean; filters?: number[] } = {}): number[] {
  const name = opts.name ?? 'btn';
  return [
    ...u8(5, 0), ...NULL_TAG, ...INT_MIN, ...INT_MIN, ...u8(0, 0), // CPicObj leaf base
    ...u8(8), // symbol schema
    ...fixed(opts.a ?? 2), ...fixed(0), ...fixed(0), ...fixed(opts.d ?? 0.5), ...s32(30 * 20), ...s32(-10 * 20),
    ...u16(0), ...u16(0), ...u8(0), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
    name.length, ...ascii(name), ...u32(opts.mediaRef ?? 12),
    ...(opts.colorTransform ? [1, ...u16(128), 255, ...u16(0), 0, ...u16(0), 255, ...u16(10), ...u16(0)] : [0]),
    ...(opts.filters ?? []),
  ];
}

describe('readCPicPlacement', () => {
  it('reads the matrix, instance name and library reference', () => {
    const bytes = [...spriteBody(), 0x00, 0x00];
    const r = readerAt(bytes);
    const p = readCPicPlacement(r, header('CPicSprite'));
    expect(p).toMatchObject({
      className: 'CPicSprite',
      instanceName: 'btn',
      mediaRef: 12,
      matrix: { a: 2, b: 0, c: 0, d: 0.5, tx: 30, ty: -10 },
      bodyStart: 0,
      bodyEnd: bytes.length - 2,
    });
    expect(p?.colorTransform).toBeUndefined();
    expect(r.pos).toBe(bytes.length - 2);
  });

  it('reads a color transform and a filter stack after the reference', () => {
    const blur = [1, 1, ...fixed(4), ...fixed(6), 1 << 3];
    const bytes = spriteBody({ colorTransform: true, filters: blur });
    const p = readCPicPlacement(readerAt(bytes), header('CPicSprite'))!;
    expect(p.colorTransform).toMatchObject({ alphaMultiplier: 0.5, redMultiplier: 1, blueMultiplier: 1, blueOffset: 10 });
    expect(p.filters).toEqual([{ type: 'blur', blurX: 4, blurY: 6, quality: 1 }]);
    expect(p.bodyEnd).toBe(bytes.length);
  });

  it('returns null for a degenerate matrix or a missing reference', () => {
    expect(readCPicPlacement(readerAt(spriteBody({ a: 0, d: 0 })), header('CPicSprite'))).toBeNull();
    expect(readCPicPlacement(readerAt(spriteBody({ a: 100 })), header('CPicSprite'))).toBeNull();
    expect(readCPicPlacement(readerAt(spriteBody({ mediaRef: 0 })), header('CPicSprite'))).toBeNull();
  });
});

describe('parseSwfFilterStack', () => {
  it('decodes drop shadow, blur and glow filters', () => {
    // Flags: inner shadow, composite source, 18 passes.
    const shadow = [0, 0x11, 0x22, 0x33, 255, ...fixed(5), ...fixed(5), ...fixed(Math.PI / 4), ...fixed(8), ...u16(512), 0x80 | 0x20 | 18];
    const blur = [1, ...fixed(3), ...fixed(3), 3 << 3];
    const glow = [2, 0xff, 0, 0, 128, ...fixed(10), ...fixed(10), ...u16(256), 0];
    const data = Uint8Array.from([3, ...shadow, ...blur, ...glow, 0xee]);
    const result = parseSwfFilterStack(data, 0)!;
    expect(result.end).toBe(data.length - 1);
    expect(result.filters.map((f) => f.type)).toEqual(['dropShadow', 'blur', 'glow']);
    expect(result.filters[0]).toMatchObject({ color: '#112233', distance: 8, strength: 2, inner: true, hideObject: false, quality: 18 });
    expect(result.filters[0].type === 'dropShadow' && result.filters[0].angle).toBeCloseTo(45, 3);
    expect(result.filters[1]).toMatchObject({ quality: 3 }); // blur keeps passes in the top 5 bits
    expect(result.filters[2]).toMatchObject({ color: '#FF0000', strength: 1, quality: 1 });
  });

  it('returns null for an empty, unknown, implausible or truncated stack', () => {
    const parse = (bytes: number[]) => parseSwfFilterStack(Uint8Array.from(bytes), 0);
    expect(parse([0])).toBeNull();
    expect(parse([1, 9])).toBeNull();
    expect(parse([1, 1, ...fixed(1000), ...fixed(1), 0])).toBeNull();
    expect(parse([1, 1, ...fixed(3)])).toBeNull();
  });
});

describe('readCPicText', () => {
  it('finds the font, colour, characters and instance name', () => {
    const body = [
      ...u8(5, 0), ...NULL_TAG, ...INT_MIN, ...INT_MIN, ...u8(0, 0), // CPicObj leaf base
      ...u8(4), // text schema
    ];
    body.push(...new Array(55 - body.length).fill(0));
    body.push(...flashStr('_sans'));
    body.push(...u8(0, 0, 0, 0, 0x33, 0x22, 0x11, 0xff)); // colour: B, G, R, A
    body.push(0xff, 0xfe, 0xff, 0x00, ...utf16('Hello'), 0, 0);
    body.push(...flashStr('titleText'));
    body.push(...new Array(8).fill(0));
    const r = readerAt(body);
    const text = readCPicText(r, header('CPicText'))!;
    expect(text).toMatchObject({
      characters: 'Hello',
      fontFace: '_sans',
      fillColor: '#112233',
      instanceName: 'titleText',
    });
    expect(text.bodyEnd).toBe(body.length - 8);
  });

  it('returns null when it finds neither text nor an instance name', () => {
    const body = [...u8(5, 0), ...NULL_TAG, ...INT_MIN, ...INT_MIN, ...u8(0, 0), ...u8(4), ...new Array(80).fill(0)];
    expect(readCPicText(readerAt(body), header('CPicText'))).toBeNull();
  });
});
