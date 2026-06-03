import { describe, it, expect } from 'vitest';
// The committed fixture is a REAL Flash MX 2004 binary (OLE2) FLA: the
// "onRollOver Strobe Button" sample from canfieldstudios.com (btnstrob.fla).
// Its `Page 1` scene PLACES library Symbol 1 (a green 180px square) via a
// CPicSprite instance at (300,150) px — the case this module decodes. Loaded
// via Vite's ?url + fetch, the same way the other binary-FLA fixtures load.
import btnstrobUrl from './fixtures/btnstrob.fla?url';
import { OLE2File } from '../ole2-reader';
import { parseBinaryFLA } from '../binary-fla-parser';
import {
  buildCombinedClassTable,
  dedupeInstances,
  instanceSymbolType,
  scanForInstances,
  tryParseInstanceAt,
  type DecodedInstance,
} from '../binary-instance-decoder';

async function loadBtnstrob(): Promise<Uint8Array> {
  const res = await fetch(btnstrobUrl);
  return new Uint8Array(await res.arrayBuffer());
}

// ── byte-builder helpers (little-endian) ────────────────────────────────────
function u8(...v: number[]): number[] {
  return v.map((n) => n & 0xff);
}
function u16le(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff];
}
function s32le(v: number): number[] {
  const n = v < 0 ? v + 0x100000000 : v;
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}
function u32le(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
}
function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

const FIXED_1 = 0x00010000; // 1.0 in 16.16 fixed-point
const NEWCLASS = [0xff, 0xff];

/**
 * Build a CPicSymbol-derived placement BODY (the bytes that follow the class
 * tag), exactly matching the layout verified byte-for-byte against btnstrob.fla
 * `Page 1`: CPicObj base (schema 2 → NULL child + 2×s32 point), then
 * symbol_schema, 6-u32 matrix, field_b0/cc, field_90, name, media_ref.
 */
function placementBody(opts: {
  cpicObjSchema?: number;
  flags?: number;
  pointX?: number;
  pointY?: number;
  symbolSchema?: number;
  matrix: [number, number, number, number, number, number]; // a,b,c,d (16.16), tx,ty (twips)
  name?: string;
  mediaRef: number;
}): number[] {
  const schema = opts.cpicObjSchema ?? 2;
  const name = opts.name ?? '';
  const out: number[] = [];
  out.push(...u8(schema, opts.flags ?? 0));
  out.push(...u16le(0x0000)); // NULL child list (leaf placement)
  out.push(...s32le(opts.pointX ?? 6000));
  out.push(...s32le(opts.pointY ?? 3000));
  if (schema >= 3) out.push(...u8(0));
  if (schema >= 4) out.push(...u8(0));
  out.push(...u8(opts.symbolSchema ?? 14)); // symbol_schema
  for (const m of opts.matrix) out.push(...s32le(m));
  out.push(...u16le(0)); // field_b0
  out.push(...u16le(2)); // field_cc
  out.push(...u8(1)); // field_90 marker
  out.push(...u16le(256), ...u16le(0), ...u16le(256), ...u16le(0)); // 4×u16
  out.push(...u8(name.length), ...ascii(name)); // instance name
  out.push(...u32le(opts.mediaRef)); // media_ref → library item id
  return out;
}

/** `FFFF <schema u16> <len u16> <ascii name>` — a NEWCLASS declaration. */
function classDecl(name: string, schema = 1): number[] {
  return [
    ...NEWCLASS,
    ...u16le(schema),
    ...u16le(name.length),
    ...ascii(name),
  ];
}

const IDENTITY: [number, number, number, number, number, number] = [
  FIXED_1,
  0,
  0,
  FIXED_1,
  6000, // tx = 6000 twips = 300 px
  3000, // ty = 3000 twips = 150 px
];

