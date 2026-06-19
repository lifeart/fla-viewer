/**
 * SYMBOL-INSTANCE PLACEMENT decoder for pre-CS5 *binary* `.fla` files
 * (GitHub issue #8 — the frontier the shape-geometry work in
 * {@link ./binary-shape-decoder} deliberately left open).
 *
 * The geometry decoder makes a binary FLA's *library symbols* render: it
 * recovers the `CPicShape` vector art inside each `Symbol N` / `Page N` stream.
 * But a scene's STAGE stays empty, because a scene does not contain inline art —
 * it contains symbol *instances*: a library-item reference plus a placement
 * matrix. This module decodes those placements so scenes composite their
 * library symbols and real artwork appears on the stage.
 *
 * ── How a placed instance is encoded (verified against real Flash FLAs) ──────
 *
 * The class tree (FORMAT.md §3, reverse-engineered from Flash 8's flash.exe):
 *
 *     CPicObj
 *       └── CPicSymbol  (244 B)              — a library item / placement base
 *             ├── CPicShapeObj (244 B)        — placed graphic-symbol instance
 *             ├── CPicSprite   (408 B)        — placed movie-clip instance
 *             └── CPicButton   (548 B)        — placed button instance
 *
 * A placement is a `CPicSymbol`-derived object that appears as a CHILD of a
 * `CPicFrame` (`CPicPage → CPicLayer → CPicFrame → {CPicShape | placement}`).
 * Its `Serialize` (FORMAT.md §4 `CPicSymbol::Serialize`) lays out as:
 *
 *     CPicObj::Serialize         — u8 schema; u8 flags; children-list (NULL for
 *                                  a leaf placement); 2×s32 point (schema>=1);
 *                                  u8 (schema>=3); u8 (schema>=4)
 *     u8       symbol_schema
 *     6×u32    matrix            — a,b,c,d 16.16 fixed; tx,ty integer twips
 *     u16      field_b0
 *     u16      field_cc
 *     u8       field_90 marker   — (always 1) + 4×u16
 *     u8 len + ascii instance-name  (often empty)
 *     u32      media_ref         — THE LIBRARY REFERENCE: the N in "Symbol N"
 *
 * `media_ref` is the library item id (the same `u32` the library table writes
 * after each item name in `Contents`), which maps directly to the symbol number
 * and the `Symbol N` OLE stream. So a placement says "draw library item
 * media_ref here, transformed by this matrix" — exactly Flash's stage model.
 *
 * Real byte evidence (btnstrob.fla `Page 1`): a single `CPicSprite` child of the
 * scene's frame with matrix `(65536,0,0,65536, 6000,3000)` → scale 1.0,
 * tx=300 px, ty=150 px, and `media_ref=1` → library "Symbol 1" (a green
 * `#66ff00` graphic). That places Symbol 1's art at (300,150) on the 550×400
 * stage.
 *
 * ── Why a recovery scanner (not the structured walk) ─────────────────────────
 *
 * `CPicFrame` has dozens of schema-gated trailing fields (labels, tween data,
 * sound cues, child placements) gated by a schema observed up to ~32; even the
 * reference decoder cannot reliably consume them and falls back to a signature
 * scan (FORMAT.md §10, §11.5). A structured `CPicPage→…→CPicFrame` walk desyncs
 * in that tail and SILENTLY DROPS the frame's child placements — empirically it
 * misses most instances (it found 49 across a 140-FLA corpus where a recovery
 * scan found 279). So, exactly like the shape decoder, we use a recovery
 * scanner that locates placement bodies directly:
 *
 *   1. class-declaration recovery — every `FFFF <schema> <len> "CPicSprite"`
 *      (or CPicShapeObj / CPicButton) is guaranteed to be followed by a
 *      placement body; parse it.
 *   2. back-reference recovery — Flash instantiates additional placements of an
 *      already-declared class with a back-ref tag `0x80NN`. We first scan the
 *      stream for the NEWCLASS declarations to learn which combined-table index
 *      maps to an instance class, then accept a placement body only when the two
 *      bytes preceding it are a back-ref tag whose index resolves to an instance
 *      class. (Requiring a real preceding class tag — not a brute-force body
 *      match — eliminates the false positives that a naked signature scan
 *      produces.)
 *
 * No errors are silently swallowed (project rule): a body that fails validation
 * is skipped, never crashing the parse; nothing is fabricated.
 */

