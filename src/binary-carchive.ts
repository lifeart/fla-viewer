/**
 * MFC `CArchive` primitives shared by the pre-CS5 *binary* `.fla` decoders
 * (shape, instance and timeline). Ported from the object-walk reader in PR #45
 * (zndxcvbn) and the earlier `ArchiveReader` in {@link ./binary-shape-decoder}.
 *
 * This module does not interpret CPic* object bodies. It only reads bytes and
 * the object tags every binary FLA stream uses, and keeps CArchive's load
 * array in step so back-references resolve to the right class.
 *
 * ── Object tags (LE u16), per MFC `CArchive::ReadClass` ──────────────────────
 *   0x0000          null object (also ends a CPicObj children list)
 *   0xFFFF          new class: u16 schema, u16 nameLen, nameLen ASCII bytes;
 *                   then the new object's body
 *   0x8000 | idx    new object of the already-loaded class at load-array idx;
 *                   then the new object's body
 *   idx (< 0x7FFF)  reference to an already-loaded object; NO body follows
 *   0x7FFF + u32    "big" form of the two above for idx >= 0x7FFF; bit 31 of
 *                   the u32 marks a class reference
 *
 * The load array is 1-based. A new class takes two slots (the class, then the
 * object created from it); a new object of a known class takes one. Missing
 * the second case shifts every later index by one, which is what the old
 * reader did.
 */

/** Thrown when a read runs past the end of the stream buffer. */
export class EndOfStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EndOfStreamError';
  }
}

/** Little-endian cursor over a stream's bytes (mirrors fla-decoder `Reader`). */
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

export const NULL_TAG = 0x0000;
export const NEWCLASS_TAG = 0xffff;
export const BIG_OBJECT_TAG = 0x7fff;
const CLASS_TAG = 0x8000;
const BIG_CLASS_FLAG = 0x80000000;

/**
 * One object tag.
 * - `new_class`: a class declaration; the new object's body follows.
 * - `backref`: a new object of an already-loaded class; its body follows.
 * - `object_ref`: a reference to an already-loaded object; no body follows.
 */
export interface ClassTag {
  kind: 'null' | 'new_class' | 'backref' | 'object_ref';
  name?: string;
  schema?: number;
}

interface LoadArrayEntry {
  kind: 'class' | 'object';
  name: string;
}

const ascii = new TextDecoder('ascii');

/**
 * Reads CArchive object tags and keeps the load array in step, so a
 * back-reference index resolves to its class name.
 */
export class ArchiveReader {
  private loadArray: LoadArrayEntry[] = [];
  constructor(public r: ByteReader) {}

  /** Register a class declaration: its class slot, then its first object. */
  registerClass(name: string): void {
    this.loadArray.push({ kind: 'class', name }, { kind: 'object', name });
  }

  /** Seed the load array with classes already declared earlier in the stream. */
  seedClasses(names: readonly string[]): void {
    for (const n of names) this.registerClass(n);
  }

  /** Current load-array length (1-based index of the last entry). */
  get loadArrayLength(): number {
    return this.loadArray.length;
  }

  /** Read one object tag. Throws on a tag that does not resolve. */
  readClassTag(): ClassTag {
    const start = this.r.pos;
    const tag = this.r.u16();
    if (tag === NULL_TAG) return { kind: 'null' };
    if (tag === NEWCLASS_TAG) {
      const schema = this.r.u16();
      const nameLen = this.r.u16();
      const name = ascii.decode(this.r.bytes(nameLen));
      this.registerClass(name);
      return { kind: 'new_class', name, schema };
    }
    let idx: number;
    let isClassRef: boolean;
    if (tag === BIG_OBJECT_TAG) {
      const big = this.r.u32();
      isClassRef = (big & BIG_CLASS_FLAG) !== 0;
      idx = big & ~BIG_CLASS_FLAG;
    } else {
      isClassRef = (tag & CLASS_TAG) !== 0;
      idx = tag & ~CLASS_TAG;
    }
    const entry = this.loadArray[idx - 1];
    if (!entry || entry.kind !== (isClassRef ? 'class' : 'object')) {
      throw new Error(
        `bad ${isClassRef ? 'class' : 'object'} reference ${idx} @ 0x${start.toString(16)} ` +
          `(load array length ${this.loadArray.length})`
      );
    }
    if (isClassRef) {
      this.loadArray.push({ kind: 'object', name: entry.name });
      return { kind: 'backref', name: entry.name };
    }
    return { kind: 'object_ref', name: entry.name };
  }

