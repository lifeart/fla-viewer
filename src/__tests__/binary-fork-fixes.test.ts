import { describe, it, expect, vi, afterEach } from 'vitest';
// Regression tests for the binary (pre-CS5) FLA fixes ported in 8a0a370 from
// liangforstudy/fla-viewer-fix. Section numbers (§N) refer to
// docs/binary-fla-fixes.md. Every input here is a small SYNTHETIC byte buffer
// (or a synthetic CFB container built by `buildCFB` below), shaped after the
// byte layouts that document describes. Each test is written so that it fails
// on the pre-fix behaviour named in its comment.
import mp3Url from './fixtures/mp3-sound.mp3?url';
import {
  ArchiveReader,
  ByteReader,
  edgeUnitsPerPx,
  readCPicShape,
  readShapeData,
  ULTRA_TWIPS_PER_PX,
} from '../binary-shape-decoder';
import { decodeStreamTimeline } from '../binary-timeline-decoder';
import { extractBinaryFLAInfo, parseBinaryFLA } from '../binary-fla-parser';
import { FLAParser } from '../fla-parser';
import { FLARenderer } from '../renderer';
import { OLE2File } from '../ole2-reader';
import type { Edge, Frame, Shape } from '../types';

// ── little-endian byte builders ─────────────────────────────────────────────
const u8 = (...v: number[]): number[] => v.map((n) => n & 0xff);
const u16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
const s16 = (v: number): number[] => u16(v < 0 ? v + 0x10000 : v);
const u32 = (v: number): number[] => [
  v & 0xff,
  (v >> 8) & 0xff,
  (v >> 16) & 0xff,
  (v >>> 24) & 0xff,
];
const s32 = (v: number): number[] => u32(v < 0 ? v + 0x100000000 : v);

const NEWCLASS = [0xff, 0xff];
const NULL_TAG = [0x00, 0x00];
const INT_MIN = s32(-0x80000000);
const SENTINEL = [...NULL_TAG, ...INT_MIN, ...INT_MIN];
const IDENTITY = [
  ...u32(0x10000),
  ...u32(0),
  ...u32(0),
  ...u32(0x10000),
  ...u32(0),
  ...u32(0),
];

const decl = (name: string, schema = 1): number[] => [
  ...NEWCLASS,
  ...u16(schema),
  ...u16(name.length),
  ...[...name].map((c) => c.charCodeAt(0)),
];
const backref = (idx: number): number[] => u16(0x8000 | idx);
const utf16 = (s: string): number[] => {
  const out: number[] = [];
  for (const ch of s) out.push(ch.charCodeAt(0) & 0xff, (ch.charCodeAt(0) >> 8) & 0xff);
  return out;
};
/** Flash CString: FF FE FF <u8 charLen> <UTF-16LE>. */
const flashStr = (s: string): number[] => [0xff, 0xfe, 0xff, s.length, ...utf16(s)];

// ── synthetic timeline streams (layout as in scripts/make-timeline-fixture.mjs)

/** A legacy (shape_data_schema 2) filled square: 4 edges, fill1 = 1. */
function squareShapeData(sizePx: number): number[] {
  const sz = sizePx * ULTRA_TWIPS_PER_PX;
  const d = (dx: number, dy: number) => [...s32(dx), ...s32(dy)];
  const out: number[] = [];
  out.push(...u8(2), ...u32(0), ...u16(1)); // schema 2, edge hint, 1 fill
  out.push(...u32(0xff00ff00), ...u16(0)); // legacy solid green
  out.push(...u16(0)); // no line styles
  out.push(...u8(0x62), ...u16(0), ...u16(1), ...u16(0)); // style change (line 0, fill1 1, fill0 0)
  out.push(...d(0, 0), ...d(sz, 0));
  for (const [dx, dy] of [
    [0, sz],
    [-sz, 0],
    [0, -sz],
  ]) {
    out.push(...u8(0x22), ...d(0, 0), ...d(dx, dy));
  }
  out.push(...u8(0)); // edge terminator
  return out;
}

/** A CPicShape body (shape_schema 2) placed at (txPx, tyPx). */
function shapeBody(txPx: number, tyPx = 100, sizePx = 40): number[] {
  return [
    ...u8(2, 0),
    ...NULL_TAG,
    ...INT_MIN,
    ...INT_MIN,
    ...u8(2), // shape_schema
    ...u32(0x10000),
    ...u32(0),
    ...u32(0),
    ...u32(0x10000),
    ...s32(txPx * 20),
    ...s32(tyPx * 20),
    ...squareShapeData(sizePx),
  ];
}

interface FrameSpec {
  span: number;
  /** x of the square placed in this keyframe; omitted = empty keyframe. */
  x?: number;
  field188?: number;
  field190?: number;
  soundRef?: number;
}
interface LayerSpec {
  name: string;
  frames: FrameSpec[];
}

