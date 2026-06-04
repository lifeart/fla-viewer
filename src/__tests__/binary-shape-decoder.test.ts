import { describe, it, expect } from 'vitest';
// The committed fixture is a REAL Flash MX 2004 binary (OLE2) FLA: the
// "onRollOver Strobe Button" sample from canfieldstudios.com/flashmx2004
// (btnstrob.zip → btnstrob.fla). Loaded via Vite's ?url + fetch, the same way
// the other binary-FLA fixtures are loaded in this suite (browser test env).
import btnstrobUrl from './fixtures/btnstrob.fla?url';
import {
  ByteReader,
  ArchiveReader,
  readEdgeStream,
  readShapeData,
  readCPicShape,
  rawEdgesToEdges,
  colorFromU32,
  decodeStreamShapes,
  scanForShapes,
  recoverFillStyle0FromGeometry,
  ULTRA_TWIPS_PER_PX,
  type RawEdge,
} from '../binary-shape-decoder';
import { OLE2File } from '../ole2-reader';

async function loadBtnstrob(): Promise<Uint8Array> {
  const res = await fetch(btnstrobUrl);
  return new Uint8Array(await res.arrayBuffer());
}

// ── byte-builder helpers ────────────────────────────────────────────────────

function u8(...vals: number[]): number[] {
  return vals.map((v) => v & 0xff);
}
function u16le(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff];
}
function s16le(v: number): number[] {
  const n = v < 0 ? v + 0x10000 : v;
  return [n & 0xff, (n >> 8) & 0xff];
}
function u32le(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
}
function s32le(v: number): number[] {
  const n = v < 0 ? v + 0x100000000 : v;
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}

describe('binary-shape-decoder: coordinate unit (ultra-twips → px)', () => {
  // A single straight edge whose endpoint delta is one type-2 (s32,s32) pair.
  // We pick deltas that are EXACT multiples of 2560 so the expected pixel
  // values are integers and unambiguous: 2560 ultra-twips == 1 px.
  //   delta1 (move)  : type 0 → (0,0)        → from = (0,0)
  //   delta2 (control): type 0 → (0,0)       → straight edge
  //   delta3 (endpoint): type 2 → (5*2560, 3*2560) → to = (5px, 3px)
  // edge_flags layout: bits[1:0]=t1=0, bits[3:2]=t2=0, bits[5:4]=t3=2 → 0x20.
  const EDGE_FLAGS = 0x20; // t1=0, t2=0, t3=2 (straight: 0x0C bits clear)

  function singleEdgeStream(toUltraX: number, toUltraY: number): Uint8Array {
    return Uint8Array.from([
      ...u8(EDGE_FLAGS),
      ...s32le(toUltraX),
      ...s32le(toUltraY),
      ...u8(0x00), // terminator
    ]);
  }

  it('divides ultra-twips by 2560 to get pixels', () => {
    const r = new ByteReader(singleEdgeStream(5 * ULTRA_TWIPS_PER_PX, 3 * ULTRA_TWIPS_PER_PX));
    const raw = readEdgeStream(r);
    expect(raw).toHaveLength(1);
    // Raw edge is still in ultra-twips.
    expect(raw[0].toX).toBe(5 * ULTRA_TWIPS_PER_PX);
    expect(raw[0].toY).toBe(3 * ULTRA_TWIPS_PER_PX);
    // Converting to PathCommands divides by 2560 → exact pixels.
    const edges = rawEdgesToEdges(raw);
    expect(edges).toHaveLength(1);
    const cmds = edges[0].commands;
    expect(cmds[0]).toEqual({ type: 'M', x: 0, y: 0 });
    expect(cmds[1]).toEqual({ type: 'L', x: 5, y: 3 });
  });

  // LOAD-BEARING NEGATIVE CONTROL: this assertion only passes because the
  // decoder uses the 2560 divisor. If the divisor were wrong (e.g. 20 like the
  // matrix twips, or 128, or 1), the pixel value would NOT be 5. We assert the
  // expected px equals ultra/2560 and that it differs from the wrong divisors,
  // so a regression to the wrong unit is caught.
  it('would produce different pixels under the wrong divisor (proves /2560 is load-bearing)', () => {
    const ultra = 5 * ULTRA_TWIPS_PER_PX; // 12800
    const r = new ByteReader(singleEdgeStream(ultra, 0));
    const px = rawEdgesToEdges(readEdgeStream(r))[0].commands[1] as {
      type: 'L';
      x: number;
      y: number;
    };
    expect(px.x).toBe(ultra / ULTRA_TWIPS_PER_PX); // 5
    expect(px.x).not.toBe(ultra / 20); // wrong: twip divisor → 640
    expect(px.x).not.toBe(ultra / 128); // wrong: ×128 only → 100
    expect(px.x).not.toBe(ultra); // wrong: no divisor → 12800
  });
});

