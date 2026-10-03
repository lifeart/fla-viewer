/**
 * Heuristic CPicText reader: finds the font, colour, characters and instance
 * name by scanning the body, so the second timeline walker can step over text
 * fields. Ported from PR #45 (zndxcvbn).
 */
import { CArchiveReader, type CArchiveObjectHeader } from './binary-carchive';
import {
  readCPicObjLeafBase,
  type CPicObjBase,
} from './binary-cpic-object';
import {
  hasFlashStringMarker,
  readStrictFlashStringAt,
  decodeRawUtf16UntilNull,
} from './binary-flash-string';

export interface CPicTextResult {
  characters: string;
  fontFace?: string;
  bold?: boolean;
  fontSize?: number;
  width?: number;
  height?: number;
  alignment?: 'left' | 'center' | 'right' | 'justify';
  fillColor?: string;
  instanceName?: string;
  registrationPoint?: { x: number; y: number };
  bodyStart: number;
  bodyEnd: number;
}

function isFontFace(s: string): boolean {
  return s.startsWith('$') || s === '_sans' || s === '_serif' || s === '_typewriter' || s.endsWith('Font*') || s.endsWith('MT');
}

function isInstanceName(s: string): boolean {
  if (s.length < 2) return false;
  if (s.startsWith('$') || s.endsWith('MT')) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}

function isPlausibleTextCharacters(s: string): boolean {
  if (s.length === 0) return false;
  let printable = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0xfeff || c === 0xfffd) return false;
    if (c === 0x0a || c === 0x0d || c === 0x09) {
      printable += 1;
      continue;
    }
    if (c >= 0x20 && c <= 0x7e) {
      printable += 1;
      continue;
    }
    if (c >= 0x0400 && c <= 0x052f) {
      printable += 1;
      continue;
    }
    return false;
  }
  return printable === s.length;
}

export function readCPicText(
  reader: CArchiveReader,
  _header: CArchiveObjectHeader,
  scanEndLimit?: number
): CPicTextResult | null {
  const bodyStart = reader.pos;
  const scanEnd = Math.min(reader.data.length, scanEndLimit ?? bodyStart + 2000);

  let base: CPicObjBase<never>;
  try {
    base = readCPicObjLeafBase(reader);
  } catch {
    return null;
  }

  if (base.schema < 1 || base.schema > 30 || base.flags > 0x40) return null;

  const textSchema = reader.readU8();
  if (textSchema < 1 || textSchema > 30) return null;

  let fontSize: number | undefined;
  let width: number | undefined;
  let height: number | undefined;
  let alignment: 'left' | 'center' | 'right' | 'justify' | undefined;

  if (bodyStart + 60 <= scanEnd) {
    const alignByte = reader.data[bodyStart + 17];
    if (alignByte <= 3) {
      alignment = (['left', 'center', 'right', 'justify'] as const)[alignByte];
    }

    const rawSize = reader.data[bodyStart + 44];
    if (rawSize > 0 && rawSize < 300) fontSize = rawSize;

    const rawW = (reader.data[bodyStart + 44] << 8) | reader.data[bodyStart + 43];
    if (rawW > 0 && rawW < 100000) width = rawW / 20;

    if (bodyStart + 53 <= scanEnd) {
      const rawH = (reader.data[bodyStart + 52] << 8) | reader.data[bodyStart + 51];
      if (rawH > 0 && rawH < 100000) height = rawH / 20;
    }
  }

  reader.pos = Math.min(Math.max(reader.pos, bodyStart + 55), scanEnd);

  let fontFace: string | undefined;
  let lastFontFaceEnd = reader.pos;

  for (let p = reader.pos; p + 4 < scanEnd; p++) {
    if (!hasFlashStringMarker(reader.data, p)) continue;
    if (reader.data[p + 3] === 0) continue;

    const decoded = readStrictFlashStringAt(reader.data, p, { maxChars: 100 });
    if (!decoded) continue;

    if (isFontFace(decoded.value)) {
      if (!fontFace) fontFace = decoded.value;
      lastFontFaceEnd = decoded.end;
    }
    p = decoded.end - 1;
  }

  let fillColor = '#000000';
  if (lastFontFaceEnd > bodyStart + 10) {
    for (let p = lastFontFaceEnd; p + 8 <= scanEnd; p++) {
      if (
        reader.data[p] <= 1 && reader.data[p + 1] === 0 &&
        reader.data[p + 2] === 0 && reader.data[p + 3] === 0
      ) {
        const b = reader.data[p + 4];
        const g = reader.data[p + 5];
        const r = reader.data[p + 6];
        const a = reader.data[p + 7];
        if (a === 0xff && (r | g | b) !== 0) {
          fillColor = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
        }
        break;
      }
    }
  }

  let bold: boolean | undefined;
  if (lastFontFaceEnd > bodyStart + 10) {
    for (let p = lastFontFaceEnd; p + 4 <= scanEnd; p++) {
      if (reader.data[p] === 0x22 && reader.data[p + 1] === 0x00) {
        bold = reader.data[p + 2] !== 0;
        break;
      }
    }
  }

  let characters = '';
  let textEnd = reader.pos;
  for (let p = lastFontFaceEnd; p + 4 < scanEnd; p++) {
    if (!hasFlashStringMarker(reader.data, p)) continue;
    if (reader.data[p + 3] !== 0) continue;

    const rawText = decodeRawUtf16UntilNull(reader.data, p + 4);
    if (rawText && rawText.end <= scanEnd && isPlausibleTextCharacters(rawText.value)) {
      characters = rawText.value;
      textEnd = rawText.end;
    }
  }

  let instanceName = '';
  let instanceEnd = textEnd;
  for (let p = textEnd; p + 4 < scanEnd; p++) {
    const decoded = readStrictFlashStringAt(reader.data, p, { maxChars: 40 });
    if (!decoded) continue;
    if (isInstanceName(decoded.value)) {
      instanceName = decoded.value;
      instanceEnd = decoded.end;
      break;
    }
    p = decoded.end - 1;
  }

  reader.pos = instanceName ? instanceEnd : Math.max(textEnd, lastFontFaceEnd);

  if (!characters && !instanceName) return null;

  return {
    characters,
    fontFace,
    bold,
    fontSize,
    width,
    height,
    alignment,
    fillColor,
    instanceName: instanceName || undefined,
    registrationPoint: base.registrationPoint,
    bodyStart,
    bodyEnd: reader.pos,
  };
}