/**
 * A `Page N` stream: CPicPage → CPicLayer* → CPicFrame* (frame_schema 19).
 * Combined class table: CPicPage 1/2, CPicLayer 3/4, CPicFrame 5/6, CPicShape
 * 7/8 — classes are declared on first use and back-referenced afterwards, so a
 * second layer begins with the `03 80` back-ref to CPicLayer (§2).
 * `trailing` bytes are appended after the page terminator.
 */
function pageStream(layers: LayerSpec[], trailing: number[] = []): Uint8Array {
  const out: number[] = [0x01, ...decl('CPicPage'), ...u8(2, 0)];
  let frameDeclared = false;
  let shapeDeclared = false;
  layers.forEach((layer, li) => {
    out.push(...(li === 0 ? decl('CPicLayer') : backref(3)));
    out.push(...u8(2, 0)); // layer CPicObj base
    for (const f of layer.frames) {
      out.push(...(frameDeclared ? backref(5) : decl('CPicFrame')));
      frameDeclared = true;
      out.push(...u8(2, 0)); // frame CPicObj base
      if (f.x !== undefined) {
        out.push(...(shapeDeclared ? backref(7) : decl('CPicShape')));
        shapeDeclared = true;
        out.push(...shapeBody(f.x));
      }
      out.push(...NULL_TAG, ...INT_MIN, ...INT_MIN); // end children + point
      // The frame's own (empty) canvas shape.
      out.push(...u8(2), ...IDENTITY, ...u8(2), ...u32(0), ...u16(0), ...u16(0), ...u8(0));
      // CPicFrame tail, frame_schema 19.
      out.push(...u8(19), ...u16(f.span));
      out.push(...u16(f.field188 ?? 0x0600)); // field_188
      out.push(...s16(f.field190 ?? 0)); // field_190
      out.push(...u16(f.soundRef ?? 0)); // sound ref
      out.push(...u16(0)); // entry count
      out.push(...u16(0), ...u8(0), ...u32(0), ...s32(0), ...u16(0));
      out.push(...u32(0), ...u32(2)); // timeline sub-object
      out.push(...u32(0), ...u32(0), ...u32(0), ...u16(0), ...u32(0), ...u16(0));
    }
    out.push(...NULL_TAG, ...INT_MIN, ...INT_MIN); // end layer children + point
    out.push(...u8(11), ...flashStr(layer.name)); // layer_schema 11 + name
    out.push(...u8(0, 0, 0)); // current, locked, hidden
    out.push(...u32(0xffffffff), ...u32(0), ...u32(0), ...u32(0));
    out.push(...u8(0), ...NULL_TAG, ...u8(0), ...u8(0)); // mode, parent, >=9, >=10
  });
  out.push(...SENTINEL, ...u8(2), ...NULL_TAG); // page terminator
  out.push(...trailing);
  return Uint8Array.from(out);
}

// ── synthetic `Contents` stream pieces ──────────────────────────────────────

/**
 * Doc props: 100-byte lead-in, an optional stage rect (4×s32 twips) exactly 53
 * bytes before the background colour (§7), the colour record (RGBA, RGBA, u16
 * 0, u16 fps), then any `extra` bytes (publish strings, sound records).
 */
function contentsStream(opts: {
  rect?: [number, number, number, number];
  rgb?: [number, number, number];
  fps?: number;
  extra?: number[];
}): Uint8Array {
  const out: number[] = new Array(100).fill(0);
  if (opts.rect) out.push(...opts.rect.flatMap((v) => s32(v)));
  else out.push(...new Array(16).fill(0));
  out.push(...new Array(53 - 16).fill(0));
  const [r, g, b] = opts.rgb ?? [255, 255, 255];
  out.push(...u8(r, g, b, 255), ...u8(0, 0, 0, 255), ...u16(0), ...u16(opts.fps ?? 24));
  out.push(...new Array(16).fill(0));
  out.push(...(opts.extra ?? []));
  return Uint8Array.from(out);
}

const publishSize = (w: number, h: number): number[] => [
  ...flashStr('PublishHtmlProperties::Width'),
  ...flashStr(String(w)),
  ...flashStr('PublishHtmlProperties::Height'),
  ...flashStr(String(h)),
];

/** A CMediaSound record (§12): stream name, display name, footer. */
const soundRecord = (
  mediaNumber: number,
  name: string,
  format: number,
  sampleCount: number
): number[] => {
  const stream = `Media ${mediaNumber}`;
  return [
    stream.length,
    ...utf16(stream),
    ...flashStr(name),
    ...u8(0x01, 0x02, 0x03), // unrelated record bytes before the footer
    ...u8(0x00, 0x0a, format, 0x00),
    ...u32(sampleCount),
    ...new Array(8).fill(0x11),
  ];
};

