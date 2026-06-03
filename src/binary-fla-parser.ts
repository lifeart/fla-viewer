/**
 * Parser for pre-CS5 *binary* `.fla` files (GitHub issue #8).
 *
 * Unlike CS5+ FLAs (ZIP archives containing XFL/XML), Flash 5 .. CS4 saved
 * `.fla` files as OLE2 compound documents whose streams hold MFC `CArchive`
 * object trees. This module reads the OLE2 container (via {@link OLE2File})
 * and extracts the document-level data the format reliably yields:
 *
 *   - background color + frame rate  (binary pattern in the `Contents` stream)
 *   - stage width/height             (HTML publish-settings strings)
 *   - the symbol library table       (symbol number → name + type)
 *
 * The extraction logic mirrors the reverse-engineered fla-decoder reference
 * (https://github.com/eddiemoore/fla-decoder), specifically
 * `scripts/extract_library.py` and `scripts/extract_all.py`, and is validated
 * byte-for-byte against real Flash MX 2004 sample FLAs (see
 * `src/__tests__/binary-fla-parser.test.ts`).
 *
 * What is NOT decoded here: per-symbol vector shape geometry, timeline
 * frames/tweens, text/bitmap/sound content. Those require walking the full MFC
 * `Serialize` field orderings (CPicShape edge streams, etc.), which the
 * reference itself only achieves with extensive Ghidra-derived schema tables.
 * We surface the library so the viewer can DISPLAY the document instead of
 * failing, and we never silently swallow errors (project rule).
 */
import { OLE2File } from './ole2-reader';
import type { FLADocument, Symbol, Timeline } from './types';

export type BinarySymbolType = 'graphic' | 'button' | 'movieclip' | 'unknown';

export interface BinaryLibraryEntry {
  /** OLE2 stream number (the N in "Symbol N"). */
  symbolNumber: number;
  /** Library display name. */
  name: string;
  /** Symbol kind decoded from the type byte after the name. */
  symbolType: BinarySymbolType;
}

export interface BinaryFLAInfo {
  width: number;
  height: number;
  frameRate: number;
  backgroundColor: string;
  /** Stream names found in the OLE2 container (Contents, Page N, Symbol N…). */
  streams: string[];
  /** Decoded symbol library table. */
  library: BinaryLibraryEntry[];
  /** True when stage dimensions came from publish settings (else defaults). */
  dimensionsFromPublishSettings: boolean;
}

const SYMBOL_TYPE_NAMES: Record<number, BinarySymbolType> = {
  0: 'graphic',
  1: 'button',
  2: 'movieclip',
};

const utf16le = new TextDecoder('utf-16le');

/** Decode a UTF-16LE substring of `data` (byteLen bytes). */
function decodeUtf16(data: Uint8Array, start: number, byteLen: number): string {
  return utf16le.decode(data.subarray(start, start + byteLen));
}

