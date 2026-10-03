/**
 * CPicSprite / CPicSymbol / CPicButton / CPicShapeObj placement reader for the
 * second timeline walker: matrix, instance name, library reference, and the
 * colour transform / filter tail of older schemas. Ported from PR #45 (zndxcvbn).
 */
import { CArchiveReader, type CArchiveObjectHeader } from './binary-carchive';
import {
  readCPicObjLeafBase,
  type CPicObjBase,
} from './binary-cpic-object';
import { readStrictFlashStringAt, hasFlashStringMarker } from './binary-flash-string';
import { parseSwfFilterStack } from './binary-swf-filters';
import type { BlendMode, ColorTransform, Filter, Matrix } from './types';

export interface CPicPlacement {
  className: string;
  mediaRef: number;
  instanceName: string;
  matrix: Matrix;
  bodyStart: number;
  bodyEnd: number;
  altMediaRef: number;
  colorTransform?: ColorTransform;
  filters?: Filter[];
  blendMode?: BlendMode;
  componentParameters?: unknown[];
  componentDataBindingXML?: string;
}

const FIXED_16_16 = 65536;
const TWIPS_PER_PX = 20;
const MAX_MEDIA_REF = 5000;
const MAX_NAME_LEN = 0x40;

function isPlausiblePlacementName(value: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return false;
  return value !== 'true' && value !== 'false';
}

function isSerializedValueName(value: string): boolean {
  return value === 'true' || value === 'false' || /^-?\d+(?:\.\d+)?$/.test(value);
}

function readU16At(data: Uint8Array, pos: number): number {
  return pos + 1 < data.length ? data[pos] | (data[pos + 1] << 8) : 0;
}
function readU32At(data: Uint8Array, pos: number): number {
  return pos + 3 < data.length
    ? data[pos] | (data[pos + 1] << 8) | (data[pos + 2] << 16) | (data[pos + 3] * 0x1000000)
    : 0;
}

function blendModeFromCode(code: number): BlendMode | undefined {
  if (code === 2) return 'layer';
  return undefined;
}

