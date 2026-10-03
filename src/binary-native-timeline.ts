/**
 * Second timeline walker for pre-CS5 binary FLA streams, for the CS3/CS4 files
 * {@link decodeStreamTimeline} cannot walk. Ported from PR #45 (zndxcvbn).
 *
 * It reads the CPicPage → CPicLayer → CPicFrame tree with typed CPic readers,
 * and when a body does not parse it resyncs by scanning for frame tails, layer
 * tails and object tags. Those heuristics were tuned on SkyUI CS4 files, so
 * {@link decodeNativeStreamTimeline} keeps a result only when it passes the same
 * gate as the first walker plus a per-layer frame-count cross-check.
 */
import {
  ByteReader,
  edgeUnitsPerPx,
  readShapeData,
  rawEdgesToEdges,
  scanForShapes,
  type DecodedShapeData,
  type DecodedShape,
} from './binary-shape-decoder';
import {
  CArchiveReader,
  scanCArchiveObjectStarts,
  type CArchiveObjectHeader,
  type CArchiveObjectStart,
} from './binary-carchive';
import { decodeUtf16Le, readStrictFlashStringAt } from './binary-flash-string';
import { readCPicText, type CPicTextResult } from './binary-cpic-text';
import { readCPicPlacement, type CPicPlacement } from './binary-cpic-placement';
import {
  type CPicFrameTailProbe,
  findCPicFrameTailProbeInRange,
  isKnownCPicFrameKeyMode,
  isPlausibleCPicFrameTailAt,
} from './binary-cpic-frame-tail';
import type {
  DecodedKeyframe,
  DecodedStreamTimeline,
  DecodedTimelineLayer,
} from './binary-timeline-decoder';
import { isPlausibleLayerName } from './binary-timeline-decoder';
import {
  readCPicObjBase,
  readCPicObjLeafBase,
  type CPicChild,
  type CPicObjBase,
} from './binary-cpic-object';
import type { Matrix, Shape } from './types';

export interface NativeCPicFrame {
  header: CArchiveObjectHeader;
  base: CPicObjBase<NativeCPicChild>;
  bodyEnd: number;
  frameSchema: number;
  duration: number;
  keyMode: number;
  /** Tween ease (-100..100), from the modern frame tail only. */
  acceleration?: number;
  /** 1-based sound started by this frame (0 = none), modern frame tail only. */
  soundRef?: number;
  inlineDuration?: number;
  hasShapeTail?: boolean;
  inlineSegments?: NativeCPicInlineFrameSegment[];
  legacyShapes?: DecodedShape[];
  label?: string;
}

export interface NativeCPicInlineFrameSegment {
  bodyStart: number;
  bodyEnd: number;
  duration: number;
  keyMode: number;
  children: CPicChild<NativeCPicChild>[];
}

export interface NativeCPicLayer {
  header: CArchiveObjectHeader;
  base: CPicObjBase<NativeCPicFrame>;
  bodyEnd: number;
  layerSchema: number;
  name: string;
  locked: boolean;
  visible: boolean;
  parentLayerRef?: number;
  frames: NativeCPicFrame[];
}

export interface NativeCPicPage {
  header: CArchiveObjectHeader;
  base: CPicObjBase<NativeCPicLayer>;
  bodyEnd: number;
  layers: NativeCPicLayer[];
}

export interface NativeTimelineDecodeResult {
  ok: boolean;
  page: NativeCPicPage | null;
  error?: string;
}

export type NativeCPicChild =
  | { kind: 'shape'; header: CArchiveObjectHeader; bodyEnd: number; shape?: Shape; shapeData?: DecodedShapeData }
  | { kind: 'placement'; header: CArchiveObjectHeader; bodyEnd: number; placement: CPicPlacement }
  | { kind: 'placementShell'; header: CArchiveObjectHeader; bodyEnd: number }
  | { kind: 'text'; header: CArchiveObjectHeader; bodyEnd: number; text: CPicTextResult };

const CPIC_SYNC_CLASSES = new Set([
  'CPicPage',
  'CPicLayer',
  'CPicFrame',
  'CPicShape',
  'CPicSprite',
  'CPicSymbol',
  'CPicButton',
  'CPicShapeObj',
  'CPicText',
]);
const CHILD_CLASSES = ['CPicShape', 'CPicSprite', 'CPicSymbol', 'CPicButton', 'CPicShapeObj', 'CPicText'];
const PLACEMENT_CLASSES = new Set(['CPicSprite', 'CPicSymbol', 'CPicButton', 'CPicShapeObj']);

/**
 * The flat object scan of one stream, indexed for the walker's lookups (they
 * run per byte inside resync scans, so a linear filter per call was quadratic).
 */
interface ObjectStartIndex {
  /** All starts, sorted by bodyStart. */
  starts: CArchiveObjectStart[];
  bodyStarts: number[];
  /** Sorted bodyStarts per class. */
  byClass: Map<string, number[]>;
  /** First scanned start at each bodyStart. */
  atBodyStart: Map<number, CArchiveObjectStart>;
  bodyStartSet: ReadonlySet<number>;
}
const objectStartIndexCache = new WeakMap<Uint8Array, ObjectStartIndex>();

function objectStartIndex(data: Uint8Array): ObjectStartIndex {
  const cached = objectStartIndexCache.get(data);
  if (cached) return cached;
  const starts = scanCArchiveObjectStarts(data, CPIC_SYNC_CLASSES);
  const byClass = new Map<string, number[]>();
  const atBodyStart = new Map<number, CArchiveObjectStart>();
  for (const start of starts) {
    const list = byClass.get(start.className);
    if (list) list.push(start.bodyStart);
    else byClass.set(start.className, [start.bodyStart]);
    if (!atBodyStart.has(start.bodyStart)) atBodyStart.set(start.bodyStart, start);
  }
  const bodyStarts = starts.map((start) => start.bodyStart);
  const index = { starts, bodyStarts, byClass, atBodyStart, bodyStartSet: new Set(bodyStarts) };
  objectStartIndexCache.set(data, index);
  return index;
}

/** Index of the first element of sorted `values` greater than `after`. */
function upperBound(values: readonly number[], after: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] <= after) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Smallest scanned bodyStart > `after` among `classes`, or null. */
function nextScannedBody(data: Uint8Array, classes: readonly string[], after: number): number | null {
  const { byClass } = objectStartIndex(data);
  let best: number | null = null;
  for (const className of classes) {
    const list = byClass.get(className);
    if (!list) continue;
    const i = upperBound(list, after);
    if (i < list.length && (best === null || list[i] < best)) best = list[i];
  }
  return best;
}

/** Scanned placement starts with `after < bodyStart < before`, in order. */
function scannedPlacementsBetween(data: Uint8Array, after: number, before: number): CArchiveObjectStart[] {
  const { starts, bodyStarts } = objectStartIndex(data);
  const out: CArchiveObjectStart[] = [];
  for (let i = upperBound(bodyStarts, after); i < starts.length && starts[i].bodyStart < before; i++) {
    if (PLACEMENT_CLASSES.has(starts[i].className)) out.push(starts[i]);
  }
  return out;
}

function cpicObjectBodyStarts(data: Uint8Array): ReadonlySet<number> {
  return objectStartIndex(data).bodyStartSet;
}

function correctHeaderFromScannedObjectStart(
  header: CArchiveObjectHeader,
  reader: CArchiveReader
): CArchiveObjectHeader {
  const scanned = objectStartIndex(reader.data).atBodyStart.get(header.bodyStart);
  if (!scanned || scanned.className === header.className) return header;
  return reader.correctLastObjectHeader(header, scanned.className, scanned.referenceKind);
}