describe('binary-shape-decoder: delta accumulation', () => {
  // Three chained straight edges, each advancing the running endpoint by a
  // type-2 delta. The KEY correctness property: each edge's `from` is the
  // PREVIOUS edge's `to`, and `to = from + delta3`. If accumulation were
  // dropped (each edge starting from origin) the absolute coords would be
  // wrong after the first edge.
  function chainedEdges(): Uint8Array {
    const flags = 0x20; // t1=0, t2=0, t3=2, straight
    const step = 2 * ULTRA_TWIPS_PER_PX; // +2 px per edge
    return Uint8Array.from([
      ...u8(flags),
      ...s32le(step),
      ...s32le(0), // edge 1: (0,0)->(2,0)
      ...u8(flags),
      ...s32le(step),
      ...s32le(0), // edge 2: (2,0)->(4,0)
      ...u8(flags),
      ...s32le(0),
      ...s32le(step), // edge 3: (4,0)->(4,2)
      ...u8(0x00),
    ]);
  }

  it('accumulates the running endpoint across edges', () => {
    const raw = readEdgeStream(new ByteReader(chainedEdges()));
    expect(raw).toHaveLength(3);
    // Pixel-space chain after /2560.
    const px = (v: number) => v / ULTRA_TWIPS_PER_PX;
    expect([px(raw[0].fromX), px(raw[0].fromY)]).toEqual([0, 0]);
    expect([px(raw[0].toX), px(raw[0].toY)]).toEqual([2, 0]);
    // Edge 2 starts where edge 1 ended (NOT at origin) — accumulation.
    expect([px(raw[1].fromX), px(raw[1].fromY)]).toEqual([2, 0]);
    expect([px(raw[1].toX), px(raw[1].toY)]).toEqual([4, 0]);
    expect([px(raw[2].fromX), px(raw[2].fromY)]).toEqual([4, 0]);
    expect([px(raw[2].toX), px(raw[2].toY)]).toEqual([4, 2]);
  });

  it('would mislocate later edges if accumulation were dropped (proves accumulation is load-bearing)', () => {
    const raw = readEdgeStream(new ByteReader(chainedEdges()));
    // The third edge's absolute start is (4,0)px — only reachable by summing
    // the prior two deltas. A non-accumulating decoder would put it at (0,0).
    expect(raw[2].fromX).toBe(4 * ULTRA_TWIPS_PER_PX);
    expect(raw[2].fromX).not.toBe(0);
  });
});

describe('binary-shape-decoder: coord delta encodings', () => {
  it('type 3 left-shifts the stored value by 7 (twips → ultra-twips)', () => {
    // Real shapes use type-3 deltas storing twips; the decoder shifts <<7.
    // edge_flags 0x30 = t1=0, t2=0, t3=3 (straight). A stored s16 of 3600
    // (= 180 px in twips) becomes 3600<<7 = 460800 ultra-twips = 180 px.
    const stream = Uint8Array.from([
      ...u8(0x30),
      ...s16le(3600),
      ...s16le(0),
      ...u8(0x00),
    ]);
    const raw = readEdgeStream(new ByteReader(stream));
    expect(raw[0].toX).toBe(3600 << 7); // 460800
    expect(raw[0].toX).toBe(460800);
    expect(rawEdgesToEdges(raw)[0].commands[1]).toMatchObject({
      type: 'L',
      x: 180,
    });
  });

  it('type 1 reads raw s16 as ultra-twips directly (no shift)', () => {
    const stream = Uint8Array.from([
      ...u8(0x10),
      ...s16le(2560),
      ...s16le(0),
      ...u8(0x00),
    ]); // t3=1
    const raw = readEdgeStream(new ByteReader(stream));
    expect(raw[0].toX).toBe(2560); // NOT shifted
    expect(rawEdgesToEdges(raw)[0].commands[1]).toMatchObject({ type: 'L', x: 1 });
  });

  it('emits a quadratic Bézier when the control-offset bits are set', () => {
    // edge_flags: t1=0, t2=2 (control), t3=2 (endpoint) → 0x28 (0x0C bits set).
    const flags = (2 << 2) | (2 << 4); // 0x28
    const stream = Uint8Array.from([
      ...u8(flags),
      ...s32le(1 * ULTRA_TWIPS_PER_PX),
      ...s32le(2 * ULTRA_TWIPS_PER_PX), // ctrl offset
      ...s32le(4 * ULTRA_TWIPS_PER_PX),
      ...s32le(0), // endpoint offset
      ...u8(0x00),
    ]);
    const raw = readEdgeStream(new ByteReader(stream));
    expect(raw[0].kind).toBe('curve');
    const cmds = rawEdgesToEdges(raw)[0].commands;
    expect(cmds[1]).toEqual({ type: 'Q', cx: 1, cy: 2, x: 4, y: 0 });
  });
});

