/**
 * SWF-style filter stack (drop shadow, blur, glow) in older CPicSprite /
 * CPicButton placement tails. Ported from PR #45 (zndxcvbn).
 */
import type { Filter } from './types';

const FIXED_16_16 = 65536;

class FilterReader {
  pos: number;
  private view: DataView;

  constructor(private data: Uint8Array, pos: number) {
    this.pos = pos;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  private need(bytes: number): void {
    if (this.pos + bytes > this.data.length) {
      throw new Error(`SWF filter stack: need ${bytes} bytes at 0x${this.pos.toString(16)}`);
    }
  }

  u8(): number {
    this.need(1);
    return this.data[this.pos++];
  }

  u16(): number {
    this.need(2);
    const value = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return value;
  }

  s32(): number {
    this.need(4);
    const value = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return value;
  }
}

function colorFromRgbBytes(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function isPlausibleNumber(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

function fixed16(reader: FilterReader): number {
  return reader.s32() / FIXED_16_16;
}

/**
 * Decode the SWF-style filter stack embedded in legacy CPicSprite/CPicButton
 * placement tails.
 *
 * Filter ids follow SWF FilterList order for the subset observed in pre-CS5
 * binary FLAs:
 *   0 = DropShadowFilter
 *   1 = BlurFilter
 *   2 = GlowFilter
 *
 * Other ids are left undecoded until their binary bodies are validated against
 * real FLA/XFL pairs; returning null keeps the caller from silently consuming a
 * tail with a guessed length.
 */
export function parseSwfFilterStack(
  data: Uint8Array,
  pos: number
): { filters: Filter[]; end: number } | null {
  if (pos >= data.length) return null;
  const reader = new FilterReader(data, pos);

  try {
    const count = reader.u8();
    if (count < 1 || count > 16) return null;

    const filters: Filter[] = [];
    for (let i = 0; i < count; i++) {
      const filterId = reader.u8();
      switch (filterId) {
        case 0: {
          const red = reader.u8();
          const green = reader.u8();
          const blue = reader.u8();
          const alpha = reader.u8() / 255;
          const blurX = fixed16(reader);
          const blurY = fixed16(reader);
          const angle = fixed16(reader) * 180 / Math.PI;
          const distance = fixed16(reader);
          const strength = reader.u16() / 256;
          const flags = reader.u8();
          // SWF DROPSHADOWFILTER: inner, knockout, composite source, then 5 bits of passes.
          const quality = Math.max(1, flags & 0x1f);
          if (
            !isPlausibleNumber(blurX, 0, 512) ||
            !isPlausibleNumber(blurY, 0, 512) ||
            !isPlausibleNumber(distance, 0, 4096) ||
            !isPlausibleNumber(strength, 0, 64)
          ) {
            return null;
          }
          filters.push({
            type: 'dropShadow',
            blurX,
            blurY,
            color: colorFromRgbBytes(red, green, blue),
            alpha,
            angle,
            distance,
            strength,
            inner: (flags & 0x80) !== 0,
            knockout: (flags & 0x40) !== 0,
            // 0x20 is CompositeSource: set when the object is drawn too.
            hideObject: (flags & 0x20) === 0,
            quality,
          });
          break;
        }
        case 1: {
          const blurX = fixed16(reader);
          const blurY = fixed16(reader);
          const flags = reader.u8();
          const quality = Math.max(1, flags >> 3);
          if (!isPlausibleNumber(blurX, 0, 512) || !isPlausibleNumber(blurY, 0, 512)) {
            return null;
          }
          filters.push({ type: 'blur', blurX, blurY, quality });
          break;
        }
        case 2: {
          const red = reader.u8();
          const green = reader.u8();
          const blue = reader.u8();
          const alpha = reader.u8() / 255;
          const blurX = fixed16(reader);
          const blurY = fixed16(reader);
          const strength = reader.u16() / 256;
          const flags = reader.u8();
          // SWF GLOWFILTER: inner, knockout, composite source, then 5 bits of passes.
          const quality = Math.max(1, flags & 0x1f);
          if (
            !isPlausibleNumber(blurX, 0, 512) ||
            !isPlausibleNumber(blurY, 0, 512) ||
            !isPlausibleNumber(strength, 0, 64)
          ) {
            return null;
          }
          filters.push({
            type: 'glow',
            blurX,
            blurY,
            color: colorFromRgbBytes(red, green, blue),
            strength,
            alpha,
            inner: (flags & 0x80) !== 0,
            knockout: (flags & 0x40) !== 0,
            quality,
          });
          break;
        }
        default:
          return null;
      }
    }
    return filters.length > 0 ? { filters, end: reader.pos } : null;
  } catch {
    return null;
  }
}