  /**
   * Class name of the class-reference tag at the reader's position, WITHOUT
   * consuming it; undefined if the next tag is not a resolvable short class
   * reference.
   */
  peekBackrefName(): string | undefined {
    const { buf, pos } = this.r;
    if (pos + 2 > buf.length) return undefined;
    const tag = buf[pos] | (buf[pos + 1] << 8);
    if (!(tag & CLASS_TAG) || tag === NEWCLASS_TAG) return undefined;
    const entry = this.loadArray[(tag & ~CLASS_TAG) - 1];
    return entry?.kind === 'class' ? entry.name : undefined;
  }
}

function isClassNameByte(c: number): boolean {
  // ASCII letters / digits / underscore: every CPic*/MFI* class name.
  return (
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    (c >= 0x30 && c <= 0x39) ||
    c === 0x5f
  );
}

/**
 * Match a NEWCLASS declaration (`FF FF <u16 schema> <u16 len> <name>`) at
 * `pos`. The name must be 1..maxLen class-name characters.
 */
export function readNewClassNameAt(
  data: Uint8Array,
  pos: number,
  maxLen = 39
): { className: string; bodyStart: number } | null {
  if (pos < 0 || pos + 6 > data.length) return null;
  if (data[pos] !== 0xff || data[pos + 1] !== 0xff) return null;
  const nameLen = data[pos + 4] | (data[pos + 5] << 8);
  if (nameLen < 1 || nameLen > maxLen || pos + 6 + nameLen > data.length) return null;
  for (let i = 0; i < nameLen; i++) {
    if (!isClassNameByte(data[pos + 6 + i])) return null;
  }
  return {
    className: ascii.decode(data.subarray(pos + 6, pos + 6 + nameLen)),
    bodyStart: pos + 6 + nameLen,
  };
}

/**
 * Forward scan for every NEWCLASS declaration, in stream order, returning the
 * class names (one per declaration). Used to seed an {@link ArchiveReader}
 * that starts mid-stream.
 */
export function scanDeclaredClasses(data: Uint8Array): string[] {
  const names: string[] = [];
  let i = 0;
  while (i < data.length - 6) {
    const declared = readNewClassNameAt(data, i);
    if (declared) {
      names.push(declared.className);
      i = declared.bodyStart;
      continue;
    }
    i += 1;
  }
  return names;
}

// ── Header-level reader for the CPic object walker (binary-native-timeline) ──
//
// Ported from PR #45 (zndxcvbn). Unlike {@link ArchiveReader} it resolves a
// back-reference by the kind of load-array entry it lands on rather than by the
// tag's class bit, and it can resync its load array over a byte range. The
// object walker relies on both to recover from bodies it cannot read exactly.

export type CArchiveRecoveredVia = 'class_decl' | 'backref';
export type CArchiveReferenceKind = 'new_class' | 'class_backref' | 'object_backref';

export interface CArchiveObjectStart {
  /** Byte offset just after the object tag / class declaration. */
  bodyStart: number;
  className: string;
  recoveredVia: CArchiveRecoveredVia;
  referenceKind: CArchiveReferenceKind;
}

export interface CArchiveObjectHeader {
  /** Byte offset where the object tag starts. */
  tagStart: number;
  /** Byte offset just after the object tag / class declaration. */
  bodyStart: number;
  className: string;
  /** CArchive schema from NEWCLASS declarations. Backrefs reuse the class. */
  schema?: number;
  referenceKind: CArchiveReferenceKind;
  /** 1-based CArchive load-array object slot for newly-created objects. */
  objectIndex?: number;
  /** 1-based CArchive load-array slot referenced by backrefs. */
  referenceIndex?: number;
}

export interface CArchiveReaderCheckpoint {
  pos: number;
  combined: string[];
}

export interface CArchiveReadObject<T> {
  header: CArchiveObjectHeader;
  bodyEnd: number;
  value: T;
}

function classNameFromCombinedEntry(entry: string): string {
  return entry.substring(entry.indexOf(':') + 1);
}

/**
 * Stateful CArchive ReadObject tag reader.
 *
 * This is the native path for typed CPic parsers: it consumes exactly one
 * object tag, updates CArchive's combined class/object load array, then lets a
 * caller parse the object body from `bodyStart`. It deliberately does not scan
 * ahead or infer body lengths.
 */
