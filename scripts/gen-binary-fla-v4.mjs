// Generates a tiny *synthetic*, byte-valid OLE2 / Microsoft Compound File
// Binary (CFB) **version 4** fixture (4096-byte sectors) for the issue #8
// binary-FLA reader regression test. It contains NO Adobe/third-party content
// — it is purely synthetic, built from scratch here. Re-run with:
//   node scripts/gen-binary-fla-v4.mjs
//
// Why v4 specifically: the committed `binary-mx2004.fla` fixture is CFB v3
// (512-byte sectors), for which `512 + n*sectorSize` happens to equal the
// correct `(n + 1) * sectorSize`. v4 (4096-byte sectors) is the only case that
// distinguishes the two formulas, so this fixture is the one that actually
// guards the sectorOffset fix.
//
// Layout (one FAT sector is plenty — covers 1024 sectors):
//   sector 0 : FAT
//   sector 1 : directory entries (Root Entry + "Contents")
//   sector 2..k : "Contents" stream data (spans MULTIPLE 4096-byte sectors so
//                 the FAT chain + sectorOffset are genuinely exercised)
//
// The "Contents" stream is intentionally larger than 4096 bytes (and larger
// than the 4096-byte mini-stream cutoff) so it takes the regular-FAT path and
// chains across several full sectors. There is no mini-stream / mini-FAT here:
// FLA `Contents` is always large, and the large-FAT path is exactly what the
// v3-coincidence formula broke for v4.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SECTOR = 4096; // v4
const SECTOR_SHIFT = 0x000c; // 1 << 12 = 4096
const MINI_SECTOR_SHIFT = 0x0006; // 1 << 6 = 64
const MINI_CUTOFF = 4096;

const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;

const OBJ_ROOT = 5;
const OBJ_STREAM = 2;

// ── The deterministic stream payload. ~3.5 sectors → 4 data sectors, so the
// FAT chain has >1 link and the final sector is partial (exercises byteLimit
// truncation). The byte pattern is position-derived so the test can assert it
// independently without hardcoding a huge literal.
const CONTENTS_SIZE = SECTOR * 3 + 1234; // 13522 bytes
function contentByte(i) {
  // Mix two periods so it isn't a constant fill; stays a stable function of i.
  return (i * 31 + (i >> 8) * 7 + 0x11) & 0xff;
}
const contents = new Uint8Array(CONTENTS_SIZE);
for (let i = 0; i < CONTENTS_SIZE; i++) contents[i] = contentByte(i);

const contentsSectorCount = Math.ceil(CONTENTS_SIZE / SECTOR); // 4

// ── Sector allocation.
const FAT_SECTOR = 0;
const DIR_SECTOR = 1;
const CONTENTS_START = 2;
const totalSectors = CONTENTS_START + contentsSectorCount; // 6

const fileBytes = SECTOR * (1 + totalSectors); // sector 0's region holds header
const buf = new Uint8Array(fileBytes);
const view = new DataView(buf.buffer);

// ── Sector-array offset helper, matching the (FIXED) reader: the sector array
// begins after the 4096-byte header region, i.e. sector n lives at (n+1)*4096.
const sectorOffset = (n) => (n + 1) * SECTOR;

// ── Header ([MS-CFB] §2.2).
const MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
MAGIC.forEach((b, i) => (buf[i] = b));
// CLSID (16 bytes) left zero.
view.setUint16(0x18, 0x003e, true); // minor version
view.setUint16(0x1a, 0x0004, true); // major version = 4
view.setUint16(0x1c, 0xfffe, true); // byte order LE marker
view.setUint16(0x1e, SECTOR_SHIFT, true); // sector shift -> 4096
view.setUint16(0x20, MINI_SECTOR_SHIFT, true); // mini sector shift -> 64
// 0x22..0x27 reserved (zero); 0x28 number of directory sectors (v4).
view.setUint32(0x28, 1, true); // 1 directory sector
view.setUint32(0x2c, 1, true); // number of FAT sectors
view.setUint32(0x30, DIR_SECTOR, true); // first directory sector
view.setUint32(0x34, 0, true); // transaction signature
view.setUint32(0x38, MINI_CUTOFF, true); // mini-stream cutoff (4096)
view.setUint32(0x3c, ENDOFCHAIN, true); // first mini-FAT sector (none)
view.setUint32(0x40, 0, true); // number of mini-FAT sectors
view.setUint32(0x44, ENDOFCHAIN, true); // first DIFAT sector (none beyond header)
view.setUint32(0x48, 0, true); // number of DIFAT sectors
// DIFAT array (109 entries) at 0x4c: first entry = our FAT sector, rest FREE.
view.setUint32(0x4c, FAT_SECTOR, true);
for (let i = 1; i < 109; i++) {
  view.setUint32(0x4c + i * 4, FREESECT, true);
}

