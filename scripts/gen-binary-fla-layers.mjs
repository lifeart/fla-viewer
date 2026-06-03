// Generates a tiny *synthetic*, byte-valid OLE2 / CFB v3 fixture for the
// issue #8 timeline/layer-structure work. It contains NO Adobe/third-party
// content — every byte is built from scratch here. Re-run with:
//   node scripts/gen-binary-fla-layers.mjs
// Verified to round-trip through Python `olefile` (the reference CFB reader).
//
// Unlike `binary-mx2004.fla` (which only exercises the library + doc props),
// this fixture's `Page 1` and `Symbol 1` streams carry real CPicLayer records
// in the exact wire layout we validated byte-for-byte against 5 real Flash MX
// 2004 FLAs (see src/binary-fla-structure.ts):
//   00 00 00 00 00 80 00 00 00 80   CPicObj NULL child tag + 2× INT_MIN point
//   <u8 layer_schema=11>
//   FF FE FF <u8 charLen> <UTF-16LE name>
//   <u8 type> <u8 locked> <u8 visible> <u32 colour filler>
// plus a `Contents` stream with one library record (Symbol 1 → "Box", graphic)
// and the Html publish-settings Width/Height.
//
// All three streams are well under the 4096-byte mini-stream cutoff, so per
// [MS-CFB] they MUST live in the mini-stream (mini-FAT path) — exactly where a
// real small FLA stream lives, and what `olefile` requires. The Root Entry's
// own stream is the mini-stream backing store.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SECTOR = 512;
const MINI = 64;
const SECTOR_SHIFT = 0x0009;
const MINI_SECTOR_SHIFT = 0x0006;
const MINI_CUTOFF = 4096;
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;
const OBJ_ROOT = 5;
const OBJ_STREAM = 2;

function u16le(n) {
  return [n & 0xff, (n >> 8) & 0xff];
}
function utf16le(s) {
  const out = [];
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out.push(c & 0xff, (c >> 8) & 0xff);
  }
  return out;
}
function flashString(s) {
  return [0xff, 0xfe, 0xff, s.length, ...utf16le(s)];
}
function layerRecord(name, schema, type, locked, visible) {
  return [
    0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x80, // SIG
    schema,
    ...flashString(name),
    type, locked, visible,
    0x00, 0x00, 0x00, 0x00, // colour filler (ignored by the reader)
  ];
}

const page1 = Uint8Array.from([
  0x01, 0xff, 0xff, 0x00, 0x01,
  ...layerRecord('Background', 11, 0, 0, 1),
  0xaa, 0xbb,
  ...layerRecord('Guide: helper', 11, 1, 0, 1),
  ...layerRecord('Actions', 11, 0, 1, 1),
]);
const symbol1 = Uint8Array.from([
  0x01, 0xff, 0xff, 0x00, 0x01,
  ...layerRecord('Layer 1', 11, 0, 0, 1),
  ...layerRecord('Layer 2', 11, 0, 1, 0),
]);
function buildContents() {
  const bytes = [];
  while (bytes.length < 100) bytes.push(0);
  bytes.push(0x33, 0x66, 0x99, 0xff); // background #336699
  bytes.push(0x00, 0x00, 0x00, 0xff);
  bytes.push(...u16le(0)); // pad
  bytes.push(...u16le(30)); // fps
  const symName = 'Symbol 1';
  bytes.push(symName.length);
  bytes.push(...utf16le(symName));
  bytes.push(...flashString('Box'));
  bytes.push(...u16le(1), ...u16le(0)); // u32 id = 1
  bytes.push(0x00); // graphic
  bytes.push(...flashString('PublishHtmlProperties::Width'));
  bytes.push(...flashString('320'));
  bytes.push(...flashString('PublishHtmlProperties::Height'));
  bytes.push(...flashString('240'));
  return Uint8Array.from(bytes);
}
const contents = buildContents();

// Streams in mini-stream order (their data is concatenated into the mini-stream
// backing store, each padded to a whole 64-byte mini-sector).
const streams = [
  { name: 'Contents', data: contents },
  { name: 'Page 1', data: page1 },
  { name: 'Symbol 1', data: symbol1 },
];

// ── Build the mini-stream: concatenate each stream's mini-sectors. ──────────
let miniStart = 0;
const miniSectors = []; // flat array of mini-FAT entries
const miniBytes = [];
for (const s of streams) {
  const count = Math.max(1, Math.ceil(s.data.length / MINI));
  s.miniStart = miniStart;
  for (let i = 0; i < count; i++) {
    const sec = miniStart + i;
    miniSectors[sec] = i === count - 1 ? ENDOFCHAIN : sec + 1;
  }
  // Append the data, padded to count*MINI.
  const padded = new Uint8Array(count * MINI);
  padded.set(s.data, 0);
  for (const b of padded) miniBytes.push(b);
  miniStart += count;
}
const miniStream = Uint8Array.from(miniBytes);
const miniSectorTotal = miniStart;