export class CArchiveReader {
  private combined: string[] = [];
  private view: DataView;

  constructor(public readonly data: Uint8Array, public pos = 0) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get remaining(): number {
    return this.data.length - this.pos;
  }

  seedClass(className: string): void {
    this.combined.push(`class:${className}`, `obj:${className}`);
  }

  seedClasses(classNames: readonly string[]): void {
    for (const className of classNames) this.seedClass(className);
  }

  combinedClassTable(): string[] {
    return this.combined.map(classNameFromCombinedEntry);
  }

  correctLastObjectHeader(
    header: CArchiveObjectHeader,
    className: string,
    referenceKind: CArchiveReferenceKind
  ): CArchiveObjectHeader {
    if (header.referenceKind === 'class_backref' && header.objectIndex === this.combined.length) {
      this.combined[this.combined.length - 1] = `obj:${className}`;
    } else if (header.referenceKind !== 'class_backref' && referenceKind === 'class_backref') {
      this.combined.push(`obj:${className}`);
    }
    return {
      ...header,
      className,
      referenceKind,
      ...(referenceKind === 'class_backref' ? { objectIndex: this.combined.length } : {}),
    };
  }

  syncObjectHeadersInRange(
    start: number,
    end: number,
    knownClasses?: ReadonlySet<string>,
    knownObjectBodyStarts?: ReadonlySet<number>
  ): void {
    let i = Math.max(0, start);
    const limit = Math.min(end, this.data.length);

    while (i < limit - 2) {
      const declared = readNewClassNameAt(this.data, i);
      if (
        declared &&
        declared.bodyStart <= limit &&
        (!knownClasses || knownClasses.has(declared.className)) &&
        (!knownObjectBodyStarts || knownObjectBodyStarts.has(declared.bodyStart))
      ) {
        this.seedClass(declared.className);
        i = declared.bodyStart;
        continue;
      }

      const tag = this.data[i] | (this.data[i + 1] << 8);
      const isLongBackref = tag === BIG_OBJECT_TAG;
      if (isLongBackref || (tag & 0x8000)) {
        if (isLongBackref && i + 6 > limit) break;
        const idx = isLongBackref
          ? (this.data[i + 2] | (this.data[i + 3] << 8) | (this.data[i + 4] << 16) | (this.data[i + 5] << 24)) & ~BIG_CLASS_FLAG
          : tag & 0x7fff;
        const bodyStart = i + (isLongBackref ? 6 : 2);
        if (
          idx >= 1 &&
          idx <= this.combined.length &&
          (!knownObjectBodyStarts || knownObjectBodyStarts.has(bodyStart))
        ) {
          const entry = this.combined[idx - 1];
          const className = classNameFromCombinedEntry(entry);
          if (!knownClasses || knownClasses.has(className)) {
            if (entry.startsWith('class:')) {
              this.combined.push(`obj:${className}`);
            }
            i += isLongBackref ? 6 : 2;
            continue;
          }
        }
      }

      i += 1;
    }
  }

  checkpoint(): CArchiveReaderCheckpoint {
    return {
      pos: this.pos,
      combined: [...this.combined],
    };
  }

  restore(checkpoint: CArchiveReaderCheckpoint): void {
    this.pos = checkpoint.pos;
    this.combined = [...checkpoint.combined];
  }

  peekObjectHeader(): CArchiveObjectHeader | null {
    const checkpoint = this.checkpoint();
    try {
      return this.readObjectHeader();
    } finally {
      this.restore(checkpoint);
    }
  }

  private need(n: number): void {
    if (this.pos + n > this.data.length) {
      throw new Error(
        `CArchive: need ${n} bytes at 0x${this.pos.toString(16)}, only ${this.remaining} left`
      );
    }
  }

  readU8(): number {
    this.need(1);
    return this.data[this.pos++];
  }

  readU16(): number {
    this.need(2);
    const value = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return value;
  }

  readS16(): number {
    this.need(2);
    const value = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return value;
  }

  readU32(): number {
    this.need(4);
    const value = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return value;
  }

  readS32(): number {
    this.need(4);
    const value = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return value;
  }

  readBytes(n: number): Uint8Array {
    this.need(n);
    const value = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return value;
  }