interface LegacyFrameTailBoundary {
  frameSchema: number;
  duration: number;
  end: number;
  label?: string;
}

function findFollowingLayerTailAfterLegacyFrame(data: Uint8Array, start: number): number | null {
  const limit = Math.min(data.length - 20, start + 900);
  for (let p = start; p <= limit; p++) {
    if (data[p] !== 0 || data[p + 1] !== 0) continue;
    if (
      data[p + 2] !== 0x00 ||
      data[p + 3] !== 0x00 ||
      data[p + 4] !== 0x00 ||
      data[p + 5] !== 0x80 ||
      data[p + 6] !== 0x00 ||
      data[p + 7] !== 0x00 ||
      data[p + 8] !== 0x00 ||
      data[p + 9] !== 0x80
    ) {
      continue;
    }
    const layerSchema = data[p + 12];
    if (layerSchema < 1 || layerSchema > 40) continue;
    const name = readStrictFlashStringAt(data, p + 13, { allowEmpty: true, maxChars: 255 });
    if (!name) continue;
    return p;
  }
  return null;
}

function findLegacyFrameTailAt(data: Uint8Array, pos: number): LegacyFrameTailBoundary | null {
  if (pos < 0 || pos + 8 > data.length) return null;
  const frameSchema = data[pos];
  if (frameSchema < 2 || frameSchema > 40) return null;
  const duration = data[pos + 1] | (data[pos + 2] << 8);
  if (duration < 1 || duration > 1000) return null;

  const end = findFollowingLayerTailAfterLegacyFrame(data, pos + 3);
  if (end === null) return null;

  let label: string | undefined;
  const nextFrameBody = findNextScannedObjectBody(data, pos, 'CPicFrame');
  const labelEnd = nextFrameBody === null ? end : Math.min(end, Math.max(pos + 3, nextFrameBody - 2));
  for (let p = pos + 3; p < labelEnd; p++) {
    const decoded = readStrictFlashStringAt(data, p, { allowEmpty: false, maxChars: 255 });
    if (!decoded) continue;
    if (isFrameLabelString(decoded.value)) label = decoded.value;
    break;
  }
  return { frameSchema, duration, end, label };
}

function legacyFrameTailScore(pos: number, legacy: LegacyFrameTailBoundary): number {
  return pos + (legacy.frameSchema >= 19 ? 100000 : 0) + (legacy.duration === 1 ? 10000 : 0);
}

function findLegacyFrameTailAfterShapeData(data: Uint8Array, start: number, limit: number): number | null {
  let bestPos: number | null = null;
  let bestEnd: number | null = null;
  let bestScore = -1;

  for (let p = start; p <= limit; p++) {
    const legacy = findLegacyFrameTailAt(data, p);
    if (!legacy) continue;
    if (bestEnd !== null && legacy.end > bestEnd) continue;

    const score = legacyFrameTailScore(p, legacy);
    if (bestEnd === null || legacy.end < bestEnd || score > bestScore) {
      bestPos = p;
      bestEnd = legacy.end;
      bestScore = score;
    }
  }

  return bestPos;
}

function findNextScannedObjectBody(
  data: Uint8Array,
  start: number,
  className: string
): number | null {
  return nextScannedBody(data, [className], start);
}

function findNextScannedChildObjectBody(data: Uint8Array, start: number): number | null {
  return nextScannedBody(data, CHILD_CLASSES, start);
}

function findFrameTailAfterShapeData(data: Uint8Array, start: number): number | null {
  const limit = Math.min(data.length - 24, start + 20000);
  const modern = findCPicFrameTailProbeInRange(data, start, limit);
  if (modern) return modern.pos;
  return findLegacyFrameTailAfterShapeData(data, start, limit);
}

function findNearbyFrameTail(data: Uint8Array, start: number, maxDistance: number): number | null {
  const limit = Math.min(data.length - 24, start + maxDistance);
  const hasSaneNextFrameGap = (pos: number): boolean => {
    const nextFrame = nextScannedBody(data, ['CPicFrame'], pos);
    return nextFrame !== null && nextFrame - pos >= 64;
  };
  for (let p = start; p <= limit; p++) {
    const keyMode = readU16At(data, p + 3);
    if (isKnownCPicFrameKeyMode(keyMode) && isPlausibleCPicFrameTailAt(data, p) && hasSaneNextFrameGap(p)) return p;
  }
  for (let p = start; p <= limit; p++) {
    if (isPlausibleCPicFrameTailAt(data, p) && hasSaneNextFrameGap(p)) return p;
  }
  for (let p = start; p <= limit; p++) {
    if (findLegacyFrameTailAt(data, p) && hasSaneNextFrameGap(p)) return p;
  }
  for (let p = start; p <= limit; p++) {
    const frameSchema = data[p];
    if (frameSchema < 2 || frameSchema > 40) continue;
    const duration = data[p + 1] | (data[p + 2] << 8);
    if (duration < 1 || duration > 1000) continue;
    const keyMode = readU16At(data, p + 3);
    if (!isKnownCPicFrameKeyMode(keyMode)) continue;
    if (!hasSaneNextFrameGap(p)) continue;
    return p;
  }
  return null;
}

function findNextScannedFrameTag(data: Uint8Array, start: number, end: number): number | null {
  const next = nextScannedBody(data, ['CPicFrame'], start);
  return next !== null && next < end ? next - 2 : null;
}

function findNextScannedTimelineTag(
  data: Uint8Array,
  start: number,
  classes: readonly string[] = ['CPicFrame', 'CPicLayer']
): number | null {
  const next = nextScannedBody(data, classes, start);
  return next !== null ? next - 2 : null;
}

function clampEmptyFrameBeforeNextScannedFrame(
  reader: CArchiveReader,
  frameTailStart: number,
  base: CPicObjBase<NativeCPicChild>,
  hasShapeTail: boolean | undefined
): void {
  if (base.children.length !== 0 || hasShapeTail) return;
  const nextFrameTag = findNextScannedFrameTag(reader.data, frameTailStart, reader.pos);
  if (nextFrameTag !== null) reader.pos = nextFrameTag;
}