// ── FAT (sector 0). One u32 per sector; entries-per-sector = 1024.
const fatEntries = SECTOR / 4;
const fatBase = sectorOffset(FAT_SECTOR);
// Default everything to FREESECT.
for (let i = 0; i < fatEntries; i++) {
  view.setUint32(fatBase + i * 4, FREESECT, true);
}
const setFat = (sector, value) =>
  view.setUint32(fatBase + sector * 4, value, true);
setFat(FAT_SECTOR, FATSECT); // sector 0 is the FAT itself
setFat(DIR_SECTOR, ENDOFCHAIN); // directory is a single sector
// Contents chain: 2 -> 3 -> ... -> last -> ENDOFCHAIN.
for (let i = 0; i < contentsSectorCount; i++) {
  const s = CONTENTS_START + i;
  const isLast = i === contentsSectorCount - 1;
  setFat(s, isLast ? ENDOFCHAIN : s + 1);
}

// ── Directory entries (sector 1). 128 bytes each.
const dirBase = sectorOffset(DIR_SECTOR);
function writeDirEntry(index, name, objType, startSector, size, opts = {}) {
  const off = dirBase + index * 128;
  // Name: UTF-16LE, NUL-terminated, length-in-bytes (incl. terminator) at 0x40.
  for (let i = 0; i < name.length; i++) {
    view.setUint16(off + i * 2, name.charCodeAt(i), true);
  }
  const nameLenBytes = (name.length + 1) * 2;
  view.setUint16(off + 0x40, nameLenBytes, true);
  view.setUint8(off + 0x42, objType);
  view.setUint8(off + 0x43, opts.colorFlag ?? 1); // node color (1=black)
  view.setUint32(off + 0x44, opts.leftSibling ?? NOSTREAM, true);
  view.setUint32(off + 0x48, opts.rightSibling ?? NOSTREAM, true);
  view.setUint32(off + 0x4c, opts.child ?? NOSTREAM, true);
  // CLSID (0x50, 16 bytes) + state bits + timestamps left zero.
  view.setUint32(off + 0x74, startSector >>> 0, true); // starting sector
  // size as u64 (low at 0x78, high at 0x7c).
  view.setUint32(off + 0x78, size >>> 0, true);
  view.setUint32(off + 0x7c, Math.floor(size / 0x100000000), true);
}

// index 0: Root Entry. Its child points at the single "Contents" entry.
// Root's starting sector / size describe the mini-stream; we have none → 0.
writeDirEntry(0, 'Root Entry', OBJ_ROOT, ENDOFCHAIN, 0, { child: 1 });
// index 1: the "Contents" stream (large → regular FAT path).
writeDirEntry(1, 'Contents', OBJ_STREAM, CONTENTS_START, CONTENTS_SIZE);
// Remaining dir entries in the sector stay zero (OBJ_UNKNOWN/free → skipped).

// ── Stream data sectors.
for (let i = 0; i < contentsSectorCount; i++) {
  const s = CONTENTS_START + i;
  const dst = sectorOffset(s);
  const srcOff = i * SECTOR;
  const len = Math.min(SECTOR, CONTENTS_SIZE - srcOff);
  buf.set(contents.subarray(srcOff, srcOff + len), dst);
}

// ── Emit fixture + a sidecar describing the expected payload so the test can
// assert without re-deriving the writer's logic. Keep it tiny: just size +
// SHA-256 of the payload + a few sampled bytes.
const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, '..', 'src', '__tests__', 'fixtures');
mkdirSync(fixtureDir, { recursive: true });
const outPath = join(fixtureDir, 'binary-v4.fla');
writeFileSync(outPath, buf);

console.log(`Wrote ${outPath} (${buf.length} bytes)`);
console.log(`Contents stream: ${CONTENTS_SIZE} bytes across ${contentsSectorCount} sectors of ${SECTOR}`);
console.log(`Sample bytes: [0]=${contents[0]} [4096]=${contents[4096]} [last]=${contents[CONTENTS_SIZE - 1]}`);
