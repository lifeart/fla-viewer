import { describe, it, expect } from 'vitest';
import {
  extractLayers,
  extractTimelines,
} from '../binary-fla-structure';

// Build one CPicLayer record exactly as a Flash MX 2004 stream stores it
// (validated byte-for-byte against 5 real FLAs + the fla-decoder reference):
//   00 00 00 00 00 80 00 00 00 80   CPicObj NULL child tag + 2× INT_MIN point
//   <u8 layer_schema>
//   FF FE FF <u8 charLen> <UTF-16LE name>
//   <u8 type> <u8 locked> <u8 visible>
//   <u32 filler>                      (the post-triple color word, ignored)
function layerRecord(
  name: string,
  schema: number,
  type: number,
  locked: number,
  visible: number
): Uint8Array {
  const nameUtf16: number[] = [];
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    nameUtf16.push(code & 0xff, (code >> 8) & 0xff);
  }
  const charLen = name.length;
  return Uint8Array.from([
    0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x80, // SIG
    schema,
    0xff, 0xfe, 0xff, charLen,
    ...nameUtf16,
    type, locked, visible,
    0x00, 0x00, 0x00, 0x00, // filler (color u32)
  ]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

describe('extractLayers (binary FLA layer enumeration)', () => {
  it('decodes name / type / locked / visible for a multi-layer stream', () => {
    const stream = concat(
      Uint8Array.from([0x01, 0xff, 0xff, 0x00, 0x01]), // some preamble noise
      layerRecord('Layer 1', 11, 0, 0, 1),
      Uint8Array.from([0xaa, 0xbb]), // inter-layer junk (frame tails we skip)
      layerRecord('shaft', 11, 0, 1, 0),
      layerRecord('Layer 3', 11, 3, 0, 1) // type 3 = mask
    );
    const layers = extractLayers(stream);
    expect(layers).toEqual([
      { name: 'Layer 1', schema: 11, layerType: 'normal', locked: false, visible: true },
      { name: 'shaft', schema: 11, layerType: 'normal', locked: true, visible: false },
      { name: 'Layer 3', schema: 11, layerType: 'mask', locked: false, visible: true },
    ]);
  });

  it('classifies guide / folder layers, including by name prefix', () => {
    const stream = concat(
      // type byte 1 → guide
      layerRecord('Layer 2', 11, 1, 0, 0),
      // type byte 0 but "Guide: " name prefix → still guide
      layerRecord('Guide: Layer 8', 11, 0, 0, 1),
      // type byte 5 → folder
      layerRecord('My Folder', 11, 5, 0, 1),
      // type byte 4 → masked
      layerRecord('Masked Layer', 11, 4, 0, 1)
    );
    const layers = extractLayers(stream);
    expect(layers.map((l) => [l.name, l.layerType])).toEqual([
      ['Layer 2', 'guide'],
      ['Guide: Layer 8', 'guide'],
      ['My Folder', 'folder'],
      ['Masked Layer', 'masked'],
    ]);
  });

  it('returns [] for a stream with no layer signature (no false positives)', () => {
    // The 10-byte sentinel can precede non-layer objects (e.g. CPicShape) that
    // are NOT followed by a layer schema + name Flash string; those must not be
    // mis-read as layers.
    const notALayer = Uint8Array.from([
      0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x80, // SIG
      0x05, // schema-ish byte
      0x12, 0x34, 0x56, 0x78, // but NOT an FF FE FF Flash string
      0x9a, 0xbc,
    ]);
    expect(extractLayers(notALayer)).toEqual([]);
    expect(extractLayers(new Uint8Array(0))).toEqual([]);
  });
});

describe('extractTimelines (per-stream timeline structure)', () => {
  it('selects only Page N / Symbol N streams and sorts them', () => {
    const streams = new Map<string, Uint8Array>([
      ['Contents', layerRecord('ignored', 11, 0, 0, 1)],
      ['Symbol 2', layerRecord('Layer A', 11, 0, 0, 1)],
      ['Page 1', layerRecord('Layer B', 11, 0, 0, 1)],
      ['Media 1', new Uint8Array([1, 2, 3])],
    ]);
    const tls = extractTimelines(streams);
    // Page before Symbol; Contents/Media excluded.
    expect(tls.map((t) => t.stream)).toEqual(['Page 1', 'Symbol 2']);
    expect(tls[0].layers[0].name).toBe('Layer B');
    expect(tls[1].layers[0].name).toBe('Layer A');
  });
});