// ── minimal CFB v3 writer (port of scripts/make-timeline-fixture.mjs) ───────
// Streams shorter than the 4096-byte mini cutoff are zero-padded (no mini-FAT
// is written); longer streams keep their exact size.
function buildCFB(streams: { name: string; data: Uint8Array }[]): Uint8Array {
  const SECTOR = 512;
  const ENDOFCHAIN = 0xfffffffe;
  const FREESECT = 0xffffffff;
  const NOSTREAM = 0xffffffff;
  const FATSECT = 0xfffffffd;
  const entries: { name: string; type: number; data: Uint8Array }[] = [
    { name: 'Root Entry', type: 5, data: new Uint8Array(0) },
  ];
  for (const s of streams) {
    let data = s.data;
    if (data.length < 4096) {
      const p = new Uint8Array(4096);
      p.set(data);
      data = p;
    }
    entries.push({ name: s.name, type: 2, data });
  }
  const sectors: Uint8Array[] = [];
  const fat: number[] = [];
  const allocChain = (data: Uint8Array): number => {
    if (data.length === 0) return ENDOFCHAIN;
    const first = sectors.length;
    const n = Math.ceil(data.length / SECTOR);
    for (let i = 0; i < n; i++) {
      const sec = new Uint8Array(SECTOR);
      sec.set(data.subarray(i * SECTOR, (i + 1) * SECTOR));
      sectors.push(sec);
      fat.push(sectors.length);
    }
    fat[first + n - 1] = ENDOFCHAIN;
    return first;
  };
  const starts = entries.map((e) => (e.type === 2 ? allocChain(e.data) : ENDOFCHAIN));
  const dirBytes: number[] = [];
  entries.forEach((e, i) => {
    const ent = new Uint8Array(128);
    for (let j = 0; j < e.name.length; j++) {
      ent[j * 2] = e.name.charCodeAt(j) & 0xff;
      ent[j * 2 + 1] = (e.name.charCodeAt(j) >> 8) & 0xff;
    }
    const nameLen = (e.name.length + 1) * 2;
    ent[64] = nameLen & 0xff;
    ent[65] = nameLen >> 8;
    ent[66] = e.type;
    ent[67] = 1;
    const w32 = (off: number, v: number) => ent.set(u32(v), off);
    w32(68, NOSTREAM);
    w32(72, NOSTREAM);
    w32(76, NOSTREAM);
    if (i === 0) {
      w32(76, entries.length > 1 ? 1 : NOSTREAM);
      w32(116, ENDOFCHAIN);
      w32(120, 0);
    } else {
      if (i + 1 < entries.length) w32(72, i + 1);
      w32(116, starts[i]);
      w32(120, e.data.length);
    }
    dirBytes.push(...ent);
  });
  while (dirBytes.length % SECTOR !== 0) dirBytes.push(0);
  const dirStart = allocChain(Uint8Array.from(dirBytes));
  let fatSectorCount = 1;
  for (;;) {
    const needed = Math.ceil((sectors.length + fatSectorCount) / (SECTOR / 4));
    if (needed === fatSectorCount) break;
    fatSectorCount = needed;
  }
  const fatStart = sectors.length;
  for (let i = 0; i < fatSectorCount; i++) {
    sectors.push(new Uint8Array(SECTOR));
    fat.push(FATSECT);
  }
  while (fat.length % (SECTOR / 4) !== 0) fat.push(FREESECT);
  fat.forEach((v, i) => {
    sectors[fatStart + Math.floor(i / (SECTOR / 4))].set(u32(v), (i % (SECTOR / 4)) * 4);
  });
  const header = new Uint8Array(SECTOR);
  header.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  header.set(u16(0x3e), 0x18);
  header.set(u16(3), 0x1a);
  header.set(u16(0xfffe), 0x1c);
  header.set(u16(9), 0x1e);
  header.set(u16(6), 0x20);
  header.set(u32(fatSectorCount), 0x2c);
  header.set(u32(dirStart), 0x30);
  header.set(u32(4096), 0x38);
  header.set(u32(ENDOFCHAIN), 0x3c);
  header.set(u32(0), 0x40);
  header.set(u32(ENDOFCHAIN), 0x44);
  header.set(u32(0), 0x48);
  for (let i = 0; i < 109; i++) {
    header.set(u32(i < fatSectorCount ? fatStart + i : FREESECT), 0x4c + i * 4);
  }
  const total = new Uint8Array(SECTOR + sectors.length * SECTOR);
  total.set(header, 0);
  sectors.forEach((s, i) => total.set(s, SECTOR + i * SECTOR));
  return total;
}

/** tx of every shape element in a frame list, flattened. */
const shapeTxs = (frames: Frame[]): number[] =>
  frames.flatMap((f) =>
    f.elements.filter((e): e is Shape => e.type === 'shape').map((s) => s.matrix.tx)
  );

afterEach(() => {
  vi.restoreAllMocks();
});

