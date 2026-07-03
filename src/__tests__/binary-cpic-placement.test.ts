import { describe, expect, it } from 'vitest';
import { CArchiveReader, type CArchiveObjectHeader } from '../binary-carchive';
import { readCPicPlacement } from '../binary-cpic-placement';

const FIXED_1 = 0x00010000;
const IDENTITY: [number, number, number, number, number, number] = [
  FIXED_1,
  0,
  0,
  FIXED_1,
  0,
  0,
];

function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function s32le(value: number): number[] {
  const n = value < 0 ? value + 0x100000000 : value;
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}

function placementBody(opts: {
  matrix: [number, number, number, number, number, number];
  mediaRef: number;
  name?: string;
  cpicObjSchema?: number;
  symbolSchema?: number;
}): number[] {
  const out: number[] = [];
  out.push(opts.cpicObjSchema ?? 2, 0);
  out.push(...u16le(0));
  out.push(...s32le(6000), ...s32le(3000));
  if ((opts.cpicObjSchema ?? 2) >= 3) out.push(0);
  if ((opts.cpicObjSchema ?? 2) >= 4) out.push(0);
  if ((opts.cpicObjSchema ?? 2) >= 6) out.push(0);
  out.push(opts.symbolSchema ?? 21);
  for (const m of opts.matrix) out.push(...s32le(m));
  out.push(...u16le(0));
  out.push(...u16le(2));
  out.push(1);
  out.push(...u16le(256), ...u16le(0), ...u16le(256), ...u16le(0));
  const name = opts.name ?? '';
  out.push(name.length, ...[...name].map((c) => c.charCodeAt(0)));
  out.push(...s32le(opts.mediaRef));
  return out;
}

function schema22TransformTail(targetRef: number, marker: 'short' | 'extended' = 'short'): number[] {
  const out = new Array<number>(128).fill(0);
  out[0] = 1;
  if (marker === 'short') {
    out[10] = 0xff;
    out[11] = 0xff;
    out[12] = 0xfe;
    out[13] = 0xff;
    out[14] = 0x00;
  } else {
    out[7] = 0xff;
    out[8] = 0xff;
    out[9] = 0xff;
    out[10] = 0xff;
    out[11] = 0xff;
    out[12] = 0xfe;
    out[13] = 0xff;
    out[14] = 0x00;
  }
  out[15] = targetRef & 0xff;
  out[16] = (targetRef >> 8) & 0xff;
  out[17] = (targetRef >> 16) & 0xff;
  out[18] = (targetRef >>> 24) & 0xff;
  for (const rel of [26, 46, 66, 86]) {
    out[rel + 2] = 0x80;
    out[rel + 3] = 0x3f;
  }
  return out;
}

function header(className: string): CArchiveObjectHeader {
  return {
    tagStart: 0,
    bodyStart: 0,
    className,
    referenceKind: 'new_class',
  };
}

describe('binary-cpic-placement: SWF filter tails', () => {
  it('uses schema>=22 transform-tail targetRef as the primary mediaRef', () => {
    const body = Uint8Array.from([
      ...placementBody({ matrix: IDENTITY, mediaRef: 1, symbolSchema: 22 }),
      ...schema22TransformTail(8),
    ]);

    const placement = readCPicPlacement(new CArchiveReader(body), header('CPicSprite'));

    expect(placement?.mediaRef).toBe(8);
    expect(placement?.altMediaRef).toBe(8);
    expect(placement?.bodyEnd).toBe(body.length);
  });

  it('uses schema>=22 extended transform-tail targetRef as the primary mediaRef', () => {
    const body = Uint8Array.from([
      ...placementBody({ matrix: IDENTITY, mediaRef: 1, symbolSchema: 22 }),
      ...schema22TransformTail(52, 'extended'),
    ]);

    const placement = readCPicPlacement(new CArchiveReader(body), header('CPicSprite'));

    expect(placement?.mediaRef).toBe(52);
    expect(placement?.altMediaRef).toBe(52);
    expect(placement?.bodyEnd).toBe(body.length);
  });

  it('decodes BlurFilter in the native CPicPlacement path', () => {
    const body = Uint8Array.from([
      ...placementBody({ matrix: IDENTITY, mediaRef: 3 }),
      0,
      1,
      1,
      ...s32le(10 * FIXED_1),
      ...s32le(12 * FIXED_1),
      0x10,
    ]);

    const placement = readCPicPlacement(new CArchiveReader(body), header('CPicSprite'));

    expect(placement?.filters).toEqual([{ type: 'blur', blurX: 10, blurY: 12, quality: 2 }]);
    expect(placement?.bodyEnd).toBe(body.length);
  });

  it('decodes DropShadowFilter after a color transform in the native CPicPlacement path', () => {
    const body = Uint8Array.from([
      ...placementBody({ matrix: IDENTITY, mediaRef: 3 }),
      1,
      ...u16le(128),
      0xff, ...u16le(0),
      0xff, ...u16le(0),
      0xff, ...u16le(0),
      ...u16le(0),
      1,
      0,
      0x11, 0x22, 0x33, 0x80,
      ...s32le(4 * FIXED_1),
      ...s32le(5 * FIXED_1),
      ...s32le(Math.round(Math.PI / 4 * FIXED_1)),
      ...s32le(6 * FIXED_1),
      ...u16le(512),
      0x18,
    ]);

    const placement = readCPicPlacement(new CArchiveReader(body), header('CPicSprite'));
    const filter = placement?.filters?.[0];

    expect(placement?.colorTransform?.alphaMultiplier).toBeCloseTo(0.5, 6);
    expect(filter?.type).toBe('dropShadow');
    if (filter?.type === 'dropShadow') {
      expect(filter.color).toBe('#112233');
      expect(filter.alpha).toBeCloseTo(128 / 255, 6);
      expect(filter.blurX).toBe(4);
      expect(filter.blurY).toBe(5);
      expect(filter.distance).toBe(6);
      expect(filter.angle).toBeCloseTo(45, 3);
      expect(filter.strength).toBe(2);
      expect(filter.quality).toBe(3);
    }
    expect(placement?.bodyEnd).toBe(body.length);
  });
});
