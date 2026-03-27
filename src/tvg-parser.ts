import pako from 'pako';

// ── Public Types ──

export interface TVGBitmapTile {
  clipX: number;
  clipY: number;
  clipW: number;
  clipH: number;
  pngData: Uint8Array;
}

export interface TVGDiagnosticEvent {
  severity: 'info' | 'warn' | 'error';
  code: string;
  tag?: string;
  offset: number;
  length?: number;
  context: 'top-level' | 'main-data' | 'art-layer' | 'component' | 'bitmap' | 'palette' | 'render';
  note?: string;
}

export interface TVGDiagnostics {
  events: TVGDiagnosticEvent[];
  counts: Record<string, number>;
}

export type TVGPaint =
  | { kind: 'solid'; rgba: { r: number; g: number; b: number; a: number } }
  | {
      kind: 'gradient';
      gradientType: 'linear' | 'radial';
      stops: { pos: number; r: number; g: number; b: number; a: number }[];
      transform: TVGTransform | null;
      fallback: { r: number; g: number; b: number; a: number };
    };

export interface TVGDrawing {
  layers: TVGArtLayer[];
  palette: TVGPaletteEntry[];
  bitmapTiles: TVGBitmapTile[];
  diagnostics: TVGDiagnostics;
}

export interface TVGArtLayer {
  type: 'underlay' | 'color' | 'line' | 'overlay';
  shapes: TVGShape[];
}

export interface TVGShape {
  shapeType: number; // 2=fill, 3=stroke, 6=line
  components: TVGComponent[];
  nodePosition?: number | null;
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
  /** Tip tangent values from tGTB domain section (6 f32s total). */
  tipTangentLeftFrom: number;
  tipTangentRightFrom: number;
  tipTangentLeftTo: number;
  tipTangentRightTo: number;
  /** Closed flag from tGTB 5-byte trailer (byte[3]). */
  closed: boolean;
}

/**
 * Harmony join types for stroke corners.
 * Maps to Canvas lineJoin: 'round', 'miter', 'bevel'.
 */
export type TVGJoinType = 'round' | 'miter' | 'bevel';

/**
 * Harmony tip (cap) types for stroke endpoints.
 * FLAT_TIP -> 'butt', ROUND_TIP -> 'round', BEVEL_TIP -> 'square'.
 */
export type TVGTipType = 'round' | 'butt' | 'square';

export interface TVGComponent {
  componentType: number; // 0=fill, 1=unknown, 2=stroke, 4=pencil
  colorId: bigint | null;
  /** Inside color ID from second TGCO entry (usually 0xFFFFFFFFFFFFFFFF = null). */
  insideColorId: bigint | null;
  paletteIndex: number | null; // Palette position index for fills without TGCO
  color: { r: number; g: number; b: number; a: number } | null;
  fillPaintSource: 'explicit' | 'inherited' | 'default' | 'synthetic' | null;
  /** Resolved inside color for two-sided strokes (inner side fill contribution). */
  insideColor: { r: number; g: number; b: number; a: number } | null;
  transform: TVGTransform | null;
  path: TVGPath | null;
  strokeWidth: number | null;
  thicknessProfile: TVGThicknessProfile | null;
  joinType: TVGJoinType; // Stroke join type (default: 'round')
  fromTipType: TVGTipType; // Start cap type (default: 'round')
  toTipType: TVGTipType; // End cap type (default: 'round')
  gradientType?: 'linear' | 'radial';
  gradientStops?: { pos: number; r: number; g: number; b: number; a: number }[];
  /** tGTI full fields (76-byte structure) */
  tgtiThickness: number | null;
  tgtiTextureScaleX: number | null;
  tgtiTextureScaleY: number | null;
  tgtiTextureOffset: number | null;
  tgtiOpacityThickness: number | null;
  tgtiOpacityScaleX: number | null;
  tgtiOpacityScaleY: number | null;
  tgtiOpacityOffset: number | null;
  tgtiHasTextureFlags: number | null;
  pathRefHint: number | null;
  outerPaint: TVGPaint | null;
  innerPaint: TVGPaint | null;
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
  tgrvValue: number | null;
  directionReversed: boolean | null;
}

export type TVGSegment =
  | { type: 'M'; x: number; y: number }
  | { type: 'L'; x: number; y: number }
  | { type: 'Q'; cx: number; cy: number; x: number; y: number }
  | { type: 'C'; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number };

export interface TVGPaletteEntry {
  name: string;
  id: bigint;
  paletteName: string;
  r: number;
  g: number;
  b: number;
  a: number;
}

interface TVGBitmapBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface TVGBitmapRenderState {
  bounds: TVGBitmapBounds;
  viewport?: number;
  centerOnOrigin: boolean;
  diagnostics?: TVGDiagnostics;
}

function createDiagnostics(): TVGDiagnostics {
  return { events: [], counts: {} };
}

