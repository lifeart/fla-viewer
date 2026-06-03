// Generates a *synthetic*, byte-valid OLE2 / Microsoft Compound File Binary
// (CFB) **version 3** (512-byte sector) fixture that REQUIRES DIFAT-sector
// chaining to be read correctly (issue #8). It contains NO Adobe/third-party
// content — it is purely synthetic, built from scratch here. Re-run with:
//   node scripts/gen-binary-fla-difat.mjs
//
// ── Why this fixture exists ────────────────────────────────────────────────
// A CFB header has room for only the first 109 FAT-sector pointers (the DIFAT
// array at offset 0x4c). When a file's FAT needs MORE than 109 sectors, the
// remaining FAT-sector pointers live in dedicated "DIFAT sectors" that chain
// through their last u32. `src/ole2-reader.ts` implements that chaining loop
// (parseHeader → `while (difatSector !== ENDOFCHAIN ...)`), but none of the
// existing fixtures (`binary-mx2004.fla`, `binary-v4.fla`) — nor the 5 real
// Flash MX 2004 FLAs we validated against — are large enough to need it. This
// fixture is the regression guard for that loop.
//
// To force > 109 FAT sectors with 512-byte (v3) sectors (128 FAT entries each)
// the FAT must describe > 109 × 128 = 13 952 sectors, i.e. a ~7 MB file. The
// payload is almost entirely a single large run-length-friendly stream, so the
// file gzip-compresses to a few KB; we commit the *gzipped* bytes and the test
// inflates them with DecompressionStream('gzip'). The structure, not the data,
// is what matters — the stream's bytes are a position-derived pattern so the
// test can assert read-back without storing a huge literal.
//
// Layout (v3, 512-byte sectors):
//   sector 0                : DIFAT sector (holds FAT-sector pointers 110..)
//   sector 1                : directory (Root Entry + "Contents")
//   sectors 2 .. 2+F-1      : the FAT itself (F = NUM_FAT_SECTORS sectors)
//   sectors 2+F ..          : "Contents" stream data (large, regular-FAT path)
// The header's 109 DIFAT slots point at the first 109 FAT sectors; the 110th+
// FAT-sector pointer lives in the DIFAT sector at sector 0. Reading the whole
// "Contents" stream back therefore EXERCISES the DIFAT-chaining loop: without
// it the reader only sees the first 109 FAT sectors and truncates the stream.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

const SECTOR = 512; // v3
const SECTOR_SHIFT = 0x0009; // 1 << 9 = 512
const MINI_SECTOR_SHIFT = 0x0006; // 1 << 6 = 64
const MINI_CUTOFF = 4096;

const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const DIFSECT = 0xfffffffc;
const NOSTREAM = 0xffffffff;

const OBJ_ROOT = 5;
const OBJ_STREAM = 2;

const FAT_PER_SECTOR = SECTOR / 4; // 128
const DIFAT_PER_SECTOR = FAT_PER_SECTOR - 1; // 127 (last u32 chains to next DIFAT sector)

// ── We want strictly MORE than 109 FAT sectors so DIFAT-sector chaining runs.
// Use 110 FAT sectors: 109 pointers in the header + 1 pointer in our single
// DIFAT sector. That single DIFAT sector covers up to 127 extra FAT sectors,
// so one is plenty for the 110th.
const NUM_FAT_SECTORS = 110;
const NUM_DIFAT_SECTORS = 1;

// ── Fixed sector allocation for the non-data sectors.
const DIFAT_SECTOR = 0;
const DIR_SECTOR = 1;
const FAT_START = 2; // FAT occupies sectors 2 .. 2+NUM_FAT_SECTORS-1
const CONTENTS_START = FAT_START + NUM_FAT_SECTORS;