/** Find the first index >= `from` where `needle` occurs in `hay`, or -1. */
function indexOf(hay: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Collect every `FF FE FF <u8 len> <len×2 UTF-16LE>` Flash string in the
 * stream. These hold publish-settings keys/values, library names, folders…
 * (fla-decoder docs/FORMAT.md §2 "Length-prefixed strings").
 */
function collectFlashStrings(data: Uint8Array): string[] {
  const strings: string[] = [];
  let pos = 0;
  while (pos < data.length - 4) {
    if (data[pos] === 0xff && data[pos + 1] === 0xfe && data[pos + 2] === 0xff) {
      const len = data[pos + 3];
      const end = pos + 4 + len * 2;
      if (len > 0 && end <= data.length) {
        strings.push(decodeUtf16(data, pos + 4, len * 2));
        pos = end;
        continue;
      }
    }
    pos += 1;
  }
  return strings;
}

/**
 * Extract the symbol library table from the `Contents` stream.
 * Mirrors fla-decoder `extract_library.extract_library_table`: each library
 * record holds a `"Symbol N"` MFC CString (u8 charlen + UTF-16LE) followed,
 * within ~100 bytes, by a `FF FE FF` Flash string with the library name and
 * then `u32 id + u8 type`.
 */
function extractLibrary(contents: Uint8Array): BinaryLibraryEntry[] {
  // UTF-16LE bytes for "Symbol " (prefix of every library item's CString).
  const symbolPrefix = new Uint8Array([
    0x53, 0x00, 0x79, 0x00, 0x6d, 0x00, 0x62, 0x00, 0x6f, 0x00, 0x6c, 0x00,
    0x20, 0x00,
  ]);
  // Keyed by symbol number. A symbol can appear in more than one library
  // record (Flash writes both a movieclip placeholder and the resolved entry
  // for auto-named items like "Symbol 1"); the LAST record written is the
  // authoritative one, matching the fla-decoder reference's dict-overwrite.
  const byNumber = new Map<number, BinaryLibraryEntry>();
  let pos = 0;
  while (pos < contents.length) {
    const idx = indexOf(contents, symbolPrefix, pos);
    if (idx < 0) break;
    // The MFC CString length (chars) is the byte immediately before the text.
    const strLen = idx > 0 ? contents[idx - 1] : 0;
    if (strLen > 0 && idx + strLen * 2 <= contents.length) {
      const s = decodeUtf16(contents, idx, strLen * 2);
      const m = /^Symbol (\d+)$/.exec(s);
      if (m) {
        const symNum = parseInt(m[1], 10);
        const strEnd = idx + strLen * 2;
        // Search forward for the FF FE FF library-name string.
        let search = strEnd;
        const limit = Math.min(contents.length - 4, strEnd + 100);
        while (search < limit) {
          if (
            contents[search] === 0xff &&
            contents[search + 1] === 0xfe &&
            contents[search + 2] === 0xff
          ) {
            const ln = contents[search + 3];
            const nameEnd = search + 4 + ln * 2;
            if (ln > 0 && nameEnd <= contents.length) {
              const name = decodeUtf16(contents, search + 4, ln * 2);
              // Skip path-like strings (folders / import paths).
              if (!name.includes('/') && !name.startsWith('.\\')) {
                let symbolType: BinarySymbolType = 'unknown';
                if (nameEnd + 5 <= contents.length) {
                  const typeByte = contents[nameEnd + 4];
                  symbolType = SYMBOL_TYPE_NAMES[typeByte] ?? 'unknown';
                }
                byNumber.set(symNum, {
                  symbolNumber: symNum,
                  name,
                  symbolType,
                });
                break;
              }
            }
          }
          search += 1;
        }
      }
    }
    pos = idx + 1;
  }
  return [...byNumber.values()].sort(
    (a, b) => a.symbolNumber - b.symbolNumber
  );
}

/**
 * Extract background color + frame rate from the binary RGBA/RGBA/u16/u16
 * pattern in `Contents` (fla-decoder extract_all.py): two RGBA quads (both
 * with alpha 0xFF), a u16 zero pad, then the frame rate as a u16 in 10..60.
 */
function extractColorAndFrameRate(
  contents: Uint8Array
): { backgroundColor?: string; frameRate?: number } {
  const dv = new DataView(
    contents.buffer,
    contents.byteOffset,
    contents.byteLength
  );
  for (let ci = 100; ci < contents.length - 14; ci++) {
    const a1 = contents[ci + 3];
    const a2 = contents[ci + 7];
    if (a1 !== 0xff || a2 !== 0xff) continue;
    const pad = dv.getUint16(ci + 8, true);
    const fps = dv.getUint16(ci + 10, true);
    if (pad === 0 && fps >= 10 && fps <= 60) {
      const r = contents[ci];
      const g = contents[ci + 1];
      const b = contents[ci + 2];
      const hex = (n: number) => n.toString(16).padStart(2, '0');
      return {
        backgroundColor: `#${hex(r)}${hex(g)}${hex(b)}`,
        frameRate: fps,
      };
    }
  }
  return {};
}

/**
 * Extract stage dimensions from the HTML publish-settings strings (keys
 * "…Html…::Width" / "::Height" with a numeric value string immediately after).
 */
function extractDimensions(
  strings: string[]
): { width?: number; height?: number } {
  const out: { width?: number; height?: number } = {};
  for (let i = 0; i < strings.length - 1; i++) {
    const key = strings[i];
    const val = strings[i + 1];
    if (key.endsWith('::Width') && key.includes('Html') && /^\d+$/.test(val)) {
      out.width = parseInt(val, 10);
    }
    if (key.endsWith('::Height') && key.includes('Html') && /^\d+$/.test(val)) {
      out.height = parseInt(val, 10);
    }
  }
  return out;
}

/**
 * Read a binary FLA's OLE2 container and extract document-level info.
 * Throws (never silently fails) if the `Contents` stream is missing — that
 * would mean the file is not a recognizable binary FLA.
 */
export function extractBinaryFLAInfo(bytes: Uint8Array): BinaryFLAInfo {
  const ole = new OLE2File(bytes);
  const streams = ole.listStreams().map((s) => s.name);

  if (!ole.hasStream('Contents')) {
    throw new Error(
      'Binary FLA is missing its "Contents" stream; cannot read document data. ' +
        `Streams present: ${streams.join(', ') || '(none)'}`
    );
  }

  const contents = ole.readStream('Contents');
  const strings = collectFlashStrings(contents);

  const { backgroundColor, frameRate } = extractColorAndFrameRate(contents);
  const dims = extractDimensions(strings);
  const library = extractLibrary(contents);

  return {
    // Flash's default stage is 550×400 @ 24fps on a white stage — apply these
    // as fallbacks when a value could not be recovered.
    width: dims.width ?? 550,
    height: dims.height ?? 400,
    frameRate: frameRate ?? 24,
    backgroundColor: backgroundColor ?? '#FFFFFF',
    streams,
    library,
    dimensionsFromPublishSettings:
      dims.width !== undefined && dims.height !== undefined,
  };
}

/**
 * Parse a binary FLA into a {@link FLADocument} the existing viewer/renderer
 * can consume. Document properties and the library are populated; per-symbol
 * geometry and timeline frames are not yet decoded (see module docstring), so
 * each library item is registered as an empty symbol and a single empty main
 * timeline is provided. This lets the viewer open the file and list its
 * library rather than erroring out.
 */
export function parseBinaryFLA(bytes: Uint8Array): FLADocument {
  const info = extractBinaryFLAInfo(bytes);

  const symbols = new Map<string, Symbol>();
  for (const entry of info.library) {
    const symbolType =
      entry.symbolType === 'unknown' ? 'graphic' : entry.symbolType;
    const emptyTimeline: Timeline = {
      name: entry.name,
      layers: [],
      totalFrames: 1,
      referenceLayers: new Set<number>(),
    };
    const symbol: Symbol = {
      name: entry.name,
      itemID: `Symbol ${entry.symbolNumber}`,
      symbolType,
      timeline: emptyTimeline,
    };
    symbols.set(entry.name, symbol);
  }

  const mainTimeline: Timeline = {
    name: 'Scene 1',
    layers: [],
    totalFrames: 1,
    referenceLayers: new Set<number>(),
  };

  return {
    width: info.width,
    height: info.height,
    frameRate: info.frameRate,
    backgroundColor: info.backgroundColor,
    timelines: [mainTimeline],
    symbols,
    bitmaps: new Map(),
    sounds: new Map(),
    videos: new Map(),
  };
}
