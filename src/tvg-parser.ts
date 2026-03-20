import pako from 'pako';

// ── Public Types ──

export interface TVGBitmapTile {
  clipX: number;
  clipY: number;
  clipW: number;
  clipH: number;
  pngData: Uint8Array;
}

export interface TVGDrawing {
  layers: TVGArtLayer[];
  palette: TVGPaletteEntry[];
  bitmapTiles: TVGBitmapTile[];
}

export interface TVGArtLayer {
  type: 'underlay' | 'color' | 'line' | 'overlay';
  shapes: TVGShape[];
}

export interface TVGShape {
  shapeType: number; // 2=fill, 3=stroke, 6=line
  components: TVGComponent[];
}

export interface TVGThicknessControlPoint {
  x: number; // 0..1 relative to interval between this point and the next (fwd) or previous (back)
  y: number; // offset distance from center line
}

export interface TVGThicknessPoint {
  loc: number;
  leftOffset: number;
  leftCtrlBack: TVGThicknessControlPoint;
  leftCtrlFwd: TVGThicknessControlPoint;
  rightOffset: number;
  rightCtrlBack: TVGThicknessControlPoint;
  rightCtrlFwd: TVGThicknessControlPoint;
}

export interface TVGThicknessProfile {
  points: TVGThicknessPoint[];
  domain: [number, number]; // [start, end] - which portion of the thickness path applies
}

export interface TVGComponent {
  componentType: number; // 0=fill, 1=unknown, 2=stroke, 4=pencil
  colorId: bigint | null;
  paletteIndex: number | null; // Palette position index for fills without TGCO
  color: { r: number; g: number; b: number; a: number } | null;
  transform: TVGTransform | null;
  path: TVGPath | null;
  strokeWidth: number | null;
  thicknessProfile: TVGThicknessProfile | null;
}

export interface TVGTransform {
  a: number; // scaleX
  b: number; // skewY
  c: number; // skewX
  d: number; // scaleY
  tx: number;
  ty: number;
}

export interface TVGPath {
  segments: TVGSegment[];
  closed: boolean;
}

export type TVGSegment =
  | { type: 'M'; x: number; y: number }
  | { type: 'L'; x: number; y: number }
  | { type: 'Q'; cx: number; cy: number; x: number; y: number }
  | { type: 'C'; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number };

export interface TVGPaletteEntry {
  name: string;
  id: bigint;
  r: number;
  g: number;
  b: number;
  a: number;
}

// ── Binary Reader ──

class BinaryReader {
  private view: DataView;
  private bytes: Uint8Array;
  pos: number;

  constructor(buffer: ArrayBufferLike, offset = 0) {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    this.pos = offset;
  }

  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  readU8(): number {
    return this.view.getUint8(this.pos++);
  }