// ── Regular-FAT sector layout. ──────────────────────────────────────────────
//   sector 0 : FAT
//   sector 1 : directory
//   sector 2 : mini-FAT
//   sector 3.. : mini-stream backing store (the Root Entry's stream)
const FAT_SECTOR = 0;
const DIR_SECTOR = 1;
const MINIFAT_SECTOR = 2;
const MINISTREAM_START = 3;
const miniStreamSectorCount = Math.max(1, Math.ceil(miniStream.length / SECTOR));
const totalSectors = MINISTREAM_START + miniStreamSectorCount;

const buf = new Uint8Array(SECTOR * (1 + totalSectors));
const view = new DataView(buf.buffer);
const sectorOffset = (n) => (n + 1) * SECTOR;

// Header.
[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].forEach((b, i) => (buf[i] = b));
view.setUint16(0x18, 0x003e, true);
view.setUint16(0x1a, 0x0003, true);
view.setUint16(0x1c, 0xfffe, true);
view.setUint16(0x1e, SECTOR_SHIFT, true);
view.setUint16(0x20, MINI_SECTOR_SHIFT, true);
view.setUint32(0x2c, 1, true); // 1 FAT sector
view.setUint32(0x30, DIR_SECTOR, true);
view.setUint32(0x38, MINI_CUTOFF, true);
view.setUint32(0x3c, MINIFAT_SECTOR, true); // first mini-FAT sector
view.setUint32(0x40, 1, true); // 1 mini-FAT sector
view.setUint32(0x44, ENDOFCHAIN, true); // no DIFAT sector
view.setUint32(0x48, 0, true);
view.setUint32(0x4c, FAT_SECTOR, true);
for (let i = 1; i < 109; i++) view.setUint32(0x4c + i * 4, FREESECT, true);

// FAT.
const fatBase = sectorOffset(FAT_SECTOR);
for (let i = 0; i < SECTOR / 4; i++) view.setUint32(fatBase + i * 4, FREESECT, true);
const setFat = (s, v) => view.setUint32(fatBase + s * 4, v, true);
setFat(FAT_SECTOR, FATSECT);
setFat(DIR_SECTOR, ENDOFCHAIN);
setFat(MINIFAT_SECTOR, ENDOFCHAIN);
for (let i = 0; i < miniStreamSectorCount; i++) {
  const sec = MINISTREAM_START + i;
  setFat(sec, i === miniStreamSectorCount - 1 ? ENDOFCHAIN : sec + 1);
}

// Mini-FAT (sector 2): one u32 per mini-sector, rest FREE.
const miniFatBase = sectorOffset(MINIFAT_SECTOR);
for (let i = 0; i < SECTOR / 4; i++) view.setUint32(miniFatBase + i * 4, FREESECT, true);
for (let i = 0; i < miniSectorTotal; i++) {
  view.setUint32(miniFatBase + i * 4, miniSectors[i], true);
}

// Directory entries. The Root Entry's stream IS the mini-stream backing store.
const dirBase = sectorOffset(DIR_SECTOR);
function writeDir(index, name, type, start, size, opts = {}) {
  const off = dirBase + index * 128;
  utf16le(name).forEach((b, i) => (buf[off + i] = b));
  view.setUint16(off + 0x40, (name.length + 1) * 2, true);
  view.setUint8(off + 0x42, type);
  view.setUint8(off + 0x43, opts.colorFlag ?? 1);
  view.setUint32(off + 0x44, opts.leftSibling ?? NOSTREAM, true);
  view.setUint32(off + 0x48, opts.rightSibling ?? NOSTREAM, true);
  view.setUint32(off + 0x4c, opts.child ?? NOSTREAM, true);
  view.setUint32(off + 0x74, start >>> 0, true);
  view.setUint32(off + 0x78, size >>> 0, true);
}
// Root → child = Contents (index 1). Stream entries chain via right siblings.
writeDir(0, 'Root Entry', OBJ_ROOT, MINISTREAM_START, miniStream.length, {
  child: 1,
});
writeDir(1, 'Contents', OBJ_STREAM, streams[0].miniStart, streams[0].data.length, {
  rightSibling: 2,
});
writeDir(2, 'Page 1', OBJ_STREAM, streams[1].miniStart, streams[1].data.length, {
  rightSibling: 3,
});
writeDir(3, 'Symbol 1', OBJ_STREAM, streams[2].miniStart, streams[2].data.length);

// Mini-stream backing-store sectors.
buf.set(miniStream, sectorOffset(MINISTREAM_START));

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, '..', 'src', '__tests__', 'fixtures');
mkdirSync(fixtureDir, { recursive: true });
const outPath = join(fixtureDir, 'binary-layers.fla');
writeFileSync(outPath, buf);
console.log(`Wrote ${outPath} (${buf.length} bytes)`);
console.log(`  streams: ${streams.map((s) => `${s.name}=${s.data.length}B`).join(', ')}`);
console.log(`  mini-stream: ${miniStream.length}B across ${miniSectorTotal} mini-sectors`);