function addDiagnostic(
  diagnostics: TVGDiagnostics,
  event: TVGDiagnosticEvent,
): void {
  diagnostics.events.push(event);
  diagnostics.counts[event.code] = (diagnostics.counts[event.code] || 0) + 1;
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

  findTag4(tag: string, from = this.pos): number {
    const [a, b, c, d] = [tag.charCodeAt(0), tag.charCodeAt(1), tag.charCodeAt(2), tag.charCodeAt(3)];
    for (let i = Math.max(0, from); i <= this.bytes.length - 4; i++) {
      if (this.bytes[i] === a && this.bytes[i + 1] === b && this.bytes[i + 2] === c && this.bytes[i + 3] === d) {
        return i;
      }
    }
    return -1;
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
const TAG_TGRV = 'TGRV';
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
    diagnostics: createDiagnostics(),
  };

  // Parse top-level chunks
  while (reader.remaining > 4) {
    const tag = reader.readTag4();

    if (tag === TAG_CERT) {
      const len = reader.readU32LE();
      if (len > reader.remaining) {
        addDiagnostic(drawing.diagnostics, {
          severity: 'error',
          code: 'TRUNCATED_CHUNK',
          tag,
          offset: reader.pos - 8,
          length: len,
          context: 'top-level',
        });
      }
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
    } else if (tag === TAG_TPAL) {
      try {
        const data = readEncodedData(reader);
        drawing.palette = parsePalette(new BinaryReader(data.buffer));
      } catch (_e) {
        addDiagnostic(drawing.diagnostics, {
          severity: 'warn',
          code: 'PALETTE_PARSE_SKIPPED',
          tag,
          offset: reader.pos - 4,
          context: 'palette',
        });
      }
    } else if (tag === 'TLAB') {
      try {
        const data = readEncodedData(reader);
        parseMainData(new BinaryReader(data.buffer), drawing);
      } catch (_e) {
        addDiagnostic(drawing.diagnostics, {
          severity: 'warn',
          code: 'UNKNOWN_TOP_LEVEL_TAG',
          tag,
          offset: reader.pos - 4,
          context: 'top-level',
        });
      }
    } else if (tag === TAG_TTOC) {
      const len = reader.readU32LE();
      reader.skip(len);
    } else if (tag === TAG_TGBG) {
      const tagOffset = reader.pos - 4;
      const tgbgData = readRecoverableInnerTagPayload(reader, tag, drawing.diagnostics, 'bitmap', tagOffset);
      if (tgbgData && tgbgData.length > 0) {
        parseTGBGTiles(tgbgData, drawing.bitmapTiles);
      }
    } else if (tag === TAG_SIGN) {
      skipSignaturePayload(reader, drawing.diagnostics, 'top-level', reader.pos - 4);
    } else {
      // Unknown tag - scan forward to find next known tag pattern
      addDiagnostic(drawing.diagnostics, {
        severity: 'warn',
        code: 'UNKNOWN_TOP_LEVEL_TAG',
        tag,
        offset: reader.pos - 4,
        context: 'top-level',
      });
      reader.pos -= 4; // back up to re-scan
      if (!scanToNextTopLevelTag(reader)) {
        break;
      }
    }
  }

  // If no vector or bitmap data found, scan raw buffer for TGBG bitmap blocks
  if (drawing.layers.length === 0 && drawing.bitmapTiles.length === 0) {
    scanForBitmapTiles(new Uint8Array(buffer), drawing, drawing.diagnostics);
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

  for (let layerIndex = 0; layerIndex < drawing.layers.length; layerIndex++) {
    const layer = drawing.layers[layerIndex];
    for (let shapeIndex = 0; shapeIndex < layer.shapes.length; shapeIndex++) {
      const shape = layer.shapes[shapeIndex];
      for (const comp of shape.components) {
        if (comp.colorId !== null) {
          const entry = paletteMap.get(comp.colorId);
          if (entry) {
            comp.color = { r: entry.r, g: entry.g, b: entry.b, a: entry.a };
            if (comp.componentType === 0 || comp.componentType === 1) comp.fillPaintSource = 'explicit';
          }
        }
        // Resolve insideColorId for two-sided strokes
        if (comp.insideColorId !== null) {
          const insideEntry = paletteMap.get(comp.insideColorId);
          if (insideEntry) {
            comp.insideColor = { r: insideEntry.r, g: insideEntry.g, b: insideEntry.b, a: insideEntry.a };
          }
        }
        // Fills: use paletteIndex as TPAL index to get colorId for external palette resolution.
        // Set colorId from TPAL entry's id so resolveExternalPalette can override with .plt colors.
        // Only fall back to TPAL RGBA if the entry's id is 0 (no external reference).
        if ((comp.componentType === 0 || comp.componentType === 1) && comp.color === null && comp.paletteIndex !== null) {
          const idx = comp.paletteIndex;
          // paletteIndex=0 typically means "unset/default" (not "TPAL entry 0").
          // Entry 0 is usually "Line" which is wrong for fills.
          // Only use paletteIndex > 0 as actual TPAL lookups.
          if (idx > 0 && idx < drawing.palette.length) {
            const entry = drawing.palette[idx];
            const nameLower = entry.name.toLowerCase();
            if (entry.a > 0 && nameLower !== 'line') {
              if (entry.id !== 0n && comp.colorId === null) {
                // Set colorId for external palette resolution
                comp.colorId = entry.id;
              }
              // Set TPAL color as fallback (external palette will override if matched)
              comp.color = { r: entry.r, g: entry.g, b: entry.b, a: entry.a };
              comp.fillPaintSource = 'explicit';
            }
          }
        }
        // Strokes without color get the "Line" palette color, or default to black
        if ((comp.componentType === 2 || comp.componentType === 4) && comp.color === null) {
          comp.color = lineColor ? { ...lineColor } : { r: 0, g: 0, b: 0, a: 255 };
        }
        updateComponentPaints(comp);
      }

      suppressUnderlayFollowerFillColors(drawing.layers, layerIndex, layer, shape, shapeIndex);

      // Fill color inheritance: fills without color inherit from preceding colored fill
      const fills = shape.components.filter(c => c.componentType === 0);
      const fillCarriers = shape.components.filter(c => c.componentType === 0 || c.componentType === 1);
      let lastColor: { r: number; g: number; b: number; a: number } | null = null;
      let lastFillSource: TVGComponent['fillPaintSource'] = null;
      for (const comp of fillCarriers) {
        if (comp.color !== null) {
          lastColor = comp.color;
          lastFillSource = comp.fillPaintSource;
        } else if (comp.componentType === 0 && lastColor !== null && canInheritFillColor(comp)) {
          comp.color = { ...lastColor };
          comp.fillPaintSource = lastFillSource === 'default' ? 'default' : 'inherited';
        }
      }
      // If still no fills have color, apply TPAL heuristic default
      if (defaultFillColor && fills.length > 0 && !fills.some(f => f.color !== null)) {
        fills[0].color = { ...defaultFillColor };
        fills[0].fillPaintSource = 'default';
        // Re-run inheritance from this seed
        lastColor = defaultFillColor;
        lastFillSource = 'default';
        for (let i = 1; i < fills.length; i++) {
          if (fills[i].color === null) {
            fills[i].color = { ...lastColor };
            fills[i].fillPaintSource = lastFillSource === 'default' ? 'default' : 'inherited';
          } else {
            lastColor = fills[i].color!;
            lastFillSource = fills[i].fillPaintSource;
          }
        }
      }
      for (const comp of shape.components) {
        updateComponentPaints(comp);
      }
    }
  }


  return drawing;
}

// ── Encoded Data Reading ──

/** Scan forward to find the next recognized top-level tag or null+UNCO/ZLIB pattern. */
function scanToNextTopLevelTag(reader: BinaryReader): boolean {
  const knownTopTags = new Set([
    TAG_CERT, TAG_ENDT, TAG_TVCI, TAG_CREA, TAG_TTOC, TAG_SIGN, TAG_TGBG, TAG_TPAL, 'TLAB',
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

function readRecoverableInnerTagPayload(
  reader: BinaryReader,
  tag: string,
  diagnostics: TVGDiagnostics,
  context: TVGDiagnosticEvent['context'],
  offset: number,
): Uint8Array | null {
  const len = readInnerTagLength(reader);
  if (len >= 0 && len <= reader.remaining) {
    return reader.readBytes(len);
  }

  const recoveryStart = reader.pos;
  const nextEndt = reader.findTag4(TAG_ENDT, recoveryStart);
  if (nextEndt > recoveryStart) {
    addDiagnostic(diagnostics, {
      severity: 'warn',
      code: 'SCAN_FORWARD_RECOVERY',
      tag,
      offset,
      length: len,
      context,
      note: 'Recovered malformed inner-tag length by scanning to ENDT',
    });
    return reader.readBytes(nextEndt - recoveryStart);
  }

  addDiagnostic(diagnostics, {
    severity: 'error',
    code: 'TRUNCATED_CHUNK',
    tag,
    offset,
    length: len,
    context,
  });
  if (reader.remaining > 0) {
    return reader.readBytes(reader.remaining);
  }
  return null;
}

function skipSignaturePayload(
  reader: BinaryReader,
  diagnostics: TVGDiagnostics,
  context: TVGDiagnosticEvent['context'],
  offset: number,
): void {
  const len = reader.readU32LE();
  if (len >= 0 && len <= reader.remaining) {
    reader.skip(len);
    return;
  }

  const nextEndt = reader.findTag4(TAG_ENDT, reader.pos);
  addDiagnostic(diagnostics, {
    severity: 'warn',
    code: 'SCAN_FORWARD_RECOVERY',
    tag: TAG_SIGN,
    offset,
    length: len,
    context,
    note: 'Recovered malformed SIGN payload by scanning to ENDT',
  });
  if (nextEndt >= reader.pos) {
    reader.pos = nextEndt;
    return;
  }
  reader.skip(reader.remaining);
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

function findPNG(
  data: Uint8Array,
  start: number,
  end: number,
  extendedEnd = end,
): { start: number; end: number } | null {
  const hardEnd = Math.min(end, data.length);
  const softEnd = Math.min(Math.max(end, extendedEnd), data.length);
  for (let i = start; i < softEnd - 8; i++) {
    if (data[i] === 0x89 && data[i+1] === 0x50 && data[i+2] === 0x4E && data[i+3] === 0x47 &&
        data[i+4] === 0x0D && data[i+5] === 0x0A && data[i+6] === 0x1A && data[i+7] === 0x0A) {
      // Walk PNG chunks instead of substring-scanning for IEND. Tiny tiles can
      // place the final chunk close to the TBBM boundary, and the loose scan
      // misses those valid short payloads.
      let cursor = i + 8;
      while (cursor + 12 <= softEnd) {
        const chunkLen = (data[cursor] << 24)
          | (data[cursor + 1] << 16)
          | (data[cursor + 2] << 8)
          | data[cursor + 3];
        if (chunkLen < 0) break;
        const chunkEnd = cursor + 12 + chunkLen;
        if (chunkEnd > softEnd) break;
        const isIEND = data[cursor + 4] === 0x49
          && data[cursor + 5] === 0x45
          && data[cursor + 6] === 0x4E
          && data[cursor + 7] === 0x44;
        cursor = chunkEnd;
        if (isIEND) return { start: i, end: cursor };
      }
      // Fallback for malformed-but-renderable payloads.
      for (let e = i + 8; e < softEnd - 11; e++) {
        if (data[e] === 0x00 && data[e+1] === 0x00 && data[e+2] === 0x00 && data[e+3] === 0x00 &&
            data[e+4] === 0x49 && data[e+5] === 0x45 && data[e+6] === 0x4E && data[e+7] === 0x44) {
          return { start: i, end: e + 12 };
        }
      }
      return { start: i, end: hardEnd };
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
    for (let j = tbbm.contentStart; j < tEnd - 5; j++) {
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
    const png = findPNG(data, tbbm.contentStart, tEnd, data.length);
    // Sparse bitmap atlases can contain valid tiny PNG tiles, especially when
    // a tile only carries a few opaque pixels. Reject only obviously broken payloads.
    if (png && png.end - png.start > 32 && clipW > 0 && clipH > 0) {
      tiles.push({
        clipX, clipY, clipW, clipH,
        pngData: data.slice(png.start, png.end),
      });
    }

    // Skip to end of this TBBM
    i = tEnd - 1;
  }
}

function hashBitmapTileData(data: Uint8Array): number {
  let hash = 2166136261;
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i];
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function dedupeBitmapTiles(tiles: TVGBitmapTile[]): TVGBitmapTile[] {
  const seen = new Set<string>();
  const deduped: TVGBitmapTile[] = [];
  for (const tile of tiles) {
    const key = `${tile.clipX}:${tile.clipY}:${tile.clipW}:${tile.clipH}:${tile.pngData.length}:${hashBitmapTileData(tile.pngData)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(tile);
  }
  return deduped;
}

/** Scan the entire raw TVG buffer for bitmap tile data (TBBM blocks).
 *  Searches UNCO/ZLIB blocks for TGBG markers, then extracts all TBBM tiles
 *  from the containing decoded data (bypassing TGBG length parsing). */
function scanForBitmapTiles(raw: Uint8Array, drawing: TVGDrawing, diagnostics?: TVGDiagnostics): void {
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
      // Scan the entire decoded block for TBBM tiles (don't rely on TGBG length).
      // Some bitmap-only TVGs spread tiles across multiple decoded wrappers, so
      // we cannot stop after the first hit.
      const before = drawing.bitmapTiles.length;
      parseTGBGTiles(decoded, drawing.bitmapTiles);
      hasTGBG = drawing.bitmapTiles.length > before;
    }

    // Recurse into nested UNCO/ZLIB blocks (e.g. TLAB wrappers)
    let foundAny = hasTGBG;
    if (depth < 3) {
      for (let j = 0; j < decoded.length - 8; j++) {
        if (decoded[j] === 0x55 && decoded[j+1] === 0x4E && decoded[j+2] === 0x43 && decoded[j+3] === 0x4F) { // UNCO
          const innerLen = decoded[j+4] | (decoded[j+5] << 8) | (decoded[j+6] << 16) | (decoded[j+7] << 24);
          if (innerLen > 0 && innerLen <= decoded.length - j - 8) {
            foundAny = scanDecodedForTiles(decoded.slice(j + 8, j + 8 + innerLen), depth + 1) || foundAny;
            j += 8 + innerLen - 1;
          }
        } else if (decoded[j] === 0x5A && decoded[j+1] === 0x4C && decoded[j+2] === 0x49 && decoded[j+3] === 0x42) { // ZLIB
          const tl = decoded[j+4] | (decoded[j+5] << 8) | (decoded[j+6] << 16) | (decoded[j+7] << 24);
          if (tl > 4 && tl <= decoded.length - j - 8) {
            try {
              const inner = pako.inflate(decoded.slice(j + 12, j + 12 + tl - 4));
              foundAny = scanDecodedForTiles(inner, depth + 1) || foundAny;
            } catch { /* skip */ }
            j += 8 + tl - 1;
          }
        }
      }
    }
    return foundAny;
  };

  let foundAny = false;
  for (let i = 20; i < raw.length - 8; i++) {
    const b0 = raw[i], b1 = raw[i+1], b2 = raw[i+2], b3 = raw[i+3];
    // UNCO block
    if (b0 === 0x55 && b1 === 0x4E && b2 === 0x43 && b3 === 0x4F) {
      const len = raw[i+4] | (raw[i+5] << 8) | (raw[i+6] << 16) | (raw[i+7] << 24);
      if (len <= 0 || len > raw.length - i - 8) continue;
      const decoded = raw.slice(i + 8, i + 8 + len);
      foundAny = scanDecodedForTiles(decoded, 0) || foundAny;
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
        foundAny = scanDecodedForTiles(decoded, 0) || foundAny;
      } catch { /* skip */ }
      i += 8 + totalLen - 1;
    }
  }

  if (foundAny) {
    drawing.bitmapTiles = dedupeBitmapTiles(drawing.bitmapTiles);
    if (diagnostics) {
      addDiagnostic(diagnostics, {
        severity: 'warn',
        code: 'BITMAP_FALLBACK_SCAN_USED',
        offset: 0,
        context: 'bitmap',
      });
    }
  }
}

// ── Main Data Parsing ──

function parseMainData(reader: BinaryReader, drawing: TVGDrawing): void {
  while (reader.remaining > 4) {
    const tagOffset = reader.pos;
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
        addDiagnostic(drawing.diagnostics, {
          severity: 'warn',
          code: 'UNKNOWN_MAIN_DATA_TAG',
          tag,
          offset: tagOffset,
          context: 'main-data',
          note: 'Failed to parse TLAB wrapper',
        });
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
        const layer = parseArtLayer(new BinaryReader(data.buffer), layerType, drawing.diagnostics);
        if (layer.shapes.length > 0) {
          drawing.layers.push(layer);
        }
      } catch (_e) {
        addDiagnostic(drawing.diagnostics, {
          severity: 'warn',
          code: 'UNKNOWN_MAIN_DATA_TAG',
          tag,
          offset: tagOffset,
          context: 'main-data',
          note: 'Failed to parse art layer payload',
        });
      }
    } else if (tag === TAG_TPAL) {
      try {
        const data = readEncodedData(reader);
        drawing.palette = parsePalette(new BinaryReader(data.buffer));
      } catch (_e) {
        addDiagnostic(drawing.diagnostics, {
          severity: 'warn',
          code: 'PALETTE_PARSE_SKIPPED',
          tag,
          offset: tagOffset,
          context: 'palette',
        });
      }
    } else if (tag === TAG_TGBG) {
      // Bitmap group — contains tiled PNG data
      try {
        const tgbgData = readRecoverableInnerTagPayload(reader, tag, drawing.diagnostics, 'bitmap', tagOffset);
        if (tgbgData && tgbgData.length > 0) {
          parseTGBGTiles(tgbgData, drawing.bitmapTiles);
        }
      } catch (_e) {
        addDiagnostic(drawing.diagnostics, {
          severity: 'warn',
          code: 'UNKNOWN_MAIN_DATA_TAG',
          tag,
          offset: tagOffset,
          context: 'bitmap',
          note: 'Failed to parse TGBG payload',
        });
      }
    } else if (tag === TAG_TGRV) {
      const rvLen = reader.readU32LE();
      if (rvLen >= 8 && rvLen <= reader.remaining) {
        const tgrvValue = reader.readF64LE();
        addDiagnostic(drawing.diagnostics, {
          severity: 'info',
          code: 'TGRV_PRESENT',
          tag,
          offset: tagOffset,
          length: rvLen,
          context: 'main-data',
          note: `main-data value=${tgrvValue}`,
        });
        if (rvLen > 8) reader.skip(rvLen - 8);
      } else if (rvLen > 0 && rvLen <= reader.remaining) {
        reader.skip(rvLen);
      } else {
        addDiagnostic(drawing.diagnostics, {
          severity: 'error',
          code: 'TRUNCATED_CHUNK',
          tag,
          offset: tagOffset,
          length: rvLen,
          context: 'main-data',
        });
      }
    } else if (tag === TAG_ENDT) {
      break;
    } else if (tag === TAG_TTOC) {
      const len = reader.readU32LE();
      reader.skip(len);
    } else if (tag === TAG_SIGN) {
      skipSignaturePayload(reader, drawing.diagnostics, 'main-data', tagOffset);
    } else {
      // Unknown tag in main data - try length-skip
      addDiagnostic(drawing.diagnostics, {
        severity: 'warn',
        code: 'UNKNOWN_MAIN_DATA_TAG',
        tag,
        offset: tagOffset,
        context: 'main-data',
      });
      if (reader.remaining >= 4) {
        const len = reader.readU32LE();
        if (len > 0 && len <= reader.remaining) {
          reader.skip(len);
        } else {
          addDiagnostic(drawing.diagnostics, {
            severity: 'error',
            code: 'TRUNCATED_CHUNK',
            tag,
            offset: tagOffset,
            length: len,
            context: 'main-data',
          });
          break;
        }
      } else {
        break;
      }
    }
  }
}

// ── Art Layer Parsing ──

function parseArtLayer(reader: BinaryReader, type: TVGArtLayer['type'], diagnostics?: TVGDiagnostics): TVGArtLayer {
  const layer: TVGArtLayer = { type, shapes: [] };

  if (reader.remaining < 6) return layer;

  // Preamble
  const dataType = reader.readU16LE();
  if (dataType === 0x0000) return layer; // Empty layer

  const shapeCount = reader.readU32LE();

  // Skip any extra preamble bytes (seen: 4 extra bytes before TGLY)
  // Look for TGLY tag
  for (let s = 0; s < shapeCount && reader.remaining > 8; s++) {
    let nodePosition: number | null = null;
    if (reader.remaining >= 8) {
      const candidatePos = reader.pos;
      const candidateNodePosition = reader.readU32LE();
      if (reader.peekTag4() === TAG_TGLY) {
        nodePosition = candidateNodePosition;
        reader.skip(4); // consume TGLY after the node-position preamble
      } else {
        reader.pos = candidatePos;
      }
    }
    // Find next TGLY tag
    if (nodePosition === null && !scanToTag(reader, TAG_TGLY, diagnostics, 'art-layer')) break;

    const shapeLen = reader.readU32LE();
    if (shapeLen > reader.remaining) break;

    const shapeEnd = reader.pos + shapeLen;
    const shapeType = reader.readU16LE();
    const componentCount = reader.readU32LE();

    const shape: TVGShape = { shapeType, components: [], nodePosition };

    let lastTGTBWidth: number | null = null;
    let lastTGTBProfile: TVGThicknessProfile | null = null;
    for (let c = 0; c < componentCount && reader.pos < shapeEnd; c++) {
      // Find next TGVS
      if (!scanToTag(reader, TAG_TGVS, diagnostics, 'component')) break;

      const vsLen = reader.readU32LE();
      if (vsLen > reader.remaining) break;

      const vsEnd = reader.pos + vsLen;
      const comp = parseComponent(reader, vsEnd, diagnostics, lastTGTBWidth, lastTGTBProfile);
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

  borrowMissingPencilPaths(layer);

  return layer;
}

function canBorrowMissingPencilPaths(prev: TVGShape, shape: TVGShape): boolean {
  const prevFills = prev.components.filter(c => c.componentType === 0 && c.path && c.path.segments.length > 0);
  const missingPencils = shape.components.filter(c => c.componentType === 4 && (!c.path || c.path.segments.length === 0));
  if (prev.shapeType !== 1 || prevFills.length === 0 || missingPencils.length === 0) return false;

  if (shape.shapeType === 5) {
    return true;
  }

  return (shape.shapeType === 1 || shape.shapeType === 4)
    && missingPencils.length === shape.components.length
    && prevFills.length >= missingPencils.length;
}

function borrowMissingPencilPaths(layer: TVGArtLayer): void {
  for (let si = 1; si < layer.shapes.length; si++) {
    const shape = layer.shapes[si];
    const prev = layer.shapes[si - 1];
    if (!canBorrowMissingPencilPaths(prev, shape)) continue;

    const prevFills = prev.components.filter(c => c.componentType === 0 && c.path && c.path.segments.length > 0);
    const pencils = shape.components.filter(c => c.componentType === 4 && (!c.path || c.path.segments.length === 0));
    for (let pi = 0; pi < pencils.length && pi < prevFills.length; pi++) {
      const shouldUseHint = prevFills.length !== pencils.length;
      const pathRefHint = pencils[pi].pathRefHint;
      const hintedFill = shouldUseHint && pathRefHint !== null
        ? prevFills[pathRefHint - 1] ?? null
        : null;
      pencils[pi].path = hintedFill?.path ?? prevFills[pi].path;
    }
  }
}

export function __borrowMissingPencilPathsForTests(layer: TVGArtLayer): void {
  borrowMissingPencilPaths(layer);
}

function scanToTag(
  reader: BinaryReader,
  tag: string,
  diagnostics?: TVGDiagnostics,
  context: TVGDiagnosticEvent['context'] = 'component',
): boolean {
  // Look for the tag within the next few bytes
  const startPos = reader.pos;
  const maxScan = Math.min(reader.remaining, 64);
  for (let i = 0; i < maxScan - 3; i++) {
    if (reader.peekTag4() === tag) {
      if (i > 0 && diagnostics) {
        addDiagnostic(diagnostics, {
          severity: 'warn',
          code: 'SCAN_FORWARD_RECOVERY',
          tag,
          offset: startPos,
          length: i,
          context,
        });
      }
      reader.skip(4); // consume the tag
      return true;
    }
    reader.skip(1);
  }
  reader.pos = startPos;
  return false;
}

// ── Component Parsing ──

function parseComponent(
  reader: BinaryReader,
  endPos: number,
  diagnostics?: TVGDiagnostics,
  prevTGTBWidth?: number | null,
  prevTGTBProfile?: TVGThicknessProfile | null,
): TVGComponent | null {
  const comp: TVGComponent = {
    componentType: -1,
    colorId: null,
    insideColorId: null,
    paletteIndex: null,
    color: null,
    fillPaintSource: null,
    insideColor: null,
    transform: null,
    path: null,
    strokeWidth: null,
    thicknessProfile: null,
    joinType: 'round',
    fromTipType: 'round',
    toTipType: 'round',
    tgtiThickness: null,
    tgtiTextureScaleX: null,
    tgtiTextureScaleY: null,
    tgtiTextureOffset: null,
    tgtiOpacityThickness: null,
    tgtiOpacityScaleX: null,
    tgtiOpacityScaleY: null,
    tgtiOpacityOffset: null,
    tgtiHasTextureFlags: null,
    pathRefHint: null,
    outerPaint: null,
    innerPaint: null,
  };
  let pendingTGRVValue: number | null = null;

  while (reader.pos < endPos - 4) {
    const tagOffset = reader.pos;
    const tag = reader.readTag4();

    if (tag === TAG_TGSD) {
      const sdLen = reader.readU32LE();
      if (sdLen > reader.remaining) {
        if (diagnostics) {
          addDiagnostic(diagnostics, {
            severity: 'error',
            code: 'TRUNCATED_CHUNK',
            tag,
            offset: tagOffset,
            length: sdLen,
            context: 'component',
          });
        }
        reader.pos = endPos; return null;
      }
      const sdEnd = reader.pos + sdLen;
      parseTGSD(reader, comp, sdLen);
      reader.pos = sdEnd;
    } else if (tag === TAG_TGCO) {
      const coLen = reader.readU32LE();
      if (coLen > reader.remaining) {
        if (diagnostics) {
          addDiagnostic(diagnostics, {
            severity: 'error',
            code: 'TRUNCATED_CHUNK',
            tag,
            offset: tagOffset,
            length: coLen,
            context: 'component',
          });
        }
        reader.pos = endPos; return null;
      }
      const coEnd = reader.pos + coLen;
      parseTGCO(reader, comp, coLen);
      reader.pos = coEnd;
    } else if (tag === TAG_TGBP) {
      const bpLen = reader.readU32LE();
      if (bpLen > reader.remaining) {
        if (diagnostics) {
          addDiagnostic(diagnostics, {
            severity: 'error',
            code: 'TRUNCATED_CHUNK',
            tag,
            offset: tagOffset,
            length: bpLen,
            context: 'component',
          });
        }
        reader.pos = endPos; return null;
      }
      const bpEnd = reader.pos + bpLen;
      comp.path = parseTGBP(reader, bpLen);
      if (comp.path && pendingTGRVValue !== null) {
        comp.path.tgrvValue = pendingTGRVValue;
      }
      reader.pos = bpEnd;
    } else if (tag === TAG_TGRV) {
      const rvLen = reader.readU32LE();
      if (rvLen >= 8 && rvLen <= reader.remaining) {
        pendingTGRVValue = reader.readF64LE();
        if (comp.path) {
          comp.path.tgrvValue = pendingTGRVValue;
        }
        if (diagnostics) {
          addDiagnostic(diagnostics, {
            severity: 'info',
            code: 'TGRV_PRESENT',
            tag,
            offset: tagOffset,
            length: rvLen,
            context: 'component',
            note: `value=${pendingTGRVValue}`,
          });
        }
        if (rvLen > 8) reader.skip(rvLen - 8);
      } else if (rvLen > 0 && rvLen <= reader.remaining) {
        reader.skip(rvLen);
      } else if (diagnostics) {
        addDiagnostic(diagnostics, {
          severity: 'error',
          code: 'TRUNCATED_CHUNK',
          tag,
          offset: tagOffset,
          length: rvLen,
          context: 'component',
        });
      }
    } else if (tag === 'tGTB') {
      // Pencil thickness: extract thickness profile and max width
      const len = reader.readU32LE();
      if (len > reader.remaining) { reader.skip(Math.min(len, reader.remaining)); } else {
        const tbEnd = reader.pos + len;
        const result = parseTGTB(reader, len, prevTGTBProfile || null);
        if (result) {
          comp.strokeWidth = result.maxWidth;
          comp.thicknessProfile = result.profile;
          comp.fromTipType = result.fromTip;
          comp.toTipType = result.toTip;
          comp.joinType = result.join;
        }
        // Fallback: inherit width from previous component if type=0x00 returned null
        if (comp.strokeWidth === null && prevTGTBWidth != null) {
          comp.strokeWidth = prevTGTBWidth;
        }
        reader.pos = tbEnd;
      }
    } else if (tag === 'tGTI') {
      // Full 76-byte tGTI structure (all f64 except last u32):
      //   +0: sentinel u64 (0xFFFFFFFFFFFFFFFF)
      //   +8: thickness f64
      //   +16: textureScaleX f64
      //   +24: textureScaleY f64
      //   +32: textureOffset f64
      //   +40: opacityThickness f64
      //   +48: opacityScaleX f64
      //   +56: opacityScaleY f64
      //   +64: opacityOffset f64
      //   +72: hasTextureFlags u32
      const len = reader.readU32LE();
      if (len >= 16 && reader.remaining >= len) {
        const tiEnd = reader.pos + len;
        reader.skip(8); // sentinel u64 (0xFFFFFFFFFFFFFFFF)
        const thickness = reader.readF64LE(); // +8
        if (comp.strokeWidth === null) {
          comp.strokeWidth = thickness;
        }
        comp.tgtiThickness = thickness;

        if (len >= 76) {
          // Full 76-byte structure
          comp.tgtiTextureScaleX = reader.readF64LE();   // +16
          comp.tgtiTextureScaleY = reader.readF64LE();   // +24
          comp.tgtiTextureOffset = reader.readF64LE();   // +32
          comp.tgtiOpacityThickness = reader.readF64LE(); // +40
          comp.tgtiOpacityScaleX = reader.readF64LE();   // +48
          comp.tgtiOpacityScaleY = reader.readF64LE();   // +56
          comp.tgtiOpacityOffset = reader.readF64LE();   // +64
          comp.tgtiHasTextureFlags = reader.readU32LE(); // +72
        }
        reader.pos = tiEnd;
      } else {
        reader.skip(Math.min(len, reader.remaining));
      }
    } else {
      reader.pos -= 4;
      if (reader.pos + 8 <= endPos) {
        const candidateRef = reader.readU32LE();
        const nextTag = reader.peekTag4();
        if (comp.componentType === 4 && nextTag === 'tGTB' && candidateRef > 0 && candidateRef <= 255) {
          comp.pathRefHint = candidateRef;
          continue;
        }
        reader.pos -= 4;
      }
      if (reader.pos < endPos) {
        const b = reader.readU8();
        if (b !== 0x00 && b !== 0x01) {
          // Unknown data, try to continue
          reader.pos -= 1;
          if (diagnostics) {
            addDiagnostic(diagnostics, {
              severity: 'warn',
              code: 'UNKNOWN_COMPONENT_TAG',
              tag,
              offset: tagOffset,
              context: 'component',
            });
          }
          // Scan forward to next known tag
          if (!scanToNextKnownTag(reader, endPos, diagnostics)) {
            reader.pos = endPos;
            return comp;
          }
        }
      }
    }
  }

  // Finding 7: Combine TGBP endpoint-proximity heuristic with tGTB closed flag.
  // If the thickness profile says the path is closed, mark the path as closed too.
  if (comp.path && comp.thicknessProfile && comp.thicknessProfile.closed && !comp.path.closed) {
    comp.path.closed = true;
  }
  if (comp.path && pendingTGRVValue !== null) {
    comp.path.tgrvValue = pendingTGRVValue;
  }

  return comp;
}

function scanToNextKnownTag(reader: BinaryReader, endPos: number, diagnostics?: TVGDiagnostics): boolean {
  const knownTags = [TAG_TGSD, TAG_TGCO, TAG_TGBP, TAG_TGRV, 'tGTB', 'tGTI'];
  const startPos = reader.pos;
  while (reader.pos < endPos - 4) {
    const peek = reader.peekTag4();
    if (knownTags.includes(peek)) {
      if (reader.pos > startPos && diagnostics) {
        addDiagnostic(diagnostics, {
          severity: 'warn',
          code: 'SCAN_FORWARD_RECOVERY',
          tag: peek,
          offset: startPos,
          length: reader.pos - startPos,
          context: 'component',
        });
      }
      return true;
    }
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

  if (comp.componentType === 0 || comp.componentType === 1) {
    // Fill component: byte 1 is a flag for embedded color presence
    // 0x01 = has embedded TGCO sub-tag with color UID
    // 0x00 = no embedded color (needs external project palette / inheritance)
    if (len >= 2) {
      const hasColor = reader.readU8();
      if (hasColor === 0x01) {
        // Scan for embedded TGCO tag to extract transform data and colorId
        scanAndParseTGCO(reader, comp, sdEnd);
        // Fallback: read color ID 24 bytes from end of TGSD.
        // Only use this if TGCO didn't already provide a valid colorId.
        // The 24-from-end heuristic works for TGSD len=85 but reads zeros
        // for len=133 where there are extra bytes after the TGCO block.
        if (len >= 26 && comp.colorId === null) {
          reader.pos = sdStart + len - 24;
          comp.colorId = reader.readU64LE();
        }
      } else if (hasColor === 0x00) {
        // hasColor=0x00 can mean two things:
        // 1. Short fills (len=13): no color, inherit from preceding fill
        // 2. Long fills (len>=85): ALSO has an embedded TGCO at offset 9 (shifted by 5 extra bytes)
        //    The structure is: 4 zero bytes + 0x01 flag + 2 unknown bytes + TGCO tag
        if (len >= 85) {
          // Scan for embedded TGCO in the hasColor=0 variant
          const foundTGCO = scanAndParseTGCO(reader, comp, sdEnd);
          // Only use the 24-from-end heuristic when a real TGCO block exists.
          // On long hasColor=0 fills without TGCO, this fallback can misread a
          // trailing payload and pin the component to the wrong explicit color.
          if (foundTGCO && comp.colorId === null && len >= 26) {
            reader.pos = sdStart + len - 24;
            comp.colorId = reader.readU64LE();
          }
        } else if (len >= 6) {
          // Short fill: read palette index for potential lookup
          comp.paletteIndex = reader.readU32LE();
        }
      }
    }
  } else if (comp.componentType === 4) {
    // Pencil component: has inline color ID
    // Full structure is 25 bytes when len=25:
    //   byte[0]: componentType (already read)
    //   bytes[1-4]: f32 brush size (~10.0)
    //   bytes[5-12]: colorId (u64)
    //   bytes[13-24]: 12 zero bytes (reserved/padding)
    if (reader.remaining >= 12) {
      const brushSize = reader.readF32LE();
      if (Number.isFinite(brushSize) && brushSize > 0) {
        const shouldUseInlineBrushSize = comp.strokeWidth === null
          || comp.strokeWidth <= 0.05
          || (comp.tgtiThickness !== null && Math.abs(comp.strokeWidth - comp.tgtiThickness) < 1e-6);
        if (shouldUseInlineBrushSize) {
          comp.strokeWidth = brushSize;
        }
      }
      comp.colorId = reader.readU64LE();
      // Read remaining bytes (12 zero bytes for len=25) — currently unused but consumed
      const extraBytes = sdEnd - reader.pos;
      if (extraBytes > 0) {
        reader.skip(extraBytes);
      }
    }
  } else if (comp.componentType === 2) {
    // Brush stroke: similar structure to fill — check for embedded color
    if (len >= 2) {
      const hasColor = reader.readU8();
      if (hasColor === 0x01) {
        scanAndParseTGCO(reader, comp, sdEnd);
        if (len >= 26 && comp.colorId === null) {
          reader.pos = sdStart + len - 24;
          comp.colorId = reader.readU64LE();
        }
      }
    }
  }

  reader.pos = sdEnd;
}

/** Scan within TGSD data for an embedded TGCO sub-tag and parse it. */
function scanAndParseTGCO(reader: BinaryReader, comp: TVGComponent, endPos: number): boolean {
  const scanStart = reader.pos;
  while (reader.pos < endPos - 8) {
    if (reader.peekTag4() === TAG_TGCO) {
      reader.skip(4); // consume TGCO tag
      const coLen = reader.readU32LE();
      const coEnd = reader.pos + coLen;
      if (coEnd <= endPos) {
        parseTGCO(reader, comp, coLen);
        reader.pos = coEnd;
        return true;
      }
    }
    reader.skip(1);
  }
  reader.pos = scanStart;
  return false;
}

// ── TGCO Parsing ──

function parseTGCO(reader: BinaryReader, comp: TVGComponent, len: number): void {
  if (len < 57) return;

  // Entry 1 (bytes 0-56): outside color (colorType + transform + colorId)
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
  // This is the authoritative source for both fills and strokes when TGCO is present.
  if (len >= 57 && comp.colorId === null) {
    comp.colorId = reader.readU64LE();
  }

  // Entry 2 (bytes 57-113): inside color (same structure: colorType + transform + colorId)
  // When TGCO length >= 114, there are TWO 57-byte color entries.
  // The inside colorId is usually 0xFFFFFFFFFFFFFFFF (null/unused).
  if (len >= 114) {
    const insideColorType = reader.readU8();
    void insideColorType;
    // Skip inside transform (6 x f64 = 48 bytes)
    reader.skip(48);
    const insideColorId = reader.readU64LE();
    // Store insideColorId; 0xFFFFFFFFFFFFFFFF means "no inside color"
    const NULL_COLOR_ID = 0xFFFFFFFFFFFFFFFFn;
    comp.insideColorId = (insideColorId === NULL_COLOR_ID) ? null : insideColorId;
  }
}

// ── Join/Tip Type Decoders ──

/** Decode a join type byte: 0=ROUND, 1=MITER, 2=BEVEL */
function decodeJoinType(b: number): TVGJoinType {
  switch (b) {
    case 1: return 'miter';
    case 2: return 'bevel';
    default: return 'round';
  }
}

/** Decode a tip (cap) type byte: 0=ROUND, 1=FLAT, 2=BEVEL */
function decodeTipType(b: number): TVGTipType {
  switch (b) {
    case 1: return 'butt';   // FLAT_TIP
    case 2: return 'square'; // BEVEL_TIP
    default: return 'round'; // ROUND_TIP
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
): { maxWidth: number; profile: TVGThicknessProfile; fromTip: TVGTipType; toTip: TVGTipType; join: TVGJoinType } | null {
  if (len < 10) return null;
  const startPos = reader.pos;
  const endPos = startPos + len;

  try {
    const type = reader.readU8();

    if (type === 0x00) {
      // Reference to previous thickness profile — reuse definition, read new domain
      reader.readU32LE(); // id
      const domainResult = readTGTBDomain(reader, endPos);
      if (prevProfile && domainResult) {
        // Reuse previous profile's points with new domain
        const profile: TVGThicknessProfile = {
          points: prevProfile.points,
          domain: domainResult.domain,
          tipTangentLeftFrom: domainResult.tipTangentLeftFrom,
          tipTangentRightFrom: domainResult.tipTangentRightFrom,
          tipTangentLeftTo: domainResult.tipTangentLeftTo,
          tipTangentRightTo: domainResult.tipTangentRightTo,
          closed: prevProfile.closed,
        };
        let maxWidth = 0;
        for (const pt of profile.points) {
          const w = pt.leftOffset + pt.rightOffset;
          if (w > maxWidth) maxWidth = w;
        }
        return { maxWidth, profile, fromTip: 'round', toTip: 'round', join: 'round' };
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

    // Read 5-byte trailer: tip/join/closed flags
    // byte[0]: tipType_from (0=FLAT, 1=ROUND, 2=BEVEL)
    // byte[1]: tipType_to
    // byte[2]: joinType (0=ROUND, 1=MITER, 2=BEVEL)
    // byte[3]: closed flag (0 or 1)
    // byte[4]: reserved
    let fromTip: TVGTipType = 'round';
    let toTip: TVGTipType = 'round';
    let join: TVGJoinType = 'round';
    let tgtbClosed = false;
    if (reader.pos + 5 <= endPos) {
      const tipFromByte = reader.readU8();
      const tipToByte = reader.readU8();
      const joinByte = reader.readU8();
      const closedByte = reader.readU8();
      reader.skip(1); // reserved byte
      // Only apply if the values look like valid enum values (0-2)
      if (tipFromByte <= 2 && tipToByte <= 2 && joinByte <= 2) {
        fromTip = decodeTipType(tipFromByte);
        toTip = decodeTipType(tipToByte);
        join = decodeJoinType(joinByte);
      }
      tgtbClosed = closedByte !== 0;
    }

    // Read domain (6 x f32 = 24 bytes)
    const domainResult = readTGTBDomain(reader, endPos);

    if (maxWidth <= 0) return null;
    return {
      maxWidth,
      profile: {
        points,
        domain: domainResult ? domainResult.domain : [0, 1],
        tipTangentLeftFrom: domainResult ? domainResult.tipTangentLeftFrom : 0,
        tipTangentRightFrom: domainResult ? domainResult.tipTangentRightFrom : 0,
        tipTangentLeftTo: domainResult ? domainResult.tipTangentLeftTo : 0,
        tipTangentRightTo: domainResult ? domainResult.tipTangentRightTo : 0,
        closed: tgtbClosed,
      },
      fromTip, toTip, join,
    };
  } catch (_e) {
    reader.pos = startPos;
    return null;
  }
}

/**
 * Read the tGTB domain section: 6 x f32 = 24 bytes.
 *   f32: domainStart
 *   f32: tipTangent(left, from)
 *   f32: tipTangent(right, from)
 *   f32: domainEnd
 *   f32: tipTangent(left, to)
 *   f32: tipTangent(right, to)
 */
interface TGTBDomainResult {
  domain: [number, number];
  tipTangentLeftFrom: number;
  tipTangentRightFrom: number;
  tipTangentLeftTo: number;
  tipTangentRightTo: number;
}

function readTGTBDomain(reader: BinaryReader, endPos: number): TGTBDomainResult | null {
  if (reader.pos + 24 > endPos) return null;
  try {
    const domainStart = reader.readF32LE();
    const tipTangentLeftFrom = reader.readF32LE();
    const tipTangentRightFrom = reader.readF32LE();
    const domainEnd = reader.readF32LE();
    const tipTangentLeftTo = reader.readF32LE();
    const tipTangentRightTo = reader.readF32LE();
    return {
      domain: [domainStart, domainEnd],
      tipTangentLeftFrom,
      tipTangentRightFrom,
      tipTangentLeftTo,
      tipTangentRightTo,
    };
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

  // Check for explicit closed flag byte after the point data.
  // Expected consumed bytes: 4 (numPoints) + flagByteCount + numPoints*8 (points)
  const consumedBytes = 4 + flagByteCount + numPoints * 8;
  let closed = false;
  if (consumedBytes < len) {
    // There are trailing bytes — the first one is likely the closed flag (0 or 1)
    const closedByte = reader.readU8();
    closed = closedByte !== 0;
  }

  // Some paths return to their start point without setting the explicit closed bit.
  // Treat those as closed so stroke rendering uses joins instead of open-end caps.
  if (!closed && points.length >= 2) {
    const first = points[0];
    const last = points[points.length - 1];
    const dx = Math.abs(first.x - last.x);
    const dy = Math.abs(first.y - last.y);
    closed = dx < 0.001 && dy < 0.001;
  }

  return { segments, closed, tgrvValue: null, directionReversed: null };
}

// ── Palette Parsing ──

function parsePalette(reader: BinaryReader): TVGPaletteEntry[] {
  const entries: TVGPaletteEntry[] = [];

  if (reader.remaining < 8) return entries;

  const colorCount = reader.readU32LE();
  reader.readU32LE(); // startMarker 0x79

  for (let i = 0; i < colorCount && reader.remaining > 4; i++) {
    const entry: TVGPaletteEntry = { name: '', id: 0n, paletteName: '', r: 0, g: 0, b: 0, a: 255 };

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

        // Source palette name (u32 charCount + UTF-16LE string)
        const remainingInTCID = idEnd - reader.pos;
        if (remainingInTCID >= 4) {
          const palNameCharCount = reader.readU32LE();
          if (palNameCharCount > 0 && palNameCharCount < 1000 && (idEnd - reader.pos) >= palNameCharCount * 2) {
            const palNameBytes = reader.readBytes(palNameCharCount * 2);
            entry.paletteName = decodeUTF16LE(palNameBytes);
          }
        }

        // Skip rest
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
  name?: string; // color entry name (e.g., "Skin", "Hair")
  paletteName?: string; // source palette file name without .plt (e.g., "Anna")
  gradientType?: 'linear' | 'radial';
  stops?: { pos: number; r: number; g: number; b: number; a: number }[];
}

function buildPaint(
  color: { r: number; g: number; b: number; a: number } | null,
  gradientType?: 'linear' | 'radial',
  gradientStops?: { pos: number; r: number; g: number; b: number; a: number }[],
  transform?: TVGTransform | null,
): TVGPaint | null {
  if (!color) return null;
  if (gradientType && gradientStops && gradientStops.length > 0) {
    return {
      kind: 'gradient',
      gradientType,
      stops: gradientStops,
      transform: transform ?? null,
      fallback: color,
    };
  }
  return { kind: 'solid', rgba: color };
}

function updateComponentPaints(comp: TVGComponent): void {
  comp.outerPaint = buildPaint(comp.color, comp.gradientType, comp.gradientStops, comp.transform);
  comp.innerPaint = comp.insideColor ? { kind: 'solid', rgba: comp.insideColor } : null;
}

function hasExplicitFillStyle(comp: TVGComponent): boolean {
  return (comp.componentType === 0 || comp.componentType === 1) && comp.fillPaintSource === 'explicit';
}

function canInheritFillColor(comp: TVGComponent): boolean {
  return comp.componentType === 0;
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

  // Build a name-based lookup: paletteName -> colorName -> ExternalPaletteColor
  // Used as fallback when ID matching fails
  const nameMap = new Map<string, Map<string, ExternalPaletteColor>>();
  for (const color of externalColors) {
    if (color.paletteName && color.name) {
      let byName = nameMap.get(color.paletteName);
      if (!byName) {
        byName = new Map();
        nameMap.set(color.paletteName, byName);
      }
      // First entry wins (don't overwrite)
      if (!byName.has(color.name)) {
        byName.set(color.name, color);
      }
    }
  }

  // Build a global colorName -> ExternalPaletteColor map (first occurrence wins).
  // Used as last-resort fallback when no palette name matches at all.
  const globalNameMap = new Map<string, ExternalPaletteColor>();
  for (const color of externalColors) {
    if (color.name && !globalNameMap.has(color.name)) {
      globalNameMap.set(color.name, color);
    }
  }

  // Build TPAL id -> entry map for fallback lookup
  const tpalById = new Map<bigint, TVGPaletteEntry>();
  for (const entry of drawing.palette) {
    if (entry.id !== 0n) {
      tpalById.set(entry.id, entry);
    }
  }

  // Fuzzy palette name matcher: given a TPAL palette name, find the best matching
  // external palette. Tries: (1) exact, (2) case-insensitive, (3) word-overlap scoring.
  const fuzzyPaletteCache = new Map<string, Map<string, ExternalPaletteColor> | null>();
  const extPaletteNames = Array.from(nameMap.keys());

  function fuzzyFindPalette(tpalPalName: string): Map<string, ExternalPaletteColor> | null {
    if (fuzzyPaletteCache.has(tpalPalName)) return fuzzyPaletteCache.get(tpalPalName)!;

    // 1. Exact match
    let result = nameMap.get(tpalPalName) ?? null;
    if (result) { fuzzyPaletteCache.set(tpalPalName, result); return result; }

    const tpalLower = tpalPalName.toLowerCase();

    // 2. Case-insensitive exact match
    for (const extName of extPaletteNames) {
      if (extName.toLowerCase() === tpalLower) {
        result = nameMap.get(extName)!;
        fuzzyPaletteCache.set(tpalPalName, result);
        return result;
      }
    }

    // 3. Split both names into word tokens and score by overlap.
    // Tokenize on underscores, spaces, camelCase boundaries, and dots.
    const tokenize = (s: string): string[] =>
      s.toLowerCase()
        .replace(/([a-z])([A-Z])/g, '$1_$2')
        .split(/[_\s.]+/)
        .filter(t => t.length > 0);

    const tpalTokens = tokenize(tpalPalName);
    if (tpalTokens.length === 0) {
      fuzzyPaletteCache.set(tpalPalName, null);
      return null;
    }

    let bestMatch: string | null = null;
    let bestScore = 0;

    for (const extName of extPaletteNames) {
      const extTokens = tokenize(extName);
      if (extTokens.length === 0) continue;

      // Count shared tokens (case-insensitive)
      let shared = 0;
      for (const tt of tpalTokens) {
        if (extTokens.includes(tt)) shared++;
      }
      if (shared === 0) {
        // Try prefix/substring matching on individual tokens
        for (const tt of tpalTokens) {
          for (const et of extTokens) {
            if (et.startsWith(tt) || tt.startsWith(et)) {
              shared = 0.5; // partial credit
              break;
            }
          }
          if (shared > 0) break;
        }
      }

      if (shared > bestScore) {
        bestScore = shared;
        bestMatch = extName;
      }
    }

    result = bestMatch ? nameMap.get(bestMatch)! : null;
    fuzzyPaletteCache.set(tpalPalName, result);
    return result;
  }

  // Helper: apply color (and gradient info if present) from an external palette entry to a component
  const applyExtColor = (comp: TVGComponent, ext: ExternalPaletteColor) => {
    comp.color = { r: ext.r, g: ext.g, b: ext.b, a: ext.a };
    if (comp.componentType === 0 || comp.componentType === 1) {
      comp.fillPaintSource = 'explicit';
    }
    if (ext.gradientType && ext.stops && ext.stops.length > 0) {
      comp.gradientType = ext.gradientType;
      comp.gradientStops = ext.stops;
    }
  };

  for (const layer of drawing.layers) {
    for (const shape of layer.shapes) {
      for (const comp of shape.components) {
        if (comp.colorId !== null) {
          const ext = extMap.get(comp.colorId);
          if (ext) {
            // External palette always overrides (more authoritative than internal TPAL)
            applyExtColor(comp, ext);
          } else {
            // Fallback: match by palette name + color entry name
            const tpalEntry = tpalById.get(comp.colorId);
            if (tpalEntry && tpalEntry.paletteName && tpalEntry.name) {
              // Guard: if the TPAL entry already has a valid non-default color
              // (a > 0 and not pure black), the inline color is authoritative for
              // this element.  Name-based fuzzy/global matching can pull in a
              // colour from a *different* palette namespace with the same name
              // but different RGB values, so skip it when the TPAL colour is
              // already meaningful.
              const tpalHasColor = tpalEntry.a > 0 &&
                !(tpalEntry.r === 0 && tpalEntry.g === 0 && tpalEntry.b === 0);

              if (!tpalHasColor) {
                // Try fuzzy palette name matching (exact -> case-insensitive -> word overlap)
                const byName = fuzzyFindPalette(tpalEntry.paletteName);
                if (byName) {
                  const named = byName.get(tpalEntry.name);
                  if (named) {
                    applyExtColor(comp, named);
                  }
                } else {
                  // Last resort: match color name across ALL palettes
                  const globalMatch = globalNameMap.get(tpalEntry.name);
                  if (globalMatch) {
                    applyExtColor(comp, globalMatch);
                  }
                }
              }
            }
          }
        }
        if (comp.insideColorId !== null) {
          const insideExt = extMap.get(comp.insideColorId);
          if (insideExt) {
            comp.insideColor = { r: insideExt.r, g: insideExt.g, b: insideExt.b, a: insideExt.a };
          }
        }
        updateComponentPaints(comp);
      }
      // Re-apply fill inheritance after external palette resolution
      const fillCarriers = shape.components.filter(c => c.componentType === 0 || c.componentType === 1);
      let lastColor: { r: number; g: number; b: number; a: number } | null = null;
      let lastFillSource: TVGComponent['fillPaintSource'] = null;
      for (const comp of fillCarriers) {
        if (comp.color !== null) {
          lastColor = comp.color;
          lastFillSource = comp.fillPaintSource;
        } else if (comp.componentType === 0 && lastColor !== null && canInheritFillColor(comp)) {
          comp.color = { ...lastColor };
          comp.fillPaintSource = lastFillSource === 'default' ? 'default' : 'inherited';
        }
        updateComponentPaints(comp);
      }
      for (const comp of shape.components) {
        updateComponentPaints(comp);
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
  /** Center the viewport on the origin (0,0) instead of the content centroid.
   *  Used by the compositor so all elements share the same coordinate space. */
  centerOnOrigin?: boolean;
  /** Supersampling factor for antialiasing (e.g., 2 for 2x supersampling).
   *  Renders internally at width*SS x height*SS then downsamples. */
  supersample?: number;
  /** Skip flood-fill clipping for faster rendering (e.g., grid thumbnails). */
  skipClipping?: boolean;
  /** Skip white background pre-composite (for matte/compositor sources). */
  skipBackgroundComposite?: boolean;
}

function getActiveArtLayerTypes(options?: TVGRenderOptions): TVGArtLayer['type'][] {
  const includeUnderlay = options?.includeUnderlay ?? true;
  const artLayerFilter = options?.artLayerFilter;
  if (artLayerFilter && artLayerFilter !== 'all') {
    return [artLayerFilter];
  }
  return includeUnderlay
    ? ['underlay', 'color', 'line', 'overlay']
    : ['color', 'line', 'overlay'];
}

function shapeMayRenderVisibleContent(
  shape: TVGShape,
  layer: TVGArtLayer,
  allLayers: TVGArtLayer[],
  defaultBoundaryFillColor: { r: number; g: number; b: number; a: number } | null,
  defaultStrokeWidth: number,
): boolean {
  const fillComps = shape.components.filter(comp =>
    (comp.componentType === 0 || comp.componentType === 1)
    && comp.path
    && comp.path.segments.length > 1
    && !isDegenerate(comp.path),
  );
  if (fillComps.some(comp =>
    comp.outerPaint !== null
    || comp.fillPaintSource !== null
    || comp.paletteIndex !== null
    || comp.colorId !== null,
  )) {
    return true;
  }

  const strokeComps = shape.components.filter(comp =>
    (comp.componentType === 2 || comp.componentType === 4)
    && comp.path
    && comp.path.segments.length > 0,
  );
  if (strokeComps.some(comp =>
    shouldRenderWidthlessBoundaryStroke(layer, shape, comp)
    || (comp.outerPaint !== null && resolveStrokeProfile(comp, defaultStrokeWidth) !== null),
  )) {
    return true;
  }

  if (defaultBoundaryFillColor
    && isBoundaryOnlyShape(shape)
    && !hasSiblingRenderableFillShape(allLayers, layer, shape)) {
    return true;
  }

  const hasOnlyPencils = strokeComps.length > 0 && strokeComps.every(comp => comp.componentType === 4);
  const hasVisiblePencilPaint = strokeComps.some(comp =>
    comp.componentType === 4
    && comp.outerPaint?.kind === 'solid'
    && comp.outerPaint.rgba.r >= 30
    && comp.outerPaint.rgba.g >= 30
    && comp.outerPaint.rgba.b >= 30,
  );
  return layer.type !== 'line' && hasOnlyPencils && hasVisiblePencilPaint;
}

function collectRenderablePoints(
  drawing: TVGDrawing,
  activeLayerTypes: TVGArtLayer['type'][],
  defaultBoundaryFillColor: { r: number; g: number; b: number; a: number } | null,
  defaultStrokeWidth: number,
): { x: number; y: number }[] {
  const activeTypes = new Set(activeLayerTypes);
  const allPoints: { x: number; y: number }[] = [];
  for (const layer of drawing.layers) {
    if (!activeTypes.has(layer.type)) continue;
    for (const shape of layer.shapes) {
      if (!shapeMayRenderVisibleContent(shape, layer, drawing.layers, defaultBoundaryFillColor, defaultStrokeWidth)) {
        continue;
      }
      for (const comp of shape.components) {
        if (!comp.path) continue;
        for (const seg of comp.path.segments) {
          allPoints.push({ x: seg.x, y: seg.y });
          if (seg.type === 'Q') allPoints.push({ x: seg.cx, y: seg.cy });
          else if (seg.type === 'C') {
            allPoints.push({ x: seg.c1x, y: seg.c1y });
            allPoints.push({ x: seg.c2x, y: seg.c2y });
          }
        }
      }
    }
  }

  if (allPoints.length > 0) {
    return allPoints;
  }

  for (const layer of drawing.layers) {
    if (!activeTypes.has(layer.type)) continue;
    for (const shape of layer.shapes) {
      for (const comp of shape.components) {
        if (!comp.path) continue;
        for (const seg of comp.path.segments) {
          allPoints.push({ x: seg.x, y: seg.y });
          if (seg.type === 'Q') allPoints.push({ x: seg.cx, y: seg.cy });
          else if (seg.type === 'C') {
            allPoints.push({ x: seg.c1x, y: seg.c1y });
            allPoints.push({ x: seg.c2x, y: seg.c2y });
          }
        }
      }
    }
  }
  return allPoints;
}

function computeMaxStrokeWidth(drawing: TVGDrawing, fallbackWidth: number): number {
  let maxStrokeW = 0;
  for (const layer of drawing.layers) {
    for (const shape of layer.shapes) {
      for (const comp of shape.components) {
        if (comp.componentType !== 2 && comp.componentType !== 4) continue;
        if (comp.strokeWidth !== null && comp.strokeWidth > maxStrokeW) {
          maxStrokeW = comp.strokeWidth;
        }
        if (comp.tgtiThickness !== null && comp.tgtiThickness > maxStrokeW) {
          maxStrokeW = comp.tgtiThickness;
        }
        if (comp.thicknessProfile) {
          for (const pt of comp.thicknessProfile.points) {
            if (pt.leftOffset + pt.rightOffset > maxStrokeW) {
              maxStrokeW = pt.leftOffset + pt.rightOffset;
            }
          }
        }
        if (comp.componentType === 4
          && comp.strokeWidth === null
          && comp.thicknessProfile === null
          && comp.tgtiThickness === null) {
          maxStrokeW = Math.max(maxStrokeW, fallbackWidth);
        }
        if (shouldRenderWidthlessBoundaryStroke(layer, shape, comp)) {
          maxStrokeW = Math.max(maxStrokeW, fallbackWidth);
        }
      }
    }
  }
  return maxStrokeW;
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
      return renderBitmapTVGToCanvas(drawing, width, height, viewport, options);
    }
    return null;
  }

  // Supersampling: render at SS× resolution then downsample for antialiasing.
  // Default 2× for quality unless explicitly set to 1 or skipClipping (fast mode).
  const defaultSS = options?.skipClipping ? 1 : 2;
  const SS = options?.supersample !== undefined ? (options.supersample > 1 ? options.supersample : 1) : defaultSS;
  const defaultStrokeWidth = 1.0;
  const ssWidth = width * SS;
  const ssHeight = height * SS;
  const layerTypes = getActiveArtLayerTypes(options);

  let defaultBoundaryFillColor: { r: number; g: number; b: number; a: number } | null = null;
  for (const entry of drawing.palette) {
    const nameLower = entry.name.toLowerCase();
    if (!UTILITY_NAMES.has(nameLower) && entry.a > 0 &&
        !(entry.r === 0 && entry.g === 0 && entry.b === 0)) {
      defaultBoundaryFillColor = { r: entry.r, g: entry.g, b: entry.b, a: entry.a };
      break;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = ssWidth;
  canvas.height = ssHeight;
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
    for (const point of collectRenderablePoints(drawing, layerTypes, defaultBoundaryFillColor, defaultStrokeWidth)) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
    // Expand bounds by max stroke width to prevent thick strokes from clipping
    const maxStrokeW = computeMaxStrokeWidth(drawing, defaultStrokeWidth);
    const halfStroke = maxStrokeW / 2;
    minX -= halfStroke;
    minY -= halfStroke;
    maxX += halfStroke;
    maxY += halfStroke;

    const contentExtent = Math.max(maxX - minX, maxY - minY);
    const centerOnOrigin = options?.centerOnOrigin ?? false;
    if (centerOnOrigin) {
      const originExtent = 2 * Math.max(Math.abs(minX), Math.abs(maxX), Math.abs(minY), Math.abs(maxY));
      viewportSize = Math.max(viewport, contentExtent + 227, originExtent + 100);
    } else {
      viewportSize = Math.max(viewport, contentExtent + 227);
    }

    // When centerOnOrigin is set (compositor mode), center on (0,0) so all elements
    // share the same coordinate space. Otherwise center on content centroid.
    const centerX = centerOnOrigin ? 0 : (minX + maxX) / 2;
    const centerY = centerOnOrigin ? 0 : (minY + maxY) / 2;

    scale = Math.min(ssWidth, ssHeight) / viewportSize;
    offsetX = ssWidth / 2 - centerX * scale;
    offsetY = ssHeight / 2 + centerY * scale;
    ctx.setTransform(scale, 0, 0, -scale, offsetX, offsetY);
  } else {
    // Auto-fit to path bounds
    const allPoints = collectRenderablePoints(drawing, layerTypes, defaultBoundaryFillColor, defaultStrokeWidth);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of allPoints) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const drawingWidth = maxX - minX;
    const drawingHeight = maxY - minY;
    if (drawingWidth < 0.01 && drawingHeight < 0.01) return null;
    if (drawingWidth < 0.01 || drawingHeight < 0.01) {
      const halfStroke = Math.max(computeMaxStrokeWidth(drawing, defaultStrokeWidth) / 2, 0.5);
      if (drawingWidth < 0.01) {
        minX -= halfStroke;
        maxX += halfStroke;
      }
      if (drawingHeight < 0.01) {
        minY -= halfStroke;
        maxY += halfStroke;
      }
    }
    const fittedWidth = maxX - minX;
    const fittedHeight = maxY - minY;
    viewportSize = Math.max(fittedWidth, fittedHeight);

    const padding = 4 * SS;
    const availW = ssWidth - padding * 2;
    const availH = ssHeight - padding * 2;
    scale = Math.min(availW / fittedWidth, availH / fittedHeight);
    offsetX = padding + (availW - fittedWidth * scale) / 2 - minX * scale;
    offsetY = padding + (availH - fittedHeight * scale) / 2 + maxY * scale;
    ctx.setTransform(scale, 0, 0, -scale, offsetX, offsetY);
  }

  // Art layer order. Research confirmed Toon Boom thumbnails render ALL layers
  // including underlay (which contains Mask-colored fills visible in thumbnails).
  // The includeUnderlay option defaults to true for thumbnail matching.
  // Set to false for compositor mode where underlay is used as CUTTER clip mask.
  const fillOrder = layerTypes;
  const strokeOrder = layerTypes;

  // Three-pass rendering with dilated flood-fill clipping:
  //   1. Render fills to offscreen canvas
  //   2. Build stroke mask → dilate 2px → flood-fill from edges → erase outside
  //   3. Composite clipped fills, then visible strokes on top

  const fillCanvas = document.createElement('canvas');
  fillCanvas.width = ssWidth;
  fillCanvas.height = ssHeight;
  const fillCtx = fillCanvas.getContext('2d')!;
  fillCtx.setTransform(ctx.getTransform());

  for (const layerType of fillOrder) {
    for (const layer of drawing.layers) {
      if (layer.type !== layerType) continue;
      renderLayerPass(fillCtx, layer, defaultStrokeWidth, 'fill', {
        defaultBoundaryFillColor,
        skipClipping: options?.skipClipping ?? false,
        diagnostics: drawing.diagnostics,
        allLayers: drawing.layers,
      });
    }
  }

  // Composite clipped fills onto main canvas
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(fillCanvas, 0, 0);
  ctx.restore();

  // Pass 3: Render visible strokes on top (covers boundary imprecision from dilation).
  // All layers render strokes in order (painter's algorithm).
  // Overlay strokes render on top — in Harmony thumbnails, all art layers are
  // rendered without inter-layer clipping.
  for (const layerType of strokeOrder) {
    for (const layer of drawing.layers) {
      if (layer.type !== layerType) continue;
      renderLayerPass(ctx, layer, defaultStrokeWidth, 'stroke');
    }
  }

  // Pre-composite against white background (skip for matte/compositor sources)
  if (!options?.skipBackgroundComposite) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, ssWidth, ssHeight);
    ctx.restore();
  }

  // Downsample from SS resolution to output resolution
  if (SS > 1) {
    const outCanvas = document.createElement('canvas');
    outCanvas.width = width;
    outCanvas.height = height;
    const outCtx = outCanvas.getContext('2d')!;
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = 'high';
    outCtx.drawImage(canvas, 0, 0, width, height);
    return outCanvas;
  }

  return canvas;
}

function computeBitmapBounds(tiles: TVGBitmapTile[]): TVGBitmapBounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const tile of tiles) {
    if (tile.clipW > 0 && tile.clipH > 0) {
      minX = Math.min(minX, tile.clipX);
      minY = Math.min(minY, tile.clipY);
      maxX = Math.max(maxX, tile.clipX + tile.clipW);
      maxY = Math.max(maxY, tile.clipY + tile.clipH);
    }
  }
  if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) {
    return null;
  }
  return { minX, minY, maxX, maxY };
}

function snapBitmapBoundsToTileGrid(bounds: TVGBitmapBounds, tileSize: number): TVGBitmapBounds {
  if (tileSize <= 0) return bounds;
  return {
    minX: Math.floor(bounds.minX / tileSize) * tileSize,
    minY: Math.floor(bounds.minY / tileSize) * tileSize,
    maxX: Math.ceil(bounds.maxX / tileSize) * tileSize,
    maxY: Math.ceil(bounds.maxY / tileSize) * tileSize,
  };
}

function drawImageWithProgressiveDownscale(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  let current = source;
  let currentW = source.width;
  let currentH = source.height;
  const targetW = Math.max(1, Math.round(dw));
  const targetH = Math.max(1, Math.round(dh));

  while (currentW > targetW * 2 || currentH > targetH * 2) {
    const nextW = Math.max(targetW, Math.ceil(currentW / 2));
    const nextH = Math.max(targetH, Math.ceil(currentH / 2));
    const next = document.createElement('canvas');
    next.width = nextW;
    next.height = nextH;
    const nextCtx = next.getContext('2d')!;
    nextCtx.imageSmoothingEnabled = true;
    nextCtx.imageSmoothingQuality = 'high';
    nextCtx.clearRect(0, 0, nextW, nextH);
    nextCtx.drawImage(current, 0, 0, currentW, currentH, 0, 0, nextW, nextH);
    current = next;
    currentW = nextW;
    currentH = nextH;
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(current, 0, 0, currentW, currentH, dx, dy, dw, dh);
}

function renderBitmapTVGToCanvas(
  drawing: TVGDrawing,
  width: number,
  height: number,
  viewport?: number,
  options?: TVGRenderOptions,
): HTMLCanvasElement | null {
  const tiles = drawing.bitmapTiles;
  if (tiles.length === 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const bounds = computeBitmapBounds(tiles) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  // Return canvas — actual bitmap rendering happens asynchronously
  // Mark the canvas with bitmap data for async loading
  (canvas as any).__bitmapTiles = tiles;
  (canvas as any).__bitmapState = {
    bounds,
    viewport,
    centerOnOrigin: options?.centerOnOrigin ?? false,
    diagnostics: drawing.diagnostics,
  } as TVGBitmapRenderState;
  return canvas;
}

/** Load bitmap tiles asynchronously onto a canvas */
export async function loadBitmapTiles(canvas: HTMLCanvasElement, diagnostics?: TVGDiagnostics): Promise<boolean> {
  const tiles = (canvas as any).__bitmapTiles as TVGBitmapTile[] | undefined;
  if (!tiles || tiles.length === 0) return false;
  const state = (canvas as any).__bitmapState as TVGBitmapRenderState | undefined;
  const bounds = state?.bounds ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const renderDiagnostics = diagnostics ?? state?.diagnostics;
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

  const remapBitmapTile = (img: HTMLImageElement): HTMLCanvasElement => {
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = img.width;
    sourceCanvas.height = img.height;
    const sourceCtx = sourceCanvas.getContext('2d')!;
    sourceCtx.drawImage(img, 0, 0);
    const src = sourceCtx.getImageData(0, 0, img.width, img.height);

    const coverageStats = (data: Uint8ClampedArray) => {
      let opaquePixels = 0;
      let alphaSum = 0;
      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3];
        alphaSum += alpha;
        if (alpha >= 24) opaquePixels++;
      }
      const pixelCount = Math.max(1, data.length / 4);
      return {
        opaquePixels,
        meanAlpha: alphaSum / pixelCount,
      };
    };

    const tileCanvas = document.createElement('canvas');
    tileCanvas.width = img.width;
    tileCanvas.height = img.height;
    const tileCtx = tileCanvas.getContext('2d')!;
    const dst = tileCtx.createImageData(img.width, img.height);
    for (let i = 0; i < src.data.length; i += 4) {
      const r = src.data[i + 0];
      const g = src.data[i + 1];
      const b = src.data[i + 2];
      const a = src.data[i + 3];
      dst.data[i + 0] = g;
      dst.data[i + 1] = r;
      dst.data[i + 2] = a;
      dst.data[i + 3] = b;
    }
    const sourceStats = coverageStats(src.data);
    const remappedStats = coverageStats(dst.data);
    const remapCollapsesAlpha = remappedStats.opaquePixels < sourceStats.opaquePixels * 0.75
      || remappedStats.meanAlpha < sourceStats.meanAlpha * 0.75;
    if (remapCollapsesAlpha) {
      return sourceCanvas;
    }
    tileCtx.putImageData(dst, 0, 0);
    return tileCanvas;
  };

  const images = await Promise.all(tiles.map(async (tile) => {
    try {
      const img = await loadImage(tile.pngData);
      return { tile, img: remapBitmapTile(img) };
    } catch {
      if (renderDiagnostics) {
        addDiagnostic(renderDiagnostics, {
          severity: 'warn',
          code: 'BITMAP_TILE_DECODE_FAILED',
          offset: 0,
          context: 'bitmap',
        });
      }
      return null;
    }
  }));

  const loaded = images.filter((x): x is { tile: TVGBitmapTile; img: HTMLCanvasElement } => x !== null);
  if (loaded.length === 0) return false;

  const hasClipRects = isFinite(bounds.minX) && isFinite(bounds.minY) && (bounds.maxX - bounds.minX) > 0 && (bounds.maxY - bounds.minY) > 0;
  const largest = loaded.reduce((a, b) => a.img.width * a.img.height > b.img.width * b.img.height ? a : b);
  const nativeBounds = hasClipRects
    ? bounds
    : { minX: 0, minY: 0, maxX: largest.img.width, maxY: largest.img.height };
  const fallbackScanUsed = (renderDiagnostics?.counts?.BITMAP_FALLBACK_SCAN_USED ?? 0) > 0;
  const shouldSnapFallbackAtlasBounds = fallbackScanUsed && hasClipRects && loaded.length >= 32;
  const fittedBounds = shouldSnapFallbackAtlasBounds
    ? snapBitmapBoundsToTileGrid(nativeBounds, 256)
    : nativeBounds;

  if (!hasClipRects && renderDiagnostics) {
    addDiagnostic(renderDiagnostics, {
      severity: 'warn',
      code: 'BITMAP_NO_CLIP_RECTS',
      offset: 0,
      context: 'bitmap',
    });
  }

  const nativeW = Math.max(1, Math.round(fittedBounds.maxX - fittedBounds.minX));
  const nativeH = Math.max(1, Math.round(fittedBounds.maxY - fittedBounds.minY));
  const nativeCanvas = document.createElement('canvas');
  nativeCanvas.width = nativeW;
  nativeCanvas.height = nativeH;
  const nativeCtx = nativeCanvas.getContext('2d')!;

  if (hasClipRects) {
    for (const { tile, img } of loaded) {
      nativeCtx.drawImage(
        img,
        Math.round(tile.clipX - fittedBounds.minX),
        Math.round(tile.clipY - fittedBounds.minY),
        Math.round(tile.clipW),
        Math.round(tile.clipH),
      );
    }
  } else {
    nativeCtx.drawImage(largest.img, 0, 0);
  }

  const contentExtent = Math.max(fittedBounds.maxX - fittedBounds.minX, fittedBounds.maxY - fittedBounds.minY);
  const centerOnOrigin = state?.centerOnOrigin ?? false;
  const originExtent = 2 * Math.max(
    Math.abs(fittedBounds.minX),
    Math.abs(fittedBounds.maxX),
    Math.abs(fittedBounds.minY),
    Math.abs(fittedBounds.maxY),
  );
  let scale: number;
  let dx: number;
  let dy: number;
  const viewportValue = state?.viewport ?? 0;
  const shouldUseViewportFit = viewportValue > 0 && centerOnOrigin;
  if (shouldUseViewportFit) {
    const viewportSize = centerOnOrigin
      ? Math.max(viewportValue, contentExtent, originExtent)
      : Math.max(viewportValue, contentExtent);
    const centerX = centerOnOrigin ? 0 : (fittedBounds.minX + fittedBounds.maxX) / 2;
    const centerY = centerOnOrigin ? 0 : (fittedBounds.minY + fittedBounds.maxY) / 2;
    scale = Math.min(width, height) / Math.max(viewportSize, 1);
    dx = width / 2 - (centerX - fittedBounds.minX) * scale;
    dy = height / 2 - (fittedBounds.maxY - centerY) * scale;
  } else {
    const aspectRatio = nativeW / Math.max(nativeH, 1);
    const padding = fallbackScanUsed && loaded.length >= 100 && aspectRatio <= 1.2
      ? 6
      : fallbackScanUsed && loaded.length < 10
        ? 7
        : 4;
    const availW = width - padding * 2;
    const availH = height - padding * 2;
    scale = Math.min(availW / nativeW, availH / nativeH);
    dx = padding + (availW - nativeW * scale) / 2;
    dy = padding + (availH - nativeH * scale) / 2;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  drawImageWithProgressiveDownscale(ctx, nativeCanvas, dx, dy, nativeW * scale, nativeH * scale);

  // Clean up
  delete (canvas as any).__bitmapTiles;
  delete (canvas as any).__bitmapState;
  return true;
}

type FillStyleKey = string;
type ContourSource = 'explicit-fill' | 'boundary-stroke' | 'thin-pencil';

interface TVGContourFragment {
  source: ContourSource;
  layerType: TVGArtLayer['type'];
  shapeIndex: number;
  componentIndex: number;
  styleKey: FillStyleKey | null;
  style: TVGComponent | null;
  segments: TVGSegment[];
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  reversible: true;
  supportOnly: boolean;
}

interface TVGResolvedContour {
  source: ContourSource;
  layerType: TVGArtLayer['type'];
  shapeIndex: number;
  styleKey: FillStyleKey;
  style: TVGComponent | null;
  fragments: Array<{ fragmentIndex: number; reversed: boolean }>;
  fragmentCount: number;
  styledFragmentCount: number;
  supportFragmentCount: number;
  path: Path2D;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  samplePoint: { x: number; y: number } | null;
  sourceOrder: number;
  synthesized: boolean;
  flattened: { x: number; y: number }[];
}

interface TVGContourNode {
  contourIndex: number;
  parent: number | null;
  children: number[];
  depth: number;
}

interface TVGFillBuildResult {
  contours: TVGResolvedContour[];
  unresolvedChains: TVGResolvedContour[];
}

interface TVGFillRenderOptions {
  defaultBoundaryFillColor: { r: number; g: number; b: number; a: number } | null;
  skipClipping: boolean;
  diagnostics?: TVGDiagnostics;
  allLayers?: TVGArtLayer[];
}

interface LocalFillPaintSource {
  kind: 'path' | 'bbox';
  path?: Path2D;
  paint: TVGPaint;
  fillRule?: CanvasFillRule;
}

const UTILITY_NAMES = new Set([
  'line', 'mask', 'invis', 'handles', 'invisible', 'shadow',
  'controller', 'eye_lid_ctrl', 'null', 'transparent',
]);
const CHAIN_TOL = 2.0;
const AUTO_CLOSE_TOL = 2.0;

function serializeTransform(transform: TVGTransform | null | undefined): string {
  if (!transform) return 'none';
  return [
    transform.a,
    transform.b,
    transform.c,
    transform.d,
    transform.tx,
    transform.ty,
  ].map(x => x.toFixed(6)).join(',');
}

function paintKeyForComponent(comp: TVGComponent): FillStyleKey | null {
  if (!comp.outerPaint) return null;
  if (comp.outerPaint.kind === 'solid') {
    const { r, g, b, a } = comp.outerPaint.rgba;
    return `solid:${r},${g},${b},${a}`;
  }
  return `gradient:${comp.outerPaint.gradientType}:${serializeTransform(comp.outerPaint.transform)}:${JSON.stringify(comp.outerPaint.stops)}`;
}

function cloneSolidPaint(color: { r: number; g: number; b: number; a: number }): TVGPaint {
  return { kind: 'solid', rgba: { ...color } };
}

function isNearlyBlackSolidPaint(paint: TVGPaint | null, threshold = 12): boolean {
  return !!paint
    && paint.kind === 'solid'
    && paint.rgba.a > 0
    && paint.rgba.r <= threshold
    && paint.rgba.g <= threshold
    && paint.rgba.b <= threshold;
}

function createSyntheticStyleComponent(paint: TVGPaint): TVGComponent {
  const color = paint.kind === 'solid' ? paint.rgba : paint.fallback;
  return {
    componentType: 0,
    colorId: null,
    insideColorId: null,
    paletteIndex: null,
    color: { ...color },
    fillPaintSource: 'synthetic',
    insideColor: null,
    transform: paint.kind === 'gradient' ? paint.transform : null,
    path: null,
    strokeWidth: null,
    thicknessProfile: null,
    joinType: 'round',
    fromTipType: 'round',
    toTipType: 'round',
    gradientType: paint.kind === 'gradient' ? paint.gradientType : undefined,
    gradientStops: paint.kind === 'gradient' ? paint.stops : undefined,
    tgtiThickness: null,
    tgtiTextureScaleX: null,
    tgtiTextureScaleY: null,
    tgtiTextureOffset: null,
    tgtiOpacityThickness: null,
    tgtiOpacityScaleX: null,
    tgtiOpacityScaleY: null,
    tgtiOpacityOffset: null,
    tgtiHasTextureFlags: null,
    pathRefHint: null,
    outerPaint: paint,
    innerPaint: null,
  };
}

function splitPathIntoSubpaths(path: TVGPath): TVGSegment[][] {
  const subpaths: TVGSegment[][] = [];
  let current: TVGSegment[] = [];
  for (const seg of path.segments) {
    if (seg.type === 'M' && current.length > 0) {
      subpaths.push(current);
      current = [seg];
    } else {
      current.push(seg);
    }
  }
  if (current.length > 0) subpaths.push(current);
  return subpaths;
}

function segmentBounds(segments: TVGSegment[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const seg of segments) {
    minX = Math.min(minX, seg.x);
    minY = Math.min(minY, seg.y);
    maxX = Math.max(maxX, seg.x);
    maxY = Math.max(maxY, seg.y);
    if (seg.type === 'Q') {
      minX = Math.min(minX, seg.cx);
      minY = Math.min(minY, seg.cy);
      maxX = Math.max(maxX, seg.cx);
      maxY = Math.max(maxY, seg.cy);
    } else if (seg.type === 'C') {
      minX = Math.min(minX, seg.c1x, seg.c2x);
      minY = Math.min(minY, seg.c1y, seg.c2y);
      maxX = Math.max(maxX, seg.c1x, seg.c2x);
      maxY = Math.max(maxY, seg.c1y, seg.c2y);
    }
  }
  return { minX, minY, maxX, maxY };
}

function computeShapeBounds(shape: TVGShape): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const comp of shape.components) {
    if (!comp.path) continue;
    for (const seg of comp.path.segments) {
      minX = Math.min(minX, seg.x);
      minY = Math.min(minY, seg.y);
      maxX = Math.max(maxX, seg.x);
      maxY = Math.max(maxY, seg.y);
      if (seg.type === 'Q') {
        minX = Math.min(minX, seg.cx);
        minY = Math.min(minY, seg.cy);
        maxX = Math.max(maxX, seg.cx);
        maxY = Math.max(maxY, seg.cy);
      } else if (seg.type === 'C') {
        minX = Math.min(minX, seg.c1x, seg.c2x);
        minY = Math.min(minY, seg.c1y, seg.c2y);
        maxX = Math.max(maxX, seg.c1x, seg.c2x);
        maxY = Math.max(maxY, seg.c1y, seg.c2y);
      }
    }
  }
  return isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

function segmentCoordinateEqual(a: number, b: number, epsilon = 0.01): boolean {
  return Math.abs(a - b) <= epsilon;
}

function segmentsGeometricallyEqual(a: TVGSegment, b: TVGSegment, epsilon = 0.01): boolean {
  if (a.type !== b.type) return false;
  if (!segmentCoordinateEqual(a.x, b.x, epsilon) || !segmentCoordinateEqual(a.y, b.y, epsilon)) return false;
  if (a.type === 'Q' && b.type === 'Q') {
    return segmentCoordinateEqual(a.cx, b.cx, epsilon)
      && segmentCoordinateEqual(a.cy, b.cy, epsilon);
  }
  if (a.type === 'C' && b.type === 'C') {
    return segmentCoordinateEqual(a.c1x, b.c1x, epsilon)
      && segmentCoordinateEqual(a.c1y, b.c1y, epsilon)
      && segmentCoordinateEqual(a.c2x, b.c2x, epsilon)
      && segmentCoordinateEqual(a.c2y, b.c2y, epsilon);
  }
  return true;
}

function pathsGeometricallyEqual(a: TVGPath | null, b: TVGPath | null, epsilon = 0.01): boolean {
  if (!a || !b) return false;
  if (a.closed !== b.closed) return false;
  if (a.segments.length !== b.segments.length) return false;
  for (let i = 0; i < a.segments.length; i++) {
    if (!segmentsGeometricallyEqual(a.segments[i], b.segments[i], epsilon)) return false;
  }
  return true;
}

function boundaryShapeSignature(shape: TVGShape): string {
  return shape.components.map((comp) => {
    if (!comp.path) return 'nop';
    return comp.path.segments.map((seg) => {
      if (seg.type === 'Q') {
        return `${seg.type}:${seg.x.toFixed(3)},${seg.y.toFixed(3)},${seg.cx.toFixed(3)},${seg.cy.toFixed(3)}`;
      }
      if (seg.type === 'C') {
        return `${seg.type}:${seg.x.toFixed(3)},${seg.y.toFixed(3)},${seg.c1x.toFixed(3)},${seg.c1y.toFixed(3)},${seg.c2x.toFixed(3)},${seg.c2y.toFixed(3)}`;
      }
      return `${seg.type}:${seg.x.toFixed(3)},${seg.y.toFixed(3)}`;
    }).join('|');
  }).join('||');
}

function fillCarrierEntries(shape: TVGShape): Array<{ index: number; comp: TVGComponent }> {
  return shape.components
    .map((comp, index) => ({ index, comp }))
    .filter(({ comp }) => (comp.componentType === 0 || comp.componentType === 1) && !!comp.path);
}

function findMatchingUnderlayShape(
  layers: TVGArtLayer[],
  currentLayerIndex: number,
  currentShape: TVGShape,
  currentShapeIndex: number,
): TVGShape | null {
  const currentFillEntries = fillCarrierEntries(currentShape);
  if (currentFillEntries.length === 0) return null;
  for (let layerIndex = currentLayerIndex - 1; layerIndex >= 0; layerIndex--) {
    const layer = layers[layerIndex];
    if (layer.type !== 'underlay') continue;
    const candidate = layer.shapes[currentShapeIndex];
    if (!candidate) continue;
    const candidateFillEntries = fillCarrierEntries(candidate);
    if (candidateFillEntries.length !== currentFillEntries.length) continue;
    let matches = true;
    for (let i = 0; i < currentFillEntries.length; i++) {
      if (!pathsGeometricallyEqual(currentFillEntries[i].comp.path, candidateFillEntries[i].comp.path)) {
        matches = false;
        break;
      }
    }
    if (matches) return candidate;
  }
  return null;
}

function suppressUnderlayFollowerFillColors(
  layers: TVGArtLayer[],
  currentLayerIndex: number,
  currentLayer: TVGArtLayer,
  currentShape: TVGShape,
  currentShapeIndex: number,
): void {
  if (currentLayer.type !== 'color') return;
  const currentFillEntries = fillCarrierEntries(currentShape);
  if (currentFillEntries.length < 2) return;
  const underlayShape = findMatchingUnderlayShape(layers, currentLayerIndex, currentShape, currentShapeIndex);
  if (!underlayShape) return;
  const underlayFillEntries = fillCarrierEntries(underlayShape);
  const changedIndexes: number[] = [];
  const suppressedIndexes: number[] = [];
  for (let i = 0; i < currentFillEntries.length; i++) {
    const currentKey = paintKeyForComponent(currentFillEntries[i].comp);
    const underlayKey = paintKeyForComponent(underlayFillEntries[i].comp);
    if (!underlayKey) return;
    if (currentKey === null || currentKey === underlayKey) {
      suppressedIndexes.push(i);
    } else {
      changedIndexes.push(i);
    }
  }
  if (changedIndexes.length !== 1 || changedIndexes[0] !== 0 || suppressedIndexes.length === 0) return;
  for (const entryIndex of suppressedIndexes) {
    const { comp } = currentFillEntries[entryIndex];
    comp.color = null;
    comp.colorId = null;
    comp.gradientType = undefined;
    comp.gradientStops = undefined;
    comp.fillPaintSource = null;
    updateComponentPaints(comp);
  }
}

function boundsIntersect(
  a: { minX: number; minY: number; maxX: number; maxY: number } | null,
  b: { minX: number; minY: number; maxX: number; maxY: number } | null,
  padding = 0,
): boolean {
  if (!a || !b) return false;
  return !(a.maxX < b.minX - padding
    || a.minX > b.maxX + padding
    || a.maxY < b.minY - padding
    || a.minY > b.maxY + padding);
}

function isBoundaryOnlyShape(shape: TVGShape): boolean {
  return shape.components.length > 0 && shape.components.every(comp =>
    comp.componentType === 2
    && comp.strokeWidth === null
    && !comp.thicknessProfile
    && comp.tgtiThickness === null
    && !!comp.path
    && comp.path.segments.length > 1,
  );
}

function isWidthlessBoundaryStroke(comp: TVGComponent): boolean {
  return comp.componentType === 2
    && comp.strokeWidth === null
    && !comp.thicknessProfile
    && comp.tgtiThickness === null
    && !!comp.path
    && comp.path.segments.length > 0;
}

function paintHasVisibleAlpha(paint: TVGPaint | null): boolean {
  if (!paint) return false;
  if (paint.kind === 'solid') return paint.rgba.a > 0;
  return paint.fallback.a > 0;
}

function isLowAlphaSolidFillComponent(comp: TVGComponent, maxAlpha = 80): boolean {
  return (comp.componentType === 0 || comp.componentType === 1)
    && comp.strokeWidth === null
    && comp.outerPaint?.kind === 'solid'
    && comp.outerPaint.rgba.a > 0
    && comp.outerPaint.rgba.a <= maxAlpha;
}

function shouldAttenuateLowAlphaGuideFills(layer: TVGArtLayer): boolean {
  if (layer.type !== 'color' || layer.shapes.length < 20) return false;
  if (!layer.shapes.every(shape => shape.components.length === 1)) return false;
  let lowAlphaFillCount = 0;
  let pencilCount = 0;
  for (const shape of layer.shapes) {
    const comp = shape.components[0];
    if (isLowAlphaSolidFillComponent(comp)) {
      lowAlphaFillCount++;
      continue;
    }
    if (comp.componentType === 4
      && comp.outerPaint?.kind === 'solid'
      && comp.outerPaint.rgba.a === 255
      && comp.path
      && comp.path.segments.length > 0) {
      pencilCount++;
    }
  }
  return lowAlphaFillCount >= 3 && pencilCount >= 20;
}

function scalePaintAlpha(paint: TVGPaint, factor: number): TVGPaint {
  if (factor >= 0.999) return paint;
  if (paint.kind === 'solid') {
    return {
      kind: 'solid',
      rgba: {
        ...paint.rgba,
        a: Math.max(0, Math.min(255, Math.round(paint.rgba.a * factor))),
      },
    };
  }
  return {
    ...paint,
    fallback: {
      ...paint.fallback,
      a: Math.max(0, Math.min(255, Math.round(paint.fallback.a * factor))),
    },
    stops: paint.stops.map(stop => ({
      ...stop,
      a: Math.max(0, Math.min(255, Math.round(stop.a * factor))),
    })),
  };
}

function shouldRenderWidthlessBoundaryStroke(
  layer: TVGArtLayer,
  shape: TVGShape,
  comp: TVGComponent,
): boolean {
  if (!isWidthlessBoundaryStroke(comp)) return false;
  if (layer.type !== 'line') return false;
  if (!paintHasVisibleAlpha(comp.outerPaint)) return false;
  if (shape.shapeType === 7 && shape.components.length > 0 && shape.components.every(other => isWidthlessBoundaryStroke(other))) {
    const boundaryOnlyComps = shape.components.filter(other => isWidthlessBoundaryStroke(other));
    const isSingleOpenSegment = boundaryOnlyComps.length === 1
      && boundaryOnlyComps[0].path !== null
      && boundaryOnlyComps[0].path.segments.filter(seg => seg.type !== 'M').length <= 1
      && !boundaryOnlyComps[0].path.closed;
    if (isSingleOpenSegment) return false;
    return true;
  }
  return shape.components.some(other =>
    other !== comp
    && !!other.path
    && other.path.segments.length > 0
    && (other.componentType === 4
      || other.strokeWidth !== null
      || other.thicknessProfile !== null
      || other.tgtiThickness !== null)
    && paintsEqual(other.outerPaint, comp.outerPaint),
  );
}

function collectSiblingBoundaryMaskShapes(
  allLayers: TVGArtLayer[] | undefined,
  currentLayer: TVGArtLayer,
  currentShape: TVGShape,
): TVGShape[] {
  if (!allLayers || allLayers.length === 0) return [];
  const currentBounds = computeShapeBounds(currentShape);
  if (!currentBounds) return [];
  const matches: TVGShape[] = [];
  const seen = new Set<string>();
  for (const layer of allLayers) {
    if (layer === currentLayer) continue;
    for (const shape of layer.shapes) {
      if (!isBoundaryOnlyShape(shape)) continue;
      if (boundsIntersect(currentBounds, computeShapeBounds(shape), 0.5)) {
        const signature = boundaryShapeSignature(shape);
        if (seen.has(signature)) continue;
        seen.add(signature);
        matches.push(shape);
      }
    }
  }
  return matches;
}

function shapeHasRenderableFill(shape: TVGShape): boolean {
  return shape.components.some(comp =>
    (comp.componentType === 0 || comp.componentType === 1)
    && comp.path
    && !isDegenerate(comp.path)
    && comp.outerPaint !== null
    && (!comp.color || comp.color.a > 0),
  );
}

function shapeHasNonBlackRenderableFill(shape: TVGShape): boolean {
  return shape.components.some(comp =>
    (comp.componentType === 0 || comp.componentType === 1)
    && comp.path
    && !isDegenerate(comp.path)
    && comp.outerPaint !== null
    && (!comp.color || comp.color.a > 0)
    && !isNearlyBlackSolidPaint(comp.outerPaint),
  );
}

function shapeHasOnlyNearBlackRenderableFills(shape: TVGShape): boolean {
  let hasRenderableFill = false;
  for (const comp of shape.components) {
    if ((comp.componentType !== 0 && comp.componentType !== 1)
      || !comp.path
      || isDegenerate(comp.path)
      || comp.outerPaint === null
      || (comp.color && comp.color.a <= 0)) {
      continue;
    }
    hasRenderableFill = true;
    if (!isNearlyBlackSolidPaint(comp.outerPaint)) {
      return false;
    }
  }
  return hasRenderableFill;
}

function shouldSuppressLargeNearBlackLineFillShape(
  layer: TVGArtLayer,
  shape: TVGShape,
  strokeComps: TVGComponent[],
  resolvedContourCount = 0,
): boolean {
  if (layer.type !== 'line' || strokeComps.length > 0) return false;
  if (!shapeHasOnlyNearBlackRenderableFills(shape)) return false;
  if (resolvedContourCount > 0) return false;
  const currentBounds = computeShapeBounds(shape);
  if (!currentBounds) return false;
  const currentArea = (currentBounds.maxX - currentBounds.minX) * (currentBounds.maxY - currentBounds.minY);
  if (currentArea < 50000) return false;
  for (const sibling of layer.shapes) {
    if (sibling === shape) continue;
    if (!shapeHasNonBlackRenderableFill(sibling)) continue;
    if (boundsIntersect(currentBounds, computeShapeBounds(sibling), 0.5)) {
      return true;
    }
  }
  return false;
}

function hasSiblingRenderableFillShape(
  allLayers: TVGArtLayer[] | undefined,
  currentLayer: TVGArtLayer,
  currentShape: TVGShape,
): boolean {
  if (!allLayers || allLayers.length === 0) return false;
  const currentBounds = computeShapeBounds(currentShape);
  if (!currentBounds) return false;
  for (const layer of allLayers) {
    if (layer === currentLayer) continue;
    for (const shape of layer.shapes) {
      if (!shapeHasRenderableFill(shape)) continue;
      if (boundsIntersect(currentBounds, computeShapeBounds(shape), 0.5)) {
        return true;
      }
    }
  }
  return false;
}

function collectPreviousNearBlackRenderableFillShapes(
  layer: TVGArtLayer,
  shapeIndex: number,
  currentShape: TVGShape,
): TVGShape[] {
  if (shapeIndex <= 0) return [];
  const currentBounds = computeShapeBounds(currentShape);
  if (!currentBounds) return [];
  const blockers: TVGShape[] = [];
  for (let i = 0; i < shapeIndex; i++) {
    const sibling = layer.shapes[i];
    if (!shapeHasOnlyNearBlackRenderableFills(sibling)) continue;
    if (!boundsIntersect(currentBounds, computeShapeBounds(sibling), 0.5)) continue;
    blockers.push(sibling);
  }
  return blockers;
}

function renderableFillComponents(shape: TVGShape): TVGComponent[] {
  return shape.components.filter(comp =>
    (comp.componentType === 0 || comp.componentType === 1)
    && comp.path
    && !isDegenerate(comp.path)
    && comp.outerPaint !== null
    && (!comp.color || comp.color.a > 0),
  );
}

function renderableFillPaintKeys(shape: TVGShape): Set<FillStyleKey> {
  return new Set(
    renderableFillComponents(shape)
      .map(comp => paintKeyForComponent(comp))
      .filter((key): key is FillStyleKey => key !== null),
  );
}

function dominantRenderableFillPaintKey(shape: TVGShape): FillStyleKey | null {
  const counts = new Map<FillStyleKey, number>();
  for (const comp of renderableFillComponents(shape)) {
    const key = paintKeyForComponent(comp);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function shouldSuppressSeedCarrierFillShape(
  layer: TVGArtLayer,
  currentShape: TVGShape,
): boolean {
  if (layer.type !== 'line') return false;
  if (currentShape.components.some(comp =>
    (comp.componentType === 2 || comp.componentType === 4)
    && comp.path
    && comp.path.segments.length > 0,
  )) return false;
  const fillComps = renderableFillComponents(currentShape);
  if (fillComps.length < 4 || fillComps.length > 6) return false;
  if (renderableFillPaintKeys(currentShape).size !== 1) return false;
  const explicitCount = fillComps.filter(comp => hasExplicitFillStyle(comp)).length;
  const inheritedCount = fillComps.filter(comp => comp.fillPaintSource === 'inherited').length;
  if (explicitCount !== 1 || inheritedCount < fillComps.length - 1) return false;
  const currentKey = dominantRenderableFillPaintKey(currentShape);
  const currentBounds = computeShapeBounds(currentShape);
  if (!currentKey || !currentBounds) return false;
  return layer.shapes.some(shape => {
    if (shape === currentShape) return false;
    const siblingFillComps = renderableFillComponents(shape);
    if (siblingFillComps.length < fillComps.length * 6) return false;
    const siblingPaintKeys = renderableFillPaintKeys(shape);
    if (siblingPaintKeys.size < 2 || !siblingPaintKeys.has(currentKey)) return false;
    return boundsIntersect(currentBounds, computeShapeBounds(shape), 0.5);
  });
}

function flattenSegments(
  segments: TVGSegment[],
  closePath = false,
  quadSteps = 16,
  cubicSteps = 24,
): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.type === 'M') {
      points.push({ x: seg.x, y: seg.y });
      continue;
    }
    const prev = segments[i - 1];
    if (!prev) continue;
    if (seg.type === 'L') {
      points.push({ x: seg.x, y: seg.y });
    } else if (seg.type === 'Q') {
      for (let step = 1; step <= quadSteps; step++) {
        const t = step / quadSteps;
        const mt = 1 - t;
        points.push({
          x: mt * mt * prev.x + 2 * mt * t * seg.cx + t * t * seg.x,
          y: mt * mt * prev.y + 2 * mt * t * seg.cy + t * t * seg.y,
        });
      }
    } else if (seg.type === 'C') {
      for (let step = 1; step <= cubicSteps; step++) {
        const t = step / cubicSteps;
        points.push({
          x: cubicBezier(t, prev.x, seg.c1x, seg.c2x, seg.x),
          y: cubicBezier(t, prev.y, seg.c1y, seg.c2y, seg.y),
        });
      }
    }
  }
  if (closePath && points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (Math.abs(first.x - last.x) > 0.001 || Math.abs(first.y - last.y) > 0.001) {
      points.push({ ...first });
    }
  }
  return points;
}

function isPathEffectivelyClosed(path: TVGPath): boolean {
  if (path.closed || path.segments.length < 3) return path.closed;
  const first = path.segments[0];
  const last = path.segments[path.segments.length - 1];
  return Math.abs(first.x - last.x) < 0.001 && Math.abs(first.y - last.y) < 0.001;
}

function pointInPolygon(points: { x: number; y: number }[], point: { x: number; y: number }): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x;
    const yi = points[i].y;
    const xj = points[j].x;
    const yj = points[j].y;
    const intersect = ((yi > point.y) !== (yj > point.y))
      && (point.x < ((xj - xi) * (point.y - yi)) / ((yj - yi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function averagePoint(points: { x: number; y: number }[]): { x: number; y: number } {
  let sx = 0;
  let sy = 0;
  for (const point of points) {
    sx += point.x;
    sy += point.y;
  }
  return { x: sx / Math.max(points.length, 1), y: sy / Math.max(points.length, 1) };
}

function polygonArea(points: { x: number; y: number }[]): number {
  if (points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

function chooseSamplePoint(
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  flattened: { x: number; y: number }[],
): { x: number; y: number } | null {
  const candidates = [
    { x: (bbox.minX + bbox.maxX) / 2, y: (bbox.minY + bbox.maxY) / 2 },
    averagePoint(flattened),
    averagePoint(flattened.slice(0, Math.max(1, flattened.length - 1))),
  ];
  for (const candidate of candidates) {
    if (pointInPolygon(flattened, candidate)) return candidate;
  }
  return null;
}

function reversedSegments(segments: TVGSegment[]): TVGSegment[] {
  if (segments.length === 0) return [];
  const reversed: TVGSegment[] = [{ type: 'M', x: segments[segments.length - 1].x, y: segments[segments.length - 1].y }];
  for (let i = segments.length - 1; i >= 1; i--) {
    const seg = segments[i];
    const dest = segments[i - 1];
    if (seg.type === 'C') {
      reversed.push({ type: 'C', c1x: seg.c2x, c1y: seg.c2y, c2x: seg.c1x, c2y: seg.c1y, x: dest.x, y: dest.y });
    } else if (seg.type === 'Q') {
      reversed.push({ type: 'Q', cx: seg.cx, cy: seg.cy, x: dest.x, y: dest.y });
    } else {
      reversed.push({ type: 'L', x: dest.x, y: dest.y });
    }
  }
  return reversed;
}

function appendSegmentsToPath(path: Path2D, segments: TVGSegment[], reversed: boolean, isFirst: boolean): boolean {
  const source = reversed ? reversedSegments(segments) : segments;
  for (let i = 0; i < source.length; i++) {
    const seg = source[i];
    if (i === 0) {
      if (isFirst) path.moveTo(seg.x, seg.y);
      else path.lineTo(seg.x, seg.y);
      continue;
    }
    if (seg.type === 'C') path.bezierCurveTo(seg.c1x, seg.c1y, seg.c2x, seg.c2y, seg.x, seg.y);
    else if (seg.type === 'Q') path.quadraticCurveTo(seg.cx, seg.cy, seg.x, seg.y);
    else path.lineTo(seg.x, seg.y);
  }
  return false;
}

function buildResolvedContour(
  fragments: TVGContourFragment[],
  refs: Array<{ fragmentIndex: number; reversed: boolean }>,
  styleKey: FillStyleKey,
  style: TVGComponent | null,
  synthesized: boolean,
): TVGResolvedContour | null {
  const bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const path = new Path2D();
  let first = true;
  let flattened: { x: number; y: number }[] = [];
  let styledFragmentCount = 0;
  let supportFragmentCount = 0;
  for (const ref of refs) {
    const fragment = fragments[ref.fragmentIndex];
    if (fragment.supportOnly) supportFragmentCount++;
    else styledFragmentCount++;
    appendSegmentsToPath(path, fragment.segments, ref.reversed, first);
    first = false;
    const fragBounds = fragment.bbox;
    bbox.minX = Math.min(bbox.minX, fragBounds.minX);
    bbox.minY = Math.min(bbox.minY, fragBounds.minY);
    bbox.maxX = Math.max(bbox.maxX, fragBounds.maxX);
    bbox.maxY = Math.max(bbox.maxY, fragBounds.maxY);
    const fragPoints = flattenSegments(ref.reversed ? reversedSegments(fragment.segments) : fragment.segments);
    if (flattened.length > 0 && fragPoints.length > 0) fragPoints.shift();
    flattened = flattened.concat(fragPoints);
  }
  const head = refs[0];
  const tail = refs[refs.length - 1];
  const start = fragments[head.fragmentIndex];
  const end = fragments[tail.fragmentIndex];
  const startPoint = head.reversed ? { x: start.endX, y: start.endY } : { x: start.startX, y: start.startY };
  const endPoint = tail.reversed ? { x: end.startX, y: end.startY } : { x: end.endX, y: end.endY };
  const closeDistance = Math.hypot(startPoint.x - endPoint.x, startPoint.y - endPoint.y);
  if (closeDistance > AUTO_CLOSE_TOL) return null;
  path.closePath();
  flattened = flattenSegments([
    { type: 'M', x: flattened[0]?.x ?? startPoint.x, y: flattened[0]?.y ?? startPoint.y },
    ...flattened.slice(1).map((p): TVGSegment => ({ type: 'L', x: p.x, y: p.y })),
  ], true);
  const bboxArea = (bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY);
  const polyArea = polygonArea(flattened);
  if (!synthesized
    && styledFragmentCount === 1
    && supportFragmentCount >= 4
    && (supportFragmentCount / refs.length) >= 0.75
    && bboxArea > 0
    && (polyArea / bboxArea) > 0.8) {
    return null;
  }
  const samplePoint = chooseSamplePoint(bbox, flattened);
  return {
    source: fragments[refs[0].fragmentIndex].source,
    layerType: fragments[refs[0].fragmentIndex].layerType,
    shapeIndex: fragments[refs[0].fragmentIndex].shapeIndex,
    styleKey,
    style,
    fragments: refs,
    fragmentCount: refs.length,
    styledFragmentCount,
    supportFragmentCount,
    path,
    bbox,
    samplePoint,
    sourceOrder: Math.min(...refs.map(ref => fragments[ref.fragmentIndex].componentIndex)),
    synthesized,
    flattened,
  };
}

function buildUnresolvedChainContour(
  fragments: TVGContourFragment[],
  refs: Array<{ fragmentIndex: number; reversed: boolean }>,
  styleKey: FillStyleKey,
  style: TVGComponent | null,
  synthesized: boolean,
): TVGResolvedContour {
  const bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const path = new Path2D();
  let first = true;
  let flattened: { x: number; y: number }[] = [];
  let styledFragmentCount = 0;
  let supportFragmentCount = 0;

  for (const ref of refs) {
    const fragment = fragments[ref.fragmentIndex];
    if (fragment.supportOnly) supportFragmentCount++;
    else styledFragmentCount++;
    first = appendSegmentsToPath(path, fragment.segments, ref.reversed, first);
    bbox.minX = Math.min(bbox.minX, fragment.bbox.minX);
    bbox.minY = Math.min(bbox.minY, fragment.bbox.minY);
    bbox.maxX = Math.max(bbox.maxX, fragment.bbox.maxX);
    bbox.maxY = Math.max(bbox.maxY, fragment.bbox.maxY);
    const fragPoints = flattenSegments(ref.reversed ? reversedSegments(fragment.segments) : fragment.segments);
    if (flattened.length > 0 && fragPoints.length > 0) fragPoints.shift();
    flattened = flattened.concat(fragPoints);
  }

  const firstFragment = fragments[refs[0].fragmentIndex];
  const samplePoint = isFinite(bbox.minX) && isFinite(bbox.minY) && isFinite(bbox.maxX) && isFinite(bbox.maxY)
    ? (chooseSamplePoint(bbox, flattened) ?? { x: firstFragment.startX, y: firstFragment.startY })
    : { x: firstFragment.startX, y: firstFragment.startY };

  return {
    source: firstFragment.source,
    layerType: firstFragment.layerType,
    shapeIndex: firstFragment.shapeIndex,
    styleKey,
    style,
    fragments: refs,
    fragmentCount: refs.length,
    styledFragmentCount,
    supportFragmentCount,
    path,
    bbox: isFinite(bbox.minX) && isFinite(bbox.minY) && isFinite(bbox.maxX) && isFinite(bbox.maxY)
      ? bbox
      : firstFragment.bbox,
    samplePoint,
    sourceOrder: Math.min(...refs.map(ref => fragments[ref.fragmentIndex].componentIndex)),
    synthesized,
    flattened: flattened.length > 0 ? flattened : flattenSegments(firstFragment.segments),
  };
}

function pickBestChainCandidate(
  chain: Array<{ fragmentIndex: number; reversed: boolean }>,
  fragments: TVGContourFragment[],
  used: Set<number>,
): { fragmentIndex: number; reversed: boolean; prepend: boolean } | null {
  const head = chain[0];
  const tail = chain[chain.length - 1];
  const headFragment = fragments[head.fragmentIndex];
  const tailFragment = fragments[tail.fragmentIndex];
  const headPoint = head.reversed ? { x: headFragment.endX, y: headFragment.endY } : { x: headFragment.startX, y: headFragment.startY };
  const tailPoint = tail.reversed ? { x: tailFragment.startX, y: tailFragment.startY } : { x: tailFragment.endX, y: tailFragment.endY };

  let best: { rank: number; distance: number; support: number; componentIndex: number; fragmentIndex: number; reversed: boolean; prepend: boolean } | null = null;
  for (let i = 0; i < fragments.length; i++) {
    if (used.has(i)) continue;
    const fragment = fragments[i];
    const candidates = [
      { rank: 0, distance: Math.hypot(fragment.startX - tailPoint.x, fragment.startY - tailPoint.y), reversed: false, prepend: false },
      { rank: 1, distance: Math.hypot(fragment.endX - tailPoint.x, fragment.endY - tailPoint.y), reversed: true, prepend: false },
      { rank: 2, distance: Math.hypot(fragment.endX - headPoint.x, fragment.endY - headPoint.y), reversed: false, prepend: true },
      { rank: 3, distance: Math.hypot(fragment.startX - headPoint.x, fragment.startY - headPoint.y), reversed: true, prepend: true },
    ];
    for (const candidate of candidates) {
      if (candidate.distance > CHAIN_TOL) continue;
      const scored = {
        ...candidate,
        support: fragment.supportOnly ? 1 : 0,
        componentIndex: fragment.componentIndex,
        fragmentIndex: i,
      };
      if (!best
        || scored.rank < best.rank
        || (scored.rank === best.rank && scored.distance < best.distance)
        || (scored.rank === best.rank && scored.distance === best.distance && scored.support < best.support)
        || (scored.rank === best.rank && scored.distance === best.distance && scored.support === best.support && scored.componentIndex < best.componentIndex)) {
        best = scored;
      }
    }
  }
  return best ? { fragmentIndex: best.fragmentIndex, reversed: best.reversed, prepend: best.prepend } : null;
}

function buildContoursFromFragments(
  fragments: TVGContourFragment[],
  styleKey: FillStyleKey,
  style: TVGComponent | null,
  synthesized: boolean,
): TVGFillBuildResult {
  const contours: TVGResolvedContour[] = [];
  const unresolvedChains: TVGResolvedContour[] = [];
  const used = new Set<number>();
  const styledSeedIndices = fragments
    .map((fragment, index) => ({ fragment, index }))
    .filter(({ fragment }) => !fragment.supportOnly && fragment.styleKey === styleKey)
    .map(({ index }) => index);

  for (const seedIndex of styledSeedIndices) {
    if (used.has(seedIndex)) continue;
    const chain: Array<{ fragmentIndex: number; reversed: boolean }> = [{ fragmentIndex: seedIndex, reversed: false }];
    used.add(seedIndex);
    while (true) {
      const candidate = pickBestChainCandidate(chain, fragments, used);
      if (!candidate) break;
      used.add(candidate.fragmentIndex);
      if (candidate.prepend) chain.unshift({ fragmentIndex: candidate.fragmentIndex, reversed: candidate.reversed });
      else chain.push({ fragmentIndex: candidate.fragmentIndex, reversed: candidate.reversed });
    }

    const contour = buildResolvedContour(fragments, chain, styleKey, style, synthesized);
    if (contour) contours.push(contour);
    else {
      unresolvedChains.push(buildUnresolvedChainContour(
        fragments,
        chain.map(x => ({ ...x })),
        styleKey,
        style,
        synthesized,
      ));
    }
  }

  return { contours, unresolvedChains };
}

function buildContourTree(contours: TVGResolvedContour[]): TVGContourNode[] {
  const nodes: TVGContourNode[] = contours.map((_, contourIndex) => ({
    contourIndex,
    parent: null,
    children: [],
    depth: 0,
  }));
  for (let i = 0; i < contours.length; i++) {
    const contour = contours[i];
    let parentIndex: number | null = null;
    let parentArea = Infinity;
    for (let j = 0; j < contours.length; j++) {
      if (i === j) continue;
      const candidate = contours[j];
      if (contour.bbox.minX < candidate.bbox.minX - 0.5
        || contour.bbox.maxX > candidate.bbox.maxX + 0.5
        || contour.bbox.minY < candidate.bbox.minY - 0.5
        || contour.bbox.maxY > candidate.bbox.maxY + 0.5) {
        continue;
      }
      if (!contour.samplePoint) continue;
      if (!pointInPolygon(candidate.flattened, contour.samplePoint)) continue;
      const area = (candidate.bbox.maxX - candidate.bbox.minX) * (candidate.bbox.maxY - candidate.bbox.minY);
      if (area < parentArea) {
        parentArea = area;
        parentIndex = j;
      }
    }
    nodes[i].parent = parentIndex;
  }
  for (const node of nodes) {
    if (node.parent !== null) {
      nodes[node.parent].children.push(node.contourIndex);
    }
  }
  const visit = (index: number, depth: number) => {
    nodes[index].depth = depth;
    nodes[index].children.sort((a, b) => contours[a].sourceOrder - contours[b].sourceOrder);
    for (const child of nodes[index].children) visit(child, depth + 1);
  };
  for (const node of nodes) {
    if (node.parent === null) visit(node.contourIndex, 0);
  }
  return nodes;
}

function renderContourTree(
  contours: TVGResolvedContour[],
): LocalFillPaintSource[] {
  const tree = buildContourTree(contours);
  const sources: LocalFillPaintSource[] = [];
  const renderNode = (index: number) => {
    const contour = contours[index];
    const paint = contour.style?.outerPaint ?? null;
    if (paint) {
      const compound = new Path2D();
      compound.addPath(contour.path);
      for (const childIndex of tree[index].children) {
        compound.addPath(contours[childIndex].path);
      }
      sources.push({
        kind: 'path',
        path: compound,
        paint,
        fillRule: tree[index].children.length > 0 ? 'evenodd' : 'nonzero',
      });
    }
    for (const childIndex of tree[index].children) {
      renderNode(childIndex);
    }
  };
  tree
    .filter(node => node.parent === null)
    .sort((a, b) => contours[a.contourIndex].sourceOrder - contours[b.contourIndex].sourceOrder)
    .forEach(node => renderNode(node.contourIndex));
  return sources;
}

function paintContourTree(
  ctx: CanvasRenderingContext2D,
  contours: TVGResolvedContour[],
): void {
  for (const source of renderContourTree(contours)) {
    if (source.path) {
      fillPathWithPaint(ctx, source.path, source.paint, source.fillRule ?? 'nonzero');
    }
  }
}

function paintDirectUnresolvedChains(
  ctx: CanvasRenderingContext2D,
  chains: TVGResolvedContour[],
  alphaScale = 1,
): boolean {
  let painted = false;
  for (const chain of chains.sort((a, b) => a.sourceOrder - b.sourceOrder)) {
    const paint = chain.style?.outerPaint ?? null;
    if (!paint) continue;
    fillPathWithPaint(ctx, chain.path, scalePaintAlpha(paint, alphaScale));
    painted = true;
  }
  return painted;
}

function createRectPathFromBBox(
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
): Path2D | null {
  if (!isFinite(bbox.minX) || !isFinite(bbox.minY) || !isFinite(bbox.maxX) || !isFinite(bbox.maxY)) {
    return null;
  }
  const width = bbox.maxX - bbox.minX;
  const height = bbox.maxY - bbox.minY;
  if (width <= 0 || height <= 0) return null;
  const path = new Path2D();
  path.rect(bbox.minX, bbox.minY, width, height);
  return path;
}

function isContourGeometryClosed(
  contour: Pick<TVGResolvedContour, 'flattened'>,
  tolerance = AUTO_CLOSE_TOL,
): boolean {
  if (contour.flattened.length < 2) return false;
  const first = contour.flattened[0];
  const last = contour.flattened[contour.flattened.length - 1];
  return Math.hypot(first.x - last.x, first.y - last.y) <= tolerance;
}

function renderLegacyChainedFillComponents(
  ctx: CanvasRenderingContext2D,
  allChainComps: TVGComponent[],
  indices: number[],
  tolerance: number,
  alphaScale = 1,
): boolean {
  const compInfos = indices.map(idx => {
    const segs = allChainComps[idx].path!.segments;
    return {
      ci: idx,
      startX: segs[0].x,
      startY: segs[0].y,
      endX: segs[segs.length - 1].x,
      endY: segs[segs.length - 1].y,
    };
  });
  if (compInfos.length === 0) return false;

  const pickBestCandidate = (
    chain: Array<{ ci: number; reversed: boolean; startX: number; startY: number; endX: number; endY: number }>,
    used: Set<number>,
  ): { infoIndex: number; reversed: boolean; prepend: boolean } | null => {
    const head = chain[0];
    const tail = chain[chain.length - 1];
    let best: { rank: number; distance: number; support: number; componentIndex: number; infoIndex: number; reversed: boolean; prepend: boolean } | null = null;
    for (let i = 0; i < compInfos.length; i++) {
      if (used.has(i)) continue;
      const comp = compInfos[i];
      const support = (
        (allChainComps[comp.ci].componentType !== 0 && allChainComps[comp.ci].componentType !== 1)
        || allChainComps[comp.ci].outerPaint === null
      ) ? 1 : 0;
      const candidates = [
        { rank: 0, distance: Math.hypot(comp.startX - tail.endX, comp.startY - tail.endY), reversed: false, prepend: false },
        { rank: 1, distance: Math.hypot(comp.endX - tail.endX, comp.endY - tail.endY), reversed: true, prepend: false },
        { rank: 2, distance: Math.hypot(comp.endX - head.startX, comp.endY - head.startY), reversed: false, prepend: true },
        { rank: 3, distance: Math.hypot(comp.startX - head.startX, comp.startY - head.startY), reversed: true, prepend: true },
      ];
      for (const candidate of candidates) {
        if (candidate.distance > tolerance) continue;
        const scored = {
          ...candidate,
          support,
          componentIndex: comp.ci,
          infoIndex: i,
        };
        if (!best
          || scored.rank < best.rank
          || (scored.rank === best.rank && scored.distance < best.distance)
          || (scored.rank === best.rank && scored.distance === best.distance && scored.support < best.support)
          || (scored.rank === best.rank && scored.distance === best.distance && scored.support === best.support && scored.componentIndex < best.componentIndex)) {
          best = scored;
        }
      }
    }
    return best ? { infoIndex: best.infoIndex, reversed: best.reversed, prepend: best.prepend } : null;
  };

  const used = new Set<number>();
  const chains: Array<Array<{ ci: number; reversed: boolean; startX: number; startY: number; endX: number; endY: number }>> = [];
  for (let i = 0; i < compInfos.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const chain = [{ ...compInfos[i], reversed: false }];
    while (true) {
      const tail = chain[chain.length - 1];
      const head = chain[0];
      if (Math.abs(head.startX - tail.endX) < tolerance && Math.abs(head.startY - tail.endY) < tolerance) break;
      const candidate = pickBestCandidate(chain, used);
      if (!candidate) break;
      const comp = compInfos[candidate.infoIndex];
      used.add(candidate.infoIndex);
      const info = candidate.reversed
        ? {
            ci: comp.ci,
            startX: comp.endX,
            startY: comp.endY,
            endX: comp.startX,
            endY: comp.startY,
            reversed: true,
          }
        : { ...comp, reversed: false };
      if (candidate.prepend) chain.unshift(info);
      else chain.push(info);
    }
    chains.push(chain);
  }

  const paint = indices
    .map(index => allChainComps[index].outerPaint)
    .find((candidate): candidate is TVGPaint => candidate !== null);
  if (!paint) return false;

  const addChainToPath = (path: Path2D, chain: typeof chains[number], isFirstChain: boolean) => {
    let isFirst = isFirstChain;
    const head = chain[0];
    const tail = chain[chain.length - 1];
    const isClosed = Math.abs(head.startX - tail.endX) + Math.abs(head.startY - tail.endY) < tolerance * 2;
    for (const info of chain) {
      const comp = allChainComps[info.ci];
      const segs = comp.path!.segments;
      if (!info.reversed) {
        for (let si = 0; si < segs.length; si++) {
          const seg = segs[si];
          if (si === 0) {
            if (isFirst) {
              path.moveTo(seg.x, seg.y);
              isFirst = false;
            } else {
              path.lineTo(seg.x, seg.y);
            }
          } else if (seg.type === 'C') {
            path.bezierCurveTo(seg.c1x, seg.c1y, seg.c2x, seg.c2y, seg.x, seg.y);
          } else if (seg.type === 'Q') {
            path.quadraticCurveTo(seg.cx, seg.cy, seg.x, seg.y);
          } else {
            path.lineTo(seg.x, seg.y);
          }
        }
      } else {
        const lastSeg = segs[segs.length - 1];
        if (isFirst) {
          path.moveTo(lastSeg.x, lastSeg.y);
          isFirst = false;
        } else {
          path.lineTo(lastSeg.x, lastSeg.y);
        }
        for (let si = segs.length - 1; si >= 1; si--) {
          const seg = segs[si];
          const dest = segs[si - 1];
          if (seg.type === 'C') {
            path.bezierCurveTo(seg.c2x, seg.c2y, seg.c1x, seg.c1y, dest.x, dest.y);
          } else if (seg.type === 'Q') {
            path.quadraticCurveTo(seg.cx, seg.cy, dest.x, dest.y);
          } else {
            path.lineTo(dest.x, dest.y);
          }
        }
      }
    }
    if (isClosed) path.closePath();
  };

  if (chains.length === 1) {
    const path = new Path2D();
    addChainToPath(path, chains[0], true);
    fillPathWithPaint(ctx, path, paint);
    return true;
  }

  const chainGeometries = chains.map(chain => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let flattened: { x: number; y: number }[] = [];
    for (const info of chain) {
      const comp = allChainComps[info.ci];
      const sourceSegments = info.reversed ? reversedSegments(comp.path!.segments) : comp.path!.segments;
      for (const seg of sourceSegments) {
        minX = Math.min(minX, seg.x);
        minY = Math.min(minY, seg.y);
        maxX = Math.max(maxX, seg.x);
        maxY = Math.max(maxY, seg.y);
      }
      const fragPoints = flattenSegments(sourceSegments);
      if (flattened.length > 0 && fragPoints.length > 0) fragPoints.shift();
      flattened = flattened.concat(fragPoints);
    }
    if (flattened.length > 1) {
      const first = flattened[0];
      const last = flattened[flattened.length - 1];
      if (Math.abs(first.x - last.x) > 0.001 || Math.abs(first.y - last.y) > 0.001) {
        flattened = flattened.concat({ ...first });
      }
    }
    const bbox = { minX, minY, maxX, maxY };
    return {
      bbox,
      area: (maxX - minX) * (maxY - minY),
      flattened,
      samplePoint: chooseSamplePoint(bbox, flattened),
    };
  });

  const parent = new Array<number>(chains.length).fill(-1);
  for (let i = 0; i < chains.length; i++) {
    let bestParent = -1;
    let bestArea = Infinity;
    for (let j = 0; j < chains.length; j++) {
      if (i === j) continue;
      const outer = chainGeometries[j];
      const inner = chainGeometries[i];
      if (!inner.samplePoint || outer.flattened.length < 3) continue;
      if (inner.bbox.minX < outer.bbox.minX - 0.5 || inner.bbox.maxX > outer.bbox.maxX + 0.5
        || inner.bbox.minY < outer.bbox.minY - 0.5 || inner.bbox.maxY > outer.bbox.maxY + 0.5) {
        continue;
      }
      if (!pointInPolygon(outer.flattened, inner.samplePoint)) continue;
      if (inner.area < outer.area * 0.95 && outer.area < bestArea) {
        bestParent = j;
        bestArea = outer.area;
      }
    }
    parent[i] = bestParent;
  }

  const processed = new Set<number>();
  for (let i = 0; i < chains.length; i++) {
    if (processed.has(i) || parent[i] !== -1) continue;
    const children: number[] = [];
    for (let j = 0; j < chains.length; j++) {
      if (parent[j] === i) children.push(j);
    }
    const path = new Path2D();
    addChainToPath(path, chains[i], true);
    processed.add(i);
    if (children.length > 0) {
      for (const child of children) {
        addChainToPath(path, chains[child], false);
        processed.add(child);
      }
      fillPathWithPaint(ctx, path, scalePaintAlpha(paint, alphaScale), 'evenodd');
    } else {
      fillPathWithPaint(ctx, path, scalePaintAlpha(paint, alphaScale));
    }
  }

  for (let i = 0; i < chains.length; i++) {
    if (processed.has(i)) continue;
    const path = new Path2D();
    addChainToPath(path, chains[i], true);
    fillPathWithPaint(ctx, path, scalePaintAlpha(paint, alphaScale));
  }
  return true;
}

function renderLegacyExplicitFillShape(
  ctx: CanvasRenderingContext2D,
  shape: TVGShape,
  strokeComps: TVGComponent[],
  alphaScale = 1,
): boolean {
  const chainableFillComps = shape.components.filter(comp =>
    (comp.componentType === 0 || comp.componentType === 1)
    && comp.path
    && comp.path.segments.length > 1
    && !isDegenerate(comp.path)
    && (!comp.color || comp.color.a > 0)
  );
  const explicitFillComps = chainableFillComps.filter(comp => hasExplicitFillStyle(comp) && comp.outerPaint);
  const inheritedSeedFillComps = chainableFillComps.filter(comp =>
    comp.fillPaintSource === 'inherited' && comp.outerPaint,
  );
  const defaultSeedFillComps = chainableFillComps.filter(comp =>
    comp.fillPaintSource === 'default' && comp.outerPaint,
  );
  const paintedFillComps = chainableFillComps.filter(comp => comp.outerPaint !== null);
  const fillComps = explicitFillComps.length > 0
    ? explicitFillComps
    : inheritedSeedFillComps.length > 0
      ? inheritedSeedFillComps
      : defaultSeedFillComps.length > 0
        ? defaultSeedFillComps
        : paintedFillComps;
  const supportFillComps = chainableFillComps.filter(comp => comp.outerPaint === null);
  if (fillComps.length === 0) return false;

  const tolerance = 2.0;
  const boundaryStrokes = strokeComps.filter(comp =>
    comp.componentType === 2
    && comp.strokeWidth === null
    && comp.path
    && comp.path.segments.length > 1,
  );
  const allChainComps = [...paintedFillComps, ...supportFillComps, ...boundaryStrokes];
  const colorGroups = new Map<string, number[]>();
  const boundaryIndices: number[] = [];

  for (let i = 0; i < allChainComps.length; i++) {
    const comp = allChainComps[i];
    const key = paintKeyForComponent(comp);
    if (key) {
      const group = colorGroups.get(key) ?? [];
      group.push(i);
      colorGroups.set(key, group);
    } else {
      boundaryIndices.push(i);
    }
  }

  const keys = Array.from(colorGroups.keys());
  if (keys.length === 0) return false;
  if (keys.length === 1) {
    return renderLegacyChainedFillComponents(ctx, allChainComps, allChainComps.map((_, index) => index), tolerance, alphaScale);
  }

  let rendered = false;
  for (const key of keys) {
    const groupIndices = [...(colorGroups.get(key) ?? []), ...boundaryIndices];
    rendered = renderLegacyChainedFillComponents(ctx, allChainComps, groupIndices, tolerance, alphaScale) || rendered;
  }
  return rendered;
}

function renderLegacyExplicitFillShapeWithSiblingSubtraction(
  ctx: CanvasRenderingContext2D,
  shape: TVGShape,
  strokeComps: TVGComponent[],
  siblingBlockers: TVGShape[],
  alphaScale = 1,
): boolean {
  if (siblingBlockers.length === 0) {
    return renderLegacyExplicitFillShape(ctx, shape, strokeComps, alphaScale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = ctx.canvas.width;
  canvas.height = ctx.canvas.height;
  const scratch = canvas.getContext('2d');
  if (!scratch) {
    return renderLegacyExplicitFillShape(ctx, shape, strokeComps, alphaScale);
  }
  scratch.setTransform(ctx.getTransform());
  if (!renderLegacyExplicitFillShape(scratch, shape, strokeComps, alphaScale)) {
    return false;
  }
  scratch.globalCompositeOperation = 'destination-out';
  for (const blocker of siblingBlockers) {
    const blockerStrokeComps = blocker.components.filter(comp =>
      (comp.componentType === 4 || comp.componentType === 2)
      && comp.path
      && comp.path.segments.length > 0,
    );
    renderLegacyExplicitFillShape(scratch, blocker, blockerStrokeComps, 1);
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(canvas, 0, 0);
  ctx.restore();
  return true;
}

function computePixelBBoxForShape(
  shape: TVGShape,
  baseTransform: DOMMatrix,
): { x1: number; y1: number; x2: number; y2: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const comp of shape.components) {
    if (!comp.path) continue;
    for (const seg of comp.path.segments) {
      const points = [{ x: seg.x, y: seg.y }];
      if (seg.type === 'Q') points.push({ x: seg.cx, y: seg.cy });
      else if (seg.type === 'C') points.push({ x: seg.c1x, y: seg.c1y }, { x: seg.c2x, y: seg.c2y });
      for (const point of points) {
        const px = baseTransform.a * point.x + baseTransform.c * point.y + baseTransform.e;
        const py = baseTransform.b * point.x + baseTransform.d * point.y + baseTransform.f;
        minX = Math.min(minX, px);
        minY = Math.min(minY, py);
        maxX = Math.max(maxX, px);
        maxY = Math.max(maxY, py);
      }
    }
  }
  if (!isFinite(minX)) return null;
  return { x1: minX, y1: minY, x2: maxX, y2: maxY };
}

function unionPixelBBoxes(
  boxes: Array<{ x1: number; y1: number; x2: number; y2: number } | null>,
): { x1: number; y1: number; x2: number; y2: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = false;
  for (const box of boxes) {
    if (!box) continue;
    minX = Math.min(minX, box.x1);
    minY = Math.min(minY, box.y1);
    maxX = Math.max(maxX, box.x2);
    maxY = Math.max(maxY, box.y2);
    found = true;
  }
  if (!found) return null;
  return { x1: minX, y1: minY, x2: maxX, y2: maxY };
}

function clipLocalFillSources(
  ctx: CanvasRenderingContext2D,
  layer: TVGArtLayer,
  shape: TVGShape,
  fillSources: LocalFillPaintSource[],
  defaultStrokeWidth: number,
  skipClipping: boolean,
  extraMaskShapes: TVGShape[] = [],
): boolean {
  const baseTransform = ctx.getTransform();
  const bbox = unionPixelBBoxes([
    computePixelBBoxForShape(shape, baseTransform),
    ...extraMaskShapes.map(maskShape => computePixelBBoxForShape(maskShape, baseTransform)),
  ]);
  if (!bbox) return false;

  const margin = 20;
  const bx1 = Math.floor(bbox.x1 - margin);
  const by1 = Math.floor(bbox.y1 - margin);
  const bx2 = Math.ceil(bbox.x2 + margin);
  const by2 = Math.ceil(bbox.y2 + margin);
  const bw = Math.max(1, bx2 - bx1);
  const bh = Math.max(1, by2 - by1);

  const fillCanvas = document.createElement('canvas');
  fillCanvas.width = bw;
  fillCanvas.height = bh;
  const fillCtx = fillCanvas.getContext('2d')!;
  fillCtx.setTransform(
    baseTransform.a, baseTransform.b,
    baseTransform.c, baseTransform.d,
    baseTransform.e - bx1, baseTransform.f - by1,
  );

  for (const source of fillSources) {
    if (source.kind === 'bbox') {
      fillCtx.save();
      fillCtx.setTransform(1, 0, 0, 1, 0, 0);
      fillCtx.fillStyle = paintToCssColor(source.paint);
      fillCtx.fillRect(0, 0, bw, bh);
      fillCtx.restore();
    } else if (source.path) {
      fillPathWithPaint(fillCtx, source.path, source.paint, source.fillRule ?? 'nonzero');
    }
  }

  if (skipClipping) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(fillCanvas, bx1, by1);
    ctx.restore();
    return true;
  }

  const maskScale = 3;
  const mw = bw * maskScale;
  const mh = bh * maskScale;
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = mw;
  maskCanvas.height = mh;
  const maskCtx = maskCanvas.getContext('2d')!;
  maskCtx.setTransform(
    baseTransform.a * maskScale, baseTransform.b * maskScale,
    baseTransform.c * maskScale, baseTransform.d * maskScale,
    (baseTransform.e - bx1) * maskScale, (baseTransform.f - by1) * maskScale,
  );
  renderStrokeMask(maskCtx, { ...layer, shapes: [shape, ...extraMaskShapes] }, defaultStrokeWidth);

  const maskData = maskCtx.getImageData(0, 0, mw, mh);
  const isWall = new Uint8Array(mw * mh);
  for (let i = 0; i < mw * mh; i++) {
    if (maskData.data[i * 4 + 3] > 30) isWall[i] = 1;
  }
  const dilated = new Uint8Array(mw * mh);
  const DR2x = 6;
  const DR2xSq = DR2x * DR2x;
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      const idx = y * mw + x;
      if (isWall[idx]) { dilated[idx] = 1; continue; }
      let found = false;
      for (let dy = -DR2x; dy <= DR2x && !found; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= mh) continue;
        for (let dx = -DR2x; dx <= DR2x && !found; dx++) {
          if (dx * dx + dy * dy > DR2xSq) continue;
          const nx = x + dx;
          if (nx >= 0 && nx < mw && isWall[ny * mw + nx]) found = true;
        }
      }
      if (found) dilated[idx] = 1;
    }
  }
  const erodeR = DR2x - 1;
  const erodeRSq = erodeR * erodeR;
  const closed = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      const idx = y * mw + x;
      if (!dilated[idx]) continue;
      let allDilated = true;
      for (let dy = -erodeR; dy <= erodeR && allDilated; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= mh) { allDilated = false; continue; }
        for (let dx = -erodeR; dx <= erodeR && allDilated; dx++) {
          if (dx * dx + dy * dy > erodeRSq) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= mw || !dilated[ny * mw + nx]) allDilated = false;
        }
      }
      if (allDilated) closed[idx] = 1;
    }
  }
  const outside = new Uint8Array(mw * mh);
  const queue: number[] = [];
  for (let x = 0; x < mw; x++) {
    if (!closed[x]) { outside[x] = 1; queue.push(x); }
    const b = (mh - 1) * mw + x;
    if (!closed[b]) { outside[b] = 1; queue.push(b); }
  }
  for (let y = 1; y < mh - 1; y++) {
    const left = y * mw;
    const right = left + mw - 1;
    if (!closed[left]) { outside[left] = 1; queue.push(left); }
    if (!closed[right]) { outside[right] = 1; queue.push(right); }
  }
  for (let head = 0; head < queue.length; head++) {
    const idx = queue[head];
    const x = idx % mw;
    const y = Math.floor(idx / mw);
    const neighbors = [
      x > 0 ? idx - 1 : -1,
      x < mw - 1 ? idx + 1 : -1,
      y > 0 ? idx - mw : -1,
      y < mh - 1 ? idx + mw : -1,
    ];
    for (const neighbor of neighbors) {
      if (neighbor >= 0 && !outside[neighbor] && !closed[neighbor]) {
        outside[neighbor] = 1;
        queue.push(neighbor);
      }
    }
  }

  const fillData = fillCtx.getImageData(0, 0, bw, bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      let allOutside = true;
      const x2 = x * maskScale;
      const y2 = y * maskScale;
      for (let dy = 0; dy < maskScale && allOutside; dy++) {
        for (let dx = 0; dx < maskScale && allOutside; dx++) {
          if (!outside[(y2 + dy) * mw + (x2 + dx)]) allOutside = false;
        }
      }
      if (allOutside) fillData.data[(y * bw + x) * 4 + 3] = 0;
    }
  }
  fillCtx.putImageData(fillData, 0, 0);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(fillCanvas, bx1, by1);
  ctx.restore();
  return true;
}

function createContourFragment(
  layerType: TVGArtLayer['type'],
  shapeIndex: number,
  componentIndex: number,
  source: ContourSource,
  comp: TVGComponent | null,
  segments: TVGSegment[],
  styleKey: FillStyleKey | null,
  supportOnly: boolean,
): TVGContourFragment | null {
  const drawableCount = segments.filter(seg => seg.type !== 'M').length;
  if (drawableCount < 1) return null;
  const bbox = segmentBounds(segments);
  if ((bbox.maxX - bbox.minX) < 0.01 && (bbox.maxY - bbox.minY) < 0.01) return null;
  const start = segments[0];
  const end = segments[segments.length - 1];
  return {
    source,
    layerType,
    shapeIndex,
    componentIndex,
    styleKey,
    style: comp,
    segments,
    startX: start.x,
    startY: start.y,
    endX: end.x,
    endY: end.y,
    bbox,
    reversible: true,
    supportOnly,
  };
}

function collectExplicitFillFragments(
  shape: TVGShape,
  layerType: TVGArtLayer['type'],
  shapeIndex: number,
): TVGContourFragment[] {
  const fragments: TVGContourFragment[] = [];
  const supportBoundaryComps = shape.components.filter(comp =>
    comp.componentType === 2 && comp.strokeWidth === null && comp.path && comp.path.segments.length > 1,
  );
  const explicitPaintKeys = new Set(
    shape.components
      .filter(comp =>
        (comp.componentType === 0 || comp.componentType === 1)
        && comp.path
        && !isDegenerate(comp.path)
        && comp.outerPaint !== null
        && (!comp.color || comp.color.a > 0)
        && hasExplicitFillStyle(comp),
      )
      .map(comp => paintKeyForComponent(comp))
      .filter((key): key is FillStyleKey => key !== null),
  );
  const hasExplicitStyledFill = shape.components.some(comp =>
    (comp.componentType === 0 || comp.componentType === 1)
    && comp.path
    && !isDegenerate(comp.path)
    && comp.outerPaint !== null
    && (!comp.color || comp.color.a > 0)
    && hasExplicitFillStyle(comp),
  );
  const inheritedPaintKeys = new Set(
    shape.components
      .filter(comp =>
        (comp.componentType === 0 || comp.componentType === 1)
        && comp.path
        && !isDegenerate(comp.path)
        && comp.outerPaint !== null
        && (!comp.color || comp.color.a > 0)
        && comp.fillPaintSource === 'inherited',
      )
      .map(comp => paintKeyForComponent(comp))
      .filter((key): key is FillStyleKey => key !== null),
  );
  const allowInheritedOnlySingleStyle = !hasExplicitStyledFill && inheritedPaintKeys.size === 1;
  const hasType1CarrierSupport = shape.components.some(comp =>
    comp.componentType === 1 && comp.path && !isDegenerate(comp.path),
  );
  shape.components.forEach((comp, componentIndex) => {
    if ((comp.componentType !== 0 && comp.componentType !== 1) || !comp.path || isDegenerate(comp.path)) return;
    if (comp.color && comp.color.a <= 0) return;
    const canUseInheritedStyle = (allowInheritedOnlySingleStyle
      || (hasExplicitStyledFill && (
        explicitPaintKeys.size <= 1
        || hasType1CarrierSupport
        || supportBoundaryComps.length > 0
      )))
      && comp.outerPaint !== null
      && comp.fillPaintSource === 'inherited';
    const styleKey = hasExplicitFillStyle(comp) || canUseInheritedStyle ? paintKeyForComponent(comp) : null;
    for (const segments of splitPathIntoSubpaths(comp.path)) {
      const fragment = createContourFragment(
        layerType,
        shapeIndex,
        componentIndex,
        'explicit-fill',
        comp,
        segments,
        styleKey,
        styleKey === null,
      );
      if (fragment) fragments.push(fragment);
    }
  });
  supportBoundaryComps.forEach((comp, componentIndex) => {
    for (const segments of splitPathIntoSubpaths(comp.path!)) {
      const fragment = createContourFragment(
        layerType,
        shapeIndex,
        componentIndex,
        'boundary-stroke',
        comp,
        segments,
        null,
        true,
      );
      if (fragment) fragments.push(fragment);
    }
  });
  return fragments;
}

function collectBoundaryFragments(
  shape: TVGShape,
  layerType: TVGArtLayer['type'],
  shapeIndex: number,
  boundaryStyle: TVGPaint,
): TVGContourFragment[] {
  const fragments: TVGContourFragment[] = [];
  const syntheticStyle = createSyntheticStyleComponent(boundaryStyle);
  const styleKey = paintKeyForComponent(syntheticStyle) || 'boundary';
  shape.components.forEach((comp, componentIndex) => {
    if (comp.componentType !== 2 || comp.strokeWidth !== null || !comp.path) return;
    for (const segments of splitPathIntoSubpaths(comp.path)) {
      const fragment = createContourFragment(
        layerType,
        shapeIndex,
        componentIndex,
        'boundary-stroke',
        syntheticStyle,
        segments,
        styleKey,
        false,
      );
      if (fragment) fragments.push(fragment);
    }
  });
  return fragments;
}

function getMaxProfileWidth(profile: TVGThicknessProfile): number {
  let maxWidth = 0;
  for (const point of profile.points) {
    maxWidth = Math.max(maxWidth, point.leftOffset + point.rightOffset);
  }
  return maxWidth;
}

function collectThinPencilFragments(
  shape: TVGShape,
  layerType: TVGArtLayer['type'],
  shapeIndex: number,
  pencilStyle: TVGPaint,
  defaultStrokeWidth: number,
): TVGContourFragment[] {
  const fragments: TVGContourFragment[] = [];
  const syntheticStyle = createSyntheticStyleComponent(pencilStyle);
  const styleKey = paintKeyForComponent(syntheticStyle) || 'thin-pencil';
  const maxAllowedWidth = Math.max(defaultStrokeWidth * 1.5, 6);
  shape.components.forEach((comp, componentIndex) => {
    if (comp.componentType !== 4 || !comp.path) return;
    const profile = resolveStrokeProfile(comp, defaultStrokeWidth);
    const maxWidth = profile ? getMaxProfileWidth(profile) : defaultStrokeWidth;
    if (maxWidth > maxAllowedWidth) return;
    for (const segments of splitPathIntoSubpaths(comp.path)) {
      const fragment = createContourFragment(
        layerType,
        shapeIndex,
        componentIndex,
        'thin-pencil',
        syntheticStyle,
        segments,
        styleKey,
        false,
      );
      if (fragment) fragments.push(fragment);
    }
  });
  return fragments;
}

function buildContoursForShape(
  fragments: TVGContourFragment[],
  synthesized: boolean,
): TVGFillBuildResult {
  const contours: TVGResolvedContour[] = [];
  const unresolvedChains: TVGResolvedContour[] = [];
  const styleKeys = new Set(
    fragments
      .filter(fragment => fragment.styleKey !== null && !fragment.supportOnly)
      .map(fragment => fragment.styleKey as string),
  );
  for (const styleKey of styleKeys) {
    const styleFragments = fragments.filter(fragment =>
      fragment.styleKey === styleKey || fragment.supportOnly,
    );
    const styleComp = styleFragments.find(fragment => !fragment.supportOnly && fragment.style)?.style ?? null;
    const result = buildContoursFromFragments(styleFragments, styleKey, styleComp, synthesized);
    contours.push(...result.contours);
    unresolvedChains.push(...result.unresolvedChains);
  }
  return { contours, unresolvedChains };
}

export function __debugBuildContoursForShape(
  shape: TVGShape,
  layerType: TVGArtLayer['type'],
  shapeIndex: number,
): {
  fragments: Array<{
    componentIndex: number;
    styleKey: FillStyleKey | null;
    supportOnly: boolean;
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  }>;
  contours: Array<{
    styleKey: FillStyleKey;
    sourceOrder: number;
    fragmentCount: number;
    styledFragmentCount: number;
    supportFragmentCount: number;
    bbox: { minX: number; minY: number; maxX: number; maxY: number };
    childCount: number;
  }>;
  unresolvedChains: Array<{
    styleKey: FillStyleKey;
    sourceOrder: number;
    fragmentCount: number;
    styledFragmentCount: number;
    supportFragmentCount: number;
  }>;
} {
  const fragments = collectExplicitFillFragments(shape, layerType, shapeIndex);
  const build = buildContoursForShape(fragments, false);
  const tree = buildContourTree(build.contours);
  return {
    fragments: fragments.map(fragment => ({
      componentIndex: fragment.componentIndex,
      styleKey: fragment.styleKey,
      supportOnly: fragment.supportOnly,
      startX: fragment.startX,
      startY: fragment.startY,
      endX: fragment.endX,
      endY: fragment.endY,
    })),
    contours: build.contours.map((contour, index) => ({
      styleKey: contour.styleKey,
      sourceOrder: contour.sourceOrder,
      fragmentCount: contour.fragmentCount,
      styledFragmentCount: contour.styledFragmentCount,
      supportFragmentCount: contour.supportFragmentCount,
      bbox: contour.bbox,
      childCount: tree[index]?.children.length ?? 0,
    })),
    unresolvedChains: build.unresolvedChains.map(contour => ({
      styleKey: contour.styleKey,
      sourceOrder: contour.sourceOrder,
      fragmentCount: contour.fragmentCount,
      styledFragmentCount: contour.styledFragmentCount,
      supportFragmentCount: contour.supportFragmentCount,
    })),
  };
}


function renderLayerPass(
  ctx: CanvasRenderingContext2D,
  layer: TVGArtLayer,
  defaultStrokeWidth: number,
  pass: 'fill' | 'stroke',
  options?: TVGFillRenderOptions,
): void {
  const attenuateLowAlphaGuideFills = shouldAttenuateLowAlphaGuideFills(layer);
  for (let shapeIndex = 0; shapeIndex < layer.shapes.length; shapeIndex++) {
    const shape = layer.shapes[shapeIndex];
    const strokeComps = shape.components.filter(c => (c.componentType === 4 || c.componentType === 2) && c.path && c.path.segments.length > 0);
    const lowAlphaGuideFillScale = attenuateLowAlphaGuideFills
      && shape.components.length === 1
      && isLowAlphaSolidFillComponent(shape.components[0])
      ? 0.7
      : 1;

    if (pass === 'fill') {
      const explicitFragments = collectExplicitFillFragments(shape, layer.type, shapeIndex);
      const explicitBuild = buildContoursForShape(explicitFragments, false);
      if (shouldSuppressLargeNearBlackLineFillShape(layer, shape, strokeComps, explicitBuild.contours.length)) {
        continue;
      }
      if (shouldSuppressSeedCarrierFillShape(layer, shape)) {
        continue;
      }
      const siblingBoundaryMaskShapes = options?.skipClipping
        ? []
        : collectSiblingBoundaryMaskShapes(options?.allLayers, layer, shape);
      const fillCarrierCount = shape.components.filter(comp =>
        (comp.componentType === 0 || comp.componentType === 1)
        && comp.path
        && !isDegenerate(comp.path),
      ).length;
      const hasInheritedFillCarriers = shape.components.some(comp =>
        (comp.componentType === 0 || comp.componentType === 1)
        && comp.path
        && comp.outerPaint !== null
        && comp.fillPaintSource === 'inherited',
      );
      const fillPaintKeys = new Set(
        shape.components
          .filter(comp =>
            (comp.componentType === 0 || comp.componentType === 1)
            && comp.path
            && comp.outerPaint !== null,
          )
          .map(comp => paintKeyForComponent(comp))
          .filter((key): key is FillStyleKey => key !== null),
      );
      const explicitFillPaintKeys = new Set(
        shape.components
          .filter(comp =>
            (comp.componentType === 0 || comp.componentType === 1)
            && comp.path
            && comp.outerPaint !== null
            && hasExplicitFillStyle(comp),
          )
          .map(comp => paintKeyForComponent(comp))
          .filter((key): key is FillStyleKey => key !== null),
      );
      const dominantFillPaint = shape.components.find(comp =>
        (comp.componentType === 0 || comp.componentType === 1)
        && comp.path
        && comp.outerPaint !== null,
      )?.outerPaint ?? null;
      const shouldSubtractNearBlackSiblingFillBlockers = layer.type === 'line'
        && strokeComps.length === 0
        && fillPaintKeys.size > 1
        && explicitBuild.contours.length === 0
        && explicitBuild.unresolvedChains.length > 0;
      const nearBlackSiblingFillBlockers = shouldSubtractNearBlackSiblingFillBlockers
        ? collectPreviousNearBlackRenderableFillShapes(layer, shapeIndex, shape)
        : [];
      const shouldPreferSiblingBoundaryClip = !options?.skipClipping
        && strokeComps.length === 0
        && fillCarrierCount > 0
        && fillCarrierCount <= 12
        && fillPaintKeys.size === 1
        && explicitBuild.contours.length === 0
        && siblingBoundaryMaskShapes.length >= 4
        && dominantFillPaint !== null;
      if (shouldPreferSiblingBoundaryClip && clipLocalFillSources(
        ctx,
        layer,
        shape,
        [{ kind: 'bbox', paint: dominantFillPaint }],
        defaultStrokeWidth,
        false,
        siblingBoundaryMaskShapes,
      )) {
        continue;
      }
      const shouldPaintSmallUnresolvedDirectly = strokeComps.length === 0
        && explicitBuild.contours.length === 0
        && explicitBuild.unresolvedChains.length > 0
        && siblingBoundaryMaskShapes.length === 0
        && explicitBuild.unresolvedChains.every(chain =>
          chain.supportFragmentCount > 0
          && chain.styledFragmentCount > 0
          && chain.fragmentCount <= 4
          && (chain.bbox.maxX - chain.bbox.minX) <= 900
          && (chain.bbox.maxY - chain.bbox.minY) <= 900,
        );
      if (shouldPaintSmallUnresolvedDirectly
        && paintDirectUnresolvedChains(ctx, explicitBuild.unresolvedChains, lowAlphaGuideFillScale)) {
        continue;
      }
      const shouldPreferMaskedRectUnresolvedFill = layer.type === 'line'
        && !options?.skipClipping
        && strokeComps.length === 0
        && fillCarrierCount >= 20
        && explicitBuild.contours.length === 0
        && explicitBuild.unresolvedChains.length > 0
        && fillPaintKeys.size >= 2
        && siblingBoundaryMaskShapes.length >= 4
        && explicitBuild.unresolvedChains.every(chain =>
          chain.styledFragmentCount === 1
          && chain.supportFragmentCount >= 8,
        );
      if (shouldPreferMaskedRectUnresolvedFill) {
        const rectFillSources = explicitBuild.unresolvedChains
          .map(chain => {
            const paint = chain.style?.outerPaint ?? null;
            const path = createRectPathFromBBox(chain.bbox);
            if (!paint || !path) return null;
            return { kind: 'path' as const, path, paint };
          })
          .filter((source): source is { kind: 'path'; path: Path2D; paint: TVGPaint } => source !== null);
        if (rectFillSources.length > 0
          && clipLocalFillSources(ctx, layer, shape, rectFillSources, defaultStrokeWidth, false, siblingBoundaryMaskShapes)) {
          continue;
        }
      }
      const shouldPreferLegacyInheritedFillShape = layer.type === 'line'
        && strokeComps.length === 0
        && fillCarrierCount >= 2
        && hasInheritedFillCarriers
        && explicitFillPaintKeys.size <= 1
        && fillPaintKeys.size <= 1
        && !isNearlyBlackSolidPaint(dominantFillPaint);
      const shouldPreferLegacyInheritedOnlyShape = strokeComps.length === 0
        && hasInheritedFillCarriers
        && explicitFillPaintKeys.size === 0
        && fillPaintKeys.size === 1
        && explicitBuild.unresolvedChains.length > 0;
      const shouldPreferLegacyUnresolvedFillOnlyShape = strokeComps.length === 0
        && siblingBoundaryMaskShapes.length === 0
        && fillPaintKeys.size === 1
        && explicitBuild.unresolvedChains.length > 0;
      const shouldSkipLegacyForPureOpenUnresolved = layer.type === 'line'
        && strokeComps.length === 0
        && siblingBoundaryMaskShapes.length === 0
        && explicitBuild.contours.length === 0
        && explicitBuild.unresolvedChains.length > 0
        && explicitBuild.unresolvedChains.every(chain =>
          chain.supportFragmentCount === 0
          && !isContourGeometryClosed(chain),
        );
      const shouldPreferLegacy = (
        explicitBuild.unresolvedChains.length > explicitBuild.contours.length
        && explicitBuild.unresolvedChains.length > 0
      )
        || shouldPreferLegacyInheritedFillShape
        || shouldPreferLegacyInheritedOnlyShape
        || shouldPreferLegacyUnresolvedFillOnlyShape;
      if (!shouldSkipLegacyForPureOpenUnresolved
        && (shouldPreferLegacy || explicitBuild.contours.length === 0)
        && renderLegacyExplicitFillShapeWithSiblingSubtraction(
          ctx,
          shape,
          strokeComps,
          nearBlackSiblingFillBlockers,
          lowAlphaGuideFillScale,
        )) {
        continue;
      }
      let renderedExplicit = false;
      if (explicitBuild.contours.length > 0) {
        const sortedContours = explicitBuild.contours.sort((a, b) => a.sourceOrder - b.sourceOrder);
        const contourFillSources = renderContourTree(sortedContours);
        const shouldClipResolvedContours = !options?.skipClipping
          && strokeComps.length === 0
          && siblingBoundaryMaskShapes.length > 0;
        if (shouldClipResolvedContours
          && clipLocalFillSources(ctx, layer, shape, contourFillSources, defaultStrokeWidth, false, siblingBoundaryMaskShapes)) {
          renderedExplicit = true;
        } else {
          for (const source of contourFillSources) {
            if (source.path) {
              fillPathWithPaint(ctx, source.path, scalePaintAlpha(source.paint, lowAlphaGuideFillScale), source.fillRule ?? 'nonzero');
            }
          }
          renderedExplicit = contourFillSources.length > 0;
        }
      }

      const hasLocalClipMask = strokeComps.length > 0 || siblingBoundaryMaskShapes.length > 0;
      if (explicitBuild.unresolvedChains.length > 0 && !options?.skipClipping && hasLocalClipMask) {
        const fillSources = explicitBuild.unresolvedChains
          .map(contour => contour.style?.outerPaint ? {
            kind: 'path' as const,
            path: contour.path,
            paint: contour.style.outerPaint,
          } : null)
          .filter((source): source is NonNullable<typeof source> => source !== null);
        if (fillSources.length > 0 && clipLocalFillSources(ctx, layer, shape, fillSources, defaultStrokeWidth, false, siblingBoundaryMaskShapes)) {
          renderedExplicit = true;
        }
      }
      if (!renderedExplicit
        && explicitBuild.unresolvedChains.length > 0
        && !shouldSkipLegacyForPureOpenUnresolved
        && renderLegacyExplicitFillShapeWithSiblingSubtraction(
          ctx,
          shape,
          strokeComps,
          nearBlackSiblingFillBlockers,
          lowAlphaGuideFillScale,
        )) {
        renderedExplicit = true;
      }
      if (renderedExplicit) continue;

      const shouldSuppressBoundaryFillFallback = isBoundaryOnlyShape(shape)
        && hasSiblingRenderableFillShape(options?.allLayers, layer, shape);

      if (options?.defaultBoundaryFillColor && !shouldSuppressBoundaryFillFallback) {
        const boundaryPaint = cloneSolidPaint(options.defaultBoundaryFillColor);
        const boundaryFragments = collectBoundaryFragments(shape, layer.type, shapeIndex, boundaryPaint);
        if (boundaryFragments.length > 0) {
          const boundaryBuild = buildContoursForShape(boundaryFragments, true);
          if (boundaryBuild.contours.length > 0) {
            paintContourTree(ctx, boundaryBuild.contours.sort((a, b) => a.sourceOrder - b.sourceOrder));
            continue;
          }
          if (!options.skipClipping) {
            if (clipLocalFillSources(ctx, layer, shape, [{ kind: 'bbox', paint: boundaryPaint }], defaultStrokeWidth, false, siblingBoundaryMaskShapes)) {
              continue;
            }
          }
        }
      }

      const pencilComps = strokeComps.filter(comp =>
        comp.componentType === 4
        && comp.path
        && comp.outerPaint?.kind === 'solid'
        && comp.outerPaint.rgba.r >= 30
        && comp.outerPaint.rgba.g >= 30
        && comp.outerPaint.rgba.b >= 30,
      );
      const hasOnlyPencils = strokeComps.length > 0 && strokeComps.every(comp => comp.componentType === 4);
      const allowLineLayerPencilContours = layer.type === 'line'
        && hasOnlyPencils
        && pencilComps.length === strokeComps.length
        && shape.components.every(comp => comp.componentType === 4)
        && pencilComps.every(comp => !isNearlyBlackSolidPaint(comp.outerPaint))
        && new Set(pencilComps.map(comp => paintKeyForComponent(comp))).size === 1;
      const allowPencilFallback = layer.type !== 'line' || allowLineLayerPencilContours;
      if (allowPencilFallback && hasOnlyPencils && pencilComps.length > 0) {
        const counts = new Map<string, { count: number; paint: TVGPaint }>();
        for (const comp of pencilComps) {
          const paint = comp.outerPaint!;
          const key = JSON.stringify(paint);
          const entry = counts.get(key) || { count: 0, paint };
          entry.count++;
          counts.set(key, entry);
        }
        const dominant = Array.from(counts.values()).sort((a, b) => b.count - a.count)[0];
        if (dominant) {
          const pencilFragments = collectThinPencilFragments(shape, layer.type, shapeIndex, dominant.paint, defaultStrokeWidth);
          if (pencilFragments.length > 0) {
            const pencilBuild = buildContoursForShape(pencilFragments, true);
            if (pencilBuild.contours.length > 0) {
              paintContourTree(ctx, pencilBuild.contours.sort((a, b) => a.sourceOrder - b.sourceOrder));
              continue;
            }
          }
          if (layer.type !== 'line'
            && clipLocalFillSources(ctx, layer, shape, [{ kind: 'bbox', paint: dominant.paint }], defaultStrokeWidth, !!options?.skipClipping, siblingBoundaryMaskShapes)) {
            continue;
          }
        }
      }
      continue;
    }

    if (pass === 'stroke') {
      for (const comp of strokeComps) {
        renderStrokeComponent(ctx, layer, shape, comp, defaultStrokeWidth, options?.diagnostics);
      }
    }
  }
}

interface TVGStrokeSample {
  x: number;
  y: number;
  nx: number;
  ny: number;
  leftW: number;
  rightW: number;
}

interface TVGStrokeOutline {
  centerlinePoints: Array<{ x: number; y: number }>;
  leftEdge: Array<{ x: number; y: number }>;
  rightEdge: Array<{ x: number; y: number }>;
  isClosed: boolean;
  firstSample: TVGStrokeSample | null;
  lastSample: TVGStrokeSample | null;
}

function createUniformThicknessProfile(totalWidth: number, closed: boolean): TVGThicknessProfile {
  const half = Math.max(0, totalWidth / 2);
  const zero = { x: 0, y: half };
  return {
    points: [
      {
        loc: 0,
        leftOffset: half,
        leftCtrlBack: zero,
        leftCtrlFwd: zero,
        rightOffset: half,
        rightCtrlBack: zero,
        rightCtrlFwd: zero,
      },
      {
        loc: 1,
        leftOffset: half,
        leftCtrlBack: zero,
        leftCtrlFwd: zero,
        rightOffset: half,
        rightCtrlBack: zero,
        rightCtrlFwd: zero,
      },
    ],
    domain: [0, 1],
    tipTangentLeftFrom: 1,
    tipTangentRightFrom: 1,
    tipTangentLeftTo: 1,
    tipTangentRightTo: 1,
    closed,
  };
}

function resolveStrokeProfile(
  comp: TVGComponent,
  defaultStrokeWidth: number,
  overrideWidth?: number | null,
): TVGThicknessProfile | null {
  if (!comp.path || comp.path.segments.length < 2) return null;
  if (comp.thicknessProfile) return comp.thicknessProfile;
  const totalWidth = overrideWidth
    ?? comp.strokeWidth
    ?? comp.tgtiThickness
    ?? (comp.componentType === 4 ? defaultStrokeWidth : null);
  if (totalWidth === null || totalWidth < 0.05) return null;
  return createUniformThicknessProfile(totalWidth, isPathEffectivelyClosed(comp.path));
}

function paintToCssColor(paint: TVGPaint): string {
  if (paint.kind === 'solid') {
    const { r, g, b, a } = paint.rgba;
    return `rgba(${r},${g},${b},${a / 255})`;
  }
  const { r, g, b, a } = paint.fallback;
  return `rgba(${r},${g},${b},${a / 255})`;
}

function createGradientFill(
  ctx: CanvasRenderingContext2D,
  paint: Extract<TVGPaint, { kind: 'gradient' }>,
): CanvasGradient {
  const gradient = paint.gradientType === 'linear'
    ? ctx.createLinearGradient(0, 0, 1, 0)
    : ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  for (const stop of paint.stops) {
    const offset = Math.max(0, Math.min(1, stop.pos / 100));
    gradient.addColorStop(offset, `rgba(${stop.r},${stop.g},${stop.b},${stop.a / 255})`);
  }
  return gradient;
}

function fillPathWithPaint(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  paint: TVGPaint,
  fillRule: CanvasFillRule = 'nonzero',
): boolean {
  if (paint.kind === 'solid') {
    ctx.fillStyle = paintToCssColor(paint);
    ctx.fill(path, fillRule);
    return true;
  }

  const transform = paint.transform;
  if (transform) {
    const det = transform.a * transform.d - transform.b * transform.c;
    if (Math.abs(det) > 1e-8) {
      try {
        const matrix = new DOMMatrix([transform.a, transform.b, transform.c, transform.d, transform.tx, transform.ty]);
        const localPath = new Path2D();
        localPath.addPath(path, matrix.inverse());
        ctx.save();
        ctx.transform(transform.a, transform.b, transform.c, transform.d, transform.tx, transform.ty);
        ctx.fillStyle = createGradientFill(ctx, paint);
        ctx.fill(localPath, fillRule);
        ctx.restore();
        return true;
      } catch {
        // Fall back to the solid backup color below.
      }
    }
  }

  ctx.fillStyle = `rgba(${paint.fallback.r},${paint.fallback.g},${paint.fallback.b},${paint.fallback.a / 255})`;
  ctx.fill(path, fillRule);
  return true;
}

function paintsEqual(a: TVGPaint | null, b: TVGPaint | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function buildStrokeOutline(path: TVGPath, profile: TVGThicknessProfile): TVGStrokeOutline | null {
  const segs = path.segments;
  if (segs.length < 2) return null;

  const { arcStarts: segArcStarts, totalLen } = computeSegmentArcLengths(segs);
  if (totalLen < 0.01) return null;

  const numSamples = Math.max(40, Math.min(300, Math.ceil(totalLen)));
  const [domainStart, domainEnd] = profile.domain;
  const domainLen = domainEnd - domainStart;

  const centerlinePoints: Array<{ x: number; y: number }> = [];
  const leftEdge: Array<{ x: number; y: number }> = [];
  const rightEdge: Array<{ x: number; y: number }> = [];
  let firstSample: TVGStrokeSample | null = null;
  let lastSample: TVGStrokeSample | null = null;

  const maxIndex = profile.closed ? numSamples - 1 : numSamples;
  for (let i = 0; i <= maxIndex; i++) {
    const frac = numSamples > 0 ? i / numSamples : 0;
    const pt = sampleCenterline(segs, segArcStarts, totalLen, frac);
    if (!pt) continue;
    const thicknessT = domainLen > 0 ? domainStart + frac * domainLen : frac;
    const { leftW, rightW } = interpolateThickness(profile, thicknessT);
    const sample: TVGStrokeSample = { ...pt, leftW, rightW };
    centerlinePoints.push({ x: pt.x, y: pt.y });
    leftEdge.push({ x: pt.x + pt.nx * leftW, y: pt.y + pt.ny * leftW });
    rightEdge.push({ x: pt.x - pt.nx * rightW, y: pt.y - pt.ny * rightW });
    if (!firstSample) firstSample = sample;
    lastSample = sample;
  }

  if (leftEdge.length < 2 || !firstSample || !lastSample) return null;
  return {
    centerlinePoints,
    leftEdge,
    rightEdge,
    isClosed: profile.closed || isPathEffectivelyClosed(path),
    firstSample,
    lastSample,
  };
}

function tangentFromSample(sample: TVGStrokeSample): { x: number; y: number } {
  return { x: sample.ny, y: -sample.nx };
}

function createStrokeOutlinePath(
  outline: TVGStrokeOutline,
  profile: TVGThicknessProfile,
  fromTipType: TVGTipType = 'round',
  toTipType: TVGTipType = 'round',
): Path2D {
  const path = new Path2D();
  const { leftEdge, rightEdge, firstSample, lastSample, isClosed } = outline;
  path.moveTo(leftEdge[0].x, leftEdge[0].y);
  for (let i = 1; i < leftEdge.length; i++) {
    path.lineTo(leftEdge[i].x, leftEdge[i].y);
  }

  if (isClosed) {
    path.lineTo(rightEdge[rightEdge.length - 1].x, rightEdge[rightEdge.length - 1].y);
  } else if (lastSample && profile.points.length > 0) {
    const lastProfilePoint = profile.points[profile.points.length - 1];
    const tangent = tangentFromSample(lastSample);
    if (toTipType === 'square') {
      const leftCap = {
        x: leftEdge[leftEdge.length - 1].x + tangent.x * lastProfilePoint.leftOffset,
        y: leftEdge[leftEdge.length - 1].y + tangent.y * lastProfilePoint.leftOffset,
      };
      const rightCap = {
        x: rightEdge[rightEdge.length - 1].x + tangent.x * lastProfilePoint.rightOffset,
        y: rightEdge[rightEdge.length - 1].y + tangent.y * lastProfilePoint.rightOffset,
      };
      path.lineTo(leftCap.x, leftCap.y);
      path.lineTo(rightCap.x, rightCap.y);
      path.lineTo(rightEdge[rightEdge.length - 1].x, rightEdge[rightEdge.length - 1].y);
    } else if (toTipType === 'butt') {
      path.lineTo(rightEdge[rightEdge.length - 1].x, rightEdge[rightEdge.length - 1].y);
    } else {
      const tipTangentL = profile.tipTangentLeftTo ?? 1;
      const tipTangentR = profile.tipTangentRightTo ?? 1;
      const cp1x = leftEdge[leftEdge.length - 1].x + tangent.x * 1.33 * lastProfilePoint.leftOffset * tipTangentL;
      const cp1y = leftEdge[leftEdge.length - 1].y + tangent.y * 1.33 * lastProfilePoint.leftOffset * tipTangentL;
      const cp2x = rightEdge[rightEdge.length - 1].x + tangent.x * 1.33 * lastProfilePoint.rightOffset * tipTangentR;
      const cp2y = rightEdge[rightEdge.length - 1].y + tangent.y * 1.33 * lastProfilePoint.rightOffset * tipTangentR;
      path.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, rightEdge[rightEdge.length - 1].x, rightEdge[rightEdge.length - 1].y);
    }
  }

  for (let i = rightEdge.length - 2; i >= 0; i--) {
    path.lineTo(rightEdge[i].x, rightEdge[i].y);
  }

  if (!isClosed && firstSample && profile.points.length > 0) {
    const firstProfilePoint = profile.points[0];
    const tangent = tangentFromSample(firstSample);
    if (fromTipType === 'square') {
      const rightCap = {
        x: rightEdge[0].x - tangent.x * firstProfilePoint.rightOffset,
        y: rightEdge[0].y - tangent.y * firstProfilePoint.rightOffset,
      };
      const leftCap = {
        x: leftEdge[0].x - tangent.x * firstProfilePoint.leftOffset,
        y: leftEdge[0].y - tangent.y * firstProfilePoint.leftOffset,
      };
      path.lineTo(rightCap.x, rightCap.y);
      path.lineTo(leftCap.x, leftCap.y);
      path.lineTo(leftEdge[0].x, leftEdge[0].y);
    } else if (fromTipType === 'round') {
      const tipTangentL = profile.tipTangentLeftFrom ?? 1;
      const tipTangentR = profile.tipTangentRightFrom ?? 1;
      const cp1x = rightEdge[0].x - tangent.x * 1.33 * firstProfilePoint.rightOffset * tipTangentR;
      const cp1y = rightEdge[0].y - tangent.y * 1.33 * firstProfilePoint.rightOffset * tipTangentR;
      const cp2x = leftEdge[0].x - tangent.x * 1.33 * firstProfilePoint.leftOffset * tipTangentL;
      const cp2y = leftEdge[0].y - tangent.y * 1.33 * firstProfilePoint.leftOffset * tipTangentL;
      path.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, leftEdge[0].x, leftEdge[0].y);
    } else {
      path.lineTo(leftEdge[0].x, leftEdge[0].y);
    }
  }

  path.closePath();
  return path;
}

function createHalfRibbonPath(outline: TVGStrokeOutline, side: 'outer' | 'inner'): Path2D {
  const path = new Path2D();
  const edge = side === 'outer' ? outline.leftEdge : outline.rightEdge;
  path.moveTo(outline.centerlinePoints[0].x, outline.centerlinePoints[0].y);
  for (let i = 1; i < outline.centerlinePoints.length; i++) {
    path.lineTo(outline.centerlinePoints[i].x, outline.centerlinePoints[i].y);
  }
  for (let i = edge.length - 1; i >= 0; i--) {
    path.lineTo(edge[i].x, edge[i].y);
  }
  path.closePath();
  return path;
}

function renderStrokeOutlineWithPaints(
  ctx: CanvasRenderingContext2D,
  comp: TVGComponent,
  profile: TVGThicknessProfile,
  outerPaint: TVGPaint | null,
  innerPaint: TVGPaint | null,
  diagnostics?: TVGDiagnostics,
  allowFastPath = true,
): void {
  if (!comp.path) return;
  const fullPaint = outerPaint ?? innerPaint;
  if (!fullPaint) return;

  if (innerPaint && outerPaint && paintsEqual(innerPaint, outerPaint)) {
    innerPaint = null;
  }

  const uniformWidth = getUniformProfileWidth(profile);
  const canFastPath = allowFastPath
    && !innerPaint
    && outerPaint?.kind === 'solid'
    && uniformWidth !== null
    && uniformWidth >= 0.1
    && (isPathEffectivelyClosed(comp.path) || comp.fromTipType === comp.toTipType);
  if (canFastPath) {
    const path = buildPath2D(comp.path);
    ctx.strokeStyle = paintToCssColor(outerPaint);
    ctx.lineWidth = uniformWidth;
    ctx.lineCap = isPathEffectivelyClosed(comp.path) ? 'butt' : comp.fromTipType;
    ctx.lineJoin = comp.joinType;
    ctx.stroke(path);
    return;
  }

  const outline = buildStrokeOutline(comp.path, profile);
  if (!outline) return;
  const fullPath = createStrokeOutlinePath(outline, profile, comp.fromTipType, comp.toTipType);

  if (!innerPaint) {
    fillPathWithPaint(ctx, fullPath, fullPaint);
    return;
  }

  if (outerPaint?.kind === 'gradient' || innerPaint.kind === 'gradient') {
    if (diagnostics) {
      addDiagnostic(diagnostics, {
        severity: 'info',
        code: 'STROKE_GRADIENT_SIDE_FALLBACK',
        offset: 0,
        context: 'render',
        note: 'Rendered dual-sided stroke as a single outline because gradient side splitting is not supported.',
      });
    }
    fillPathWithPaint(ctx, fullPath, outerPaint ?? innerPaint);
    return;
  }

  fillPathWithPaint(ctx, createHalfRibbonPath(outline, 'outer'), outerPaint ?? innerPaint);
  fillPathWithPaint(ctx, createHalfRibbonPath(outline, 'inner'), innerPaint);
}

function renderStrokeComponent(
  ctx: CanvasRenderingContext2D,
  layer: TVGArtLayer,
  shape: TVGShape,
  comp: TVGComponent,
  defaultStrokeWidth: number,
  diagnostics?: TVGDiagnostics,
): void {
  if (!comp.path || comp.path.segments.length < 2) return;
  const xform = ctx.getTransform();
  const ctxScale = Math.hypot(xform.a, xform.b) || 1;
  const boundaryWidth = shouldRenderWidthlessBoundaryStroke(layer, shape, comp)
    ? Math.max(1.5, 4.0 / ctxScale)
    : undefined;
  if (comp.componentType === 2 && comp.strokeWidth === null && !comp.thicknessProfile && comp.tgtiThickness === null && boundaryWidth === undefined) {
    return;
  }
  const profile = resolveStrokeProfile(comp, defaultStrokeWidth, boundaryWidth);
  if (!profile) return;
  renderStrokeOutlineWithPaints(ctx, comp, profile, comp.outerPaint, comp.innerPaint, diagnostics);
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
      const xform = ctx.getTransform();
      const ctxScale = Math.hypot(xform.a, xform.b) || 1;
      const boundaryWidth = isWidthlessBoundaryStroke(comp)
        ? Math.max(1.5, 4.0 / ctxScale)
        : undefined;
      const profile = resolveStrokeProfile(comp, defaultStrokeWidth, boundaryWidth);
      if (!profile) continue;
      renderStrokeOutlineWithPaints(
        ctx,
        comp,
        profile,
        { kind: 'solid', rgba: { r: 255, g: 255, b: 255, a: 255 } },
        null,
        undefined,
        true,
      );
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
  while (segIdx < segs.length - 1 && segArcStarts[segIdx + 1] <= targetLen) segIdx++;

  const segStart = segArcStarts[segIdx];
  const segEnd = (segIdx + 1 < segArcStarts.length) ? segArcStarts[segIdx + 1] : totalArcLen;
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
function computeSegmentArcLengths(segs: TVGSegment[]): { arcStarts: number[]; totalLen: number } {
  const arcStarts: number[] = new Array(segs.length).fill(0);
  let cumLen = 0;

  for (let i = 1; i < segs.length; i++) {
    arcStarts[i] = cumLen;
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
      const steps = 16;
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
  }

  return { arcStarts, totalLen: cumLen };
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

/**
 * Check if a thickness profile is uniform (constant width).
 * Returns the constant lineWidth (left + right) if uniform, or null if variable.
 * A profile is "uniform" if the range of leftOffset and rightOffset values
 * (including control points) is less than 0.1.
 */
function getUniformProfileWidth(profile: TVGThicknessProfile): number | null {
  const pts = profile.points;
  if (pts.length === 0) return null;

  let minLeft = Infinity, maxLeft = -Infinity;
  let minRight = Infinity, maxRight = -Infinity;

  for (const pt of pts) {
    minLeft = Math.min(minLeft, pt.leftOffset, pt.leftCtrlFwd.y, pt.leftCtrlBack.y);
    maxLeft = Math.max(maxLeft, pt.leftOffset, pt.leftCtrlFwd.y, pt.leftCtrlBack.y);
    minRight = Math.min(minRight, pt.rightOffset, pt.rightCtrlFwd.y, pt.rightCtrlBack.y);
    maxRight = Math.max(maxRight, pt.rightOffset, pt.rightCtrlFwd.y, pt.rightCtrlBack.y);
  }

  if (maxLeft - minLeft < 0.1 && maxRight - minRight < 0.1) {
    // Uniform: total width = average left + average right
    const avgLeft = (minLeft + maxLeft) / 2;
    const avgRight = (minRight + maxRight) / 2;
    return avgLeft + avgRight;
  }
  return null;
}

/** Check if a path collapses to a point-sized bbox. Line fragments are still valid contour edges. */
function isDegenerate(path: TVGPath): boolean {
  if (path.segments.length <= 1) return true;
  const bounds = segmentBounds(path.segments);
  return (bounds.maxX - bounds.minX) < 0.01 && (bounds.maxY - bounds.minY) < 0.01;
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
