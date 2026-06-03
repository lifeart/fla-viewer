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
 * NEW (issue #8 shape geometry): per-stream vector SHAPE geometry is now
 * decoded too — see {@link ./binary-shape-decoder}. The CPicShape fill/stroke
 * styles and edge stream are read and converted to pixel-space PathCommands,
 * so real artwork renders on the stage instead of an empty document.
 *
 * What is still NOT decoded here: per-frame timeline content (keyframes,
 * tweens, symbol placements), text/bitmap/sound element placement. Those
 * require walking the full MFC `Serialize` field orderings including
 * CPicFrame's schema-gated timeline tail, which even the reference decoder
 * only resolves via signature-based recovery. We never silently swallow
 * errors (project rule).
 */
import { OLE2File } from './ole2-reader';
import {
  extractLayers,
  type BinaryLayerInfo,
  type BinaryLayerType,
} from './binary-fla-structure';
import { decodeStreamShapes } from './binary-shape-decoder';
import type { FLADocument, Layer, Shape, Symbol, Timeline } from './types';

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
  /**
   * Layer list decoded from each scene's `Page N` stream. The N (scene number)
   * maps to the OLE2 stream `Page N`. Layers are RELIABLE (name/type/locked/
   * visible); frame content is not decoded (see binary-fla-structure docstring).
   */
  scenes: { scene: number; layers: BinaryLayerInfo[] }[];
  /** Layer list decoded from each `Symbol N` stream, keyed by symbol number. */
  symbolLayers: Map<number, BinaryLayerInfo[]>;
  /**
   * Vector shapes decoded from each scene's `Page N` stream (issue #8 shape
   * geometry), keyed by scene number. Located by the CPicShape recovery
   * scanner (see {@link ./binary-shape-decoder}); each shape carries its own
   * matrix so the renderer places it on the stage.
   */
  sceneShapes: Map<number, Shape[]>;
  /** Vector shapes decoded from each `Symbol N` stream, keyed by symbol number. */
  symbolShapes: Map<number, Shape[]>;
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

  // ── Decode the layer structure of every scene (`Page N`) and library item
  // (`Symbol N`) stream. Only the layer list is reliably decodable (see
  // binary-fla-structure.ts); frame content is intentionally not read.
  const scenes: { scene: number; layers: BinaryLayerInfo[] }[] = [];
  const symbolLayers = new Map<number, BinaryLayerInfo[]>();
  const sceneShapes = new Map<number, Shape[]>();
  const symbolShapes = new Map<number, Shape[]>();
  for (const name of streams) {
    const pageMatch = /^Page (\d+)$/.exec(name);
    if (pageMatch) {
      const sceneNum = parseInt(pageMatch[1], 10);
      const streamData = ole.readStream(name);
      scenes.push({ scene: sceneNum, layers: extractLayers(streamData) });
      const shapes = decodeStreamShapes(streamData).shapes;
      if (shapes.length > 0) sceneShapes.set(sceneNum, shapes);
      continue;
    }
    const symMatch = /^Symbol (\d+)$/.exec(name);
    if (symMatch) {
      const symNum = parseInt(symMatch[1], 10);
      const streamData = ole.readStream(name);
      symbolLayers.set(symNum, extractLayers(streamData));
      const shapes = decodeStreamShapes(streamData).shapes;
      if (shapes.length > 0) symbolShapes.set(symNum, shapes);
    }
  }
  scenes.sort((a, b) => a.scene - b.scene);

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
    scenes,
    symbolLayers,
    sceneShapes,
    symbolShapes,
  };
}

/** Map a decoded binary layer type to the viewer's narrower Layer.layerType. */
function toViewerLayerType(
  t: BinaryLayerType
): Layer['layerType'] {
  // The viewer's Layer.layerType union is exactly these values.
  switch (t) {
    case 'guide':
      return 'guide';
    case 'folder':
      return 'folder';
    case 'mask':
      return 'mask';
    case 'masked':
      return 'masked';
    default:
      return 'normal';
  }
}

/**
 * Build viewer {@link Layer}s from the reliably-decoded binary layer list.
 * Each layer carries its real name / type / locked / visible state. Per-frame
 * timeline content (keyframes, tweens, symbol placements) is still not decoded
 * from the binary format (see {@link ./binary-fla-structure}); the CPicShape
 * recovery scanner, however, locates shapes per STREAM but not per layer/frame,
 * so all of a stream's decoded shapes are placed into the first renderable
 * (non-reference) layer's single frame. The shapes carry their own matrices,
 * so they land in the right place on the stage even without per-layer
 * attribution. Guide / folder layers are reference layers (never rendered).
 */