import { ByteReader, EndOfStreamError } from './binary-shape-decoder';
import type { Matrix } from './types';

/** 16.16 fixed-point divisor (1.0 == 0x00010000). */
const FIXED_16_16 = 65536;
/** Matrix translation unit: 1 px = 20 twips. */
const TWIPS_PER_PX = 20;

/** The three concrete `CPicSymbol` subclasses that represent a placement. */
export const INSTANCE_CLASS_NAMES = [
  'CPicSprite',
  'CPicShapeObj',
  'CPicButton',
] as const;
export type InstanceClassName = (typeof INSTANCE_CLASS_NAMES)[number];

/** Map an instance class name to a viewer symbol kind. */
export function instanceSymbolType(
  cls: InstanceClassName | string
): 'graphic' | 'movieclip' | 'button' {
  switch (cls) {
    case 'CPicButton':
      return 'button';
    case 'CPicShapeObj':
      return 'graphic';
    case 'CPicSprite':
    default:
      // CPicSprite is a movie clip; unknown placements default to movie clip.
      return 'movieclip';
  }
}

/** One decoded placement: a library reference + transform, from one stream. */
export interface DecodedInstance {
  /** Source class (CPicSprite / CPicShapeObj / CPicButton). */
  className: InstanceClassName | string;
  /** Library item id (the N in "Symbol N"); maps to a library entry. */
  mediaRef: number;
  /** Optional authoring instance name (usually empty for graphics). */
  instanceName: string;
  /** Placement transform (a/b/c/d unitless, tx/ty in pixels). */
  matrix: Matrix;
  /** How it was recovered (for honest coverage reporting). */
  recoveredVia: 'class_decl' | 'backref';
  /** Byte offset of the body start (just past the class tag). */
  bodyStart: number;
  /** Byte offset just past the body. */
  endPos: number;
}

/** Read a 6-u32 affine matrix (a,b,c,d 16.16 FP; tx,ty twips → px). */
function readMatrix(r: ByteReader): Matrix {
  const a = r.s32();
  const b = r.s32();
  const c = r.s32();
  const d = r.s32();
  const tx = r.s32();
  const ty = r.s32();
  return {
    a: a / FIXED_16_16,
    b: b / FIXED_16_16,
    c: c / FIXED_16_16,
    d: d / FIXED_16_16,
    tx: tx / TWIPS_PER_PX,
    ty: ty / TWIPS_PER_PX,
  };
}

/** Plausibility bounds rejecting parses that hit unrelated bytes. */
const MAX_SCALE = 64; // |a|,|b|,|c|,|d| as 16.16 multiples of 1.0
const MAX_TX_TWIPS = 20 * 200_000; // ±200k px
const MAX_MEDIA_REF = 5000;
const MAX_NAME_LEN = 0x40;

/**
 * Try to parse a `CPicSymbol`-derived placement body starting at `bodyStart`
 * (the byte just past the placement's class tag). Returns the decoded instance
 * or null if the bytes do not validate as a leaf placement. Uses a fresh reader
 * so a failed attempt never disturbs the caller.
 *
 * The validation gates (matrix-scale, media_ref range, clean instance name)
 * are what let a body match be trusted: a coincidental byte run almost never
 * satisfies all of them at once.
 */
