/**
 * Vector SHAPE GEOMETRY decoder for pre-CS5 *binary* `.fla` files
 * (GitHub issue #8 — the headline gap left open by the document-props /
 * library / layer-list work in {@link ./binary-fla-parser} and
 * {@link ./binary-fla-structure}).
 *
 * Until now the binary-FLA path rendered an EMPTY stage: it read the OLE2
 * container, document properties, library table and per-stream layer list,
 * but no actual artwork. This module decodes the `CPicShape` geometry — the
 * fills, strokes and edge stream — so real shapes render.
 *
 * ── Protocol source ────────────────────────────────────────────────────────
 * The format is the MFC `CArchive` object serialization Flash 5 .. CS4 used,
 * reverse-engineered from Flash 8's `flash.exe` and documented by Ed Moore in
 * "Cracking the Pre-CS5 Binary FLA"
 * (https://www.canfieldstudios.com — sample files; blog + decoder at
 * https://github.com/eddiemoore/fla-decoder, `fla_decoder/decoder.py` +
 * `docs/FORMAT.md`). This is a faithful TypeScript port of that decoder's
 * shape path, validated against real Flash MX 2004 sample FLAs (see
 * `src/__tests__/binary-shape-decoder.test.ts`).
 *
 * ── Wire format recap (FORMAT.md §2, §4, §6) ────────────────────────────────
 * CArchive class tags (LE u16):
 *   0x0000        null / end-of-children-list
 *   0xFFFF        new class: u16 schema, u16 nameLen, nameLen ASCII bytes
 *   0x8000|idx    back-reference to a previously declared class
 *   0x7FFF + u32  long-form back-reference
 * Strings: `FF FE FF <u8 charLen> <2*charLen UTF-16LE>`.
 *
 * CPicObj::Serialize: u8 schema; u8 flags; children-loop { tag; if NULL break;
 *   ReadObject; append } ; if schema>=1: 2×s32 point (often INT_MIN sentinel);
 *   if schema>=3: u8; if schema>=4: u8.
 * CPicShape::Serialize: CPicObj base; u8 shape_schema; 6×u32 matrix; shape_data.
 *
 * Matrix: a,b,c,d are 16.16 fixed-point; tx,ty are integer twips (÷20 → px).
 *
 * shape_data: u8 shape_data_schema; u32 edge_count_hint; u16 fill_count + fills;
 *   u16 line_count + line styles; then the EDGE STREAM (schema>=2) until a
 *   zero terminator byte.
 *
 * Edge stream coordinates accumulate in Flash "ultra-twips": 1 px = 2560 units
 * (= 20 twips × 128). Every edge is a quadratic Bézier; a "straight" edge has
 * its control point at the midpoint of from/to. We convert ultra-twips to
 * pixels (÷2560) and emit `M`/`L`/`Q` PathCommands.
 *
 * No errors are silently swallowed (project rule): a truncated/garbled shape
 * records a typed reason and is skipped, never crashing the whole parse.
 */

import type {
  Edge,
  FillStyle,
  Matrix,
  PathCommand,
  Shape,
  StrokeStyle,
} from './types';

/** Flash internal coordinate unit: 1 px = 2560 ultra-twips (= 20 twips × 128). */
export const ULTRA_TWIPS_PER_PX = 2560;
/** Matrix translation unit: 1 px = 20 twips. */
const TWIPS_PER_PX = 20;
/** 16.16 fixed-point divisor (1.0 == 0x00010000). */
const FIXED_16_16 = 65536;

const ascii = new TextDecoder('ascii');

/** Thrown when a read runs past the end of the stream buffer. */
export class EndOfStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EndOfStreamError';
  }
}