describe('binary-shape-decoder: style-change records', () => {
  it('applies u8 fill/line indices (flag 0x80) to subsequent edges', () => {
    // edge_flags 0xE0 = style-change(0x40) + u8(0x80) + t3=2.
    const stream = Uint8Array.from([
      ...u8(0xe0),
      ...u8(2, 0, 1), // fill0=2, fill1=0, line=1
      ...s32le(ULTRA_TWIPS_PER_PX),
      ...s32le(0),
      ...u8(0x00),
    ]);
    const raw = readEdgeStream(new ByteReader(stream));
    expect(raw[0].fill0).toBe(2);
    expect(raw[0].fill1).toBe(0);
    expect(raw[0].lineStyle).toBe(1);
    const edges = rawEdgesToEdges(raw);
    expect(edges[0].fillStyle0).toBe(2);
    expect(edges[0].strokeStyle).toBe(1);
  });
});

describe('binary-shape-decoder: recoverFillStyle0FromGeometry', () => {
  // A unit square split by its main diagonal P0(0,0)–P2(S,S) into two triangles
  // that SHARE that diagonal:
  //   • Lower-left triangle (fill 1): {P0, P3(0,S), P2}
  //   • Upper-right triangle (fill 2): {P0, P1(S,0), P2}
  // Flash stores ONLY fillStyle1 per edge (fill1 = the fill on the LEFT of
  // from→to, +y-down screen coords). The shared diagonal is owned by the
  // lower-left triangle via fillStyle1 = 1 (walked P2→P0, interior on its left);
  // the upper-right triangle sees that diagonal only through the (unstored)
  // fillStyle0. Without recovery, fill 2's boundary is OPEN (just its two outer
  // legs); recovery reconstructs the planar faces and sets the diagonal's
  // fill0 = 2 so region 2 closes. The interior-left winding below was computed
  // from the cross-product convention (see the btnstrob real-file test).
  function mkEdge(
    from: [number, number],
    to: [number, number],
    fill1: number,
    fill0 = 0
  ): RawEdge {
    return {
      fill0,
      fill1,
      lineStyle: 0,
      fromX: from[0],
      fromY: from[1],
      ctrlX: (from[0] + to[0]) >> 1,
      ctrlY: (from[1] + to[1]) >> 1,
      toX: to[0],
      toY: to[1],
      kind: 'line',
    };
  }

  it('assigns fill0 to a shared edge so the neighbouring region can close', () => {
    const S = 1000;
    // Lower-left triangle (fill 1), each edge interior-on-left:
    //   P0->P3, P3->P2, P2->P0 (the shared DIAGONAL, owned by fill1=1).
    // Upper-right triangle (fill 2), outer legs only (NOT the diagonal):
    //   P1->P0, P2->P1 (each interior-on-left, fill1=2).
    const edges: RawEdge[] = [
      mkEdge([S, S], [0, 0], 1), // shared diagonal P2->P0, owned by fill1=1
      mkEdge([0, 0], [0, S], 1), // LL: P0->P3 (left leg)
      mkEdge([0, S], [S, S], 1), // LL: P3->P2 (bottom leg)
      mkEdge([S, 0], [0, 0], 2), // UR: P1->P0 (bottom leg)
      mkEdge([S, S], [S, 0], 2), // UR: P2->P1 (right leg)
    ];

    recoverFillStyle0FromGeometry(edges);

    // The shared diagonal now also borders region 2 on its RIGHT side.
    const diag = edges[0];
    expect(diag.fill1).toBe(1); // unchanged: still owned by fill 1 on the left
    expect(diag.fill0).toBe(2); // recovered: region 2 lies on its right

    // The outer legs (already owned by their region via fill1) keep fill0 === 0.
    expect(edges[1].fill0).toBe(0);
    expect(edges[3].fill0).toBe(0);

    // Region 2's boundary is now closeable: the diagonal (fill0=2, contributes
    // reversed) + its two outer legs (fill1=2) form the triangle.
    const refFill0 = new Set(edges.map((e) => e.fill0).filter((f) => f !== 0));
    expect([...refFill0]).toEqual([2]);
  });

  it('leaves a lone single-fill loop untouched (no spurious fill0)', () => {
    const S = 1000;
    // A simple closed square, all four edges fill1 = 1. The interior face is
    // owned by fill1; the only other face is the unbounded outer face (skipped).
    const edges: RawEdge[] = [
      mkEdge([0, 0], [S, 0], 1),
      mkEdge([S, 0], [S, S], 1),
      mkEdge([S, S], [0, S], 1),
      mkEdge([0, S], [0, 0], 1),
    ];
    recoverFillStyle0FromGeometry(edges);
    for (const e of edges) expect(e.fill0).toBe(0);
  });

  it('never overwrites an existing fill0', () => {
    const S = 1000;
    const edges: RawEdge[] = [
      mkEdge([0, 0], [S, 0], 1, 7), // pre-set fill0 = 7
      mkEdge([S, 0], [S, S], 1),
      mkEdge([S, S], [0, S], 1),
      mkEdge([0, S], [0, 0], 1),
    ];
    recoverFillStyle0FromGeometry(edges);
    expect(edges[0].fill0).toBe(7); // untouched
  });
});

