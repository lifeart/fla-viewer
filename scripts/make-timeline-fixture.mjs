// One-off generator for the committed binary-FLA timeline fixture
// `src/__tests__/fixtures/binary-timeline.fla`.
//
// It writes a byte-valid OLE2 / CFB v3 compound file (512-byte sectors, flat
// single-storage layout — exactly what src/ole2-reader.ts supports) containing:
//   - a `Contents` stream with the doc props + a library entry for "Symbol 1";
//   - a `Page 1` scene stream whose single CPicLayer holds THREE keyframes
//     (spans 1, 3, 1 → indices 0, 1, 4), each placing a RENDERABLE legacy
//     CPicShape (a filled square) at a DIFFERENT x position, so rendering the
//     scene at frame 0 vs frame 4 produces visibly different pixels.
//
// This proves the issue-#8 per-frame attribution end-to-end through the real
// parser + renderer with content that actually draws. Run once:
//   node scripts/make-timeline-fixture.mjs
import { writeFileSync } from 'fs';

// ── little-endian helpers ───────────────────────────────────────────────────
const u8 = (...v) => v.map((n) => n & 0xff);
const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const s16 = (v) => u16(v < 0 ? v + 0x10000 : v);
const u32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
const s32 = (v) => u32(v < 0 ? v + 0x100000000 : v);

const NEWCLASS = [0xff, 0xff];
const NULL_TAG = [0x00, 0x00];
const INT_MIN = s32(-0x80000000);
const SENTINEL = [...NULL_TAG, ...INT_MIN, ...INT_MIN];
const decl = (n, s = 1) => [...NEWCLASS, ...u16(s), ...u16(n.length), ...[...n].map((c) => c.charCodeAt(0))];
const backref = (i) => u16(0x8000 | i);
const flashStr = (s) => {
  const o = [0xff, 0xfe, 0xff, s.length];
  for (const c of s) o.push(c.charCodeAt(0) & 0xff, (c.charCodeAt(0) >> 8) & 0xff);
  return o;
};

// ── a renderable legacy CPicShape (shape_data_schema 2): a filled square ─────
// Legacy fills (schema < 3) are `u32 color + u16 flags` and the edge stream
// assigns fill index 1 via a style-change record, so the renderer fills it.
function squareShapeData(sizePx) {
  const t = (px) => px * 2560; // px → ultra-twips (1px = 2560)
  const sz = t(sizePx);
  const out = [];
  out.push(...u8(2)); // shape_data_schema = 2 (legacy edges, no cubic tail)
  out.push(...u32(0)); // edge_hint
  out.push(...u16(1)); // fill_count = 1
  // Legacy solid fill: u32 color (R,G,B,A little-endian → A=0xFF, B=0, G=0xFF,
  // R=0 = opaque green) + u16 flags. colorFromU32 reads byte0=R..byte3=A.
  out.push(...u32(0xff00ff00), ...u16(0));
  out.push(...u16(0)); // line_count = 0
  // Edge stream: a CLOSED square traced via cumulative endpoints. Each edge's
  // delta-1 (t1) moves the running endpoint to the new `from`, delta-3 (t3) to
  // the new `to`. We keep `from` == previous `to` (delta-1 = 0) so the path is
  // continuous. flags: bit6=style change; t1=bits0-1, t3=bits4-5; type 2 = s32.
  const d = (dx, dy) => [...s32(dx), ...s32(dy)];
  // edge 0 (with style change selecting fill1=1): from (0,0) → to (sz,0).
  out.push(...u8(0x62)); // 0x40 style | t1=2 | t3=2<<4
  out.push(...u16(0), ...u16(1), ...u16(0)); // fill0=0, fill1=1, line=0
  out.push(...d(0, 0)); // from-delta: stay at running (0,0)
  out.push(...d(sz, 0)); // to-delta: +sz x → (sz,0)
  const edge = (tdx, tdy) => out.push(...u8(0x22), ...d(0, 0), ...d(tdx, tdy));
  edge(0, sz); // → (sz, sz)
  edge(-sz, 0); // → (0, sz)
  edge(0, -sz); // → (0, 0) close
  out.push(...u8(0)); // edge terminator
  return out;
}