export function tryParseInstanceAt(
  data: Uint8Array,
  bodyStart: number,
  className: InstanceClassName | string,
  recoveredVia: DecodedInstance['recoveredVia']
): DecodedInstance | null {
  if (bodyStart < 0 || bodyStart + 2 > data.length) return null;
  const r = new ByteReader(data);
  r.pos = bodyStart;
  try {
    const schema = r.u8();
    const flags = r.u8();
    if (schema < 1 || schema > 30 || flags > 0x40) return null;

    // CPicObj children list: a leaf placement has only the NULL terminator.
    const childTag = r.u16();
    if (childTag !== 0x0000) return null;

    // schema>=1: 2×s32 registration point (often the matrix's tx/ty in twips,
    // or the INT_MIN "uninitialised" sentinel — either way we ignore it and
    // use the authoritative matrix below).
    r.s32();
    r.s32();
    if (schema >= 3) r.u8();
    if (schema >= 4) r.u8();

    const symbolSchema = r.u8();
    if (symbolSchema < 1 || symbolSchema > 40) return null;

    const matrix = readMatrix(r);
    // A real placement matrix has a non-degenerate 2×2 and sane scale/translate.
    if (matrix.a === 0 && matrix.d === 0) return null;
    for (const v of [matrix.a, matrix.b, matrix.c, matrix.d]) {
      if (!Number.isFinite(v) || Math.abs(v) > MAX_SCALE) return null;
    }
    if (
      Math.abs(matrix.tx * TWIPS_PER_PX) > MAX_TX_TWIPS ||
      Math.abs(matrix.ty * TWIPS_PER_PX) > MAX_TX_TWIPS
    ) {
      return null;
    }

    r.u16(); // field_b0
    r.u16(); // field_cc
    r.u8(); // field_90 marker (always 1)
    r.u16();
    r.u16();
    r.u16();
    r.u16(); // 4×u16 field_90 struct

    const nameLen = r.u8();
    if (nameLen > MAX_NAME_LEN) return null;
    const nameBytes = r.bytes(nameLen);
    let instanceName = '';
    for (const ch of nameBytes) {
      // Control bytes (other than common whitespace) mean we mis-parsed.
      if (ch < 9) return null;
      instanceName += String.fromCharCode(ch);
    }

    const mediaRef = r.u32();
    if (mediaRef < 1 || mediaRef > MAX_MEDIA_REF) return null;

    return {
      className,
      mediaRef,
      instanceName,
      matrix,
      recoveredVia,
      bodyStart,
      endPos: r.pos,
    };
  } catch (err) {
    if (err instanceof EndOfStreamError || err instanceof Error) return null;
    throw err;
  }
}

/**
 * Scan a stream for every NEWCLASS declaration in stream order and return the
 * combined class+object table (each NEWCLASS allocates two slots — class then
 * object — so a 1-based back-ref index maps to `combined[idx-1]`). Mirrors the
 * `ArchiveReader` table semantics (FORMAT.md §2) but built by a forward scan,
 * not a structured walk, so it never desyncs on CPicFrame's tail.
 */
export function buildCombinedClassTable(data: Uint8Array): string[] {
  const combined: string[] = [];
  let i = 0;
  while (i < data.length - 6) {
    if (data[i] === 0xff && data[i + 1] === 0xff) {
      const nameLen = data[i + 4] | (data[i + 5] << 8);
      if (nameLen > 0 && nameLen < 40 && i + 6 + nameLen <= data.length) {
        let printable = true;
        for (let j = 0; j < nameLen; j++) {
          const c = data[i + 6 + j];
          // ASCII letters / digits / underscore — every CPic*/MFI* class name.
          const ok =
            (c >= 0x41 && c <= 0x5a) ||
            (c >= 0x61 && c <= 0x7a) ||
            (c >= 0x30 && c <= 0x39) ||
            c === 0x5f;
          if (!ok) {
            printable = false;
            break;
          }
        }
        if (printable) {
          let name = '';
          for (let j = 0; j < nameLen; j++) {
            name += String.fromCharCode(data[i + 6 + j]);
          }
          combined.push(name); // odd slot: the CRuntimeClass
          combined.push(name); // even slot: the created CObject
          i += 6 + nameLen;
          continue;
        }
      }
    }
    i += 1;
  }
  return combined;
}

function matchAt(hay: Uint8Array, needle: Uint8Array, at: number): boolean {
  if (at < 0 || at + needle.length > hay.length) return false;
  for (let j = 0; j < needle.length; j++) {
    if (hay[at + j] !== needle[j]) return false;
  }
  return true;
}

function indexOf(hay: Uint8Array, needle: Uint8Array, from: number): number {
  for (let i = Math.max(0, from); i <= hay.length - needle.length; i++) {
    if (matchAt(hay, needle, i)) return i;
  }
  return -1;
}

