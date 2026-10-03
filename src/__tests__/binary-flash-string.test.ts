import { describe, expect, it } from 'vitest';
import {
  collectFlashStrings,
  decodeUtf16Le,
  hasFlashStringMarker,
  readFlashStringAt,
} from '../binary-flash-string';

function utf16le(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    out.push(code & 0xff, (code >> 8) & 0xff);
  }
  return out;
}

const flashString = (s: string) => [0xff, 0xfe, 0xff, s.length, ...utf16le(s)];
const extendedFlashString = (s: string) => [0xff, 0xfe, 0xff, 0xff, s.length & 0xff, (s.length >> 8) & 0xff, ...utf16le(s)];

describe('readFlashStringAt', () => {
  it('reads the normal form and reports its offsets', () => {
    const data = Uint8Array.from([0xaa, ...flashString('Layer 1'), 0xbb]);
    expect(readFlashStringAt(data, 1)).toEqual({
      value: 'Layer 1',
      start: 1,
      textStart: 5,
      end: 5 + 14,
      charLength: 7,
      extended: false,
    });
    expect(readFlashStringAt(data, 0)).toBeNull();
  });

  it('decodes non-ASCII UTF-16', () => {
    const data = Uint8Array.from(flashString('Кадр 1'));
    expect(readFlashStringAt(data, 0)?.value).toBe('Кадр 1');
  });

  it('reads the extended form only when allowed', () => {
    const text = 'x'.repeat(200);
    const data = Uint8Array.from(extendedFlashString(text));
    // Without opt-in the 0xFF length byte means 255 chars, which runs past the end.
    expect(readFlashStringAt(data, 0)).toBeNull();
    const s = readFlashStringAt(data, 0, { allowExtended: true });
    expect(s).toMatchObject({ value: text, textStart: 6, charLength: 200, extended: true });
    expect(s?.end).toBe(data.length);
  });

  it('rejects empty strings unless allowed', () => {
    const data = Uint8Array.from([0xff, 0xfe, 0xff, 0x00]);
    expect(readFlashStringAt(data, 0)).toBeNull();
    expect(readFlashStringAt(data, 0, { allowEmpty: true })).toMatchObject({ value: '', end: 4 });
  });

  it('rejects strings that run past the end of the data', () => {
    expect(readFlashStringAt(Uint8Array.from(flashString('abc').slice(0, -1)), 0)).toBeNull();
    expect(readFlashStringAt(Uint8Array.from([0xff, 0xfe, 0xff]), 0)).toBeNull();
    expect(readFlashStringAt(Uint8Array.from([0xff, 0xfe, 0xff, 0xff, 0x01]), 0, { allowExtended: true })).toBeNull();
  });
});

describe('collectFlashStrings', () => {
  it('collects strings in order and skips noise and empty strings', () => {
    const data = Uint8Array.from([
      0xaa, ...flashString('Width'), 0xff, 0xfe, 0xff, 0x00, 0xbb, ...flashString('550'), 0, 0, 0, 0,
    ]);
    expect(collectFlashStrings(data)).toEqual(['Width', '550']);
  });

  it('resumes scanning after each string instead of matching inside it', () => {
    // The text itself contains FF FE FF; it must not be read as a second string.
    const inner = String.fromCharCode(0x41, 0xfeff, 0x01ff);
    const data = Uint8Array.from([...flashString(inner), 0, 0, 0, 0]);
    expect(collectFlashStrings(data)).toEqual([inner]);
  });
});

describe('helpers', () => {
  it('detects the marker and decodes raw UTF-16LE', () => {
    const data = Uint8Array.from(flashString('A'));
    expect(hasFlashStringMarker(data, 0)).toBe(true);
    expect(hasFlashStringMarker(data, 1)).toBe(false);
    expect(hasFlashStringMarker(data, -1)).toBe(false);
    expect(decodeUtf16Le(data, 4, 2)).toBe('A');
  });
});