// ── Size the "Contents" stream so the TOTAL sector count exceeds 109×128 =
// 13 952 (which is what forces a 110th FAT sector). The FAT describes
// NUM_FAT_SECTORS × 128 = 14 080 sector slots; we fill just past the 13 952
// boundary and leave the rest FREE. Total sectors = CONTENTS_START + dataCount.
const TOTAL_SECTORS_TARGET = 109 * FAT_PER_SECTOR + 32; // 13 984 → needs 110 FAT sectors
const contentsSectorCount = TOTAL_SECTORS_TARGET - CONTENTS_START;
const CONTENTS_SIZE = contentsSectorCount * SECTOR - 137; // partial final sector (exercise byteLimit)

const totalSectors = CONTENTS_START + contentsSectorCount;
if (Math.ceil(NUM_FAT_SECTORS * FAT_PER_SECTOR) < totalSectors) {
  throw new Error('FAT too small to describe all sectors — bump NUM_FAT_SECTORS');
}
if (NUM_FAT_SECTORS <= 109) {
  throw new Error('NUM_FAT_SECTORS must exceed 109 to exercise DIFAT chaining');
}

// ── The deterministic stream payload (stable function of byte index).
export function contentByte(i) {
  return (i * 37 + (i >> 9) * 11 + 0x29) & 0xff;
}

const fileBytes = SECTOR * (1 + totalSectors); // sector 0's region follows the 512-byte header
const buf = new Uint8Array(fileBytes);
const view = new DataView(buf.buffer);

// Sector n lives at (n + 1) * SECTOR (the sector array starts after the header).
const sectorOffset = (n) => (n + 1) * SECTOR;

// ── Header ([MS-CFB] §2.2).
const MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
MAGIC.forEach((b, i) => (buf[i] = b));
view.setUint16(0x18, 0x003e, true); // minor version
view.setUint16(0x1a, 0x0003, true); // major version = 3
view.setUint16(0x1c, 0xfffe, true); // byte-order LE marker
view.setUint16(0x1e, SECTOR_SHIFT, true); // 512-byte sectors
view.setUint16(0x20, MINI_SECTOR_SHIFT, true);
view.setUint32(0x28, 0, true); // num directory sectors (0 for v3)
view.setUint32(0x2c, NUM_FAT_SECTORS, true); // number of FAT sectors
view.setUint32(0x30, DIR_SECTOR, true); // first directory sector
view.setUint32(0x34, 0, true); // transaction signature
view.setUint32(0x38, MINI_CUTOFF, true); // mini-stream cutoff
view.setUint32(0x3c, ENDOFCHAIN, true); // first mini-FAT sector (none)
view.setUint32(0x40, 0, true); // number of mini-FAT sectors
view.setUint32(0x44, DIFAT_SECTOR, true); // first DIFAT sector
view.setUint32(0x48, NUM_DIFAT_SECTORS, true); // number of DIFAT sectors

// ── DIFAT: the FAT-sector pointers. The first 109 live in the header at 0x4c.
const fatSectors = [];
for (let i = 0; i < NUM_FAT_SECTORS; i++) fatSectors.push(FAT_START + i);

for (let i = 0; i < 109; i++) {
  view.setUint32(0x4c + i * 4, fatSectors[i], true);
}
// Header is exactly full (109 pointers). Remaining pointers (110th onward) go
// into the DIFAT sector at sector 0.
const difatBase = sectorOffset(DIFAT_SECTOR);
for (let i = 0; i < DIFAT_PER_SECTOR; i++) {
  const fatIdx = 109 + i;
  view.setUint32(
    difatBase + i * 4,
    fatIdx < NUM_FAT_SECTORS ? fatSectors[fatIdx] : FREESECT,
    true
  );
}
// Last u32 of the DIFAT sector chains to the next DIFAT sector — none here.
view.setUint32(difatBase + DIFAT_PER_SECTOR * 4, ENDOFCHAIN, true);