function readCPicShapeTail(reader: CArchiveReader, boundary?: 'frameTail'): { shape: Shape; shapeData: DecodedShapeData; shapeSchema: number } | null {
  const shapeSchema = reader.readU8();
  if (shapeSchema !== 0 && shapeSchema !== 0xff) {
    const ma = reader.readS32();
    const mb = reader.readS32();
    const mc = reader.readS32();
    const md = reader.readS32();
    const mtx = reader.readS32();
    const mty = reader.readS32();
    const matrix: Matrix = {
      a: ma / 65536,
      b: mb / 65536,
      c: mc / 65536,
      d: md / 65536,
      tx: mtx / 20,
      ty: mty / 20,
    };
    const shapeDataReader = new ByteReader(reader.data);
    shapeDataReader.pos = reader.pos;
    const shapeDataStart = reader.pos;
    let shapeData: DecodedShapeData;
    try {
      shapeData = readShapeData(shapeDataReader, shapeSchema > 2);
    } catch (error) {
      if (boundary === 'frameTail') {
        const frameTail = findFrameTailAfterShapeData(reader.data, shapeDataStart);
        if (frameTail !== null) {
          reader.pos = frameTail;
          return null;
        }
      }
      throw error;
    }
    const hasDrawableShape = shapeData.fills.length > 0 || shapeData.strokes.length > 0 || shapeData.rawEdges.length > 0;
    if (boundary === 'frameTail' && !hasDrawableShape) {
      const frameTail = findNearbyFrameTail(reader.data, shapeDataStart, 160);
      if (frameTail !== null) {
        reader.pos = frameTail;
        return null;
      }
    }
    if (boundary === 'frameTail') {
      const legacyFrameTail = findLegacyFrameTailAfterShapeData(
        reader.data,
        shapeDataStart,
        Math.min(reader.data.length - 24, shapeDataStart + 1200)
      );
      if (legacyFrameTail !== null && legacyFrameTail < shapeDataReader.pos) {
        reader.pos = legacyFrameTail;
        return null;
      }
    }
    reader.pos = shapeDataReader.pos;
    const makeResult = (): { shape: Shape; shapeData: DecodedShapeData; shapeSchema: number } => {
      const edges = rawEdgesToEdges(shapeData.rawEdges, edgeUnitsPerPx(shapeSchema));
      return {
        shape: { type: 'shape', matrix, fills: shapeData.fills, strokes: shapeData.strokes, edges },
        shapeData,
        shapeSchema,
      };
    };
    if (shapeData.shapeDataSchema > 4) {
      const cubicCountPos = reader.pos;
      const cubicCount = reader.readS32();
      const cubicEnd = reader.pos + cubicCount * 32;
      if (boundary === 'frameTail') {
        const legacyFrameTail = findLegacyFrameTailAfterShapeData(
          reader.data,
          cubicCountPos,
          Math.min(reader.data.length - 24, cubicCountPos + 1200)
        );
        if (
          legacyFrameTail !== null &&
          (cubicCount < 0 || cubicCount > 100000 || cubicEnd > reader.data.length || legacyFrameTail < cubicEnd)
        ) {
          reader.pos = legacyFrameTail;
          return makeResult();
        }
      }
      if (cubicCount < 0 || cubicCount > 100000) {
        if (boundary === 'frameTail') {
          const frameTail = findFrameTailAfterShapeData(reader.data, cubicCountPos);
          if (frameTail !== null) {
            reader.pos = frameTail;
            return makeResult();
          }
        }
        throw new Error(
          `CPicShape: implausible cubic edge count ${cubicCount} at 0x${cubicCountPos.toString(16)} ` +
            `(shapeSchema ${shapeSchema}, dataSchema ${shapeData.shapeDataSchema})`
        );
      }
      if (boundary === 'frameTail') {
        if (cubicEnd > reader.data.length) {
          const frameTail = findFrameTailAfterShapeData(reader.data, cubicCountPos);
          if (frameTail !== null) {
            reader.pos = frameTail;
            return makeResult();
          }
        }
      }
      reader.readBytes(cubicCount * 32);
    }
    return makeResult();
  }
  return null;
}

function skipCPicShapeTail(reader: CArchiveReader, boundary?: 'frameTail'): boolean {
  const result = readCPicShapeTail(reader, boundary);
  return result !== null && (result.shapeData.fills.length > 0 || result.shapeData.strokes.length > 0 || result.shapeData.rawEdges.length > 0);
}

function readLegacyFrameTailIfPresent(reader: CArchiveReader): LegacyFrameTailBoundary | null {
  const legacy = findLegacyFrameTailAt(reader.data, reader.pos);
  const compact = legacy ?? findLegacyFrameTailBeforeNextTimelineObject(reader);
  if (!compact) return null;
  reader.pos = compact.end;
  return compact;
}

