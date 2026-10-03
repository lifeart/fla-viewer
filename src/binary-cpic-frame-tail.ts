/**
 * Probe for a modern (schema >= 19) CPicFrame tail at a byte offset. The second
 * timeline walker uses it to resync after a body it cannot read exactly.
 * Ported from PR #45 (zndxcvbn); the key-mode list is what the SkyUI CS4 files
 * contain.
 */
import { readStrictFlashStringAt } from './binary-flash-string';

export interface CPicFrameTailProbe {
  pos: number;
  frameSchema: number;
  duration: number;
  keyMode: number;
}

export const KNOWN_CPIC_FRAME_KEY_MODES = new Set([
  0x0000,
  0x0200,
  0x0601,
  0x2000,
  0x2200,
  0x2600,
  0x3a00,
  0x3e00,
  0x4601,
  0x5401,
  0x5601,
  0x5a01,
]);

export function isKnownCPicFrameKeyMode(value: number): boolean {
  return KNOWN_CPIC_FRAME_KEY_MODES.has(value);
}

function readU16At(data: Uint8Array, pos: number): number {
  return pos + 2 <= data.length ? data[pos] | (data[pos + 1] << 8) : 0;
}

function readU32At(data: Uint8Array, pos: number): number {
  return pos + 4 <= data.length
    ? (data[pos] | (data[pos + 1] << 8) | (data[pos + 2] << 16) | data[pos + 3] * 0x1000000) >>> 0
    : 0;
}

export function readCPicFrameTailProbeAt(data: Uint8Array, pos: number): CPicFrameTailProbe | null {
  if (pos < 0 || pos + 24 > data.length) return null;
  const frameSchema = data[pos];
  if (frameSchema < 19 || frameSchema > 40) return null;

  const duration = data[pos + 1] | (data[pos + 2] << 8);
  if (duration < 1 || duration >= 16000) return null;

  const keyMode = frameSchema > 2 ? readU16At(data, pos + 3) : 0;
  if (!isKnownCPicFrameKeyMode(keyMode)) return null;

  let p = pos + 3;
  if (frameSchema > 2) p += 2;
  if (frameSchema > 1) p += 2;
  if (frameSchema > 4) p += 2;
  if (frameSchema > 5) {
    const count = readU16At(data, p);
    if (count !== 0) return null;
    p += 2;
  }
  if (frameSchema > 6) {
    if (p + 11 > data.length) return null;
    p += 2;
    p += 1;
    p += 4;
    p += 4;
  }
  if (frameSchema > 7) p += 2;
  if (frameSchema >= 23) {
    const decoded = readStrictFlashStringAt(data, p, { allowEmpty: true, maxChars: 255 });
    if (decoded) p = decoded.end;
  }
  if (p + 8 > data.length) return null;
  const typeId = readU32At(data, p);
  const formatType = readU32At(data, p + 4);
  if (typeId > 100000) return null;
  if (formatType !== 0 && formatType !== 1 && formatType !== 2) return null;

  return { pos, frameSchema, duration, keyMode };
}

export function isPlausibleCPicFrameTailAt(data: Uint8Array, pos: number): boolean {
  return readCPicFrameTailProbeAt(data, pos) !== null;
}

export function findCPicFrameTailProbeInRange(
  data: Uint8Array,
  start: number,
  end: number
): CPicFrameTailProbe | null {
  const limit = Math.min(end, data.length - 24);
  for (let p = Math.max(0, start); p <= limit; p++) {
    const tail = readCPicFrameTailProbeAt(data, p);
    if (tail) return tail;
  }
  return null;
}
