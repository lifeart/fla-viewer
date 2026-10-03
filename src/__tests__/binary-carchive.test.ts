import { describe, expect, it } from 'vitest';
import {
  ArchiveReader,
  ByteReader,
  EndOfStreamError,
  readNewClassNameAt,
  scanDeclaredClasses,
} from '../binary-carchive';
import { buildCombinedClassTable } from '../binary-instance-decoder';

const u16le = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const u32le = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const classDecl = (name: string, schema = 1) => [0xff, 0xff, ...u16le(schema), ...u16le(name.length), ...ascii(name)];
const classRef = (idx: number) => u16le(0x8000 | idx);
const objectRef = (idx: number) => u16le(idx);
const bigClassRef = (idx: number) => [0xff, 0x7f, ...u32le(0x80000000 | idx)];
const bigObjectRef = (idx: number) => [0xff, 0x7f, ...u32le(idx)];

function reader(bytes: number[]): { r: ByteReader; ar: ArchiveReader } {
  const r = new ByteReader(Uint8Array.from(bytes));
  return { r, ar: new ArchiveReader(r) };
}

describe('ArchiveReader', () => {
  it('reads a null tag and a new class with its schema', () => {
    const { r, ar } = reader([0x00, 0x00, ...classDecl('CPicPage', 5)]);
    expect(ar.readClassTag()).toEqual({ kind: 'null' });
    expect(ar.readClassTag()).toEqual({ kind: 'new_class', name: 'CPicPage', schema: 5 });
    expect(r.pos).toBe(2 + 6 + 'CPicPage'.length);
    expect(ar.loadArrayLength).toBe(2); // class slot + object slot
  });

  it('gives a new object of a known class its own load-array slot', () => {
    // A: slots 1 (class), 2 (object). Two more A objects: slots 3 and 4.
    // B is then declared at slots 5/6, so 0x8005 must name B.
    // The old reader skipped slots 3 and 4 and could not resolve 0x8005.
    const { ar } = reader([
      ...classDecl('CPicFrame'),
      ...classRef(1),
      ...classRef(1),
      ...classDecl('CPicShape'),
      ...classRef(5),
    ]);
    expect(ar.readClassTag().kind).toBe('new_class');
    expect(ar.readClassTag()).toEqual({ kind: 'backref', name: 'CPicFrame' });
    expect(ar.readClassTag()).toEqual({ kind: 'backref', name: 'CPicFrame' });
    expect(ar.loadArrayLength).toBe(4);
    expect(ar.readClassTag()).toMatchObject({ kind: 'new_class', name: 'CPicShape' });
    expect(ar.readClassTag()).toEqual({ kind: 'backref', name: 'CPicShape' });
    expect(ar.loadArrayLength).toBe(7);
  });

  it('reads an object reference without adding a slot', () => {
    const { r, ar } = reader([...classDecl('CPicLayer'), ...objectRef(2), 0xaa]);
    ar.readClassTag();
    const before = r.pos;
    expect(ar.readClassTag()).toEqual({ kind: 'object_ref', name: 'CPicLayer' });
    expect(r.pos).toBe(before + 2); // no body consumed
    expect(ar.loadArrayLength).toBe(2);
  });

  it('reads the big tag form for class and object references', () => {
    const { r, ar } = reader([...classDecl('CPicSprite'), ...bigClassRef(1), ...bigObjectRef(3)]);
    ar.readClassTag();
    expect(ar.readClassTag()).toEqual({ kind: 'backref', name: 'CPicSprite' });
    expect(ar.readClassTag()).toEqual({ kind: 'object_ref', name: 'CPicSprite' });
    expect(r.eof()).toBe(true);
  });

  it('throws on references that do not resolve', () => {
    // Out of range.
    const outOfRange = reader([...classDecl('CPicPage'), ...classRef(9)]).ar;
    outOfRange.readClassTag();
    expect(() => outOfRange.readClassTag()).toThrow(/bad class reference 9/);
    // Class reference to an object slot.
    const classToObject = reader([...classDecl('CPicPage'), ...classRef(2)]).ar;
    classToObject.readClassTag();
    expect(() => classToObject.readClassTag()).toThrow(/bad class reference 2/);
    // Object reference to a class slot.
    const objectToClass = reader([...classDecl('CPicPage'), ...objectRef(1)]).ar;
    objectToClass.readClassTag();
    expect(() => objectToClass.readClassTag()).toThrow(/bad object reference 1/);
  });

  it('throws EndOfStreamError on a truncated tag', () => {
    const { ar } = reader([0xff]);
    expect(() => ar.readClassTag()).toThrow(EndOfStreamError);
  });

  it('seeds classes for a reader that starts mid-stream', () => {
    const { ar } = reader([...classRef(3)]);
    ar.seedClasses(['CPicPage', 'CPicLayer']);
    expect(ar.peekBackrefName()).toBe('CPicLayer');
    expect(ar.readClassTag()).toEqual({ kind: 'backref', name: 'CPicLayer' });
  });

  it('peekBackrefName only resolves short class references and never consumes', () => {
    const { r, ar } = reader([...classDecl('CPicLayer'), ...objectRef(2), ...bigClassRef(1)]);
    ar.readClassTag();
    const pos = r.pos;
    expect(ar.peekBackrefName()).toBeUndefined(); // object reference
    r.pos += 2;
    expect(ar.peekBackrefName()).toBeUndefined(); // big form
    expect(r.pos).toBe(pos + 2);
  });
});

describe('readNewClassNameAt / scanDeclaredClasses', () => {
  it('reads a declaration and reports where its body starts', () => {
    const data = Uint8Array.from([0xaa, ...classDecl('CPicLayer', 11), 0xbb]);
    expect(readNewClassNameAt(data, 1)).toEqual({ className: 'CPicLayer', bodyStart: 1 + 6 + 9 });
    expect(readNewClassNameAt(data, 0)).toBeNull();
  });

  it('rejects non-identifier names, empty names, overlong names and truncation', () => {
    expect(readNewClassNameAt(Uint8Array.from(classDecl('CPic Bad')), 0)).toBeNull();
    expect(readNewClassNameAt(Uint8Array.from([0xff, 0xff, 1, 0, 0, 0]), 0)).toBeNull();
    expect(readNewClassNameAt(Uint8Array.from(classDecl('C'.repeat(40))), 0)).toBeNull();
    expect(readNewClassNameAt(Uint8Array.from(classDecl('C'.repeat(39))), 0)?.className).toHaveLength(39);
    expect(readNewClassNameAt(Uint8Array.from(classDecl('CPicLayer').slice(0, -1)), 0)).toBeNull();
  });

  it('lists declarations in stream order, skipping noise', () => {
    const data = Uint8Array.from([
      0x01, ...classDecl('CPicPage'), 0x00, 0x05, ...classRef(1), ...classDecl('CPicLayer'), 0xff, 0xff, 0x00,
      ...classDecl('CPicFrame'), 0, 0, 0, 0, 0, 0,
    ]);
    expect(scanDeclaredClasses(data)).toEqual(['CPicPage', 'CPicLayer', 'CPicFrame']);
    // The instance decoder's forward table keeps two slots per declaration.
    expect(buildCombinedClassTable(data)).toEqual([
      'CPicPage', 'CPicPage', 'CPicLayer', 'CPicLayer', 'CPicFrame', 'CPicFrame',
    ]);
  });
});