function withNativeContext<T>(context: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${context}: ${message}`);
  }
}

function cpicObjPostChildrenLength(schema: number): number {
  return 2 + (schema >= 1 ? 8 : 0) + (schema >= 3 ? 1 : 0) + (schema >= 4 ? 1 : 0) + (schema >= 6 ? 1 : 0);
}

interface TextChildFrameTailBoundary {
  textEnd: number;
  frameTailStart: number;
}

function findTextChildFrameTailBoundary(
  data: Uint8Array,
  bodyStart: number,
  parentFrameSchema: number
): TextChildFrameTailBoundary | null {
  const frameBaseTail = cpicObjPostChildrenLength(parentFrameSchema);
  const emptyShapeTailLength = 1 + 24 + 10 + 4;
  const limit = Math.min(data.length - 8, bodyStart + 900);

  for (let p = bodyStart + 80; p < limit; p++) {
    const frameSchema = data[p];
    const duration = data[p + 1] | (data[p + 2] << 8);
    const keyMode = data[p + 3] | (data[p + 4] << 8);
    if (frameSchema < 19 || frameSchema > 40 || duration < 1 || duration >= 16000) continue;
    if (!isKnownCPicFrameKeyMode(keyMode)) continue;

    const textEnd = p - emptyShapeTailLength - frameBaseTail;
    const shapeSchemaPos = textEnd + frameBaseTail;
    if (textEnd <= bodyStart || shapeSchemaPos < bodyStart || shapeSchemaPos >= data.length) continue;
    if (data[textEnd] !== 0x00 || data[textEnd + 1] !== 0x00) continue;
    const shapeSchema = data[shapeSchemaPos];
    if (shapeSchema < 1 || shapeSchema > 20) continue;
    return { textEnd, frameTailStart: p };
  }

  return null;
}

function findChildObjectEndBeforeFrameTail(data: Uint8Array, bodyStart: number): number | null {
  const frameTail = findFrameTailAfterShapeData(data, bodyStart + 80);
  if (frameTail === null) return null;

  const min = Math.max(bodyStart, frameTail - 4000);
  for (let p = frameTail - 8; p >= min; p--) {
    if (
      data[p] === 0x00 &&
      data[p + 1] === 0x00 &&
      data[p + 2] === 0x00 &&
      data[p + 3] === 0x80 &&
      data[p + 4] === 0x00 &&
      data[p + 5] === 0x00 &&
      data[p + 6] === 0x00 &&
      data[p + 7] === 0x80 &&
      p >= 2 &&
      data[p - 2] === 0x00 &&
      data[p - 1] === 0x00
    ) {
      return p - 2;
    }
  }

  return null;
}

function readU16At(data: Uint8Array, pos: number): number {
  return pos + 2 <= data.length ? data[pos] | (data[pos + 1] << 8) : 0;
}

function findModernFrameTailInfoInRange(
  data: Uint8Array,
  start: number,
  end: number
): CPicFrameTailProbe | null {
  return findCPicFrameTailProbeInRange(data, start, end);
}

function readInlinePlacementChildAt(
  data: Uint8Array,
  bodyStart: number,
  className: string
): CPicChild<NativeCPicChild> | null {
  const reader = new CArchiveReader(data, bodyStart);
  const header: CArchiveObjectHeader = {
    tagStart: Math.max(0, bodyStart - 2),
    bodyStart,
    className,
    referenceKind: 'class_backref',
  };
  const nativePlacement = readCPicPlacement(reader, header);
  if (!nativePlacement) return null;
  reader.pos = nativePlacement.bodyEnd;
  return {
    header,
    bodyEnd: reader.pos,
    value: { kind: 'placement', header, bodyEnd: reader.pos, placement: nativePlacement },
  };
}

function extractCompactInlineFrameSegments(
  data: Uint8Array,
  base: CPicObjBase<NativeCPicChild>,
  bodyEnd: number
): { firstDuration?: number; segments: NativeCPicInlineFrameSegment[] } {
  const placementStarts = scannedPlacementsBetween(data, base.bodyEnd, bodyEnd);

  const decoded: CPicChild<NativeCPicChild>[] = [];
  for (const start of placementStarts) {
    const child = readInlinePlacementChildAt(data, start.bodyStart, start.className);
    if (!child) continue;
    if (decoded.some((existing) => existing.bodyEnd > child.header.bodyStart)) continue;
    decoded.push(child);
  }

  let firstDuration: number | undefined;
  const segments: NativeCPicInlineFrameSegment[] = [];
  let scanStart = base.bodyEnd;
  for (let i = 0; i < decoded.length; i++) {
    const child = decoded[i];
    const beforeTail = findModernFrameTailInfoInRange(data, scanStart, child.header.tagStart);
    if (beforeTail && firstDuration === undefined) firstDuration = beforeTail.duration;

    const afterTail = findModernFrameTailInfoInRange(data, child.bodyEnd, bodyEnd);
    if (afterTail) {
      segments.push({
        bodyStart: child.header.bodyStart,
        bodyEnd: decoded[i + 1]?.header.bodyStart ?? afterTail.pos,
        duration: afterTail.duration,
        keyMode: afterTail.keyMode,
        children: [child],
      });
      if (i === decoded.length - 1) {
        const trailingTail = findModernFrameTailInfoInRange(data, afterTail.pos + 24, bodyEnd);
        if (trailingTail) {
          segments.push({
            bodyStart: trailingTail.pos,
            bodyEnd,
            duration: trailingTail.duration,
            keyMode: trailingTail.keyMode,
            children: [],
          });
        }
      }
    }
    scanStart = child.bodyEnd;
  }

  return { firstDuration, segments };
}

function extractModernInlineFrameSegments(
  data: Uint8Array,
  start: number,
  bodyEnd: number
): NativeCPicInlineFrameSegment[] {
  if (bodyEnd <= start) return [];
  const placementStarts = scannedPlacementsBetween(data, start, bodyEnd);

  const decoded: CPicChild<NativeCPicChild>[] = [];
  for (const start of placementStarts) {
    const child = readInlinePlacementChildAt(data, start.bodyStart, start.className);
    if (!child) continue;
    if (decoded.some((existing) => existing.bodyEnd > child.header.bodyStart)) continue;
    decoded.push(child);
  }

  const segments: NativeCPicInlineFrameSegment[] = [];
  for (let i = 0; i < decoded.length; i++) {
    const child = decoded[i];
    const afterTail = findModernFrameTailInfoInRange(data, child.bodyEnd, bodyEnd);
    if (!afterTail) continue;
    segments.push({
      bodyStart: child.header.bodyStart,
      bodyEnd: decoded[i + 1]?.header.bodyStart ?? afterTail.pos,
      duration: afterTail.duration,
      keyMode: afterTail.keyMode,
      children: [child],
    });
    if (i === decoded.length - 1) {
      const trailingTail = findModernFrameTailInfoInRange(data, afterTail.pos + 24, bodyEnd);
      if (trailingTail) {
        segments.push({
          bodyStart: trailingTail.pos,
          bodyEnd,
          duration: trailingTail.duration,
          keyMode: trailingTail.keyMode,
          children: [],
        });
      }
    }
  }
  return segments;
}

function readNestedCPicShapeChild(
  header: CArchiveObjectHeader,
  reader: CArchiveReader
): NativeCPicChild {
  if (header.className !== 'CPicShape') {
    throw new Error(
      `CPicShape: unsupported child ${header.className} at 0x${header.tagStart.toString(16)} ` +
        `(body 0x${header.bodyStart.toString(16)}, ${header.referenceKind})`
    );
  }

  const tail = readRecursiveCPicShapeObject(reader);
  return { kind: 'shape', header, bodyEnd: reader.pos, ...(tail ? { shape: tail.shape, shapeData: tail.shapeData } : {}) };
}

function readRecursiveCPicShapeObject(reader: CArchiveReader, boundary?: 'frameTail'): { shape: Shape; shapeData: DecodedShapeData } | null {
  readCPicObjBase(reader, readNestedCPicShapeChild);
  try {
    return readCPicShapeTail(reader, boundary);
  } catch (error) {
    if (boundary === 'frameTail') {
      const childEnd = findChildObjectEndBeforeFrameTail(reader.data, reader.pos);
      if (childEnd !== null) {
        reader.pos = childEnd;
        return null;
      }
    }
    throw error;
  }
}

function readCPicShapeObject(header: CArchiveObjectHeader, reader: CArchiveReader): { shape: Shape; shapeData: DecodedShapeData } | null {
  const checkpoint = reader.checkpoint();
  try {
    readCPicObjLeafBase(reader);
    return readCPicShapeTail(reader);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('expected leaf but found CPicShape')) {
      reader.restore(checkpoint);
      try {
        return readRecursiveCPicShapeObject(reader);
      } catch (nestedError) {
        const childEnd = findChildObjectEndBeforeFrameTail(reader.data, header.bodyStart);
        if (childEnd === null) throw nestedError;
        reader.pos = childEnd;
        return null;
      }
    }
    const childEnd = findChildObjectEndBeforeFrameTail(reader.data, header.bodyStart);
    if (childEnd === null) throw error;
    reader.pos = childEnd;
    return null;
  }
}

function readCPicShapeChild(
  inputHeader: CArchiveObjectHeader,
  reader: CArchiveReader,
  parentFrameSchema: number
): NativeCPicChild {
  const header = correctHeaderFromScannedObjectStart(inputHeader, reader);
  if (header.className === 'CPicShape') {
    const tail = readCPicShapeObject(header, reader);
    return { kind: 'shape', header, bodyEnd: reader.pos, ...(tail ? { shape: tail.shape, shapeData: tail.shapeData } : {}) };
  }

  if (header.className === 'CPicText') {
    const frameBoundary = findTextChildFrameTailBoundary(reader.data, header.bodyStart, parentFrameSchema);
    const nextChildBody = findNextScannedChildObjectBody(reader.data, header.bodyStart);
    const frameTextEnd = frameBoundary?.textEnd ?? reader.data.length;
    const scanEnd = Math.min(frameTextEnd, nextChildBody ?? frameTextEnd);
    const nativeText = readCPicText(reader, header, scanEnd);
    if (!nativeText) {
      throw new Error(`CPicFrame: could not decode CPicText child at 0x${header.bodyStart.toString(16)}`);
    }
    const nextChildTag = nextChildBody !== null && nextChildBody < frameTextEnd
      ? Math.max(header.bodyStart, nextChildBody - 2)
      : null;
    reader.pos = nextChildTag ?? frameBoundary?.textEnd ?? nativeText.bodyEnd;
    return { kind: 'text', header, bodyEnd: reader.pos, text: nativeText };
  }

  if (
    header.className === 'CPicSprite' ||
    header.className === 'CPicSymbol' ||
    header.className === 'CPicButton' ||
    header.className === 'CPicShapeObj'
  ) {
    const nativePlacement = readCPicPlacement(reader, header);
    if (nativePlacement) {
      reader.pos = nativePlacement.bodyEnd;
      return { kind: 'placement', header, bodyEnd: reader.pos, placement: nativePlacement };
    }
    const childEnd = findChildObjectEndBeforeFrameTail(reader.data, reader.pos);
    if (childEnd !== null) {
      reader.pos = childEnd;
      return { kind: 'placementShell', header, bodyEnd: reader.pos };
    }
    throw new Error(`CPicFrame: could not decode ${header.className} child at 0x${header.bodyStart.toString(16)}`);
  }

  throw new Error(
    `CPicFrame: unsupported child ${header.className} at 0x${header.tagStart.toString(16)} ` +
      `(body 0x${header.bodyStart.toString(16)}, ${header.referenceKind})`
  );
}

interface FrameTimelineTail {
  label?: string;
  consumesPostTail: boolean;
}

function readOptionalFlashString(reader: CArchiveReader): string | undefined {
  const decoded = readStrictFlashStringAt(reader.data, reader.pos, {
    allowEmpty: true,
    allowExtended: true,
    maxChars: 65535,
  });
  if (!decoded) return undefined;
  reader.pos = decoded.end;
  return decoded.value;
}

function isFrameLabelString(value: string | undefined): value is string {
  if (!value) return false;
  if (value.length > 255) return false;
  if (/[\r\n;]/.test(value)) return false;
  if (/\b(function|import|var|return|if|else|while|for|stop|gotoAnd(?:Play|Stop)|trace)\b/.test(value)) {
    return false;
  }
  if (/[A-Za-z_$][\w$.]*\s*\(/.test(value)) return false;
  return true;
}

function readFrameTimelineSubobject(
  reader: CArchiveReader,
  frameSchema: number
): FrameTimelineTail {
  if (frameSchema < 19) return { consumesPostTail: false };

  const timelineStart = reader.pos;
  const typeId = reader.readU32();
  const formatType = reader.readU32();
  let label: string | undefined;

  if (formatType === 0) {
    reader.readU32(); // tl_init
    const idCount = reader.readU32();
    if (idCount > 100000) throw new Error(`CPicFrame: implausible timeline id count ${idCount}`);
    for (let i = 0; i < idCount; i++) reader.readU32();

    reader.readU32(); // tl_pf_schema
    const pfCount = reader.readU32();
    if (pfCount > 100000) throw new Error(`CPicFrame: implausible timeline pf count ${pfCount}`);
    for (let i = 0; i < pfCount; i++) {
      throw new Error('CPicFrame: native per-frame timeline data is not decoded yet');
    }

    if (typeId >= 4) {
      const maybeLabel = readOptionalFlashString(reader);
      if (isFrameLabelString(maybeLabel)) label = maybeLabel;
    }
  } else if (formatType !== 2) {
    if (formatType === 1) {
      reader.readU32();
      reader.readU32();
      reader.readU32();
      readOptionalFlashString(reader);
      for (let i = 0; i < 5; i++) reader.readU32();
      readOptionalFlashString(reader);
      reader.readU32();
      reader.readU32();
      reader.readU32();
      reader.readU32();
      reader.readU32();
      return { label, consumesPostTail: true };
    }
    throw new Error(
      `CPicFrame: unsupported timeline format ${formatType} at 0x${timelineStart.toString(16)} ` +
        `(typeId ${typeId})`
    );
  }

  return { label, consumesPostTail: false };
}

function skipNullableObject(reader: CArchiveReader, absentBeforeClasses: readonly string[] = []): boolean {
  if (absentBeforeClasses.length > 0) {
    const next = reader.peekObjectHeader();
    if (next && absentBeforeClasses.includes(next.className)) return false;
  }
  const header = reader.readObjectHeader();
  if (header) {
    throw new Error(`CPicFrame: expected null object, got ${header.className}`);
  }
  return true;
}

function readNullableLayerParentRef(reader: CArchiveReader): number | undefined {
  const next = reader.peekObjectHeader();
  if (!next) {
    reader.readObjectHeader();
    return undefined;
  }
  if (next.className === 'CPicLayer' && next.referenceKind === 'object_backref') {
    const header = reader.readObjectHeader();
    return header?.referenceIndex;
  }
  if (next.className === 'CPicLayer' && next.referenceKind === 'class_backref') {
    return undefined;
  }
  const header = reader.readObjectHeader();
  throw new Error(`CPicLayer: expected parent layer ref/null, got ${header?.className ?? 'null'}`);
}

function canReadObjectHeaderAtCurrentPosition(reader: CArchiveReader): boolean {
  const checkpoint = reader.checkpoint();
  try {
    reader.readObjectHeader();
    return true;
  } catch {
    return false;
  } finally {
    reader.restore(checkpoint);
  }
}

function canReadObjectHeaderAtPosition(reader: CArchiveReader, pos: number): boolean {
  const checkpoint = reader.checkpoint();
  try {
    reader.pos = pos;
    reader.readObjectHeader();
    return true;
  } catch {
    return false;
  } finally {
    reader.restore(checkpoint);
  }
}

function safePeekObjectHeader(reader: CArchiveReader): CArchiveObjectHeader | null {
  try {
    return reader.peekObjectHeader();
  } catch {
    return null;
  }
}

function safePeekObjectHeaderAtPosition(reader: CArchiveReader, pos: number): CArchiveObjectHeader | null {
  const checkpoint = reader.checkpoint();
  try {
    reader.pos = pos;
    return reader.readObjectHeader();
  } catch {
    return null;
  } finally {
    reader.restore(checkpoint);
  }
}

function findLegacyFrameTailBeforeNextTimelineObject(reader: CArchiveReader): LegacyFrameTailBoundary | null {
  const pos = reader.pos;
  if (pos < 0 || pos + 8 > reader.data.length) return null;

  const frameSchema = reader.data[pos];
  if (frameSchema < 2 || frameSchema > 40) return null;

  const duration = reader.data[pos + 1] | (reader.data[pos + 2] << 8);
  if (duration < 1 || duration > 1000) return null;

  const limit = Math.min(reader.data.length - 4, pos + 1200);
  for (let p = pos + 20; p <= limit; p++) {
    const next = safePeekObjectHeaderAtPosition(reader, p);
    if (!next) continue;
    if (next.className !== 'CPicFrame' && next.className !== 'CPicLayer') continue;
    return { frameSchema, duration, end: p };
  }

  return null;
}

function readCPicLayerPreChildren(schema: number, flags: number, reader: CArchiveReader): void {
  if (
    schema === 1 &&
    flags === 1 &&
    reader.pos < reader.data.length &&
    reader.data[reader.pos] === 0 &&
    canReadObjectHeaderAtPosition(reader, reader.pos + 1)
  ) {
    reader.readU8();
  }
}

function readCPicFrameBase(reader: CArchiveReader): CPicObjBase<NativeCPicChild> {
  const bodyStart = reader.pos;
  const schema = reader.readU8();
  const flags = reader.readU8();
  const children: CPicChild<NativeCPicChild>[] = [];

  const base: CPicObjBase<NativeCPicChild> = {
    bodyStart,
    bodyEnd: reader.pos,
    schema,
    flags,
    children,
  };

  while (true) {
    if (findLegacyFrameTailAt(reader.data, reader.pos) || findLegacyFrameTailBeforeNextTimelineObject(reader)) {
      base.bodyEnd = reader.pos;
      return base;
    }

    const header = reader.readObjectHeader();
    if (!header) break;
    const value = readCPicShapeChild(header, reader, schema);
    children.push({ header, bodyEnd: reader.pos, value });
  }

  if (schema >= 1) {
    base.registrationPoint = {
      x: reader.readS32(),
      y: reader.readS32(),
    };
  }
  if (schema >= 3) base.extra1 = reader.readU8();
  if (schema >= 4) base.extra2 = reader.readU8();
  if (schema >= 6) base.extra3 = reader.readU8();

  base.bodyEnd = reader.pos;
  return base;
}

function finalizeNativeFrame(data: Uint8Array, frame: NativeCPicFrame): NativeCPicFrame {
  if (!nativeFrameHasElements(frame)) {
    return frame;
  }
  if (frame.frameSchema >= 19) {
    const internal = extractCompactInlineFrameSegments(data, frame.base, frame.bodyEnd);
    const end = findNextScannedTimelineTag(data, frame.bodyEnd, ['CPicLayer']);
    const external = end !== null && end > frame.bodyEnd
      ? extractModernInlineFrameSegments(data, frame.bodyEnd, end)
      : [];
    const segments = [...internal.segments, ...external];
    if (segments.length === 0) return frame;
    return { ...frame, inlineSegments: segments };
  }
  if (frame.bodyEnd <= frame.base.bodyEnd) return frame;
  const inline = extractCompactInlineFrameSegments(data, frame.base, frame.bodyEnd);
  if (inline.firstDuration === undefined && inline.segments.length === 0) return frame;
  return {
    ...frame,
    ...(inline.firstDuration !== undefined ? { inlineDuration: inline.firstDuration } : {}),
    ...(inline.segments.length > 0 ? { inlineSegments: inline.segments } : {}),
  };
}

function readCPicFrame(header: CArchiveObjectHeader, reader: CArchiveReader): NativeCPicFrame {
  if (header.className !== 'CPicFrame') {
    throw new Error(`CPicLayer: unsupported child ${header.className}`);
  }

  const base = withNativeContext(
    `CPicFrame body 0x${header.bodyStart.toString(16)}`,
    () => readCPicFrameBase(reader)
  );
  const directLegacyTail = readLegacyFrameTailIfPresent(reader);
  if (directLegacyTail) {
    clampEmptyFrameBeforeNextScannedFrame(reader, base.bodyEnd, base, undefined);
    return finalizeNativeFrame(reader.data, {
      header,
      base,
      bodyEnd: reader.pos,
      frameSchema: directLegacyTail.frameSchema,
      duration: directLegacyTail.duration,
      keyMode: 0,
      ...(directLegacyTail.label && { label: directLegacyTail.label }),
    });
  }
  const shapeTailStart = reader.pos;
  const hasShapeTail = withNativeContext(
    `CPicFrame shape tail 0x${reader.pos.toString(16)}`,
    () => skipCPicShapeTail(reader, 'frameTail')
  );
  let syncedThrough = reader.pos;
  reader.syncObjectHeadersInRange(shapeTailStart, syncedThrough, CPIC_SYNC_CLASSES, cpicObjectBodyStarts(reader.data));
  if (!isPlausibleCPicFrameTailAt(reader.data, reader.pos)) {
    const frameTail = findFrameTailAfterShapeData(reader.data, reader.pos + 1);
    if (frameTail !== null) reader.pos = frameTail;
  }
  if (reader.pos > syncedThrough) {
    reader.syncObjectHeadersInRange(syncedThrough, reader.pos, CPIC_SYNC_CLASSES, cpicObjectBodyStarts(reader.data));
    syncedThrough = reader.pos;
  }
  if (!isPlausibleCPicFrameTailAt(reader.data, reader.pos)) {
    const earlierLegacyTail = findLegacyFrameTailAfterShapeData(
      reader.data,
      shapeTailStart,
      Math.max(shapeTailStart, reader.pos)
    );
    if (earlierLegacyTail !== null && earlierLegacyTail < reader.pos) {
      reader.pos = earlierLegacyTail;
    }
  }
  const preferredLegacyTail = findLegacyFrameTailAt(reader.data, reader.pos);
  const keyModeAtFrameTail = readU16At(reader.data, reader.pos + 3);
  if (
    preferredLegacyTail &&
    keyModeAtFrameTail !== 0x2200 &&
    keyModeAtFrameTail !== 0x4601
  ) {
    reader.pos = preferredLegacyTail.end;
    clampEmptyFrameBeforeNextScannedFrame(reader, base.bodyEnd, base, hasShapeTail);
    return finalizeNativeFrame(reader.data, {
      header,
      base,
      bodyEnd: reader.pos,
      frameSchema: preferredLegacyTail.frameSchema,
      duration: preferredLegacyTail.duration,
      keyMode: 0,
      ...(hasShapeTail && { hasShapeTail }),
      ...(preferredLegacyTail.label && { label: preferredLegacyTail.label }),
    });
  }
  const legacyTail = !isPlausibleCPicFrameTailAt(reader.data, reader.pos)
    ? readLegacyFrameTailIfPresent(reader)
    : null;
  if (legacyTail) {
    clampEmptyFrameBeforeNextScannedFrame(reader, base.bodyEnd, base, hasShapeTail);
    return finalizeNativeFrame(reader.data, {
      header,
      base,
      bodyEnd: reader.pos,
      frameSchema: legacyTail.frameSchema,
      duration: legacyTail.duration,
      keyMode: 0,
      ...(hasShapeTail && { hasShapeTail }),
      ...(legacyTail.label && { label: legacyTail.label }),
    });
  }

  const modernTailCheckpoint = reader.checkpoint();
  const legacyAtModernTail = findLegacyFrameTailAt(reader.data, reader.pos);
  const frameTailStart = reader.pos;
  const frameSchema = reader.readU8();
  const duration = reader.readU16();
  if (duration < 1 || duration >= 16000) {
    const earlierLegacyTail = findLegacyFrameTailAfterShapeData(
      reader.data,
      header.bodyStart,
      frameTailStart
    );
    if (earlierLegacyTail !== null && earlierLegacyTail < frameTailStart) {
      reader.restore(modernTailCheckpoint);
      reader.pos = earlierLegacyTail;
      const recovered = readLegacyFrameTailIfPresent(reader);
      if (recovered) {
        clampEmptyFrameBeforeNextScannedFrame(reader, base.bodyEnd, base, hasShapeTail);
        return finalizeNativeFrame(reader.data, {
          header,
          base,
          bodyEnd: reader.pos,
          frameSchema: recovered.frameSchema,
          duration: recovered.duration,
          keyMode: 0,
          ...(recovered.label && { label: recovered.label }),
        });
      }
    }
    throw new Error(
      `CPicFrame: implausible duration ${duration} at 0x${frameTailStart.toString(16)}`
    );
  }

  const keyMode = frameSchema > 2 ? reader.readU16() : 0;
  const acceleration = frameSchema > 1 ? reader.readS16() : 0;
  const soundRef = frameSchema > 4 ? reader.readU16() : 0;
  if (frameSchema > 5) {
    const count = reader.readU16();
    if (count !== 0) throw new Error('CPicFrame: non-empty frame entry table is not decoded yet');
  }
  if (frameSchema > 6) {
    reader.readU16();
    reader.readU8();
    reader.readU32();
    reader.readS32();
  }
  if (frameSchema > 7) reader.readU16();

  let preTimelineLabel: string | undefined;
  if (frameSchema >= 23) {
    const maybeLabel = readOptionalFlashString(reader);
    if (isFrameLabelString(maybeLabel)) preTimelineLabel = maybeLabel;
  }

  const timelineTail = withNativeContext(
    `CPicFrame timeline tail 0x${reader.pos.toString(16)}`,
    () => readFrameTimelineSubobject(reader, frameSchema)
  );
  const label = timelineTail.label ?? preTimelineLabel;

  if (!timelineTail.consumesPostTail && frameSchema > 10) {
    reader.readU32();
    reader.readU32();
  }
  if (!timelineTail.consumesPostTail) {
    if (frameSchema > 11) reader.readU32();
    if (frameSchema > 12) {
      withNativeContext(`CPicFrame morph object 0x${reader.pos.toString(16)}`, () => skipNullableObject(reader));
    }
    if (frameSchema > 13) reader.readU32();
    if (frameSchema > 14) {
      withNativeContext(
        `CPicFrame oblist object 0x${reader.pos.toString(16)}`,
        () => skipNullableObject(reader, ['CPicLayer'])
      );
    }
  }

  if (legacyAtModernTail && reader.pos > legacyAtModernTail.end) {
    reader.restore(modernTailCheckpoint);
    reader.pos = legacyAtModernTail.end;
    clampEmptyFrameBeforeNextScannedFrame(reader, base.bodyEnd, base, hasShapeTail);
    return finalizeNativeFrame(reader.data, {
      header,
      base,
      bodyEnd: reader.pos,
      frameSchema: legacyAtModernTail.frameSchema,
      duration: legacyAtModernTail.duration,
      keyMode: 0,
      ...(hasShapeTail && { hasShapeTail }),
      ...(legacyAtModernTail.label && { label: legacyAtModernTail.label }),
    });
  }

  clampEmptyFrameBeforeNextScannedFrame(reader, base.bodyEnd, base, hasShapeTail);

  return finalizeNativeFrame(reader.data, {
    header,
    base,
    bodyEnd: reader.pos,
    frameSchema,
    duration,
    keyMode,
    acceleration,
    soundRef,
    ...(hasShapeTail && { hasShapeTail }),
    label,
  });
}

function readCPicLayer(header: CArchiveObjectHeader, reader: CArchiveReader): NativeCPicLayer {
  if (header.className !== 'CPicLayer') {
    throw new Error(`CPicPage: unsupported child ${header.className}`);
  }

  const base = withNativeContext(
    `CPicLayer body 0x${header.bodyStart.toString(16)}`,
    () =>
      readCPicObjBase(reader, readCPicFrame, {
        readPreChildren: readCPicLayerPreChildren,
        stopBeforeChildClasses: ['CPicLayer'],
      })
  );
  if (base.children.length === 0 && safePeekObjectHeader(reader)?.className === 'CPicLayer') {
    return {
      header,
      base,
      bodyEnd: reader.pos,
      layerSchema: base.schema,
      name: '',
      locked: false,
      visible: true,
      frames: [],
    };
  }
  const layerSchema = reader.readU8();
  const name = readStrictFlashStringAt(reader.data, reader.pos, { allowEmpty: true, maxChars: 255 });
  if (!name) throw new Error(`CPicLayer: missing layer name at 0x${reader.pos.toString(16)}`);
  reader.pos = name.end;

  let locked = false;
  let visible = true;
  if (layerSchema >= 4) {
    // u8 current, u8 locked, u8 hidden (same order as binary-fla-structure's
    // extractLayers; #45 read the last two the other way round).
    reader.readU8();
    locked = reader.readU8() !== 0;
    visible = reader.readU8() === 0;
  }
  if (layerSchema >= 5) reader.readU32();
  if (layerSchema >= 6) {
    reader.readU32();
    reader.readU32();
  }
  let parentLayerRef: number | undefined;
  if (layerSchema >= 8) {
    reader.readU32();
    reader.readU8();
    const parentCheckpoint = reader.checkpoint();
    parentLayerRef = withNativeContext(
      `CPicLayer parent object 0x${reader.pos.toString(16)}`,
      () => readNullableLayerParentRef(reader)
    );
    if (parentLayerRef !== undefined && safePeekObjectHeader(reader)?.className === 'CPicFrame') {
      reader.restore(parentCheckpoint);
      return {
        header,
        base,
        bodyEnd: reader.pos,
        layerSchema,
        name: name.value,
        locked,
        visible,
        frames: base.children.map((child) => child.value),
      };
    }
    if (parentLayerRef === undefined && safePeekObjectHeader(reader)?.className === 'CPicLayer') {
      return {
        header,
        base,
        bodyEnd: reader.pos,
        layerSchema,
        name: name.value,
        locked,
        visible,
        frames: base.children.map((child) => child.value),
      };
    }
    if (parentLayerRef !== undefined) {
      void parentLayerRef;
    }
  }
  if (layerSchema >= 9) {
    const extrasStart = reader.pos;
    const layerAfterTwoExtras = safePeekObjectHeaderAtPosition(reader, extrasStart + 2);
    const frameAfterCompactLayer = safePeekObjectHeaderAtPosition(reader, extrasStart + 6);
    if (
      layerAfterTwoExtras?.className === 'CPicLayer' &&
      layerAfterTwoExtras.referenceKind === 'class_backref' &&
      frameAfterCompactLayer?.className === 'CPicFrame'
    ) {
      reader.readU8();
      reader.readU8();
      return {
        header,
        base,
        bodyEnd: reader.pos,
        layerSchema,
        name: name.value,
        locked,
        visible,
        ...(parentLayerRef !== undefined ? { parentLayerRef } : {}),
        frames: base.children.map((child) => child.value),
      };
    }
    reader.readU8();
    if (layerSchema >= 10) reader.readU8();
    if (layerSchema >= 11) reader.readU8();
    if (!canReadObjectHeaderAtCurrentPosition(reader)) {
      reader.pos = extrasStart;
      reader.readU16();
      if (layerSchema >= 10) reader.readU16();
      if (layerSchema >= 11) reader.readU16();
    }
    const trailingParent = safePeekObjectHeader(reader);
    if (
      trailingParent?.className === 'CPicLayer' &&
      trailingParent.referenceKind === 'object_backref' &&
      safePeekObjectHeaderAtPosition(reader, reader.pos + 2)?.className === 'CPicLayer' &&
      safePeekObjectHeaderAtPosition(reader, reader.pos + 2)?.referenceKind === 'class_backref'
    ) {
      reader.readObjectHeader();
    }
  }

  return {
    header,
    base,
    bodyEnd: reader.pos,
    layerSchema,
    name: name.value,
    locked,
    visible,
    ...(parentLayerRef !== undefined ? { parentLayerRef } : {}),
    frames: base.children.map((child) => child.value),
  };
}

function readCPicPage(header: CArchiveObjectHeader, reader: CArchiveReader): NativeCPicPage {
  if (header.className !== 'CPicPage') {
    throw new Error(`expected CPicPage root, got ${header.className}`);
  }
  const base = withNativeContext(
    `CPicPage body 0x${header.bodyStart.toString(16)}`,
    () => readCPicObjBase(reader, readCPicLayer)
  );
  return {
    header,
    base,
    bodyEnd: reader.pos,
    layers: base.children.map((child) => child.value),
  };
}

function applyNativeFrameLabels(page: NativeCPicPage, data: Uint8Array): void {
  const labels = scanFrameLabels(data);
  if (labels.length === 0) return;

  for (const layer of page.layers) {
    const frames = layer.frames;
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      if (frame.label) continue;
      const start = frame.header.bodyStart;
      const end = frames[i + 1]?.header.bodyStart ?? frame.bodyEnd;
      const label = labels.find((candidate) =>
        candidate.bodyStart >= start &&
        candidate.bodyStart < end
      );
      if (label) frame.label = label.label;
    }
  }
}

function applyLegacyFrameShapes(page: NativeCPicPage, data: Uint8Array): void {
  const recovered = scanForShapes(data, ['CPicPage', 'CPicLayer', 'CPicFrame', 'CPicShape']);
  if (recovered.length === 0) return;

  for (const layer of page.layers) {
    const frames = layer.frames;
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const start = frame.header.bodyStart;
      const end = frames[i + 1]?.header.bodyStart ?? frame.bodyEnd;
      const shapes = recovered.filter((shape) =>
        shape.bodyStart >= start &&
        shape.endPos <= end
      );
      if (shapes.length > 0) frame.legacyShapes = shapes;
    }
  }
}

/**
 * Walk one `Page N` / `Symbol N` stream as a CPic object tree. Never throws:
 * a failed walk returns `ok: false` with the error message.
 */
export function decodeNativeTimelineTreeDetailed(data: Uint8Array): NativeTimelineDecodeResult {
  try {
    const reader = new CArchiveReader(data, data[0] === 0x01 ? 1 : 0);
    const page = reader.readObject(readCPicPage);
    if (page) {
      applyNativeFrameLabels(page.value, data);
      // Legacy shapes only feed compactFrameDurationProvider, which ignores
      // pages without a compact (schema < 19) frame; skip the costly scan.
      const hasCompactFrame = page.value.layers.some((layer) =>
        layer.frames.some((frame) => frame.frameSchema < 19)
      );
      if (hasCompactFrame) applyLegacyFrameShapes(page.value, data);
    }
    return { ok: page !== null, page: page?.value ?? null };
  } catch (error) {
    return {
      ok: false,
      page: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Convert a walked page to the layer/keyframe structure the parser attributes
 * content with. Layers stay in stream order (bottom-first), like
 * {@link decodeStreamTimeline}; the parser flips them to top-first.
 */
export function nativeTimelineToDecodedTimeline(page: NativeCPicPage): DecodedStreamTimeline {
  const layers: DecodedTimelineLayer[] = page.layers.map((layer) => {
    let startIndex = 0;
    const keyframes: DecodedKeyframe[] = [];
    for (let frameIndex = 0; frameIndex < layer.frames.length; frameIndex++) {
      const frame = layer.frames[frameIndex];
      // A compact (schema < 19) frame with content can be followed by an empty
      // modern frame that carries its span; the pair is one keyframe.
      const provider = compactFrameDurationProvider(frame, layer.frames[frameIndex + 1]);
      const tail = provider ?? frame;
      const duration = nativeFrameDuration(tail);
      const inlineSegments = filteredInlineSegments(layer, frameIndex);
      keyframes.push({
        startIndex,
        duration,
        bodyStart: frame.header.bodyStart,
        bodyEnd: inlineSegments[0]?.bodyStart ?? provider?.bodyEnd ?? frame.bodyEnd,
        ...tweenAndSound(tail.keyMode, tail.acceleration, tail.soundRef),
      });
      if (provider) frameIndex += 1;
      startIndex += duration;
      for (const segment of inlineSegments) {
        keyframes.push({
          startIndex,
          duration: segment.duration,
          bodyStart: segment.bodyStart,
          bodyEnd: segment.bodyEnd,
          ...tweenAndSound(segment.keyMode),
        });
        startIndex += segment.duration;
      }
    }
    return {
      name: layer.name,
      schema: layer.layerSchema,
      locked: layer.locked,
      visible: layer.visible,
      keyframes,
    };
  });

  let totalFrames = 1;
  for (const layer of layers) {
    for (const kf of layer.keyframes) {
      totalFrames = Math.max(totalFrames, kf.startIndex + kf.duration);
    }
  }
  return { layers, totalFrames };
}

function tweenAndSound(
  keyMode: number,
  acceleration = 0,
  soundRef = 0
): Pick<DecodedKeyframe, 'motionTween' | 'acceleration' | 'soundRef'> {
  // Bit 0 of the key mode marks a classic motion tween (as in
  // decodeStreamTimeline's field_188).
  const motionTween = (keyMode & 1) !== 0;
  return {
    ...(motionTween && {
      motionTween,
      acceleration: Math.abs(acceleration) <= 100 ? acceleration : 0,
    }),
    ...(soundRef > 0 && { soundRef }),
  };
}

/**
 * Object-walk counterpart of {@link decodeStreamTimeline}, for streams that
 * walker cannot read (CS3/CS4 files with text, bitmaps and newer frame tails).
 * Returns null unless the walk finishes and passes the same confidence gate:
 * at least one layer, plausible layer names, and some layer with more than one
 * keyframe.
 */
export function decodeNativeStreamTimeline(data: Uint8Array): DecodedStreamTimeline | null {
  const { page } = decodeNativeTimelineTreeDetailed(data);
  if (!page) return null;
  const timeline = nativeTimelineToDecodedTimeline(page);
  if (timeline.layers.length === 0) return null;
  if (!timeline.layers.every((layer) => isPlausibleLayerName(layer.name))) return null;
  if (!timeline.layers.some((layer) => layer.keyframes.length > 1)) return null;
  if (!keyframeCountsMatchFrameObjects(page, timeline, data)) return null;
  return timeline;
}

/**
 * Cross-check the walk against a flat scan of the stream: every layer must
 * yield exactly as many keyframes as there are CPicFrame objects in its byte
 * range. When a frame's shape data cannot be read, the walker resyncs on a
 * later frame tail and silently merges the frames in between; on the CS4 test
 * files this rejects 14 of 233 otherwise accepted timelines.
 */
function keyframeCountsMatchFrameObjects(
  page: NativeCPicPage,
  timeline: DecodedStreamTimeline,
  data: Uint8Array
): boolean {
  // Only declarations and class references create objects; the scan's
  // class-bit tags that land on an object slot are byte noise (a layer colour
  // such as FF 80 reads as tag 0x80FF once the load array is that long).
  const frameStarts = objectStartIndex(data)
    .starts.filter((object) => object.className === 'CPicFrame' && object.referenceKind !== 'object_backref')
    .map((object) => object.bodyStart);
  return page.layers.every((layer, index) => {
    const start = layer.header.bodyStart;
    const end = page.layers[index + 1]?.header.bodyStart ?? data.length;
    const frameObjects = frameStarts.filter((pos) => pos >= start && pos < end).length;
    return timeline.layers[index].keyframes.length === frameObjects;
  });
}

function nativeFrameDuration(frame: NativeCPicFrame): number {
  if (frame.inlineDuration !== undefined) return frame.inlineDuration;
  return frame.frameSchema < 19 ? 1 : frame.duration;
}

function nativeFrameHasElements(frame: NativeCPicFrame): boolean {
  return (
    frame.hasShapeTail === true ||
    frame.base.children.length > 0 ||
    (frame.legacyShapes?.length ?? 0) > 0
  );
}

/** Inline segments that do not overlap another frame of the same layer. */
function filteredInlineSegments(
  layer: NativeCPicLayer,
  frameIndex: number
): NativeCPicInlineFrameSegment[] {
  const frame = layer.frames[frameIndex];
  return (frame.inlineSegments ?? []).filter((segment) =>
    !layer.frames.some((other, otherIndex) =>
      otherIndex !== frameIndex &&
      segment.bodyStart >= other.header.bodyStart &&
      segment.bodyStart < other.bodyEnd
    )
  );
}

function compactFrameDurationProvider(
  frame: NativeCPicFrame,
  next: NativeCPicFrame | undefined
): NativeCPicFrame | undefined {
  if (frame.frameSchema >= 19 || !nativeFrameHasElements(frame) || !next) return undefined;
  if (next.frameSchema < 19 || nativeFrameHasElements(next) || next.label) return undefined;
  return next;
}

interface ScannedFrameLabel {
  label: string;
  /** Offset of the record in the stream. */
  bodyStart: number;
}

/**
 * Scan for frame-label records (`FF FF FF 3F ?? ?? FF FE FF <len> <UTF-16>`
 * followed by `?? 00 00 00 01 00 00 00`). Ported from PR #45's
 * `extractFrameLabels`; the walker only uses them to tell a labelled empty
 * frame from a span-carrying one.
 */
function scanFrameLabels(data: Uint8Array): ScannedFrameLabel[] {
  const labels: ScannedFrameLabel[] = [];
  const headFixed: [number, number][] = [[0, 0xff], [1, 0xff], [2, 0xff], [3, 0x3f], [6, 0xff], [7, 0xfe], [8, 0xff]];
  const TAIL = [0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00];

  for (let i = 0; i + 11 <= data.length; i++) {
    if (headFixed.some(([pos, val]) => data[i + pos] !== val)) continue;

    const len = data[i + 9];
    const textEnd = i + 10 + len * 2;
    if (len < 1 || len > 50 || textEnd + 1 + TAIL.length > data.length) continue;

    let printable = true;
    for (let j = 0; j < len; j++) {
      const c = data[i + 10 + j * 2] | (data[i + 11 + j * 2] << 8);
      if (c < 0x20 || c > 0x7e) {
        printable = false;
        break;
      }
    }
    if (!printable) continue;
    if (TAIL.some((val, j) => data[textEnd + 1 + j] !== val)) continue;

    const label = decodeUtf16Le(data, i + 10, len * 2);
    if (labels.some((l) => l.label === label)) continue;
    labels.push({ label, bodyStart: i });
  }
  return labels;
}