/** `<len u16> "CPicXxx"` — the tail of a NEWCLASS declaration for `cls`. */
function classDeclTail(cls: string): Uint8Array {
  const out = new Uint8Array(2 + cls.length);
  out[0] = cls.length;
  out[1] = 0;
  for (let i = 0; i < cls.length; i++) out[2 + i] = cls.charCodeAt(i);
  return out;
}

/**
 * Recover every symbol-instance placement in one `Page N` / `Symbol N` stream.
 *
 * Two complementary strategies (see module docstring):
 *   1. class-declaration recovery for the first instance of each instance class;
 *   2. back-reference recovery for the rest, gated on the back-ref index
 *      resolving to an instance class via {@link buildCombinedClassTable}.
 *
 * Taken-region tracking prevents the same bytes being recovered twice, and the
 * results are returned in stream order.
 */
export function scanForInstances(data: Uint8Array): DecodedInstance[] {
  const combined = buildCombinedClassTable(data);
  // 1-based combined indices that resolve to an instance class.
  const instanceIndices = new Set<number>();
  for (let k = 0; k < combined.length; k++) {
    if ((INSTANCE_CLASS_NAMES as readonly string[]).includes(combined[k])) {
      instanceIndices.add(k + 1);
    }
  }

  const found: DecodedInstance[] = [];
  const taken: Array<[number, number]> = [];
  const covered = (p: number) => taken.some(([s, e]) => s <= p && p < e);

  // 1) class-declaration recovery: the first placement of each instance class
  //    follows a guaranteed `FFFF <schema> <len> "CPicXxx"` declaration.
  for (const cls of INSTANCE_CLASS_NAMES) {
    const tail = classDeclTail(cls);
    let from = 0;
    for (;;) {
      const m = indexOf(data, tail, from);
      if (m < 0) break;
      from = m + 1;
      // Require the 4 bytes before to be a NEWCLASS tag (FF FF <u16 schema>).
      if (m < 4 || data[m - 4] !== 0xff || data[m - 3] !== 0xff) continue;
      const bodyStart = m + tail.length;
      if (covered(bodyStart)) continue;
      const inst = tryParseInstanceAt(data, bodyStart, cls, 'class_decl');
      if (!inst) continue;
      found.push(inst);
      taken.push([inst.bodyStart, inst.endPos]);
    }
  }

  // 2) back-reference recovery: a placement instantiated from an
  //    already-declared instance class is preceded by a back-ref tag 0x80NN
  //    whose index resolves to that instance class.
  let i = 2;
  while (i < data.length - 2) {
    if (covered(i)) {
      i += 1;
      continue;
    }
    const tag = data[i - 2] | (data[i - 1] << 8);
    if (tag & 0x8000) {
      const idx = tag & 0x7fff;
      if (instanceIndices.has(idx)) {
        const className = combined[idx - 1] ?? 'CPicSprite';
        const inst = tryParseInstanceAt(data, i, className, 'backref');
        if (inst) {
          found.push(inst);
          taken.push([inst.bodyStart, inst.endPos]);
          i = inst.endPos;
          continue;
        }
      }
    }
    i += 1;
  }

  found.sort((a, b) => a.bodyStart - b.bodyStart);
  return found;
}

/**
 * De-duplicate placements that are identical in (mediaRef + rounded matrix).
 *
 * The recovery scanner walks the WHOLE stream, so an animated scene that places
 * the same symbol at the same spot across several keyframes yields several
 * identical placements. Because we cannot reliably attribute placements to
 * individual frames (the CPicFrame tail is unparsed — see module docstring), we
 * composite all recovered placements into one frame; collapsing exact duplicates
 * avoids stacking many identical copies. Distinct positions are preserved.
 */