describe('binary-shape-decoder: colorFromU32', () => {
  it('reads R,G,B,A from LE byte order', () => {
    // 0xff00ff66 LE bytes = 66 ff 00 ff → R=0x66 G=0xff B=0x00 A=0xff.
    expect(colorFromU32(0xff00ff66)).toEqual({ color: '#66ff00', alpha: 1 });
  });
});

// ── Full synthetic CPicShape body (CPicObj base + matrix + shape_data) ───────

describe('binary-shape-decoder: full CPicShape body', () => {
  // Build a leaf CPicShape exactly as Flash stores it (matching the real
  // btnstrob Symbol 1 layout we traced byte-for-byte):
  //   u8 cpicobj_schema=2, u8 flags=0
  //   u16 0x0000 (NULL child list), s32 INT_MIN, s32 INT_MIN (point)
  //   u8 shape_schema=2
  //   6×u32 matrix = identity (a=d=0x00010000, rest 0)
  //   u8 shape_data_schema=5, u32 edge_hint, u16 fill_count=1, <fill>, u16 line_count=0
  //   edge stream (one straight edge to 10px,10px), terminator
  function syntheticShapeBody(): Uint8Array {
    return Uint8Array.from([
      ...u8(2, 0), // cpicobj schema, flags
      ...u16le(0x0000), // NULL child list
      ...s32le(-0x80000000), // point.x INT_MIN
      ...s32le(-0x80000000), // point.y INT_MIN
      ...u8(2), // shape_schema (>2? no → caps_flag false)
      ...u32le(0x00010000), // a
      ...u32le(0), // b
      ...u32le(0), // c
      ...u32le(0x00010000), // d
      ...u32le(0), // tx (twips)
      ...u32le(0), // ty
      ...u8(5), // shape_data_schema (modern)
      ...u32le(1), // edge_count_hint
      ...u16le(1), // fill_count
      ...u32le(0xff0000ee), // fill color: R=ee G=00 B=00 A=ff
      ...u8(0x00), // subtype = solid
      ...u8(0x00), // more_flags
      ...u16le(0), // line_count
      // edge stream: one straight edge (0,0)->(10,10)
      ...u8(0x20), // t1=0,t2=0,t3=2
      ...s32le(10 * ULTRA_TWIPS_PER_PX),
      ...s32le(10 * ULTRA_TWIPS_PER_PX),
      ...u8(0x00), // terminator
    ]);
  }

  it('reads CPicObj base + matrix + shape_data and yields one pixel-space edge', () => {
    const r = new ByteReader(syntheticShapeBody());
    const ar = new ArchiveReader(r);
    const { shape, rawEdges } = readCPicShape(r, ar);
    expect(shape.matrix).toEqual({ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 });
    expect(shape.fills).toEqual([
      { index: 1, type: 'solid', color: '#ee0000', alpha: 1 },
    ]);
    expect(shape.strokes).toHaveLength(0);
    expect(rawEdges).toHaveLength(1);
    expect(shape.edges).toHaveLength(1);
    expect(shape.edges[0].commands).toEqual([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 10, y: 10 },
    ]);
  });

  it('legacy shape_data_schema (<3) reads solid fills as u32 color + u16 flags', () => {
    const r = new ByteReader(
      Uint8Array.from([
        ...u8(2), // shape_data_schema = 2 (edge stream present, legacy fills)
        ...u32le(0),
        ...u16le(1), // fill_count
        ...u32le(0xff112233), // color (B=33 G=22 R=11 A=ff → #112233)... wait LE
        ...u16le(0x0000), // legacy flags
        ...u16le(0), // line_count
        ...u8(0x20),
        ...s32le(ULTRA_TWIPS_PER_PX),
        ...s32le(0),
        ...u8(0x00),
      ])
    );
    const data = readShapeData(r, false);
    expect(data.fills).toEqual([
      { index: 1, type: 'solid', color: '#332211', alpha: 1 },
    ]);
    expect(data.rawEdges).toHaveLength(1);
  });
});