  private resolveBackref(tagStart: number, idx: number): CArchiveObjectHeader {
    if (idx < 1 || idx > this.combined.length) {
      throw new Error(
        `CArchive: invalid backref index ${idx} at 0x${tagStart.toString(16)} ` +
          `(load array length ${this.combined.length})`
      );
    }

    const entry = this.combined[idx - 1];
    const className = classNameFromCombinedEntry(entry);
    if (entry.startsWith('class:')) {
      this.combined.push(`obj:${className}`);
      return {
        tagStart,
        bodyStart: this.pos,
        className,
        referenceKind: 'class_backref',
        objectIndex: this.combined.length,
        referenceIndex: idx,
      };
    }

    return {
      tagStart,
      bodyStart: this.pos,
      className,
      referenceKind: 'object_backref',
      objectIndex: idx,
      referenceIndex: idx,
    };
  }

  readObjectHeader(): CArchiveObjectHeader | null {
    const tagStart = this.pos;
    const tag = this.readU16();

    if (tag === NULL_TAG) return null;

    if (tag === NEWCLASS_TAG) {
      const objectIndex = this.combined.length + 2;
      const schema = this.readU16();
      const nameLen = this.readU16();
      if (nameLen < 1 || nameLen > 1024) {
        throw new Error(`CArchive: implausible class name length ${nameLen} at 0x${tagStart.toString(16)}`);
      }
      const className = ascii.decode(this.readBytes(nameLen));
      this.seedClass(className);
      return {
        tagStart,
        bodyStart: this.pos,
        className,
        schema,
        referenceKind: 'new_class',
        objectIndex,
      };
    }

    if (tag === BIG_OBJECT_TAG) {
      // Bit 31 marks a class reference; the entry kind decides that here.
      return this.resolveBackref(tagStart, this.readU32() & ~BIG_CLASS_FLAG);
    }

    if (tag & 0x8000) {
      return this.resolveBackref(tagStart, tag & 0x7fff);
    }

    return this.resolveBackref(tagStart, tag);
  }

  readObject<T>(parseBody: (header: CArchiveObjectHeader, reader: CArchiveReader) => T): CArchiveReadObject<T> | null {
    const header = this.readObjectHeader();
    if (!header) return null;
    const value = parseBody(header, this);
    return { header, bodyEnd: this.pos, value };
  }
}

/**
 * Simulate CArchive's load array enough to recover every object's body start.
 *
 * NEWCLASS allocates two entries in the combined table: the class and the first
 * object. A later 0x8000|idx tag may refer either to a class entry, creating a
 * new object of that class, or to an existing object entry.
 */
export function scanCArchiveObjectStarts(
  data: Uint8Array,
  knownClasses?: ReadonlySet<string>
): CArchiveObjectStart[] {
  const loadArray: string[] = [];
  const starts: CArchiveObjectStart[] = [];
  let i = 0;

  while (i < data.length - 2) {
    const declared = readNewClassNameAt(data, i);
    if (declared && (!knownClasses || knownClasses.has(declared.className))) {
      loadArray.push(`class:${declared.className}`);
      loadArray.push(`obj:${declared.className}`);
      starts.push({
        bodyStart: declared.bodyStart,
        className: declared.className,
        recoveredVia: 'class_decl',
        referenceKind: 'new_class',
      });
      i = declared.bodyStart;
      continue;
    }

    const tag = data[i] | (data[i + 1] << 8);
    const isLongBackref = tag === BIG_OBJECT_TAG;
    if (isLongBackref || (tag & 0x8000)) {
      if (isLongBackref && i + 6 > data.length) break;
      const idx = isLongBackref
        ? (data[i + 2] | (data[i + 3] << 8) | (data[i + 4] << 16) | (data[i + 5] << 24)) & ~BIG_CLASS_FLAG
        : tag & 0x7fff;
      if (idx >= 1 && idx <= loadArray.length) {
        const item = loadArray[idx - 1];
        const className = classNameFromCombinedEntry(item);
        if (!knownClasses || knownClasses.has(className)) {
          if (item.startsWith('class:')) {
            loadArray.push(`obj:${className}`);
          }
          starts.push({
            bodyStart: i + (isLongBackref ? 6 : 2),
            className,
            recoveredVia: 'backref',
            referenceKind: item.startsWith('class:') ? 'class_backref' : 'object_backref',
          });
        }
        i += isLongBackref ? 6 : 2;
        continue;
      }
    }

    i += 1;
  }

  starts.sort((a, b) => a.bodyStart - b.bodyStart);
  return starts;
}

