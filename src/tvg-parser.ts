import pako from 'pako';

// ── Public Types ──

export interface TVGDrawing {
  layers: TVGArtLayer[];
  palette: TVGPaletteEntry[];
}

export interface TVGArtLayer {
  type: 'underlay' | 'color' | 'line' | 'overlay';
  shapes: TVGShape[];
}

export interface TVGShape {
  shapeType: number; // 2=fill, 3=stroke, 6=line
  components: TVGComponent[];
}

export interface TVGComponent {
  componentType: number; // 0=fill, 1=unknown, 2=stroke, 4=pencil
  colorId: bigint | null;
  paletteIndex: number | null; // Palette position index for fills without TGCO
  color: { r: number; g: number; b: number; a: number } | null;
  transform: TVGTransform | null;
  path: TVGPath | null;
  strokeWidth: number | null;
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

  // Resolve colors: link components' colorId to palette entries
  const paletteMap = new Map<bigint, TVGPaletteEntry>();
  for (const entry of drawing.palette) {
    paletteMap.set(entry.id, entry);
  }

  // Find palette colors by role
  let lineColor: { r: number; g: number; b: number; a: number } | null = null;
  let defaultFillColor: { r: number; g: number; b: number; a: number } | null = null;
  const utilityNames = new Set(['line', 'mask', 'invis', 'handles', 'invisible', 'shadow']);

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
        // Fills: use paletteIndex as TPAL index, but skip "Line" entries
        // (Line is a stroke color; palIdx→Line on fills is typically a default/unset value)
        if (comp.componentType === 0 && comp.color === null && comp.paletteIndex !== null) {
          const idx = comp.paletteIndex;
          if (idx >= 0 && idx < drawing.palette.length) {
            const entry = drawing.palette[idx];
            const nameLower = entry.name.toLowerCase();
            if (entry.a > 0 && nameLower !== 'line') {
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

    for (let c = 0; c < componentCount && reader.pos < shapeEnd; c++) {
      // Find next TGVS
      if (!scanToTag(reader, TAG_TGVS)) break;

      const vsLen = reader.readU32LE();
      if (vsLen > reader.remaining) break;

      const vsEnd = reader.pos + vsLen;
      const comp = parseComponent(reader, vsEnd);
      if (comp) shape.components.push(comp);

      reader.pos = vsEnd; // Ensure we advance past the TGVS block
    }

    if (shape.components.length > 0) {
      layer.shapes.push(shape);
    }

    reader.pos = shapeEnd; // Ensure we advance past the TGLY block
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

function parseComponent(reader: BinaryReader, endPos: number): TVGComponent | null {
  const comp: TVGComponent = {
    componentType: -1,
    colorId: null,
    paletteIndex: null,
    color: null,
    transform: null,
    path: null,
    strokeWidth: null,
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
      // Pencil thickness: extract max width from thickness control points
      const len = reader.readU32LE();
      if (len > reader.remaining) { reader.skip(Math.min(len, reader.remaining)); } else {
        const tbEnd = reader.pos + len;
        comp.strokeWidth = parseTGTBMaxWidth(reader, len);
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
 * Parse tGTB pencil thickness data and extract the maximum stroke width.
 * tGTB format: type(u8) + id(u32) + 0xCF marker + pointCount(u32) + points...
 * Each point: location(f32) + left_offset(f32) + left_cp1(2xf32) + left_cp2(2xf32)
 *             + right_offset(f32) + right_cp1(2xf32) + right_cp2(2xf32) = 11 floats
 */
function parseTGTBMaxWidth(reader: BinaryReader, len: number): number | null {
  if (len < 10) return null;
  const startPos = reader.pos;

  try {
    const type = reader.readU8();
    if (type === 0x00) {
      // Reference to previous thickness - can't extract width
      return null;
    }
    if (type !== 0x01) return null;

    reader.readU32LE(); // color/id reference (often 0xFFFFFFFF)
    const marker = reader.readU8();
    if (marker !== 0xCF) return null;

    // Skip 1 mystery byte
    reader.readU8();

    const pointCount = reader.readU32LE();
    if (pointCount === 0 || pointCount > 1000) return null;

    // Each point: 11 f32 values = 44 bytes
    const needed = pointCount * 44;
    if (reader.remaining < needed) return null;

    let maxWidth = 0;
    for (let i = 0; i < pointCount; i++) {
      reader.readF32LE(); // location (0..1)
      const leftOffset = reader.readF32LE();  // left side offset from center
      reader.skip(16); // left bezier control points (4 f32)
      const rightOffset = reader.readF32LE(); // right side offset from center
      reader.skip(16); // right bezier control points (4 f32)
      const width = leftOffset + rightOffset;
      if (width > maxWidth) maxWidth = width;
    }

    return maxWidth > 0 ? maxWidth : null;
  } catch (_e) {
    reader.pos = startPos;
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
          // (rare, but handle gracefully)
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
        if (comp.color === null && comp.colorId !== null) {
          const ext = extMap.get(comp.colorId);
          if (ext) {
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
export function renderTVGToCanvas(
  drawing: TVGDrawing,
  width: number,
  height: number,
): HTMLCanvasElement | null {
  // Collect all paths to compute bounds
  const allPoints: { x: number; y: number }[] = [];
  for (const layer of drawing.layers) {
    for (const shape of layer.shapes) {
      for (const comp of shape.components) {
        if (comp.path) {
          for (const seg of comp.path.segments) {
            allPoints.push({ x: seg.x, y: seg.y });
            if (seg.type === 'Q') {
              allPoints.push({ x: seg.cx, y: seg.cy });
            } else if (seg.type === 'C') {
              allPoints.push({ x: seg.c1x, y: seg.c1y });
              allPoints.push({ x: seg.c2x, y: seg.c2y });
            }
          }
        }
      }
    }
  }

  if (allPoints.length === 0) return null;

  // Compute bounds
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

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  // Scale and center the drawing within the canvas
  const padding = 4;
  const availW = width - padding * 2;
  const availH = height - padding * 2;
  const scale = Math.min(availW / drawingWidth, availH / drawingHeight);
  const offsetX = padding + (availW - drawingWidth * scale) / 2 - minX * scale;
  // Flip Y axis: TVG uses Y-up (math coordinates), canvas uses Y-down
  const offsetY = padding + (availH - drawingHeight * scale) / 2 + maxY * scale;

  ctx.setTransform(scale, 0, 0, -scale, offsetX, offsetY);

  // Compute a reasonable default stroke width based on drawing scale
  // (pencil thickness from tGTI is often in internal units, too thin to see)
  const defaultStrokeWidth = Math.max(drawingWidth, drawingHeight) * 0.008;

  // Render layers in order: color, line, overlay
  // Skip underlay (tUAA) — it contains construction/guide geometry, not final art
  const layerOrder: TVGArtLayer['type'][] = ['underlay', 'color', 'line', 'overlay'];
  for (const layerType of layerOrder) {
    for (const layer of drawing.layers) {
      if (layer.type !== layerType) continue;
      renderLayer(ctx, layer, defaultStrokeWidth);
    }
  }

  return canvas;
}

function colorKey(c: { r: number; g: number; b: number; a: number } | null): string {
  return c ? `${c.r},${c.g},${c.b},${c.a}` : 'none';
}

function renderLayer(ctx: CanvasRenderingContext2D, layer: TVGArtLayer, defaultStrokeWidth: number): void {
  for (const shape of layer.shapes) {
    // Separate fill components from stroke/pencil components
    const fillComps = shape.components.filter(c => c.componentType === 0 && c.path && c.path.segments.length > 1 && !isDegenerate(c.path));
    const strokeComps = shape.components.filter(c => (c.componentType === 4 || c.componentType === 2) && c.path && c.path.segments.length > 0);

    // Group fill components by color, preserving order.
    // Consecutive fills with the same color are chain-linked into one path.
    // Different colors start a new fill group.
    if (fillComps.length > 0) {
      // Resolve effective color: components without their own color inherit from the
      // most recent preceding colored component (leader/follower pattern)
      type FillGroup = { color: { r: number; g: number; b: number; a: number } | null; comps: typeof fillComps };
      const groups: FillGroup[] = [];
      let currentGroup: FillGroup | null = null;
      let lastSeenColor: { r: number; g: number; b: number; a: number } | null = null;

      for (const comp of fillComps) {
        if (comp.color) lastSeenColor = comp.color;
        const effectiveColor = comp.color ?? lastSeenColor;
        const key = colorKey(effectiveColor);
        if (!currentGroup || colorKey(currentGroup.color) !== key) {
          currentGroup = { color: effectiveColor, comps: [] };
          groups.push(currentGroup);
        }
        currentGroup.comps.push(comp);
      }

      // Render each color group
      for (const group of groups) {
        const combinedPath = new Path2D();
        let lastX = NaN, lastY = NaN;
        let hasContour = false;

        for (const comp of group.comps) {
          const segs = comp.path!.segments;
          const firstSeg = segs[0]; // always 'M'

          // Check if this component continues from where the last one ended
          const continues = !isNaN(lastX) &&
            Math.abs(firstSeg.x - lastX) < 0.5 &&
            Math.abs(firstSeg.y - lastY) < 0.5;

          if (!continues) {
            if (hasContour) combinedPath.closePath();
            combinedPath.moveTo(firstSeg.x, firstSeg.y);
            hasContour = true;
          }

          for (let i = 1; i < segs.length; i++) {
            const seg = segs[i];
            switch (seg.type) {
              case 'M': combinedPath.moveTo(seg.x, seg.y); break;
              case 'L': combinedPath.lineTo(seg.x, seg.y); break;
              case 'Q': combinedPath.quadraticCurveTo(seg.cx, seg.cy, seg.x, seg.y); break;
              case 'C': combinedPath.bezierCurveTo(seg.c1x, seg.c1y, seg.c2x, seg.c2y, seg.x, seg.y); break;
            }
          }

          const lastSeg = segs[segs.length - 1];
          lastX = lastSeg.x;
          lastY = lastSeg.y;
        }

        if (hasContour) combinedPath.closePath();

        if (group.color) {
          ctx.fillStyle = `rgba(${group.color.r},${group.color.g},${group.color.b},${group.color.a / 255})`;
          ctx.fill(combinedPath, 'evenodd');
        }
        // Skip fills with no resolved color — they need the project palette
      }
    }

    // Render stroke/pencil components individually
    for (const comp of strokeComps) {
      const path = buildPath2D(comp.path!);
      const color = comp.color;

      if (color) {
        ctx.strokeStyle = `rgba(${color.r},${color.g},${color.b},${color.a / 255})`;
      } else {
        ctx.strokeStyle = '#000';
      }
      // Use explicit thickness if available; fall back to proportional default
      const sw = comp.strokeWidth !== null ? comp.strokeWidth : defaultStrokeWidth;
      ctx.lineWidth = sw;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke(path);
    }
  }
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
