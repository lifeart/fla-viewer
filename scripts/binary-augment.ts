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
import { extractLinkage, type BinaryLinkage } from '../src/binary-linkage-decoder';

export type { BinaryLinkage };

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

// extractLinkage now lives in src/binary-linkage-decoder.ts (the core parser
// surfaces it on FLADocument.linkage); re-imported above for this extractor.

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