  readU16LE(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  readU32LE(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readU32BE(): number {
    const v = this.view.getUint32(this.pos, false);
    this.pos += 4;
    return v;
  }

  readU64LE(): bigint {
    const lo = BigInt(this.view.getUint32(this.pos, true));
    const hi = BigInt(this.view.getUint32(this.pos + 4, true));
    this.pos += 8;
    return (hi << 32n) | lo;
  }

  readF32LE(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readF64LE(): number {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  readBytes(n: number): Uint8Array {
    const slice = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  readTag4(): string {
    return String.fromCharCode(this.bytes[this.pos++], this.bytes[this.pos++], this.bytes[this.pos++], this.bytes[this.pos++]);
  }

  peekTag4(): string {
    return String.fromCharCode(this.bytes[this.pos], this.bytes[this.pos + 1], this.bytes[this.pos + 2], this.bytes[this.pos + 3]);
  }

  skip(n: number): void {
    this.pos += n;
  }

  subReader(length: number): BinaryReader {
    const sub = new BinaryReader(this.bytes.buffer.slice(this.pos, this.pos + length));
    this.pos += length;
    return sub;
  }
}

// ── Tag Constants ──

const TAG_CERT = 'CERT';
const TAG_ENDT = 'ENDT';
const TAG_TVCI = 'TVCI';
const TAG_CREA = 'CREA';
const TAG_UNCO = 'UNCO';
const TAG_ZLIB = 'ZLIB';
const TAG_TPAL = 'TPAL';
const TAG_TTOC = 'TTOC';
const TAG_SIGN = 'SIGN';
const TAG_tUAA = 'tUAA';
const TAG_tCAA = 'tCAA';
const TAG_tLAA = 'tLAA';
const TAG_tOAA = 'tOAA';
const TAG_TGLY = 'TGLY';
const TAG_TGVS = 'TGVS';
const TAG_TGSD = 'TGSD';
const TAG_TGBP = 'TGBP';
const TAG_TGCO = 'TGCO';
// const TAG_TGRV = 'TGRV';
const TAG_TCSC = 'TCSC';
const TAG_TCID = 'TCID';
const TAG_TGBG = 'TGBG';

// ── Main Parser ──

export function parseTVG(buffer: ArrayBufferLike): TVGDrawing {
  const reader = new BinaryReader(buffer);

  // Header
  const magic = reader.readTag4() + reader.readTag4();
  if (magic !== 'OTVGfull') {
    throw new Error(`Invalid TVG magic: "${magic}"`);
  }
  const field1 = reader.readU32LE(); // 1009
  const field2 = reader.readU32LE(); // 2
  const field3 = reader.readU32LE(); // 1
  if (field1 !== 1009 || field2 !== 2 || field3 !== 1) {
    // Not a fatal error, just unexpected version
  }

  const drawing: TVGDrawing = {
    layers: [],
    palette: [],
    bitmapTiles: [],
  };

  // Parse top-level chunks
  while (reader.remaining > 4) {
    const tag = reader.readTag4();

    if (tag === TAG_CERT) {
      const len = reader.readU32LE();
      reader.skip(len); // Skip certificate
    } else if (tag === TAG_ENDT) {
      // End marker, no payload
      // There might be more data after (like UNCO following ENDT after CERT)
    } else if (tag === '\0\0\0\0') {
      // Null tag = MainData (encoded block)
      try {
        const mainData = readEncodedData(reader);
        parseMainData(new BinaryReader(mainData.buffer), drawing);
      } catch (_e) {
        // If we already have layers, this is likely trailing data — stop parsing
        if (drawing.layers.length > 0) break;
      }
    } else if (tag === TAG_UNCO || tag === TAG_ZLIB) {
      // Sometimes the main data starts directly with encoding tag
      reader.pos -= 4; // Back up, readEncodedData will re-read the tag
      try {
        const mainData = readEncodedData(reader);
        parseMainData(new BinaryReader(mainData.buffer), drawing);
      } catch (_e) {
        if (drawing.layers.length > 0) break;
      }
    } else if (tag === TAG_TVCI) {
      const len = reader.readU32LE();
      reader.skip(len);
    } else if (tag === TAG_CREA) {
      // Skip - encoded block or simple value
      if (reader.remaining >= 4) {
        const nextTag = reader.peekTag4();
        if (nextTag === TAG_UNCO || nextTag === TAG_ZLIB) {
          try {
            const data = readEncodedData(reader);
            void data;
          } catch (_e) {
            // Skip remaining
          }
        } else {
          const len = reader.readU32LE();
          if (len > 0 && len <= reader.remaining) {
            reader.skip(len);
          }
        }
      }
    } else if (tag === TAG_TTOC) {
      const len = reader.readU32LE();
      reader.skip(len);
    } else if (tag === TAG_SIGN) {
      const len = reader.readU32LE();
      reader.skip(len);
    } else {
      // Unknown tag - scan forward to find next known tag pattern
      reader.pos -= 4; // back up to re-scan
      if (!scanToNextTopLevelTag(reader)) {
        break;
      }
    }
  }

  // If no vector or bitmap data found, scan raw buffer for TGBG bitmap blocks
  if (drawing.layers.length === 0 && drawing.bitmapTiles.length === 0) {
    scanForBitmapTiles(new Uint8Array(buffer), drawing);
  }

  // Resolve colors: link components' colorId to palette entries
  const paletteMap = new Map<bigint, TVGPaletteEntry>();
  for (const entry of drawing.palette) {
    paletteMap.set(entry.id, entry);
  }

  // Find palette colors by role
  let lineColor: { r: number; g: number; b: number; a: number } | null = null;
  let defaultFillColor: { r: number; g: number; b: number; a: number } | null = null;
  // Utility colors that should not be used as default fill colors.
  // These are rig controls, masks, and invisible markers - not visible content.
  const utilityNames = new Set([
    'line', 'mask', 'invis', 'handles', 'invisible', 'shadow',
    'controller', 'eye_lid_ctrl', 'null', 'transparent',
  ]);

  for (const entry of drawing.palette) {
    const nameLower = entry.name.toLowerCase();
    if (nameLower === 'line' && !lineColor) {
      lineColor = { r: entry.r, g: entry.g, b: entry.b, a: entry.a };
    }
    if (!defaultFillColor && !utilityNames.has(nameLower) && entry.a > 0 &&
        !(entry.r === 0 && entry.g === 0 && entry.b === 0)) {
      defaultFillColor = { r: entry.r, g: entry.g, b: entry.b, a: entry.a };
    }
  }

  for (const layer of drawing.layers) {
    for (const shape of layer.shapes) {
      for (const comp of shape.components) {
        if (comp.colorId !== null) {
          const entry = paletteMap.get(comp.colorId);
          if (entry) {
            comp.color = { r: entry.r, g: entry.g, b: entry.b, a: entry.a };
          }
        }
        // Fills: use paletteIndex as TPAL index to get colorId for external palette resolution.
        // Set colorId from TPAL entry's id so resolveExternalPalette can override with .plt colors.
        // Only fall back to TPAL RGBA if the entry's id is 0 (no external reference).
        if (comp.componentType === 0 && comp.color === null && comp.paletteIndex !== null) {
          const idx = comp.paletteIndex;
          if (idx >= 0 && idx < drawing.palette.length) {
            const entry = drawing.palette[idx];
            const nameLower = entry.name.toLowerCase();
            if (entry.a > 0 && nameLower !== 'line') {
              if (entry.id !== 0n && comp.colorId === null) {
                // Set colorId for external palette resolution
                comp.colorId = entry.id;
              }
              // Set TPAL color as fallback (external palette will override if matched)
              comp.color = { r: entry.r, g: entry.g, b: entry.b, a: entry.a };
            }
          }
        }
        // Strokes without color get the "Line" palette color, or default to black
        if ((comp.componentType === 2 || comp.componentType === 4) && comp.color === null) {
          comp.color = lineColor ? { ...lineColor } : { r: 0, g: 0, b: 0, a: 255 };
        }
      }

      // Fill color inheritance: fills without color inherit from preceding colored fill
      const fills = shape.components.filter(c => c.componentType === 0);
      let lastColor: { r: number; g: number; b: number; a: number } | null = null;
      for (const fill of fills) {
        if (fill.color !== null) {
          lastColor = fill.color;
        } else if (lastColor !== null) {
          fill.color = { ...lastColor };
        }
      }
      // If still no fills have color, apply TPAL heuristic default
      if (defaultFillColor && fills.length > 0 && !fills.some(f => f.color !== null)) {
        fills[0].color = { ...defaultFillColor };
        // Re-run inheritance from this seed
        lastColor = defaultFillColor;
        for (let i = 1; i < fills.length; i++) {
          if (fills[i].color === null) {
            fills[i].color = { ...lastColor };
          } else {
            lastColor = fills[i].color!;
          }
        }
      }
    }
  }

  return drawing;
}

// ── Encoded Data Reading ──

/** Scan forward to find the next recognized top-level tag or null+UNCO/ZLIB pattern. */
function scanToNextTopLevelTag(reader: BinaryReader): boolean {
  const knownTopTags = new Set([
    TAG_CERT, TAG_ENDT, TAG_TVCI, TAG_CREA, TAG_TTOC, TAG_SIGN,
    TAG_UNCO, TAG_ZLIB,
  ]);
  while (reader.remaining >= 4) {
    const peek = reader.peekTag4();
    if (peek === '\0\0\0\0' || knownTopTags.has(peek)) {
      return true;
    }
    reader.skip(1);
  }
  return false;
}

function readEncodedData(reader: BinaryReader): Uint8Array {
  const encoding = reader.readTag4();

  if (encoding === TAG_UNCO) {
    const len = reader.readU32LE();
    return reader.readBytes(len);
  } else if (encoding === TAG_ZLIB) {
    const totalLen = reader.readU32LE();
    const decompLen = reader.readU32LE();
    const compressedLen = totalLen - 4;
    const compressed = reader.readBytes(compressedLen);
    try {
      const decompressed = pako.inflate(compressed);
      return decompressed;
    } catch (_e) {
      // Try raw deflate if zlib fails
      try {
        return pako.inflateRaw(compressed);
      } catch (_e2) {
        return new Uint8Array(decompLen);
      }
    }
  } else {
    throw new Error(`Unknown encoding: "${encoding}"`);
  }
}

// ── Inner Tag Format (used by TGBG bitmap blocks) ──
// Format: 4-byte tag + 1-byte type + variable length bytes
// type 0x01 → 1 length byte, 0x03 → 2 bytes LE, 0x07 → 3 bytes LE

function readInnerTagLength(reader: BinaryReader): number {
  const type = reader.readU8();
  if (type === 0x01) return reader.readU8();
  if (type === 0x03) return reader.readU16LE();
  if (type === 0x07) { const lo = reader.readU16LE(); const hi = reader.readU8(); return lo | (hi << 16); }
  return -1;
}

function readInnerTagAt(data: Uint8Array, pos: number): { tag: string; contentStart: number; contentLen: number } | null {
  if (pos + 5 > data.length) return null;
  const tag = String.fromCharCode(data[pos], data[pos+1], data[pos+2], data[pos+3]);
  const type = data[pos + 4];
  let len = 0, hdrSize = 5;
  // Type byte encodes length size: bit pattern determines byte count
  // Low bit may be leaf/container flag; length bytes determined by upper bits
  const lenBytes = (type >> 1) & 0x03; // 0→0, 1→1, 2→2, 3→3
  if (lenBytes === 0) { len = data[pos + 5]; hdrSize = 6; }
  else if (lenBytes === 1) { len = data[pos + 5] | (data[pos + 6] << 8); hdrSize = 7; }
  else if (lenBytes === 2 || lenBytes === 3) { len = data[pos + 5] | (data[pos + 6] << 8) | (data[pos + 7] << 16); hdrSize = 8; }
  else return null;
  return { tag, contentStart: pos + hdrSize, contentLen: len };
}

function findPNG(data: Uint8Array, start: number, end: number): { start: number; end: number } | null {
  for (let i = start; i < end - 8; i++) {
    if (data[i] === 0x89 && data[i+1] === 0x50 && data[i+2] === 0x4E && data[i+3] === 0x47 &&
        data[i+4] === 0x0D && data[i+5] === 0x0A && data[i+6] === 0x1A && data[i+7] === 0x0A) {
      // Find IEND marker
      for (let e = i + 8; e < end - 7; e++) {
        if (data[e] === 0x49 && data[e+1] === 0x45 && data[e+2] === 0x4E && data[e+3] === 0x44) {
          return { start: i, end: e + 8 }; // +8 for IEND length(4) + tag(4) + CRC(4)... actually IEND chunk is len(4)+IEND(4)+CRC(4)=12
        }
      }
    }
  }
  return null;
}

function parseTGBGTiles(data: Uint8Array, tiles: TVGBitmapTile[]): void {
  // Scan for TBBM (tile) blocks within the TGBG hierarchy
  // TBBM contains TBBH header with: TBBD (tile grid size), TBBC (canvas bounds), TBBA (tile rect)
  // TBBA format: (x, y, width, height) as 4x int32 LE — matches the PNG pixel dimensions
  for (let i = 0; i < data.length - 5; i++) {
    if (data[i] !== 0x54 || data[i+1] !== 0x42 || data[i+2] !== 0x42 || data[i+3] !== 0x4D) continue; // 'TBBM'

    const tbbm = readInnerTagAt(data, i);
    if (!tbbm || tbbm.contentLen < 10) continue;

    const tEnd = tbbm.contentStart + tbbm.contentLen;

    // Find TBBA (tile position/size) within TBBM/TBBH
    let clipX = 0, clipY = 0, clipW = 0, clipH = 0;
    for (let j = tbbm.contentStart; j < Math.min(tEnd, tbbm.contentStart + 200) - 5; j++) {
      if (data[j] === 0x54 && data[j+1] === 0x42 && data[j+2] === 0x42 && data[j+3] === 0x41) { // 'TBBA'
        const tbba = readInnerTagAt(data, j);
        if (tbba && tbba.contentLen >= 16) {
          const dv = new DataView(data.buffer, data.byteOffset + tbba.contentStart, 16);
          clipX = dv.getInt32(0, true);  // x position
          clipY = dv.getInt32(4, true);  // y position
          clipW = dv.getInt32(8, true);  // width (matches PNG width)
          clipH = dv.getInt32(12, true); // height (matches PNG height)
        }
        break;
      }
    }

    // Find PNG in this TBBM
    const png = findPNG(data, tbbm.contentStart, tEnd);
    if (png && png.end - png.start > 100 && clipW > 0 && clipH > 0) {
      tiles.push({
        clipX, clipY, clipW, clipH,
        pngData: data.slice(png.start, png.end),
      });
    }

    // Skip to end of this TBBM
    i = tEnd - 1;
  }
}

/** Scan the entire raw TVG buffer for bitmap tile data (TBBM blocks).
 *  Searches UNCO/ZLIB blocks for TGBG markers, then extracts all TBBM tiles
 *  from the containing decoded data (bypassing TGBG length parsing). */
function scanForBitmapTiles(raw: Uint8Array, drawing: TVGDrawing): void {
  const scanDecodedForTiles = (decoded: Uint8Array, depth: number): boolean => {
    // Check if this block contains TGBG
    let hasTGBG = false;
    for (let j = 0; j < decoded.length - 4; j++) {
      if (decoded[j] === 0x54 && decoded[j+1] === 0x47 && decoded[j+2] === 0x42 && decoded[j+3] === 0x47) {
        hasTGBG = true;
        break;
      }
    }

    if (hasTGBG) {
      // Scan the entire decoded block for TBBM tiles (don't rely on TGBG length)
      parseTGBGTiles(decoded, drawing.bitmapTiles);
      if (drawing.bitmapTiles.length > 0) return true;
    }

    // Recurse into nested UNCO/ZLIB blocks (e.g. TLAB wrappers)
    if (depth < 3) {
      for (let j = 0; j < decoded.length - 8; j++) {
        if (decoded[j] === 0x55 && decoded[j+1] === 0x4E && decoded[j+2] === 0x43 && decoded[j+3] === 0x4F) { // UNCO
          const innerLen = decoded[j+4] | (decoded[j+5] << 8) | (decoded[j+6] << 16) | (decoded[j+7] << 24);
          if (innerLen > 0 && innerLen <= decoded.length - j - 8) {
            if (scanDecodedForTiles(decoded.slice(j + 8, j + 8 + innerLen), depth + 1)) return true;
            j += 8 + innerLen - 1;
          }
        } else if (decoded[j] === 0x5A && decoded[j+1] === 0x4C && decoded[j+2] === 0x49 && decoded[j+3] === 0x42) { // ZLIB
          const tl = decoded[j+4] | (decoded[j+5] << 8) | (decoded[j+6] << 16) | (decoded[j+7] << 24);
          if (tl > 4 && tl <= decoded.length - j - 8) {
            try {
              const inner = pako.inflate(decoded.slice(j + 12, j + 12 + tl - 4));
              if (scanDecodedForTiles(inner, depth + 1)) return true;
            } catch { /* skip */ }
            j += 8 + tl - 1;
          }
        }
      }
    }
    return false;
  };

  for (let i = 20; i < raw.length - 8; i++) {
    const b0 = raw[i], b1 = raw[i+1], b2 = raw[i+2], b3 = raw[i+3];
    // UNCO block
    if (b0 === 0x55 && b1 === 0x4E && b2 === 0x43 && b3 === 0x4F) {
      const len = raw[i+4] | (raw[i+5] << 8) | (raw[i+6] << 16) | (raw[i+7] << 24);
      if (len <= 0 || len > raw.length - i - 8) continue;
      const decoded = raw.slice(i + 8, i + 8 + len);
      if (scanDecodedForTiles(decoded, 0)) return;
      i += 8 + len - 1;
    }
    // ZLIB block
    if (b0 === 0x5A && b1 === 0x4C && b2 === 0x49 && b3 === 0x42) {
      const totalLen = raw[i+4] | (raw[i+5] << 8) | (raw[i+6] << 16) | (raw[i+7] << 24);
      if (totalLen <= 4 || totalLen > raw.length - i - 8) continue;
      const compressedLen = totalLen - 4;
      if (compressedLen <= 0 || i + 12 + compressedLen > raw.length) continue;
      try {
        const decoded = pako.inflate(raw.slice(i + 12, i + 12 + compressedLen));
        if (scanDecodedForTiles(decoded, 0)) return;
      } catch { /* skip */ }
      i += 8 + totalLen - 1;
    }
  }
}

// ── Main Data Parsing ──

function parseMainData(reader: BinaryReader, drawing: TVGDrawing): void {
  while (reader.remaining > 4) {
    const tag = reader.readTag4();

    if (tag === '\0\0\0\0') {
      // Null marker — continue to next tag
      continue;
    } else if (tag === 'TLAB') {
      // Layer block wrapper — contains the actual art layer data
      try {
        const data = readEncodedData(reader);
        parseMainData(new BinaryReader(data.buffer), drawing);
      } catch (_e) {
        // Skip unparseable TLAB
      }
    } else if (tag === TAG_TVCI) {
      // Software identity - encoded block, skip
      try {
        const data = readEncodedData(reader);
        void data;
      } catch (_e) {
        break;
      }
    } else if (tag === TAG_CREA) {
      try {
        const data = readEncodedData(reader);
        void data;
      } catch (_e) {
        break;
      }
    } else if (tag === 'AUIF') {
      // Audio info, skip
      try {
        const data = readEncodedData(reader);
        void data;
      } catch (_e) {
        break;
      }
    } else if (tag === TAG_tUAA || tag === TAG_tCAA || tag === TAG_tLAA || tag === TAG_tOAA) {
      const layerType = tag === TAG_tUAA ? 'underlay'
        : tag === TAG_tCAA ? 'color'
        : tag === TAG_tLAA ? 'line'
        : 'overlay';

      try {
        const data = readEncodedData(reader);
        const layer = parseArtLayer(new BinaryReader(data.buffer), layerType);
        if (layer.shapes.length > 0) {
          drawing.layers.push(layer);
        }
      } catch (_e) {
        // Skip unparseable layer
      }
    } else if (tag === TAG_TPAL) {
      try {
        const data = readEncodedData(reader);
        drawing.palette = parsePalette(new BinaryReader(data.buffer));
      } catch (_e) {
        // Skip palette errors
      }
    } else if (tag === TAG_TGBG) {
      // Bitmap group — contains tiled PNG data
      try {
        const tgbgLen = readInnerTagLength(reader);
        if (tgbgLen > 0 && tgbgLen <= reader.remaining) {
          const tgbgData = reader.readBytes(tgbgLen);
          parseTGBGTiles(tgbgData, drawing.bitmapTiles);
        }
      } catch (_e) {
        // Skip unparseable TGBG
      }
    } else if (tag === TAG_ENDT) {
      break;
    } else if (tag === TAG_TTOC) {
      const len = reader.readU32LE();
      reader.skip(len);
    } else if (tag === TAG_SIGN) {
      const len = reader.readU32LE();
      reader.skip(len);
    } else {
      // Unknown tag in main data - try length-skip
      if (reader.remaining >= 4) {
        const len = reader.readU32LE();
        if (len > 0 && len <= reader.remaining) {
          reader.skip(len);
        } else {
          break;
        }
      } else {
        break;
      }
    }
  }
}

// ── Art Layer Parsing ──

function parseArtLayer(reader: BinaryReader, type: TVGArtLayer['type']): TVGArtLayer {
  const layer: TVGArtLayer = { type, shapes: [] };

  if (reader.remaining < 6) return layer;

  // Preamble
  const dataType = reader.readU16LE();
  if (dataType === 0x0000) return layer; // Empty layer

  const shapeCount = reader.readU32LE();

  // Skip any extra preamble bytes (seen: 4 extra bytes before TGLY)
  // Look for TGLY tag
  for (let s = 0; s < shapeCount && reader.remaining > 8; s++) {
    // Find next TGLY tag
    if (!scanToTag(reader, TAG_TGLY)) break;

    const shapeLen = reader.readU32LE();
    if (shapeLen > reader.remaining) break;

    const shapeEnd = reader.pos + shapeLen;
    const shapeType = reader.readU16LE();
    const componentCount = reader.readU32LE();

    const shape: TVGShape = { shapeType, components: [] };

    let lastTGTBWidth: number | null = null;
    let lastTGTBProfile: TVGThicknessProfile | null = null;
    for (let c = 0; c < componentCount && reader.pos < shapeEnd; c++) {
      // Find next TGVS
      if (!scanToTag(reader, TAG_TGVS)) break;

      const vsLen = reader.readU32LE();
      if (vsLen > reader.remaining) break;

      const vsEnd = reader.pos + vsLen;
      const comp = parseComponent(reader, vsEnd, lastTGTBWidth, lastTGTBProfile);
      if (comp) {
        shape.components.push(comp);
        // Track last tGTB width and profile for "reference to previous" inheritance
        if (comp.strokeWidth !== null && comp.strokeWidth > 0.1) {
          lastTGTBWidth = comp.strokeWidth;
        }
        if (comp.thicknessProfile) {
          lastTGTBProfile = comp.thicknessProfile;
        }
      }

      reader.pos = vsEnd; // Ensure we advance past the TGVS block
    }

    if (shape.components.length > 0) {
      layer.shapes.push(shape);
    }

    reader.pos = shapeEnd; // Ensure we advance past the TGLY block
  }

  // Type-5 path borrowing: type-5 shapes' N-1 pencil components
  // borrow paths from the preceding type-1 shape's N fill components.
  for (let si = 1; si < layer.shapes.length; si++) {
    const shape = layer.shapes[si];
    if (shape.shapeType !== 5) continue;
    const prev = layer.shapes[si - 1];
    if (prev.shapeType !== 1) continue;

    const prevFills = prev.components.filter(c => c.componentType === 0 && c.path && c.path.segments.length > 0);
    const pencils = shape.components.filter(c => c.componentType === 4 && (!c.path || c.path.segments.length === 0));

    // Assign paths from fill components to pencil components
    for (let pi = 0; pi < pencils.length && pi < prevFills.length; pi++) {
      pencils[pi].path = prevFills[pi].path;
    }
  }

  return layer;
}

function scanToTag(reader: BinaryReader, tag: string): boolean {
  // Look for the tag within the next few bytes
  const startPos = reader.pos;
  const maxScan = Math.min(reader.remaining, 64);
  for (let i = 0; i < maxScan - 3; i++) {
    if (reader.peekTag4() === tag) {
      reader.skip(4); // consume the tag
      return true;
    }
    reader.skip(1);
  }
  reader.pos = startPos;
  return false;
}

// ── Component Parsing ──

function parseComponent(reader: BinaryReader, endPos: number, prevTGTBWidth?: number | null, prevTGTBProfile?: TVGThicknessProfile | null): TVGComponent | null {
  const comp: TVGComponent = {
    componentType: -1,
    colorId: null,
    paletteIndex: null,
    color: null,
    transform: null,
    path: null,
    strokeWidth: null,
    thicknessProfile: null,
  };

  while (reader.pos < endPos - 4) {
    const tag = reader.readTag4();

    if (tag === TAG_TGSD) {
      const sdLen = reader.readU32LE();
      if (sdLen > reader.remaining) { reader.pos = endPos; return null; }
      const sdEnd = reader.pos + sdLen;
      parseTGSD(reader, comp, sdLen);
      reader.pos = sdEnd;
    } else if (tag === TAG_TGCO) {
      const coLen = reader.readU32LE();
      if (coLen > reader.remaining) { reader.pos = endPos; return null; }
      const coEnd = reader.pos + coLen;
      parseTGCO(reader, comp, coLen);
      reader.pos = coEnd;
    } else if (tag === TAG_TGBP) {
      const bpLen = reader.readU32LE();
      if (bpLen > reader.remaining) { reader.pos = endPos; return null; }
      const bpEnd = reader.pos + bpLen;
      comp.path = parseTGBP(reader, bpLen);
      reader.pos = bpEnd;
    } else if (tag === 'tGTB') {
      // Pencil thickness: extract thickness profile and max width
      const len = reader.readU32LE();
      if (len > reader.remaining) { reader.skip(Math.min(len, reader.remaining)); } else {
        const tbEnd = reader.pos + len;
        const result = parseTGTB(reader, len, prevTGTBProfile || null);
        if (result) {
          comp.strokeWidth = result.maxWidth;
          comp.thicknessProfile = result.profile;
        }
        // Fallback: inherit width from previous component if type=0x00 returned null
        if (comp.strokeWidth === null && prevTGTBWidth != null) {
          comp.strokeWidth = prevTGTBWidth;
        }
        reader.pos = tbEnd;
      }
    } else if (tag === 'tGTI') {
      // Stroke properties (fallback width if tGTB didn't set one)
      const len = reader.readU32LE();
      if (len >= 16 && reader.remaining >= len) {
        const tiEnd = reader.pos + len;
        reader.skip(8); // sentinel
        if (comp.strokeWidth === null) {
          comp.strokeWidth = reader.readF64LE();
        }
        reader.pos = tiEnd;
      } else {
        reader.skip(Math.min(len, reader.remaining));
      }
    } else {
      // Check if it looks like a separator byte (0x00 or 0x01)
      reader.pos -= 4;
      if (reader.pos < endPos) {
        const b = reader.readU8();
        if (b !== 0x00 && b !== 0x01) {
          // Unknown data, try to continue
          reader.pos -= 1;
          // Scan forward to next known tag
          if (!scanToNextKnownTag(reader, endPos)) {
            reader.pos = endPos;
            return comp;
          }
        }
      }
    }
  }

  return comp;
}

function scanToNextKnownTag(reader: BinaryReader, endPos: number): boolean {
  const knownTags = [TAG_TGSD, TAG_TGCO, TAG_TGBP, 'tGTB', 'tGTI'];
  while (reader.pos < endPos - 4) {
    const peek = reader.peekTag4();
    if (knownTags.includes(peek)) return true;
    reader.skip(1);
  }
  return false;
}

// ── TGSD Parsing ──
// TGSD contains the component type and may embed a TGCO sub-tag with color info.

function parseTGSD(reader: BinaryReader, comp: TVGComponent, len: number): void {
  if (len < 1) return;
  const sdStart = reader.pos;
  const sdEnd = sdStart + len;

  comp.componentType = reader.readU8();

  if (comp.componentType === 0) {
    // Fill component: byte 1 is a flag for embedded color presence
    // 0x01 = has embedded TGCO sub-tag with color UID
    // 0x00 = no embedded color (needs external project palette / inheritance)
    if (len >= 2) {
      const hasColor = reader.readU8();
      if (hasColor === 0x01) {
        // Scan for embedded TGCO tag to extract transform data
        scanAndParseTGCO(reader, comp, sdEnd);
        // Color ID is always 24 bytes from end of TGSD (per Rust reference)
        // This is correct for ALL TGSD sizes (85, 133, etc.)
        if (len >= 26) {
          reader.pos = sdStart + len - 24;
          comp.colorId = reader.readU64LE();
        }
      } else if (hasColor === 0x00) {
        // No embedded color - needs palette resolution or inheritance
        // Read palette index from offset 2 (u32) for potential palette lookup
        if (len >= 6) {
          comp.paletteIndex = reader.readU32LE();
        }
      }
    }
  } else if (comp.componentType === 4) {
    // Pencil component: has inline color ID
    // Skip float32 value (brush size ~10.0)
    if (reader.remaining >= 12) {
      reader.skip(4); // f32
      comp.colorId = reader.readU64LE();
    }
  } else if (comp.componentType === 2) {
    // Brush stroke: similar structure to fill — check for embedded color
    if (len >= 2) {
      const hasColor = reader.readU8();
      if (hasColor === 0x01) {
        scanAndParseTGCO(reader, comp, sdEnd);
        if (len >= 26) {
          reader.pos = sdStart + len - 24;
          comp.colorId = reader.readU64LE();
        }
      }
    }
  }

  reader.pos = sdEnd;
}

/** Scan within TGSD data for an embedded TGCO sub-tag and parse it. */
function scanAndParseTGCO(reader: BinaryReader, comp: TVGComponent, endPos: number): void {
  const scanStart = reader.pos;
  while (reader.pos < endPos - 8) {
    if (reader.peekTag4() === TAG_TGCO) {
      reader.skip(4); // consume TGCO tag
      const coLen = reader.readU32LE();
      const coEnd = reader.pos + coLen;
      if (coEnd <= endPos) {
        parseTGCO(reader, comp, coLen);
        reader.pos = coEnd;
        return;
      }
    }
    reader.skip(1);
  }
  reader.pos = scanStart;
}

// ── TGCO Parsing ──

function parseTGCO(reader: BinaryReader, comp: TVGComponent, len: number): void {
  if (len < 57) return;

  const colorType = reader.readU8(); // 1 = solid fill
  void colorType;

  // 2x3 affine transform (float64)
  const a = reader.readF64LE();  // scaleX
  const c = reader.readF64LE();  // skewX
  const b = reader.readF64LE();  // skewY
  const d = reader.readF64LE();  // scaleY
  const tx = reader.readF64LE(); // translateX
  const ty = reader.readF64LE(); // translateY

  comp.transform = { a, b, c, d, tx, ty };

  // Read colorId from remaining bytes (8-byte UID after the 49-byte header+transform).
  // For componentType 0 fills, this gets overwritten by parseTGSD (TGSD offset len-24).
  // For componentType 2 strokes, this standalone TGCO is the only source of colorId.
  if (len >= 57 && comp.colorId === null) {
    comp.colorId = reader.readU64LE();
  }
}

// ── tGTB Parsing (Pencil Thickness) ──

/**
 * Parse tGTB pencil thickness data, returning the full profile and max width.
 * tGTB format:
 *   type(u8) + id(u32) + marker(u16 LE, must be 0x00CF) + pointCount(u32) + points...
 *   Each point: loc(f32) + left_offset(f32) + left_ctrl_back(2xf32) + left_ctrl_fwd(2xf32)
 *               + right_offset(f32) + right_ctrl_back(2xf32) + right_ctrl_fwd(2xf32) = 11 f32s
 *   After points: 5-byte trailer + domain(f32 + u64 + f32 + u64)
 *
 * For type=0x00 (reference to previous): type(u8) + id(u32) + domain(f32+u64+f32+u64)
 */
function parseTGTB(
  reader: BinaryReader, len: number, prevProfile: TVGThicknessProfile | null,
): { maxWidth: number; profile: TVGThicknessProfile } | null {
  if (len < 10) return null;
  const startPos = reader.pos;
  const endPos = startPos + len;

  try {
    const type = reader.readU8();

    if (type === 0x00) {
      // Reference to previous thickness profile — reuse definition, read new domain
      reader.readU32LE(); // id
      const domain = readTGTBDomain(reader, endPos);
      if (prevProfile && domain) {
        // Reuse previous profile's points with new domain
        const profile: TVGThicknessProfile = {
          points: prevProfile.points,
          domain,
        };
        let maxWidth = 0;
        for (const pt of profile.points) {
          const w = pt.leftOffset + pt.rightOffset;
          if (w > maxWidth) maxWidth = w;
        }
        return { maxWidth, profile };
      }
      return null;
    }
    if (type !== 0x01) return null;

    reader.readU32LE(); // color/id reference (often 0xFFFFFFFF)
    const marker = reader.readU16LE(); // 0x00CF
    if (marker !== 0xCF) return null;

    const pointCount = reader.readU32LE();
    if (pointCount === 0 || pointCount > 1000) return null;

    const needed = pointCount * 44;
    if (reader.remaining < needed) return null;

    let maxWidth = 0;
    const points: TVGThicknessPoint[] = [];

    for (let i = 0; i < pointCount; i++) {
      const loc = reader.readF32LE();
      const leftOffset = reader.readF32LE();
      const lbX = reader.readF32LE();
      const lbY = reader.readF32LE();
      const lfX = reader.readF32LE();
      const lfY = reader.readF32LE();
      const rightOffset = reader.readF32LE();
      const rbX = reader.readF32LE();
      const rbY = reader.readF32LE();
      const rfX = reader.readF32LE();
      const rfY = reader.readF32LE();

      points.push({
        loc,
        leftOffset,
        leftCtrlBack: { x: lbX, y: lbY },
        leftCtrlFwd: { x: lfX, y: lfY },
        rightOffset,
        rightCtrlBack: { x: rbX, y: rbY },
        rightCtrlFwd: { x: rfX, y: rfY },
      });

      const width = leftOffset + rightOffset;
      if (width > maxWidth) maxWidth = width;
    }

    // Read 5-byte trailer (expected to be zeros)
    if (reader.pos + 5 <= endPos) {
      reader.skip(5);
    }

    // Read domain
    const domain = readTGTBDomain(reader, endPos);

    if (maxWidth <= 0) return null;
    return { maxWidth, profile: { points, domain: domain || [0, 1] } };
  } catch (_e) {
    reader.pos = startPos;
    return null;
  }
}

/** Read the tGTB domain: f32(start) + u64(unknown) + f32(end) + u64(unknown) = 24 bytes */
function readTGTBDomain(reader: BinaryReader, endPos: number): [number, number] | null {
  if (reader.pos + 24 > endPos) return null;
  try {
    const domainStart = reader.readF32LE();
    reader.skip(8); // unknown u64
    const domainEnd = reader.readF32LE();
    reader.skip(8); // unknown u64
    return [domainStart, domainEnd];
  } catch (_e) {
    return null;
  }
}

// ── TGBP Parsing (Bezier Path) ──

function parseTGBP(reader: BinaryReader, len: number): TVGPath | null {
  if (len < 4) return null;

  const numPoints = reader.readU32LE();
  if (numPoints === 0 || numPoints > 100000) return null;

  // Read flag bits (1 bit per point, packed LSB first)
  const flagByteCount = Math.ceil(numPoints / 8);
  if (reader.remaining < flagByteCount) return null;
  const flagBytes = reader.readBytes(flagByteCount);

  // Read points (float32 x,y pairs)
  const pointByteCount = numPoints * 8;
  if (reader.remaining < pointByteCount) return null;

  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < numPoints; i++) {
    const x = reader.readF32LE();
    const y = reader.readF32LE();
    points.push({ x, y });
  }

  // Decode flag bits: on-curve (1) vs off-curve (0), TrueType-style
  // bit=1: on-curve point (line endpoint or bezier endpoint)
  // bit=0: off-curve point (bezier control point)
  // Consecutive off-curve points are collected until an on-curve point:
  //   0 off-curve + on-curve = Line-to
  //   1 off-curve + on-curve = Quadratic bezier
  //   2 off-curve + on-curve = Cubic bezier
  // This is equivalent to cpsdqs/tvg's segment-type bitstream interpretation:
  //   "1" = line (1 point), "01" = quadratic (2 points), "001" = cubic (3 points)
  // Bit 0 is for the moveTo point (always on-curve, never checked in segment loop).
  const onCurve: boolean[] = [];
  for (let i = 0; i < numPoints; i++) {
    const byteIdx = Math.floor(i / 8);
    const bitIdx = i % 8;
    onCurve.push(((flagBytes[byteIdx] >> bitIdx) & 1) === 1);
  }

  // Build segments
  const segments: TVGSegment[] = [];
  let pointIdx = 0;

  if (numPoints > 0) {
    // First point is always a move-to
    segments.push({ type: 'M', x: points[0].x, y: points[0].y });
    pointIdx = 1;
  }

  while (pointIdx < numPoints) {
    if (onCurve[pointIdx]) {
      // On-curve point with no preceding off-curve → line-to
      segments.push({ type: 'L', x: points[pointIdx].x, y: points[pointIdx].y });
      pointIdx++;
    } else {
      // Collect consecutive off-curve (control) points
      const controlStart = pointIdx;
      while (pointIdx < numPoints && !onCurve[pointIdx]) {
        pointIdx++;
      }
      const controlCount = pointIdx - controlStart;

      // The next on-curve point is the endpoint
      if (pointIdx < numPoints) {
        const endPt = points[pointIdx];
        pointIdx++; // consume the on-curve endpoint

        if (controlCount === 1) {
          // Quadratic bezier: 1 control point + endpoint
          const cp = points[controlStart];
          segments.push({ type: 'Q', cx: cp.x, cy: cp.y, x: endPt.x, y: endPt.y });
        } else if (controlCount === 2) {
          // Cubic bezier: 2 control points + endpoint
          const cp1 = points[controlStart];
          const cp2 = points[controlStart + 1];
          segments.push({ type: 'C', c1x: cp1.x, c1y: cp1.y, c2x: cp2.x, c2y: cp2.y, x: endPt.x, y: endPt.y });
        } else {
          // More than 2 off-curve: split into multiple cubics
          for (let i = 0; i < controlCount; i += 2) {
            if (i + 1 < controlCount) {
              const cp1 = points[controlStart + i];
              const cp2 = points[controlStart + i + 1];
              const ep = (i + 2 >= controlCount) ? endPt : {
                x: (points[controlStart + i + 1].x + points[controlStart + i + 2].x) / 2,
                y: (points[controlStart + i + 1].y + points[controlStart + i + 2].y) / 2,
              };
              segments.push({ type: 'C', c1x: cp1.x, c1y: cp1.y, c2x: cp2.x, c2y: cp2.y, x: ep.x, y: ep.y });
            } else {
              // Single remaining control point → quadratic
              const cp = points[controlStart + i];
              segments.push({ type: 'Q', cx: cp.x, cy: cp.y, x: endPt.x, y: endPt.y });
            }
          }
        }
      } else {
        // Off-curve points at the end with no on-curve endpoint — treat as lines
        for (let i = controlStart; i < controlStart + controlCount; i++) {
          segments.push({ type: 'L', x: points[i].x, y: points[i].y });
        }
      }
    }
  }

  // Check if closed (first point ~= last point)
  let closed = false;
  if (points.length >= 2) {
    const first = points[0];
    const last = points[points.length - 1];
    const dx = Math.abs(first.x - last.x);
    const dy = Math.abs(first.y - last.y);
    closed = dx < 0.001 && dy < 0.001;
  }

  return { segments, closed };
}

// ── Palette Parsing ──

function parsePalette(reader: BinaryReader): TVGPaletteEntry[] {
  const entries: TVGPaletteEntry[] = [];

  if (reader.remaining < 8) return entries;

  const colorCount = reader.readU32LE();
  reader.readU32LE(); // startMarker 0x79

  for (let i = 0; i < colorCount && reader.remaining > 4; i++) {
    const entry: TVGPaletteEntry = { name: '', id: 0n, r: 0, g: 0, b: 0, a: 255 };

    // Read header u16
    if (reader.remaining < 2) break;
    reader.readU16LE(); // header (0)

    // Read sub-tags until terminator 0x79000000
    while (reader.remaining > 4) {
      const tag = reader.readTag4();

      if (tag === TAG_TCSC) {
        const len = reader.readU32LE();
        if (len >= 4 && reader.remaining >= 4) {
          entry.r = reader.readU8();
          entry.g = reader.readU8();
          entry.b = reader.readU8();
          entry.a = reader.readU8();
          if (len > 4) reader.skip(len - 4);
        } else {
          reader.skip(Math.min(len, reader.remaining));
        }
      } else if (tag === TAG_TCID) {
        const len = reader.readU32LE();
        if (len < 12 || reader.remaining < len) {
          reader.skip(Math.min(len, reader.remaining));
          continue;
        }
        const idEnd = reader.pos + len;

        // Name: u32 charCount + UTF-16LE
        const nameCharCount = reader.readU32LE();
        if (nameCharCount > 0 && nameCharCount < 1000 && reader.remaining >= nameCharCount * 2) {
          const nameBytes = reader.readBytes(nameCharCount * 2);
          entry.name = decodeUTF16LE(nameBytes);
        }

        // Color ID (u64)
        if (reader.remaining >= 8) {
          entry.id = reader.readU64LE();
        }

        // Skip rest (project name etc.)
        reader.pos = idEnd;
      } else {
        // Check if this is the terminator (0x79 0x00 0x00 0x00)
        reader.pos -= 4;
        if (reader.remaining >= 4) {
          const val = reader.readU32LE();
          if (val === 0x00000079) {
            // Terminator - entry complete
            break;
          }
          // Not a terminator - skip unknown data
          // Try to find next TCSC, TCID, or terminator
        }
      }
    }

    entries.push(entry);
  }

  return entries;
}

function decodeUTF16LE(bytes: Uint8Array): string {
  const chars: string[] = [];
  for (let i = 0; i < bytes.length - 1; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    if (code === 0) break;
    chars.push(String.fromCharCode(code));
  }
  return chars.join('');
}

// ── External Palette Resolution ──

export interface ExternalPaletteColor {
  r: number; g: number; b: number; a: number;
  id: string; // hex ID string like "0xABC123"
}

/**
 * Resolve colors for a TVG drawing using an external project palette (.plt).
 * The external palette provides colors by UID matching.
 */
export function resolveExternalPalette(
  drawing: TVGDrawing,
  externalColors: ExternalPaletteColor[],
): void {
  // Build a map from palette color UID to RGBA
  // The .plt IDs are hex strings like "0xABC123" - convert to bigint for matching
  const extMap = new Map<bigint, ExternalPaletteColor>();
  for (const color of externalColors) {
    try {
      const id = BigInt(color.id);
      extMap.set(id, color);
    } catch (_e) {
      // Skip invalid IDs
    }
  }

  for (const layer of drawing.layers) {
    for (const shape of layer.shapes) {
      for (const comp of shape.components) {
        if (comp.colorId !== null) {
          const ext = extMap.get(comp.colorId);
          if (ext) {
            // External palette always overrides (more authoritative than internal TPAL)
            comp.color = { r: ext.r, g: ext.g, b: ext.b, a: ext.a };
          }
        }
      }
      // Re-apply fill inheritance after external palette resolution
      const fills = shape.components.filter(c => c.componentType === 0);
      let lastColor: { r: number; g: number; b: number; a: number } | null = null;
      for (const fill of fills) {
        if (fill.color !== null) {
          lastColor = fill.color;
        } else if (lastColor !== null) {
          fill.color = { ...lastColor };
        }
      }
    }
  }
}

// ── Canvas Rendering ──

/**
 * Render a TVG drawing to an HTMLCanvasElement.
 * Returns the canvas element, or null if the drawing has no renderable content.
 */
export interface TVGRenderOptions {
  /** Include underlay art layer (Mask colors). Default: false (skip for clean render). */
  includeUnderlay?: boolean;
  /** Filter to render only a specific art layer type.
   *  'all' or undefined → current behavior (all visible layers).
   *  'color' → only tCAA (color art layer).
   *  'line' → only tLAA (line art layer).
   *  'overlay' → only tOAA (overlay art layer). */
  artLayerFilter?: 'all' | 'color' | 'line' | 'overlay';
}

export function renderTVGToCanvas(
  drawing: TVGDrawing,
  width: number,
  height: number,
  viewport?: number,
  options?: TVGRenderOptions,
): HTMLCanvasElement | null {
  // Check for any vector data
  let hasVectors = false;
  for (const layer of drawing.layers) {
    for (const shape of layer.shapes) {
      for (const comp of shape.components) {
        if (comp.path && comp.path.segments.length > 0) { hasVectors = true; break; }
      }
      if (hasVectors) break;
    }
    if (hasVectors) break;
  }

  if (!hasVectors) {
    // No vector data — try bitmap tiles
    if (drawing.bitmapTiles.length > 0) {
      return renderBitmapTVGToCanvas(drawing.bitmapTiles, width, height);
    }
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  // Use field chart viewport if provided (e.g., 336 = 12 fields × 28 units/field).
  // The viewport defines a square centered at origin in TVG coordinate space.
  // If no viewport, auto-fit to path bounds.
  let scale: number;
  let offsetX: number;
  let offsetY: number;
  let viewportSize: number;

  if (viewport && viewport > 0) {
    // Field chart viewport: use viewport as the coordinate space size,
    // centered on content centroid for proper framing.
    // Auto-expand viewport if content exceeds it to prevent clipping.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const layer of drawing.layers) {
      for (const shape of layer.shapes) {
        for (const comp of shape.components) {
          if (comp.path) {
            for (const seg of comp.path.segments) {
              if (seg.x < minX) minX = seg.x;
              if (seg.y < minY) minY = seg.y;
              if (seg.x > maxX) maxX = seg.x;
              if (seg.y > maxY) maxY = seg.y;
            }
          }
        }
      }
    }
    const contentExtent = Math.max(maxX - minX, maxY - minY);
    viewportSize = Math.max(viewport, contentExtent * 1.25);

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    scale = Math.min(width, height) / viewportSize;
    offsetX = width / 2 - centerX * scale;
    offsetY = height / 2 + centerY * scale;
    ctx.setTransform(scale, 0, 0, -scale, offsetX, offsetY);
  } else {
    // Auto-fit to path bounds
    const allPoints: { x: number; y: number }[] = [];
    for (const layer of drawing.layers) {
      for (const shape of layer.shapes) {
        for (const comp of shape.components) {
          if (comp.path) {
            for (const seg of comp.path.segments) {
              allPoints.push({ x: seg.x, y: seg.y });
              if (seg.type === 'Q') allPoints.push({ x: seg.cx, y: seg.cy });
              else if (seg.type === 'C') { allPoints.push({ x: seg.c1x, y: seg.c1y }); allPoints.push({ x: seg.c2x, y: seg.c2y }); }
            }
          }
        }
      }
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of allPoints) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const drawingWidth = maxX - minX;
    const drawingHeight = maxY - minY;
    if (drawingWidth < 0.01 || drawingHeight < 0.01) return null;
    viewportSize = Math.max(drawingWidth, drawingHeight);

    const padding = 4;
    const availW = width - padding * 2;
    const availH = height - padding * 2;
    scale = Math.min(availW / drawingWidth, availH / drawingHeight);
    offsetX = padding + (availW - drawingWidth * scale) / 2 - minX * scale;
    offsetY = padding + (availH - drawingHeight * scale) / 2 + maxY * scale;
    ctx.setTransform(scale, 0, 0, -scale, offsetX, offsetY);
  }

  // Default stroke width: 1 TVG unit ≈ 1 pixel at standard viewport/canvas ratio
  const defaultStrokeWidth = 1.0;

  // Art layer order. Skip underlay by default: it contains Mask-colored fills
  // used for CUTTER clip regions, not visible content. In debug mode (includeUnderlay),
  // render all layers including underlay to show the raw drawing structure.
  const includeUnderlay = options?.includeUnderlay ?? false;
  const artLayerFilter = options?.artLayerFilter;
  let layerTypes: TVGArtLayer['type'][];
  if (artLayerFilter && artLayerFilter !== 'all') {
    // Render only the specific art layer requested
    layerTypes = [artLayerFilter];
  } else {
    layerTypes = includeUnderlay
      ? ['underlay', 'color', 'line', 'overlay']
      : ['color', 'line', 'overlay'];
  }
  const fillOrder = layerTypes;
  const strokeOrder = layerTypes;

  // Three-pass rendering with dilated flood-fill clipping:
  //   1. Render fills to offscreen canvas
  //   2. Build stroke mask → dilate 2px → flood-fill from edges → erase outside
  //   3. Composite clipped fills, then visible strokes on top

  const fillCanvas = document.createElement('canvas');
  fillCanvas.width = width;
  fillCanvas.height = height;
  const fillCtx = fillCanvas.getContext('2d')!;
  fillCtx.setTransform(ctx.getTransform());

  // Pass 1: Render all fills to offscreen canvas
  for (const layerType of fillOrder) {
    for (const layer of drawing.layers) {
      if (layer.type !== layerType) continue;
      renderLayerPass(fillCtx, layer, defaultStrokeWidth, 'fill');
    }
  }

  // Check if drawing has stroke components for clipping
  let hasStrokes = false;
  for (const layer of drawing.layers) {
    for (const shape of layer.shapes) {
      if (shape.components.some(c => (c.componentType === 2 || c.componentType === 4) && c.path && c.path.segments.length > 0)) {
        hasStrokes = true; break;
      }
    }
    if (hasStrokes) break;
  }

  if (hasStrokes) {
    // Pass 2: Dilated flood-fill to clip fills to stroke boundaries
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = width;
    maskCanvas.height = height;
    const maskCtx = maskCanvas.getContext('2d')!;
    maskCtx.setTransform(ctx.getTransform());
    for (const layerType of strokeOrder) {
      for (const layer of drawing.layers) {
        if (layer.type !== layerType) continue;
        renderStrokeMask(maskCtx, layer, defaultStrokeWidth);
      }
    }

    // Build wall map from stroke mask
    const maskData = maskCtx.getImageData(0, 0, width, height);
    const isWall = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      if (maskData.data[i * 4 + 3] > 30) isWall[i] = 1;
    }

    // Dilate by 2px to close sub-pixel gaps between stroke segments
    const dilated = new Uint8Array(width * height);
    const DR = 2;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (isWall[y * width + x]) { dilated[y * width + x] = 1; continue; }
        let found = false;
        for (let dy = -DR; dy <= DR && !found; dy++) {
          for (let dx = -DR; dx <= DR && !found; dx++) {
            if (dx * dx + dy * dy > DR * DR) continue;
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height && isWall[ny * width + nx]) found = true;
          }
        }
        if (found) dilated[y * width + x] = 1;
      }
    }

    // BFS flood-fill from edges to find "outside" region
    const outside = new Uint8Array(width * height);
    const queue: number[] = [];
    for (let x = 0; x < width; x++) {
      if (!dilated[x]) { outside[x] = 1; queue.push(x); }
      const b = (height - 1) * width + x;
      if (!dilated[b]) { outside[b] = 1; queue.push(b); }
    }
    for (let y = 1; y < height - 1; y++) {
      if (!dilated[y * width]) { outside[y * width] = 1; queue.push(y * width); }
      const r = y * width + width - 1;
      if (!dilated[r]) { outside[r] = 1; queue.push(r); }
    }
    let head = 0;
    while (head < queue.length) {
      const idx = queue[head++];
      const x = idx % width, y = (idx / width) | 0;
      if (x > 0 && !outside[idx - 1] && !dilated[idx - 1]) { outside[idx - 1] = 1; queue.push(idx - 1); }
      if (x < width - 1 && !outside[idx + 1] && !dilated[idx + 1]) { outside[idx + 1] = 1; queue.push(idx + 1); }
      if (y > 0 && !outside[idx - width] && !dilated[idx - width]) { outside[idx - width] = 1; queue.push(idx - width); }
      if (y < height - 1 && !outside[idx + width] && !dilated[idx + width]) { outside[idx + width] = 1; queue.push(idx + width); }
    }

    // Erase outside pixels from fill canvas, with leak detection fallback.
    // If clipping removes >50% of fill pixels, the mask leaked — skip clipping.
    const fillData = fillCtx.getImageData(0, 0, width, height);
    let fillPixels = 0, erasedPixels = 0;
    for (let i = 0; i < width * height; i++) {
      if (fillData.data[i * 4 + 3] > 0) fillPixels++;
      if (outside[i] && fillData.data[i * 4 + 3] > 0) erasedPixels++;
    }
    if (fillPixels > 0 && erasedPixels / fillPixels < 0.5) {
      // Safe to clip - less than 50% of fill would be removed
      for (let i = 0; i < width * height; i++) {
        if (outside[i]) fillData.data[i * 4 + 3] = 0;
      }
      fillCtx.putImageData(fillData, 0, 0);
    }
    // else: mask leaked, keep fills unclipped
  }