// ── §2 layer walk ───────────────────────────────────────────────────────────

describe('§2 layer walk keeps layers after the first', () => {
  it('ArchiveReader.peekBackrefName resolves a back-ref without consuming it', () => {
    const r = new ByteReader(Uint8Array.from([0x03, 0x80, 0xff, 0xff, 0x00, 0x00]));
    const ar = new ArchiveReader(r);
    ar.seedClasses(['CPicPage', 'CPicLayer']); // combined slots 1/2, 3/4
    expect(ar.peekBackrefName()).toBe('CPicLayer');
    expect(r.pos).toBe(0); // not consumed
    expect(ar.readClassTag()).toEqual({ kind: 'backref', name: 'CPicLayer' });
    expect(ar.peekBackrefName()).toBeUndefined(); // FF FF = NEWCLASS
    r.pos = 4;
    expect(ar.peekBackrefName()).toBeUndefined(); // 00 00 = NULL
    r.pos = 6;
    expect(ar.peekBackrefName()).toBeUndefined(); // end of buffer
  });

  it('decodes every layer of a multi-layer page (the end-marker scan used to drop them)', () => {
    // Pre-fix: after layer 1 the reader jumped to the LAST sentinel in the
    // stream (the page terminator), so only 'Layer 1' was returned.
    const data = pageStream([
      { name: 'Layer 1', frames: [{ span: 1, x: 40 }, { span: 2, x: 140 }] },
      { name: 'Layer 2', frames: [{ span: 3, x: 240 }] },
      { name: 'Layer 10', frames: [{ span: 1, x: 340 }, { span: 1, x: 440 }] },
    ]);
    const tl = decodeStreamTimeline(data);
    expect(tl).not.toBeNull();
    expect(tl!.layers.map((l) => l.name)).toEqual(['Layer 1', 'Layer 2', 'Layer 10']);
    expect(tl!.layers.map((l) => l.keyframes.map((k) => k.duration))).toEqual([
      [1, 2],
      [3],
      [1, 1],
    ]);
    expect(tl!.totalFrames).toBe(3);
  });
});

// ── §3 orphan content ───────────────────────────────────────────────────────

describe('§3 orphan content is placed once, on the first drawn layer', () => {
  it('does not copy one layer’s content onto another; true orphans land once', () => {
    // 'Bottom' (stored first) has squares at x=40,140; 'Top' at x=240. A fourth
    // square (x=340) sits after the page terminator, outside every keyframe.
    // Pre-fix each layer treated the OTHER layer's squares as its own orphans
    // and put them (plus the real orphan) on its first frame.
    const page = pageStream(
      [
        { name: 'Bottom', frames: [{ span: 1, x: 40 }, { span: 1, x: 140 }] },
        { name: 'Top', frames: [{ span: 2, x: 240 }] },
      ],
      [...new Array(16).fill(0x11), ...shapeBody(340)]
    );
    const doc = parseBinaryFLA(
      buildCFB([
        { name: 'Contents', data: contentsStream({}) },
        { name: 'Page 1', data: page },
      ])
    );
    const scene = doc.timelines[0];
    // Top-first order (§4): stored-first 'Bottom' is last.
    expect(scene.layers.map((l) => l.name)).toEqual(['Top', 'Bottom']);
    const [top, bottom] = scene.layers;
    expect(shapeTxs(top.frames)).toEqual([240]);
    expect(shapeTxs([bottom.frames[0]]).sort((a, b) => a - b)).toEqual([40, 340]);
    expect(shapeTxs([bottom.frames[1]])).toEqual([140]);
    // Every square appears exactly once across the whole timeline.
    const all = scene.layers.flatMap((l) => shapeTxs(l.frames)).sort((a, b) => a - b);
    expect(all).toEqual([40, 140, 240, 340]);
  });

  it('skips a guide or folder layer when choosing where orphans go', () => {
    // (Two keyframes on 'Art' so the walk counts as animated and attributes.)
    // Stored first is a guide (a reference layer, never drawn): the orphan
    // must go on the next drawn layer or it would disappear.
    const page = pageStream(
      [
        { name: 'Guide: path', frames: [{ span: 1, x: 40 }] },
        { name: 'Art', frames: [{ span: 1, x: 240 }, { span: 1, x: 140 }] },
      ],
      [...new Array(16).fill(0x11), ...shapeBody(340)]
    );
    const doc = parseBinaryFLA(
      buildCFB([
        { name: 'Contents', data: contentsStream({}) },
        { name: 'Page 1', data: page },
      ])
    );
    const scene = doc.timelines[0];
    expect(scene.layers.map((l) => l.name)).toEqual(['Art', 'Guide: path']);
    expect(scene.referenceLayers.has(1)).toBe(true);
    expect(shapeTxs([scene.layers[0].frames[0]]).sort((a, b) => a - b)).toEqual([240, 340]);
    expect(shapeTxs([scene.layers[0].frames[1]])).toEqual([140]);
    expect(shapeTxs(scene.layers[1].frames)).toEqual([40]);
  });

  it('adds a drawn layer for orphans when every layer is a guide or folder', () => {
    const page = pageStream(
      [{ name: 'Guide: path', frames: [{ span: 1, x: 40 }, { span: 1, x: 140 }] }],
      [...new Array(16).fill(0x11), ...shapeBody(340)]
    );
    const doc = parseBinaryFLA(
      buildCFB([
        { name: 'Contents', data: contentsStream({}) },
        { name: 'Page 1', data: page },
      ])
    );
    const scene = doc.timelines[0];
    expect(scene.layers.map((l) => l.name)).toEqual(['Guide: path', 'Recovered Content']);
    expect([...scene.referenceLayers]).toEqual([0]);
    expect(shapeTxs(scene.layers[1].frames)).toEqual([340]);
    expect(shapeTxs(scene.layers[0].frames).sort((a, b) => a - b)).toEqual([40, 140]);
  });

  it('treats only default "Folder N" names as folders', () => {
    const page = pageStream([
      { name: 'Folder art', frames: [{ span: 1, x: 40 }, { span: 1, x: 140 }] },
      { name: 'Folder 3', frames: [{ span: 2 }] },
    ]);
    const doc = parseBinaryFLA(
      buildCFB([
        { name: 'Contents', data: contentsStream({}) },
        { name: 'Page 1', data: page },
      ])
    );
    const scene = doc.timelines[0];
    expect(scene.layers.map((l) => [l.name, l.layerType])).toEqual([
      ['Folder 3', 'folder'],
      ['Folder art', 'normal'],
    ]);
    expect([...scene.referenceLayers]).toEqual([0]);
  });
});