export function readCPicPlacement(
  reader: CArchiveReader,
  header: CArchiveObjectHeader
): CPicPlacement | null {
  const bodyStart = reader.pos;
  let base: CPicObjBase<never>;
  try {
    base = readCPicObjLeafBase(reader);
  } catch {
    return null;
  }

  if (base.schema < 1 || base.schema > 30 || base.flags > 0x40) return null;

  const symbolSchema = reader.readU8();
  if (symbolSchema < 1 || symbolSchema > 40) return null;

  const data = reader.data;
  let pos = reader.pos;

  const readS32 = () => {
    const v = data[pos] | (data[pos + 1] << 8) | (data[pos + 2] << 16) | (data[pos + 3] << 24);
    pos += 4;
    return v;
  };
  const readU16 = () => {
    const v = data[pos] | (data[pos + 1] << 8);
    pos += 2;
    return v;
  };
  const readU8 = () => data[pos++];
  const readS16 = () => {
    const v = data[pos] | (data[pos + 1] << 8);
    pos += 2;
    return v << 16 >> 16;
  };

  if (pos + 24 > data.length) return null;
  const a = readS32();
  const b = readS32();
  const c = readS32();
  const d = readS32();
  const tx_raw = readS32();
  const ty_raw = readS32();

  const matrix: Matrix = {
    a: a / FIXED_16_16,
    b: b / FIXED_16_16,
    c: c / FIXED_16_16,
    d: d / FIXED_16_16,
    tx: tx_raw / TWIPS_PER_PX,
    ty: ty_raw / TWIPS_PER_PX,
  };

  if (matrix.a === 0 && matrix.d === 0) return null;
  for (const v of [matrix.a, matrix.b, matrix.c, matrix.d]) {
    if (!Number.isFinite(v) || Math.abs(v) > 64) return null;
  }
  if (Math.abs(matrix.tx * TWIPS_PER_PX) > 20 * 200_000) return null;
  if (Math.abs(matrix.ty * TWIPS_PER_PX) > 20 * 200_000) return null;

  if (pos + 10 > data.length) return null;
  readU16(); // field_b0
  readU16(); // field_cc
  readU8(); // field_90 marker
  readU16();
  readU16();
  readU16();
  readU16();

  const nameStart = pos;
  let instanceName = '';
  let mediaRef: number | undefined;
  let altMediaRef = 0;
  let blendMode: BlendMode | undefined;

  const nameLen = readU8();
  if (nameLen <= MAX_NAME_LEN && pos + nameLen + 4 <= data.length) {
    let validName = true;
    for (let i = 0; i < nameLen; i++) {
      const ch = data[pos++];
      if (ch < 9) { validName = false; break; }
      instanceName += String.fromCharCode(ch);
    }
    if (validName) {
      const parsedMediaRef = readU32At(data, pos); pos += 4;
      if (parsedMediaRef >= 1 && parsedMediaRef <= MAX_MEDIA_REF) {
        mediaRef = parsedMediaRef;
      }
    }
  }

  if (symbolSchema >= 22) {
    const tail = findSchema22TransformTail(data, nameStart - 8);
    if (tail) {
      mediaRef = tail.targetRef;
      altMediaRef = tail.targetRef;
      blendMode = tail.blendMode;
      if (!instanceName) instanceName = '';
      pos = Math.max(pos, tail.end);
    } else {
      if (mediaRef === undefined) {
        const fallback = findSchema22TailFallback(data, nameStart - 8);
        if (fallback) {
          mediaRef = fallback.targetRef;
          altMediaRef = fallback.targetRef;
          instanceName = '';
          pos = fallback.end;
        }
      }
    }
  }

  if (mediaRef === undefined) return null;

  const altRaw = bodyStart + 72;
  altMediaRef = altMediaRef || (altRaw + 4 <= data.length
    ? data[altRaw] | (data[altRaw + 1] << 8) | (data[altRaw + 2] << 16) | (data[altRaw + 3] * 0x1000000)
    : 0);

  let colorTransform: ColorTransform | undefined;
  let filters: Filter[] | undefined;
  let componentDataBindingXML: string | undefined;

  if (symbolSchema >= 22) {
    const componentTail = tryParseComponentDataBindingTail(data, pos);
    if (componentTail) {
      componentDataBindingXML = componentTail.xml;
      if ((!instanceName || isSerializedValueName(instanceName)) && componentTail.instanceName) {
        instanceName = componentTail.instanceName;
      }
      pos = componentTail.end;
    }

    const tail = !componentTail ? findSchema22TransformTail(data, pos) : null;
    if (tail) {
      altMediaRef = tail.targetRef;
      mediaRef = tail.targetRef;
      blendMode = tail.blendMode;
      pos = tail.end;
    } else if (!componentTail) {
      const fallback = findSchema22TailFallback(data, pos);
      if (fallback) {
        altMediaRef = fallback.targetRef;
        mediaRef = fallback.targetRef;
        pos = fallback.end;
      }
    }

    if (!componentTail) {
      const postTransformComponentTail = tryParseComponentDataBindingTail(data, pos);
      if (postTransformComponentTail) {
        componentDataBindingXML = postTransformComponentTail.xml;
        if ((!instanceName || isSerializedValueName(instanceName)) && postTransformComponentTail.instanceName) {
          instanceName = postTransformComponentTail.instanceName;
        }
        pos = postTransformComponentTail.end;
      }
    }
  }

  if (symbolSchema < 22 && (header.className === 'CPicSprite' || header.className === 'CPicButton') && pos + 1 <= data.length) {
    const hasCT = readU8();
    if (hasCT && pos + 13 <= data.length) {
      const alphaMult16 = readU16();
      colorTransform = {
        alphaMultiplier: alphaMult16 / 256,
        redMultiplier: readU8() / 255,
        redOffset: readS16(),
        greenMultiplier: readU8() / 255,
        greenOffset: readS16(),
        blueMultiplier: readU8() / 255,
        blueOffset: readS16(),
        alphaOffset: readS16(),
      };
    }
    const parsedFilters = parseSwfFilterStack(data, pos);
    if (parsedFilters) {
      filters = parsedFilters.filters;
      pos = parsedFilters.end;
    }
  }

  reader.pos = pos;
  return {
    className: header.className,
    mediaRef,
    instanceName,
    matrix,
    bodyStart,
    bodyEnd: pos,
    altMediaRef,
    colorTransform,
    filters,
    blendMode,
    componentDataBindingXML,
  };
}