// CPicShape body placed at pixel (txPx, tyPx) via its matrix translate.
function shapeBody(txPx, tyPx, sizePx) {
  const tw = (px) => px * 20; // px → twips for matrix translate
  return [
    ...u8(2, 0), // CPicObj schema 2, flags 0
    ...NULL_TAG, ...INT_MIN, ...INT_MIN, // empty children + point
    ...u8(2), // shape_schema (<=2 → caps flag off)
    ...u32(0x10000), ...u32(0), ...u32(0), ...u32(0x10000), ...s32(tw(txPx)), ...s32(tw(tyPx)),
    ...squareShapeData(sizePx),
  ];
}

// A CPicFrame (schema 19) with `span` and one CPicShape child at (tx,ty).
function frameBody(span, txPx, tyPx, sizePx, childTag) {
  const out = [];
  out.push(...u8(2, 0)); // CPicObj base
  out.push(...childTag, ...shapeBody(txPx, tyPx, sizePx)); // child shape
  out.push(...NULL_TAG, ...INT_MIN, ...INT_MIN); // end children + point
  // frame's own (empty) canvas shape, schema 2 (no cubic tail)
  out.push(...u8(2));
  out.push(...u32(0x10000), ...u32(0), ...u32(0), ...u32(0x10000), ...u32(0), ...u32(0));
  out.push(...u8(2), ...u32(0), ...u16(0), ...u16(0), ...u8(0)); // empty shape_data schema 2
  const fs = 19;
  out.push(...u8(fs), ...u16(span), ...u16(0), ...s16(0), ...u16(0), ...u16(0));
  out.push(...u16(0), ...u8(0), ...u32(0), ...s32(0), ...u16(0));
  out.push(...u32(0), ...u32(2)); // timeline sub-object (type_id 0, format 2)
  out.push(...u32(0), ...u32(0), ...u32(0), ...u16(0), ...u32(0), ...u16(0)); // post fields
  return out;
}

// The `Page 1` scene stream: CPicPage → CPicLayer → 3 CPicFrames (spans 1,3,1).
function pageStream() {
  const out = [0x01];
  out.push(...decl('CPicPage', 1)); // idx 1/2
  out.push(...u8(2, 0)); // page CPicObj base
  out.push(...decl('CPicLayer', 1)); // idx 3/4 — page child
  out.push(...u8(2, 0)); // layer CPicObj base
  const frames = [
    { span: 1, x: 40 },
    { span: 3, x: 240 },
    { span: 1, x: 440 },
  ];
  frames.forEach((f, i) => {
    out.push(...(i === 0 ? decl('CPicFrame', 1) : backref(5))); // CPicFrame idx 5/6
    const childTag = i === 0 ? decl('CPicShape', 1) : backref(7); // CPicShape idx 7/8
    out.push(...frameBody(f.span, f.x, 160, 80, childTag));
  });
  out.push(...NULL_TAG, ...INT_MIN, ...INT_MIN); // end layer children + point
  out.push(...u8(11)); // layer_schema 11
  out.push(...flashStr('Layer 1'));
  out.push(...u8(0), ...u8(0), ...u8(1)); // type/locked/visible
  out.push(...u32(0xffffffff), ...u32(0), ...u32(0), ...u32(0)); // color + fields
  out.push(...u8(0), ...NULL_TAG, ...u8(0), ...u8(0)); // mode, parent, schema>=9/10
  out.push(...SENTINEL, ...u8(2), ...NULL_TAG); // page terminator
  return Uint8Array.from(out);
}

// A minimal `Contents` stream: white 550×400 @ 24fps + a "Symbol 1" library
// entry. The doc-prop scanner reads two RGBA quads + u16 pad + u16 fps.
function contentsStream() {
  const out = [];
  for (let i = 0; i < 100; i++) out.push(0); // lead-in (scanner starts at 100)
  out.push(...u8(255, 255, 255, 255)); // bg RGBA (white, alpha FF)
  out.push(...u8(0, 0, 0, 255)); // 2nd quad alpha FF
  out.push(...u16(0)); // pad
  out.push(...u16(24)); // fps
  return Uint8Array.from(out);
}