// ── tryParseInstanceAt: the field-by-field placement parser ─────────────────
describe('binary-instance-decoder: tryParseInstanceAt', () => {
  it('decodes a CPicSprite placement body (matrix + media_ref)', () => {
    const body = new Uint8Array(
      placementBody({ matrix: IDENTITY, mediaRef: 1 })
    );
    const inst = tryParseInstanceAt(body, 0, 'CPicSprite', 'class_decl');
    expect(inst).not.toBeNull();
    expect(inst!.mediaRef).toBe(1);
    expect(inst!.className).toBe('CPicSprite');
    expect(inst!.matrix).toEqual({
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      tx: 300, // 6000 twips ÷ 20
      ty: 150, // 3000 twips ÷ 20
    });
    expect(inst!.endPos).toBe(body.length);
  });

  it('decodes a non-identity matrix (scale + translate)', () => {
    // a=0.5, d=2.0, tx=40 twips (=2px), ty=-100 twips (=-5px).
    const body = new Uint8Array(
      placementBody({
        matrix: [FIXED_1 / 2, 0, 0, FIXED_1 * 2, 40, -100],
        mediaRef: 7,
        name: 'inst7',
      })
    );
    const inst = tryParseInstanceAt(body, 0, 'CPicShapeObj', 'backref')!;
    expect(inst.matrix.a).toBeCloseTo(0.5, 6);
    expect(inst.matrix.d).toBeCloseTo(2.0, 6);
    expect(inst.matrix.tx).toBeCloseTo(2, 6);
    expect(inst.matrix.ty).toBeCloseTo(-5, 6);
    expect(inst.instanceName).toBe('inst7');
    expect(inst.mediaRef).toBe(7);
  });

  it('handles CPicObj schema 5 (extra1/extra2 bytes present)', () => {
    const body = new Uint8Array(
      placementBody({ cpicObjSchema: 5, matrix: IDENTITY, mediaRef: 3 })
    );
    const inst = tryParseInstanceAt(body, 0, 'CPicSprite', 'class_decl')!;
    expect(inst.mediaRef).toBe(3);
    expect(inst.matrix.tx).toBe(300);
  });

  it('rejects a body whose child list is not the NULL terminator', () => {
    const body = new Uint8Array(
      placementBody({ matrix: IDENTITY, mediaRef: 1 })
    );
    // Corrupt the child tag (bytes 2..3) to a non-null value.
    body[2] = 0xff;
    body[3] = 0xff;
    expect(tryParseInstanceAt(body, 0, 'CPicSprite', 'class_decl')).toBeNull();
  });

  it('rejects a degenerate (a=d=0) matrix', () => {
    const body = new Uint8Array(
      placementBody({ matrix: [0, 0, 0, 0, 6000, 3000], mediaRef: 1 })
    );
    expect(tryParseInstanceAt(body, 0, 'CPicSprite', 'class_decl')).toBeNull();
  });

  it('rejects an out-of-range media_ref (likely a mis-parse)', () => {
    const body = new Uint8Array(
      placementBody({ matrix: IDENTITY, mediaRef: 99999 })
    );
    expect(tryParseInstanceAt(body, 0, 'CPicSprite', 'class_decl')).toBeNull();
  });

  it('rejects truncated input without throwing', () => {
    const body = new Uint8Array(
      placementBody({ matrix: IDENTITY, mediaRef: 1 })
    ).subarray(0, 10);
    expect(tryParseInstanceAt(body, 0, 'CPicSprite', 'class_decl')).toBeNull();
  });
});

// ── buildCombinedClassTable: NEWCLASS forward scan ──────────────────────────
describe('binary-instance-decoder: buildCombinedClassTable', () => {
  it('allocates two combined slots per NEWCLASS, in stream order', () => {
    const data = new Uint8Array([
      ...classDecl('CPicPage'),
      0x00,
      ...classDecl('CPicLayer'),
      0x00,
      ...classDecl('CPicSprite'),
    ]);
    const combined = buildCombinedClassTable(data);
    // 3 classes × 2 slots = 6 entries; class is at odd 1-based index.
    expect(combined).toEqual([
      'CPicPage',
      'CPicPage',
      'CPicLayer',
      'CPicLayer',
      'CPicSprite',
      'CPicSprite',
    ]);
    // CPicSprite's class slot is combined index 5 (1-based) → combined[4].
    expect(combined[4]).toBe('CPicSprite');
  });
});

