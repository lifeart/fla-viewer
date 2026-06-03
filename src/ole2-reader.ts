/**
 * Minimal OLE2 / Microsoft Compound File Binary (CFB) reader.
 *
 * Pre-CS5 binary `.fla` files are not ZIP/XFL archives; they are OLE2 compound
 * documents (the same container format as legacy `.doc`/`.xls`/`.msi`), holding
 * MFC-serialized object trees in named streams (`Contents`, `Page N`,
 * `Symbol N`, `Media N`). See GitHub issue #8 and the fla-decoder reference
 * (https://github.com/eddiemoore/fla-decoder, docs/FORMAT.md §1).
 *
 * This is a self-contained, browser-compatible (no Node deps) read-only reader
 * supporting CFB v3 (512-byte sectors) and v4 (4096-byte sectors), including
 * both the regular FAT chain (large streams) and the mini-FAT / mini-stream
 * (small streams below the cutoff). It intentionally does not implement
 * writing, red-black tree balancing, or storage hierarchies beyond what FLA
 * files use (a single flat set of streams under the root).
 *
 * CFB spec: [MS-CFB] Microsoft Compound File Binary File Format.
 */

/** OLE2 / CFB magic signature: D0 CF 11 E0 A1 B1 1A E1. */
export const OLE2_MAGIC = new Uint8Array([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);

// Special FAT sector values.
const MAXREGSECT = 0xfffffffa;
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
// Directory entry object types.
const OBJ_UNKNOWN = 0;
const OBJ_STORAGE = 1;
const OBJ_STREAM = 2;
const OBJ_ROOT = 5;
const NOSTREAM = 0xffffffff;

export interface OLE2Entry {
  /** Stream/storage name (e.g. "Contents", "Symbol 1"). */
  name: string;
  /** Directory entry object type. */
  type: number;
  /** Total byte size of the stream's data. */
  size: number;
  /** First sector of the stream's chain (FAT or miniFAT depending on size). */
  startSector: number;
}

/**
 * Returns true when `bytes` begins with the OLE2/CFB magic signature.
 * Used to distinguish a pre-CS5 binary FLA from a ZIP/XFL one (which starts
 * with the ASCII bytes "PK").
 */
export function isOLE2(bytes: Uint8Array): boolean {
  if (bytes.length < OLE2_MAGIC.length) return false;
  for (let i = 0; i < OLE2_MAGIC.length; i++) {
    if (bytes[i] !== OLE2_MAGIC[i]) return false;
  }
  return true;
}

export class OLE2File {
  private view: DataView;
  private bytes: Uint8Array;
  private sectorSize = 512;
  private miniSectorSize = 64;
  private miniStreamCutoff = 4096;
  private fat: Uint32Array = new Uint32Array(0);
  private miniFat: Uint32Array = new Uint32Array(0);
  private dirEntries: OLE2Entry[] = [];
  /** The root entry's stream — the backing store for all mini-stream data. */
  private miniStream: Uint8Array = new Uint8Array(0);

  constructor(buffer: ArrayBuffer | Uint8Array) {
    this.bytes =
      buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength
    );
    this.parseHeader();
  }

  /** List all stream entries (excludes root and storage objects). */
  listStreams(): OLE2Entry[] {
    return this.dirEntries.filter((e) => e.type === OBJ_STREAM);
  }

  /** Whether a stream with the given name exists. */
  hasStream(name: string): boolean {
    return this.dirEntries.some(
      (e) => e.type === OBJ_STREAM && e.name === name
    );
  }

  /**
   * Read the full byte content of a named stream.
   * Throws if the stream does not exist — callers must handle this so a missing
   * stream is never silently swallowed (project rule: no empty catch blocks).
   */
  readStream(name: string): Uint8Array {
    const entry = this.dirEntries.find(
      (e) => e.type === OBJ_STREAM && e.name === name
    );
    if (!entry) {
      throw new Error(`OLE2 stream not found: "${name}"`);
    }
    return this.readEntry(entry);
  }

  /** Read the bytes for a directory entry, choosing FAT vs miniFAT by size. */
  private readEntry(entry: OLE2Entry): Uint8Array {
    if (entry.size < this.miniStreamCutoff && entry.type !== OBJ_ROOT) {
      return this.readMiniChain(entry.startSector, entry.size);
    }
    return this.readFatChain(entry.startSector, entry.size);
  }

  private parseHeader(): void {
    if (!isOLE2(this.bytes)) {
      throw new Error('Not an OLE2 compound file (bad magic signature)');
    }
    if (this.bytes.length < 512) {
      throw new Error('OLE2 file too small to contain a valid header');
    }

    const sectorShift = this.view.getUint16(0x1e, true);
    this.sectorSize = 1 << sectorShift;
    const miniSectorShift = this.view.getUint16(0x20, true);
    this.miniSectorSize = 1 << miniSectorShift;
    this.miniStreamCutoff = this.view.getUint32(0x38, true);

    if (this.sectorSize !== 512 && this.sectorSize !== 4096) {
      throw new Error(`Unsupported OLE2 sector size: ${this.sectorSize}`);
    }

    const numFatSectors = this.view.getUint32(0x2c, true);
    const dirStartSector = this.view.getUint32(0x30, true);
    const miniFatStart = this.view.getUint32(0x3c, true);
    const numMiniFatSectors = this.view.getUint32(0x40, true);
    const difatStart = this.view.getUint32(0x44, true);
    const numDifatSectors = this.view.getUint32(0x48, true);

    // ── Build the DIFAT: the list of sectors that hold the FAT. The first 109
    // DIFAT entries live in the header (offset 0x4c); any further ones chain
    // through dedicated DIFAT sectors.
    const fatSectorList: number[] = [];
    for (let i = 0; i < 109; i++) {
      const s = this.view.getUint32(0x4c + i * 4, true);
      if (s <= MAXREGSECT) fatSectorList.push(s);
    }
    let difatSector = difatStart;
    let difatGuard = 0;
    const entriesPerDifat = this.sectorSize / 4 - 1;
    while (
      difatSector !== ENDOFCHAIN &&
      difatSector !== FREESECT &&
      difatSector <= MAXREGSECT &&
      difatGuard < numDifatSectors + 1
    ) {
      const base = this.sectorOffset(difatSector);
      for (let i = 0; i < entriesPerDifat; i++) {
        const s = this.view.getUint32(base + i * 4, true);
        if (s <= MAXREGSECT) fatSectorList.push(s);
      }
      difatSector = this.view.getUint32(base + entriesPerDifat * 4, true);
      difatGuard++;
    }
    if (fatSectorList.length < numFatSectors) {
      // Not fatal — we read what the DIFAT actually pointed to — but surface it.
      console.warn(
        `OLE2: header declares ${numFatSectors} FAT sectors but DIFAT lists ${fatSectorList.length}`
      );
    }

    // ── Read the FAT itself (concatenation of all FAT sectors).
    const fatEntriesPerSector = this.sectorSize / 4;
    const fat = new Uint32Array(fatSectorList.length * fatEntriesPerSector);
    for (let fi = 0; fi < fatSectorList.length; fi++) {
      const base = this.sectorOffset(fatSectorList[fi]);
      for (let i = 0; i < fatEntriesPerSector; i++) {
        fat[fi * fatEntriesPerSector + i] = this.view.getUint32(
          base + i * 4,
          true
        );
      }
    }
    this.fat = fat;

    // ── Read the mini-FAT chain.
    if (
      numMiniFatSectors > 0 &&
      miniFatStart !== ENDOFCHAIN &&
      miniFatStart <= MAXREGSECT
    ) {
      const miniFatBytes = this.readFatChain(
        miniFatStart,
        numMiniFatSectors * this.sectorSize
      );
      const count = Math.floor(miniFatBytes.length / 4);
      const miniFat = new Uint32Array(count);
      const mv = new DataView(
        miniFatBytes.buffer,
        miniFatBytes.byteOffset,
        miniFatBytes.byteLength
      );
      for (let i = 0; i < count; i++) miniFat[i] = mv.getUint32(i * 4, true);
      this.miniFat = miniFat;
    }

    // ── Read directory entries (chained through the FAT).
    const dirBytes = this.readFatChain(dirStartSector, -1);
    this.parseDirectory(dirBytes);

    // ── The root entry's stream is the mini-stream backing store.
    const root = this.dirEntries.find((e) => e.type === OBJ_ROOT);
    if (root) {
      this.miniStream = this.readFatChain(root.startSector, root.size);
    }
  }

  private parseDirectory(dirBytes: Uint8Array): void {
    const entrySize = 128;
    const count = Math.floor(dirBytes.length / entrySize);
    const dv = new DataView(
      dirBytes.buffer,
      dirBytes.byteOffset,
      dirBytes.byteLength
    );
    const entries: OLE2Entry[] = [];
    for (let i = 0; i < count; i++) {
      const off = i * entrySize;
      const objType = dv.getUint8(off + 0x42);
      if (
        objType !== OBJ_STORAGE &&
        objType !== OBJ_STREAM &&
        objType !== OBJ_ROOT
      ) {
        // OBJ_UNKNOWN (free entry) — skip.
        if (objType !== OBJ_UNKNOWN) {
          // Unexpected type: warn rather than silently drop.
          console.warn(`OLE2: directory entry ${i} has unknown type ${objType}`);
        }
        continue;
      }
      // Name: UTF-16LE, length (incl. terminator) in bytes at off+0x40.
      let nameLen = dv.getUint16(off + 0x40, true);
      if (nameLen > 64) nameLen = 64;
      const nameChars: number[] = [];
      for (let c = 0; c + 1 < nameLen; c += 2) {
        const code = dv.getUint16(off + c, true);
        if (code === 0) break;
        nameChars.push(code);
      }
      const name = String.fromCharCode(...nameChars);
      // Directory-entry layout ([MS-CFB] §2.6.1):
      //   off+0x74  u32  starting sector location
      //   off+0x78  u64  stream size
      // FLA streams are well under 4GB so the low 32 bits of the size suffice
      // and we avoid BigInt. The high dword lives at off+0x7c.
      const startSector = dv.getUint32(off + 0x74, true);
      const sizeLow = dv.getUint32(off + 0x78, true);
      entries.push({
        name,
        type: objType,
        size: sizeLow,
        startSector,
      });
    }
    this.dirEntries = entries;
  }

  /**
   * Byte offset of regular sector `n`. Per [MS-CFB] §2.5, the array of sectors
   * begins immediately after the 512-byte header, and a sector's offset is
   * `(n + 1) * sectorSize`. For v3 (512-byte sectors) this equals the header
   * size plus `n * 512`; for v4 (4096-byte sectors) the header occupies only
   * the first 512 bytes of sector 0's region, so the formula must scale with
   * `sectorSize` — not be a fixed 512-byte header offset (which misaligned
   * every v4 sector by 3584 bytes).
   */
  private sectorOffset(n: number): number {
    return (n + 1) * this.sectorSize;
  }

  /**
   * Follow a FAT chain from `startSector`, concatenating sector data.
   * `byteLimit < 0` reads the whole chain; otherwise the result is truncated
   * to `byteLimit` bytes (used to trim a stream's final partial sector).
   */
  private readFatChain(startSector: number, byteLimit: number): Uint8Array {
    const chunks: number[] = [];
    let sector = startSector;
    let guard = 0;
    const maxSectors = this.fat.length + 1;
    while (sector !== ENDOFCHAIN && sector <= MAXREGSECT) {
      if (guard++ > maxSectors) {
        throw new Error('OLE2: FAT chain too long (possible loop)');
      }
      const base = this.sectorOffset(sector);
      const end = Math.min(base + this.sectorSize, this.bytes.length);
      for (let i = base; i < end; i++) chunks.push(this.bytes[i]);
      const next = this.fat[sector];
      if (next === undefined) break;
      sector = next;
    }
    let out = Uint8Array.from(chunks);
    if (byteLimit >= 0 && out.length > byteLimit) out = out.slice(0, byteLimit);
    return out;
  }

  /**
   * Follow a mini-FAT chain from `startSector` within the mini-stream,
   * concatenating mini-sector data, truncated to `byteLimit`.
   */
  private readMiniChain(startSector: number, byteLimit: number): Uint8Array {
    const chunks: number[] = [];
    let sector = startSector;
    let guard = 0;
    const maxSectors = this.miniFat.length + 1;
    while (sector !== ENDOFCHAIN && sector <= MAXREGSECT) {
      if (guard++ > maxSectors) {
        throw new Error('OLE2: miniFAT chain too long (possible loop)');
      }
      const base = sector * this.miniSectorSize;
      const end = Math.min(base + this.miniSectorSize, this.miniStream.length);
      for (let i = base; i < end; i++) chunks.push(this.miniStream[i]);
      const next = this.miniFat[sector];
      if (next === undefined) break;
      sector = next;
    }
    let out = Uint8Array.from(chunks);
    if (byteLimit >= 0 && out.length > byteLimit) out = out.slice(0, byteLimit);
    return out;
  }

  /** Re-export of the constants for callers/tests. */
  static readonly NOSTREAM = NOSTREAM;
}