// ── §6 edge units ───────────────────────────────────────────────────────────

describe('§6 edge units per px depend on shape_schema', () => {
  /** A CPicShape body with one straight edge to (10*5120, 4*5120) raw units. */
  const body = (shapeSchema: number) =>
    Uint8Array.from([
      ...u8(2, 0),
      ...NULL_TAG,
      ...INT_MIN,
      ...INT_MIN,
      ...u8(shapeSchema),
      ...IDENTITY,
      ...u8(5), // shape_data_schema
      ...u32(1),
      ...u16(0), // fills
      ...u16(0), // lines
      ...u8(0x20),
      ...s32(10 * 5120),
      ...s32(4 * 5120),
      ...u8(0),
    ]);

  it('edgeUnitsPerPx: 5120 for shape_schema > 2, 2560 otherwise', () => {
    expect(edgeUnitsPerPx(1)).toBe(2560);
    expect(edgeUnitsPerPx(2)).toBe(2560);
    expect(edgeUnitsPerPx(3)).toBe(5120);
    expect(edgeUnitsPerPx(4)).toBe(5120);
  });

  it('readCPicShape halves Flash 8 (shape_schema 3) coordinates vs MX 2004 (schema 2)', () => {
    const r8 = new ByteReader(body(3));
    const flash8 = readCPicShape(r8, new ArchiveReader(r8)).shape;
    // Pre-fix: 2560 units/px for every schema → (20, 8), 2× too large.
    expect(flash8.edges[0].commands).toEqual([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 10, y: 4 },
    ]);
    const r7 = new ByteReader(body(2));
    const mx2004 = readCPicShape(r7, new ArchiveReader(r7)).shape;
    expect(mx2004.edges[0].commands[1]).toEqual({ type: 'L', x: 20, y: 8 });
  });

  it('marks binary shapes exactEdges (§10 opt-in)', () => {
    const r = new ByteReader(body(3));
    expect(readCPicShape(r, new ArchiveReader(r)).shape.exactEdges).toBe(true);
  });
});

// ── §7 stage size ───────────────────────────────────────────────────────────

describe('§7 stage size from the twips rect 53 bytes before the background colour', () => {
  const info = (contents: Uint8Array) =>
    extractBinaryFLAInfo(buildCFB([{ name: 'Contents', data: contents }]));

  it('prefers the stage rect over stale publish-setting strings', () => {
    // Pre-fix: width/height came from the publish strings (550×400).
    const i = info(
      contentsStream({
        rect: [0, 720 * 20, 0, 480 * 20],
        rgb: [0x33, 0x66, 0x99],
        fps: 24,
        extra: publishSize(550, 400),
      })
    );
    expect([i.width, i.height]).toEqual([720, 480]);
    expect(i.backgroundColor).toBe('#336699');
    expect(i.frameRate).toBe(24);
  });

  it('falls back to the publish settings when there is no valid rect', () => {
    const i = info(contentsStream({ extra: publishSize(640, 360) }));
    expect([i.width, i.height]).toEqual([640, 360]);
  });

  it('rejects a rect with a non-zero origin or a fractional-pixel size', () => {
    const offset = info(
      contentsStream({ rect: [20, 720 * 20, 0, 480 * 20], extra: publishSize(640, 360) })
    );
    expect([offset.width, offset.height]).toEqual([640, 360]);
    const fractional = info(
      contentsStream({ rect: [0, 720 * 20 + 7, 0, 480 * 20], extra: publishSize(640, 360) })
    );
    expect([fractional.width, fractional.height]).toEqual([640, 360]);
  });

  it('falls back to Flash defaults (550×400) with neither source', () => {
    const i = info(contentsStream({}));
    expect([i.width, i.height]).toEqual([550, 400]);
  });
});