// ── scanForInstances: class-decl + backref recovery ─────────────────────────
describe('binary-instance-decoder: scanForInstances', () => {
  it('recovers a placement following a CPicSprite class declaration', () => {
    const data = new Uint8Array([
      ...classDecl('CPicPage'),
      ...classDecl('CPicSprite'),
      ...placementBody({ matrix: IDENTITY, mediaRef: 1 }),
    ]);
    const found = scanForInstances(data);
    expect(found).toHaveLength(1);
    expect(found[0].className).toBe('CPicSprite');
    expect(found[0].mediaRef).toBe(1);
    expect(found[0].recoveredVia).toBe('class_decl');
    expect(found[0].matrix.tx).toBe(300);
  });

  it('recovers extra placements via a back-ref tag to the instance class', () => {
    // With CPicPage (combined 1/2) then CPicSprite (combined 3/4) declared, a
    // second placement is instantiated with a back-ref to CPicSprite's object
    // slot — tag 0x8004 (combined index 4). (Real files put CPicSprite later in
    // the table; this synthetic stream just declares the two classes it needs.)
    const decls = [...classDecl('CPicPage'), ...classDecl('CPicSprite')];
    const first = placementBody({ matrix: IDENTITY, mediaRef: 1 });
    const backref = u16le(0x8004);
    const second = placementBody({
      matrix: [FIXED_1, 0, 0, FIXED_1, 1000, 2000],
      mediaRef: 2,
    });
    const data = new Uint8Array([...decls, ...first, ...backref, ...second]);
    const found = scanForInstances(data);
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.mediaRef).sort()).toEqual([1, 2]);
    const byBackref = found.find((f) => f.recoveredVia === 'backref');
    expect(byBackref).toBeDefined();
    expect(byBackref!.mediaRef).toBe(2);
    expect(byBackref!.matrix.tx).toBe(50); // 1000 twips ÷ 20
  });

  it('does NOT treat a back-ref to a NON-instance class as a placement', () => {
    // CPicFrame is declared at combined index 3/4 — NOT an instance class. A
    // back-ref 0x8004 preceding a placement-shaped body must be ignored, even
    // if the trailing bytes would otherwise parse (false-positive guard).
    const decls = [
      ...classDecl('CPicPage'),
      ...classDecl('CPicFrame'),
      ...classDecl('CPicSprite'),
    ];
    const sprite = placementBody({ matrix: IDENTITY, mediaRef: 1 });
    // A CPicFrame back-ref (0x8004) followed by a placement-shaped body.
    const frameBackref = u16le(0x8004);
    const decoy = placementBody({
      matrix: [FIXED_1, 0, 0, FIXED_1, 500, 500],
      mediaRef: 9,
    });
    const data = new Uint8Array([
      ...decls,
      ...sprite,
      ...frameBackref,
      ...decoy,
    ]);
    const found = scanForInstances(data);
    // Only the genuine CPicSprite declaration placement is recovered.
    expect(found.map((f) => f.mediaRef)).toEqual([1]);
  });
});