// ── Recovery scanner on a synthetic stream with the INT_MIN signature ───────

describe('binary-shape-decoder: recovery scanner', () => {
  it('locates a shape via the INT_MIN signature embedded in noise', () => {
    const shapeBody = Uint8Array.from([
      ...u8(2, 0),
      ...u16le(0x0000),
      ...s32le(-0x80000000),
      ...s32le(-0x80000000),
      ...u8(2),
      ...u32le(0x00010000),
      ...u32le(0),
      ...u32le(0),
      ...u32le(0x00010000),
      ...u32le(0),
      ...u32le(0),
      ...u8(5),
      ...u32le(4),
      ...u16le(1),
      ...u32le(0xff00ff00),
      ...u8(0x00),
      ...u8(0x00),
      ...u16le(0),
      // 4 edges so it clears the signature scanner's min-3-edge bar
      ...u8(0x20),
      ...s32le(5 * ULTRA_TWIPS_PER_PX),
      ...s32le(0),
      ...u8(0x20),
      ...s32le(0),
      ...s32le(5 * ULTRA_TWIPS_PER_PX),
      ...u8(0x20),
      ...s32le(-5 * ULTRA_TWIPS_PER_PX),
      ...s32le(0),
      ...u8(0x20),
      ...s32le(0),
      ...s32le(-5 * ULTRA_TWIPS_PER_PX),
      ...u8(0x00),
    ]);
    // Surround the shape with junk bytes.
    const junk = new Uint8Array(40).fill(0x42);
    const stream = new Uint8Array(junk.length + shapeBody.length + junk.length);
    stream.set(junk, 0);
    stream.set(shapeBody, junk.length);
    stream.set(junk, junk.length + shapeBody.length);

    const found = scanForShapes(stream);
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found[0].edgeCount).toBe(4);
    expect(found[0].shape.fills[0]).toMatchObject({ type: 'solid' });
  });
});