// ── §9 Flash 8 gradient bytes ───────────────────────────────────────────────

describe('§9 gradient fills skip 5 extra bytes when shape_data_schema >= 5', () => {
  const RED = 0xff0000ff; // bytes R,G,B,A = ff,00,00,ff
  const YELLOW = 0xff00ffff;
  const BLUE = 0xffff0000;

  const shapeData = (schema: number, extraGradientBytes: number) =>
    Uint8Array.from([
      ...u8(schema),
      ...u32(1), // edge hint
      ...u16(2), // fill count
      // fill 1: linear gradient
      ...u32(0),
      ...u8(0x10, 0), // subtype GRADIENT (linear), more_flags
      ...IDENTITY,
      ...u8(2), // stops
      ...u16(0), // grad_hints (capsFlag)
      ...u8(0), // gradType (capsFlag)
      ...new Array(extraGradientBytes).fill(0),
      ...u8(0),
      ...u32(RED),
      ...u8(255),
      ...u32(YELLOW),
      // fill 2: solid blue
      ...u32(BLUE),
      ...u8(0, 0),
      ...u16(0), // line count
      ...u8(0x20),
      ...s32(10 * 5120),
      ...s32(0),
      ...u8(0),
    ]);

  it('decodes the stops and the fills that follow a Flash 8 gradient', () => {
    // Pre-fix: the 5 zero bytes were read as the first stop, misaligning the
    // stops, the following solid fill and the edge stream.
    const d = readShapeData(new ByteReader(shapeData(5, 5)), true);
    expect(d.fills).toHaveLength(2);
    expect(d.fills[0].type).toBe('linear');
    expect(d.fills[0].gradient).toEqual([
      { color: '#ff0000', alpha: 1, ratio: 0 },
      { color: '#ffff00', alpha: 1, ratio: 1 },
    ]);
    expect(d.fills[1]).toEqual({ index: 2, type: 'solid', color: '#0000ff', alpha: 1 });
    expect(d.rawEdges).toHaveLength(1);
    expect(d.rawEdges[0].toX).toBe(10 * 5120);
  });

  it('does not skip those bytes for shape_data_schema 4', () => {
    const d = readShapeData(new ByteReader(shapeData(4, 0)), true);
    expect(d.fills[0].gradient!.map((g) => g.color)).toEqual(['#ff0000', '#ffff00']);
    expect(d.fills[1].color).toBe('#0000ff');
    expect(d.rawEdges).toHaveLength(1);
  });
});

// ── §10 exact contour stitching ─────────────────────────────────────────────

describe('§10 renderer stitches exactEdges shapes with exact vertex matching', () => {
  // Two separate square islands of fill 1. Island B's first vertex (23,26) is
  // within 8px of island A's closing vertex (30,20). With the 8px tolerance the
  // two loops are chained into one polygon and the bridge (30,20)→(23,36) …
  // (23,26)→(30,20) fills a wedge in the gap, e.g. at (25,28).
  const seg = (x0: number, y0: number, x1: number, y1: number): Edge => ({
    fillStyle1: 1,
    commands: [
      { type: 'M', x: x0, y: y0 },
      { type: 'L', x: x1, y: y1 },
    ],
  });
  const islands = (exactEdges?: boolean): Shape => ({
    type: 'shape',
    matrix: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
    fills: [{ index: 1, type: 'solid', color: '#ff0000', alpha: 1 }],
    strokes: [],
    edges: [
      seg(30, 20, 40, 20),
      seg(40, 20, 40, 30),
      seg(40, 30, 30, 30),
      seg(30, 30, 30, 20),
      seg(23, 26, 23, 36),
      seg(23, 36, 13, 36),
      seg(13, 36, 13, 26),
      seg(13, 26, 23, 26),
    ],
    ...(exactEdges === undefined ? {} : { exactEdges }),
  });

  const fillPathOf = (shape: Shape) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const renderer = new FLARenderer(canvas);
    const paths = (
      renderer as unknown as {
        getOrComputeShapePaths(s: Shape): { fillPaths: Map<number, Path2D> };
      }
    ).getOrComputeShapePaths(shape);
    const ctx = canvas.getContext('2d')!;
    const path = paths.fillPaths.get(1)!;
    return (x: number, y: number) => ctx.isPointInPath(path, x, y, 'nonzero');
  };

  it('keeps separate fill islands separate (no wedge in the gap)', () => {
    const inside = fillPathOf(islands(true));
    expect(inside(35, 25)).toBe(true); // island A
    expect(inside(18, 31)).toBe(true); // island B
    expect(inside(25, 28)).toBe(false); // gap (pre-fix: bridged wedge)
  });

  it('XFL shapes (no exactEdges) keep the 8px gap tolerance', () => {
    const inside = fillPathOf(islands());
    expect(inside(35, 25)).toBe(true);
    expect(inside(18, 31)).toBe(true);
    expect(inside(25, 28)).toBe(true); // chained within 8px, as before
  });
});

