import pako from 'pako';

// ── Public Types ──

export interface TVGBitmapTile {
  clipX: number;
  clipY: number;
  clipW: number;
  clipH: number;
  cellX?: number;
  cellY?: number;
  cellW?: number;
  cellH?: number;
  bitmapDepth?: number;
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
  textLabels?: TVGTextLabel[];
}

export interface TVGShape {
  shapeType: number; // 2=fill, 3=stroke, 6=line
  components: TVGComponent[];
  nodePosition?: number | null;
}

export interface TVGTextLabel {
  text: string;
  fontFamily: string;
  fontSize: number;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  matrixB?: number;
  matrixC?: number;
  styleToken?: number;
  color?: { r: number; g: number; b: number; a: number } | null;
}

export interface TVGTextLabelRenderLayout {
  transform: { a: number; b: number; c: number; d: number; e: number; f: number };
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  font: string;
  lines: string[];
  lineHeight: number;
  baseY: number;
  hasOffDiagonalTransform: boolean;
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
  contourColorId: bigint | null;
  /** Inside color ID from second TGCO entry (usually 0xFFFFFFFFFFFFFFFF = null). */
  insideColorId: bigint | null;
  paletteIndex: number | null; // Palette position index for fills without TGCO
  color: { r: number; g: number; b: number; a: number } | null;
  contourColor: { r: number; g: number; b: number; a: number } | null;
  fillPaintSource: 'explicit' | 'inherited' | 'default' | 'synthetic' | null;
  /** Resolved inside color for two-sided strokes (inner side fill contribution). */
  insideColor: { r: number; g: number; b: number; a: number } | null;
  transform: TVGTransform | null;
  contourTransform: TVGTransform | null;
  path: TVGPath | null;
  strokeWidth: number | null;
  thicknessProfile: TVGThicknessProfile | null;
  joinType: TVGJoinType; // Stroke join type (default: 'round')
  fromTipType: TVGTipType; // Start cap type (default: 'round')
  toTipType: TVGTipType; // End cap type (default: 'round')
  gradientType?: 'linear' | 'radial';
  gradientStops?: { pos: number; r: number; g: number; b: number; a: number }[];
  contourGradientType?: 'linear' | 'radial';
  contourGradientStops?: { pos: number; r: number; g: number; b: number; a: number }[];
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
  contourPaint: TVGPaint | null;
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
  backgroundComposite: boolean;
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

