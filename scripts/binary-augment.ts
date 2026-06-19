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
import { buildCombinedClassTable } from '../src/binary-instance-decoder';

export interface BinaryLinkage {
  identifier: string;
  className: string;
}

export interface BinarySymbolStrings {
  stream: string;
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
    out.push({ identifier: id, className: cls });
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
  return { stream, candidateNames, other };
}

export function augmentBinary(bytes: Uint8Array): BinaryAugment {
  const ole = new OLE2File(bytes);
  const names = ole.listStreams().map((e) => e.name);
  const linkage = names.includes('Contents')
    ? extractLinkage(ole.readStream('Contents'))
    : [];
  const symbols: BinarySymbolStrings[] = [];
  for (const name of names) {
    if (!/^Symbol \d+$/.test(name)) continue;
    try {
      symbols.push(extractSymbolStrings(name, ole.readStream(name)));
    } catch {
      // a stream we can't read is not fatal for this best-effort augmentation
    }
  }
  return { linkage, symbols };
}