// ── FAT: one u32 per sector across NUM_FAT_SECTORS sectors. Build it as a flat
// array first, then write it sector by sector.
const fatLen = NUM_FAT_SECTORS * FAT_PER_SECTOR;
const fat = new Uint32Array(fatLen).fill(FREESECT);
fat[DIFAT_SECTOR] = DIFSECT; // sector 0 is a DIFAT sector
fat[DIR_SECTOR] = ENDOFCHAIN; // directory is one sector
for (let i = 0; i < NUM_FAT_SECTORS; i++) fat[FAT_START + i] = FATSECT; // FAT marks itself
// Contents chain: CONTENTS_START -> +1 -> ... -> ENDOFCHAIN.
for (let i = 0; i < contentsSectorCount; i++) {
  const s = CONTENTS_START + i;
  fat[s] = i === contentsSectorCount - 1 ? ENDOFCHAIN : s + 1;
}
// Write FAT into its sectors.
for (let fi = 0; fi < NUM_FAT_SECTORS; fi++) {
  const base = sectorOffset(FAT_START + fi);
  for (let i = 0; i < FAT_PER_SECTOR; i++) {
    view.setUint32(base + i * 4, fat[fi * FAT_PER_SECTOR + i], true);
  }
}

// ── Directory entries (sector 1). 128 bytes each.
const dirBase = sectorOffset(DIR_SECTOR);
function writeDirEntry(index, name, objType, startSector, size, opts = {}) {
  const off = dirBase + index * 128;
  for (let i = 0; i < name.length; i++) {
    view.setUint16(off + i * 2, name.charCodeAt(i), true);
  }
  view.setUint16(off + 0x40, (name.length + 1) * 2, true); // name length incl. NUL
  view.setUint8(off + 0x42, objType);
  view.setUint8(off + 0x43, opts.colorFlag ?? 1);
  view.setUint32(off + 0x44, opts.leftSibling ?? NOSTREAM, true);
  view.setUint32(off + 0x48, opts.rightSibling ?? NOSTREAM, true);
  view.setUint32(off + 0x4c, opts.child ?? NOSTREAM, true);
  view.setUint32(off + 0x74, startSector >>> 0, true);
  view.setUint32(off + 0x78, size >>> 0, true);
  view.setUint32(off + 0x7c, Math.floor(size / 0x100000000), true);
}
writeDirEntry(0, 'Root Entry', OBJ_ROOT, ENDOFCHAIN, 0, { child: 1 });
writeDirEntry(1, 'Contents', OBJ_STREAM, CONTENTS_START, CONTENTS_SIZE);

// ── Stream data sectors.
for (let i = 0; i < CONTENTS_SIZE; i++) {
  buf[sectorOffset(CONTENTS_START) + i] = contentByte(i);
}

// ── Emit the gzipped fixture (a ~7 MB sparse file compresses to a few KB).
const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, '..', 'src', '__tests__', 'fixtures');
mkdirSync(fixtureDir, { recursive: true });
const outPath = join(fixtureDir, 'binary-difat.fla.gz');
const gz = gzipSync(Buffer.from(buf), { level: 9 });
writeFileSync(outPath, gz);

console.log(`Wrote ${outPath}`);
console.log(`  uncompressed: ${buf.length} bytes (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
console.log(`  gzipped:      ${gz.length} bytes`);
console.log(`  FAT sectors:  ${NUM_FAT_SECTORS} (> 109 → DIFAT-sector chaining required)`);
console.log(`  DIFAT sectors:${NUM_DIFAT_SECTORS} at sector ${DIFAT_SECTOR}`);
console.log(`  Contents:     ${CONTENTS_SIZE} bytes across ${contentsSectorCount} sectors`);
console.log(`  total sectors:${totalSectors} (> 109×128=${109 * FAT_PER_SECTOR})`);
console.log(`  sample bytes: [0]=${contentByte(0)} [600]=${contentByte(600)} [last]=${contentByte(CONTENTS_SIZE - 1)}`);