// ── REAL-FILE decode assertion (canfield Flash MX 2004 sample) ──────────────
// The btnstrob.fla "onRollOver Strobe Button" sample from canfieldstudios.com
// is a real Flash MX 2004 binary (OLE2) FLA. Symbol 1's shape is a 180×180px
// square with a green (#66ff00) fill and a red (#ff0000) stroke. We assert the
// exact decoded geometry — these numbers were cross-checked against the
// eddiemoore/fla-decoder reference Python decoder (identical output).
describe('binary-shape-decoder: real Flash MX 2004 FLA (btnstrob.fla)', () => {
  it('decodes Symbol 1 as a 180px square with the expected fill/stroke', async () => {
    const bytes = await loadBtnstrob();
    // Confirm OLE2 magic (D0 CF 11 E0) — it really is a pre-CS5 binary FLA.
    expect([...bytes.slice(0, 4)]).toEqual([0xd0, 0xcf, 0x11, 0xe0]);

    const ole = new OLE2File(bytes);
    const res = decodeStreamShapes(ole.readStream('Symbol 1'));
    expect(res.rootClass).toBe('CPicPage');
    expect(res.shapes).toHaveLength(1);
    expect(res.totalEdges).toBe(4);

    const shape = res.shapes[0];
    expect(shape.fills).toEqual([
      { index: 1, type: 'solid', color: '#66ff00', alpha: 1 },
    ]);
    expect(shape.strokes[0]).toMatchObject({ index: 1, color: '#ff0000' });
    // ONE Edge PER RawEdge (Ruffle/SWF edge-soup contract): the 180×180 square
    // is four straight edges, each `[M(from), L(to)]`, each carrying its OWN
    // per-edge fill/stroke refs (fillStyle0=1 RIGHT side, strokeStyle=1). The
    // decoder no longer pre-concatenates them into one grouped path — the
    // renderer stitches the soup into a closed contour itself.
    expect(shape.edges).toHaveLength(4);
    for (const edge of shape.edges) {
      expect(edge.commands).toHaveLength(2);
      expect(edge.commands[0].type).toBe('M');
      expect(edge.commands[1].type).toBe('L');
      // Each square side borders fill 1 on its RIGHT (fillStyle0) and carries
      // the red stroke; fillStyle1 is unset (the outside).
      expect(edge.fillStyle0).toBe(1);
      expect(edge.fillStyle1).toBeUndefined();
      expect(edge.strokeStyle).toBe(1);
    }
    // The four edges, walked head-to-tail, still trace the closed square.
    const verts = shape.edges.map((e) => {
      const m = e.commands[0] as { type: 'M'; x: number; y: number };
      const l = e.commands[1] as { type: 'L'; x: number; y: number };
      return { from: [m.x, m.y], to: [l.x, l.y] };
    });
    expect(verts).toEqual([
      { from: [180, 180], to: [0, 180] },
      { from: [0, 180], to: [0, 0] },
      { from: [0, 0], to: [180, 0] },
      { from: [180, 0], to: [180, 180] },
    ]);
  });

  it('decodes a richer symbol with many edges (Symbol 2)', async () => {
    const bytes = await loadBtnstrob();
    const ole = new OLE2File(bytes);
    const res = decodeStreamShapes(ole.readStream('Symbol 2'));
    expect(res.shapes.length).toBeGreaterThanOrEqual(2);
    expect(res.totalEdges).toBeGreaterThanOrEqual(16);
  });

  // ── Load-bearing regression for the un-grouping fix ───────────────────────
  // Symbol 2 shape[1] is a 4-fill bordered frame (#ffffff ×2, #000000 ×2). The
  // OLD decoder grouped raw edges by (fill0,fill1,lineStyle), producing 10
  // Edges, two of which CONCATENATED disjoint raw edges with an internal `M`
  // (e.g. outer-top + inner-top under fill1=1). The NEW decoder emits ONE Edge
  // per RawEdge (12 single-segment `[M, L]` edges, zero internal moves), each
  // carrying its own fill ref — the Ruffle/SWF edge-soup contract the renderer
  // expects. This pins that contract: it FAILS against the grouped decoder
  // (which gave 10 edges / 2 multi-segment) and PASSES against the per-edge one.
  it('emits one Edge per RawEdge for the 4-fill bordered frame (no grouping)', async () => {
    const bytes = await loadBtnstrob();
    const ole = new OLE2File(bytes);
    const res = decodeStreamShapes(ole.readStream('Symbol 2'));
    const shape = res.shapes[1];

    // Four declared solid fills (two white bevels, two black bevels).
    expect(shape.fills.map((f) => f.index)).toEqual([1, 2, 3, 4]);

    // Exactly one Edge per raw edge: 12 single-segment edges, each a `[M, L]`.
    expect(shape.edges).toHaveLength(12);
    let internalMoves = 0;
    for (const edge of shape.edges) {
      expect(edge.commands).toHaveLength(2);
      expect(edge.commands[0].type).toBe('M');
      // No edge concatenates a second subpath via an internal MoveTo.
      internalMoves += edge.commands.filter((c) => c.type === 'M').length - 1;
    }
    expect(internalMoves).toBe(0);

    // Every declared fill is referenced as some edge's LEFT side (fillStyle1) —
    // the frame's four bevel regions each have a boundary contribution, so the
    // renderer can stitch all four (none is silently dropped by grouping).
    const refFill1 = new Set<number>();
    for (const edge of shape.edges) {
      if (edge.fillStyle1 !== undefined) refFill1.add(edge.fillStyle1);
    }
    expect([...refFill1].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  // ── Load-bearing regression: fillStyle0 recovery (side bevels paint) ───────
  // The binary edge stream stores ONLY fillStyle1 per edge — hand-decoding
  // btnstrob Symbol 2 shape[1] shows every style-change record is
  // `f3/f0 00 XX YY` with byte0 (fill0) ALWAYS 0x00 (no desync, no presence
  // mask: the source genuinely omits fill0). The TOP (fill 1) and BOTTOM
  // (fill 3) bevels each have four fillStyle1 edges and close on their own, but
  // the LEFT (fill 2) and RIGHT (fill 4) side bevels each have only ONE
  // fillStyle1 edge (the inner vertical) and CANNOT close — so they rendered
  // blank. `recoverFillStyle0FromGeometry` reconstructs the planar faces and
  // assigns the missing fill0 to the shared corner diagonals + outer verticals.
  //
  // This pins the recovered fill0: it FAILS against the pre-fix decoder (every
  // edge had fill0 === 0 / undefined) and PASSES after. The geometry:
  //   • RIGHT bevel = fill 4: inner-right vertical owns it via fillStyle1=4;
  //     the two right corner diagonals + outer-right vertical must carry fill0=4
  //   • LEFT bevel = fill 2: inner-left vertical owns it via fillStyle1=2;
  //     the two left corner diagonals + outer-left vertical must carry fill0=2
  it('recovers fillStyle0 on the side-bevel boundary edges so fills 2 & 4 close', async () => {
    const bytes = await loadBtnstrob();
    const ole = new OLE2File(bytes);
    const res = decodeStreamShapes(ole.readStream('Symbol 2'));
    const shape = res.shapes[1];
    expect(shape.edges).toHaveLength(12);

    // Index the 12 edges by their (from→to) endpoints in px (stable identity).
    const byEnds = new Map<string, (typeof shape.edges)[number]>();
    for (const e of shape.edges) {
      const m = e.commands[0] as { type: 'M'; x: number; y: number };
      const l = e.commands[1] as { type: 'L'; x: number; y: number };
      byEnds.set(`${m.x},${m.y}->${l.x},${l.y}`, e);
    }
    const get = (k: string) => {
      const e = byEnds.get(k);
      if (!e) throw new Error(`edge ${k} not found`);
      return e;
    };

    // RIGHT bevel (fill 4): top-right diag, bottom-right diag, outer-right vert
    // all border fill 4 on their RIGHT (fillStyle0). Inner-right vert owns it.
    expect(get('120,-40->140,-60').fillStyle0).toBe(4); // top-right diagonal
    expect(get('140,60->120,40').fillStyle0).toBe(4); // bottom-right diagonal
    expect(get('140,-60->140,60').fillStyle0).toBe(4); // outer-right vertical
    expect(get('120,-40->120,40').fillStyle1).toBe(4); // inner-right (owner)

    // LEFT bevel (fill 2): top-left diag, bottom-left diag, outer-left vert.
    expect(get('-140,-60->-120,-40').fillStyle0).toBe(2); // top-left diagonal
    expect(get('-120,40->-140,60').fillStyle0).toBe(2); // bottom-left diagonal
    expect(get('-140,60->-140,-60').fillStyle0).toBe(2); // outer-left vertical
    expect(get('-120,40->-120,-40').fillStyle1).toBe(2); // inner-left (owner)

    // Now EVERY declared fill is the LEFT (fillStyle1) of some edge AND every
    // side fill (2,4) is also the RIGHT (fillStyle0) of ≥3 edges — i.e. all four
    // bevel regions have a closeable boundary. Pre-fix, fillStyle0 was never set.
    const refFill0 = new Set<number>();
    for (const edge of shape.edges) {
      if (edge.fillStyle0 !== undefined) refFill0.add(edge.fillStyle0);
    }
    expect([...refFill0].sort((a, b) => a - b)).toEqual([2, 4]);
  });
});

// Silence "unused" for the RawEdge type import in environments that tree-shake.
const _typeProbe: RawEdge | null = null;
void _typeProbe;