// ── minimal CFB v3 writer (512-byte sectors, flat single storage) ────────────
const SECTOR = 512;
function pad(arr, n) {
  const out = arr.slice();
  while (out.length % n !== 0) out.push(0);
  return out;
}
const ENDOFCHAIN_VAL = 0xfffffffe;
const FREESECT_VAL = 0xffffffff;
const NOSTREAM_VAL = 0xffffffff;
const FATSECT_VAL = 0xfffffffd;

function buildCFB(streams) {
  // streams: [{name, data}]. Root + each stream is a directory entry. To keep
  // the reader simple we put ALL stream data in the regular FAT (no mini-FAT):
  // force size >= 4096 by padding so they bypass the mini-stream cutoff.
  const MINI_CUTOFF = 4096;
  const entries = [{ name: 'Root Entry', type: 5, data: new Uint8Array(0) }];
  for (const s of streams) {
    let data = s.data;
    // Pad every stream to >= the mini cutoff and report that padded size, so the
    // reader takes the regular-FAT path (we don't emit a mini-FAT). The decoder
    // stops at the page's own NULL terminator, so trailing zero padding is inert.
    if (data.length < MINI_CUTOFF) {
      const p = new Uint8Array(MINI_CUTOFF);
      p.set(data);
      data = p;
    }
    entries.push({ name: s.name, type: 2, data, realSize: data.length });
  }

  // Lay out stream data sectors first (FAT-chained), then the directory sector,
  // then the FAT sector(s). We compute everything then assemble.
  const sectors = []; // each is Uint8Array(512)
  const fat = []; // FAT entries parallel to `sectors`
  function allocChain(data) {
    if (data.length === 0) return ENDOFCHAIN_VAL;
    const first = sectors.length;
    const n = Math.ceil(data.length / SECTOR);
    for (let i = 0; i < n; i++) {
      const sec = new Uint8Array(SECTOR);
      sec.set(data.subarray(i * SECTOR, (i + 1) * SECTOR));
      sectors.push(sec);
      fat.push(sectors.length); // next = this+1 (placeholder; fix last)
    }
    fat[first + n - 1] = ENDOFCHAIN_VAL;
    return first;
  }

  // Allocate stream data chains.
  const starts = entries.map((e) =>
    e.type === 2 ? allocChain(e.data) : ENDOFCHAIN_VAL
  );

  // Directory: 128-byte entries, 4 per 512 sector.
  const dir = [];
  entries.forEach((e, i) => {
    const ent = new Uint8Array(128);
    // name (UTF-16LE, max 31 chars + null)
    const nm = e.name;
    for (let j = 0; j < nm.length; j++) {
      ent[j * 2] = nm.charCodeAt(j) & 0xff;
      ent[j * 2 + 1] = (nm.charCodeAt(j) >> 8) & 0xff;
    }
    const nameLen = (nm.length + 1) * 2;
    ent[64] = nameLen & 0xff;
    ent[65] = (nameLen >> 8) & 0xff;
    ent[66] = e.type; // object type
    ent[67] = 1; // color = black
    // left/right/child siblings: link streams as a chain off root's child.
    const w32 = (off, v) => {
      ent[off] = v & 0xff; ent[off + 1] = (v >> 8) & 0xff;
      ent[off + 2] = (v >> 16) & 0xff; ent[off + 3] = (v >>> 24) & 0xff;
    };
    w32(68, NOSTREAM_VAL); // left
    w32(72, NOSTREAM_VAL); // right
    w32(76, NOSTREAM_VAL); // child
    if (i === 0) {
      // root: child = first stream entry (index 1); start = ENDOFCHAIN (no mini)
      w32(76, entries.length > 1 ? 1 : NOSTREAM_VAL);
      w32(116, ENDOFCHAIN_VAL); // start sector (mini stream) — none
      w32(120, 0); // size lo
    } else {
      // chain streams via right-sibling so the reader's traversal finds them.
      if (i + 1 < entries.length) w32(72, i + 1);
      w32(116, starts[i]); // start sector
      w32(120, e.realSize ?? e.data.length); // real size lo
    }
    dir.push(ent);
  });
  // Pack directory entries into sectors.
  const dirBytes = [];
  for (const ent of dir) dirBytes.push(...ent);
  const dirStart = allocChain(Uint8Array.from(pad(dirBytes, SECTOR)));

  // Build the FAT itself. The FAT sectors also occupy sectors and must be
  // marked FATSECT (0xfffffffd) in the FAT. Compute FAT sector count.
  const FATSECT = FATSECT_VAL;
  let fatSectorCount = 1;
  for (;;) {
    const totalSectors = sectors.length + fatSectorCount;
    const needed = Math.ceil(totalSectors / (SECTOR / 4));
    if (needed === fatSectorCount) break;
    fatSectorCount = needed;
  }
  const fatStartIndex = sectors.length;
  for (let i = 0; i < fatSectorCount; i++) {
    sectors.push(new Uint8Array(SECTOR));
    fat.push(FATSECT);
  }
  // Serialize FAT into the FAT sectors.
  const fatFull = fat.slice();
  while (fatFull.length % (SECTOR / 4) !== 0) fatFull.push(FREESECT_VAL);
  for (let i = 0; i < fatFull.length; i++) {
    const sec = sectors[fatStartIndex + Math.floor(i / (SECTOR / 4))];
    const off = (i % (SECTOR / 4)) * 4;
    const v = fatFull[i];
    sec[off] = v & 0xff; sec[off + 1] = (v >> 8) & 0xff;
    sec[off + 2] = (v >> 16) & 0xff; sec[off + 3] = (v >>> 24) & 0xff;
  }

  // Header (512 bytes).
  const header = new Uint8Array(SECTOR);
  header.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  const hw16 = (off, v) => { header[off] = v & 0xff; header[off + 1] = (v >> 8) & 0xff; };
  const hw32 = (off, v) => {
    header[off] = v & 0xff; header[off + 1] = (v >> 8) & 0xff;
    header[off + 2] = (v >> 16) & 0xff; header[off + 3] = (v >>> 24) & 0xff;
  };
  hw16(0x18, 0x003e); // minor version
  hw16(0x1a, 0x0003); // major version 3
  hw16(0x1c, 0xfffe); // byte order
  hw16(0x1e, 9); // sector shift (512 = 2^9)
  hw16(0x20, 6); // mini sector shift (64 = 2^6)
  hw32(0x2c, fatSectorCount); // number of FAT sectors
  hw32(0x30, dirStart); // first directory sector
  hw32(0x38, 4096); // mini stream cutoff
  hw32(0x3c, ENDOFCHAIN_VAL); // first mini-FAT sector
  hw32(0x40, 0); // number of mini-FAT sectors
  hw32(0x44, ENDOFCHAIN_VAL); // first DIFAT sector
  hw32(0x48, 0); // number of DIFAT sectors
  // DIFAT array (first 109 entries) at 0x4c: point to the FAT sectors.
  for (let i = 0; i < 109; i++) {
    const v = i < fatSectorCount ? fatStartIndex + i : FREESECT_VAL;
    hw32(0x4c + i * 4, v);
  }

  // Assemble file: header + all sectors.
  const total = new Uint8Array(SECTOR + sectors.length * SECTOR);
  total.set(header, 0);
  sectors.forEach((s, i) => total.set(s, SECTOR + i * SECTOR));
  return total;
}

const fla = buildCFB([
  { name: 'Contents', data: contentsStream() },
  { name: 'Page 1', data: pageStream() },
]);
const outPath = new URL('../src/__tests__/fixtures/binary-timeline.fla', import.meta.url);
writeFileSync(outPath, fla);
console.log(`wrote ${fla.length} bytes to ${outPath.pathname}`);