// ── §11 motion tweens ───────────────────────────────────────────────────────

describe('§11 classic motion tweens from CPicFrame field_188 / field_190', () => {
  it('decodes field_188 bit 0 as motionTween and field_190 as the ease', () => {
    const tl = decodeStreamTimeline(
      pageStream([
        {
          name: 'Layer 1',
          frames: [
            { span: 4, x: 40, field188: 0x1e01, field190: -50 },
            { span: 1, x: 240, field188: 0x0600, field190: 0 },
            { span: 4, x: 40, field188: 0x0001, field190: 100 },
            { span: 1, x: 240, field188: 0x1e01, field190: 500 }, // out of range
          ],
        },
      ])
    )!;
    const kfs = tl.layers[0].keyframes;
    expect(kfs.map((k) => k.motionTween)).toEqual([true, false, true, true]);
    expect(kfs.map((k) => k.acceleration)).toEqual([-50, 0, 100, 0]);
  });

  it('parseBinaryFLA emits tweenType motion + acceleration on tween keyframes only', () => {
    const doc = parseBinaryFLA(
      buildCFB([
        { name: 'Contents', data: contentsStream({}) },
        {
          name: 'Page 1',
          data: pageStream([
            {
              name: 'Layer 1',
              frames: [
                { span: 5, x: 40, field188: 0x1e01, field190: -40 },
                { span: 1, x: 240 },
              ],
            },
          ]),
        },
      ])
    );
    const frames = doc.timelines[0].layers[0].frames;
    expect(frames.map((f) => [f.index, f.duration])).toEqual([
      [0, 5],
      [5, 1],
    ]);
    expect(frames[0].tweenType).toBe('motion');
    expect(frames[0].acceleration).toBe(-40);
    expect(frames[1].tweenType).toBeUndefined();
  });
});

// ── §12 sound ───────────────────────────────────────────────────────────────