function buildLayers(
  binaryLayers: BinaryLayerInfo[],
  shapes: Shape[] = []
): { layers: Layer[]; referenceLayers: Set<number> } {
  const referenceLayers = new Set<number>();
  // Choose the first non-guide/folder layer to host the recovered shapes.
  let shapeLayerIndex = binaryLayers.findIndex((bl) => {
    const t = toViewerLayerType(bl.layerType);
    return t !== 'guide' && t !== 'folder';
  });
  if (shapeLayerIndex < 0) shapeLayerIndex = 0;

  const layers: Layer[] = binaryLayers.map((bl, index) => {
    const layerType = toViewerLayerType(bl.layerType);
    if (layerType === 'guide' || layerType === 'folder') {
      referenceLayers.add(index);
    }
    const elements =
      index === shapeLayerIndex && shapes.length > 0 ? [...shapes] : [];
    return {
      name: bl.name,
      color: '#4FFF4F',
      visible: bl.visible,
      locked: bl.locked,
      outline: false,
      layerType,
      frames: [
        {
          index: 0,
          duration: 1,
          keyMode: 0,
          elements,
        },
      ],
    };
  });

  // If shapes were decoded but the stream had no layer records, synthesise a
  // single layer so the artwork still renders.
  if (shapes.length > 0 && layers.length === 0) {
    layers.push({
      name: 'Layer 1',
      color: '#4FFF4F',
      visible: true,
      locked: false,
      outline: false,
      layerType: 'normal',
      frames: [{ index: 0, duration: 1, keyMode: 0, elements: [...shapes] }],
    });
  }
  return { layers, referenceLayers };
}

/**
 * Parse a binary FLA into a {@link FLADocument} the existing viewer/renderer
 * can consume.
 *
 * Decoded and populated: document properties, the symbol library, and — new in
 * the issue #8 follow-up — the LAYER STRUCTURE of every scene and library item
 * (names, types, locked/visible flags), validated byte-for-byte against the
 * fla-decoder reference on real Flash MX 2004 files. NOT decoded (so left
 * empty/placeholder): per-frame timeline content, symbol placements/positions,
 * tweens, and vector shape geometry. The viewer therefore shows a named layer
 * stack per timeline instead of an empty stage, without inventing content.
 */
export function parseBinaryFLA(bytes: Uint8Array): FLADocument {
  const info = extractBinaryFLAInfo(bytes);

  const symbols = new Map<string, Symbol>();
  for (const entry of info.library) {
    const symbolType =
      entry.symbolType === 'unknown' ? 'graphic' : entry.symbolType;
    const binaryLayers = info.symbolLayers.get(entry.symbolNumber) ?? [];
    const shapes = info.symbolShapes.get(entry.symbolNumber) ?? [];
    const { layers, referenceLayers } = buildLayers(binaryLayers, shapes);
    const timeline: Timeline = {
      name: entry.name,
      layers,
      totalFrames: 1,
      referenceLayers,
    };
    const symbol: Symbol = {
      name: entry.name,
      itemID: `Symbol ${entry.symbolNumber}`,
      symbolType,
      timeline,
    };
    symbols.set(entry.name, symbol);
  }

  // One timeline per scene (`Page N`). If no scene streams were found, fall
  // back to a single empty "Scene 1" so the document still opens.
  const timelines: Timeline[] =
    info.scenes.length > 0
      ? info.scenes.map((s) => {
          const shapes = info.sceneShapes.get(s.scene) ?? [];
          const { layers, referenceLayers } = buildLayers(s.layers, shapes);
          return {
            name: `Scene ${s.scene}`,
            layers,
            totalFrames: 1,
            referenceLayers,
          };
        })
      : [
          {
            name: 'Scene 1',
            layers: [],
            totalFrames: 1,
            referenceLayers: new Set<number>(),
          },
        ];

  return {
    width: info.width,
    height: info.height,
    frameRate: info.frameRate,
    backgroundColor: info.backgroundColor,
    timelines,
    symbols,
    bitmaps: new Map(),
    sounds: new Map(),
    videos: new Map(),
  };
}
