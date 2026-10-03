/**
 * Flash's length-prefixed UTF-16LE strings in pre-CS5 *binary* `.fla` streams
 * (fla-decoder docs/FORMAT.md §2 "Length-prefixed strings"). Ported from
 * PR #45 (zndxcvbn).
 *
 *   Normal form:   FF FE FF <u8 charLen> <charLen × UTF-16LE>
 *   Extended form: FF FE FF FF <u16 charLen> <charLen × UTF-16LE>
 *
 * The extended form is only read when a caller opts in: the existing scanners
 * were written against the normal form and read a 0xFF length byte as 255.
 */

const utf16le = new TextDecoder('utf-16le');

export interface FlashString {
  value: string;
  /** Offset of the FF FE FF marker. */
  start: number;
  /** Offset of the first UTF-16LE code unit. */
  textStart: number;
  /** Offset just past the last code unit. */
  end: number;
  /** Length in UTF-16 code units. */
  charLength: number;
  extended: boolean;
}

export interface ReadFlashStringOptions {
  /** Accept a zero-length string (default false). */
  allowEmpty?: boolean;
  /** Read `FF FE FF FF <u16 len>` as the extended form (default false). */
  allowExtended?: boolean;
}

/** Decode `byteLength` bytes of UTF-16LE starting at `start`. */
export function decodeUtf16Le(data: Uint8Array, start: number, byteLength: number): string {
  return utf16le.decode(data.subarray(start, start + byteLength));
}

/** True when `FF FE FF` starts at `pos`. */
export function hasFlashStringMarker(data: Uint8Array, pos: number): boolean {
  return (
    pos >= 0 &&
    pos + 3 <= data.length &&
    data[pos] === 0xff &&
    data[pos + 1] === 0xfe &&
    data[pos + 2] === 0xff
  );
}

/**
 * Read a Flash string at `pos`. Returns null when there is no marker, the
 * string is empty (unless allowed), or it runs past the end of `data`.
 */
export function readFlashStringAt(
  data: Uint8Array,
  pos: number,
  opts: ReadFlashStringOptions = {}
): FlashString | null {
  if (!hasFlashStringMarker(data, pos) || pos + 4 > data.length) return null;

  const extended = opts.allowExtended === true && data[pos + 3] === 0xff;
  let charLength: number;
  let textStart: number;
  if (extended) {
    if (pos + 6 > data.length) return null;
    charLength = data[pos + 4] | (data[pos + 5] << 8);
    textStart = pos + 6;
  } else {
    charLength = data[pos + 3];
    textStart = pos + 4;
  }

  if (charLength === 0 && !opts.allowEmpty) return null;
  const end = textStart + charLength * 2;
  if (end > data.length) return null;

  return {
    value: decodeUtf16Le(data, textStart, charLength * 2),
    start: pos,
    textStart,
    end,
    charLength,
    extended,
  };
}

/** Every non-empty normal-form Flash string in `data`, in order. */
export function collectFlashStrings(data: Uint8Array): string[] {
  const strings: string[] = [];
  let pos = 0;
  while (pos < data.length - 4) {
    const s = readFlashStringAt(data, pos);
    if (s) {
      strings.push(s.value);
      pos = s.end;
      continue;
    }
    pos += 1;
  }
  return strings;
}