describe('§12 binary sound extraction', () => {
  const pcm = (len: number, fill: number) => new Uint8Array(len).fill(fill);

  async function soundFla(): Promise<Uint8Array> {
    const mp3 = new Uint8Array(await (await fetch(mp3Url)).arrayBuffer());
    const contents = contentsStream({
      extra: [
        // 0x0E = 44.1 kHz, 16-bit, mono; 2048 samples × 2 bytes = 4096.
        ...soundRecord(1, 'tone.wav', 0x0e, 2048),
        // 0x05 = 11.025 kHz, 8-bit, stereo; 2048 × 2 × 1 = 4096.
        ...soundRecord(2, 'stereo8.wav', 0x05, 2048),
        // MP3 sniffed from the stream (FF FB), length not checked.
        ...soundRecord(3, 'music.mp3', 0x0f, 99999),
        // Neither MP3 nor 100×2 bytes of PCM (ADPCM/Nellymoser): skipped.
        ...soundRecord(4, 'adpcm.wav', 0x0e, 100),
      ],
    });
    const page = pageStream([
      { name: 'Art', frames: [{ span: 1, x: 40 }, { span: 2, x: 140 }] },
      { name: 'Sound', frames: [{ span: 3, soundRef: 1 }] },
    ]);
    return buildCFB([
      { name: 'Contents', data: contents },
      { name: 'Page 1', data: page },
      { name: 'Media 1', data: pcm(4096, 0x10) },
      { name: 'Media 2', data: pcm(4096, 0x80) },
      { name: 'Media 3', data: mp3 },
      { name: 'Media 4', data: pcm(4096, 0x22) },
    ]);
  }

  it('parses CMediaSound records: format byte → rate/bits/channels, codec sniff, skip', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = extractBinaryFLAInfo(await soundFla());
    expect([...info.sounds.keys()].sort()).toEqual([1, 2, 3]);
    expect(info.sounds.get(1)).toEqual({
      mediaNumber: 1,
      name: 'tone.wav',
      stream: 'Media 1',
      codec: 'pcm',
      sampleRate: 44100,
      bitDepth: 16,
      channels: 1,
      sampleCount: 2048,
    });
    expect(info.sounds.get(2)).toMatchObject({
      codec: 'pcm',
      sampleRate: 11025,
      bitDepth: 8,
      channels: 2,
    });
    expect(info.sounds.get(3)).toMatchObject({ name: 'music.mp3', codec: 'mp3' });
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes('adpcm.wav') && String(c[0]).includes('skipped'))
    ).toBe(true);
  });

  it('links the keyframe sound ref to an event sound in the FLADocument', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doc = parseBinaryFLA(await soundFla());
    expect([...doc.sounds.keys()].sort()).toEqual(['music.mp3', 'stereo8.wav', 'tone.wav']);
    expect(doc.sounds.get('tone.wav')).toMatchObject({
      href: 'Media 1',
      sampleRate: 44100,
      bitDepth: 16,
      channels: 1,
      sampleCount: 2048,
    });
    expect(doc.sounds.get('music.mp3')!.format).toBe('mp3');
    const layers = doc.timelines[0].layers;
    expect(layers.map((l) => l.name)).toEqual(['Sound', 'Art']);
    expect(layers[0].frames[0].sound).toEqual({ name: 'tone.wav', sync: 'event' });
    expect(layers[1].frames.every((f) => f.sound === undefined)).toBe(true);
  });

  it('reads sample counts of 2^31 and above as unsigned', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const contents = contentsStream({ extra: soundRecord(1, 'huge.wav', 0x0e, 0x80000000) });
    const info = extractBinaryFLAInfo(
      buildCFB([
        { name: 'Contents', data: contents },
        { name: 'Media 1', data: new Uint8Array(4096) },
      ])
    );
    // The length check fails (it is not that much PCM), so the record is
    // skipped; the warning shows the unsigned byte count, not a negative one.
    expect(info.sounds.size).toBe(0);
    const msg = String((console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]);
    expect(msg).toContain(`nor ${0x80000000 * 2}-byte PCM`);
  });

  it('skips a sound whose stream cannot be read and keeps the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const real = OLE2File.prototype.readStream;
    vi.spyOn(OLE2File.prototype, 'readStream').mockImplementation(function (this: OLE2File, name: string) {
      if (name === 'Media 2') throw new Error('FAT chain loop');
      return real.call(this, name);
    });
    const info = extractBinaryFLAInfo(await soundFla());
    expect([...info.sounds.keys()].sort()).toEqual([1, 3]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('stereo8.wav') && String(c[0]).includes('unreadable'))).toBe(true);
  });

  it('keeps two sounds with the same display name apart', () => {
    const contents = contentsStream({
      extra: [...soundRecord(1, 'click.wav', 0x0e, 2048), ...soundRecord(2, 'click.wav', 0x0e, 2048)],
    });
    const page = pageStream([
      { name: 'A', frames: [{ span: 1, soundRef: 1 }] },
      { name: 'B', frames: [{ span: 1, soundRef: 2 }] },
      { name: 'Art', frames: [{ span: 1, x: 40 }, { span: 1, x: 140 }] },
    ]);
    const doc = parseBinaryFLA(
      buildCFB([
        { name: 'Contents', data: contents },
        { name: 'Page 1', data: page },
        { name: 'Media 1', data: new Uint8Array(4096) },
        { name: 'Media 2', data: new Uint8Array(4096) },
      ])
    );
    expect([...doc.sounds.keys()].sort()).toEqual(['click.wav', 'click.wav (Media 2)']);
    expect(doc.sounds.get('click.wav')!.href).toBe('Media 1');
    expect(doc.sounds.get('click.wav (Media 2)')!.href).toBe('Media 2');
    const byLayer = new Map(doc.timelines[0].layers.map((l) => [l.name, l.frames[0].sound?.name]));
    expect(byLayer.get('A')).toBe('click.wav');
    expect(byLayer.get('B')).toBe('click.wav (Media 2)');
  });

  it('FLAParser decodes binary PCM into an AudioBuffer and MP3 via decodeAudioData', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = new File([(await soundFla()).slice().buffer as ArrayBuffer], 'sound.fla', { type: 'application/octet-stream' });
    const doc = await new FLAParser().parse(file);
    const tone = doc.sounds.get('tone.wav')!.audioData!;
    expect(tone).toBeDefined();
    expect(tone.numberOfChannels).toBe(1);
    expect(tone.sampleRate).toBe(44100);
    expect(tone.length).toBe(2048);
    // 16-bit LE 0x1010 = 4112 → 4112/32768.
    expect(tone.getChannelData(0)[0]).toBeCloseTo(4112 / 32768, 6);
    const stereo = doc.sounds.get('stereo8.wav')!.audioData!;
    expect(stereo.numberOfChannels).toBe(2);
    expect(stereo.length).toBe(2048);
    const music = doc.sounds.get('music.mp3')!.audioData;
    expect(music).toBeDefined();
    expect(music!.duration).toBeGreaterThan(0);
  });
});