// ── dedupeInstances ─────────────────────────────────────────────────────────
describe('binary-instance-decoder: dedupeInstances', () => {
  it('collapses placements identical in mediaRef + matrix, keeps distinct', () => {
    const base: Omit<DecodedInstance, 'matrix' | 'mediaRef'> = {
      className: 'CPicSprite',
      instanceName: '',
      recoveredVia: 'backref',
      bodyStart: 0,
      endPos: 0,
    };
    const m = (tx: number): DecodedInstance['matrix'] => ({
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      tx,
      ty: 0,
    });
    const insts: DecodedInstance[] = [
      { ...base, mediaRef: 1, matrix: m(10) },
      { ...base, mediaRef: 1, matrix: m(10) }, // exact duplicate
      { ...base, mediaRef: 1, matrix: m(20) }, // distinct position
      { ...base, mediaRef: 2, matrix: m(10) }, // distinct symbol
    ];
    const deduped = dedupeInstances(insts);
    expect(deduped).toHaveLength(3);
  });
});

describe('binary-instance-decoder: instanceSymbolType', () => {
  it('maps placement classes to viewer symbol kinds', () => {
    expect(instanceSymbolType('CPicButton')).toBe('button');
    expect(instanceSymbolType('CPicShapeObj')).toBe('graphic');
    expect(instanceSymbolType('CPicSprite')).toBe('movieclip');
  });
});

// ── REAL-FILE: btnstrob.fla scene places library Symbol 1 ───────────────────
// The headline case: the scene (Page 1) PLACES Symbol 1 (a green square) via a
// CPicSprite instance at (300,150) px. The geometry PR decoded the symbol into
// the library but left the stage EMPTY; this decodes the placement.
describe('binary-instance-decoder: real Flash MX 2004 FLA (btnstrob.fla)', () => {
  it('recovers the scene CPicSprite placement (media_ref 1 @ 300,150)', async () => {
    const bytes = await loadBtnstrob();
    expect([...bytes.slice(0, 4)]).toEqual([0xd0, 0xcf, 0x11, 0xe0]);
    const ole = new OLE2File(bytes);
    const found = scanForInstances(ole.readStream('Page 1'));
    expect(found).toHaveLength(1);
    expect(found[0].className).toBe('CPicSprite');
    expect(found[0].mediaRef).toBe(1); // → library "Symbol 1"
    expect(found[0].matrix).toEqual({
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      tx: 300,
      ty: 150,
    });
  });

  it('parseBinaryFLA composites Symbol 1 onto the scene (was empty)', async () => {
    const bytes = await loadBtnstrob();
    const doc = parseBinaryFLA(bytes);

    // The library still decodes its symbols (geometry PR).
    expect(doc.symbols.has('Symbol 1')).toBe(true);

    // The scene now carries a SymbolInstance referencing Symbol 1 — previously
    // the scene's frames were entirely empty.
    const scene = doc.timelines[0];
    const allElements = scene.layers.flatMap((l) =>
      l.frames.flatMap((f) => f.elements)
    );
    const symbolInstances = allElements.filter((e) => e.type === 'symbol');
    expect(symbolInstances).toHaveLength(1);
    const placed = symbolInstances[0];
    expect(placed.type).toBe('symbol');
    if (placed.type === 'symbol') {
      expect(placed.libraryItemName).toBe('Symbol 1');
      expect(placed.matrix.tx).toBe(300);
      expect(placed.matrix.ty).toBe(150);
      // The referenced symbol exists and carries the green square geometry.
      const sym = doc.symbols.get(placed.libraryItemName)!;
      const shapes = sym.timeline.layers
        .flatMap((l) => l.frames.flatMap((f) => f.elements))
        .filter((e) => e.type === 'shape');
      expect(shapes.length).toBeGreaterThanOrEqual(1);
    }

    // The placement is hosted on a layer the renderer will actually draw
    // (visible, not a guide/folder reference layer) — otherwise the artwork
    // would be silently dropped.
    const hostLayer = scene.layers.find((l) =>
      l.frames.some((f) => f.elements.some((e) => e.type === 'symbol'))
    )!;
    expect(hostLayer.visible).toBe(true);
    expect(hostLayer.layerType === 'guide' || hostLayer.layerType === 'folder').toBe(
      false
    );
  });
});
