import { describe, expect, it } from 'vitest';
import {
  collectFlashStrings,
  decodeRawUtf16UntilNull,
  decodeUtf16Le,
  hasFlashStringMarker,
  readFlashStringAt,
  readStrictFlashStringAt,
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

describe('readStrictFlashStringAt', () => {
  it('reads what readFlashStringAt reads when nothing is suspicious', () => {
    const data = Uint8Array.from(flashString('Layer 1'));
    expect(readStrictFlashStringAt(data, 0)).toEqual(readFlashStringAt(data, 0));
  });

  it('rejects a NUL code unit and strings over maxChars', () => {
    expect(readStrictFlashStringAt(Uint8Array.from(flashString('a\u0000b')), 0)).toBeNull();
    const data = Uint8Array.from(flashString('abcdef'));
    expect(readStrictFlashStringAt(data, 0, { maxChars: 5 })).toBeNull();
    expect(readStrictFlashStringAt(data, 0, { maxChars: 6 })?.value).toBe('abcdef');
  });

  it('rejects the extended marker unless allowed instead of reading 0xFF as a length', () => {
    const long = 'y'.repeat(300);
    const data = Uint8Array.from(extendedFlashString(long));
    expect(readStrictFlashStringAt(data, 0)).toBeNull();
    expect(readStrictFlashStringAt(data, 0, { allowExtended: true })?.value).toBe(long);
    // A 255-char normal string after the extended marker byte would otherwise fit.
    const ambiguous = Uint8Array.from([0xff, 0xfe, 0xff, 0xff, ...new Array(510).fill(0x41)]);
    expect(readFlashStringAt(ambiguous, 0)?.charLength).toBe(255);
    expect(readStrictFlashStringAt(ambiguous, 0)).toBeNull();
  });
});

describe('decodeRawUtf16UntilNull', () => {
  it('reads up to the NUL and points past it', () => {
    const data = Uint8Array.from([...utf16le('Hi!'), 0, 0, 0x41, 0]);
    expect(decodeRawUtf16UntilNull(data, 0)).toEqual({ value: 'Hi!', end: 8 });
  });

  it('stops at the end of the data when there is no NUL', () => {
    expect(decodeRawUtf16UntilNull(Uint8Array.from(utf16le('Hi')), 0)).toEqual({ value: 'Hi', end: 4 });
  });

  it('returns null for an empty string or no data', () => {
    expect(decodeRawUtf16UntilNull(Uint8Array.from([0, 0, 0x41, 0]), 0)).toBeNull();
    expect(decodeRawUtf16UntilNull(Uint8Array.from([0x41]), 0)).toBeNull();
  });
});