  get length(): number {
    return this.bytes.length;
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

  slice(start: number, end: number): Uint8Array {
    return this.bytes.slice(start, end);
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
const TAG_TGND = 'TGND';
const TAG_TGTL = 'TGTL';
const TAG_TGSD = 'TGSD';
const TAG_TGBP = 'TGBP';
const TAG_TGCO = 'TGCO';
const TAG_TGRV = 'TGRV';
const TAG_TCSC = 'TCSC';
const TAG_TCID = 'TCID';
const TAG_TGBG = 'TGBG';
const TAG_TBBM = 'TBBM';

const TOP_LEVEL_TAGS = new Set([
  TAG_CERT, TAG_ENDT, TAG_TVCI, TAG_CREA, TAG_TTOC, TAG_SIGN, TAG_TGBG, TAG_TBBM, TAG_TPAL, 'TLAB',
  TAG_UNCO, TAG_ZLIB,
]);

const MAIN_DATA_TAGS = new Set([
  TAG_ENDT, TAG_TVCI, TAG_CREA, TAG_TTOC, TAG_SIGN, TAG_TGBG, TAG_TBBM, TAG_TPAL, TAG_TGRV, 'TLAB', 'AUIF',
  TAG_tUAA, TAG_tCAA, TAG_tLAA, TAG_tOAA, TAG_UNCO, TAG_ZLIB,
]);

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
            const payloadStart = reader.pos;
            const recoverableSign = findRecoverableSignatureWithinWindow(reader, payloadStart, payloadStart + len);
            if (recoverableSign) {
              reader.pos = recoverableSign.signOffset;
            } else {
              reader.skip(len);
            }
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
      scanToKnownTagWithin(reader, TOP_LEVEL_TAGS, 8);
    } else if (tag === TAG_TGBG) {
      const tagOffset = reader.pos - 4;
      const tgbgData = readRecoverableInnerTagPayload(reader, tag, drawing.diagnostics, 'bitmap', tagOffset);
      if (tgbgData && tgbgData.length > 0) {
        parseTGBGTiles(tgbgData, drawing.bitmapTiles);
      }
    } else if (tag === TAG_TBBM) {
      const tagOffset = reader.pos - 4;
      const inner = readInnerTagLengthAt(reader, reader.pos);
      if (inner && inner.payloadStart + inner.len <= reader.length) {
        reader.pos = inner.payloadStart + inner.len;
        parseTGBGTiles(reader.slice(tagOffset, reader.pos), drawing.bitmapTiles);
        scanToKnownTagWithin(reader, TOP_LEVEL_TAGS, 8);
      } else {
        addDiagnostic(drawing.diagnostics, {
          severity: 'warn',
          code: 'TRUNCATED_CHUNK',
          tag,
          offset: tagOffset,
          length: inner?.len,
          context: 'bitmap',
        });
        break;
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

  // Bitmap-only TVGs commonly store TBBM blocks directly at top level. If
  // direct parsing still leaves residual top-level noise, merge the raw scan
  // so a stray padding/CRC byte cannot silently drop later tiles.
  const topLevelUnknownCount = drawing.diagnostics.counts.UNKNOWN_TOP_LEVEL_TAG ?? 0;
  const bitmapParseNeedsRepair = drawing.layers.length === 0
    && (
      drawing.bitmapTiles.length === 0
      || topLevelUnknownCount > 1
      || (drawing.diagnostics.counts.TRUNCATED_CHUNK ?? 0) > 0
    );
  if (bitmapParseNeedsRepair) {
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
        if (comp.contourColorId !== null) {
          const entry = paletteMap.get(comp.contourColorId);
          if (entry) {
            comp.contourColor = { r: entry.r, g: entry.g, b: entry.b, a: entry.a };
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
      suppressUnderlayMaskPaletteHintFillColors(layer, shape, paletteMap);

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

  resolveTextLabelPaletteColors(drawing);

  return drawing;
}

// ── Encoded Data Reading ──

/** Scan forward to find the next recognized top-level tag or null+UNCO/ZLIB pattern. */
function scanToNextTopLevelTag(reader: BinaryReader): boolean {
  while (reader.remaining >= 4) {
    const peek = reader.peekTag4();
    if (peek === '\0\0\0\0' || TOP_LEVEL_TAGS.has(peek)) {
      return true;
    }
    reader.skip(1);
  }
  return false;
}

function scanToKnownTagWithin(
  reader: BinaryReader,
  knownTags: Set<string>,
  maxLookahead: number,
): boolean {
  const savedPos = reader.pos;
  for (let skipped = 0; skipped <= maxLookahead && reader.remaining >= 4; skipped++) {
    const peek = reader.peekTag4();
    if (peek === '\0\0\0\0' || knownTags.has(peek)) {
      return true;
    }
    reader.skip(1);
  }
  reader.pos = savedPos;
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
  const lenBytes = (type >> 1) & 0x03;
  if (lenBytes === 0) return reader.readU8();
  if (lenBytes === 1) return reader.readU16LE();
  if (lenBytes === 2 || lenBytes === 3) {
    const lo = reader.readU16LE();
    const hi = reader.readU8();
    return lo | (hi << 16);
  }
  return -1;
}

function readInnerTagLengthAt(
  reader: BinaryReader,
  pos: number,
): { len: number; payloadStart: number } | null {
  const savedPos = reader.pos;
  try {
    reader.pos = pos;
    const len = readInnerTagLength(reader);
    return len >= 0 ? { len, payloadStart: reader.pos } : null;
  } catch (_e) {
    return null;
  } finally {
    reader.pos = savedPos;
  }
}

function findRecoverableSignatureWithinWindow(
  reader: BinaryReader,
  payloadStart: number,
  payloadEnd: number,
): { signOffset: number; payloadStart: number; payloadLen: number } | null {
  let searchPos = payloadStart;
  while (searchPos >= payloadStart && searchPos < payloadEnd) {
    const signOffset = reader.findTag4(TAG_SIGN, searchPos);
    if (signOffset < payloadStart || signOffset >= payloadEnd) return null;
    const inner = readInnerTagLengthAt(reader, signOffset + 4);
    if (inner) {
      const signaturePayloadEnd = inner.payloadStart + inner.len;
      if (reader.findTag4(TAG_ENDT, signaturePayloadEnd) === signaturePayloadEnd) {
        return { signOffset, payloadStart: inner.payloadStart, payloadLen: inner.len };
      }
    }
    searchPos = signOffset + 1;
  }
  return null;
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
  const payloadStart = reader.pos;
  const len = reader.readU32LE();
  if (len >= 0 && len <= reader.remaining) {
    reader.skip(len);
    return;
  }

  reader.pos = payloadStart;
  const inner = readInnerTagLengthAt(reader, payloadStart);
  if (inner) {
    const signaturePayloadEnd = inner.payloadStart + inner.len;
    if (reader.findTag4(TAG_ENDT, signaturePayloadEnd) === signaturePayloadEnd) {
      reader.pos = signaturePayloadEnd;
      return;
    }
  }

  reader.pos = payloadStart;
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

function readInt32Rect(
  data: Uint8Array,
  start: number,
): { x: number; y: number; w: number; h: number } {
  const dv = new DataView(data.buffer, data.byteOffset + start, 16);
  return {
    x: dv.getInt32(0, true),
    y: dv.getInt32(4, true),
    w: dv.getInt32(8, true),
    h: dv.getInt32(12, true),
  };
}

function collectTBBHTileMetadata(
  data: Uint8Array,
  start: number,
  end: number,
): {
  clipX: number;
  clipY: number;
  clipW: number;
  clipH: number;
  cellX?: number;
  cellY?: number;
  cellW?: number;
  cellH?: number;
  bitmapDepth?: number;
} | null {
  let clipX = 0, clipY = 0, clipW = 0, clipH = 0;
  let cellX: number | undefined;
  let cellY: number | undefined;
  let cellW: number | undefined;
  let cellH: number | undefined;
  let bitmapDepth: number | undefined;

  const applyTag = (tag: string, contentStart: number, contentLen: number) => {
    if (tag === 'TBBD' && contentLen >= 4) {
      const dv = new DataView(data.buffer, data.byteOffset + contentStart, 4);
      bitmapDepth = dv.getInt32(0, true);
      return;
    }
    if (tag === 'TBBC' && contentLen >= 16) {
      const rect = readInt32Rect(data, contentStart);
      cellX = rect.x;
      cellY = rect.y;
      cellW = rect.w;
      cellH = rect.h;
      return;
    }
    if (tag === 'TBBA' && contentLen >= 16) {
      const rect = readInt32Rect(data, contentStart);
      clipX = rect.x;
      clipY = rect.y;
      clipW = rect.w;
      clipH = rect.h;
    }
  };

  for (let j = start; j < end - 5; j++) {
    const tag = String.fromCharCode(data[j], data[j + 1], data[j + 2], data[j + 3]);
    if (!/^TBB[A-Z]$/.test(tag)) continue;
    const child = readInnerTagAt(data, j);
    if (!child) continue;
    const childEnd = Math.min(child.contentStart + child.contentLen, end);
    if (tag === 'TBBH') {
      for (let k = child.contentStart; k < childEnd - 5; k++) {
        const nestedTag = String.fromCharCode(data[k], data[k + 1], data[k + 2], data[k + 3]);
        if (!/^TBB[A-Z]$/.test(nestedTag)) continue;
        const nested = readInnerTagAt(data, k);
        if (!nested || nested.contentStart + nested.contentLen > childEnd) continue;
        applyTag(nestedTag, nested.contentStart, nested.contentLen);
        k = nested.contentStart + nested.contentLen - 1;
      }
    } else {
      applyTag(tag, child.contentStart, child.contentLen);
    }
    j = childEnd - 1;
  }

  if (clipW <= 0 || clipH <= 0) return null;
  return {
    clipX,
    clipY,
    clipW,
    clipH,
    cellX,
    cellY,
    cellW,
    cellH,
    bitmapDepth,
  };
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
    const tileMeta = collectTBBHTileMetadata(data, tbbm.contentStart, Math.min(tEnd, data.length));

    // Find PNG in this TBBM
    const png = findPNG(data, tbbm.contentStart, tEnd, data.length);
    // Sparse bitmap atlases can contain valid tiny PNG tiles, especially when
    // a tile only carries a few opaque pixels. Reject only obviously broken payloads.
    if (png && png.end - png.start > 32 && tileMeta) {
      tiles.push({
        ...tileMeta,
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
    const key = [
      tile.clipX,
      tile.clipY,
      tile.clipW,
      tile.clipH,
      tile.cellX ?? '',
      tile.cellY ?? '',
      tile.cellW ?? '',
      tile.cellH ?? '',
      tile.bitmapDepth ?? '',
      tile.pngData.length,
      hashBitmapTileData(tile.pngData),
    ].join(':');
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
        if (layer.shapes.length > 0 || (layer.textLabels?.length ?? 0) > 0) {
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
    } else if (tag === TAG_TBBM) {
      try {
        const inner = readInnerTagLengthAt(reader, reader.pos);
        if (inner && inner.payloadStart + inner.len <= reader.length) {
          reader.pos = inner.payloadStart + inner.len;
          parseTGBGTiles(reader.slice(tagOffset, reader.pos), drawing.bitmapTiles);
          scanToKnownTagWithin(reader, MAIN_DATA_TAGS, 8);
        }
      } catch (_e) {
        addDiagnostic(drawing.diagnostics, {
          severity: 'warn',
          code: 'UNKNOWN_MAIN_DATA_TAG',
          tag,
          offset: tagOffset,
          context: 'bitmap',
          note: 'Failed to parse TBBM tile payload',
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
      scanToKnownTagWithin(reader, MAIN_DATA_TAGS, 8);
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

const utf16LeDecoder = new TextDecoder('utf-16le');
const utf16BeDecoder = new TextDecoder('utf-16be');

function isPlausibleTGTLString(value: string): boolean {
  const normalized = value.replace(/\0/g, '').trim();
  if (normalized.length === 0 || normalized.length > 96) return false;
  return /^[\p{L}\p{N}\s,./&+_\-:\r]+$/u.test(normalized);
}

function sanitizeTGTLString(value: string): string {
  const sanitized = value
    .replace(/\0/g, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}\s,./&+_\-:\r]+$/u, '')
    .trim();
  const asciiRuns = sanitized.match(/[A-Za-z0-9][A-Za-z0-9 ,./&+_\-:\r]*/g);
  if (asciiRuns && asciiRuns.length > 0) {
    return asciiRuns.sort((a, b) => b.length - a.length)[0].trim();
  }
  return sanitized;
}

function scoreTGTLStringCandidate(value: string): number {
  if (!isPlausibleTGTLString(value)) return Number.NEGATIVE_INFINITY;
  const basicAsciiChars = value.match(/[A-Za-z0-9 ,./&+_\-:\r]/g)?.length ?? 0;
  const latinChars = value.match(/[\p{Script=Latin}]/gu)?.length ?? 0;
  const cjkChars = value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0;
  if (basicAsciiChars === 0 && cjkChars === 0) return Number.NEGATIVE_INFINITY;
  return value.length + basicAsciiChars * 6 + Math.max(0, latinChars - basicAsciiChars) - cjkChars * 6;
}

function extractLengthPrefixedUTF16Strings(data: Uint8Array): Array<{ offset: number; start: number; value: string }> {
  const strings: Array<{ offset: number; start: number; value: string }> = [];
  for (let offset = 0; offset <= data.length - 4; offset++) {
    const charLen = data[offset] | (data[offset + 1] << 8);
    if (charLen <= 0 || charLen > 96) continue;
    let best: string | null = null;
    let bestStart = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestEnd = -1;
    for (const start of [offset + 2, offset + 4, offset + 6, offset + 8]) {
      const end = start + charLen * 2;
      if (end > data.length) continue;
      const slice = data.slice(start, end);
      for (const decoded of [
        sanitizeTGTLString(utf16LeDecoder.decode(slice)),
        sanitizeTGTLString(utf16BeDecoder.decode(slice)),
      ]) {
        const score = scoreTGTLStringCandidate(decoded);
        if (score <= bestScore) continue;
        best = decoded;
        bestStart = start;
        bestScore = score;
        bestEnd = end;
      }
    }
    if (!best) continue;
    const previous = strings[strings.length - 1];
    if (!previous || previous.offset !== offset || previous.start !== bestStart || previous.value !== best) {
      strings.push({ offset, start: bestStart, value: best });
    }
    offset = Math.max(offset, bestEnd - 1);
  }
  return strings;
}

function extractTGTLStyleToken(data: Uint8Array, entry: { start: number } | null | undefined): number | undefined {
  if (!entry || entry.start < 8) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const fontNameCharCount = view.getUint32(entry.start - 4, true);
  if (fontNameCharCount <= 0 || fontNameCharCount > 96) return undefined;
  return view.getUint32(entry.start - 8, true);
}

function parseTGTLTextLabel(data: Uint8Array): TVGTextLabel | null {
  const strings = extractLengthPrefixedUTF16Strings(data);
  if (strings.length === 0) return null;
  const candidates = strings
    .map(entry => ({ ...entry, score: scoreTGTLStringCandidate(entry.value) }))
    .filter(entry => Number.isFinite(entry.score));
  const textEntry = candidates
    .filter(entry => !/arial/i.test(entry.value))
    .sort((a, b) => b.score - a.score || b.value.length - a.value.length)[0];
  const text = textEntry?.value;
  if (!text) return null;
  const fontEntry = candidates
    .filter(entry => /arial/i.test(entry.value))
    .sort((a, b) => b.score - a.score || b.value.length - a.value.length)[0]
    ?? candidates[1]
    ?? null;
  const fontFamily = fontEntry?.value ?? 'Arial';
  const normalizedFontFamily = /^rial$/i.test(fontFamily) ? 'Arial' : fontFamily;
  const styleToken = extractTGTLStyleToken(data, fontEntry);

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let fontSize = 5;
  let scaleX = 1;
  let matrixB = 0;
  let matrixC = 0;
  let scaleY = 1;
  let x = 0;
  let y = 0;

  for (let offset = data.length - 32; offset >= 76; offset--) {
    const boundA = view.getFloat64(offset, true);
    const boundB = view.getFloat64(offset + 24, true);
    if (!Number.isFinite(boundA) || !Number.isFinite(boundB)) continue;
    if (Math.abs(boundA - 2500) > 0.01 || Math.abs(boundB - 2500) > 0.01) continue;
    const maybeY = view.getFloat64(offset - 8, true);
    const maybeX = view.getFloat64(offset - 16, true);
    const maybeMatrixD = view.getFloat64(offset - 24, true);
    const maybeMatrixC = view.getFloat64(offset - 32, true);
    const maybeMatrixB = view.getFloat64(offset - 40, true);
    const maybeScaleX = view.getFloat64(offset - 48, true);
    const maybeFontSize = view.getFloat64(offset - 76, true);
    if (![maybeFontSize, maybeScaleX, maybeMatrixB, maybeMatrixC, maybeMatrixD, maybeX, maybeY].every(Number.isFinite)) continue;
    fontSize = maybeFontSize / 4;
    scaleX = maybeScaleX;
    matrixB = maybeMatrixB;
    matrixC = maybeMatrixC;
    scaleY = maybeMatrixD;
    x = maybeX;
    y = maybeY;
    break;
  }

  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    text,
    fontFamily: normalizedFontFamily,
    fontSize: Math.max(4, fontSize),
    x,
    y,
    scaleX: Number.isFinite(scaleX) ? scaleX : 1,
    scaleY: Number.isFinite(scaleY) ? scaleY : 1,
    matrixB: Number.isFinite(matrixB) ? matrixB : 0,
    matrixC: Number.isFinite(matrixC) ? matrixC : 0,
    styleToken,
    color: null,
  };
}

function parseTrailingTextLabels(reader: BinaryReader): TVGTextLabel[] {
  const labels: TVGTextLabel[] = [];
  const tgndPos = reader.findTag4(TAG_TGND, reader.pos);
  if (tgndPos < 0) return labels;
  reader.pos = tgndPos + 4;
  if (reader.remaining < 4) return labels;
  const tgndLen = reader.readU32LE();
  const tgndEnd = reader.pos + Math.min(tgndLen, reader.remaining);
  let cursor = reader.pos;
  while (cursor + 8 <= tgndEnd) {
    const next = reader.findTag4(TAG_TGTL, cursor);
    if (next < 0 || next + 8 > tgndEnd) break;
    reader.pos = next + 4;
    const labelLen = reader.readU32LE();
    if (labelLen <= 0 || labelLen > tgndEnd - reader.pos) break;
    const payload = reader.readBytes(labelLen);
    const label = parseTGTLTextLabel(payload);
    if (label) labels.push(label);
    cursor = reader.pos;
  }
  return labels;
}

function parseArtLayer(reader: BinaryReader, type: TVGArtLayer['type'], diagnostics?: TVGDiagnostics): TVGArtLayer {
  const layer: TVGArtLayer = { type, shapes: [], textLabels: [] };

  if (reader.remaining < 6) return layer;

  // Preamble
  const dataType = reader.readU16LE();
  if (dataType === 0x0000) {
    layer.textLabels = parseTrailingTextLabels(reader);
    return layer;
  }

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

  layer.textLabels = parseTrailingTextLabels(reader);
  borrowMissingPencilPaths(layer);
  repairForwardPencilPathRefs(layer);

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

interface LayerFillPathRef {
  shapeIndex: number;
  componentIndex: number;
  comp: TVGComponent;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

const PENCIL_PATH_REF_MAX_SHAPE_DIAGONAL = 130;
const PENCIL_PATH_REF_MAX_CLOSED_OVERLAY_DIAGONAL = 90;
const PENCIL_PATH_REF_MIN_SHAPE_OVERLAP = 0.05;
const PENCIL_PATH_REF_MAX_CENTER_DISTANCE_RATIO = 0.65;

function boundsArea(bounds: { minX: number; minY: number; maxX: number; maxY: number }): number {
  return Math.max(0, bounds.maxX - bounds.minX) * Math.max(0, bounds.maxY - bounds.minY);
}

function boundsDiagonal(bounds: { minX: number; minY: number; maxX: number; maxY: number }): number {
  return Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
}

function boundsCenter(bounds: { minX: number; minY: number; maxX: number; maxY: number }): { x: number; y: number } {
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  };
}

function boundsOverlapRatio(
  a: { minX: number; minY: number; maxX: number; maxY: number },
  b: { minX: number; minY: number; maxX: number; maxY: number },
): number {
  const overlapW = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const overlapH = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
  const denominator = Math.max(1, Math.min(boundsArea(a), boundsArea(b)));
  return (overlapW * overlapH) / denominator;
}

function componentPathBounds(comp: TVGComponent): { minX: number; minY: number; maxX: number; maxY: number } | null {
  return comp.path && comp.path.segments.length > 0 ? segmentBounds(comp.path.segments) : null;
}

function componentBounds(
  components: TVGComponent[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const comp of components) {
    const bounds = componentPathBounds(comp);
    if (!bounds) continue;
    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
  }
  return isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

function collectLayerFillPathRefs(layer: TVGArtLayer): LayerFillPathRef[] {
  const refs: LayerFillPathRef[] = [];
  layer.shapes.forEach((shape, shapeIndex) => {
    shape.components.forEach((comp, componentIndex) => {
      if (comp.componentType !== 0 || !comp.path || comp.path.segments.length === 0) return;
      const bounds = componentPathBounds(comp);
      if (!bounds || boundsArea(bounds) <= 0.01) return;
      refs.push({ shapeIndex, componentIndex, comp, bounds });
    });
  });
  return refs;
}

function pencilComponentsFormClosedChain(components: TVGComponent[], tolerance = 2): boolean {
  const endpoints = components
    .map((comp, index) => {
      if (comp.componentType !== 4 || !comp.path) return null;
      const pair = pathEndpointPair(comp.path);
      if (!pair) return null;
      return { index, start: pair.start, end: pair.end };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (endpoints.length === 0) return false;

  const used = new Set<number>([0]);
  const start = endpoints[0].start;
  let end = endpoints[0].end;
  while (used.size < endpoints.length) {
    let nextIndex = -1;
    let reversed = false;
    for (let i = 0; i < endpoints.length; i++) {
      if (used.has(i)) continue;
      if (pointsNearlyEqual(end, endpoints[i].start, tolerance)) {
        nextIndex = i;
        break;
      }
      if (pointsNearlyEqual(end, endpoints[i].end, tolerance)) {
        nextIndex = i;
        reversed = true;
        break;
      }
    }
    if (nextIndex < 0) return false;
    used.add(nextIndex);
    end = reversed ? endpoints[nextIndex].start : endpoints[nextIndex].end;
  }
  return pointsNearlyEqual(start, end, tolerance);
}

function shouldUseForwardPencilPathRef(
  shapeIndex: number,
  comp: TVGComponent,
  target: LayerFillPathRef,
  currentBounds: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
  if (target.shapeIndex !== shapeIndex + 1) return false;
  const targetBounds = target.bounds;
  const shapeDiagonal = boundsDiagonal(currentBounds);
  if (shapeDiagonal <= 0 || shapeDiagonal > PENCIL_PATH_REF_MAX_SHAPE_DIAGONAL) return false;
  if (boundsOverlapRatio(currentBounds, targetBounds) < PENCIL_PATH_REF_MIN_SHAPE_OVERLAP) return false;
  const compBounds = componentPathBounds(comp);
  if (!compBounds) return false;
  const compCenter = boundsCenter(compBounds);
  const targetCenter = boundsCenter(targetBounds);
  const centerDistanceRatio = Math.hypot(compCenter.x - targetCenter.x, compCenter.y - targetCenter.y) / shapeDiagonal;
  return centerDistanceRatio < PENCIL_PATH_REF_MAX_CENTER_DISTANCE_RATIO;
}

function repairForwardPencilPathRefs(layer: TVGArtLayer): void {
  if (layer.type !== 'line' && layer.type !== 'overlay') return;
  const fillRefs = collectLayerFillPathRefs(layer);
  if (fillRefs.length === 0) return;

  layer.shapes.forEach((shape, shapeIndex) => {
    if (shape.shapeType !== 5) return;
    const pencils = shape.components.filter(comp =>
      comp.componentType === 4 && comp.path && comp.path.segments.length > 0,
    );
    if (pencils.length === 0) return;

    const currentBounds = componentBounds(pencils);
    if (!currentBounds) return;
    const isClosedChain = pencilComponentsFormClosedChain(pencils);
    const isSmallClosedOverlay = layer.type === 'overlay'
      && isClosedChain
      && boundsDiagonal(currentBounds) <= PENCIL_PATH_REF_MAX_CLOSED_OVERLAY_DIAGONAL;
    if (layer.type === 'line' && isClosedChain) return;
    if (layer.type === 'overlay' && !isSmallClosedOverlay) return;

    for (const comp of pencils) {
      if (comp.pathRefHint === null) continue;
      const target = fillRefs[comp.pathRefHint - 1];
      if (!target) continue;
      if (isSmallClosedOverlay) {
        if (target.shapeIndex !== shapeIndex + 1) continue;
      } else if (!shouldUseForwardPencilPathRef(shapeIndex, comp, target, currentBounds)) {
        continue;
      }
      comp.path = target.comp.path;
    }
  });
}

export function __repairForwardPencilPathRefsForTests(layer: TVGArtLayer): void {
  repairForwardPencilPathRefs(layer);
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
    contourColorId: null,
    insideColorId: null,
    paletteIndex: null,
    color: null,
    contourColor: null,
    fillPaintSource: null,
    insideColor: null,
    transform: null,
    contourTransform: null,
    path: null,
    strokeWidth: null,
    thicknessProfile: null,
    joinType: 'round',
    fromTipType: 'round',
    toTipType: 'round',
    contourGradientType: undefined,
    contourGradientStops: undefined,
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
    contourPaint: null,
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
    // Type-4 contour component: keep the inline stroke color, but also capture
    // any embedded TGCO fill paint used for contour-based fill recovery.
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
      scanAndParseTGCO(reader, comp, sdEnd, 'contour');
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
function scanAndParseTGCO(
  reader: BinaryReader,
  comp: TVGComponent,
  endPos: number,
  target: 'stroke' | 'contour' = 'stroke',
): boolean {
  const scanStart = reader.pos;
  while (reader.pos < endPos - 8) {
    if (reader.peekTag4() === TAG_TGCO) {
      reader.skip(4); // consume TGCO tag
      const coLen = reader.readU32LE();
      const coEnd = reader.pos + coLen;
      if (coEnd <= endPos) {
        parseTGCO(reader, comp, coLen, target);
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

function parseTGCO(
  reader: BinaryReader,
  comp: TVGComponent,
  len: number,
  target: 'stroke' | 'contour' = 'stroke',
): void {
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

  if (target === 'contour') {
    comp.contourTransform = { a, b, c, d, tx, ty };
  } else {
    comp.transform = { a, b, c, d, tx, ty };
  }

  // Read colorId from remaining bytes (8-byte UID after the 49-byte header+transform).
  // This is the authoritative source for both fills and strokes when TGCO is present.
  if (len >= 57) {
    const colorId = reader.readU64LE();
    if (target === 'contour') {
      if (comp.contourColorId === null) comp.contourColorId = colorId;
    } else if (comp.colorId === null) {
      comp.colorId = colorId;
    }
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

/** Decode a tip (cap) type byte: 0=FLAT, 1=ROUND, 2=BEVEL */
function decodeTipType(b: number): TVGTipType {
  switch (b) {
    case 0: return 'butt';   // FLAT_TIP
    case 1: return 'round';  // ROUND_TIP
    case 2: return 'square'; // BEVEL_TIP
    default: return 'round';
  }
}

export function __decodeTipTypeForTests(b: number): TVGTipType {
  return decodeTipType(b);
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
  comp.contourPaint = buildPaint(
    comp.contourColor,
    comp.contourGradientType,
    comp.contourGradientStops,
    comp.contourTransform,
  );
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
  const applyExtContourColor = (comp: TVGComponent, ext: ExternalPaletteColor) => {
    comp.contourColor = { r: ext.r, g: ext.g, b: ext.b, a: ext.a };
    if (ext.gradientType && ext.stops && ext.stops.length > 0) {
      comp.contourGradientType = ext.gradientType;
      comp.contourGradientStops = ext.stops;
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
        if (comp.contourColorId !== null) {
          const ext = extMap.get(comp.contourColorId);
          if (ext) {
            applyExtContourColor(comp, ext);
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
  resolveTextLabelPaletteColors(drawing);
}

function resolveTextLabelPaletteColors(drawing: TVGDrawing): void {
  const byStyleToken = new Map<number, { r: number; g: number; b: number; a: number }>();
  for (const entry of drawing.palette) {
    if (entry.id === 0n) continue;
    const styleToken = Number((entry.id >> 32n) & 0xffffffffn);
    if (byStyleToken.has(styleToken)) continue;
    byStyleToken.set(styleToken, { r: entry.r, g: entry.g, b: entry.b, a: entry.a });
  }

  for (const layer of drawing.layers) {
    for (const label of layer.textLabels ?? []) {
      label.color = label.styleToken !== undefined
        ? (byStyleToken.get(label.styleToken) ?? null)
        : null;
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
  /** Experimental: bypass dense line-fill post-processing in local score probes. */
  disableDenseLineFillAdjustment?: boolean;
  /** Experimental: choose when white background is composited relative to downsampling/dense post-processing. */
  backgroundCompositeTiming?: 'pre-downsample' | 'post-downsample-before-dense' | 'post-downsample-after-dense';
}

const DENSE_LINE_FILL_INK_DENSITY_LUMA_LIMIT = 220;
const DENSE_LINE_FILL_INK_DENSITY_SUBTRACT = 32;
const DENSE_LINE_FILL_SATURATED_FILL_MIN_CHROMA = 80;
const DENSE_LINE_FILL_SATURATED_FILL_MIN_LUMA = 96;
const DENSE_LINE_FILL_SATURATED_FILL_INK_DENSITY_SUBTRACT = 24;
const DENSE_LINE_FILL_TONE_PIVOT = 96;
const DENSE_LINE_FILL_TONE_CONTRAST = 0.9024;
const DENSE_LINE_FILL_TONE_OFFSET = -4;
const DENSE_LINE_FILL_BACKGROUND_TOLERANCE = 12;
const DENSE_LINE_FILL_EDGE_ALPHA_SCALE = 1.1;
const DENSE_LINE_FILL_EXTERIOR_EDGE_EXPANSION_SCALE = 0.9;
const DENSE_LINE_FILL_EDGE_MIN_FRACTIONAL_ALPHA_PIXELS = 900;
const DENSE_LINE_FILL_EDGE_EXPANSION_MAX_FRACTIONAL_ALPHA_PIXELS = 1000;
const DENSE_LINE_FILL_EDGE_TONE_MIN_FRACTIONAL_ALPHA_PIXELS = 1500;
const DENSE_LINE_FILL_EDGE_TONE_SUBTRACT = 32;
const DENSE_LINE_FILL_INTERIOR_SHADOW_LUMA_LIMIT = 96;
const DENSE_LINE_FILL_INTERIOR_SHADOW_LIFT = { r: 8, g: 40, b: 40 };
const LINE_FILL_BOUNDS_ONLY_MIN_OUTLIER_SIZE = 1500;
const LINE_FILL_BOUNDS_ONLY_MIN_OUTLIER_DISTANCE = 2500;
const BITMAP_ATLAS_EDGE_TONE_BASE_SUBTRACT = 8;
const BITMAP_ATLAS_EDGE_TONE_FOREGROUND_SUBTRACT = 32;
const BITMAP_ATLAS_EDGE_TONE_BACKGROUND_THRESHOLD = 243;
const BITMAP_ATLAS_EDGE_TONE_MIN_ALPHA = 32;
const BITMAP_ATLAS_EDGE_TONE_MAX_ALPHA = 223;
const BITMAP_ATLAS_EDGE_TONE_MIN_PIXELS = 400;
const BITMAP_ATLAS_EDGE_TONE_WIDE_ASPECT_MIN = 1.6;
const BITMAP_ATLAS_EDGE_TONE_MULTI_TILE_MIN = 16;
const BITMAP_ATLAS_EDGE_TONE_MAX_TILES = 32;
const TVG_VIEWPORT_CONTENT_PADDING = 227;
const TVG_COMPACT_CUTOUT_VIEWPORT_CONTENT_PADDING = 220;
const TVG_COMPACT_CUTOUT_MAX_UNDERLAY_EXTENT = 220;
const TVG_TINY_VECTOR_VIEWPORT_FLOOR = 280;
const TVG_TINY_VECTOR_MAX_CONTENT_EXTENT = 96;
const TVG_TINY_VECTOR_MAX_SHAPES = 2;
const TVG_TINY_VECTOR_MAX_COMPONENTS = 8;

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

function shouldApplyDenseLineFillInkDensityAdjustment(
  drawing: TVGDrawing,
  options?: TVGRenderOptions,
): boolean {
  if (options?.disableDenseLineFillAdjustment) return false;
  if (options?.skipBackgroundComposite || options?.skipClipping || options?.centerOnOrigin) return false;
  if (options?.artLayerFilter && options.artLayerFilter !== 'all') return false;
  return shouldInsetViewportForLineFillDrawing(drawing);
}

function unionShapeBounds(shapes: TVGShape[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const shape of shapes) {
    const bounds = computeShapeBounds(shape);
    if (!bounds) continue;
    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
  }

  return Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY)
    ? { minX, minY, maxX, maxY }
    : null;
}

function shouldUseCompactCutoutViewportPadding(
  drawing: TVGDrawing,
  options?: TVGRenderOptions,
): boolean {
  if (options?.artLayerFilter || options?.centerOnOrigin || options?.skipBackgroundComposite || options?.skipClipping) {
    return false;
  }

  const visibleLayers = drawing.layers.filter(layer => layer.shapes.length > 0);
  const underlayLayers = visibleLayers.filter(layer => layer.type === 'underlay');
  if (underlayLayers.length === 0) return false;
  if (!visibleLayers.some(layer => layer.type === 'color')) return false;

  const shapeCount = visibleLayers.reduce((sum, layer) => sum + layer.shapes.length, 0);
  if (shapeCount === 0 || shapeCount > 5) return false;

  const componentCount = visibleLayers.reduce(
    (sum, layer) => sum + layer.shapes.reduce((shapeSum, shape) => shapeSum + shape.components.length, 0),
    0,
  );
  if (componentCount === 0 || componentCount > 48) return false;

  const underlayBounds = unionShapeBounds(underlayLayers.flatMap(layer => layer.shapes));
  if (!underlayBounds) return false;
  const underlayWidth = underlayBounds.maxX - underlayBounds.minX;
  const underlayHeight = underlayBounds.maxY - underlayBounds.minY;
  if (underlayWidth <= 0 || underlayHeight <= 0) return false;
  if (Math.max(underlayWidth, underlayHeight) > TVG_COMPACT_CUTOUT_MAX_UNDERLAY_EXTENT) return false;
  const underlayAspect = underlayWidth / underlayHeight;
  if (underlayAspect < 0.75 || underlayAspect > 1.0) return false;

  return visibleLayers.every(layer =>
    (layer.textLabels?.length ?? 0) === 0
    && layer.shapes.every(shape =>
      shape.components.every(comp =>
        comp.path
        && comp.path.segments.length > 0
        && (comp.componentType === 0 || comp.componentType === 1 || comp.componentType === 2 || comp.componentType === 4),
      ),
    ),
  );
}

function shouldUseTinyVectorViewportFloor(
  drawing: TVGDrawing,
  contentExtent: number,
  options?: TVGRenderOptions,
): boolean {
  if (options?.artLayerFilter || options?.centerOnOrigin || options?.skipBackgroundComposite || options?.skipClipping) {
    return false;
  }
  if (drawing.bitmapTiles.length > 0) return false;
  if (contentExtent <= 0 || contentExtent > TVG_TINY_VECTOR_MAX_CONTENT_EXTENT) return false;

  const visibleLayers = drawing.layers.filter(layer => layer.shapes.length > 0);
  if (visibleLayers.length === 0) return false;
  if (!visibleLayers.some(layer => layer.type === 'line')) return false;
  if (!visibleLayers.every(layer => layer.type === 'line' || layer.type === 'color')) return false;
  if (visibleLayers.some(layer => (layer.textLabels?.length ?? 0) > 0)) return false;

  const shapeCount = visibleLayers.reduce((sum, layer) => sum + layer.shapes.length, 0);
  if (shapeCount === 0 || shapeCount > TVG_TINY_VECTOR_MAX_SHAPES) return false;

  const componentCount = visibleLayers.reduce(
    (sum, layer) => sum + layer.shapes.reduce((shapeSum, shape) => shapeSum + shape.components.length, 0),
    0,
  );
  if (componentCount === 0 || componentCount > TVG_TINY_VECTOR_MAX_COMPONENTS) return false;

  return visibleLayers.every(layer =>
    layer.shapes.every(shape =>
      shape.components.every(comp =>
        comp.path
        && comp.path.segments.length > 0
        && (comp.componentType === 0 || comp.componentType === 1 || comp.componentType === 2 || comp.componentType === 4),
      ),
    ),
  );
}

function applyDenseLineFillInkDensityAdjustment(
  canvas: HTMLCanvasElement,
  outputFractionalAlphaPixels: number,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const shouldRelieveSaturatedFills = outputFractionalAlphaPixels >= DENSE_LINE_FILL_EDGE_MIN_FRACTIONAL_ALPHA_PIXELS
    && outputFractionalAlphaPixels <= DENSE_LINE_FILL_EDGE_EXPANSION_MAX_FRACTIONAL_ALPHA_PIXELS;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  for (let index = 0; index < data.length; index += 4) {
    const luma = 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
    const isForeground = Math.abs(data[index] - 255) > DENSE_LINE_FILL_BACKGROUND_TOLERANCE
      || Math.abs(data[index + 1] - 255) > DENSE_LINE_FILL_BACKGROUND_TOLERANCE
      || Math.abs(data[index + 2] - 255) > DENSE_LINE_FILL_BACKGROUND_TOLERANCE
      || data[index + 3] < 255 - DENSE_LINE_FILL_BACKGROUND_TOLERANCE;
    if (!isForeground) continue;

    if (luma <= DENSE_LINE_FILL_INK_DENSITY_LUMA_LIMIT) {
      const chroma = Math.max(data[index], data[index + 1], data[index + 2])
        - Math.min(data[index], data[index + 1], data[index + 2]);
      const saturatedColorFill = shouldRelieveSaturatedFills
        && chroma >= DENSE_LINE_FILL_SATURATED_FILL_MIN_CHROMA
        && luma >= DENSE_LINE_FILL_SATURATED_FILL_MIN_LUMA;
      const densitySubtract = saturatedColorFill
        ? DENSE_LINE_FILL_SATURATED_FILL_INK_DENSITY_SUBTRACT
        : DENSE_LINE_FILL_INK_DENSITY_SUBTRACT;
      data[index] = Math.max(0, data[index] - densitySubtract);
      data[index + 1] = Math.max(0, data[index + 1] - densitySubtract);
      data[index + 2] = Math.max(0, data[index + 2] - densitySubtract);
    }

    // Toon Boom thumbnails for dense line-fill drawings have slightly flatter
    // foreground contrast than Canvas downsampling: dark ink is softened while
    // pale antialias/detail pixels move back toward the ink body.
    data[index] = Math.max(0, Math.min(255, Math.round(
      DENSE_LINE_FILL_TONE_PIVOT
        + DENSE_LINE_FILL_TONE_CONTRAST * (data[index] - DENSE_LINE_FILL_TONE_PIVOT)
        + DENSE_LINE_FILL_TONE_OFFSET,
    )));
    data[index + 1] = Math.max(0, Math.min(255, Math.round(
      DENSE_LINE_FILL_TONE_PIVOT
        + DENSE_LINE_FILL_TONE_CONTRAST * (data[index + 1] - DENSE_LINE_FILL_TONE_PIVOT)
        + DENSE_LINE_FILL_TONE_OFFSET,
    )));
    data[index + 2] = Math.max(0, Math.min(255, Math.round(
      DENSE_LINE_FILL_TONE_PIVOT
        + DENSE_LINE_FILL_TONE_CONTRAST * (data[index + 2] - DENSE_LINE_FILL_TONE_PIVOT)
        + DENSE_LINE_FILL_TONE_OFFSET,
    )));
  }
  ctx.putImageData(image, 0, 0);
}

function countFractionalAlphaPixels(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext('2d');
  if (!ctx) return 0;

  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let count = 0;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] > 0 && data[index] < 255) count++;
  }
  return count;
}

function countDenseLineFillOutputFractionalAlphaPixels(
  canvas: HTMLCanvasElement,
  outputWidth: number,
  outputHeight: number,
): number {
  if (canvas.width === outputWidth && canvas.height === outputHeight) {
    return countFractionalAlphaPixels(canvas);
  }

  const alphaCanvas = document.createElement('canvas');
  alphaCanvas.width = outputWidth;
  alphaCanvas.height = outputHeight;
  const alphaCtx = alphaCanvas.getContext('2d');
  if (!alphaCtx) return 0;
  alphaCtx.imageSmoothingEnabled = true;
  alphaCtx.imageSmoothingQuality = 'high';
  alphaCtx.drawImage(canvas, 0, 0, outputWidth, outputHeight);
  return countFractionalAlphaPixels(alphaCanvas);
}

function applyDenseLineFillEdgeCoverageAdjustment(
  canvas: HTMLCanvasElement,
  outputWidth: number,
  outputHeight: number,
): number {
  const outputFractionalAlphaPixels = countDenseLineFillOutputFractionalAlphaPixels(canvas, outputWidth, outputHeight);
  if (outputFractionalAlphaPixels < DENSE_LINE_FILL_EDGE_MIN_FRACTIONAL_ALPHA_PIXELS) return outputFractionalAlphaPixels;

  const ctx = canvas.getContext('2d');
  if (!ctx) return outputFractionalAlphaPixels;

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  for (let index = 3; index < data.length; index += 4) {
    const alpha = data[index];
    if (alpha <= 0 || alpha >= 255) continue;
    data[index] = Math.min(255, Math.round(alpha * DENSE_LINE_FILL_EDGE_ALPHA_SCALE));
  }

  if (outputFractionalAlphaPixels <= DENSE_LINE_FILL_EDGE_EXPANSION_MAX_FRACTIONAL_ALPHA_PIXELS) {
    expandDenseLineFillExteriorCoverage(data, canvas.width, canvas.height);
  }
  ctx.putImageData(image, 0, 0);
  return outputFractionalAlphaPixels;
}

function expandDenseLineFillExteriorCoverage(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): void {
  // Grow only the flood-filled exterior alpha fringe. Interior transparent holes
  // are left untouched so this behaves like thumbnail antialias coverage, not
  // a morphology operation that changes contour topology.
  const pixelCount = width * height;
  const exterior = new Uint8Array(pixelCount);
  const queue = new Uint32Array(pixelCount);
  let head = 0;
  let tail = 0;

  const enqueueExterior = (x: number, y: number): void => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const pixelIndex = y * width + x;
    if (exterior[pixelIndex] !== 0 || data[pixelIndex * 4 + 3] !== 0) return;
    exterior[pixelIndex] = 1;
    queue[tail++] = pixelIndex;
  };

  for (let x = 0; x < width; x++) {
    enqueueExterior(x, 0);
    enqueueExterior(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    enqueueExterior(0, y);
    enqueueExterior(width - 1, y);
  }

  while (head < tail) {
    const pixelIndex = queue[head++];
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    enqueueExterior(x - 1, y);
    enqueueExterior(x + 1, y);
    enqueueExterior(x, y - 1);
    enqueueExterior(x, y + 1);
  }

  const source = new Uint8ClampedArray(data);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const pixelIndex = y * width + x;
      const index = pixelIndex * 4;
      if (exterior[pixelIndex] === 0 || source[index + 3] !== 0) continue;

      let alphaSum = 0;
      let redSum = 0;
      let greenSum = 0;
      let blueSum = 0;
      let neighborCount = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const neighborIndex = ((y + dy) * width + x + dx) * 4;
          const neighborAlpha = source[neighborIndex + 3];
          if (neighborAlpha === 0) continue;
          neighborCount += 1;
          alphaSum += neighborAlpha;
          redSum += source[neighborIndex] * neighborAlpha;
          greenSum += source[neighborIndex + 1] * neighborAlpha;
          blueSum += source[neighborIndex + 2] * neighborAlpha;
        }
      }
      if (alphaSum === 0 || neighborCount === 0) continue;

      const alpha = Math.round(Math.min(255, (alphaSum / neighborCount) * DENSE_LINE_FILL_EXTERIOR_EDGE_EXPANSION_SCALE));
      data[index] = Math.round(redSum / alphaSum);
      data[index + 1] = Math.round(greenSum / alphaSum);
      data[index + 2] = Math.round(blueSum / alphaSum);
      data[index + 3] = alpha;
    }
  }
}

function createOutputAlphaMask(
  canvas: HTMLCanvasElement,
  outputWidth: number,
  outputHeight: number,
): Uint8ClampedArray | null {
  const alphaCanvas = document.createElement('canvas');
  alphaCanvas.width = outputWidth;
  alphaCanvas.height = outputHeight;
  const alphaCtx = alphaCanvas.getContext('2d');
  if (!alphaCtx) return null;
  alphaCtx.imageSmoothingEnabled = true;
  alphaCtx.imageSmoothingQuality = 'high';
  alphaCtx.drawImage(canvas, 0, 0, outputWidth, outputHeight);
  return alphaCtx.getImageData(0, 0, outputWidth, outputHeight).data;
}

function applyDenseLineFillEdgeToneAdjustment(
  canvas: HTMLCanvasElement,
  alphaMask: Uint8ClampedArray | null,
): void {
  if (!alphaMask) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  for (let index = 0; index < data.length; index += 4) {
    const alpha = alphaMask[index + 3];
    if (alpha <= 0 || alpha >= 255) continue;
    data[index] = Math.max(0, data[index] - DENSE_LINE_FILL_EDGE_TONE_SUBTRACT);
    data[index + 1] = Math.max(0, data[index + 1] - DENSE_LINE_FILL_EDGE_TONE_SUBTRACT);
    data[index + 2] = Math.max(0, data[index + 2] - DENSE_LINE_FILL_EDGE_TONE_SUBTRACT);
  }
  ctx.putImageData(image, 0, 0);
}

function applyDenseLineFillInteriorShadowToneAdjustment(
  canvas: HTMLCanvasElement,
  alphaMask: Uint8ClampedArray | null,
): void {
  if (!alphaMask) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  for (let index = 0; index < data.length; index += 4) {
    if (alphaMask[index + 3] !== 255) continue;

    const luma = 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
    if (luma > DENSE_LINE_FILL_INTERIOR_SHADOW_LUMA_LIMIT) continue;

    const isForeground = Math.abs(data[index] - 255) > DENSE_LINE_FILL_BACKGROUND_TOLERANCE
      || Math.abs(data[index + 1] - 255) > DENSE_LINE_FILL_BACKGROUND_TOLERANCE
      || Math.abs(data[index + 2] - 255) > DENSE_LINE_FILL_BACKGROUND_TOLERANCE
      || data[index + 3] < 255 - DENSE_LINE_FILL_BACKGROUND_TOLERANCE;
    if (!isForeground) continue;

    data[index] = Math.min(255, data[index] + DENSE_LINE_FILL_INTERIOR_SHADOW_LIFT.r);
    data[index + 1] = Math.min(255, data[index + 1] + DENSE_LINE_FILL_INTERIOR_SHADOW_LIFT.g);
    data[index + 2] = Math.min(255, data[index + 2] + DENSE_LINE_FILL_INTERIOR_SHADOW_LIFT.b);
  }
  ctx.putImageData(image, 0, 0);
}

function compositeWhiteBackground(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
}

function filterDrawingToActiveLayerTypes(
  drawing: TVGDrawing,
  activeLayerTypes: TVGArtLayer['type'][],
): TVGDrawing {
  const activeTypes = new Set(activeLayerTypes);
  const layers = drawing.layers.filter((layer) => activeTypes.has(layer.type));
  return layers.length === drawing.layers.length ? drawing : { ...drawing, layers };
}

function isStrokeOnlyUnderlayLayer(layer: TVGArtLayer): boolean {
  return layer.type === 'underlay'
    && layer.shapes.length > 0
    && layer.shapes.every(shape =>
      shape.components.length > 0
      && shape.components.every(comp =>
        (comp.componentType === 2 || comp.componentType === 4)
        && comp.path
        && comp.path.segments.length > 0,
      ),
    );
}

function filterStrokeOnlyUnderlayLayersForCleanThumbnail(
  drawing: TVGDrawing,
  options?: TVGRenderOptions,
): TVGDrawing {
  if (options?.includeUnderlay === true || options?.artLayerFilter || options?.centerOnOrigin || options?.skipBackgroundComposite) {
    return drawing;
  }
  if (drawing.layers.some(layer => layer.type === 'color' && layer.shapes.length > 0)) return drawing;
  const hasRenderableLineFill = drawing.layers.some(layer =>
    layer.type === 'line' && layer.shapes.some(shapeHasRenderableFill),
  );
  if (!hasRenderableLineFill) return drawing;

  const layers = drawing.layers.filter(layer => !isStrokeOnlyUnderlayLayer(layer));
  return layers.length === drawing.layers.length ? drawing : { ...drawing, layers };
}

let textBoundsMeasureContext: CanvasRenderingContext2D | null | undefined;

function getTextBoundsMeasureContext(): CanvasRenderingContext2D | null {
  if (textBoundsMeasureContext !== undefined) return textBoundsMeasureContext;
  if (typeof document === 'undefined') {
    textBoundsMeasureContext = null;
    return textBoundsMeasureContext;
  }
  const canvas = document.createElement('canvas');
  textBoundsMeasureContext = canvas.getContext('2d');
  return textBoundsMeasureContext;
}

function transformPoint(
  transform: { a: number; b: number; c: number; d: number; e: number; f: number },
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: transform.a * x + transform.c * y + transform.e,
    y: transform.b * x + transform.d * y + transform.f,
  };
}

function collectTextLabelRenderablePoints(label: TVGTextLabel): Array<{ x: number; y: number }> {
  const layout = computeTextLabelRenderLayout(label);
  if (!layout || layout.lines.length === 0) return [];

  const ctx = getTextBoundsMeasureContext();
  const metrics = layout.lines.map((line) => {
    if (ctx) {
      ctx.font = layout.font;
      const measured = ctx.measureText(line);
      const ascent = measured.actualBoundingBoxAscent
        || measured.fontBoundingBoxAscent
        || layout.lineHeight * 0.8;
      const descent = measured.actualBoundingBoxDescent
        || measured.fontBoundingBoxDescent
        || layout.lineHeight * 0.2;
      return { width: measured.width, ascent, descent };
    }
    return {
      width: line.length * label.fontSize * 0.6,
      ascent: layout.lineHeight * 0.8,
      descent: layout.lineHeight * 0.2,
    };
  });

  const points: Array<{ x: number; y: number }> = [];
  layout.lines.forEach((_, index) => {
    const metric = metrics[index];
    const y = layout.baseY + index * layout.lineHeight;
    const lineHeight = metric.ascent + metric.descent;
    let minX = 0;
    let maxX = metric.width;
    if (layout.textAlign === 'right') {
      minX = -metric.width;
      maxX = 0;
    } else if (layout.textAlign === 'center') {
      minX = -metric.width / 2;
      maxX = metric.width / 2;
    }
    let minY = y - metric.ascent;
    let maxY = y + metric.descent;
    if (layout.textBaseline === 'top') {
      minY = y;
      maxY = y + lineHeight;
    } else if (layout.textBaseline === 'middle') {
      minY = y - lineHeight / 2;
      maxY = y + lineHeight / 2;
    }
    points.push(
      transformPoint(layout.transform, minX, minY),
      transformPoint(layout.transform, maxX, minY),
      transformPoint(layout.transform, minX, maxY),
      transformPoint(layout.transform, maxX, maxY),
    );
  });

  return points;
}

function shapeMayRenderVisibleContent(
  shape: TVGShape,
  layer: TVGArtLayer,
  allLayers: TVGArtLayer[],
  defaultBoundaryFillColor: { r: number; g: number; b: number; a: number } | null,
  defaultStrokeWidth: number,
  shapeIndex = -1,
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
    if (layer.type !== 'line' || !lineFillShapeIsBoundsOnlyOpenUnresolved(layer, shape, shapeIndex)) {
      return true;
    }
  }

  const strokeComps = shape.components.filter(comp =>
    (comp.componentType === 2 || comp.componentType === 4)
    && comp.path
    && comp.path.segments.length > 0,
  );
  if (strokeComps.some(comp =>
    shouldRenderWidthlessBoundaryStroke(layer, shape, comp, allLayers)
    || (comp.outerPaint !== null && resolveStrokeProfile(comp, defaultStrokeWidth) !== null),
  )) {
    return true;
  }

  if (boundaryShapeSupportsSameLayerUnderlayFill(layer, shape)) {
    return true;
  }

  if (defaultBoundaryFillColor
    && isBoundaryOnlyShape(shape)
    && !isSparseBoundaryMarkerShape(shape)
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

function lineFillShapeIsBoundsOnlyOpenUnresolved(
  layer: TVGArtLayer,
  shape: TVGShape,
  shapeIndex: number,
): boolean {
  const strokeComps = shape.components.filter(comp =>
    (comp.componentType === 4 || comp.componentType === 2)
    && comp.path
    && comp.path.segments.length > 0,
  );
  const explicitBuild = buildContoursForShape(collectExplicitFillFragments(shape, layer.type, shapeIndex), false);
  if (explicitBuild.contours.length > 0 || explicitBuild.unresolvedChains.length === 0) return false;
  if (explicitBuild.unresolvedChains.some(chain =>
    chain.supportFragmentCount > 0
    || isContourGeometryClosed(chain)
  )) {
    return false;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const chain of explicitBuild.unresolvedChains) {
    minX = Math.min(minX, chain.bbox.minX);
    minY = Math.min(minY, chain.bbox.minY);
    maxX = Math.max(maxX, chain.bbox.maxX);
    maxY = Math.max(maxY, chain.bbox.maxY);
  }
  const maxDimension = Math.max(maxX - minX, maxY - minY);
  const centerDistance = Math.hypot((minX + maxX) / 2, (minY + maxY) / 2);
  if (
    maxDimension < LINE_FILL_BOUNDS_ONLY_MIN_OUTLIER_SIZE
    || centerDistance < LINE_FILL_BOUNDS_ONLY_MIN_OUTLIER_DISTANCE
  ) {
    return false;
  }

  const legacyStrokeComps = strokeComps.length === 0
    ? collectSameLayerSupportBoundaryStrokes(layer, shape, shapeIndex)
    : strokeComps;
  return !canRenderLegacyExplicitFillShape(
    shape,
    legacyStrokeComps,
    { layerType: layer.type },
  );
}

function collectRenderablePoints(
  drawing: TVGDrawing,
  activeLayerTypes: TVGArtLayer['type'][],
  defaultBoundaryFillColor: { r: number; g: number; b: number; a: number } | null,
  defaultStrokeWidth: number,
): { x: number; y: number }[] {
  const activeTypes = new Set(activeLayerTypes);
  const scopedLayers = drawing.layers.filter((layer) => activeTypes.has(layer.type));
  const allPoints: { x: number; y: number }[] = [];
  for (const layer of scopedLayers) {
    for (let shapeIndex = 0; shapeIndex < layer.shapes.length; shapeIndex++) {
      const shape = layer.shapes[shapeIndex];
      if (!shapeMayRenderVisibleContent(shape, layer, scopedLayers, defaultBoundaryFillColor, defaultStrokeWidth, shapeIndex)) {
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
    for (const label of layer.textLabels ?? []) {
      allPoints.push(...collectTextLabelRenderablePoints(label));
    }
  }

  if (allPoints.length > 0) {
    return allPoints;
  }

  for (const layer of scopedLayers) {
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
    for (const label of layer.textLabels ?? []) {
      allPoints.push(...collectTextLabelRenderablePoints(label));
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
        if (shouldRenderWidthlessBoundaryStroke(layer, shape, comp, drawing.layers)) {
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
  const renderDrawing = normalizeThinPencilFillOnlyShapes(drawing, defaultStrokeWidth);
  const ssWidth = width * SS;
  const ssHeight = height * SS;
  const layerTypes = getActiveArtLayerTypes(options);
  const activeDrawing = filterStrokeOnlyUnderlayLayersForCleanThumbnail(
    filterDrawingToActiveLayerTypes(renderDrawing, layerTypes),
    options,
  );

  let defaultBoundaryFillColor: { r: number; g: number; b: number; a: number } | null = null;
  for (const entry of renderDrawing.palette) {
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
    for (const point of collectRenderablePoints(activeDrawing, layerTypes, defaultBoundaryFillColor, defaultStrokeWidth)) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
    // Expand bounds by max stroke width to prevent thick strokes from clipping
    const maxStrokeW = computeMaxStrokeWidth(activeDrawing, defaultStrokeWidth);
    const halfStroke = maxStrokeW / 2;
    minX -= halfStroke;
    minY -= halfStroke;
    maxX += halfStroke;
    maxY += halfStroke;

    const contentExtent = Math.max(maxX - minX, maxY - minY);
    const centerOnOrigin = options?.centerOnOrigin ?? false;
    const canvasViewportSize = Math.max(1, Math.min(ssWidth, ssHeight));
    const viewportContentPadding = shouldUseCompactCutoutViewportPadding(activeDrawing, options)
      ? TVG_COMPACT_CUTOUT_VIEWPORT_CONTENT_PADDING
      : TVG_VIEWPORT_CONTENT_PADDING;
    const viewportFloor = shouldUseTinyVectorViewportFloor(activeDrawing, contentExtent, options)
      ? Math.min(viewport, TVG_TINY_VECTOR_VIEWPORT_FLOOR)
      : viewport;
    if (centerOnOrigin) {
      const originExtent = 2 * Math.max(Math.abs(minX), Math.abs(maxX), Math.abs(minY), Math.abs(maxY));
      viewportSize = Math.max(viewportFloor, contentExtent + viewportContentPadding, originExtent + 100);
    } else {
      const baseViewportSize = Math.max(viewportFloor, contentExtent + viewportContentPadding);
      viewportSize = baseViewportSize + computeAdditionalViewportSourcePadding(
        activeDrawing,
        defaultBoundaryFillColor,
        defaultStrokeWidth,
        baseViewportSize,
        canvasViewportSize,
        SS,
      );
    }

    // When centerOnOrigin is set (compositor mode), center on (0,0) so all elements
    // share the same coordinate space. Otherwise center on content centroid.
    const centerX = centerOnOrigin ? 0 : (minX + maxX) / 2;
    const centerY = centerOnOrigin ? 0 : (minY + maxY) / 2;

    const availableViewportSize = canvasViewportSize;
    scale = availableViewportSize / viewportSize;
    offsetX = ssWidth / 2 - centerX * scale;
    offsetY = ssHeight / 2 + centerY * scale;
    ctx.setTransform(scale, 0, 0, -scale, offsetX, offsetY);
  } else {
    // Auto-fit to path bounds
    const allPoints = collectRenderablePoints(activeDrawing, layerTypes, defaultBoundaryFillColor, defaultStrokeWidth);
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
      const halfStroke = Math.max(computeMaxStrokeWidth(activeDrawing, defaultStrokeWidth) / 2, 0.5);
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
    for (const layer of activeDrawing.layers) {
      if (layer.type !== layerType) continue;
      renderLayerPass(fillCtx, layer, defaultStrokeWidth, 'fill', {
        defaultBoundaryFillColor,
        skipClipping: options?.skipClipping ?? false,
        diagnostics: activeDrawing.diagnostics,
        allLayers: activeDrawing.layers,
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
    for (const layer of activeDrawing.layers) {
      if (layer.type !== layerType) continue;
      renderLayerPass(ctx, layer, defaultStrokeWidth, 'stroke', {
        defaultBoundaryFillColor,
        skipClipping: options?.skipClipping ?? false,
        diagnostics: activeDrawing.diagnostics,
        allLayers: activeDrawing.layers,
      });
    }
  }

  const shouldApplyDenseLineFillAdjustment = shouldApplyDenseLineFillInkDensityAdjustment(renderDrawing, options);
  let denseLineFillOutputAlphaMask: Uint8ClampedArray | null = null;
  let shouldApplyDenseLineFillEdgeTone = false;
  let denseLineFillOutputFractionalAlphaPixels = 0;
  if (shouldApplyDenseLineFillAdjustment) {
    const outputFractionalAlphaPixels = applyDenseLineFillEdgeCoverageAdjustment(canvas, width, height);
    denseLineFillOutputFractionalAlphaPixels = outputFractionalAlphaPixels;
    denseLineFillOutputAlphaMask = createOutputAlphaMask(canvas, width, height);
    shouldApplyDenseLineFillEdgeTone = outputFractionalAlphaPixels >= DENSE_LINE_FILL_EDGE_TONE_MIN_FRACTIONAL_ALPHA_PIXELS;
  }

  // Pre-composite against white background (skip for matte/compositor sources)
  const backgroundCompositeTiming = options?.backgroundCompositeTiming ?? 'pre-downsample';
  const shouldCompositeBackground = !options?.skipBackgroundComposite;
  if (shouldCompositeBackground && backgroundCompositeTiming === 'pre-downsample') {
    compositeWhiteBackground(canvas);
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
    if (shouldCompositeBackground && backgroundCompositeTiming === 'post-downsample-before-dense') {
      compositeWhiteBackground(outCanvas);
    }
    if (shouldApplyDenseLineFillAdjustment) {
      applyDenseLineFillInkDensityAdjustment(outCanvas, denseLineFillOutputFractionalAlphaPixels);
      applyDenseLineFillInteriorShadowToneAdjustment(outCanvas, denseLineFillOutputAlphaMask);
      if (shouldApplyDenseLineFillEdgeTone) {
        applyDenseLineFillEdgeToneAdjustment(outCanvas, denseLineFillOutputAlphaMask);
      }
    }
    if (shouldCompositeBackground && backgroundCompositeTiming === 'post-downsample-after-dense') {
      compositeWhiteBackground(outCanvas);
    }
    return outCanvas;
  }

  if (shouldCompositeBackground && backgroundCompositeTiming === 'post-downsample-before-dense') {
    compositeWhiteBackground(canvas);
  }
  if (shouldApplyDenseLineFillAdjustment) {
    applyDenseLineFillInkDensityAdjustment(canvas, denseLineFillOutputFractionalAlphaPixels);
    applyDenseLineFillInteriorShadowToneAdjustment(canvas, denseLineFillOutputAlphaMask);
    if (shouldApplyDenseLineFillEdgeTone) {
      applyDenseLineFillEdgeToneAdjustment(canvas, denseLineFillOutputAlphaMask);
    }
  }
  if (shouldCompositeBackground && backgroundCompositeTiming === 'post-downsample-after-dense') {
    compositeWhiteBackground(canvas);
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

function computeBitmapCellBounds(tiles: TVGBitmapTile[]): TVGBitmapBounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const tile of tiles) {
    if (
      tile.cellX === undefined
      || tile.cellY === undefined
      || tile.cellW === undefined
      || tile.cellH === undefined
      || tile.cellW <= 0
      || tile.cellH <= 0
    ) {
      continue;
    }
    minX = Math.min(minX, tile.cellX);
    minY = Math.min(minY, tile.cellY);
    maxX = Math.max(maxX, tile.cellX + tile.cellW);
    maxY = Math.max(maxY, tile.cellY + tile.cellH);
  }
  if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) {
    return null;
  }
  return { minX, minY, maxX, maxY };
}

function computeCanvasAlphaBounds(
  canvas: HTMLCanvasElement,
  alphaThreshold = 1,
): TVGBitmapBounds | null {
  if (canvas.width <= 0 || canvas.height <= 0) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const alpha = imageData[(y * canvas.width + x) * 4 + 3];
      if (alpha < alphaThreshold) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + 1);
      maxY = Math.max(maxY, y + 1);
    }
  }
  if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) {
    return null;
  }
  return { minX, minY, maxX, maxY };
}

function cropCanvasToBounds(
  source: HTMLCanvasElement,
  bounds: TVGBitmapBounds,
): HTMLCanvasElement {
  const cropW = Math.max(1, Math.round(bounds.maxX - bounds.minX));
  const cropH = Math.max(1, Math.round(bounds.maxY - bounds.minY));
  const canvas = document.createElement('canvas');
  canvas.width = cropW;
  canvas.height = cropH;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(
    source,
    Math.round(bounds.minX),
    Math.round(bounds.minY),
    cropW,
    cropH,
    0,
    0,
    cropW,
    cropH,
  );
  return canvas;
}

const SNAPPED_BITMAP_GUTTER_CROP_INSET = 64;

function snapBitmapBoundsToTileGrid(bounds: TVGBitmapBounds, tileSize: number): TVGBitmapBounds {
  if (tileSize <= 0) return bounds;
  return {
    minX: Math.floor(bounds.minX / tileSize) * tileSize,
    minY: Math.floor(bounds.minY / tileSize) * tileSize,
    maxX: Math.ceil(bounds.maxX / tileSize) * tileSize,
    maxY: Math.ceil(bounds.maxY / tileSize) * tileSize,
  };
}

function computeBitmapFitPadding(
  fallbackScanUsed: boolean,
  hasClipRects: boolean,
  loadedCount: number,
  aspectRatio: number,
): number {
  if (hasClipRects && loadedCount >= 8) {
    if (!fallbackScanUsed && aspectRatio < 1) return 8.5;
    if (fallbackScanUsed && loadedCount >= 32 && loadedCount < 128 && aspectRatio > 1.35) return 5.5;
    if (!fallbackScanUsed && loadedCount === 8 && aspectRatio >= 2) return 6.5;
    if (!fallbackScanUsed && loadedCount === 12 && aspectRatio >= 2.3) return 6.5;
    if (!fallbackScanUsed && aspectRatio > 1.35 && aspectRatio < 1.6) return 7.5;
    if (!fallbackScanUsed && aspectRatio > 1.25 && aspectRatio <= 1.35) return 7.5;
    // Clipped atlases consistently match previews better with a real framing inset,
    // regardless of whether the bitmap bounds came from fallback scanning or exact clips.
    return aspectRatio <= 1.35 ? 8 : 7;
  }
  if (!fallbackScanUsed) return 4;
  // Sparse fallback-scanned atlases consistently render slightly too large with the generic
  // 4px inset. Landscape atlases typically settle at 7px, while squarer/taller atlases
  // need an extra pixel of frame to avoid a residual 1px drift against the preview.
  if (hasClipRects) return aspectRatio <= 1.35 ? 8 : 7;
  return 4;
}

export function __computeBitmapFitPaddingForTests(
  fallbackScanUsed: boolean,
  hasClipRects: boolean,
  loadedCount: number,
  aspectRatio: number,
): number {
  return computeBitmapFitPadding(fallbackScanUsed, hasClipRects, loadedCount, aspectRatio);
}

function shouldTrimSparsePortraitFallbackAtlas(
  fallbackScanUsed: boolean,
  hasClipRects: boolean,
  loadedCount: number,
  aspectRatio: number,
): boolean {
  return fallbackScanUsed
    && hasClipRects
    && loadedCount < 32
    && aspectRatio < 1;
}

function computeAdditionalViewportSourcePadding(
  drawing: TVGDrawing,
  defaultBoundaryFillColor: { r: number; g: number; b: number; a: number } | null,
  defaultStrokeWidth: number,
  baseViewportSize: number,
  canvasViewportSize: number,
  ss: number,
): number {
  if (shouldInsetViewportForColorGuideGridDrawing(drawing)) {
    const insetPx = 4 * ss;
    const availableViewportSize = Math.max(1, canvasViewportSize - insetPx * 2);
    return baseViewportSize * (canvasViewportSize / availableViewportSize - 1);
  }

  const visibleLineShapes: Array<{ layer: TVGArtLayer; shape: TVGShape; shapeIndex: number }> = [];
  for (const layer of drawing.layers) {
    for (let shapeIndex = 0; shapeIndex < layer.shapes.length; shapeIndex++) {
      const shape = layer.shapes[shapeIndex];
      if (!shapeMayRenderVisibleContent(shape, layer, drawing.layers, defaultBoundaryFillColor, defaultStrokeWidth, shapeIndex)) {
        continue;
      }
      if (layer.type !== 'line') return 0;
      visibleLineShapes.push({ layer, shape, shapeIndex });
    }
  }

  if (visibleLineShapes.length === 0) return 0;

  let insetPx = 0;
  let maxPreRenderPriority = 0;
  for (const { layer, shape, shapeIndex } of visibleLineShapes) {
    maxPreRenderPriority = Math.max(
      maxPreRenderPriority,
      preRenderLargeLineFillCarrierPriority(layer, shape, shapeIndex),
    );
  }

  if (maxPreRenderPriority >= 2) {
    insetPx = 5 * ss;
  } else if (shouldInsetViewportForConstructionGuideDrawing(visibleLineShapes)) {
    insetPx = 3.5 * ss;
  } else if (shouldInsetViewportForLineFillDrawing(drawing)) {
    insetPx = shouldUseSquareLineFillSourceInset(visibleLineShapes) ? 5 * ss : 4 * ss;
  }

  if (insetPx <= 0) return 0;
  const availableViewportSize = Math.max(1, canvasViewportSize - insetPx * 2);
  return baseViewportSize * (canvasViewportSize / availableViewportSize - 1);
}

function shouldUseSquareLineFillSourceInset(
  visibleLineShapes: Array<{ layer: TVGArtLayer; shape: TVGShape; shapeIndex: number }>,
): boolean {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { shape } of visibleLineShapes) {
    const bounds = computeShapeBounds(shape);
    if (!bounds) continue;
    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
  }
  if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return false;

  const width = Math.max(0, maxX - minX);
  const height = Math.max(0, maxY - minY);
  if (width <= 0 || height <= 0) return false;
  const aspect = width / height;
  // Square line-fill thumbnails preserve the older, looser source inset; portrait
  // drawings match the source thumbnails better with the tighter line-fill inset.
  return aspect >= 0.99 && aspect <= 1.01;
}

function shouldInsetViewportForConstructionGuideDrawing(
  visibleLineShapes: Array<{ layer: TVGArtLayer; shape: TVGShape; shapeIndex: number }>,
): boolean {
  if (visibleLineShapes.length < 2) return false;
  let hasClosedGuideShape = false;
  let hasOpenGuideShape = false;
  for (const { layer, shape } of visibleLineShapes) {
    if (layer.type !== 'line') return false;
    if (isOpenConstructionGuideShape(shape)) {
      hasOpenGuideShape = true;
      continue;
    }
    if (isClosedConstructionGuideShape(shape)) {
      hasClosedGuideShape = true;
      continue;
    }
    return false;
  }
  return hasClosedGuideShape && hasOpenGuideShape;
}

function shouldInsetViewportForLineFillDrawing(drawing: TVGDrawing): boolean {
  const hasColorLayer = drawing.layers.some((layer) => layer.type === 'color' && layer.shapes.length > 0);
  if (hasColorLayer) return false;
  return drawing.layers.some((layer) =>
    layer.type === 'line'
    && layer.shapes.some((shape, shapeIndex) => {
      const strokeComps = shape.components.filter(comp =>
        (comp.componentType === 2 || comp.componentType === 4)
        && comp.path
        && comp.path.segments.length > 0,
      );
      if (strokeComps.length > 0) return false;
      const fillComps = renderableFillComponents(shape);
      if (fillComps.length < 8) return false;
      const inheritedFillCount = fillComps.filter(comp => comp.fillPaintSource === 'inherited').length;
      if (inheritedFillCount < fillComps.length - 2) return false;
      const explicitBuild = buildContoursForShape(collectExplicitFillFragments(shape, layer.type, shapeIndex), false);
      return explicitBuild.unresolvedChains.length > 0
        || preRenderLargeLineFillCarrierPriority(layer, shape, shapeIndex) > 0;
    }),
  );
}

function isLineFillBaseCarrierShape(shape: TVGShape): boolean {
  const strokeComps = shape.components.filter(comp =>
    (comp.componentType === 2 || comp.componentType === 4)
    && comp.path
    && comp.path.segments.length > 0,
  );
  if (strokeComps.length > 0) return false;

  const fillComps = renderableFillComponents(shape);
  if (fillComps.length < 8) return false;
  const fillPaintKeys = new Set(
    fillComps
      .map(comp => paintKeyForComponent(comp))
      .filter((key): key is FillStyleKey => key !== null),
  );
  if (fillPaintKeys.size !== 1) return false;

  const inheritedFillCount = fillComps.filter(comp => comp.fillPaintSource === 'inherited').length;
  return inheritedFillCount >= fillComps.length - 2;
}

function lineFillBaseCarrierBoundsArea(shape: TVGShape): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const comp of renderableFillComponents(shape)) {
    const bounds = componentPathBounds(comp);
    if (!bounds) continue;
    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return 0;
  }
  return Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
}

function shouldUseLineFillBaseCarrierOrdering(
  layer: TVGArtLayer,
  allLayers: TVGArtLayer[] | undefined,
): boolean {
  if (layer.type !== 'line' || layer.shapes.length < LINE_FILL_BASE_ORDER_MIN_SHAPES) return false;
  if (allLayers?.some(entry => entry.type === 'color' && entry.shapes.length > 0)) return false;
  return layer.shapes.filter(isLineFillBaseCarrierShape).length >= LINE_FILL_BASE_ORDER_MIN_CARRIERS;
}

function shouldInsetViewportForColorGuideGridDrawing(drawing: TVGDrawing): boolean {
  let guideStrokeCount = 0;
  let fillPanelCount = 0;
  let labelCount = 0;

  for (const layer of drawing.layers) {
    labelCount += layer.textLabels?.length ?? 0;
    if (layer.type !== 'color') continue;
    for (const shape of layer.shapes) {
      if (isOpenColorGuideGridShape(shape)) {
        guideStrokeCount++;
        continue;
      }
      if (isColorGuideFillPanelShape(shape)) {
        fillPanelCount++;
      }
    }
  }

  return guideStrokeCount >= 16
    && fillPanelCount >= 2
    && labelCount >= 4;
}

function isOpenColorGuideGridShape(shape: TVGShape): boolean {
  return shape.shapeType === 6
    && shape.components.length === 1
    && isColorGuideGridStroke(shape.components[0]);
}

function isColorGuideGridStroke(comp: TVGComponent): boolean {
  if (comp.componentType !== 4 || !isStraightAxisPath(comp.path)) return false;
  if (comp.strokeWidth === null || comp.strokeWidth > 8) return false;
  if (comp.tgtiThickness === null || comp.tgtiThickness > 0.1) return false;
  return paintHasVisibleAlpha(comp.outerPaint) && !isDarkSolidPaint(comp.outerPaint);
}

function isColorGuideFillPanelShape(shape: TVGShape): boolean {
  if (shape.shapeType !== 4 || shape.components.length !== 1) return false;
  const comp = shape.components[0];
  if (comp.componentType !== 0 || !comp.path || !paintHasVisibleAlpha(comp.outerPaint)) return false;
  const bounds = segmentBounds(comp.path.segments);
  return (bounds.maxX - bounds.minX) >= 400
    && (bounds.maxY - bounds.minY) >= 150;
}

function isConstructionGuidePaint(paint: TVGPaint | null): boolean {
  if (paint?.kind !== 'solid') return false;
  const { r, g, b, a } = paint.rgba;
  return a > 0 && r >= 220 && g >= 25 && g <= 120 && b <= 100;
}

function isStraightAxisPath(path: TVGPath | null): boolean {
  if (!path || path.closed || path.segments.length !== 2) return false;
  const [start, end] = path.segments;
  if (start.type !== 'M' || end.type !== 'L') return false;
  const dx = Math.abs(start.x - end.x);
  const dy = Math.abs(start.y - end.y);
  return dx <= 0.001 || dy <= 0.001;
}

function isConstructionGuideStroke(comp: TVGComponent): boolean {
  return comp.componentType === 4
    && isConstructionGuidePaint(comp.outerPaint)
    && comp.strokeWidth !== null
    && comp.strokeWidth <= 12
    && comp.tgtiThickness !== null
    && comp.tgtiThickness <= 0.1
    && !!comp.path
    && comp.path.segments.length >= 2;
}

function isOpenConstructionGuideShape(shape: TVGShape): boolean {
  return shape.shapeType === 6
    && shape.components.length > 0
    && shape.components.every(comp => isConstructionGuideStroke(comp) && isStraightAxisPath(comp.path));
}

function isClosedConstructionGuideShape(shape: TVGShape): boolean {
  return shape.shapeType === 4
    && shape.components.length > 0
    && shape.components.every(comp =>
      isConstructionGuideStroke(comp)
      && !!comp.path
      && comp.path.closed
      && comp.path.segments.length >= 4,
    );
}

function shouldSuppressGuideOnlyConstructionShape(
  layer: TVGArtLayer,
  shape: TVGShape,
  allLayers?: TVGArtLayer[],
): boolean {
  if (layer.type !== 'line' || !isOpenConstructionGuideShape(shape) || !allLayers) return false;
  let hasOpenGuide = false;
  for (const candidateLayer of allLayers) {
    if (candidateLayer.type !== 'line') {
      if (candidateLayer.shapes.some(candidateShape => shapeMayContainRenderablePaint(candidateShape))) {
        return false;
      }
      continue;
    }
    for (const candidateShape of candidateLayer.shapes) {
      if (isClosedConstructionGuideShape(candidateShape)) return false;
      if (isOpenConstructionGuideShape(candidateShape)) {
        hasOpenGuide = true;
        continue;
      }
      if (shapeMayContainRenderablePaint(candidateShape)) return false;
    }
  }
  return hasOpenGuide;
}

function shapeMayContainRenderablePaint(shape: TVGShape): boolean {
  return shape.components.some(comp =>
    paintHasVisibleAlpha(comp.outerPaint)
    || paintHasVisibleAlpha(comp.innerPaint)
    || paintHasVisibleAlpha(comp.contourPaint),
  );
}

export function __shouldInsetViewportForLineFillDrawingForTests(drawing: TVGDrawing): boolean {
  return shouldInsetViewportForLineFillDrawing(drawing);
}

export function __shouldInsetViewportForColorGuideGridDrawingForTests(drawing: TVGDrawing): boolean {
  return shouldInsetViewportForColorGuideGridDrawing(drawing);
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

function shouldApplyBitmapAtlasEdgeTone(
  fallbackScanUsed: boolean,
  hasClipRects: boolean,
  loadedCount: number,
  aspectRatio: number,
): boolean {
  return !fallbackScanUsed
    && hasClipRects
    && loadedCount >= 8
    && loadedCount < BITMAP_ATLAS_EDGE_TONE_MAX_TILES
    && (loadedCount >= BITMAP_ATLAS_EDGE_TONE_MULTI_TILE_MIN
      || aspectRatio >= BITMAP_ATLAS_EDGE_TONE_WIDE_ASPECT_MIN);
}

function createBitmapAtlasEdgeAlphaMask(
  renderCanvas: HTMLCanvasElement,
  width: number,
  height: number,
  dx: number,
  dy: number,
  targetW: number,
  targetH: number,
): Uint8ClampedArray | null {
  const alphaCanvas = document.createElement('canvas');
  alphaCanvas.width = width;
  alphaCanvas.height = height;
  const alphaCtx = alphaCanvas.getContext('2d');
  if (!alphaCtx) return null;

  drawImageWithProgressiveDownscale(alphaCtx, renderCanvas, dx, dy, targetW, targetH);
  const image = alphaCtx.getImageData(0, 0, width, height);
  let edgePixels = 0;
  for (let index = 3; index < image.data.length; index += 4) {
    const alpha = image.data[index];
    if (alpha >= BITMAP_ATLAS_EDGE_TONE_MIN_ALPHA && alpha <= BITMAP_ATLAS_EDGE_TONE_MAX_ALPHA) {
      edgePixels++;
    }
  }
  return edgePixels >= BITMAP_ATLAS_EDGE_TONE_MIN_PIXELS ? image.data : null;
}

function applyBitmapAtlasEdgeTone(
  ctx: CanvasRenderingContext2D,
  alphaMask: Uint8ClampedArray,
  width: number,
  height: number,
): void {
  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;
  for (let index = 0; index < data.length; index += 4) {
    const alpha = alphaMask[index + 3];
    if (alpha < BITMAP_ATLAS_EDGE_TONE_MIN_ALPHA || alpha > BITMAP_ATLAS_EDGE_TONE_MAX_ALPHA) continue;
    const baseR = Math.max(0, data[index] - BITMAP_ATLAS_EDGE_TONE_BASE_SUBTRACT);
    const baseG = Math.max(0, data[index + 1] - BITMAP_ATLAS_EDGE_TONE_BASE_SUBTRACT);
    const baseB = Math.max(0, data[index + 2] - BITMAP_ATLAS_EDGE_TONE_BASE_SUBTRACT);
    const subtract = baseR < BITMAP_ATLAS_EDGE_TONE_BACKGROUND_THRESHOLD
      || baseG < BITMAP_ATLAS_EDGE_TONE_BACKGROUND_THRESHOLD
      || baseB < BITMAP_ATLAS_EDGE_TONE_BACKGROUND_THRESHOLD
      || data[index + 3] < BITMAP_ATLAS_EDGE_TONE_BACKGROUND_THRESHOLD
      ? BITMAP_ATLAS_EDGE_TONE_FOREGROUND_SUBTRACT
      : BITMAP_ATLAS_EDGE_TONE_BASE_SUBTRACT;
    data[index] = Math.max(0, data[index] - subtract);
    data[index + 1] = Math.max(0, data[index + 1] - subtract);
    data[index + 2] = Math.max(0, data[index + 2] - subtract);
  }
  ctx.putImageData(image, 0, 0);
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
    backgroundComposite: options?.skipBackgroundComposite !== true,
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
  const cellBounds = computeBitmapCellBounds(tiles);
  const shouldUseTileCellBounds = hasClipRects && loaded.length >= 32 && cellBounds !== null;
  const shouldSnapFallbackAtlasBounds = fallbackScanUsed && hasClipRects && loaded.length >= 32 && !shouldUseTileCellBounds;
  const fittedBounds = shouldUseTileCellBounds
    ? cellBounds
    : shouldSnapFallbackAtlasBounds
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

  let renderCanvas = nativeCanvas;
  let renderBounds = fittedBounds;
  if ((fallbackScanUsed || shouldUseTileCellBounds) && hasClipRects) {
    const visibleBounds = computeCanvasAlphaBounds(nativeCanvas);
    if (visibleBounds) {
      const leftInset = visibleBounds.minX;
      const topInset = visibleBounds.minY;
      const rightInset = nativeCanvas.width - visibleBounds.maxX;
      const bottomInset = nativeCanvas.height - visibleBounds.maxY;
      // Only crop when grid snapping introduced a substantial synthetic frame.
      // Small fallback gutters often belong to the intended sheet framing and
      // should be preserved to avoid overscaling the final bitmap.
      const shouldCropVisibleBounds = Math.max(leftInset, topInset, rightInset, bottomInset) >= SNAPPED_BITMAP_GUTTER_CROP_INSET;
      if (shouldCropVisibleBounds) {
        renderCanvas = cropCanvasToBounds(nativeCanvas, visibleBounds);
        renderBounds = {
          minX: fittedBounds.minX + visibleBounds.minX,
          minY: fittedBounds.minY + visibleBounds.minY,
          maxX: fittedBounds.minX + visibleBounds.maxX,
          maxY: fittedBounds.minY + visibleBounds.maxY,
        };
      }
    }
  }

  const renderW = Math.max(1, Math.round(renderBounds.maxX - renderBounds.minX));
  const renderH = Math.max(1, Math.round(renderBounds.maxY - renderBounds.minY));
  const contentExtent = Math.max(renderBounds.maxX - renderBounds.minX, renderBounds.maxY - renderBounds.minY);
  const centerOnOrigin = state?.centerOnOrigin ?? false;
  const originExtent = 2 * Math.max(
    Math.abs(renderBounds.minX),
    Math.abs(renderBounds.maxX),
    Math.abs(renderBounds.minY),
    Math.abs(renderBounds.maxY),
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
    const centerX = centerOnOrigin ? 0 : (renderBounds.minX + renderBounds.maxX) / 2;
    const centerY = centerOnOrigin ? 0 : (renderBounds.minY + renderBounds.maxY) / 2;
    scale = Math.min(width, height) / Math.max(viewportSize, 1);
    dx = width / 2 - (centerX - renderBounds.minX) * scale;
    dy = height / 2 - (renderBounds.maxY - centerY) * scale;
  } else {
    const aspectRatio = renderW / Math.max(renderH, 1);
    const padding = computeBitmapFitPadding(fallbackScanUsed, hasClipRects, loaded.length, aspectRatio);
    const availW = width - padding * 2;
    const availH = height - padding * 2;
    scale = Math.min(availW / renderW, availH / renderH);
    dx = padding + (availW - renderW * scale) / 2;
    dy = padding + (availH - renderH * scale) / 2;
    if (shouldTrimSparsePortraitFallbackAtlas(fallbackScanUsed, hasClipRects, loaded.length, aspectRatio)) {
      dy += 1;
    }
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (state?.backgroundComposite ?? true) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  const targetW = renderW * scale;
  let targetH = renderH * scale;
  if (shouldTrimSparsePortraitFallbackAtlas(fallbackScanUsed, hasClipRects, loaded.length, renderW / Math.max(renderH, 1))) {
    targetH = Math.max(1, targetH - 2);
  }
  const bitmapEdgeAlphaMask = (state?.backgroundComposite ?? true)
    && shouldApplyBitmapAtlasEdgeTone(fallbackScanUsed, hasClipRects, loaded.length, renderW / Math.max(renderH, 1))
    ? createBitmapAtlasEdgeAlphaMask(renderCanvas, width, height, dx, dy, targetW, targetH)
    : null;
  drawImageWithProgressiveDownscale(ctx, renderCanvas, dx, dy, targetW, targetH);
  if (bitmapEdgeAlphaMask) {
    applyBitmapAtlasEdgeTone(ctx, bitmapEdgeAlphaMask, width, height);
  }

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

interface NestedFillTopology {
  parentPaint: TVGPaint | null;
  childPaint: TVGPaint | null;
  layerType: TVGArtLayer['type'] | null;
  parentFragmentCount: number;
  parentSupportFragmentCount: number;
  parentBBox: { minX: number; minY: number; maxX: number; maxY: number };
  childFragmentCount: number;
  childBBox: { minX: number; minY: number; maxX: number; maxY: number };
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

const SAME_PAINT_DETAIL_MAX_FRAGMENTS = 12;
const SAME_PAINT_DETAIL_MAX_AREA_RATIO = 0.0375;
const LINE_FILL_BASE_ORDER_MIN_SHAPES = 8;
const LINE_FILL_BASE_ORDER_MIN_CARRIERS = 2;

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

function isDarkSolidPaint(paint: TVGPaint | null, threshold = 64): boolean {
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
    contourColorId: null,
    insideColorId: null,
    paletteIndex: null,
    color: { ...color },
    contourColor: null,
    fillPaintSource: 'synthetic',
    insideColor: null,
    transform: paint.kind === 'gradient' ? paint.transform : null,
    contourTransform: null,
    path: null,
    strokeWidth: null,
    thicknessProfile: null,
    joinType: 'round',
    fromTipType: 'round',
    toTipType: 'round',
    gradientType: paint.kind === 'gradient' ? paint.gradientType : undefined,
    gradientStops: paint.kind === 'gradient' ? paint.stops : undefined,
    contourGradientType: undefined,
    contourGradientStops: undefined,
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
    contourPaint: null,
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

function expandLegacyChainComponents(components: TVGComponent[]): TVGComponent[] {
  const expanded: TVGComponent[] = [];
  for (const comp of components) {
    if (!comp.path) continue;
    const subpaths = splitPathIntoSubpaths(comp.path)
      .filter(segments => segments.some(segment => segment.type !== 'M'));
    if (subpaths.length <= 1) {
      expanded.push(comp);
      continue;
    }
    for (const segments of subpaths) {
      expanded.push({
        ...comp,
        path: {
          ...comp.path,
          segments,
          closed: false,
        },
      });
    }
  }
  return expanded;
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

function isMaskPaletteEntry(entry: TVGPaletteEntry | undefined): boolean {
  return (entry?.name ?? '').trim().toLowerCase() === 'mask';
}

function clearFillComponentPaint(comp: TVGComponent): void {
  comp.color = null;
  comp.colorId = null;
  comp.gradientType = undefined;
  comp.gradientStops = undefined;
  comp.fillPaintSource = null;
  updateComponentPaints(comp);
}

function suppressUnderlayMaskPaletteHintFillColors(
  layer: TVGArtLayer,
  shape: TVGShape,
  paletteMap: Map<bigint, TVGPaletteEntry>,
): void {
  if (layer.type !== 'underlay') return;

  const fillEntries = fillCarrierEntries(shape);
  const maskSeed = fillEntries.find(({ comp }) =>
    comp.paletteIndex === null
    && comp.colorId !== null
    && comp.color !== null
    && isMaskPaletteEntry(paletteMap.get(comp.colorId))
  );
  if (!maskSeed) return;

  const hasOtherInlineColor = fillEntries.some(({ comp }) =>
    comp !== maskSeed.comp
    && comp.paletteIndex === null
    && comp.colorId !== null
    && !isMaskPaletteEntry(paletteMap.get(comp.colorId))
  );
  if (hasOtherInlineColor) return;

  for (const { comp } of fillEntries) {
    if (comp === maskSeed.comp) continue;
    if (comp.paletteIndex === null) continue;
    if (comp.fillPaintSource !== 'explicit') continue;
    if (comp.colorId === null) continue;
    if (isMaskPaletteEntry(paletteMap.get(comp.colorId))) continue;
    clearFillComponentPaint(comp);
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

function isSparseBoundaryMarkerShape(shape: TVGShape): boolean {
  return shape.components.length > 0
    && shape.components.every(comp =>
      comp.componentType === 2
      && comp.strokeWidth === null
      && !comp.thicknessProfile
      && comp.tgtiThickness === null
      && (!comp.path || comp.path.segments.length <= 2),
    )
    && shape.components.some(comp => comp.path && comp.path.segments.length === 2);
}

function isWidthlessBoundaryStroke(comp: TVGComponent): boolean {
  return comp.componentType === 2
    && comp.strokeWidth === null
    && !comp.thicknessProfile
    && comp.tgtiThickness === null
    && !!comp.path
    && comp.path.segments.length > 0;
}

function isImplicitWidthlessBoundaryStroke(comp: TVGComponent): boolean {
  return isWidthlessBoundaryStroke(comp)
    && comp.colorId === null
    && comp.contourColorId === null
    && comp.insideColorId === null;
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
  allLayers?: TVGArtLayer[],
): boolean {
  if (!isWidthlessBoundaryStroke(comp)) return false;
  if (layer.type !== 'line') return false;
  if (!paintHasVisibleAlpha(comp.outerPaint)) return false;
  if (shape.shapeType === 7 && boundaryStrokeMatchesActiveColorFill(layer, comp, allLayers)) return false;
  if (isImplicitWidthlessBoundaryStroke(comp)
    && shape.components.some(other =>
      other !== comp
      && (other.componentType === 0 || other.componentType === 1)
      && other.path
      && other.outerPaint !== null,
    )
    && shape.components.some(other =>
      other !== comp
      && other.componentType === 4
      && other.path
      && paintHasVisibleAlpha(other.outerPaint),
    )) {
    return false;
  }
  if (shape.shapeType === 7 && shape.components.length > 0 && shape.components.every(other => isWidthlessBoundaryStroke(other))) {
    const boundaryOnlyComps = shape.components.filter(other => isWidthlessBoundaryStroke(other));
    const isSingleOpenSegment = boundaryOnlyComps.length === 1
      && boundaryOnlyComps[0].path !== null
      && boundaryOnlyComps[0].path.segments.filter(seg => seg.type !== 'M').length <= 1
      && !boundaryOnlyComps[0].path.closed;
    if (isSingleOpenSegment) {
      return boundaryStrokeBridgesSiblingChain(layer, shape, boundaryOnlyComps[0]);
    }
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

function pathEndpointPair(path: TVGPath): { start: TVGSegment; end: TVGSegment } | null {
  if (path.segments.length < 2) return null;
  return {
    start: path.segments[0],
    end: path.segments[path.segments.length - 1],
  };
}

function pointsNearlyEqual(
  a: Pick<TVGSegment, 'x' | 'y'>,
  b: Pick<TVGSegment, 'x' | 'y'>,
  tolerance = 0.001,
): boolean {
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;
}

function pathEndpointsMatch(a: TVGPath, b: TVGPath): boolean {
  const aPair = pathEndpointPair(a);
  const bPair = pathEndpointPair(b);
  if (!aPair || !bPair) return false;
  return (
    pointsNearlyEqual(aPair.start, bPair.start) && pointsNearlyEqual(aPair.end, bPair.end)
  ) || (
    pointsNearlyEqual(aPair.start, bPair.end) && pointsNearlyEqual(aPair.end, bPair.start)
  );
}

function boundaryStrokeMatchesActiveColorFill(
  layer: TVGArtLayer,
  comp: TVGComponent,
  allLayers?: TVGArtLayer[],
): boolean {
  if (!allLayers || layer.type === 'color' || !comp.path) return false;
  return allLayers.some(candidateLayer =>
    candidateLayer.type === 'color'
    && candidateLayer.shapes.some(candidateShape =>
      candidateShape.components.some(candidate =>
        (candidate.componentType === 0 || candidate.componentType === 1)
        && candidate.path
        && candidate.outerPaint !== null
        && pathEndpointsMatch(comp.path!, candidate.path),
      ),
    ),
  );
}

function boundaryShapeMatchesActiveColorFill(
  layer: TVGArtLayer,
  shape: TVGShape,
  allLayers?: TVGArtLayer[],
): boolean {
  return isBoundaryOnlyShape(shape)
    && shape.components.every(comp => boundaryStrokeMatchesActiveColorFill(layer, comp, allLayers));
}

function boundaryStrokeBridgesSiblingChain(
  layer: TVGArtLayer,
  shape: TVGShape,
  comp: TVGComponent,
): boolean {
  if (!comp.path || comp.path.segments.length < 2) return false;
  const start = comp.path.segments[0];
  const end = comp.path.segments[comp.path.segments.length - 1];
  let startConnected = false;
  let endConnected = false;
  for (const sibling of layer.shapes) {
    if (sibling === shape) continue;
    for (const other of sibling.components) {
      if (!isWidthlessBoundaryStroke(other) || !other.path || !paintsEqual(other.outerPaint, comp.outerPaint)) {
        continue;
      }
      const otherStart = other.path.segments[0];
      const otherEnd = other.path.segments[other.path.segments.length - 1];
      if (!startConnected && (
        (Math.abs(start.x - otherStart.x) < 0.001 && Math.abs(start.y - otherStart.y) < 0.001)
        || (Math.abs(start.x - otherEnd.x) < 0.001 && Math.abs(start.y - otherEnd.y) < 0.001)
      )) {
        startConnected = true;
      }
      if (!endConnected && (
        (Math.abs(end.x - otherStart.x) < 0.001 && Math.abs(end.y - otherStart.y) < 0.001)
        || (Math.abs(end.x - otherEnd.x) < 0.001 && Math.abs(end.y - otherEnd.y) < 0.001)
      )) {
        endConnected = true;
      }
      if (startConnected && endConnected) {
        return true;
      }
    }
  }
  return false;
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
      if (!isBoundaryOnlyShape(shape) || isSparseBoundaryMarkerShape(shape)) continue;
      if (boundaryShapeMatchesActiveColorFill(layer, shape, allLayers)) continue;
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

function countSharedBoundaryEndpoints(a: TVGShape, b: TVGShape, tolerance = 2.0): number {
  const aEndpoints: Array<Pick<TVGSegment, 'x' | 'y'>> = [];
  const bEndpoints: Array<Pick<TVGSegment, 'x' | 'y'>> = [];
  for (const comp of a.components) {
    if (!comp.path) continue;
    const pair = pathEndpointPair(comp.path);
    if (!pair) continue;
    aEndpoints.push(pair.start, pair.end);
  }
  for (const comp of b.components) {
    if (!comp.path) continue;
    const pair = pathEndpointPair(comp.path);
    if (!pair) continue;
    bEndpoints.push(pair.start, pair.end);
  }

  let shared = 0;
  for (const aEndpoint of aEndpoints) {
    if (bEndpoints.some(bEndpoint => pointsNearlyEqual(aEndpoint, bEndpoint, tolerance))) {
      shared++;
    }
  }
  return shared;
}

function collectSameLayerSupportBoundaryStrokes(
  layer: TVGArtLayer,
  currentShape: TVGShape,
  currentShapeIndex: number,
): TVGComponent[] {
  if (layer.type !== 'underlay') return [];
  const currentBounds = computeShapeBounds(currentShape);
  if (!currentBounds) return [];
  const supportStrokes: TVGComponent[] = [];
  const seen = new Set<string>();
  for (let index = currentShapeIndex - 1; index >= 0; index--) {
    const candidate = layer.shapes[index];
    if (!candidate || !isBoundaryOnlyShape(candidate)) continue;
    if (!boundsIntersect(currentBounds, computeShapeBounds(candidate), 2.0)) continue;
    if (countSharedBoundaryEndpoints(currentShape, candidate) < 2) continue;
    const signature = boundaryShapeSignature(candidate);
    if (seen.has(signature)) continue;
    seen.add(signature);
    for (const comp of candidate.components) {
      if (!comp.path || comp.path.segments.length <= 1) continue;
      supportStrokes.push(createSupportOnlyLegacyComponent(comp));
    }
  }
  return supportStrokes;
}

function boundaryShapeSupportsSameLayerUnderlayFill(
  layer: TVGArtLayer,
  boundaryShape: TVGShape,
): boolean {
  if (layer.type !== 'underlay' || !isBoundaryOnlyShape(boundaryShape)) return false;
  const boundaryBounds = computeShapeBounds(boundaryShape);
  if (!boundaryBounds) return false;
  return layer.shapes.some(candidate => {
    if (candidate === boundaryShape) return false;
    if (renderableFillComponents(candidate).length === 0) return false;
    if (!boundsIntersect(boundaryBounds, computeShapeBounds(candidate), 2.0)) return false;
    return countSharedBoundaryEndpoints(candidate, boundaryShape) >= 2;
  });
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
  shapeIndex: number,
  strokeComps: TVGComponent[],
  resolvedContourCount = 0,
  layerShapes: TVGShape[] = layer.shapes,
): boolean {
  if (layer.type !== 'line' || strokeComps.length > 0) return false;
  if (!shapeHasOnlyNearBlackRenderableFills(shape)) return false;
  if (resolvedContourCount > 0) return false;
  const currentBounds = computeShapeBounds(shape);
  if (!currentBounds) return false;
  const currentArea = (currentBounds.maxX - currentBounds.minX) * (currentBounds.maxY - currentBounds.minY);
  if (currentArea < 50000) return false;
  for (let siblingIndex = shapeIndex + 1; siblingIndex < layerShapes.length; siblingIndex++) {
    const sibling = layerShapes[siblingIndex];
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

function collectOverlappingNearBlackRenderableFillShapes(
  currentShape: TVGShape,
  layerShapes: TVGShape[],
): TVGShape[] {
  const currentBounds = computeShapeBounds(currentShape);
  if (!currentBounds) return [];
  const blockers: TVGShape[] = [];
  for (const sibling of layerShapes) {
    if (sibling === currentShape) continue;
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
  sameLayerShapes: TVGShape[],
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
  return sameLayerShapes.some(shape => {
    if (shape === currentShape) return false;
    const siblingFillComps = renderableFillComponents(shape);
    if (siblingFillComps.length < fillComps.length * 6) return false;
    const siblingPaintKeys = renderableFillPaintKeys(shape);
    if (siblingPaintKeys.size < 2 || !siblingPaintKeys.has(currentKey)) return false;
    return boundsIntersect(currentBounds, computeShapeBounds(shape), 0.5);
  });
}

const EMBEDDED_DARK_LEGACY_PAINT_THRESHOLD = 64;

function collectEmbeddedDarkLegacyPaintKeysToSuppress(
  layer: TVGArtLayer,
  shape: TVGShape,
  strokeComps: TVGComponent[],
  explicitBuild: { contours: TVGResolvedContour[]; unresolvedChains: TVGResolvedContour[] },
  fillCarrierCount: number,
  fillPaintKeys: Set<FillStyleKey>,
): Set<FillStyleKey> | null {
  if (layer.type !== 'line' || strokeComps.length > 0) return null;
  if (fillCarrierCount < 50 || fillPaintKeys.size < 2) return null;
  if (explicitBuild.contours.length > 0 || explicitBuild.unresolvedChains.length === 0) return null;

  const shapeBounds = computeShapeBounds(shape);
  if (!shapeBounds) return null;
  const shapeArea = (shapeBounds.maxX - shapeBounds.minX) * (shapeBounds.maxY - shapeBounds.minY);
  if (shapeArea <= 0) return null;

  const chainableFillComps = expandLegacyChainComponents(shape.components.filter(comp =>
    (comp.componentType === 0 || comp.componentType === 1)
    && comp.path
    && comp.path.segments.length > 1
    && !isDegenerate(comp.path)
    && (!comp.color || comp.color.a > 0),
  ));
  const paintedFillComps = chainableFillComps.filter(comp => comp.outerPaint !== null);
  const supportFillComps = chainableFillComps.filter(comp => comp.outerPaint === null);
  const allChainComps = [...paintedFillComps, ...supportFillComps];
  const componentsByKey = new Map<FillStyleKey, TVGComponent[]>();
  let largestNonDarkGroupSize = 0;
  for (const comp of paintedFillComps) {
    const key = paintKeyForComponent(comp);
    if (!key || !comp.outerPaint) continue;
    const group = componentsByKey.get(key) ?? [];
    group.push(comp);
    componentsByKey.set(key, group);
    if (!isDarkSolidPaint(comp.outerPaint, EMBEDDED_DARK_LEGACY_PAINT_THRESHOLD)) {
      largestNonDarkGroupSize = Math.max(largestNonDarkGroupSize, group.length);
    }
  }
  if (largestNonDarkGroupSize < 40) return null;

  const suppressed = new Set<FillStyleKey>();
  const groups = buildLegacyFillRenderGroups(allChainComps, {
    includeNullPaintFillBoundaries: true,
  });

  for (const [key, components] of componentsByKey) {
    const paint = components.find(comp => comp.outerPaint)?.outerPaint ?? null;
    if (!isDarkSolidPaint(paint, EMBEDDED_DARK_LEGACY_PAINT_THRESHOLD)) continue;
    if (components.length < 8 || components.length > 16) continue;

    const explicitCount = components.filter(comp => hasExplicitFillStyle(comp)).length;
    const inheritedCount = components.filter(comp => comp.fillPaintSource === 'inherited').length;
    if (explicitCount !== 1 || inheritedCount < components.length - 1) continue;

    const group = groups.find(candidate => candidate.key === key);
    if (!group) continue;
    const { drawableChains } = buildLegacyChains(allChainComps, group.allChainIndices, 2.0);
    if (drawableChains.length !== 1 || !isLegacyChainClosed(drawableChains[0], 2.0)) continue;

    const chainComponents = new Set(drawableChains[0].map(link => allChainComps[link.ci]));
    if (chainComponents.size !== components.length || !components.every(comp => chainComponents.has(comp))) continue;

    const { chainGeometries } = analyzeLegacyDrawableChains(drawableChains, allChainComps);
    const chainArea = chainGeometries[0]?.area ?? Infinity;
    if (chainArea <= 0 || chainArea > shapeArea * 0.1) continue;

    suppressed.add(key);
  }

  return suppressed.size > 0 ? suppressed : null;
}

function preRenderLargeLineFillCarrierPriority(
  layer: TVGArtLayer,
  shape: TVGShape,
  shapeIndex: number,
): number {
  if (layer.type !== 'line') return 0;
  const strokeComps = shape.components.filter(comp =>
    (comp.componentType === 4 || comp.componentType === 2)
    && comp.path
    && comp.path.segments.length > 0,
  );
  if (strokeComps.length > 0) return 0;
  const fillComps = renderableFillComponents(shape);
  if (fillComps.length < 40) return 0;
  const fillPaintKeys = renderableFillPaintKeys(shape);
  if (fillPaintKeys.size === 0 || fillPaintKeys.size > 2) return 0;
  const explicitFillCount = fillComps.filter(comp => hasExplicitFillStyle(comp)).length;
  const inheritedFillCount = fillComps.filter(comp => comp.fillPaintSource === 'inherited').length;
  if (inheritedFillCount < 20) return 0;
  const explicitBuild = buildContoursForShape(collectExplicitFillFragments(shape, layer.type, shapeIndex), false);
  if (fillPaintKeys.size === 1) {
    return 0;
  }
  if (explicitFillCount !== 2 || inheritedFillCount < fillComps.length - 2) return 0;
  if (explicitBuild.contours.length !== 1) return 0;
  if (explicitBuild.unresolvedChains.length === 0 || explicitBuild.unresolvedChains.length > 2) return 0;
  return explicitBuild.unresolvedChains.every(chain =>
    chain.styledFragmentCount === 1
    && chain.supportFragmentCount >= 8
    && chain.fragmentCount >= 20,
  ) ? 2 : 0;
}

interface LineFillPreRenderPlan {
  priority: number;
  mode: 'full' | 'legacy-group';
  preRenderPaintKey: FillStyleKey | null;
}

function planLineFillPreRender(
  layer: TVGArtLayer,
  shape: TVGShape,
  shapeIndex: number,
): LineFillPreRenderPlan {
  const priority = preRenderLargeLineFillCarrierPriority(layer, shape, shapeIndex);
  return {
    priority,
    mode: 'full',
    preRenderPaintKey: null,
  };
}

function shouldPreferLegacyMixedDominantUnresolvedLineShape(
  layer: TVGArtLayer,
  strokeComps: TVGComponent[],
  fillCarrierCount: number,
  hasInheritedFillCarriers: boolean,
  fillPaintKeys: Set<FillStyleKey>,
  explicitFillPaintKeys: Set<FillStyleKey>,
  explicitBuild: TVGFillBuildResult,
): boolean {
  if (layer.type !== 'line' || strokeComps.length > 0) return false;
  if (fillCarrierCount < 20 || !hasInheritedFillCarriers) return false;
  if (fillPaintKeys.size !== 1 || explicitFillPaintKeys.size > 1) return false;
  if (explicitBuild.contours.length === 0 || explicitBuild.unresolvedChains.length !== 1) return false;
  const [chain] = explicitBuild.unresolvedChains;
  if (chain.supportFragmentCount !== 0 || chain.styledFragmentCount < 20) return false;
  const resolvedStyledFragmentCount = explicitBuild.contours.reduce(
    (sum, contour) => sum + contour.styledFragmentCount,
    0,
  );
  return chain.styledFragmentCount > resolvedStyledFragmentCount;
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

function polygonCentroid(points: { x: number; y: number }[]): { x: number; y: number } | null {
  if (points.length < 3) return null;
  let crossSum = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const cross = a.x * b.y - b.x * a.y;
    crossSum += cross;
    sx += (a.x + b.x) * cross;
    sy += (a.y + b.y) * cross;
  }
  if (Math.abs(crossSum) < 1e-6) return null;
  return {
    x: sx / (3 * crossSum),
    y: sy / (3 * crossSum),
  };
}

function searchInteriorPointInBBox(
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  flattened: { x: number; y: number }[],
): { x: number; y: number } | null {
  const width = bbox.maxX - bbox.minX;
  const height = bbox.maxY - bbox.minY;
  if (width < 0.001 || height < 0.001) return null;
  const ratios = [0.5, 0.375, 0.625, 0.25, 0.75, 0.125, 0.875];
  for (const ry of ratios) {
    for (const rx of ratios) {
      const candidate = {
        x: bbox.minX + width * rx,
        y: bbox.minY + height * ry,
      };
      if (pointInPolygon(flattened, candidate)) return candidate;
    }
  }
  return null;
}

function chooseSamplePoint(
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  flattened: { x: number; y: number }[],
): { x: number; y: number } | null {
  const candidates = [
    { x: (bbox.minX + bbox.maxX) / 2, y: (bbox.minY + bbox.maxY) / 2 },
    polygonCentroid(flattened),
    averagePoint(flattened),
    averagePoint(flattened.slice(0, Math.max(1, flattened.length - 1))),
  ].filter((candidate): candidate is { x: number; y: number } => candidate !== null);
  for (const candidate of candidates) {
    if (pointInPolygon(flattened, candidate)) return candidate;
  }
  return searchInteriorPointInBBox(bbox, flattened);
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

function shouldAllowSupportDominatedContourAutoClose(
  fragments: TVGContourFragment[],
  refs: Array<{ fragmentIndex: number; reversed: boolean }>,
  synthesized: boolean,
  styledFragmentCount: number,
  supportFragmentCount: number,
  closeDistance: number,
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  startPoint: { x: number; y: number },
  endPoint: { x: number; y: number },
): boolean {
  if (synthesized || styledFragmentCount !== 1 || supportFragmentCount < 8) {
    return false;
  }
  if (closeDistance <= CHAIN_TOL * 8) {
    return true;
  }
  const supportRatio = supportFragmentCount / Math.max(refs.length, 1);
  if (supportFragmentCount < 24 || supportRatio < 0.85) {
    return false;
  }
  const diagonal = Math.hypot(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY);
  if (diagonal <= 0 || closeDistance > Math.min(256, diagonal * 0.3)) {
    return false;
  }
  const head = refs[0];
  const tail = refs[refs.length - 1];
  const headTraversal = legacyTraversalDirections(
    { segments: fragments[head.fragmentIndex].segments, closed: false, tgrvValue: null, directionReversed: null },
    head.reversed,
  );
  const tailTraversal = legacyTraversalDirections(
    { segments: fragments[tail.fragmentIndex].segments, closed: false, tgrvValue: null, directionReversed: null },
    tail.reversed,
  );
  const closeFromStart = legacyNormalizeDirection(endPoint.x - startPoint.x, endPoint.y - startPoint.y);
  const closeFromEnd = legacyNormalizeDirection(startPoint.x - endPoint.x, startPoint.y - endPoint.y);
  const startTurn = legacyTurningAngle(headTraversal.start, closeFromStart);
  const endTurn = legacyTurningAngle(tailTraversal.end, closeFromEnd);
  return startTurn <= Math.PI / 3 && endTurn <= Math.PI / 3;
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
  const allowSupportDominatedAutoClose = shouldAllowSupportDominatedContourAutoClose(
    fragments,
    refs,
    synthesized,
    styledFragmentCount,
    supportFragmentCount,
    closeDistance,
    bbox,
    startPoint,
    endPoint,
  );
  if (closeDistance > AUTO_CLOSE_TOL && !allowSupportDominatedAutoClose) return null;
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
    && (polyArea / bboxArea) > 0.8
    && !allowSupportDominatedAutoClose
  ) {
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
  const shouldPaintContourNode = (index: number) => {
    const node = tree[index];
    if (node.parent === null) return true;
    if ((node.depth % 2) === 0) return true;
    return !paintsEqual(
      contours[index].style?.outerPaint ?? null,
      contours[node.parent].style?.outerPaint ?? null,
    );
  };
  const renderNode = (index: number) => {
    const contour = contours[index];
    const paint = contour.style?.outerPaint ?? null;
    if (paint && shouldPaintContourNode(index)) {
      const compound = new Path2D();
      compound.addPath(contour.path);
      const subtractingChildren = tree[index].children.filter(childIndex =>
        shouldSubtractNestedContour(contour, contours[childIndex]),
      );
      for (const childIndex of subtractingChildren) {
        compound.addPath(contours[childIndex].path);
      }
      sources.push({
        kind: 'path',
        path: compound,
        paint,
        fillRule: subtractingChildren.length > 0 ? 'evenodd' : 'nonzero',
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

function shouldSubtractNestedContour(parent: TVGResolvedContour, child: TVGResolvedContour): boolean {
  return shouldSubtractNestedFill({
    parentPaint: parent.style?.outerPaint ?? null,
    childPaint: child.style?.outerPaint ?? null,
    layerType: parent.layerType,
    parentFragmentCount: parent.fragmentCount,
    parentSupportFragmentCount: parent.supportFragmentCount,
    parentBBox: parent.bbox,
    childFragmentCount: child.fragmentCount,
    childBBox: child.bbox,
  });
}

function shouldSubtractNestedFill(topology: NestedFillTopology): boolean {
  if (!paintsEqual(topology.parentPaint, topology.childPaint)) return true;
  if (topology.layerType !== 'line') return true;
  if (topology.parentFragmentCount < 20 || topology.parentSupportFragmentCount > 0) return true;

  const parentArea = boundsArea(topology.parentBBox);
  const childArea = boundsArea(topology.childBBox);
  if (parentArea <= 0 || childArea <= 0) return true;

  // Harmony line-art carriers sometimes encode tiny same-paint nested contours as
  // detail islands inside a large filled contour. Treating every same-paint child
  // as an even-odd hole punches visible white seams through dense hair/face fills.
  const isSmallSamePaintDetail = topology.childFragmentCount <= SAME_PAINT_DETAIL_MAX_FRAGMENTS
    && childArea / parentArea <= SAME_PAINT_DETAIL_MAX_AREA_RATIO;
  return !isSmallSamePaintDetail;
}

function shouldAllowThinPencilContourFallback(
  layer: TVGArtLayer,
  shape: TVGShape,
  strokeComps: TVGComponent[],
  pencilComps: TVGComponent[],
): boolean {
  const hasOnlyPencils = strokeComps.length > 0 && strokeComps.every(comp => comp.componentType === 4);
  if (!hasOnlyPencils || pencilComps.length === 0) return false;

  const isPurePencilShape = shape.components.every(comp => comp.componentType === 4);
  if (!isPurePencilShape) return false;

  if (layer.type === 'line') {
    return pencilComps.every(comp => !isNearlyBlackSolidPaint(comp.outerPaint))
      && new Set(pencilComps.map(comp => paintKeyForComponent(comp))).size === 1;
  }

  if (pencilComps.length > 1) return true;
  const onlyPencil = pencilComps[0];
  return !!onlyPencil.path && isPathEffectivelyClosed(onlyPencil.path);
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

interface LegacyChainInfo {
  ci: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

interface LegacyChainLink extends LegacyChainInfo {
  reversed: boolean;
}

interface LegacyChainGeometry {
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  area: number;
  signedArea: number;
  flattened: { x: number; y: number }[];
  samplePoint: { x: number; y: number } | null;
}

interface LegacyChainCandidateTrace {
  allChainIndex: number;
  rank: number;
  reversed: boolean;
  prepend: boolean;
  distance: number;
  support: number;
  turn: number;
  decision: 'used' | 'out_of_tolerance' | 'considered' | 'selected';
}

interface LegacyChainPickTrace {
  chainAllChainIndices: number[];
  selectedAllChainIndex: number | null;
  selectedReversed: boolean | null;
  selectedPrepend: boolean | null;
  candidates: LegacyChainCandidateTrace[];
}

function polygonSignedArea(points: { x: number; y: number }[]): number {
  if (points.length < 3) return 0;
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += (points[i].x * points[i + 1].y) - (points[i + 1].x * points[i].y);
  }
  return total / 2;
}

function legacyChainEndpointGap(chain: LegacyChainLink[]): number {
  const head = chain[0];
  const tail = chain[chain.length - 1];
  return Math.hypot(head.startX - tail.endX, head.startY - tail.endY);
}

function isLegacyChainClosed(chain: LegacyChainLink[], tolerance: number): boolean {
  const head = chain[0];
  const tail = chain[chain.length - 1];
  return Math.abs(head.startX - tail.endX) + Math.abs(head.startY - tail.endY) < tolerance * 2;
}

function legacyChainBounds(
  chain: LegacyChainLink[],
  allChainComps: TVGComponent[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const info of chain) {
    const comp = allChainComps[info.ci];
    if (!comp.path) continue;
    const sourceSegments = info.reversed ? reversedSegments(comp.path.segments) : comp.path.segments;
    for (const seg of sourceSegments) {
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
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

function legacyNormalizeDirection(x: number, y: number): { x: number; y: number } | null {
  const length = Math.hypot(x, y);
  if (length <= 0.0001) return null;
  return { x: x / length, y: y / length };
}

function legacyPathDirectionAtStart(path: TVGPath): { x: number; y: number } | null {
  const start = path.segments[0];
  for (let i = 1; i < path.segments.length; i++) {
    const seg = path.segments[i];
    if (seg.type === 'C') {
      return legacyNormalizeDirection(seg.c1x - start.x, seg.c1y - start.y)
        ?? legacyNormalizeDirection(seg.x - start.x, seg.y - start.y);
    }
    if (seg.type === 'Q') {
      return legacyNormalizeDirection(seg.cx - start.x, seg.cy - start.y)
        ?? legacyNormalizeDirection(seg.x - start.x, seg.y - start.y);
    }
    const direction = legacyNormalizeDirection(seg.x - start.x, seg.y - start.y);
    if (direction) return direction;
  }
  return null;
}

function legacyPathDirectionAtEnd(path: TVGPath): { x: number; y: number } | null {
  if (path.segments.length < 2) return null;
  const last = path.segments[path.segments.length - 1];
  const prev = path.segments[path.segments.length - 2];
  if (last.type === 'C') {
    return legacyNormalizeDirection(last.x - last.c2x, last.y - last.c2y)
      ?? legacyNormalizeDirection(last.x - prev.x, last.y - prev.y);
  }
  if (last.type === 'Q') {
    return legacyNormalizeDirection(last.x - last.cx, last.y - last.cy)
      ?? legacyNormalizeDirection(last.x - prev.x, last.y - prev.y);
  }
  return legacyNormalizeDirection(last.x - prev.x, last.y - prev.y);
}

function legacyTraversalDirections(
  path: TVGPath,
  reversed: boolean,
): { start: { x: number; y: number } | null; end: { x: number; y: number } | null } {
  const start = legacyPathDirectionAtStart(path);
  const end = legacyPathDirectionAtEnd(path);
  if (!reversed) return { start, end };
  return {
    start: end ? { x: -end.x, y: -end.y } : null,
    end: start ? { x: -start.x, y: -start.y } : null,
  };
}

function legacyTurningAngle(
  from: { x: number; y: number } | null,
  to: { x: number; y: number } | null,
): number {
  if (!from || !to) return Math.PI;
  const dot = Math.max(-1, Math.min(1, from.x * to.x + from.y * to.y));
  return Math.acos(dot);
}

function selectLegacyDrawableChains(
  chains: LegacyChainLink[][],
  allChainComps: TVGComponent[],
  tolerance: number,
): { drawableChains: LegacyChainLink[][]; autoCloseChains: Set<LegacyChainLink[]> } {
  const closedChains = chains.filter(chain => isLegacyChainClosed(chain, tolerance));
  const autoCloseChains = new Set<LegacyChainLink[]>();
  const drawableChainSet = new Set<LegacyChainLink[]>(closedChains);

  const openChains = chains.filter(chain => !isLegacyChainClosed(chain, tolerance));
  for (const candidate of openChains) {
    const paintedFillComps = allChainComps.filter(comp =>
      (comp.componentType === 0 || comp.componentType === 1) && comp.outerPaint !== null,
    );
    const hasOnlyPaintedFillCarriers = allChainComps.length > 0 && allChainComps.every(comp =>
      (comp.componentType === 0 || comp.componentType === 1) && comp.outerPaint !== null,
    );
    const explicitCount = paintedFillComps.filter(comp => hasExplicitFillStyle(comp)).length;
    const inheritedCount = paintedFillComps.filter(comp => comp.fillPaintSource === 'inherited').length;
    const largestClosedChain = closedChains.reduce((max, chain) => Math.max(max, chain.length), 0);
    const bounds = legacyChainBounds(candidate, allChainComps);
    const diagonal = bounds
      ? Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)
      : 0;
    const dominantPaint = paintedFillComps[0]?.outerPaint ?? null;
    const gapLimit = Math.min(256, diagonal * 0.06);
    const isLargeDarkCarrier = dominantPaint !== null
      && isDarkSolidPaint(dominantPaint)
      && paintedFillComps.length >= 40;
    const allowDominantDarkCarrierGap = isLargeDarkCarrier
      && candidate.length >= Math.ceil(paintedFillComps.length * 0.7)
      && legacyChainEndpointGap(candidate) <= Math.min(1600, diagonal * 0.3);
    const allowSmallInheritedCarrierGap = closedChains.length === 0
      && hasOnlyPaintedFillCarriers
      && paintedFillComps.length >= 3
      && paintedFillComps.length <= 12
      && explicitCount === 1
      && inheritedCount >= paintedFillComps.length - 1
      && candidate.length >= Math.ceil(paintedFillComps.length * 0.75)
      && diagonal > 0
      && legacyChainEndpointGap(candidate) <= Math.min(32, diagonal * 0.25);

    const allowDominantInheritedCarrierGap = chains.length > 1
      && closedChains.length > 0
      && openChains.length === 1
      && hasOnlyPaintedFillCarriers
      && paintedFillComps.length >= 8
      && explicitCount === 1
      && inheritedCount >= paintedFillComps.length - 1
      && candidate.length >= Math.ceil(paintedFillComps.length * 0.5)
      && candidate.length > largestClosedChain * 2
      && diagonal > 0
      && (legacyChainEndpointGap(candidate) <= gapLimit || allowDominantDarkCarrierGap);

    if (allowSmallInheritedCarrierGap || allowDominantInheritedCarrierGap) {
      drawableChainSet.add(candidate);
      autoCloseChains.add(candidate);
    }
  }

  return {
    drawableChains: chains.filter(chain => drawableChainSet.has(chain)),
    autoCloseChains,
  };
}

function buildLegacyChains(
  allChainComps: TVGComponent[],
  indices: number[],
  tolerance: number,
  pickTrace?: LegacyChainPickTrace[],
): {
  chains: LegacyChainLink[][];
  drawableChains: LegacyChainLink[][];
  autoCloseChains: Set<LegacyChainLink[]>;
} {
  const compInfos: LegacyChainInfo[] = indices.map(idx => {
    const segs = allChainComps[idx].path!.segments;
    return {
      ci: idx,
      startX: segs[0].x,
      startY: segs[0].y,
      endX: segs[segs.length - 1].x,
      endY: segs[segs.length - 1].y,
    };
  });
  if (compInfos.length === 0) return { chains: [], drawableChains: [], autoCloseChains: new Set() };

  const pickBestCandidate = (
    chain: LegacyChainLink[],
    used: Set<number>,
  ): { infoIndex: number; reversed: boolean; prepend: boolean } | null => {
    const head = chain[0];
    const tail = chain[chain.length - 1];
    const headDirections = legacyTraversalDirections(allChainComps[head.ci].path!, head.reversed);
    const tailDirections = legacyTraversalDirections(allChainComps[tail.ci].path!, tail.reversed);
    let best: { rank: number; distance: number; support: number; turn: number; componentIndex: number; infoIndex: number; reversed: boolean; prepend: boolean } | null = null;
    const distanceTieEpsilon = 0.01;
    const turnTieEpsilon = 0.0001;
    const traceEntry: LegacyChainPickTrace | null = pickTrace ? {
      chainAllChainIndices: chain.map(link => link.ci),
      selectedAllChainIndex: null,
      selectedReversed: null,
      selectedPrepend: null,
      candidates: [],
    } : null;
    for (let i = 0; i < compInfos.length; i++) {
      const comp = compInfos[i];
      if (used.has(i)) {
        traceEntry?.candidates.push({
          allChainIndex: comp.ci,
          rank: -1,
          reversed: false,
          prepend: false,
          distance: Number.NaN,
          support: Number.NaN,
          turn: Number.NaN,
          decision: 'used',
        });
        continue;
      }
      const support = (
        (allChainComps[comp.ci].componentType !== 0 && allChainComps[comp.ci].componentType !== 1)
        || allChainComps[comp.ci].outerPaint === null
      ) ? 1 : 0;
      const forwardDirections = legacyTraversalDirections(allChainComps[comp.ci].path!, false);
      const reversedDirections = legacyTraversalDirections(allChainComps[comp.ci].path!, true);
      const candidates = [
        {
          rank: 0,
          distance: Math.hypot(comp.startX - tail.endX, comp.startY - tail.endY),
          reversed: false,
          prepend: false,
          turn: legacyTurningAngle(tailDirections.end, forwardDirections.start),
        },
        {
          rank: 1,
          distance: Math.hypot(comp.endX - tail.endX, comp.endY - tail.endY),
          reversed: true,
          prepend: false,
          turn: legacyTurningAngle(tailDirections.end, reversedDirections.start),
        },
        {
          rank: 2,
          distance: Math.hypot(comp.endX - head.startX, comp.endY - head.startY),
          reversed: false,
          prepend: true,
          turn: legacyTurningAngle(forwardDirections.end, headDirections.start),
        },
        {
          rank: 3,
          distance: Math.hypot(comp.startX - head.startX, comp.startY - head.startY),
          reversed: true,
          prepend: true,
          turn: legacyTurningAngle(reversedDirections.end, headDirections.start),
        },
      ];
      for (const candidate of candidates) {
        if (candidate.distance > tolerance) {
          traceEntry?.candidates.push({
            allChainIndex: comp.ci,
            rank: candidate.rank,
            reversed: candidate.reversed,
            prepend: candidate.prepend,
            distance: candidate.distance,
            support,
            turn: candidate.turn,
            decision: 'out_of_tolerance',
          });
          continue;
        }
        const scored = {
          ...candidate,
          support,
          componentIndex: comp.ci,
          infoIndex: i,
        };
        traceEntry?.candidates.push({
          allChainIndex: comp.ci,
          rank: candidate.rank,
          reversed: candidate.reversed,
          prepend: candidate.prepend,
          distance: candidate.distance,
          support,
          turn: candidate.turn,
          decision: 'considered',
        });
        if (!best
          || scored.rank < best.rank
          || (scored.rank === best.rank && scored.distance < best.distance - distanceTieEpsilon)
          || (scored.rank === best.rank && Math.abs(scored.distance - best.distance) <= distanceTieEpsilon && scored.support < best.support)
          // Prefer the smoother continuation when endpoint matches are effectively tied.
          || (scored.rank === best.rank
            && Math.abs(scored.distance - best.distance) <= distanceTieEpsilon
            && scored.support === best.support
            && scored.turn < best.turn - turnTieEpsilon)
          || (scored.rank === best.rank
            && Math.abs(scored.distance - best.distance) <= distanceTieEpsilon
            && scored.support === best.support
            && Math.abs(scored.turn - best.turn) <= turnTieEpsilon
            && scored.componentIndex < best.componentIndex)) {
          best = scored;
        }
      }
    }
    if (traceEntry) {
      if (best) {
        traceEntry.selectedAllChainIndex = best.componentIndex;
        traceEntry.selectedReversed = best.reversed;
        traceEntry.selectedPrepend = best.prepend;
        const selected = traceEntry.candidates.find(candidate =>
          candidate.decision === 'considered'
          && candidate.allChainIndex === best.componentIndex
          && candidate.reversed === best.reversed
          && candidate.prepend === best.prepend
          && candidate.rank === best.rank
          && Math.abs(candidate.distance - best.distance) <= distanceTieEpsilon
        );
        if (selected) {
          selected.decision = 'selected';
        }
      }
      pickTrace?.push(traceEntry);
    }
    return best ? { infoIndex: best.infoIndex, reversed: best.reversed, prepend: best.prepend } : null;
  };

  const used = new Set<number>();
  const chains: LegacyChainLink[][] = [];
  for (let i = 0; i < compInfos.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const chain: LegacyChainLink[] = [{ ...compInfos[i], reversed: false }];
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

  const { drawableChains, autoCloseChains } = selectLegacyDrawableChains(chains, allChainComps, tolerance);
  return { chains, drawableChains, autoCloseChains };
}

function analyzeLegacyDrawableChains(
  drawableChains: LegacyChainLink[][],
  allChainComps: TVGComponent[],
): {
  chainGeometries: LegacyChainGeometry[];
  parent: number[];
} {
  const chainGeometries = drawableChains.map(chain => {
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
      signedArea: polygonSignedArea(flattened),
      flattened,
      samplePoint: chooseSamplePoint(bbox, flattened),
    };
  });

  const parent = new Array<number>(drawableChains.length).fill(-1);
  for (let i = 0; i < drawableChains.length; i++) {
    let bestParent = -1;
    let bestArea = Infinity;
    for (let j = 0; j < drawableChains.length; j++) {
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

  return { chainGeometries, parent };
}

function renderLegacyChainedFillComponents(
  ctx: CanvasRenderingContext2D,
  allChainComps: TVGComponent[],
  indices: number[],
  tolerance: number,
  alphaScale = 1,
  options: LegacyFillRenderOptions = {},
): boolean {
  const { chains, drawableChains, autoCloseChains } = buildLegacyChains(allChainComps, indices, tolerance);
  if (chains.length === 0) return false;
  let activeDrawableChains = drawableChains.filter(chain =>
    isLegacyChainClosed(chain, tolerance) || autoCloseChains.has(chain),
  );
  let activeAutoCloseChains = autoCloseChains;
  if (activeDrawableChains.length === 0) return false;

  const paint = indices
    .map(index => allChainComps[index].outerPaint)
    .find((candidate): candidate is TVGPaint => candidate !== null);
  if (!paint) return false;

  const addChainToPath = (path: Path2D, chain: typeof chains[number], isFirstChain: boolean) => {
    let isFirst = isFirstChain;
    const isClosed = isLegacyChainClosed(chain, tolerance) || activeAutoCloseChains.has(chain);
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

  if (activeDrawableChains.length === 1) {
    const path = new Path2D();
    addChainToPath(path, activeDrawableChains[0], true);
    fillPathWithPaint(ctx, path, paint);
    return true;
  }

  const { chainGeometries, parent } = analyzeLegacyDrawableChains(activeDrawableChains, allChainComps);
  const chainSupportCounts = activeDrawableChains.map(chain =>
    chain.filter(info => allChainComps[info.ci].outerPaint === null).length,
  );
  const childrenByParent = new Map<number, number[]>();
  for (let i = 0; i < parent.length; i++) {
    const siblings = childrenByParent.get(parent[i]) ?? [];
    siblings.push(i);
    childrenByParent.set(parent[i], siblings);
  }

  const depth = new Array<number>(parent.length).fill(0);
  const visitDepth = (index: number, value: number) => {
    depth[index] = value;
    for (const child of childrenByParent.get(index) ?? []) visitDepth(child, value + 1);
  };
  for (const root of childrenByParent.get(-1) ?? []) {
    visitDepth(root, 0);
  }

  const shouldPaintChainNode = (index: number) => (
    parent[index] === -1 || (depth[index] % 2) === 0
  );

  const renderChainNode = (index: number) => {
    const children = childrenByParent.get(index) ?? [];
    if (shouldPaintChainNode(index)) {
      const path = new Path2D();
      addChainToPath(path, activeDrawableChains[index], true);
      const subtractingChildren = children.filter(child =>
        shouldSubtractNestedFill({
          parentPaint: paint,
          childPaint: paint,
          layerType: options.layerType ?? null,
          parentFragmentCount: activeDrawableChains[index].length,
          parentSupportFragmentCount: chainSupportCounts[index],
          parentBBox: chainGeometries[index].bbox,
          childFragmentCount: activeDrawableChains[child].length,
          childBBox: chainGeometries[child].bbox,
        }),
      );
      if (subtractingChildren.length > 0) {
        for (const child of subtractingChildren) {
          addChainToPath(path, activeDrawableChains[child], true);
        }
        fillPathWithPaint(ctx, path, scalePaintAlpha(paint, alphaScale), 'evenodd');
      } else {
        fillPathWithPaint(ctx, path, scalePaintAlpha(paint, alphaScale));
      }
    }
    for (const child of children) {
      renderChainNode(child);
    }
  };

  for (const root of childrenByParent.get(-1) ?? []) {
    renderChainNode(root);
  }
  return true;
}

interface LegacyFillRenderGroup {
  key: string;
  allChainIndices: number[];
}

interface LegacyFillRenderOptions {
  supportInheritedCrossPaint?: boolean;
  allowedPaintKeys?: Set<FillStyleKey>;
  blockedPaintKeys?: Set<FillStyleKey>;
  includeNullPaintFillBoundaries?: boolean;
  layerType?: TVGArtLayer['type'];
}

function createSupportOnlyLegacyComponent(comp: TVGComponent): TVGComponent {
  return {
    ...comp,
    outerPaint: null,
  };
}

function buildLegacyFillRenderGroups(
  allChainComps: TVGComponent[],
  options: LegacyFillRenderOptions = {},
): LegacyFillRenderGroup[] {
  const colorGroups = new Map<string, number[]>();
  const boundaryIndices: number[] = [];
  const includeNullPaintFillBoundaries = options.includeNullPaintFillBoundaries ?? true;

  for (let i = 0; i < allChainComps.length; i++) {
    const comp = allChainComps[i];
    const key = paintKeyForComponent(comp);
    if (key) {
      const group = colorGroups.get(key) ?? [];
      group.push(i);
      colorGroups.set(key, group);
    } else if (
      includeNullPaintFillBoundaries
      || comp.componentType === 2
      || comp.componentType === 4
    ) {
      boundaryIndices.push(i);
    }
  }

  const keys = Array.from(colorGroups.keys());
  if (keys.length <= 1) {
    const singleGroup = {
      key: keys[0] ?? '__single__',
      allChainIndices: allChainComps.map((_, index) => index),
    };
    if (options.allowedPaintKeys && keys[0] && !options.allowedPaintKeys.has(keys[0])) return [];
    if (options.blockedPaintKeys && keys[0] && options.blockedPaintKeys.has(keys[0])) return [];
    return [singleGroup];
  }

  const supportIndicesByKey = new Map<string, number[]>();
  if (options.supportInheritedCrossPaint) {
    for (const key of keys) {
      const supportIndices: number[] = [];
      for (const comp of allChainComps) {
        if (paintKeyForComponent(comp) === key) continue;
        if (comp.fillPaintSource !== 'inherited' || comp.outerPaint === null) continue;
        allChainComps.push(createSupportOnlyLegacyComponent(comp));
        supportIndices.push(allChainComps.length - 1);
      }
      supportIndicesByKey.set(key, supportIndices);
    }
  }

  return keys
    .filter(key =>
      (!options.allowedPaintKeys || options.allowedPaintKeys.has(key))
      && (!options.blockedPaintKeys || !options.blockedPaintKeys.has(key)),
    )
    .map(key => ({
    key,
    allChainIndices: [
      ...(colorGroups.get(key) ?? []),
      ...boundaryIndices,
      ...(supportIndicesByKey.get(key) ?? []),
    ],
    }));
}

function canRenderLegacyChainedFillComponents(
  allChainComps: TVGComponent[],
  indices: number[],
  tolerance: number,
): boolean {
  const { chains, drawableChains, autoCloseChains } = buildLegacyChains(allChainComps, indices, tolerance);
  if (chains.length === 0) return false;
  const hasDrawableChain = drawableChains.some(chain =>
    isLegacyChainClosed(chain, tolerance) || autoCloseChains.has(chain),
  );
  if (!hasDrawableChain) return false;
  return indices.some(index => allChainComps[index]?.outerPaint !== null);
}

function canRenderLegacyExplicitFillShape(
  shape: TVGShape,
  strokeComps: TVGComponent[],
  options: LegacyFillRenderOptions = {},
): boolean {
  const chainableFillComps = expandLegacyChainComponents(shape.components.filter(comp =>
    (comp.componentType === 0 || comp.componentType === 1)
    && comp.path
    && comp.path.segments.length > 1
    && !isDegenerate(comp.path)
    && (!comp.color || comp.color.a > 0)
  ));
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
  const boundaryStrokes = expandLegacyChainComponents(strokeComps.filter(comp =>
    comp.componentType === 2
    && comp.strokeWidth === null
    && comp.path
    && comp.path.segments.length > 1,
  ));
  const allChainComps = [...paintedFillComps, ...supportFillComps, ...boundaryStrokes];
  const groups = buildLegacyFillRenderGroups(allChainComps, options);
  return groups.some(group =>
    canRenderLegacyChainedFillComponents(allChainComps, group.allChainIndices, tolerance),
  );
}

function renderLegacyExplicitFillShape(
  ctx: CanvasRenderingContext2D,
  shape: TVGShape,
  strokeComps: TVGComponent[],
  alphaScale = 1,
  options: LegacyFillRenderOptions = {},
): boolean {
  const chainableFillComps = expandLegacyChainComponents(shape.components.filter(comp =>
    (comp.componentType === 0 || comp.componentType === 1)
    && comp.path
    && comp.path.segments.length > 1
    && !isDegenerate(comp.path)
    && (!comp.color || comp.color.a > 0)
  ));
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
  const boundaryStrokes = expandLegacyChainComponents(strokeComps.filter(comp =>
    comp.componentType === 2
    && comp.strokeWidth === null
    && comp.path
    && comp.path.segments.length > 1,
  ));
  const allChainComps = [...paintedFillComps, ...supportFillComps, ...boundaryStrokes];
  const groups = buildLegacyFillRenderGroups(allChainComps, options);
  if (groups.length === 0) return false;
  if (groups.length === 1) {
    return renderLegacyChainedFillComponents(ctx, allChainComps, groups[0].allChainIndices, tolerance, alphaScale, options);
  }

  let rendered = false;
  for (const group of groups) {
    rendered = renderLegacyChainedFillComponents(
      ctx,
      allChainComps,
      group.allChainIndices,
      tolerance,
      alphaScale,
      options,
    ) || rendered;
  }
  return rendered;
}

function renderLegacyExplicitFillShapeWithSiblingSubtraction(
  ctx: CanvasRenderingContext2D,
  shape: TVGShape,
  strokeComps: TVGComponent[],
  siblingBlockers: TVGShape[],
  alphaScale = 1,
  options: LegacyFillRenderOptions = {},
): boolean {
  if (siblingBlockers.length === 0) {
    return renderLegacyExplicitFillShape(ctx, shape, strokeComps, alphaScale, options);
  }
  const canvas = document.createElement('canvas');
  canvas.width = ctx.canvas.width;
  canvas.height = ctx.canvas.height;
  const scratch = canvas.getContext('2d');
  if (!scratch) {
    return renderLegacyExplicitFillShape(ctx, shape, strokeComps, alphaScale, options);
  }
  scratch.setTransform(ctx.getTransform());
  if (!renderLegacyExplicitFillShape(scratch, shape, strokeComps, alphaScale, options)) {
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
  shape.components.forEach((comp, componentIndex) => {
    if (comp.componentType !== 4 || !comp.path || isDegenerate(comp.path)) return;
    if (!paintHasVisibleAlpha(comp.contourPaint) || isNearlyBlackSolidPaint(comp.contourPaint)) return;
    const syntheticStyle = createSyntheticStyleComponent(comp.contourPaint!);
    const styleKey = paintKeyForComponent(syntheticStyle);
    if (!styleKey) return;
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

function canRenderLegacyFillComponents(
  components: TVGComponent[],
  tolerance: number,
): boolean {
  if (components.length === 0) return false;
  const indices = components.map((_, index) => index);
  const { drawableChains, autoCloseChains } = buildLegacyChains(components, indices, tolerance);
  if (drawableChains.length === 0) return false;
  return drawableChains.every(chain =>
    isLegacyChainClosed(chain, tolerance) || autoCloseChains.has(chain),
  );
}

function collectPencilStrokeLegacyFillComponents(
  shape: TVGShape,
  fillPaint: TVGPaint,
  defaultStrokeWidth: number,
  sourcePaint: TVGPaint | null = fillPaint,
): TVGComponent[] {
  const sourceKey = sourcePaint ? paintKeyForComponent(createSyntheticStyleComponent(sourcePaint)) : null;
  const maxAllowedWidth = Math.max(defaultStrokeWidth * 1.5, 6);
  return shape.components.flatMap(comp => {
    if (comp.componentType !== 4 || !comp.path) return [];
    if (sourceKey && paintKeyForComponent(comp) !== sourceKey) return [];
    const profile = resolveStrokeProfile(comp, defaultStrokeWidth);
    const maxWidth = profile ? getMaxProfileWidth(profile) : defaultStrokeWidth;
    if (maxWidth > maxAllowedWidth) return [];
    return [{
      ...comp,
      componentType: 0,
      fillPaintSource: 'explicit',
      outerPaint: fillPaint,
      color: fillPaint.kind === 'solid' ? { ...fillPaint.rgba } : comp.color,
    }];
  });
}

function collectThinPencilLegacyFillComponents(
  shape: TVGShape,
  pencilStyle: TVGPaint,
  defaultStrokeWidth: number,
): TVGComponent[] {
  return collectPencilStrokeLegacyFillComponents(shape, pencilStyle, defaultStrokeWidth, pencilStyle);
}

function canRenderThinPencilLegacyFill(
  shape: TVGShape,
  pencilStyle: TVGPaint,
  defaultStrokeWidth: number,
): boolean {
  const tolerance = 2.0;
  return canRenderLegacyFillComponents(
    collectThinPencilLegacyFillComponents(shape, pencilStyle, defaultStrokeWidth),
    tolerance,
  );
}

function selectPurePencilLoopFillPaint(
  shape: TVGShape,
  strokeComps: TVGComponent[],
  defaultBoundaryFillColor: { r: number; g: number; b: number; a: number } | null | undefined,
  defaultStrokeWidth: number,
): { fillPaint: TVGPaint; sourcePaint: TVGPaint } | null {
  const isSingleClosedPencilPath = strokeComps.length === 1
    && strokeComps[0].path?.closed === true
    && strokeComps[0].path.segments.filter(segment => segment.type !== 'M').length >= 2;
  if (strokeComps.length < 3 && !isSingleClosedPencilPath) return null;
  if (!shape.components.every(comp => comp.componentType === 4 && !!comp.path && comp.path.segments.length > 0)) {
    return null;
  }
  if (shape.components.some(comp => isConstructionGuidePaint(comp.outerPaint))) return null;

  const paintKeys = new Set(
    strokeComps
      .map(comp => paintKeyForComponent(comp))
      .filter((key): key is FillStyleKey => key !== null),
  );
  if (paintKeys.size !== 1) return null;

  const sourcePaint = strokeComps[0].outerPaint;
  if (!paintHasVisibleAlpha(sourcePaint)) return null;

  const sourceFillComps = collectPencilStrokeLegacyFillComponents(
    shape,
    sourcePaint!,
    defaultStrokeWidth,
    sourcePaint,
  );
  if (!canRenderLegacyFillComponents(sourceFillComps, 2.0)) return null;

  const contourPaint = strokeComps.find(comp => paintHasVisibleAlpha(comp.contourPaint))?.contourPaint ?? null;
  if (contourPaint && !paintsEqual(contourPaint, sourcePaint)) {
    return { fillPaint: contourPaint, sourcePaint: sourcePaint! };
  }

  if (isNearlyBlackSolidPaint(sourcePaint)) {
    if (defaultBoundaryFillColor) {
      const fillPaint = cloneSolidPaint(defaultBoundaryFillColor);
      if (!isNearlyBlackSolidPaint(fillPaint)) {
        return { fillPaint, sourcePaint: sourcePaint! };
      }
    }
    if (isSingleClosedPencilPath) {
      return { fillPaint: sourcePaint!, sourcePaint: sourcePaint! };
    }
    return null;
  }

  return { fillPaint: sourcePaint!, sourcePaint: sourcePaint! };
}

function renderPurePencilLoopFill(
  ctx: CanvasRenderingContext2D,
  shape: TVGShape,
  fillPaint: TVGPaint,
  sourcePaint: TVGPaint,
  defaultStrokeWidth: number,
): boolean {
  const legacyFillComps = collectPencilStrokeLegacyFillComponents(
    shape,
    fillPaint,
    defaultStrokeWidth,
    sourcePaint,
  );
  if (legacyFillComps.length === 0) return false;
  return renderLegacyChainedFillComponents(
    ctx,
    legacyFillComps,
    legacyFillComps.map((_, index) => index),
    2.0,
  );
}

function renderThinPencilLegacyFill(
  ctx: CanvasRenderingContext2D,
  shape: TVGShape,
  pencilStyle: TVGPaint,
  defaultStrokeWidth: number,
): boolean {
  const legacyFillComps = collectThinPencilLegacyFillComponents(shape, pencilStyle, defaultStrokeWidth);
  if (legacyFillComps.length === 0) return false;
  const tolerance = 2.0;
  if (!canRenderLegacyFillComponents(legacyFillComps, tolerance)) return false;
  const indices = legacyFillComps.map((_, index) => index);
  return renderLegacyChainedFillComponents(ctx, legacyFillComps, indices, tolerance);
}

function renderThinPencilExplicitFill(
  ctx: CanvasRenderingContext2D,
  layer: TVGArtLayer,
  shape: TVGShape,
  shapeIndex: number,
  pencilStyle: TVGPaint,
  defaultStrokeWidth: number,
): boolean {
  const syntheticFillComps = collectThinPencilLegacyFillComponents(shape, pencilStyle, defaultStrokeWidth);
  if (syntheticFillComps.length === 0) return false;
  const syntheticShape = { ...shape, components: syntheticFillComps };
  const explicitBuild = buildContoursForShape(
    collectExplicitFillFragments(syntheticShape, layer.type, shapeIndex),
    false,
  );
  if (explicitBuild.contours.length > 0) {
    paintContourTree(ctx, explicitBuild.contours.sort((a, b) => a.sourceOrder - b.sourceOrder));
    return true;
  }
  return renderLegacyExplicitFillShape(ctx, syntheticShape, []);
}

function analyzeThinPencilFallback(
  layer: TVGArtLayer,
  shape: TVGShape,
  shapeIndex: number,
  strokeComps: TVGComponent[],
  defaultStrokeWidth: number,
): {
  dominantPaint: TVGPaint;
  contourBuild: TVGFillBuildResult | null;
  canLegacyFill: boolean;
  canExplicitFill: boolean;
  renderAsFillOnly: boolean;
} | null {
  const pencilComps = strokeComps.filter(comp =>
    comp.componentType === 4
    && comp.path
    && comp.outerPaint?.kind === 'solid'
    && comp.outerPaint.rgba.r >= 30
    && comp.outerPaint.rgba.g >= 30
    && comp.outerPaint.rgba.b >= 30,
  );
  if (!shouldAllowThinPencilContourFallback(layer, shape, strokeComps, pencilComps)) return null;

  const counts = new Map<string, { count: number; paint: TVGPaint }>();
  for (const comp of pencilComps) {
    const paint = comp.outerPaint!;
    const key = JSON.stringify(paint);
    const entry = counts.get(key) || { count: 0, paint };
    entry.count++;
    counts.set(key, entry);
  }
  const dominant = Array.from(counts.values()).sort((a, b) => b.count - a.count)[0];
  if (!dominant) return null;

  const contourFragments = collectThinPencilFragments(shape, layer.type, shapeIndex, dominant.paint, defaultStrokeWidth);
  const contourBuild = contourFragments.length > 0
    ? buildContoursForShape(contourFragments, true)
    : null;
  const canLegacyFill = canRenderThinPencilLegacyFill(shape, dominant.paint, defaultStrokeWidth);
  const syntheticFillComps = collectThinPencilLegacyFillComponents(shape, dominant.paint, defaultStrokeWidth);
  const syntheticExplicitBuild = syntheticFillComps.length > 0
    ? buildContoursForShape(
      collectExplicitFillFragments({ ...shape, components: syntheticFillComps }, layer.type, shapeIndex),
      false,
    )
    : null;
  const canExplicitFill = (syntheticExplicitBuild?.contours.length ?? 0) > 0
    || canRenderLegacyFillComponents(syntheticFillComps, 2.0);
  if ((contourBuild?.contours.length ?? 0) === 0 && !canLegacyFill && !canExplicitFill) return null;

  const paintKeys = new Set(
    pencilComps
      .map(comp => paintKeyForComponent(comp))
      .filter((key): key is FillStyleKey => key !== null),
  );
  const renderAsFillOnly = shape.components.length > 0
    && shape.components.every(comp => comp.componentType === 4 && !!comp.path && comp.path.segments.length > 0)
    && pencilComps.length === strokeComps.length
    && paintKeys.size === 1
    && !isNearlyBlackSolidPaint(dominant.paint)
    && canExplicitFill;

  return {
    dominantPaint: dominant.paint,
    contourBuild,
    canLegacyFill,
    canExplicitFill,
    renderAsFillOnly,
  };
}

function normalizeThinPencilFillOnlyShapes(
  drawing: TVGDrawing,
  defaultStrokeWidth: number,
): TVGDrawing {
  let normalizedDrawing: TVGDrawing | null = null;
  for (let layerIndex = 0; layerIndex < drawing.layers.length; layerIndex++) {
    const layer = drawing.layers[layerIndex];
    for (let shapeIndex = 0; shapeIndex < layer.shapes.length; shapeIndex++) {
      const shape = layer.shapes[shapeIndex];
      const strokeComps = shape.components.filter(comp =>
        (comp.componentType === 4 || comp.componentType === 2)
        && comp.path
        && comp.path.segments.length > 0,
      );
      const purePencilLoopFill = selectPurePencilLoopFillPaint(shape, strokeComps, null, defaultStrokeWidth);
      if (purePencilLoopFill && !paintsEqual(purePencilLoopFill.fillPaint, purePencilLoopFill.sourcePaint)) {
        // Contour-colored pencil loops need both passes: contourPaint fills the
        // enclosed region, while the original outer paint remains the outline.
        continue;
      }
      const thinPencilFallback = analyzeThinPencilFallback(
        layer,
        shape,
        shapeIndex,
        strokeComps,
        defaultStrokeWidth,
      );
      if (!thinPencilFallback?.renderAsFillOnly || !thinPencilFallback.canExplicitFill) {
        continue;
      }
      if (!normalizedDrawing) {
        normalizedDrawing = structuredClone(drawing);
      }
      const normalizedShape = normalizedDrawing.layers[layerIndex].shapes[shapeIndex];
      normalizedShape.components = collectThinPencilLegacyFillComponents(
        normalizedShape,
        thinPencilFallback.dominantPaint,
        defaultStrokeWidth,
      );
    }
  }
  return normalizedDrawing ?? drawing;
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
    componentIndexes: number[];
    bbox: { minX: number; minY: number; maxX: number; maxY: number };
    childCount: number;
  }>;
  unresolvedChains: Array<{
    styleKey: FillStyleKey;
    sourceOrder: number;
    fragmentCount: number;
    styledFragmentCount: number;
    supportFragmentCount: number;
    componentIndexes: number[];
    bbox: { minX: number; minY: number; maxX: number; maxY: number };
    closeDistance: number;
    allowSupportDominatedAutoClose: boolean;
    supportDominatedRejectRatio: number | null;
    rebuildsAsContour: boolean;
    rebuiltSamplePoint: { x: number; y: number } | null;
  }>;
} {
  const fragments = collectExplicitFillFragments(shape, layerType, shapeIndex);
  const build = buildContoursForShape(fragments, false);
  const tree = buildContourTree(build.contours);
  const styleFragmentsForContour = (styleKey: FillStyleKey) =>
    fragments.filter(fragment => fragment.styleKey === styleKey || fragment.supportOnly);
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
    contours: build.contours.map((contour, index) => {
      const styleFragments = styleFragmentsForContour(contour.styleKey);
      return {
        styleKey: contour.styleKey,
        sourceOrder: contour.sourceOrder,
        fragmentCount: contour.fragmentCount,
        styledFragmentCount: contour.styledFragmentCount,
        supportFragmentCount: contour.supportFragmentCount,
        componentIndexes: contour.fragments.map(ref => styleFragments[ref.fragmentIndex]?.componentIndex ?? -1),
        bbox: contour.bbox,
        childCount: tree[index]?.children.length ?? 0,
      };
    }),
    unresolvedChains: build.unresolvedChains.map(contour => {
      const styleFragments = styleFragmentsForContour(contour.styleKey);
      const head = contour.fragments[0];
      const tail = contour.fragments[contour.fragments.length - 1];
      const startFragment = styleFragments[head.fragmentIndex];
      const endFragment = styleFragments[tail.fragmentIndex];
      const startPoint = head.reversed
        ? { x: startFragment?.endX ?? 0, y: startFragment?.endY ?? 0 }
        : { x: startFragment?.startX ?? 0, y: startFragment?.startY ?? 0 };
      const endPoint = tail.reversed
        ? { x: endFragment?.startX ?? 0, y: endFragment?.startY ?? 0 }
        : { x: endFragment?.endX ?? 0, y: endFragment?.endY ?? 0 };
      const closeDistance = Math.hypot(startPoint.x - endPoint.x, startPoint.y - endPoint.y);
      const allowSupportDominatedAutoClose = shouldAllowSupportDominatedContourAutoClose(
        styleFragments,
        contour.fragments,
        contour.synthesized,
        contour.styledFragmentCount,
        contour.supportFragmentCount,
        closeDistance,
        contour.bbox,
        startPoint,
        endPoint,
      );
      const bboxArea = (contour.bbox.maxX - contour.bbox.minX) * (contour.bbox.maxY - contour.bbox.minY);
      const polyArea = polygonArea(contour.flattened);
      const rebuilt = buildResolvedContour(
        styleFragments,
        contour.fragments.map(ref => ({ ...ref })),
        contour.styleKey,
        contour.style,
        contour.synthesized,
      );
      return {
        styleKey: contour.styleKey,
        sourceOrder: contour.sourceOrder,
        fragmentCount: contour.fragmentCount,
        styledFragmentCount: contour.styledFragmentCount,
        supportFragmentCount: contour.supportFragmentCount,
        componentIndexes: contour.fragments.map(ref => styleFragments[ref.fragmentIndex]?.componentIndex ?? -1),
        bbox: contour.bbox,
        closeDistance,
        allowSupportDominatedAutoClose,
        supportDominatedRejectRatio: bboxArea > 0 ? polyArea / bboxArea : null,
        rebuildsAsContour: rebuilt !== null,
        rebuiltSamplePoint: rebuilt?.samplePoint ?? null,
      };
    }),
  };
}

export function __debugBuildLegacyChainsForShape(
  shape: TVGShape,
  strokeComps: TVGComponent[] = shape.components.filter(comp =>
    (comp.componentType === 2 || comp.componentType === 4)
    && comp.path
    && comp.path.segments.length > 1,
  ),
  options: {
    supportInheritedCrossPaint?: boolean;
    includeNullPaintFillBoundaries?: boolean;
  } = {},
): {
  allChainComponents: Array<{
    allChainIndex: number;
    componentIndex: number;
    componentType: number;
    fillPaintSource: TVGComponent['fillPaintSource'];
    paintKey: FillStyleKey | null;
    hasPaint: boolean;
  }>;
  groups: Array<{
    key: string;
    allChainIndices: number[];
    componentIndexes: number[];
    chains: Array<{ componentIndexes: number[]; closed: boolean }>;
    drawableChains: Array<{
      componentIndexes: number[];
      closed: boolean;
      parent: number;
      bbox: { minX: number; minY: number; maxX: number; maxY: number };
      area: number;
      signedArea: number;
      samplePoint: { x: number; y: number } | null;
    }>;
  }>;
} {
  const componentIndexByRef = new Map(shape.components.map((comp, index) => [comp, index]));
  const chainableFillComps = shape.components.filter(comp =>
    (comp.componentType === 0 || comp.componentType === 1)
    && comp.path
    && comp.path.segments.length > 1
    && !isDegenerate(comp.path)
    && (!comp.color || comp.color.a > 0),
  );
  const paintedFillComps = chainableFillComps.filter(comp => comp.outerPaint !== null);
  const supportFillComps = chainableFillComps.filter(comp => comp.outerPaint === null);
  const boundaryStrokes = strokeComps.filter(comp =>
    comp.componentType === 2
    && comp.strokeWidth === null
    && comp.path
    && comp.path.segments.length > 1,
  );
  const allChainComps = [...paintedFillComps, ...supportFillComps, ...boundaryStrokes];
  const groups = buildLegacyFillRenderGroups(allChainComps, options)
    .map(group => {
      const { chains, drawableChains } = buildLegacyChains(allChainComps, group.allChainIndices, 2.0);
      const { chainGeometries, parent } = analyzeLegacyDrawableChains(drawableChains, allChainComps);
      const toDebugChain = (chain: LegacyChainLink[]) => ({
        componentIndexes: chain.map(link => componentIndexByRef.get(allChainComps[link.ci]) ?? -1),
        closed: Math.abs(chain[0].startX - chain[chain.length - 1].endX) + Math.abs(chain[0].startY - chain[chain.length - 1].endY) < 4,
      });
      return {
        key: group.key,
        allChainIndices: group.allChainIndices,
        componentIndexes: group.allChainIndices.map(index => componentIndexByRef.get(allChainComps[index]) ?? -1),
        chains: chains.map(toDebugChain),
        drawableChains: drawableChains.map((chain, index) => ({
          ...toDebugChain(chain),
          parent: parent[index],
          bbox: chainGeometries[index].bbox,
          area: chainGeometries[index].area,
          signedArea: chainGeometries[index].signedArea,
          samplePoint: chainGeometries[index].samplePoint,
        })),
      };
    });

  return {
    allChainComponents: allChainComps.map((comp, allChainIndex) => ({
      allChainIndex,
      componentIndex: componentIndexByRef.get(comp) ?? -1,
      componentType: comp.componentType,
      fillPaintSource: comp.fillPaintSource,
      paintKey: paintKeyForComponent(comp),
      hasPaint: comp.outerPaint !== null,
    })),
    groups,
  };
}

export function __debugTraceLegacyChainSelectionsForShape(
  shape: TVGShape,
  strokeComps: TVGComponent[] = shape.components.filter(comp =>
    (comp.componentType === 2 || comp.componentType === 4)
    && comp.path
    && comp.path.segments.length > 1,
  ),
  options: {
    supportInheritedCrossPaint?: boolean;
    includeNullPaintFillBoundaries?: boolean;
  } = {},
): {
  allChainComponents: Array<{
    allChainIndex: number;
    componentIndex: number;
    componentType: number;
    fillPaintSource: TVGComponent['fillPaintSource'];
    paintKey: FillStyleKey | null;
    hasPaint: boolean;
    segmentCount: number;
    chord: number;
  }>;
  groups: Array<{
    key: string;
    picks: Array<{
      chainComponentIndexes: number[];
      selectedComponentIndex: number | null;
      selectedAllChainIndex: number | null;
      selectedReversed: boolean | null;
      selectedPrepend: boolean | null;
      candidates: Array<{
        componentIndex: number;
        allChainIndex: number;
        componentType: number;
        fillPaintSource: TVGComponent['fillPaintSource'];
        paintKey: FillStyleKey | null;
        hasPaint: boolean;
        segmentCount: number;
        chord: number;
        rank: number;
        reversed: boolean;
        prepend: boolean;
        distance: number;
        support: number;
        turn: number;
        decision: LegacyChainCandidateTrace['decision'];
      }>;
    }>;
  }>;
} {
  const componentIndexByRef = new Map(shape.components.map((comp, index) => [comp, index]));
  const chainableFillComps = shape.components.filter(comp =>
    (comp.componentType === 0 || comp.componentType === 1)
    && comp.path
    && comp.path.segments.length > 1
    && !isDegenerate(comp.path)
    && (!comp.color || comp.color.a > 0),
  );
  const paintedFillComps = chainableFillComps.filter(comp => comp.outerPaint !== null);
  const supportFillComps = chainableFillComps.filter(comp => comp.outerPaint === null);
  const boundaryStrokes = strokeComps.filter(comp =>
    comp.componentType === 2
    && comp.strokeWidth === null
    && comp.path
    && comp.path.segments.length > 1,
  );
  const allChainComps = [...paintedFillComps, ...supportFillComps, ...boundaryStrokes];
  const groups = buildLegacyFillRenderGroups(allChainComps, options)
    .map(group => {
      const pickTrace: LegacyChainPickTrace[] = [];
      buildLegacyChains(allChainComps, group.allChainIndices, 2.0, pickTrace);
      return {
        key: group.key,
        picks: pickTrace.map(pick => ({
          chainComponentIndexes: pick.chainAllChainIndices.map(index => componentIndexByRef.get(allChainComps[index]) ?? -1),
          selectedComponentIndex: pick.selectedAllChainIndex !== null
            ? componentIndexByRef.get(allChainComps[pick.selectedAllChainIndex]) ?? -1
            : null,
          selectedAllChainIndex: pick.selectedAllChainIndex,
          selectedReversed: pick.selectedReversed,
          selectedPrepend: pick.selectedPrepend,
          candidates: pick.candidates.map(candidate => {
            const comp = allChainComps[candidate.allChainIndex];
            const segs = comp.path?.segments ?? [];
            const first = segs[0];
            const last = segs[segs.length - 1];
            return {
              componentIndex: componentIndexByRef.get(comp) ?? -1,
              allChainIndex: candidate.allChainIndex,
              componentType: comp.componentType,
              fillPaintSource: comp.fillPaintSource,
              paintKey: paintKeyForComponent(comp),
              hasPaint: comp.outerPaint !== null,
              segmentCount: segs.length,
              chord: first && last ? Math.hypot(last.x - first.x, last.y - first.y) : 0,
              rank: candidate.rank,
              reversed: candidate.reversed,
              prepend: candidate.prepend,
              distance: candidate.distance,
              support: candidate.support,
              turn: candidate.turn,
              decision: candidate.decision,
            };
          }),
        })),
      };
    });

  return {
    allChainComponents: allChainComps.map((comp, allChainIndex) => {
      const segs = comp.path?.segments ?? [];
      const first = segs[0];
      const last = segs[segs.length - 1];
      return {
        allChainIndex,
        componentIndex: componentIndexByRef.get(comp) ?? -1,
        componentType: comp.componentType,
        fillPaintSource: comp.fillPaintSource,
        paintKey: paintKeyForComponent(comp),
        hasPaint: comp.outerPaint !== null,
        segmentCount: segs.length,
        chord: first && last ? Math.hypot(last.x - first.x, last.y - first.y) : 0,
      };
    }),
    groups,
  };
}

export function __debugLineFillDecisions(
  layer: TVGArtLayer,
): Array<{
  shapeIndex: number;
  componentCount: number;
  fillComponentCount: number;
  fillPaintKeyCount: number;
  explicitFillCount: number;
  inheritedFillCount: number;
  resolvedContourCount: number;
  unresolvedChainCount: number;
  preRenderPriority: number;
  preRenderMode: LineFillPreRenderPlan['mode'];
  preRenderPaintKey: FillStyleKey | null;
  suppressLargeNearBlack: boolean;
  suppressSeedCarrier: boolean;
}> {
  return layer.shapes.map((shape, shapeIndex) => {
    const strokeComps = shape.components.filter(comp =>
      (comp.componentType === 4 || comp.componentType === 2)
      && comp.path
      && comp.path.segments.length > 0,
    );
    const explicitBuild = buildContoursForShape(collectExplicitFillFragments(shape, layer.type, shapeIndex), false);
    const fillComps = renderableFillComponents(shape);
    const preRenderPlan = planLineFillPreRender(layer, shape, shapeIndex);
    return {
      shapeIndex,
      componentCount: shape.components.length,
      fillComponentCount: fillComps.length,
      fillPaintKeyCount: renderableFillPaintKeys(shape).size,
      explicitFillCount: fillComps.filter(comp => hasExplicitFillStyle(comp)).length,
      inheritedFillCount: fillComps.filter(comp => comp.fillPaintSource === 'inherited').length,
      resolvedContourCount: explicitBuild.contours.length,
      unresolvedChainCount: explicitBuild.unresolvedChains.length,
      preRenderPriority: preRenderPlan.priority,
      preRenderMode: preRenderPlan.mode,
      preRenderPaintKey: preRenderPlan.preRenderPaintKey,
      suppressLargeNearBlack: shouldSuppressLargeNearBlackLineFillShape(layer, shape, shapeIndex, strokeComps, explicitBuild.contours.length),
      suppressSeedCarrier: shouldSuppressSeedCarrierFillShape(layer, shape, layer.shapes),
    };
  });
}

export function __debugAnalyzeLineFillShapeRenderPath(
  layer: TVGArtLayer,
  shapeIndex: number,
  options?: TVGFillRenderOptions,
): {
  shapeIndex: number;
  resolvedContourCount: number;
  unresolvedChainCount: number;
  siblingBoundaryMaskCount: number;
  nearBlackSiblingFillBlockerCount: number;
  fillCarrierCount: number;
  fillPaintKeyCount: number;
  explicitFillPaintKeyCount: number;
  hasInheritedFillCarriers: boolean;
  suppressLargeNearBlack: boolean;
  suppressSeedCarrier: boolean;
  shouldPreferSiblingBoundaryClip: boolean;
  shouldPaintSmallUnresolvedDirectly: boolean;
  shouldPreferMaskedRectUnresolvedFill: boolean;
  shouldPreferLegacyInheritedFillShape: boolean;
  shouldPreferLegacyInheritedOnlyShape: boolean;
  shouldPreferLegacyUnresolvedFillOnlyShape: boolean;
  shouldPreferLegacyMixedDominantUnresolvedLineFill: boolean;
  shouldSkipLegacyForPureOpenUnresolved: boolean;
  shouldPreferLegacy: boolean;
  shouldClipResolvedContours: boolean;
  hasLocalClipMask: boolean;
  expectedPrimaryPath:
    | 'suppress-large-near-black'
    | 'suppress-seed-carrier'
    | 'sibling-boundary-clip'
    | 'paint-small-unresolved'
    | 'masked-rect-unresolved'
    | 'legacy'
    | 'resolved-contours-clipped'
    | 'resolved-contours'
    | 'unresolved-clipped'
    | 'legacy-after-explicit'
    | 'boundary-fallback';
} | null {
  type LineFillDebugPrimaryPath =
    | 'suppress-large-near-black'
    | 'suppress-seed-carrier'
    | 'sibling-boundary-clip'
    | 'paint-small-unresolved'
    | 'masked-rect-unresolved'
    | 'legacy'
    | 'resolved-contours-clipped'
    | 'resolved-contours'
    | 'unresolved-clipped'
    | 'legacy-after-explicit'
    | 'boundary-fallback';
  const shape = layer.shapes[shapeIndex];
  if (!shape) return null;
  const sameLayerShapes = layer.shapes;
  const strokeComps = shape.components.filter(c => (c.componentType === 4 || c.componentType === 2) && c.path && c.path.segments.length > 0);
  const explicitBuild = buildContoursForShape(collectExplicitFillFragments(shape, layer.type, shapeIndex), false);
  const suppressLargeNearBlack = shouldSuppressLargeNearBlackLineFillShape(
    layer,
    shape,
    shapeIndex,
    strokeComps,
    explicitBuild.contours.length,
    sameLayerShapes,
  );
  const suppressSeedCarrier = shouldSuppressSeedCarrierFillShape(layer, shape, sameLayerShapes);
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
    ? collectOverlappingNearBlackRenderableFillShapes(shape, sameLayerShapes)
    : [];
  const shouldPreferSiblingBoundaryClip = !options?.skipClipping
    && strokeComps.length === 0
    && fillCarrierCount > 0
    && fillCarrierCount <= 12
    && fillPaintKeys.size === 1
    && explicitBuild.contours.length === 0
    && siblingBoundaryMaskShapes.length >= 4
    && dominantFillPaint !== null;
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
      && chain.supportFragmentCount >= 8
      && isContourGeometryClosed(chain)
    );
  const shouldPreferLegacyInheritedFillShape = layer.type === 'line'
    && strokeComps.length === 0
    && fillCarrierCount >= 2
    && hasInheritedFillCarriers
    && explicitBuild.contours.length === 0
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
  const shouldPreferLegacyMixedDominantUnresolvedLineFill =
    shouldPreferLegacyMixedDominantUnresolvedLineShape(
      layer,
      strokeComps,
      fillCarrierCount,
      hasInheritedFillCarriers,
      fillPaintKeys,
      explicitFillPaintKeys,
      explicitBuild,
    );
  const shouldSkipLegacyForPureOpenUnresolved = layer.type === 'line'
    && strokeComps.length === 0
    && siblingBoundaryMaskShapes.length === 0
    && explicitBuild.contours.length === 0
    && explicitBuild.unresolvedChains.length > 0
    && explicitBuild.unresolvedChains.every(chain =>
      chain.supportFragmentCount === 0
      && !isContourGeometryClosed(chain),
    )
    && (!hasInheritedFillCarriers || fillCarrierCount > 12 || fillPaintKeys.size > 1);
  const shouldPreferLegacy = (
    explicitBuild.unresolvedChains.length > explicitBuild.contours.length
    && explicitBuild.unresolvedChains.length > 0
  )
    || shouldPreferLegacyMixedDominantUnresolvedLineFill
    || shouldPreferLegacyInheritedFillShape
    || shouldPreferLegacyInheritedOnlyShape
    || shouldPreferLegacyUnresolvedFillOnlyShape;
  const shouldClipResolvedContours = !options?.skipClipping
    && strokeComps.length === 0
    && explicitBuild.contours.length > 0
    && siblingBoundaryMaskShapes.length > 0;
  const hasLocalClipMask = strokeComps.length > 0 || siblingBoundaryMaskShapes.length > 0;

  let expectedPrimaryPath: LineFillDebugPrimaryPath;
  if (suppressLargeNearBlack) expectedPrimaryPath = 'suppress-large-near-black';
  else if (suppressSeedCarrier) expectedPrimaryPath = 'suppress-seed-carrier';
  else if (shouldPreferSiblingBoundaryClip) expectedPrimaryPath = 'sibling-boundary-clip';
  else if (shouldPaintSmallUnresolvedDirectly) expectedPrimaryPath = 'paint-small-unresolved';
  else if (shouldPreferMaskedRectUnresolvedFill) expectedPrimaryPath = 'masked-rect-unresolved';
  else if (!shouldSkipLegacyForPureOpenUnresolved && (shouldPreferLegacy || explicitBuild.contours.length === 0)) expectedPrimaryPath = 'legacy';
  else if (shouldClipResolvedContours) expectedPrimaryPath = 'resolved-contours-clipped';
  else if (explicitBuild.contours.length > 0) expectedPrimaryPath = 'resolved-contours';
  else if (explicitBuild.unresolvedChains.length > 0 && !options?.skipClipping && hasLocalClipMask) expectedPrimaryPath = 'unresolved-clipped';
  else if (explicitBuild.unresolvedChains.length > 0 && !shouldSkipLegacyForPureOpenUnresolved) expectedPrimaryPath = 'legacy-after-explicit';
  else expectedPrimaryPath = 'boundary-fallback';

  return {
    shapeIndex,
    resolvedContourCount: explicitBuild.contours.length,
    unresolvedChainCount: explicitBuild.unresolvedChains.length,
    siblingBoundaryMaskCount: siblingBoundaryMaskShapes.length,
    nearBlackSiblingFillBlockerCount: nearBlackSiblingFillBlockers.length,
    fillCarrierCount,
    fillPaintKeyCount: fillPaintKeys.size,
    explicitFillPaintKeyCount: explicitFillPaintKeys.size,
    hasInheritedFillCarriers,
    suppressLargeNearBlack,
    suppressSeedCarrier,
    shouldPreferSiblingBoundaryClip,
    shouldPaintSmallUnresolvedDirectly,
    shouldPreferMaskedRectUnresolvedFill,
    shouldPreferLegacyInheritedFillShape,
    shouldPreferLegacyInheritedOnlyShape,
    shouldPreferLegacyUnresolvedFillOnlyShape,
    shouldPreferLegacyMixedDominantUnresolvedLineFill,
    shouldSkipLegacyForPureOpenUnresolved,
    shouldPreferLegacy,
    shouldClipResolvedContours,
    hasLocalClipMask,
    expectedPrimaryPath,
  };
}

export function __debugLineFillRenderStrategy(
  layer: TVGArtLayer,
  shapeIndex: number,
  allLayers?: TVGArtLayer[],
): {
  shapeIndex: number;
  fillCarrierCount: number;
  fillPaintKeyCount: number;
  explicitFillPaintKeyCount: number;
  hasInheritedFillCarriers: boolean;
  resolvedContourCount: number;
  unresolvedChainCount: number;
  siblingBoundaryMaskShapeCount: number;
  nearBlackSiblingFillBlockerCount: number;
  unresolvedChains: Array<{
    styledFragmentCount: number;
    supportFragmentCount: number;
    fragmentCount: number;
    closed: boolean;
    bbox: { minX: number; minY: number; maxX: number; maxY: number };
  }>;
  preRenderPlan: LineFillPreRenderPlan;
  suppressLargeNearBlack: boolean;
  suppressSeedCarrier: boolean;
  shouldPreferSiblingBoundaryClip: boolean;
  shouldPaintSmallUnresolvedDirectly: boolean;
  shouldPreferMaskedRectUnresolvedFill: boolean;
  shouldPreferLegacyInheritedFillShape: boolean;
  shouldPreferLegacyInheritedOnlyShape: boolean;
  shouldPreferLegacyUnresolvedFillOnlyShape: boolean;
  shouldPreferLegacyMixedDominantUnresolvedLineFill: boolean;
  shouldSkipLegacyForPureOpenUnresolved: boolean;
  shouldPreferLegacy: boolean;
  primaryCandidate:
    | 'suppress-large-near-black'
    | 'suppress-seed-carrier'
    | 'sibling-boundary-clip'
    | 'paint-small-unresolved-directly'
    | 'masked-rect-unresolved-fill'
    | 'legacy'
    | 'resolved-contours-or-fallback';
} {
  const shape = layer.shapes[shapeIndex];
  if (!shape) {
    throw new Error(`Shape ${shapeIndex} is out of range for layer with ${layer.shapes.length} shapes`);
  }

  const strokeComps = shape.components.filter(comp =>
    (comp.componentType === 4 || comp.componentType === 2)
    && comp.path
    && comp.path.segments.length > 0,
  );
  const explicitBuild = buildContoursForShape(collectExplicitFillFragments(shape, layer.type, shapeIndex), false);
  const sameLayerShapes = layer.shapes;
  const siblingBoundaryMaskShapes = collectSiblingBoundaryMaskShapes(allLayers, layer, shape);
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
    ? collectOverlappingNearBlackRenderableFillShapes(shape, sameLayerShapes)
    : [];
  const shouldPreferSiblingBoundaryClip = strokeComps.length === 0
    && fillCarrierCount > 0
    && fillCarrierCount <= 12
    && fillPaintKeys.size === 1
    && explicitBuild.contours.length === 0
    && siblingBoundaryMaskShapes.length >= 4
    && dominantFillPaint !== null;
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
  const shouldPreferMaskedRectUnresolvedFill = layer.type === 'line'
    && strokeComps.length === 0
    && fillCarrierCount >= 20
    && explicitBuild.contours.length === 0
    && explicitBuild.unresolvedChains.length > 0
    && fillPaintKeys.size >= 2
    && siblingBoundaryMaskShapes.length >= 4
    && explicitBuild.unresolvedChains.every(chain =>
      chain.styledFragmentCount === 1
      && chain.supportFragmentCount >= 8
      && isContourGeometryClosed(chain)
    );
  const shouldPreferLegacyInheritedFillShape = layer.type === 'line'
    && strokeComps.length === 0
    && fillCarrierCount >= 2
    && hasInheritedFillCarriers
    && explicitBuild.contours.length === 0
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
  const shouldPreferLegacyMixedDominantUnresolvedLineFill =
    shouldPreferLegacyMixedDominantUnresolvedLineShape(
      layer,
      strokeComps,
      fillCarrierCount,
      hasInheritedFillCarriers,
      fillPaintKeys,
      explicitFillPaintKeys,
      explicitBuild,
    );
  const shouldSkipLegacyForPureOpenUnresolved = layer.type === 'line'
    && strokeComps.length === 0
    && siblingBoundaryMaskShapes.length === 0
    && explicitBuild.contours.length === 0
    && explicitBuild.unresolvedChains.length > 0
    && explicitBuild.unresolvedChains.every(chain =>
      chain.supportFragmentCount === 0
      && !isContourGeometryClosed(chain),
    )
    && (!hasInheritedFillCarriers || fillCarrierCount > 12 || fillPaintKeys.size > 1);
  const shouldPreferLegacy = (
    explicitBuild.unresolvedChains.length > explicitBuild.contours.length
    && explicitBuild.unresolvedChains.length > 0
  )
    || shouldPreferLegacyMixedDominantUnresolvedLineFill
    || shouldPreferLegacyInheritedFillShape
    || shouldPreferLegacyInheritedOnlyShape
    || shouldPreferLegacyUnresolvedFillOnlyShape;
  const suppressLargeNearBlack = shouldSuppressLargeNearBlackLineFillShape(
    layer,
    shape,
    shapeIndex,
    strokeComps,
    explicitBuild.contours.length,
    sameLayerShapes,
  );
  const suppressSeedCarrier = shouldSuppressSeedCarrierFillShape(layer, shape, sameLayerShapes);
  const primaryCandidate = suppressLargeNearBlack
    ? 'suppress-large-near-black'
    : suppressSeedCarrier
      ? 'suppress-seed-carrier'
      : shouldPreferSiblingBoundaryClip
        ? 'sibling-boundary-clip'
        : shouldPaintSmallUnresolvedDirectly
          ? 'paint-small-unresolved-directly'
          : shouldPreferMaskedRectUnresolvedFill
            ? 'masked-rect-unresolved-fill'
            : (!shouldSkipLegacyForPureOpenUnresolved
                && (shouldPreferLegacy || explicitBuild.contours.length === 0))
              ? 'legacy'
              : 'resolved-contours-or-fallback';

  return {
    shapeIndex,
    fillCarrierCount,
    fillPaintKeyCount: fillPaintKeys.size,
    explicitFillPaintKeyCount: explicitFillPaintKeys.size,
    hasInheritedFillCarriers,
    resolvedContourCount: explicitBuild.contours.length,
    unresolvedChainCount: explicitBuild.unresolvedChains.length,
    siblingBoundaryMaskShapeCount: siblingBoundaryMaskShapes.length,
    nearBlackSiblingFillBlockerCount: nearBlackSiblingFillBlockers.length,
    unresolvedChains: explicitBuild.unresolvedChains.map(chain => ({
      styledFragmentCount: chain.styledFragmentCount,
      supportFragmentCount: chain.supportFragmentCount,
      fragmentCount: chain.fragmentCount,
      closed: isContourGeometryClosed(chain),
      bbox: chain.bbox,
    })),
    preRenderPlan: planLineFillPreRender(layer, shape, shapeIndex),
    suppressLargeNearBlack,
    suppressSeedCarrier,
    shouldPreferSiblingBoundaryClip,
    shouldPaintSmallUnresolvedDirectly,
    shouldPreferMaskedRectUnresolvedFill,
    shouldPreferLegacyInheritedFillShape,
    shouldPreferLegacyInheritedOnlyShape,
    shouldPreferLegacyUnresolvedFillOnlyShape,
    shouldPreferLegacyMixedDominantUnresolvedLineFill,
    shouldSkipLegacyForPureOpenUnresolved,
    shouldPreferLegacy,
    primaryCandidate,
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
  const renderEntries = layer.shapes.map((shape, shapeIndex) => ({
    shapeIndex,
    shape,
    preRenderPlan: pass === 'fill' && layer.type === 'line'
      ? planLineFillPreRender(layer, shape, shapeIndex)
      : {
          priority: 0,
          mode: 'full' as const,
          preRenderPaintKey: null,
        },
  }));
  if (pass === 'fill' && shouldUseLineFillBaseCarrierOrdering(layer, options?.allLayers)) {
    const canOrderBaseCarriersByCoverage = renderEntries.every(entry => entry.preRenderPlan.priority === 0);
    renderEntries.sort((a, b) => {
      const aOrder = isLineFillBaseCarrierShape(a.shape) ? 0 : 1;
      const bOrder = isLineFillBaseCarrierShape(b.shape) ? 0 : 1;
      if (aOrder !== bOrder) return aOrder - bOrder;
      if (aOrder === 0 && canOrderBaseCarriersByCoverage) {
        return lineFillBaseCarrierBoundsArea(b.shape) - lineFillBaseCarrierBoundsArea(a.shape)
          || a.shapeIndex - b.shapeIndex;
      }
      return a.shapeIndex - b.shapeIndex;
    });
  }
  const preRenderEntries = pass === 'fill' && layer.type === 'line'
    ? renderEntries
      .filter(entry => entry.preRenderPlan.priority > 0)
      .sort((a, b) => b.preRenderPlan.priority - a.preRenderPlan.priority || a.shapeIndex - b.shapeIndex)
    : [];
  const sameLayerShapes = layer.shapes;
  const preRenderedFullShapeIndexes = new Set<number>();
  const preRenderedLegacyPaintKeys = new Map<number, Set<FillStyleKey>>();
  if (pass === 'fill' && layer.type === 'line') {
    for (const { shapeIndex, shape, preRenderPlan } of preRenderEntries) {
      const strokeComps = shape.components.filter(comp =>
        (comp.componentType === 4 || comp.componentType === 2)
        && comp.path
        && comp.path.segments.length > 0,
      );
      const lowAlphaGuideFillScale = attenuateLowAlphaGuideFills
        && shape.components.length === 1
        && isLowAlphaSolidFillComponent(shape.components[0])
        ? 0.7
        : 1;
      if (preRenderPlan.mode === 'full') {
        if (renderLegacyExplicitFillShape(
          ctx,
          shape,
          strokeComps,
          lowAlphaGuideFillScale,
          { supportInheritedCrossPaint: true, layerType: layer.type },
        )) {
          preRenderedFullShapeIndexes.add(shapeIndex);
        }
        continue;
      }
      if (preRenderPlan.mode !== 'legacy-group' || !preRenderPlan.preRenderPaintKey) continue;
      if (renderLegacyExplicitFillShape(
        ctx,
        shape,
        strokeComps,
        lowAlphaGuideFillScale,
        {
          allowedPaintKeys: new Set([preRenderPlan.preRenderPaintKey]),
          includeNullPaintFillBoundaries: false,
          layerType: layer.type,
        },
      )) {
        preRenderedLegacyPaintKeys.set(shapeIndex, new Set([preRenderPlan.preRenderPaintKey]));
      }
    }
  }
  for (let renderShapeIndex = 0; renderShapeIndex < renderEntries.length; renderShapeIndex++) {
    const { shapeIndex, shape, preRenderPlan } = renderEntries[renderShapeIndex];
    const strokeComps = shape.components.filter(c => (c.componentType === 4 || c.componentType === 2) && c.path && c.path.segments.length > 0);
    const lowAlphaGuideFillScale = attenuateLowAlphaGuideFills
      && shape.components.length === 1
      && isLowAlphaSolidFillComponent(shape.components[0])
      ? 0.7
      : 1;
    if (shouldSuppressGuideOnlyConstructionShape(layer, shape, options?.allLayers)) {
      continue;
    }

    if (pass === 'fill') {
      if (preRenderedFullShapeIndexes.has(shapeIndex)) {
        continue;
      }

      const purePencilLoopFill = selectPurePencilLoopFillPaint(
        shape,
        strokeComps,
        options?.defaultBoundaryFillColor,
        defaultStrokeWidth,
      );
      if (purePencilLoopFill
        && renderPurePencilLoopFill(
          ctx,
          shape,
          purePencilLoopFill.fillPaint,
          purePencilLoopFill.sourcePaint,
          defaultStrokeWidth,
        )) {
        continue;
      }

      const explicitFragments = collectExplicitFillFragments(shape, layer.type, shapeIndex);
      const explicitBuild = buildContoursForShape(explicitFragments, false);
      if (shouldSuppressLargeNearBlackLineFillShape(
        layer,
        shape,
        shapeIndex,
        strokeComps,
        explicitBuild.contours.length,
        sameLayerShapes,
      )) {
        continue;
      }
      if (shouldSuppressSeedCarrierFillShape(layer, shape, sameLayerShapes)) {
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
        ? collectOverlappingNearBlackRenderableFillShapes(shape, sameLayerShapes)
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
          && chain.supportFragmentCount >= 8
          && isContourGeometryClosed(chain)
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
        && explicitBuild.contours.length === 0
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
      const shouldPreferLegacyMixedDominantUnresolvedLineFill =
        shouldPreferLegacyMixedDominantUnresolvedLineShape(
          layer,
          strokeComps,
          fillCarrierCount,
          hasInheritedFillCarriers,
          fillPaintKeys,
          explicitFillPaintKeys,
          explicitBuild,
        );
      const shouldSkipLegacyForPureOpenUnresolved = layer.type === 'line'
        && strokeComps.length === 0
        && siblingBoundaryMaskShapes.length === 0
        && explicitBuild.contours.length === 0
        && explicitBuild.unresolvedChains.length > 0
        && explicitBuild.unresolvedChains.every(chain =>
          chain.supportFragmentCount === 0
          && !isContourGeometryClosed(chain),
        )
        && (!hasInheritedFillCarriers || fillCarrierCount > 12 || fillPaintKeys.size > 1);
      const shouldPreferLegacy = (
        explicitBuild.unresolvedChains.length > explicitBuild.contours.length
        && explicitBuild.unresolvedChains.length > 0
      )
        || shouldPreferLegacyMixedDominantUnresolvedLineFill
        || shouldPreferLegacyInheritedFillShape
        || shouldPreferLegacyInheritedOnlyShape
        || shouldPreferLegacyUnresolvedFillOnlyShape;
      const preRenderedPaintKeys = preRenderedLegacyPaintKeys.get(shapeIndex);
      const embeddedDarkPaintKeys = collectEmbeddedDarkLegacyPaintKeysToSuppress(
        layer,
        shape,
        strokeComps,
        explicitBuild,
        fillCarrierCount,
        fillPaintKeys,
      );
      const blockedPaintKeys = new Set<FillStyleKey>([
        ...(preRenderPlan.mode === 'legacy-group' && preRenderedPaintKeys ? preRenderedPaintKeys : []),
        ...(embeddedDarkPaintKeys ?? []),
      ]);
      const legacyRenderOptions: LegacyFillRenderOptions = {
        layerType: layer.type,
        ...(blockedPaintKeys.size > 0 ? { blockedPaintKeys } : {}),
      };
      const legacyStrokeComps = strokeComps.length === 0
        ? collectSameLayerSupportBoundaryStrokes(layer, shape, shapeIndex)
        : strokeComps;
      if (!shouldSkipLegacyForPureOpenUnresolved
        && (shouldPreferLegacy || explicitBuild.contours.length === 0)
        && renderLegacyExplicitFillShapeWithSiblingSubtraction(
          ctx,
          shape,
          legacyStrokeComps,
          nearBlackSiblingFillBlockers,
          lowAlphaGuideFillScale,
          legacyRenderOptions,
        )) {
        continue;
      }
      let renderedExplicit = false;
      if (explicitBuild.contours.length > 0) {
        const sortedContours = [...explicitBuild.contours].sort((a, b) => a.sourceOrder - b.sourceOrder);
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
          legacyStrokeComps,
          nearBlackSiblingFillBlockers,
          lowAlphaGuideFillScale,
          legacyRenderOptions,
        )) {
        renderedExplicit = true;
      }
      if (renderedExplicit) continue;

      const shouldSuppressBoundaryFillFallback = isBoundaryOnlyShape(shape)
        && (isSparseBoundaryMarkerShape(shape)
          || hasSiblingRenderableFillShape(options?.allLayers, layer, shape));

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

      const thinPencilFallback = analyzeThinPencilFallback(layer, shape, shapeIndex, strokeComps, defaultStrokeWidth);
      if (thinPencilFallback) {
        if (thinPencilFallback.renderAsFillOnly
          && thinPencilFallback.canExplicitFill
          && renderThinPencilExplicitFill(
            ctx,
            layer,
            shape,
            shapeIndex,
            thinPencilFallback.dominantPaint,
            defaultStrokeWidth,
          )) {
          continue;
        }
        if ((thinPencilFallback.contourBuild?.contours.length ?? 0) > 0) {
          paintContourTree(ctx, thinPencilFallback.contourBuild!.contours.sort((a, b) => a.sourceOrder - b.sourceOrder));
          continue;
        }
        if (thinPencilFallback.canLegacyFill
          && renderThinPencilLegacyFill(ctx, shape, thinPencilFallback.dominantPaint, defaultStrokeWidth)) {
          continue;
        }
        if (layer.type !== 'line'
          && clipLocalFillSources(
            ctx,
            layer,
            shape,
            [{ kind: 'bbox', paint: thinPencilFallback.dominantPaint }],
            defaultStrokeWidth,
            !!options?.skipClipping,
            siblingBoundaryMaskShapes,
          )) {
          continue;
        }
      }
      continue;
    }

    if (pass === 'stroke') {
      const purePencilLoopFill = selectPurePencilLoopFillPaint(
        shape,
        strokeComps,
        options?.defaultBoundaryFillColor,
        defaultStrokeWidth,
      );
      const shouldKeepContourLoopStroke = purePencilLoopFill !== null
        && !paintsEqual(purePencilLoopFill.fillPaint, purePencilLoopFill.sourcePaint);
      const thinPencilFallback = analyzeThinPencilFallback(layer, shape, shapeIndex, strokeComps, defaultStrokeWidth);
      if (thinPencilFallback?.renderAsFillOnly && !shouldKeepContourLoopStroke) {
        continue;
      }
      for (const comp of strokeComps) {
        renderStrokeComponent(ctx, layer, shape, comp, defaultStrokeWidth, options?.diagnostics, options?.allLayers);
      }
    }
  }
  if (pass === 'stroke' && layer.textLabels && layer.textLabels.length > 0) {
    renderTextLabels(ctx, layer.textLabels);
  }
}

function renderTextLabels(ctx: CanvasRenderingContext2D, textLabels: TVGTextLabel[]): void {
  for (const label of textLabels) {
    const layout = computeTextLabelRenderLayout(label);
    if (!layout) continue;
    ctx.save();
    ctx.transform(
      layout.transform.a,
      layout.transform.b,
      layout.transform.c,
      layout.transform.d,
      layout.transform.e,
      layout.transform.f,
    );
    ctx.fillStyle = label.color
      ? `rgba(${label.color.r},${label.color.g},${label.color.b},${label.color.a / 255})`
      : '#000000';
    ctx.textAlign = layout.textAlign;
    ctx.textBaseline = layout.textBaseline;
    ctx.font = layout.font;
    layout.lines.forEach((line, index) => {
      ctx.fillText(line, 0, layout.baseY + index * layout.lineHeight);
    });
    ctx.restore();
  }
}

const MAX_TGTL_AXIS_SCALE = 1.3;

function compressTextLabelAxis(x: number, y: number): { x: number; y: number } {
  const length = Math.hypot(x, y);
  if (length <= 0.001) return { x, y };
  if (length <= MAX_TGTL_AXIS_SCALE) return { x, y };
  const scale = MAX_TGTL_AXIS_SCALE / length;
  return { x: x * scale, y: y * scale };
}

function computeTextLabelRenderLayout(label: TVGTextLabel): TVGTextLabelRenderLayout | null {
  const matrixB = label.matrixB ?? 0;
  const matrixC = label.matrixC ?? 0;
  const hasOffDiagonalTransform = Math.abs(matrixB) > 0.001 || Math.abs(matrixC) > 0.001;
  const maxTerm = Math.max(
    Math.abs(label.scaleX),
    Math.abs(matrixB),
    Math.abs(matrixC),
    Math.abs(label.scaleY),
  );
  if (maxTerm < 0.001) return null;

  const lines = label.text.replace(/_/g, ' ').split(/\r|\n/).filter(line => line.length > 0);
  const originalXAxis = { x: label.scaleX, y: matrixB };
  const originalYAxis = { x: matrixC, y: label.scaleY };
  const weight = /black/i.test(label.fontFamily) ? 'bold ' : '';
  const xAxis = compressTextLabelAxis(originalXAxis.x, originalXAxis.y);
  const yAxis = compressTextLabelAxis(originalYAxis.x, originalYAxis.y);
  const renderedFontSize = label.fontSize;
  const lineHeight = renderedFontSize * 1.2;
  return {
    // TGTL stores text size separately from the 2x2 orientation matrix, but
    // some labels carry exaggerated matrix magnitudes. Preserve orientation
    // and modest scaling, while capping oversized axes.
    transform: {
      a: xAxis.x,
      b: xAxis.y,
      c: yAxis.x,
      d: -yAxis.y,
      e: label.x,
      f: label.y,
    },
    textAlign: hasOffDiagonalTransform
      ? 'center'
      : label.scaleX < 0
        ? 'right'
        : 'left',
    textBaseline: 'alphabetic',
    font: `${weight}${renderedFontSize}px ${label.fontFamily}, sans-serif`,
    lines,
    lineHeight,
    baseY: hasOffDiagonalTransform ? -((lines.length - 1) * lineHeight) / 2 : 0,
    hasOffDiagonalTransform,
  };
}

export function __computeTextLabelRenderLayoutForTests(label: TVGTextLabel): TVGTextLabelRenderLayout | null {
  return computeTextLabelRenderLayout(label);
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
  allLayers?: TVGArtLayer[],
): void {
  if (!comp.path || comp.path.segments.length < 2) return;
  const xform = ctx.getTransform();
  const ctxScale = Math.hypot(xform.a, xform.b) || 1;
  const boundaryWidth = shouldRenderWidthlessBoundaryStroke(layer, shape, comp, allLayers)
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
