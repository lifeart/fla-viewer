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

/**
 * The library symbol NUMBER a linkage identifier binds to, or null.
 *
 * The library-item record writes the item's name as a Flash string immediately
 * followed by a `u32` — the REAL symbol number (the `N` in the `S <N>` /
 * `Symbol <N>` stream). This is NOT the "Symbol 1"/"Symbol 2" default edit-name
 * string seen elsewhere (that is just the pre-rename display name). We take the
 * FIRST occurrence of the identifier whose trailing 4 bytes are a `u32` (not
 * another Flash-string header — that would be the linkage-TABLE record, where the
 * separator string follows) AND whose value is an existing symbol stream number.
 * Later occurrences (component-param references) can carry an unrelated u32, so
 * first-match + the stream-number gate is what keeps the join 1:1.
 */
function symbolNumberFor(
  contents: Uint8Array,
  identifier: string,
  symbolNumbers: Set<number>
): number | null {
  const len = identifier.length;
  for (let p = 0; p + 4 + len * 2 + 4 <= contents.length; p++) {
    if (contents[p] !== 0xff || contents[p + 1] !== 0xfe || contents[p + 2] !== 0xff || contents[p + 3] !== len) {
      continue;
    }
    let ok = true;
    for (let i = 0; i < len; i++) {
      if ((contents[p + 4 + i * 2] | (contents[p + 4 + i * 2 + 1] << 8)) !== identifier.charCodeAt(i)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const after = p + 4 + len * 2;
    // A Flash-string header here means this is the linkage-table record (the
    // separator/className strings follow), not the library-item record.
    if (contents[after] === 0xff && contents[after + 1] === 0xfe && contents[after + 2] === 0xff) {
      continue;
    }
    const val =
      contents[after] | (contents[after + 1] << 8) | (contents[after + 2] << 16) | (contents[after + 3] * 0x1000000);
    if (symbolNumbers.has(val)) return val;
  }
  return null;
}

/**
 * Join each linkage record to its library Symbol number (see
 * {@link symbolNumberFor}). Returns `symbolNumber → linkage record`, so the
 * parser can set per-symbol `linkageClassName` directly — making the binary path
 * match the XFL shape with no SWF and no consumer-side join. Records with no
 * local symbol stream (imported/shared classes) are left unjoined (they stay in
 * the document-level table only). The join is 1:1 (first writer wins on the rare
 * chance two records resolve to the same number).
 */
export function joinLinkageToSymbolNumbers(
  contents: Uint8Array,
  linkage: BinaryLinkage[],
  symbolNumbers: Set<number>
): Map<number, BinaryLinkage> {
  const out = new Map<number, BinaryLinkage>();
  for (const rec of linkage) {
    const num = symbolNumberFor(contents, rec.identifier, symbolNumbers);
    if (num !== null && !out.has(num)) out.set(num, rec);
  }
  return out;
}