function tryConsumeSchema22TransformTail(
  data: Uint8Array,
  pos: number
): { end: number; targetRef: number; blendMode?: BlendMode } | null {
  const len = 128;
  if (pos + len > data.length) return null;
  const hasShortMarker =
    readU16At(data, pos + 8) === 0 &&
    data[pos + 10] === 0xff &&
    data[pos + 11] === 0xff &&
    data[pos + 12] === 0xfe &&
    data[pos + 13] === 0xff &&
    data[pos + 14] === 0x00;
  const hasExtendedMarker =
    data[pos + 7] === 0xff &&
    data[pos + 8] === 0xff &&
    data[pos + 9] === 0xff &&
    data[pos + 10] === 0xff &&
    data[pos + 11] === 0xff &&
    data[pos + 12] === 0xfe &&
    data[pos + 13] === 0xff &&
    data[pos + 14] === 0x00;
  if (!hasShortMarker && !hasExtendedMarker) return null;

  const targetRef = readU32At(data, pos + 15);
  if (targetRef < 1 || targetRef > MAX_MEDIA_REF) return null;

  for (const rel of [26, 46, 66, 86]) {
    if (data[pos + rel] !== 0x00 || data[pos + rel + 1] !== 0x00 || data[pos + rel + 2] !== 0x80 || data[pos + rel + 3] !== 0x3f) return null;
  }

  const blendMode = blendModeFromCode(data[pos + 23]);

  return { end: pos + len, targetRef, ...(blendMode ? { blendMode } : {}) };
}

function findSchema22TransformTail(
  data: Uint8Array,
  start: number,
  maxForward = 32
): { start: number; end: number; targetRef: number; blendMode?: BlendMode } | null {
  const limit = Math.min(data.length, start + maxForward);
  for (let pos = Math.max(0, start); pos <= limit; pos++) {
    const tail = tryConsumeSchema22TransformTail(data, pos);
    if (tail) return { start: pos, ...tail };
  }
  return null;
}

function findSchema22TailFallback(
  data: Uint8Array,
  start: number,
  maxForward = 64
): { start: number; end: number; targetRef: number } | null {
  const limit = Math.min(data.length - 5, start + maxForward);
  for (let p = start; p <= limit; p++) {
    if (data[p] !== 0xff || data[p + 1] !== 0xff || data[p + 2] !== 0xfe || data[p + 3] !== 0xff || data[p + 4] !== 0x00) continue;
    const targetRef = readU32At(data, p + 5);
    if (targetRef < 1 || targetRef > MAX_MEDIA_REF) continue;
    return { start: p, end: p + 118, targetRef };
  }
  return null;
}

function tryParseComponentDataBindingTail(
  data: Uint8Array,
  start: number,
  maxScan = 4096
): { xml: string; instanceName?: string; end: number } | null {
  const limit = Math.min(data.length - 4, start + maxScan);
  let instanceName: string | undefined;

  for (let p = start; p < limit; p++) {
    if (
      p + 10 <= data.length &&
      data[p] === 0x00 && data[p + 1] === 0x00 && data[p + 2] === 0x00 && data[p + 3] === 0x00 &&
      data[p + 4] === 0x00 && data[p + 5] === 0x80 && data[p + 6] === 0x00 && data[p + 7] === 0x00 &&
      data[p + 8] === 0x00 && data[p + 9] === 0x80
    ) {
      return null;
    }

    if (!hasFlashStringMarker(data, p)) continue;

    const decoded = readStrictFlashStringAt(data, p, {
      allowEmpty: true,
      allowExtended: true,
      maxChars: 65535,
    });
    if (!decoded) continue;

    if (instanceName === undefined && isPlausiblePlacementName(decoded.value)) {
      instanceName = decoded.value;
    }

    if (decoded.value.startsWith('<component ') && decoded.value.includes('</component>')) {
      return { xml: decoded.value, instanceName, end: decoded.end };
    }

    p = decoded.end - 1;
  }

  return null;
}