  // Composite clipped fills onto main canvas
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(fillCanvas, 0, 0);
  ctx.restore();

  // Pass 3: Render visible strokes on top (covers boundary imprecision from dilation)
  for (const layerType of strokeOrder) {
    for (const layer of drawing.layers) {
      if (layer.type !== layerType) continue;
      renderLayerPass(ctx, layer, defaultStrokeWidth, 'stroke');
    }
  }

  return canvas;
}

function renderBitmapTVGToCanvas(
  tiles: TVGBitmapTile[],
  width: number,
  height: number,
): HTMLCanvasElement | null {
  if (tiles.length === 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  // Compute overall bounds from tile clip rects
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const tile of tiles) {
    if (tile.clipW > 0 && tile.clipH > 0) {
      minX = Math.min(minX, tile.clipX);
      minY = Math.min(minY, tile.clipY);
      maxX = Math.max(maxX, tile.clipX + tile.clipW);
      maxY = Math.max(maxY, tile.clipY + tile.clipH);
    }
  }

  // Return canvas — actual bitmap rendering happens asynchronously
  // Mark the canvas with bitmap data for async loading
  (canvas as any).__bitmapTiles = tiles;
  (canvas as any).__bitmapBounds = { minX, minY, maxX, maxY };
  return canvas;
}

