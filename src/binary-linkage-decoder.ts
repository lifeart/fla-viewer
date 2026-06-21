/**
 * ActionScript LINKAGE table decoder for pre-CS5 *binary* `.fla` files
 * (GitHub issue #42).
 *
 * The linkage table lives in the OLE2 `Contents` stream. Each record is
 *   <identifier> <separator> <className> `<schema:u8> 02 00 00 00`
 * where the three pieces are Flash strings (`FF FE FF <u8 len> <UTF-16LE>`) and
 * the separator is `"."` in some files (configpanel.fla) and the EMPTY string in
 * others (inventorylists.fla). Anchoring on the trailing `<schema> 02 00 00 00`
 * marker (schema varies by Flash version) and reading the three strings back
 * from it captures both separator styles and every schema seen in the corpus.
 *
 * NOT solved here: joining a linkage record to a specific library Symbol number.
 * That join is object-identity based (not positional, and there is no shared
 * GUID between a linkage record and a `Symbol N` stream — only per-component edit
 * timestamps), so a binary FLA cannot resolve it from its own bytes. The table is
 * surfaced on the document for a consumer that owns the join (e.g. the compiled
 * SWF's registerClass map) to fingerprint each symbol's child instance names
 * against. See memory binary_fla_linkage_names.
 */
import type { BinaryLinkage } from './types';

export type { BinaryLinkage };

/** Find a Flash string whose end offset is exactly `end`, scanning backward. */
function flashStrEndingAt(
  d: Uint8Array,
  end: number
): { str: string; start: number } | null {
  for (let q = end - 4; q >= Math.max(0, end - 800); q--) {
    if (d[q] !== 0xff || d[q + 1] !== 0xfe || d[q + 2] !== 0xff) continue;
    const len = d[q + 3];
    if (q + 4 + len * 2 !== end) continue;
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = d[q + 4 + i * 2] | (d[q + 4 + i * 2 + 1] << 8);
      if (c < 0x20 || c > 0x7e) return null; // not a clean string field
      s += String.fromCharCode(c);
    }
    return { str: s, start: q };
  }
  return null;
}

const LINK_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LINK_CLASS = /^[A-Za-z_][A-Za-z0-9_.]*$/;

// UTF-16LE "Symbol " / "Sprite " edit-name prefixes. Character 0 is the root /
// main timeline, so a linkage record whose bound edit-name is "Symbol 0" is the
// document class. Each library symbol binds "Symbol N"/"Sprite N" with N>=1.
const SYMBOL_PREFIX = [0x53, 0, 0x79, 0, 0x6d, 0, 0x62, 0, 0x6f, 0, 0x6c, 0, 0x20, 0];
const SPRITE_PREFIX = [0x53, 0, 0x70, 0, 0x72, 0, 0x69, 0, 0x74, 0, 0x65, 0, 0x20, 0];

function matchPrefix(d: Uint8Array, q: number, pre: number[]): boolean {
  for (let j = 0; j < pre.length; j++) if (d[q + j] !== pre[j]) return false;
  return true;
}

/**
 * True iff the NEAREST "Symbol N"/"Sprite N" edit-name before the linkage
 * identifier is exactly "Symbol 0" — i.e. this record binds the root (character
 * 0) = the document class. Taking the nearest edit-name (not just "is there a
 * Symbol 0 within a window") avoids tagging a later library record whose own
 * binding (e.g. "Sprite 4") sits between it and an unrelated earlier "Symbol 0".
 */
function boundToRoot(d: Uint8Array, identifierStart: number): boolean {
  for (let q = identifierStart - 2; q >= Math.max(0, identifierStart - 200); q--) {
    const isSym = matchPrefix(d, q, SYMBOL_PREFIX);
    if (!isSym && !matchPrefix(d, q, SPRITE_PREFIX)) continue;
    let n = '';
    for (let p = q + SYMBOL_PREFIX.length; p + 1 < d.length && d[p] >= 0x30 && d[p] <= 0x39 && d[p + 1] === 0; p += 2) {
      n += String.fromCharCode(d[p]);
    }
    if (n === '') continue;
    return isSym && n === '0'; // nearest edit-name decides
  }
  return false;
}

/**
 * Extract the ActionScript linkage table from a binary FLA's `Contents` stream.
 * Marker = `<schema u8> 02 00 00 00`; the className Flash string ends right at
 * the schema byte; the separator and identifier strings are read back from there.
 * De-duplicated on `identifier|className`.
 */
export function extractLinkage(contents: Uint8Array): BinaryLinkage[] {
  const out: BinaryLinkage[] = [];
  const seen = new Set<string>();
  for (let m = 1; m + 4 <= contents.length; m++) {
    if (contents[m] !== 0x02 || contents[m + 1] !== 0x00 || contents[m + 2] !== 0x00 || contents[m + 3] !== 0x00) continue;
    const schema = contents[m - 1];
    // The schema byte varies by Flash version (0x05 in configpanel/
    // inventorylists, 0x07 in itemcard's imported symbols); gate to a sane range.
    if (schema < 1 || schema > 63) continue;
    // Read three Flash strings back: <identifier> <sep> <className>.
    const className = flashStrEndingAt(contents, m - 1);
    if (!className) continue;
    const sep = flashStrEndingAt(contents, className.start);
    if (!sep) continue;
    const identifier = flashStrEndingAt(contents, sep.start);
    if (!identifier) continue;
    const id = identifier.str;
    const cls = className.str;
    // Export id is always a simple identifier; class (when present) is an
    // identifier or dotted path. These gates drop the non-linkage markers.
    if (!LINK_ID.test(id)) continue;
    if (cls && !LINK_CLASS.test(cls)) continue;
    const key = id + '|' + cls;
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = boundToRoot(contents, identifier.start) ? 'document' : 'library';
    out.push({ identifier: id, className: cls, kind });
  }
  return out;
}
