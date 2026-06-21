import { describe, it, expect } from 'vitest';
import { extractLinkage, joinLinkageToSymbolNumbers } from '../binary-linkage-decoder';

// ── byte-builder helpers ────────────────────────────────────────────────────
function u8(...v: number[]): number[] {
  return v.map((n) => n & 0xff);
}
function u32le(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
}
function utf16(s: string): number[] {
  const o: number[] = [];
  for (const c of s) o.push(c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8);
  return o;
}
/** A Flash string `FF FE FF <u8 len> <UTF-16LE>`. */
function flashStr(s: string): number[] {
  return [0xff, 0xfe, 0xff, s.length, ...utf16(s)];
}
/** A library-item record fragment: the item name followed by its u32 symbol number. */
function libraryItem(name: string, symbolNumber: number): number[] {
  return [...flashStr(name), ...u32le(symbolNumber)];
}
/**
 * One linkage record: `<id> <sep> <className> <schema> 02 00 00 00`. The schema
 * byte varies by Flash version (0x05 / 0x07 in the real corpus); the separator
 * is "." in some files and EMPTY in others — both are covered below.
 */
function record(id: string, sep: string, cls: string, schema: number): number[] {
  return [...flashStr(id), ...flashStr(sep), ...flashStr(cls), schema, 0x02, 0x00, 0x00, 0x00];
}

describe('extractLinkage — binary Contents linkage table', () => {
  it('decodes id + className + kind for both separator styles and schemas', () => {
    const bytes = new Uint8Array([
      ...u8(0, 0, 0, 0), // leading padding
      ...record('MyButton', '.', 'com.example.MyButton', 0x05), // "." separator
      ...u8(0, 0, 0, 0, 0, 0, 0, 0), // gap between records
      ...record('MyList', '', 'skyui.List', 0x07), // EMPTY separator
    ]);
    expect(extractLinkage(bytes)).toEqual([
      { identifier: 'MyButton', className: 'com.example.MyButton', kind: 'library' },
      { identifier: 'MyList', className: 'skyui.List', kind: 'library' },
    ]);
  });

  it('tags the document class when the nearest edit-name is "Symbol 0"', () => {
    const bytes = new Uint8Array([
      ...utf16('Symbol 0'), // root edit-name immediately precedes the record
      ...record('DocClass', '.', 'MyDocument', 0x05),
    ]);
    expect(extractLinkage(bytes)).toEqual([
      { identifier: 'DocClass', className: 'MyDocument', kind: 'document' },
    ]);
  });

  it('keeps a library record bound to a non-root "Symbol 1" edit-name', () => {
    const bytes = new Uint8Array([
      ...utf16('Symbol 1'),
      ...record('LibClip', '.', 'MyClip', 0x05),
    ]);
    expect(extractLinkage(bytes)[0].kind).toBe('library');
  });

  it('returns [] for a stream with no linkage records', () => {
    expect(extractLinkage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual([]);
  });
});

describe('joinLinkageToSymbolNumbers — linkage → library Symbol number', () => {
  it('joins each identifier to the u32 after its library-item name string', () => {
    const bytes = new Uint8Array([
      // library-item records: name string immediately followed by u32 symbol id
      ...libraryItem('MyClip', 677),
      ...u8(0, 0, 0, 0),
      ...libraryItem('MyButton', 254),
      ...u8(0, 0, 0, 0),
      // linkage-table records (the same ids, but followed by a separator string)
      ...record('MyClip', '.', 'com.MyClip', 0x05),
      ...u8(0, 0, 0, 0),
      ...record('MyButton', '', 'skyui.MyButton', 0x07),
    ]);
    const linkage = extractLinkage(bytes);
    const join = joinLinkageToSymbolNumbers(bytes, linkage, new Set([677, 254]));
    expect(join.get(677)?.identifier).toBe('MyClip');
    expect(join.get(677)?.className).toBe('com.MyClip');
    expect(join.get(254)?.identifier).toBe('MyButton');
    expect(join.size).toBe(2);
  });

  it('ignores the linkage-table occurrence (separator string follows, not a u32)', () => {
    // Only the table record exists — no library-item record — so no join.
    const bytes = new Uint8Array([...record('Imported', '.', 'shared.Imported', 0x05)]);
    const linkage = extractLinkage(bytes);
    expect(joinLinkageToSymbolNumbers(bytes, linkage, new Set([1, 2, 3])).size).toBe(0);
  });

  it('does not join when the trailing u32 is not an existing symbol stream', () => {
    const bytes = new Uint8Array([
      ...libraryItem('Ghost', 999),
      ...u8(0, 0, 0, 0),
      ...record('Ghost', '.', 'Ghost', 0x05),
    ]);
    const linkage = extractLinkage(bytes);
    // 999 is not in the symbol-number set → no join.
    expect(joinLinkageToSymbolNumbers(bytes, linkage, new Set([42])).size).toBe(0);
  });
});