/** Load bitmap tiles asynchronously onto a canvas */
export async function loadBitmapTiles(canvas: HTMLCanvasElement): Promise<boolean> {
  const tiles = (canvas as any).__bitmapTiles as TVGBitmapTile[] | undefined;
  if (!tiles || tiles.length === 0) return false;

  const bounds = (canvas as any).__bitmapBounds as { minX: number; minY: number; maxX: number; maxY: number };
  const ctx = canvas.getContext('2d')!;
  const width = canvas.width;
  const height = canvas.height;

  // Load all PNG tiles as images
  const loadImage = (data: Uint8Array): Promise<HTMLImageElement> => {
    return new Promise((resolve, reject) => {
      const ab = new ArrayBuffer(data.byteLength);
      new Uint8Array(ab).set(data);
      const blob = new Blob([ab], { type: 'image/png' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load PNG tile')); };
      img.src = url;
    });
  };

  const images = await Promise.all(tiles.map(async (tile) => {
    try {
      const img = await loadImage(tile.pngData);
      return { tile, img };
    } catch {
      return null;
    }
  }));

  const loaded = images.filter((x): x is { tile: TVGBitmapTile; img: HTMLImageElement } => x !== null);
  if (loaded.length === 0) return false;

  // Compute bounds from actual image sizes if clip rects are all zero
  let useClipRects = isFinite(bounds.minX) && (bounds.maxX - bounds.minX) > 0;

  if (useClipRects) {
    const totalW = bounds.maxX - bounds.minX;
    const totalH = bounds.maxY - bounds.minY;
    const scale = Math.min(width / totalW, height / totalH);
    const offsetX = (width - totalW * scale) / 2;
    const offsetY = (height - totalH * scale) / 2;

    for (const { tile, img } of loaded) {
      const dx = offsetX + (tile.clipX - bounds.minX) * scale;
      const dy = offsetY + (tile.clipY - bounds.minY) * scale;
      const dw = tile.clipW * scale;
      const dh = tile.clipH * scale;
      ctx.drawImage(img, dx, dy, dw, dh);
    }
  } else {
    // No clip rect info — composite tiles by stacking largest first
    // Just draw the largest tile centered
    const largest = loaded.reduce((a, b) => a.img.width * a.img.height > b.img.width * b.img.height ? a : b);
    const scale = Math.min(width / largest.img.width, height / largest.img.height);
    const dw = largest.img.width * scale;
    const dh = largest.img.height * scale;
    ctx.drawImage(largest.img, (width - dw) / 2, (height - dh) / 2, dw, dh);
  }

  // Clean up
  delete (canvas as any).__bitmapTiles;
  delete (canvas as any).__bitmapBounds;
  return true;
}


function renderLayerPass(ctx: CanvasRenderingContext2D, layer: TVGArtLayer, defaultStrokeWidth: number, pass: 'fill' | 'stroke'): void {
  for (const shape of layer.shapes) {
    // Separate fill components from stroke/pencil components
    const fillComps = shape.components.filter(c => c.componentType === 0 && c.path && c.path.segments.length > 1 && !isDegenerate(c.path)
      && (!c.color || c.color.a > 128)); // Skip low-alpha fills (controller/handle colors)
    const strokeComps = shape.components.filter(c => (c.componentType === 4 || c.componentType === 2) && c.path && c.path.segments.length > 0);

    // Fill rendering: group fill components by color, then chain each group
    // into closed regions. Colorless fills AND invisible stroke boundaries
    // (ct=2 without strokeWidth) are shared across groups as boundary segments.
    if (pass === 'fill' && fillComps.length > 0) {
      const TOL = 2.0;

      // Include invisible stroke boundaries as additional fill boundary components.
      // In Toon Boom, invisible strokes (ct=2, no width) define fill region edges.
      // Adding them to the fill chain helps close open regions.
      const boundaryStrokes = strokeComps.filter(c =>
        c.componentType === 2 && c.strokeWidth === null && c.path && c.path.segments.length > 1
      );
      // Create a combined component array: fills + boundary strokes
      const allChainComps = [...fillComps, ...boundaryStrokes];

      // Separate colored fills from colorless boundary fills
      const colorKey = (c: { r: number; g: number; b: number; a: number }) => `${c.r},${c.g},${c.b},${c.a}`;
      const colorGroups = new Map<string, number[]>(); // colorKey -> fill indices in allChainComps
      const boundaryIndices: number[] = []; // colorless fills + boundary strokes

      for (let i = 0; i < allChainComps.length; i++) {
        const comp = allChainComps[i];
        if (comp.color && comp.componentType === 0) {
          const key = colorKey(comp.color);
          if (!colorGroups.has(key)) colorGroups.set(key, []);
          colorGroups.get(key)!.push(i);
        } else {
          boundaryIndices.push(i);
        }
      }

      // If only one color (or no colors), use original single-chain approach
      // For multi-color shapes, chain each color group + shared boundaries
      const colorKeys = Array.from(colorGroups.keys());
      if (colorKeys.length <= 1) {
        // Single color: chain all components (fills + boundary strokes)
        chainAndFillComponents(ctx, allChainComps, allChainComps.map((_, i) => i), TOL);
      } else {
        // Multi-color: chain each color group separately, including shared boundaries
        for (const key of colorKeys) {
          const groupIndices = [...colorGroups.get(key)!, ...boundaryIndices];
          chainAndFillComponents(ctx, allChainComps, groupIndices, TOL);
        }
      }
    }

    // Render stroke/pencil components individually
    if (pass === 'stroke') {
      for (const comp of strokeComps) {
        const color = comp.color;
        const fillStyle = color
          ? `rgba(${color.r},${color.g},${color.b},${color.a / 255})`
          : '#000';

        // Use explicit thickness if available; pencil strokes (ct=4) fall back to
        // proportional default; brush strokes (ct=2) without explicit width are invisible
        // boundary strokes used by Toon Boom for fill region definition.
        let sw: number;
        if (comp.strokeWidth !== null) {
          sw = comp.strokeWidth;
        } else if (comp.componentType === 4) {
          sw = defaultStrokeWidth;
        } else {
          continue; // ct=2 brush strokes without explicit width are invisible boundaries
        }
        if (sw < 0.1) continue;

        // Variable-width stroke: render as filled outline using thickness profile
        if (comp.thicknessProfile && comp.thicknessProfile.points.length >= 2 && comp.path) {
          renderVariableWidthStroke(ctx, comp.path, comp.thicknessProfile, fillStyle);
        } else {
          const path = buildPath2D(comp.path!);
          ctx.strokeStyle = fillStyle;
          ctx.lineWidth = sw;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.stroke(path);
        }
      }
    }
  }
}

/**
 * Render all stroke outlines (including invisible boundary strokes) as an opaque mask.
 * Used with globalCompositeOperation 'destination-out' to erase fill pixels under strokes,
 * preventing fill overflow past stroke boundaries.
 *
 * This renders ALL stroke/boundary components (ct=2 and ct=4) as opaque white,
 * including invisible boundary strokes (ct=2 without explicit strokeWidth) which
 * define fill region edges in Toon Boom.
 */
function renderStrokeMask(ctx: CanvasRenderingContext2D, layer: TVGArtLayer, defaultStrokeWidth: number): void {
  for (const shape of layer.shapes) {
    const strokeComps = shape.components.filter(c => (c.componentType === 4 || c.componentType === 2) && c.path && c.path.segments.length > 0);

    for (const comp of strokeComps) {
      // For the mask, determine stroke width:
      // - Explicit strokeWidth from the component
      // - ct=4 pencil: use defaultStrokeWidth
      // - ct=2 invisible boundary: use a thin boundary width to erase fill overflow
      let sw: number;
      if (comp.strokeWidth !== null) {
        sw = comp.strokeWidth;
      } else if (comp.componentType === 4) {
        sw = defaultStrokeWidth;
      } else {
        // Invisible boundary strokes: use width 1.0 for the mask to ensure
        // continuous lines. Visible strokes drawn on top cover this imprecision.
        sw = 1.0;
      }
      if (sw < 0.05) continue;

      // Variable-width stroke: render as filled outline
      if (comp.thicknessProfile && comp.thicknessProfile.points.length >= 2 && comp.path) {
        renderVariableWidthStroke(ctx, comp.path, comp.thicknessProfile, 'rgba(255,255,255,1)');
      } else {
        const path = buildPath2D(comp.path!);
        ctx.strokeStyle = 'rgba(255,255,255,1)';
        ctx.lineWidth = sw;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke(path);
      }
    }
  }
}

/**
 * Evaluate a cubic bezier at parameter t.
 */
function cubicBezier(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

/**
 * Evaluate a cubic bezier derivative at parameter t (for tangent).
 */
function cubicBezierDeriv(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const mt = 1 - t;
  return 3 * mt * mt * (p1 - p0) + 6 * mt * t * (p2 - p1) + 3 * t * t * (p3 - p2);
}

/**
 * Sample a point and tangent on the centerline path at a given arc-length fraction.
 * Handles M, L, Q, C segments by evaluating the actual curve equations.
 */
function sampleCenterline(
  segs: TVGSegment[],
  segArcStarts: number[],
  totalArcLen: number,
  targetFraction: number,
): { x: number; y: number; nx: number; ny: number } | null {
  const targetLen = targetFraction * totalArcLen;
  if (segs.length < 2) return null;

  // Find which segment contains targetLen
  let segIdx = 1;
  while (segIdx < segs.length - 1 && segArcStarts[segIdx + 1] < targetLen) segIdx++;

  const segStart = segArcStarts[segIdx];
  const segEnd = (segIdx + 1 < segArcStarts.length) ? segArcStarts[segIdx + 1] : segArcStarts[segIdx];
  const segLen = segEnd - segStart;
  const segT = segLen > 0.001 ? Math.max(0, Math.min(1, (targetLen - segStart) / segLen)) : 0;

  const seg = segs[segIdx];
  const prev = segs[segIdx - 1] || segs[0];

  let x: number, y: number, tx: number, ty: number;

  if (seg.type === 'L' || seg.type === 'M') {
    x = prev.x + (seg.x - prev.x) * segT;
    y = prev.y + (seg.y - prev.y) * segT;
    tx = seg.x - prev.x;
    ty = seg.y - prev.y;
  } else if (seg.type === 'Q') {
    const mt = 1 - segT;
    x = mt * mt * prev.x + 2 * mt * segT * seg.cx + segT * segT * seg.x;
    y = mt * mt * prev.y + 2 * mt * segT * seg.cy + segT * segT * seg.y;
    tx = 2 * mt * (seg.cx - prev.x) + 2 * segT * (seg.x - seg.cx);
    ty = 2 * mt * (seg.cy - prev.y) + 2 * segT * (seg.y - seg.cy);
  } else if (seg.type === 'C') {
    x = cubicBezier(segT, prev.x, seg.c1x, seg.c2x, seg.x);
    y = cubicBezier(segT, prev.y, seg.c1y, seg.c2y, seg.y);
    tx = cubicBezierDeriv(segT, prev.x, seg.c1x, seg.c2x, seg.x);
    ty = cubicBezierDeriv(segT, prev.y, seg.c1y, seg.c2y, seg.y);
  } else {
    return null;
  }

  const tLen = Math.sqrt(tx * tx + ty * ty) || 1;
  // Normal perpendicular to tangent (left-pointing)
  return { x, y, nx: -ty / tLen, ny: tx / tLen };
}

/**
 * Compute approximate arc lengths for each path segment using subdivision.
 * Returns array where index i is the cumulative arc length at the START of segment i.
 */
function computeSegmentArcLengths(segs: TVGSegment[]): number[] {
  const arcStarts: number[] = [0]; // segment 0 (M) starts at 0
  let cumLen = 0;

  for (let i = 1; i < segs.length; i++) {
    const prev = segs[i - 1];
    const seg = segs[i];
    let segLen = 0;

    if (seg.type === 'L' || seg.type === 'M') {
      const dx = seg.x - prev.x;
      const dy = seg.y - prev.y;
      segLen = Math.sqrt(dx * dx + dy * dy);
    } else if (seg.type === 'Q') {
      const steps = 8;
      let lx = prev.x, ly = prev.y;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const mt = 1 - t;
        const nx = mt * mt * prev.x + 2 * mt * t * seg.cx + t * t * seg.x;
        const ny = mt * mt * prev.y + 2 * mt * t * seg.cy + t * t * seg.y;
        segLen += Math.sqrt((nx - lx) ** 2 + (ny - ly) ** 2);
        lx = nx; ly = ny;
      }
    } else if (seg.type === 'C') {
      const steps = 12;
      let lx = prev.x, ly = prev.y;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const nx = cubicBezier(t, prev.x, seg.c1x, seg.c2x, seg.x);
        const ny = cubicBezier(t, prev.y, seg.c1y, seg.c2y, seg.y);
        segLen += Math.sqrt((nx - lx) ** 2 + (ny - ly) ** 2);
        lx = nx; ly = ny;
      }
    }

    cumLen += segLen;
    arcStarts.push(cumLen);
  }

  return arcStarts;
}

/**
 * Interpolate thickness using cubic bezier control points from the thickness profile.
 *
 * The control points define a smooth cubic bezier curve between adjacent thickness points:
 *   ctrl_fwd of point_i: forward CP (x is 0..1 relative to interval, y is offset distance)
 *   ctrl_back of point_i+1: backward CP (x is 0..1 relative from next point, y is offset distance)
 */
function interpolateThickness(
  profile: TVGThicknessProfile,
  t: number,
): { leftW: number; rightW: number } {
  const pts = profile.points;
  if (pts.length === 0) return { leftW: 0, rightW: 0 };
  if (pts.length === 1) return { leftW: pts[0].leftOffset, rightW: pts[0].rightOffset };

  // Clamp t to profile range
  if (t <= pts[0].loc) return { leftW: pts[0].leftOffset, rightW: pts[0].rightOffset };
  if (t >= pts[pts.length - 1].loc) {
    const last = pts[pts.length - 1];
    return { leftW: last.leftOffset, rightW: last.rightOffset };
  }

  // Find the interval
  let j = 1;
  while (j < pts.length && pts[j].loc < t) j++;

  const prev = pts[j - 1];
  const next = pts[j];
  const intervalLen = next.loc - prev.loc;
  if (intervalLen <= 0) return { leftW: prev.leftOffset, rightW: prev.rightOffset };

  const localT = (t - prev.loc) / intervalLen;

  // Cubic bezier interpolation for left side:
  // P0 = prev.leftOffset, P1 = prev.leftCtrlFwd.y, P2 = next.leftCtrlBack.y, P3 = next.leftOffset
  const leftW = cubicBezier(localT, prev.leftOffset, prev.leftCtrlFwd.y, next.leftCtrlBack.y, next.leftOffset);
  const rightW = cubicBezier(localT, prev.rightOffset, prev.rightCtrlFwd.y, next.rightCtrlBack.y, next.rightOffset);

  return { leftW: Math.max(0, leftW), rightW: Math.max(0, rightW) };
}

/** Render a variable-width stroke as a filled outline using the thickness profile. */
function renderVariableWidthStroke(
  ctx: CanvasRenderingContext2D,
  path: TVGPath,
  profile: TVGThicknessProfile,
  fillStyle: string,
): void {
  const segs = path.segments;
  if (segs.length < 2) return;

  // Compute proper arc lengths along the actual bezier curves
  const segArcStarts = computeSegmentArcLengths(segs);
  const totalLen = segArcStarts[segArcStarts.length - 1];
  if (totalLen < 0.01) return;

  // Higher sample density for better quality (was: max 80, 2px spacing)
  const numSamples = Math.max(30, Math.min(200, Math.ceil(totalLen)));

  // Map from thickness domain to centerline parameter
  const [domainStart, domainEnd] = profile.domain;
  const domainLen = domainEnd - domainStart;

  const leftPoints: { x: number; y: number }[] = [];
  const rightPoints: { x: number; y: number }[] = [];

  let firstPt: { x: number; y: number; nx: number; ny: number } | null = null;
  let lastPt: { x: number; y: number; nx: number; ny: number } | null = null;

  for (let i = 0; i <= numSamples; i++) {
    const frac = i / numSamples;

    const pt = sampleCenterline(segs, segArcStarts, totalLen, frac);
    if (!pt) continue;

    // Map centerline fraction to thickness parameter via domain
    const thicknessT = domainLen > 0 ? domainStart + frac * domainLen : frac;

    const { leftW, rightW } = interpolateThickness(profile, thicknessT);

    leftPoints.push({ x: pt.x + pt.nx * leftW, y: pt.y + pt.ny * leftW });
    rightPoints.push({ x: pt.x - pt.nx * rightW, y: pt.y - pt.ny * rightW });

    if (!firstPt) firstPt = pt;
    lastPt = pt;
  }

  if (leftPoints.length < 2) return;

  // Build filled outline: left forward, end cap, right reversed, start cap
  const outlinePath = new Path2D();
  outlinePath.moveTo(leftPoints[0].x, leftPoints[0].y);
  for (let i = 1; i < leftPoints.length; i++) {
    outlinePath.lineTo(leftPoints[i].x, leftPoints[i].y);
  }

  // End cap: cubic bezier round cap (matching Toon Boom's 1.33x cap offset)
  if (lastPt && profile.points.length > 0) {
    const lastTP = profile.points[profile.points.length - 1];
    const capScale = 1.33;
    const lastLeft = leftPoints[leftPoints.length - 1];
    const lastRight = rightPoints[rightPoints.length - 1];
    // Tangent direction at end
    const tdx = -lastPt.ny;
    const tdy = lastPt.nx;
    const cp1x = lastLeft.x + tdx * capScale * lastTP.leftOffset;
    const cp1y = lastLeft.y + tdy * capScale * lastTP.leftOffset;
    const cp2x = lastRight.x + tdx * capScale * lastTP.rightOffset;
    const cp2y = lastRight.y + tdy * capScale * lastTP.rightOffset;
    outlinePath.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, lastRight.x, lastRight.y);
  } else {
    outlinePath.lineTo(rightPoints[rightPoints.length - 1].x, rightPoints[rightPoints.length - 1].y);
  }

  for (let i = rightPoints.length - 2; i >= 0; i--) {
    outlinePath.lineTo(rightPoints[i].x, rightPoints[i].y);
  }

  // Start cap: cubic bezier round cap
  if (firstPt && profile.points.length > 0) {
    const firstTP = profile.points[0];
    const capScale = 1.33;
    const firstRight = rightPoints[0];
    const firstLeft = leftPoints[0];
    // Tangent direction at start (backward = negative tangent)
    const tdx = firstPt.ny;
    const tdy = -firstPt.nx;
    const cp1x = firstRight.x + tdx * capScale * firstTP.rightOffset;
    const cp1y = firstRight.y + tdy * capScale * firstTP.rightOffset;
    const cp2x = firstLeft.x + tdx * capScale * firstTP.leftOffset;
    const cp2y = firstLeft.y + tdy * capScale * firstTP.leftOffset;
    outlinePath.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, firstLeft.x, firstLeft.y);
  }

  outlinePath.closePath();

  ctx.fillStyle = fillStyle;
  ctx.fill(outlinePath);
}

