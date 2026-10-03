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

export interface ReadStrictFlashStringOptions extends ReadFlashStringOptions {
  /** Reject strings longer than this many code units. */
  maxChars?: number;
}

/**
 * Stricter {@link readFlashStringAt} used by the CPic object walker (PR #45),
 * which probes many offsets and needs false matches to fail: rejects a string
 * containing a NUL code unit, one longer than `maxChars`, and an `FF FE FF FF`
 * marker unless `allowExtended` is set (instead of reading 0xFF as a length).
 */
export function readStrictFlashStringAt(
  data: Uint8Array,
  pos: number,
  opts: ReadStrictFlashStringOptions = {}
): FlashString | null {
  if (!opts.allowExtended && hasFlashStringMarker(data, pos) && data[pos + 3] === 0xff) {
    return null;
  }
  const s = readFlashStringAt(data, pos, opts);
  if (!s) return null;
  if (opts.maxChars !== undefined && s.charLength > opts.maxChars) return null;
  for (let i = 0; i < s.charLength; i++) {
    if ((data[s.textStart + i * 2] | data[s.textStart + i * 2 + 1]) === 0) return null;
  }
  return s;
}

/**
 * Read NUL-terminated raw UTF-16LE at `pos` (no length prefix). Returns null
 * when the first code unit is NUL or missing; `end` is just past the NUL, or
 * the end of `data` when there is none.
 */
export function decodeRawUtf16UntilNull(
  data: Uint8Array,
  pos: number
): { value: string; end: number } | null {
  let i = pos;
  if (i + 2 > data.length || (data[i] | (data[i + 1] << 8)) === 0) return null;
  let value = '';
  while (i + 2 <= data.length) {
    const c = data[i] | (data[i + 1] << 8);
    if (c === 0) break;
    value += String.fromCharCode(c);
    i += 2;
  }
  return { value, end: Math.min(i + 2, data.length) };
}
