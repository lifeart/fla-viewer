/**
 * Issue #42 binary (pre-CS5 / OLE2) augmentation for the verification extractor.
 *
 * The binary FLA decoder recovers geometry + symbol structure but NOT the
 * authoring metadata a language feature needs (linkage classes, instance names,
 * component params). That metadata lives in the OLE2 streams as Flash strings
 * (`FF FE FF <u8 len> <UTF-16LE>`). Full placement-schema decode varies by Flash
 * version and is a large, regression-risky core change, so this module extracts
 * the metadata directly from the streams as best-effort, clearly-labelled data
 * for the reporter to validate BEFORE we commit core-parser changes:
 *
 *   - linkage[]         : the Contents linkage table (export id -> AS class)
 *   - symbols[].candidateNames : per-Symbol-stream identifier-like Flash strings
 *     (plausible child instance names), with MFC class refs filtered out.
 *
 * NOT solved here (called out to the reporter): joining a linkage record to a
 * specific Symbol number, and structurally splitting real instance names from
 * component-param keys (persistentData sub-records). See memory
 * binary_fla_linkage_names.
 */
import { OLE2File } from '../src/ole2-reader';
import { buildCombinedClassTable, scanNamedInstances, type NamedInstance } from '../src/binary-instance-decoder';

export interface BinaryLinkage {
  identifier: string;
  className: string;
  /**
   * 'document' = the main-timeline/root class (bound to character 0, i.e. the
   * `Symbol 0` edit-name in the record); 'library' = a regular library symbol.
   * Lets a stage-instance resolver avoid mistaking the document class for a
   * library symbol.
   */
  kind: 'document' | 'library';
}

export interface BinarySymbolStrings {
  stream: string;
  /**
   * Named placements (name + kind) decoded from the placement records — higher
   * precision than `candidateNames` (drops param keys, adds the type) but
   * best-effort recall: the FP8 per-class field layout isn't fully decoded, so
   * some names can be missed and a few frame labels/class refs can leak.
   */
  namedInstances: NamedInstance[];
  /** Identifier-like strings that are plausible child instance names. */
  candidateNames: string[];
  /** Everything else, for transparency (layers, fonts, labels, AS, param values). */
  other: string[];
}

export interface BinaryAugment {
  linkage: BinaryLinkage[];
  symbols: BinarySymbolStrings[];
}

/** Read a Flash string `FF FE FF <u8 len> <UTF-16LE>` at p, or null. */
function readFlashStr(d: Uint8Array, p: number): { str: string; end: number } | null {
  if (d[p] !== 0xff || d[p + 1] !== 0xfe || d[p + 2] !== 0xff) return null;
  const len = d[p + 3];
  const start = p + 4;
  if (start + len * 2 > d.length) return null;
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(d[start + i * 2] | (d[start + i * 2 + 1] << 8));
  return { str: s, end: start + len * 2 };
}

/** Find a Flash string whose end offset is exactly `end`, scanning backward. */
function flashStrEndingAt(d: Uint8Array, end: number): { str: string; start: number } | null {
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
 * The Contents linkage table. Each record is
 *   <identifier> <separator> <className> `05 02 00 00 00`
 * where the separator Flash string is `"."` in some files (configpanel.fla) and
 * the EMPTY string in others (inventorylists.fla). The older scan keyed on the
 * "." separator and so missed empty-separator files — anchor instead on the
 * trailing `05 02 00 00 00` marker and read the three strings back from it.
 */
export function extractLinkage(contents: Uint8Array): BinaryLinkage[] {
  // Marker = <schema u8> 02 00 00 00. The schema byte varies by Flash version
  // (0x05 in configpanel/inventorylists, 0x07 in itemcard's imported symbols);
  // the className Flash string ends right at that schema byte.
  const out: BinaryLinkage[] = [];
  const seen = new Set<string>();
  for (let m = 1; m + 4 <= contents.length; m++) {
    if (contents[m] !== 0x02 || contents[m + 1] !== 0x00 || contents[m + 2] !== 0x00 || contents[m + 3] !== 0x00) continue;
    const schema = contents[m - 1];
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

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LAYERISH = /(^Layer \d+$)|(Layer$)/;
const STATEISH = /^(Up|Over|Down|Hit|Normal|Selected|Hover|Disabled|_up|_over|_down|_hit)$/;

/**
 * Per-symbol Flash strings, lightly classified. Heuristic — see module note.
 * MFC CRuntimeClass refs (the set the decoder already builds) are filtered out of
 * candidateNames per the reporter's guidance; component-param keys still leak in
 * (they need persistentData sub-record decode to split cleanly).
 */
export function extractSymbolStrings(stream: string, data: Uint8Array): BinarySymbolStrings {
  const classRefs = new Set(buildCombinedClassTable(data));
  // Drop the internal byte offset from the surfaced output.
  const namedInstances = scanNamedInstances(data).map(({ bodyStart, ...n }) => n);
  const candidateNames: string[] = [];
  const other: string[] = [];
  const seen = new Set<string>();
  for (let p = 0; p + 4 <= data.length; p++) {
    const fs = readFlashStr(data, p);
    if (!fs || fs.str.length === 0) continue;
    p = fs.end - 1;
    const s = fs.str;
    if (seen.has(s)) continue;
    seen.add(s);
    const isName =
      IDENT.test(s) &&
      !classRefs.has(s) &&         // MFC CRuntimeClass refs (e.g. CategoryListEntry)
      !s.startsWith('$') &&        // font tokens ($EverywhereMediumFont*)
      !LAYERISH.test(s) &&         // layer names
      !STATEISH.test(s) &&         // button/clip state labels
      !s.includes('(') && !s.includes(';') && !s.includes('=');
    (isName ? candidateNames : other).push(s);
  }
  return { stream, namedInstances, candidateNames, other };
}

export function augmentBinary(bytes: Uint8Array): BinaryAugment {
  const ole = new OLE2File(bytes);
  const names = ole.listStreams().map((e) => e.name);
  const linkage = names.includes('Contents')
    ? extractLinkage(ole.readStream('Contents'))
    : [];
  const symbols: BinarySymbolStrings[] = [];
  for (const name of names) {
    // Symbol timelines come under TWO naming conventions: the classic
    // "Symbol N" and the newer timestamped "S <n> <timestamp>" (+ the main
    // timeline "Page N"). The old filter only matched "Symbol N", so every
    // "S …" stream — and the symbols inside it — was silently skipped, which is
    // why some symbols' children were missing per-file (issue #42 recall gap).
    if (!/^(Symbol \d+|S \d+ \d+|Page \d+)$/.test(name)) continue;
    try {
      symbols.push(extractSymbolStrings(name, ole.readStream(name)));
    } catch {
      // a stream we can't read is not fatal for this best-effort augmentation
    }
  }
  return { linkage, symbols };
}