/** Chain a subset of fill components by endpoint matching and render filled paths. */
function chainAndFillComponents(
  ctx: CanvasRenderingContext2D,
  allFillComps: TVGComponent[],
  indices: number[],
  TOL: number,
): void {
  const compInfos = indices.map(idx => {
    const segs = allFillComps[idx].path!.segments;
    return {
      ci: idx,
      startX: segs[0].x, startY: segs[0].y,
      endX: segs[segs.length - 1].x, endY: segs[segs.length - 1].y,
    };
  });

  // Greedy chain building: link components by matching endpoints
  const used = new Set<number>();
  const chains: { ci: number; reversed: boolean; startX: number; startY: number; endX: number; endY: number }[][] = [];
  for (let i = 0; i < compInfos.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const chain: typeof chains[0] = [{ ...compInfos[i], reversed: false }];
    let changed = true;
    while (changed) {
      changed = false;
      const tail = chain[chain.length - 1];
      const head = chain[0];
      if (Math.abs(head.startX - tail.endX) < TOL && Math.abs(head.startY - tail.endY) < TOL) break;
      for (let j = 0; j < compInfos.length; j++) {
        if (used.has(j)) continue;
        const c = compInfos[j];
        if (Math.abs(c.startX - tail.endX) < TOL && Math.abs(c.startY - tail.endY) < TOL) {
          chain.push({ ...c, reversed: false }); used.add(j); changed = true; break;
        }
        if (Math.abs(c.endX - tail.endX) < TOL && Math.abs(c.endY - tail.endY) < TOL) {
          chain.push({ ci: c.ci, startX: c.endX, startY: c.endY, endX: c.startX, endY: c.startY, reversed: true });
          used.add(j); changed = true; break;
        }
      }
      if (changed) continue;
      for (let j = 0; j < compInfos.length; j++) {
        if (used.has(j)) continue;
        const c = compInfos[j];
        if (Math.abs(c.endX - head.startX) < TOL && Math.abs(c.endY - head.startY) < TOL) {
          chain.unshift({ ...c, reversed: false }); used.add(j); changed = true; break;
        }
        if (Math.abs(c.startX - head.startX) < TOL && Math.abs(c.startY - head.startY) < TOL) {
          chain.unshift({ ci: c.ci, startX: c.endX, startY: c.endY, endX: c.startX, endY: c.startY, reversed: true });
          used.add(j); changed = true; break;
        }
      }
    }
    chains.push(chain);
  }

  // Build a single compound path from all chains for evenodd fill.
  // Chained components are connected via lineTo, unchained ones start new sub-paths.
  let fillColor: { r: number; g: number; b: number; a: number } | null = null;
  for (const chain of chains) {
    for (const info of chain) {
      const comp = allFillComps[info.ci];
      if (comp.color) { fillColor = comp.color; break; }
    }
    if (fillColor) break;
  }
  if (!fillColor) return;

  const path = new Path2D();
  for (const chain of chains) {
    let isFirst = true;
    const head = chain[0], tail = chain[chain.length - 1];
    const isClosed = Math.abs(head.startX - tail.endX) + Math.abs(head.startY - tail.endY) < TOL * 2;

    for (const info of chain) {
      const comp = allFillComps[info.ci];
      const segs = comp.path!.segments;
      if (!info.reversed) {
        for (let si = 0; si < segs.length; si++) {
          const seg = segs[si];
          if (si === 0) {
            if (isFirst) { path.moveTo(seg.x, seg.y); isFirst = false; }
            else path.lineTo(seg.x, seg.y);
          } else if (seg.type === 'C') path.bezierCurveTo(seg.c1x, seg.c1y, seg.c2x, seg.c2y, seg.x, seg.y);
          else if (seg.type === 'Q') path.quadraticCurveTo(seg.cx, seg.cy, seg.x, seg.y);
          else path.lineTo(seg.x, seg.y);
        }
      } else {
        const lastSeg = segs[segs.length - 1];
        if (isFirst) { path.moveTo(lastSeg.x, lastSeg.y); isFirst = false; }
        else path.lineTo(lastSeg.x, lastSeg.y);
        for (let si = segs.length - 1; si >= 1; si--) {
          const seg = segs[si];
          const dest = segs[si - 1];
          if (seg.type === 'C') path.bezierCurveTo(seg.c2x, seg.c2y, seg.c1x, seg.c1y, dest.x, dest.y);
          else if (seg.type === 'Q') path.quadraticCurveTo(seg.cx, seg.cy, dest.x, dest.y);
          else path.lineTo(dest.x, dest.y);
        }
      }
    }
    if (isClosed) path.closePath();
  }

  const fillStyle = `rgba(${fillColor.r},${fillColor.g},${fillColor.b},${fillColor.a / 255})`;
  ctx.fillStyle = fillStyle;
  ctx.fill(path, 'evenodd');
}

/** Check if a path is degenerate (all points collinear — forms a line, not a shape). */
function isDegenerate(path: TVGPath): boolean {
  if (path.segments.length <= 2) {
    const xs = new Set(path.segments.map(s => Math.round(s.x * 100)));
    const ys = new Set(path.segments.map(s => Math.round(s.y * 100)));
    return xs.size <= 1 || ys.size <= 1;
  }
  return false;
}

function buildPath2D(tvgPath: TVGPath): Path2D {
  const path = new Path2D();
  for (const seg of tvgPath.segments) {
    switch (seg.type) {
      case 'M':
        path.moveTo(seg.x, seg.y);
        break;
      case 'L':
        path.lineTo(seg.x, seg.y);
        break;
      case 'Q':
        path.quadraticCurveTo(seg.cx, seg.cy, seg.x, seg.y);
        break;
      case 'C':
        path.bezierCurveTo(seg.c1x, seg.c1y, seg.c2x, seg.c2y, seg.x, seg.y);
        break;
    }
  }
  if (tvgPath.closed) {
    path.closePath();
  }
  return path;
}