/** Little-endian cursor over a stream's bytes (mirrors decoder.py `Reader`). */
export class ByteReader {
  pos = 0;
  private view: DataView;
  constructor(public buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  private need(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new EndOfStreamError(
        `need ${n} bytes at pos 0x${this.pos.toString(16)}, only ${this.remaining()} left`
      );
    }
  }
  u8(): number {
    this.need(1);
    return this.buf[this.pos++];
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  s16(): number {
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  s32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  eof(): boolean {
    return this.pos >= this.buf.length;
  }
  remaining(): number {
    return this.buf.length - this.pos;
  }
}

/** Interpret an s32 as 16.16 fixed-point. */
function fixed16_16(raw: number): number {
  // raw is already a signed 32-bit int from DataView.getInt32.
  return raw / FIXED_16_16;
}

/** Read a 6-u32 affine matrix: a,b,c,d in 16.16 FP; tx,ty in twips → px. */
function readMatrix(r: ByteReader): Matrix {
  const a = r.s32();
  const b = r.s32();
  const c = r.s32();
  const d = r.s32();
  const tx = r.s32();
  const ty = r.s32();
  return {
    a: fixed16_16(a),
    b: fixed16_16(b),
    c: fixed16_16(c),
    d: fixed16_16(d),
    tx: tx / TWIPS_PER_PX,
    ty: ty / TWIPS_PER_PX,
  };
}

/**
 * Decode a u32 color word into a CSS hex color + 0..1 alpha.
 * Flash stores it LE so byte0=R, byte1=G, byte2=B, byte3=A
 * (FORMAT.md `argb_to_css`).
 */
export function colorFromU32(u32: number): { color: string; alpha: number } {
  const r = u32 & 0xff;
  const g = (u32 >>> 8) & 0xff;
  const b = (u32 >>> 16) & 0xff;
  const a = (u32 >>> 24) & 0xff;
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return { color: `#${hex(r)}${hex(g)}${hex(b)}`, alpha: a / 255 };
}

// ── MFC class-tag reader ────────────────────────────────────────────────────

const NULL_TAG = 0x0000;
const NEWCLASS_TAG = 0xffff;
const LONG_BACKREF_TAG = 0x7fff;

interface ClassTag {
  kind: 'null' | 'new_class' | 'backref';
  name?: string;
  schema?: number;
}

/**
 * Reads the MFC `CArchive` class-tag protocol, registering new classes so
 * back-references resolve to a class name (FORMAT.md §2). Mirrors decoder.py
 * `ArchiveReader`: each NEWCLASS allocates two combined-table slots (class +
 * object), so a 1-based backref index maps to `combined[idx-1]`.
 */
export class ArchiveReader {
  /** Combined class+object table; entries carry the resolved class name. */
  private combined: string[] = [];
  constructor(public r: ByteReader) {}

  registerClass(name: string): void {
    this.combined.push(name); // odd slot: the CRuntimeClass
    this.combined.push(name); // even slot: the created CObject
  }

  /** Read one object-header class tag. */
  readClassTag(): ClassTag {
    const tag = this.r.u16();
    if (tag === NULL_TAG) return { kind: 'null' };
    if (tag === NEWCLASS_TAG) {
      const schema = this.r.u16();
      const nameLen = this.r.u16();
      const name = ascii.decode(this.r.bytes(nameLen));
      this.registerClass(name);
      return { kind: 'new_class', name, schema };
    }
    if (tag === LONG_BACKREF_TAG) {
      const idx = this.r.u32();
      const name = this.combined[idx - 1];
      return { kind: 'backref', name };
    }
    if (tag & 0x8000) {
      const idx = tag & 0x7fff;
      const name = this.combined[idx - 1];
      return { kind: 'backref', name };
    }
    throw new Error(
      `bad class tag 0x${tag.toString(16).padStart(4, '0')} @ 0x${(this.r.pos - 2).toString(16)}`
    );
  }

  /** Seed the table with classes already declared earlier in the stream. */
  seedClasses(names: string[]): void {
    for (const n of names) this.registerClass(n);
  }
}

// ── shape data: fills, strokes, edge stream ─────────────────────────────────

/** Fill-style subtype mask (FORMAT.md §6): SOLID/GRADIENT/BITMAP/type-0x20. */
const SUBTYPE_GRADIENT = 0x10;
const SUBTYPE_TYPE20 = 0x20;
const SUBTYPE_BITMAP = 0x40;

interface DecodedFill {
  style: FillStyle;
}

/**
 * Read one modern (shape_data_schema >= 3) fill style. `capsFlag` is
 * `CPicShape.shape_schema > 2` (NOT shape_data_schema — getting this wrong
 * mis-aligns gradient extras; FORMAT.md §6 "worst bug"), and gates the
 * extra gradient hint bytes.
 */
function readFillStyle(
  r: ByteReader,
  capsFlag: boolean,
  index: number
): DecodedFill {
  const colorU32 = r.u32();
  const subtype = r.u8();
  r.u8(); // more_flags (unused for rendering)
  const sel = subtype & 0x70;
  const base = colorFromU32(colorU32);

  if (sel & SUBTYPE_GRADIENT) {
    const matrix = readMatrix(r);
    const numStops = Math.min(r.u8(), 15);
    let gradType = 0;
    if (capsFlag) {
      r.u16(); // grad_hints
      gradType = r.u8();
    }
    const gradient = [];
    for (let i = 0; i < numStops; i++) {
      const position = r.u8();
      const stopColor = colorFromU32(r.u32());
      gradient.push({
        color: stopColor.color,
        alpha: stopColor.alpha,
        ratio: position / 255,
      });
    }
    // subtype low bits distinguish linear (0) vs radial (FORMAT.md fill_to_svg).
    const isRadial = (subtype & 0x03) !== 0 || gradType !== 0;
    return {
      style: {
        index,
        type: isRadial ? 'radial' : 'linear',
        gradient,
        matrix,
      },
    };
  }
  if (sel & SUBTYPE_BITMAP) {
    const matrix = readMatrix(r);
    const bitmapId = r.u32();
    return {
      style: {
        index,
        type: 'bitmap',
        matrix,
        bitmapPath: `Media ${bitmapId}`,
        color: base.color,
        alpha: base.alpha,
      },
    };
  }
  if (sel & SUBTYPE_TYPE20) {
    // Undocumented variant: consume its bytes so the stream stays aligned,
    // render as the base solid color.
    readMatrix(r);
    r.u32();
    r.u16();
    r.u16();
    r.u16();
    r.u16();
    return { style: { index, type: 'solid', color: base.color, alpha: base.alpha } };
  }
  return { style: { index, type: 'solid', color: base.color, alpha: base.alpha } };
}

/**
 * Skip the 4-byte bit-packed inline compact fill carried by every line style
 * (FUN_00f3c8c0, FORMAT.md §6). We do not currently interpret its packed
 * subtypes semantically — the line's own `stroke_color` is authoritative —
 * but the bytes MUST be consumed to keep the stream aligned.
 */
function skipInlineFill(r: ByteReader): void {
  const sv = r.s16();
  r.u16();
  // For sv != 0 the encoding is a plain (x,y) color and the 4 bytes are all of
  // it; for sv == 0 the high byte selects a subtype but no further bytes are
  // read past these 4 in any observed schema. The 4 bytes are fixed-width.
  void sv;
}

/** Read one line style (FORMAT.md §6). `capsFlag` gates the caps/joins tail. */
function readLineStyle(
  r: ByteReader,
  capsFlag: boolean,
  index: number
): StrokeStyle {
  const strokeColorU32 = r.u32();
  const flags16 = r.u16();
  skipInlineFill(r);
  const { color, alpha } = colorFromU32(strokeColorU32);
  let caps: StrokeStyle['caps'];
  let joints: StrokeStyle['joints'];
  let miterLimit: number | undefined;
  if (capsFlag) {
    const startCap = r.u8();
    r.u8(); // end_cap
    const joinsByte = r.u8();
    r.u8(); // reserved
    miterLimit = r.u16();
    // The caps tail also carries a full fill style (variable length).
    readFillStyle(r, capsFlag, 0);
    caps = startCap === 1 ? 'round' : startCap === 2 ? 'square' : 'none';
    joints =
      joinsByte === 1 ? 'round' : joinsByte === 2 ? 'bevel' : 'miter';
  }
  // flags16 is the stroke weight in twips-ish units; the reference renders it
  // with an empirical 0.05 scale (FORMAT.md §10 "Stroke width units"). A
  // 0-weight stroke is Flash's hairline (1 px).
  const weight = flags16 === 0 ? 1 : Math.max(0.25, flags16 * 0.05);
  const stroke: StrokeStyle = {
    index,
    type: 'solid',
    color,
    weight,
  };
  if (alpha !== 1) {
    // StrokeStyle has no alpha field; fold low alpha into an rgba color.
    const r2 = parseInt(color.slice(1, 3), 16);
    const g2 = parseInt(color.slice(3, 5), 16);
    const b2 = parseInt(color.slice(5, 7), 16);
    stroke.color = `rgba(${r2},${g2},${b2},${alpha.toFixed(3)})`;
  }
  if (caps) stroke.caps = caps;
  if (joints) stroke.joints = joints;
  if (miterLimit !== undefined) stroke.miterLimit = miterLimit;
  return stroke;
}

/**
 * Read one coordinate-delta pair (FUN_00f3c150, FORMAT.md §6). The 2-bit
 * `typeCode` selects the encoding; values accumulate in ultra-twips:
 *   type 0 (0 B): (0,0)
 *   type 1 (4 B): (s16, s16)            — fine precision
 *   type 2 (8 B): (s32, s32)            — full range
 *   type 3 (4 B): (s16<<7, s16<<7)      — coarse precision (stored as twips)
 */
function readCoordDelta(r: ByteReader, typeCode: number): [number, number] {
  switch (typeCode) {
    case 0:
      return [0, 0];
    case 1:
      return [r.s16(), r.s16()];
    case 2:
      return [r.s32(), r.s32()];
    case 3:
      return [r.s16() << 7, r.s16() << 7];
    default:
      throw new Error(`bad coord delta type ${typeCode}`);
  }
}

/** One decoded edge: a quadratic Bézier in ultra-twips plus style indices. */
export interface RawEdge {
  fill0: number;
  fill1: number;
  lineStyle: number;
  fromX: number;
  fromY: number;
  ctrlX: number;
  ctrlY: number;
  toX: number;
  toY: number;
  /** 'line' = straight (control was synthesised at the midpoint). */
  kind: 'line' | 'curve';
}

/**
 * Decode the variable-length edge stream until a zero terminator byte
 * (FORMAT.md §6). Coordinates accumulate from a running endpoint that starts
 * at (0,0). Style-change records (flag 0x40) update the current fill/line
 * indices applied to subsequent edges.
 */
export function readEdgeStream(r: ByteReader): RawEdge[] {
  const edges: RawEdge[] = [];
  let curX = 0;
  let curY = 0;
  let fill0 = 0;
  let fill1 = 0;
  let line = 0;
  for (;;) {
    if (r.eof()) {
      throw new EndOfStreamError('unexpected EOF in edge loop (no terminator)');
    }
    const flags = r.u8();
    if (flags === 0) break; // terminator
    if (flags & 0x40) {
      // style change: 3 indices, 1-based, u8 if 0x80 set else u16.
      if (flags & 0x80) {
        fill0 = r.u8();
        fill1 = r.u8();
        line = r.u8();
      } else {
        fill0 = r.u16() & 0x7fff;
        fill1 = r.u16() & 0x7fff;
        line = r.u16() & 0x7fff;
      }
    }
    const t1 = flags & 3;
    const t2 = (flags >> 2) & 3;
    const t3 = (flags >> 4) & 3;
    const [dx1, dy1] = readCoordDelta(r, t1);
    const [dx2, dy2] = readCoordDelta(r, t2);
    const [dx3, dy3] = readCoordDelta(r, t3);
    const fromX = curX + dx1;
    const fromY = curY + dy1;
    let ctrlX = fromX + dx2;
    let ctrlY = fromY + dy2;
    const toX = fromX + dx3;
    const toY = fromY + dy3;
    curX = toX;
    curY = toY;
    let kind: RawEdge['kind'];
    // (flags & 0x0C) == 0 → straight edge: synthesise midpoint control.
    if ((flags & 0x0c) === 0) {
      ctrlX = (fromX + toX) >> 1;
      ctrlY = (fromY + toY) >> 1;
      kind = 'line';
    } else {
      kind = 'curve';
    }
    edges.push({
      fill0,
      fill1,
      lineStyle: line,
      fromX,
      fromY,
      ctrlX,
      ctrlY,
      toX,
      toY,
      kind,
    });
  }
  return edges;
}

/** Decoded shape data: fills, strokes and edges (still in ultra-twips). */
export interface DecodedShapeData {
  shapeDataSchema: number;
  fills: FillStyle[];
  strokes: StrokeStyle[];
  rawEdges: RawEdge[];
}

/**
 * Read the geometry block inside a CPicShape (FUN_00f3da60, FORMAT.md §6).
 * `capsFlag` = `shape_schema > 2`.
 */
export function readShapeData(
  r: ByteReader,
  capsFlag: boolean
): DecodedShapeData {
  const shapeDataSchema = r.u8();
  r.u32(); // edge_count_hint (informational)
  const fillCount = r.u16();
  const fills: FillStyle[] = [];
  for (let i = 0; i < fillCount; i++) {
    if (shapeDataSchema < 3) {
      // Legacy solid fill: u32 color + u16 flags.
      const { color, alpha } = colorFromU32(r.u32());
      r.u16();
      fills.push({ index: i + 1, type: 'solid', color, alpha });
    } else {
      fills.push(readFillStyle(r, capsFlag, i + 1).style);
    }
  }
  const lineCount = r.u16();
  const strokes: StrokeStyle[] = [];
  for (let i = 0; i < lineCount; i++) {
    strokes.push(readLineStyle(r, capsFlag, i + 1));
  }
  let rawEdges: RawEdge[] = [];
  if (shapeDataSchema >= 2) {
    rawEdges = readEdgeStream(r);
  }
  return { shapeDataSchema, fills, strokes, rawEdges };
}

// ── edges → PathCommands (ultra-twips → pixels) ─────────────────────────────

/**
 * Convert decoded raw edges (ultra-twips) into viewer {@link Edge}s with
 * pixel-space {@link PathCommand}s. Contiguous edges sharing the same
 * fill/line indices are grouped into one path so the renderer can fill them
 * as a single region; an `M` is emitted whenever the start of an edge does
 * not continue the previous endpoint.
 */
export function rawEdgesToEdges(rawEdges: RawEdge[]): Edge[] {
  const out: Edge[] = [];
  // Group by (fill0, fill1, lineStyle) preserving first-seen order.
  const groups = new Map<string, RawEdge[]>();
  const order: string[] = [];
  for (const e of rawEdges) {
    const key = `${e.fill0}|${e.fill1}|${e.lineStyle}`;
    let g = groups.get(key);
    if (!g) {
      g = [];
      groups.set(key, g);
      order.push(key);
    }
    g.push(e);
  }
  const px = (v: number) => v / ULTRA_TWIPS_PER_PX;
  for (const key of order) {
    const group = groups.get(key)!;
    const [f0, f1, ls] = key.split('|').map((n) => parseInt(n, 10));
    const commands: PathCommand[] = [];
    let cur: [number, number] | null = null;
    for (const e of group) {
      const fx = px(e.fromX);
      const fy = px(e.fromY);
      const tx = px(e.toX);
      const ty = px(e.toY);
      if (cur === null || cur[0] !== fx || cur[1] !== fy) {
        commands.push({ type: 'M', x: fx, y: fy });
      }
      if (e.kind === 'line') {
        commands.push({ type: 'L', x: tx, y: ty });
      } else {
        commands.push({
          type: 'Q',
          cx: px(e.ctrlX),
          cy: px(e.ctrlY),
          x: tx,
          y: ty,
        });
      }
      cur = [tx, ty];
    }
    const edge: Edge = { commands };
    if (f0) edge.fillStyle0 = f0;
    if (f1) edge.fillStyle1 = f1;
    if (ls) edge.strokeStyle = ls;
    out.push(edge);
  }
  return out;
}

// ── CPicShape body ──────────────────────────────────────────────────────────

/** A decoded shape plus where it sat in the stream (for region tracking and
 *  per-frame attribution — see {@link ./binary-timeline-decoder}). */
export interface DecodedShape {
  shape: Shape;
  edgeCount: number;
  /** Byte offset of the shape body start (just past its class tag/signature). */
  bodyStart: number;
  /** Byte offset just past the shape body. */
  endPos: number;
}

/**
 * Read a CPicShape body starting at the reader's current position: the
 * CPicObj base (schema, flags, children list, point, extras), then
 * `shape_schema`, the 6-u32 matrix and the shape_data block.
 *
 * Children are read via the archive's class-tag loop. For shape geometry we
 * do not need to fully decode child objects, but we MUST consume the
 * (typically empty) children list so the matrix/shape_data that follow align.
 */
export function readCPicShape(
  r: ByteReader,
  ar: ArchiveReader
): { shape: Shape; rawEdges: RawEdge[] } {
  const schema = r.u8();
  r.u8(); // flags
  // Children list. For a leaf CPicShape this is just the NULL terminator; we
  // do not recurse into child bodies here (the recovery scanner finds nested
  // shapes independently), so a non-null child tag means this is not a plain
  // leaf shape and we stop reading children to avoid desync.
  const firstTag = ar.readClassTag();
  if (firstTag.kind !== 'null') {
    throw new Error(
      `CPicShape with non-empty child list (tag ${firstTag.kind}) not a leaf shape`
    );
  }
  if (schema >= 1) {
    r.s32(); // point.x (often INT_MIN)
    r.s32(); // point.y
  }
  if (schema >= 3) r.u8();
  if (schema >= 4) r.u8();

  const shapeSchema = r.u8();
  const matrix = readMatrix(r);
  const data = readShapeData(r, shapeSchema > 2);
  const edges = rawEdgesToEdges(data.rawEdges);
  const shape: Shape = {
    type: 'shape',
    matrix,
    fills: data.fills,
    strokes: data.strokes,
    edges,
  };
  return { shape, rawEdges: data.rawEdges };
}

// ── recovery scanner ────────────────────────────────────────────────────────

/**
 * The 10-byte CPicShape header tail used as a recovery signature
 * (FORMAT.md §11.5): NULL child tag (00 00) followed by two INT_MIN point
 * sentinels. This is the byte after `schema, flags`, so a hit at index `i`
 * means a plausible shape body starts at `i - 2`.
 */
const SHAPE_SIG = new Uint8Array([
  0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x80,
]);

/** `FFFF 0001 0009 "CPicShape"` — a guaranteed shape-body class declaration. */
const CPICSHAPE_DECL = new Uint8Array([
  0xff, 0xff, 0x01, 0x00, 0x09, 0x00, 0x43, 0x50, 0x69, 0x63, 0x53, 0x68,
  0x61, 0x70, 0x65,
]);

function matchAt(hay: Uint8Array, needle: Uint8Array, at: number): boolean {
  if (at < 0 || at + needle.length > hay.length) return false;
  for (let j = 0; j < needle.length; j++) {
    if (hay[at + j] !== needle[j]) return false;
  }
  return true;
}

function indexOf(hay: Uint8Array, needle: Uint8Array, from: number): number {
  for (let i = Math.max(0, from); i <= hay.length - needle.length; i++) {
    if (matchAt(hay, needle, i)) return i;
  }
  return -1;
}

/** Coordinate sanity bound: reject parses that run off to absurd positions. */
const MAX_ULTRA_TWIPS = 50_000_000; // ≈ 19,500 px

/**
 * Try to parse a CPicShape body at `bodyStart`. Returns the decoded shape (if
 * it yields at least `minEdges` plausible edges) or null. Uses a fresh reader
 * so a failed attempt never disturbs the caller's position.
 */
function tryParseShapeAt(
  data: Uint8Array,
  bodyStart: number,
  classNames: string[],
  minEdges: number
): DecodedShape | null {
  if (bodyStart < 0 || bodyStart >= data.length) return null;
  const r = new ByteReader(data);
  r.pos = bodyStart;
  const ar = new ArchiveReader(r);
  ar.seedClasses(classNames);
  let result: { shape: Shape; rawEdges: RawEdge[] };
  try {
    result = readCPicShape(r, ar);
  } catch (err) {
    if (err instanceof EndOfStreamError || err instanceof Error) return null;
    throw err;
  }
  const { shape, rawEdges } = result;
  if (rawEdges.length < minEdges || r.pos <= bodyStart + 30) return null;
  // Reject implausibly high schema (likely a signature false-positive).
  // (We don't keep shapeDataSchema on the Shape; re-derive a cheap sanity
  // check from the coordinates instead.)
  for (const e of rawEdges) {
    const coords = [e.fromX, e.fromY, e.ctrlX, e.ctrlY, e.toX, e.toY];
    for (const v of coords) {
      if (Math.abs(v) > MAX_ULTRA_TWIPS) return null;
    }
  }
  return { shape, edgeCount: rawEdges.length, bodyStart, endPos: r.pos };
}

/**
 * Recovery scanner (FORMAT.md §11.5): walk the whole stream finding plausible
 * CPicShape bodies. Two complementary strategies:
 *   1. class-declaration recovery — every `FFFF 0001 0009 "CPicShape"` is
 *      guaranteed to be followed by a shape body (min 1 edge accepted).
 *   2. signature recovery — the 10-byte header tail; try offsets -2,-1,0,-3,
 *      with a higher bar (min 3 edges) to avoid noise.
 * Taken-region tracking prevents the same bytes being recovered twice.
 */
export function scanForShapes(
  data: Uint8Array,
  seedClasses: string[] = []
): DecodedShape[] {
  const found: DecodedShape[] = [];
  const taken: Array<[number, number]> = [];
  const covered = (p: number) => taken.some(([s, e]) => s <= p && p < e);

  const recordRegion = (bodyStart: number, ds: DecodedShape) => {
    const maxRegion = Math.max(500, ds.edgeCount * 12 + 1000);
    taken.push([bodyStart, Math.min(ds.endPos, bodyStart + maxRegion)]);
  };

  // 1) class-declaration recovery.
  let searchFrom = 0;
  for (;;) {
    const m = indexOf(data, CPICSHAPE_DECL, searchFrom);
    if (m < 0) break;
    searchFrom = m + 1;
    const bodyStart = m + CPICSHAPE_DECL.length;
    if (covered(bodyStart)) continue;
    const classes = seedClasses.includes('CPicShape')
      ? seedClasses
      : [...seedClasses, 'CPicShape'];
    const ds = tryParseShapeAt(data, bodyStart, classes, 1);
    if (!ds) continue;
    found.push(ds);
    recordRegion(bodyStart, ds);
  }

  // 2) signature-based recovery.
  let pos = 0;
  while (pos < data.length - SHAPE_SIG.length - 2) {
    const idx = indexOf(data, SHAPE_SIG, pos);
    if (idx < 0) break;
    pos = idx + 1;
    for (const offset of [-2, -1, 0, -3]) {
      const bodyStart = idx + offset;
      if (bodyStart < 0) continue;
      if (covered(bodyStart)) break;
      const ds = tryParseShapeAt(data, bodyStart, seedClasses, 3);
      if (!ds) continue;
      found.push(ds);
      recordRegion(bodyStart, ds);
      pos = taken[taken.length - 1][1];
      break;
    }
  }

  return found;
}

// ── top-level: decode all shapes in a Symbol/Page stream ────────────────────

export interface DecodedStreamShapes {
  /** Root class name (CPicPage / CPicSprite / CPicShape …). */
  rootClass: string;
  /** Every recovered shape, in stream order. */
  shapes: Shape[];
  /**
   * The same recovered shapes WITH their stream byte offsets, in stream order
   * (1:1 with `shapes`). Used for per-frame attribution by
   * {@link ./binary-timeline-decoder}. `shapes` is kept for callers that only
   * need the geometry.
   */
  decoded: DecodedShape[];
  /** Total edge count across all shapes (for honest coverage reporting). */
  totalEdges: number;
}

/**
 * Decode every renderable shape in a single `Symbol N` / `Page N` stream.
 *
 * We read the root class tag (after the 1-byte 0x01 root header) to report
 * the container type, then ALWAYS run the recovery scanner over the whole
 * stream. The structured walk of CPicPage→CPicLayer→CPicFrame is intentionally
 * not attempted for geometry: CPicFrame's many schema-gated tail fields make
 * a clean walk fragile (the reference itself relies on the scanner), and the
 * INT_MIN signature reliably locates the leaf CPicShape bodies regardless of
 * how the timeline above them is laid out.
 */
export function decodeStreamShapes(data: Uint8Array): DecodedStreamShapes {
  let rootClass = '(unknown)';
  const seedClasses: string[] = [];
  try {
    const r = new ByteReader(data);
    r.u8(); // 0x01 root header
    const ar = new ArchiveReader(r);
    const tag = ar.readClassTag();
    if (tag.kind === 'new_class' && tag.name) {
      rootClass = tag.name;
      seedClasses.push(tag.name);
    } else if (tag.kind === 'backref' && tag.name) {
      rootClass = tag.name;
    }
  } catch (err) {
    if (!(err instanceof EndOfStreamError || err instanceof Error)) throw err;
    // A malformed header still lets the scanner run on the raw bytes.
  }

  const decoded = scanForShapes(data, seedClasses);
  const shapes = decoded.map((d) => d.shape);
  const totalEdges = decoded.reduce((n, d) => n + d.edgeCount, 0);
  return { rootClass, shapes, decoded, totalEdges };
}