export function dedupeInstances(insts: DecodedInstance[]): DecodedInstance[] {
  const seen = new Set<string>();
  const out: DecodedInstance[] = [];
  const r4 = (n: number) => Math.round(n * 1000) / 1000;
  const r1 = (n: number) => Math.round(n * 10) / 10;
  for (const inst of insts) {
    const m = inst.matrix;
    const key = [
      inst.mediaRef,
      r4(m.a),
      r4(m.b),
      r4(m.c),
      r4(m.d),
      r1(m.tx),
      r1(m.ty),
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(inst);
  }
  return out;
}

/** A named placement recovered from a stream (instance name + kind only). */
export interface NamedInstance {
  /** Authoring instance name — the AS identifier on the timeline. */
  name: string;
  /** Element kind, from the placement class. */
  type: 'symbol' | 'text';
  /** For symbol instances, the symbol kind. */
  symbolType?: 'movieclip' | 'button' | 'graphic';
}

/** Placement classes whose records carry an instance name (incl. CPicText). */
const NAMED_PLACEMENT_CLASSES = ['CPicSprite', 'CPicButton', 'CPicShapeObj', 'CPicText'] as const;

function placementKind(cls: string): NamedInstance {
  switch (cls) {
    case 'CPicText':
      return { name: '', type: 'text' };
    case 'CPicButton':
      return { name: '', type: 'symbol', symbolType: 'button' };
    case 'CPicShapeObj':
      return { name: '', type: 'symbol', symbolType: 'graphic' };
    case 'CPicSprite':
    default:
      return { name: '', type: 'symbol', symbolType: 'movieclip' };
  }
}

const NAMED_INSTANCE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Flash device-font aliases — these are font names, never instance names. */
const DEVICE_FONTS = new Set(['_sans', '_serif', '_typewriter']);
/**
 * Button/movie-clip frame-label state words. These live on CPicFrame records, not
 * placements, but the heuristic name scan can pick one up as a placement's "first
 * identifier" — filter them so they don't masquerade as instance names.
 */
const STATE_LABELS = new Set([
  'Up', 'Over', 'Down', 'Hit', '_up', '_over', '_down', '_hit',
  'Normal', 'Selected', 'Hover', 'Disabled', 'Off', 'On',
  'up', 'over', 'down', 'hover', 'select', 'normal', 'selected', 'disabled', 'off', 'on',
]);

/**
 * The instance name within a placement body [start, end): the first identifier-
 * like Flash string (`FF FE FF <u8 len> <UTF-16LE>`), excluding font tokens
 * (`$…*`) and MFC class refs. Returns '' for an unnamed placement.
 */
function placementName(data: Uint8Array, start: number, end: number, classRefs: Set<string>): string {
  for (let p = start; p + 4 <= end; p++) {
    if (data[p] !== 0xff || data[p + 1] !== 0xfe || data[p + 2] !== 0xff) continue;
    const len = data[p + 3];
    if (len === 0 || len > 40 || p + 4 + len * 2 > end) continue;
    let s = '';
    let ok = true;
    for (let i = 0; i < len; i++) {
      const c = data[p + 4 + i * 2] | (data[p + 4 + i * 2 + 1] << 8);
      if (c < 0x20 || c > 0x7e) { ok = false; break; }
      s += String.fromCharCode(c);
    }
    p += 3 + len * 2;
    if (!ok || !NAMED_INSTANCE_RE.test(s)) continue;
    if (s.startsWith('$') || DEVICE_FONTS.has(s)) continue; // font tokens
    if (classRefs.has(s) || STATE_LABELS.has(s)) continue; // class refs / frame labels
    return s;
  }
  return '';
}

/**
 * Recover NAMED placements (instance name + kind) from one `Symbol N` / `Page N`
 * stream. Complements {@link scanForInstances}, which decodes placement geometry
 * (matrix + media_ref) for the older 16.16/ASCII format but rejects the FP8
 * variant (float32 matrix + `FF FE FF` UTF-16 name) used by newer files — which
 * drops the instance names a language tool needs.
 *
 * Locates each placement by its CArchive class tag (NEWCLASS declaration or
 * 0x80NN back-reference) and reads the instance name from the placement body,
 * skipping the version-specific matrix entirely. Unnamed placements are omitted.
 */
export function scanNamedInstances(data: Uint8Array): NamedInstance[] {
  const combined = buildCombinedClassTable(data);
  const classRefs = new Set(combined);
  const named = new Set<string>(NAMED_PLACEMENT_CLASSES);

  const starts: Array<{ pos: number; cls: string }> = [];

  // 1) class-declaration recovery — the first placement of each class.
  for (const cls of NAMED_PLACEMENT_CLASSES) {
    const tail = classDeclTail(cls);
    let from = 0;
    for (;;) {
      const m = indexOf(data, tail, from);
      if (m < 0) break;
      from = m + 1;
      if (m < 4 || data[m - 4] !== 0xff || data[m - 3] !== 0xff) continue;
      starts.push({ pos: m + tail.length, cls });
    }
  }

  // 2) back-reference recovery — 0x80NN tag whose index resolves to a placement class.
  const placementIndex = new Map<number, string>();
  for (let k = 0; k < combined.length; k++) {
    if (named.has(combined[k])) placementIndex.set(k + 1, combined[k]);
  }
  for (let i = 2; i < data.length - 2; i++) {
    const tag = data[i - 2] | (data[i - 1] << 8);
    if (!(tag & 0x8000)) continue;
    const cls = placementIndex.get(tag & 0x7fff);
    if (cls) starts.push({ pos: i, cls });
  }

  starts.sort((a, b) => a.pos - b.pos);

  const out: NamedInstance[] = [];
  const seen = new Set<string>();
  for (let s = 0; s < starts.length; s++) {
    const { pos, cls } = starts[s];
    const end = s + 1 < starts.length ? starts[s + 1].pos : data.length;
    const name = placementName(data, pos, end, classRefs);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ ...placementKind(cls), name });
  }

  // 3) Text-field recovery. Class-index back-refs find the FIRST CPicText of a
  //    stream; later text fields reference a prior CPicText OBJECT by a high MFC
  //    load-array index (e.g. 0x8083), which the class-index filter misses — so
  //    their names get swallowed into a preceding sprite's range. A text field
  //    references a font (`$…*` or a device font) immediately before its instance
  //    name, so recover the name as the next identifier after each font token.
  for (let p = 0; p + 4 <= data.length; p++) {
    if (data[p] !== 0xff || data[p + 1] !== 0xfe || data[p + 2] !== 0xff) continue;
    const len = data[p + 3];
    if (len === 0 || len > 40 || p + 4 + len * 2 > data.length) continue;
    let f = '';
    let ok = true;
    for (let i = 0; i < len; i++) {
      const c = data[p + 4 + i * 2] | (data[p + 4 + i * 2 + 1] << 8);
      if (c < 0x20 || c > 0x7e) { ok = false; break; }
      f += String.fromCharCode(c);
    }
    p += 3 + len * 2;
    if (!ok || !(f.startsWith('$') || DEVICE_FONTS.has(f))) continue;
    // The name is the next identifier within the same text record (bounded window).
    const name = placementName(data, p + 1, Math.min(data.length, p + 200), classRefs);
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push({ type: 'text', name });
    }
  }

  // 4) Name-field recovery. A CPicSymbol instance name is serialized as an EMPTY
  //    Flash string immediately followed by the name Flash string
  //    (FF FE FF 00 · FF FE FF <name>). Catches sprite/button placements whose
  //    object-index back-ref start wasn't detected (e.g. prevBtn, a sibling of an
  //    already-found nextBtn). Only ADDS missed names (existing ones are deduped).
  for (let p = 0; p + 8 <= data.length; p++) {
    if (data[p] !== 0xff || data[p + 1] !== 0xfe || data[p + 2] !== 0xff || data[p + 3] !== 0x00) continue;
    const q = p + 4;
    if (data[q] !== 0xff || data[q + 1] !== 0xfe || data[q + 2] !== 0xff) continue;
    const len = data[q + 3];
    if (len === 0 || len > 40 || q + 4 + len * 2 > data.length) continue;
    let s = '';
    let ok = true;
    for (let i = 0; i < len; i++) {
      const c = data[q + 4 + i * 2] | (data[q + 4 + i * 2 + 1] << 8);
      if (c < 0x20 || c > 0x7e) { ok = false; break; }
      s += String.fromCharCode(c);
    }
    p = q + 3 + len * 2;
    if (!ok || !NAMED_INSTANCE_RE.test(s)) continue;
    if (s.startsWith('$') || DEVICE_FONTS.has(s) || classRefs.has(s) || STATE_LABELS.has(s) || seen.has(s)) continue;
    seen.add(s);
    out.push({ type: 'symbol', symbolType: 'movieclip', name: s });
  }
  return out;
}
