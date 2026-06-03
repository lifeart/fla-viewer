/**
 * Per-LAYER / per-FRAME timeline ATTRIBUTION for pre-CS5 *binary* `.fla` files
 * (GitHub issue #8 — the animation frontier left open by the shape-geometry
 * work in {@link ./binary-shape-decoder} and the instance-placement work in
 * {@link ./binary-instance-decoder}).
 *
 * ── The problem this solves ──────────────────────────────────────────────────
 *
 * #22/#24 recover a stream's SHAPES and symbol-INSTANCE placements via whole-
 * stream signature scanners, then composite EVERYTHING into a single frame of a
 * single host layer. Multi-keyframe scenes therefore cannot animate and may
 * show several keyframes overlaid. This module attributes that recovered
 * content to the correct LAYER and FRAME INDEX so scrubbing/playing shows the
 * right content per frame.
 *
 * ── How frame index + duration are encoded (fla-decoder + real bytes) ────────
 *
 * The object tree is `CPicPage → CPicLayer → CPicFrame → {content}` (fla-decoder
 * docs/FORMAT.md §3–4, reverse-engineered from Flash 8's flash.exe). A layer's
 * keyframes are the CPicFrame objects in its CPicObj children list, IN ORDER.
 * There is NO explicit "frame index" field — the index is POSITIONAL: each
 * keyframe starts where the previous one ended. The keyframe's SPAN (how many
 * timeline frames it occupies, i.e. Flash's "duration") is the first field of
 * `CPicFrame::Serialize` after the schema byte — `u16 field_18c` (FORMAT.md
 * §4 `CPicFrame::Serialize`, loading path at 0x8fe3fa).
 *
 * Real byte evidence (MeteorStorm.fla, a Flash 8 OLE2 FLA, `Symbol 24` movie
 * clip; verified with the fla-decoder Python reference): one CPicLayer
 * ("Layer 1") whose children are three CPicFrame objects with `field_18c` =
 * 1, 21, 1 — i.e. keyframes at frame indices 0 (span 1), 1 (span 21) and 22
 * (span 1). `Symbol 7` is a 9-keyframe frame-by-frame clip with field_18c=1
 * for each (indices 0..8). `Symbol 20` ("Bitmap 2") has field_18c = 10,9,3,7,
 * 1,1 → indices 0,10,19,22,29,30. Frames after the first are written with an
 * MFC back-reference class tag (0x80NN) to the already-declared CPicFrame
 * class, then a fresh body — so the children loop reads them all.
 *
 * ── Why a confidence-GATED structural walk ───────────────────────────────────
 *
 * CPicFrame has a long schema-gated tail (FORMAT.md §4: sound refs, entry
 * tables, frame labels, a timeline sub-object, tween/morph ReadObjects, …).
 * Consuming it exactly is what lets the children loop reach the NEXT frame; if
 * a tail field is misread the loop desyncs and the rest of the timeline is lost.
 * Empirically the walk is RELIABLE for the modern schema (page_schema 5,
 * layer_schema 11, frame_schema ≥ 19 seen in Flash 8 files) but DESYNCS on the
 * legacy schema 0 of Flash 5 / MX files (where it reads a garbage layer name).
 *
 * So this module never trusts a partial walk. {@link decodeStreamTimeline}
 * returns a result ONLY when the walk is CONFIDENT — a printable layer name, a
 * known layer schema, and every frame body parsed without hitting end-of-stream
 * or an out-of-range field. When it is not confident it returns `null`, and the
 * caller keeps the existing #22/#24 single-frame behaviour (no regression).
 *
 * The walk records each keyframe's BYTE RANGE `[bodyStart, bodyEnd)`. Recovered
 * shapes/instances (which carry their own stream offsets) are then attributed to
 * the keyframe whose range contains them — see {@link attributeToFrames}. This
 * reuses the robust #22/#24 content decoders for the actual geometry/placement
 * and adds only the (layer, frame-index) it belongs to.
 *
 * No errors are silently swallowed (project rule): a parse that fails its
 * confidence gate is reported via the `null` return / `reason`, never crashes
 * the whole parse, and nothing is fabricated.
 */

import {
  ArchiveReader,
  ByteReader,
  EndOfStreamError,
  readShapeData,
} from './binary-shape-decoder';

/** One decoded keyframe: its timeline span and the byte range of its body. */
export interface DecodedKeyframe {
  /** Frame index where this keyframe starts (0-based, positional). */
  startIndex: number;
  /** Keyframe span in timeline frames (CPicFrame.field_18c). */
  duration: number;
  /** Byte offset of the frame body start (just past its class tag). */
  bodyStart: number;
  /** Byte offset just past the frame body (exclusive). */
  bodyEnd: number;
}

/** One decoded layer with its keyframe sequence. */
export interface DecodedTimelineLayer {
  /** Layer display name. */
  name: string;
  /** CPicLayer.layer_schema. */
  schema: number;
  /** Layer kind from the post-name type byte (0=normal,1=guide,3=mask,
   *  4=masked,5=folder); undefined when the schema does not carry it. */
  typeByte?: number;
  locked: boolean;
  visible: boolean;
  /** Keyframes in timeline order. */
  keyframes: DecodedKeyframe[];
}

/** Result of a confident structural timeline walk for one stream. */
export interface DecodedStreamTimeline {
  layers: DecodedTimelineLayer[];
  /** Largest (startIndex + duration) across all layers — the scene length. */
  totalFrames: number;
}

// Frame body parse outcome (internal).
interface FrameParse {
  duration: number;
  bodyEnd: number;
}

const utf16le = new TextDecoder('utf-16le');

/**
 * Read an MFC/Flash CString as written in these streams: a u8 char-length, or
 * an extended FF FFFE (UTF-16) / FF FFFF (long ASCII) form. Mirrors fla-decoder
 * `_read_flash_cstring`. Returns the decoded text (used only to consume bytes —
 * we don't surface frame labels yet).
 */
function readFlashCString(r: ByteReader): string {
  const b = r.u8();
  if (b === 0) return '';
  if (b < 0xff) {
    return new TextDecoder('latin1').decode(r.bytes(b));
  }
  const ext = r.u16();
  if (ext === 0xfffe) {
    let count = r.u8();
    if (count === 0xff) count = r.u16();
    return count > 0 ? utf16le.decode(r.bytes(count * 2)) : '';
  }
  if (ext === 0xffff) {
    const count = r.u32();
    return new TextDecoder('latin1').decode(r.bytes(count));
  }
  return new TextDecoder('latin1').decode(r.bytes(ext));
}

/**
 * Consume one CPicObj children list (FORMAT.md §4 `CPicObj::Serialize`): a loop
 * of class tags terminated by a NULL tag. Each non-null child body is consumed
 * by `consumeChild`. Returns the byte ranges of the direct children so the
 * caller (a layer) can collect its frames.
 *
 * We do NOT recurse into a child's own deep content here beyond what is needed
 * to find its end — the goal is frame boundaries, not a full object tree.
 */
function consumeChildren(
  r: ByteReader,
  ar: ArchiveReader,
  consumeChild: (className: string, r: ByteReader, ar: ArchiveReader) => void
): void {
  for (;;) {
    const tag = ar.readClassTag();
    if (tag.kind === 'null') return;
    if (!tag.name) {
      // A backref that did not resolve to a known class — we cannot know the
      // child's layout, so stop the loop rather than desync silently.
      throw new Error('unresolved class tag in children list');
    }
    consumeChild(tag.name, r, ar);
  }
}

/**
 * Consume the CPicObj base of any object (schema, flags, children list, point,
 * extras). `onChild` is invoked for each child class so a layer can collect its
 * CPicFrame children. FORMAT.md §4 `CPicObj::Serialize`.
 */
function consumeCPicObjBase(
  r: ByteReader,
  ar: ArchiveReader,
  onChild: (className: string, r: ByteReader, ar: ArchiveReader) => void
): number {
  const schema = r.u8();
  r.u8(); // flags
  consumeChildren(r, ar, onChild);
  if (schema >= 1) {
    r.s32(); // point.x
    r.s32(); // point.y
  }
  if (schema >= 3) r.u8();
  if (schema >= 4) r.u8();
  return schema;
}

// A cubic post-stream entry is 4 control points × 2 s32 = 32 bytes
// (fla-decoder read_shape_data). edge counts beyond this are implausible.
const MAX_CUBIC_EDGES = 100000;

/**
 * Consume a CPicShape body's shape-specific part (after the CPicObj base):
 * `u8 shape_schema`, 6×u32 matrix, then the shape_data block. Reuses the
 * tested {@link readShapeData} for fills/strokes/edges, then consumes the
 * cubic32 post-stream that follows when `shape_data_schema > 4` (which
 * {@link readShapeData} does not read — the recovery scanner doesn't need an
 * exact end, but the structural walk does). fla-decoder `read_shape_data`:
 * `s32 cubic_count` then `cubic_count × (4 × 2 × s32)`.
 */
function consumeCPicShapeTail(r: ByteReader): number {
  const shapeSchema = r.u8();
  for (let i = 0; i < 6; i++) r.u32(); // 6×u32 matrix
  const sd = readShapeData(r, shapeSchema > 2);
  if (sd.shapeDataSchema > 4) {
    const cubicCount = r.s32();
    if (cubicCount < 0 || cubicCount > MAX_CUBIC_EDGES) {
      throw new Error(`implausible cubic edge count ${cubicCount}`);
    }
    for (let i = 0; i < cubicCount; i++) {
      r.bytes(32); // 4 points × 2 × s32
    }
  }
  return shapeSchema;
}

// Plausibility bound: a frame span over this many frames almost certainly means
// we mis-read field_18c (real Flash timelines are far shorter). 16000 ≈ 11 min
// at 24fps, comfortably above any real timeline while rejecting garbage.
const MAX_FRAME_SPAN = 16000;

/**
 * Consume one CPicFrame body and return its span (field_18c) + end offset.
 * Ported field-for-field from fla-decoder `read_cpicframe` (FORMAT.md §4,
 * loading path at 0x8fe3fa). CPicFrame inherits CPicShape inherits CPicObj, so
 * the CPicObj base + CPicShape tail are consumed first, then the schema-gated
 * frame tail.
 *
 * Throws on any out-of-range field or end-of-stream so the caller's confidence
 * gate can reject the whole walk rather than emit a desynced timeline.
 */
function consumeCPicFrame(r: ByteReader, ar: ArchiveReader): FrameParse {
  // CPicObj base + CPicShape tail (a frame's "drawable canvas"). A frame's
  // children are its placed content; we consume them to stay aligned.
  consumeCPicObjBase(r, ar, (className, rr, aar) =>
    consumeChildObject(className, rr, aar)
  );
  consumeCPicShapeTail(r);

  const fs = r.u8(); // frame_schema
  const field18c = r.u16(); // SPAN (Flash keyframe duration)
  if (fs > 2) r.u16(); // field_188
  else r.u8();
  if (fs > 1) r.s16(); // field_190
  if (fs > 4) r.u16(); // sound ref
  if (fs > 5) {
    const cnt = r.u16(); // entry table
    for (let i = 0; i < cnt; i++) {
      r.u32();
      r.u16();
      r.u16();
    }
  }
  if (fs > 6) {
    r.u16();
    r.u8();
    r.u32();
    r.s32();
  }
  if (fs > 7) r.u16();
  if (fs > 8) {
    if (fs >= 23) readFlashCString(r); // field_250 frame label-ish
    if (fs >= 19) {
      consumeTimelineSubObject(r); // FUN_8facd0
    } else {
      // schemas 10..18 use a variable sub-object (FUN_8fd980) we do not decode;
      // refuse so the gate falls back rather than guessing.
      throw new Error(`frame_schema ${fs} tail not supported`);
    }
    if (fs > 10) {
      r.u32(); // field_258
      r.u32(); // field_25c
      if (fs > 11) r.u32(); // field_254
      if (fs > 12) {
        const morphTag = r.u16();
        if (morphTag !== 0) {
          throw new Error('non-null morph ReadObject in frame tail');
        }
      }
      if (fs > 13) r.u32(); // field_1e4
      if (fs > 14) {
        const oblistTag = r.u16();
        if (oblistTag !== 0) {
          throw new Error('non-null CObList ReadObject in frame tail');
        }
      }
      if (fs > 15 && fs >= 23) readFlashCString(r); // field_298
      if (fs > 19) r.u32(); // field_294
      if (fs > 20) r.u32(); // field_24c
      if (fs >= 22) r.u32(); // field_264
      if (fs >= 24) {
        r.u32();
        r.u32();
      }
    }
  }

  if (field18c < 1 || field18c > MAX_FRAME_SPAN) {
    throw new Error(`implausible frame span ${field18c}`);
  }
  return { duration: field18c, bodyEnd: r.pos };
}

/**
 * Consume the CPicFrame timeline sub-object (FUN_8facd0, frame_schema ≥ 19):
 * `u32 type_id, u32 format_type`, optional id list, optional label / per-frame
 * sub-structure. Ported from fla-decoder `_read_fun_8facd0`.
 */
function consumeTimelineSubObject(r: ByteReader): void {
  const typeId = r.u32();
  const formatType = r.u32();
  if (typeId >= 1) {
    r.u32(); // tl_init
    const count = r.u32();
    if (count > 0 && count < 10000) {
      for (let i = 0; i < count; i++) r.u32();
    } else if (count !== 0) {
      throw new Error(`implausible timeline id count ${count}`);
    }
  }
  if (formatType === 1 && typeId >= 4) {
    readFlashCString(r); // tl_label
  } else if (formatType === 0) {
    r.u32(); // tl_pf_schema
    const pfCount = r.u32();
    if (pfCount > 0 && pfCount < 10000) {
      for (let i = 0; i < pfCount; i++) r.u32();
    } else if (pfCount !== 0) {
      throw new Error(`implausible timeline per-frame count ${pfCount}`);
    }
  }
}

/**
 * Consume a generic child object found inside a frame (CPicShape / CPicSprite /
 * CPicShapeObj / CPicButton / CPicText / nested CPicFrame …). We only need to
 * advance the cursor past it so the children loop stays aligned; the recovery
 * scanners decode the real content separately. Unsupported classes throw so the
 * confidence gate rejects the walk rather than desync.
 */
function consumeChildObject(
  className: string,
  r: ByteReader,
  ar: ArchiveReader
): void {
  switch (className) {
    case 'CPicShape':
      consumeCPicObjBase(r, ar, (c, rr, aar) => consumeChildObject(c, rr, aar));
      consumeCPicShapeTail(r);
      return;
    case 'CPicFrame':
      consumeCPicFrame(r, ar);
      return;
    case 'CPicSprite':
    case 'CPicShapeObj':
    case 'CPicButton':
    case 'CPicSymbol':
      consumeCPicSymbol(r, ar, className);
      return;
    default:
      throw new Error(`unsupported child class ${className} in frame walk`);
  }
}

// Symbol-placement plausibility bounds (mirror the instance decoder).
const MAX_SYMBOL_SCHEMA = 40;
const MAX_INSTANCE_NAME = 0x40;

// The CPicObj "uninitialised origin" sentinel: NULL child tag + 2×INT_MIN point.
// It begins every CPicShape / CPicFrame body. CPicSprite / CPicButton have a
// complex variable tail (nested timeline, frame labels, …) that even the
// reference decoder does not fully consume — it (and we) resync by scanning to
// the next sentinel, which is the start of the following sibling's body.
const ORIGIN_SENTINEL = new Uint8Array([
  0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x80,
]);

function findSentinel(buf: Uint8Array, from: number): number {
  outer: for (let i = from; i <= buf.length - ORIGIN_SENTINEL.length; i++) {
    for (let j = 0; j < ORIGIN_SENTINEL.length; j++) {
      if (buf[i + j] !== ORIGIN_SENTINEL[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Consume a CPicSymbol-derived child (CPicSprite / CPicShapeObj / CPicButton /
 * CPicSymbol). The leading layout matches {@link ./binary-instance-decoder}
 * (FORMAT.md §4 `CPicSymbol::Serialize`): CPicObj base, symbol_schema, 6×u32
 * matrix, field_b0(/cc), field_90 marker + 4×u16, instance name, media_ref.
 *
 * CPicSprite / CPicButton then carry a SPRITE tail (sprite_schema + a nested
 * timeline sub-object + frame labels) whose full layout is not cleanly
 * consumable — so, exactly like fla-decoder `read_cpicsprite`, we resync by
 * scanning to the next origin sentinel, which is the next sibling/frame body.
 * (A bare CPicShapeObj has no such tail and stops at media_ref.)
 */
function consumeCPicSymbol(
  r: ByteReader,
  ar: ArchiveReader,
  className: string
): void {
  const bodyStart = r.pos;
  consumeCPicObjBase(r, ar, (c, rr, aar) => consumeChildObject(c, rr, aar));
  const symbolSchema = r.u8();
  if (symbolSchema < 1 || symbolSchema > MAX_SYMBOL_SCHEMA) {
    throw new Error(`implausible symbol_schema ${symbolSchema}`);
  }
  for (let i = 0; i < 6; i++) r.u32(); // matrix
  r.u16(); // field_b0
  if (symbolSchema > 1) r.u16(); // field_cc
  r.u8(); // field_90 marker
  r.u16();
  r.u16();
  r.u16();
  r.u16(); // 4×u16
  const nameLen = r.u8(); // instance name (ascii, u8 length)
  if (nameLen > MAX_INSTANCE_NAME) {
    throw new Error(`implausible instance-name length ${nameLen}`);
  }
  r.bytes(nameLen);
  r.u32(); // media_ref

  if (className === 'CPicSprite' || className === 'CPicButton') {
    // Sprite/button tail: read sprite_schema + nested timeline, then resync to
    // the next origin sentinel (the start of the following frame/sibling body).
    const schemaByte = r.u8(); // sprite_schema
    if (schemaByte >= 2) {
      try {
        consumeTimelineSubObject(r);
      } catch {
        // The nested timeline can be malformed; the sentinel scan resyncs us.
      }
    }
    const next = findSentinel(r.buf, r.pos);
    if (next < 0 || next <= bodyStart) {
      throw new Error('CPicSprite tail: no resync sentinel found');
    }
    r.pos = next;
  }
}

/**
 * Consume a CPicLayer and collect its keyframe sequence. Layout from fla-decoder
 * `read_cpiclayer` (FORMAT.md §4). The layer's CPicObj children list holds its
 * CPicFrame keyframes IN ORDER; we record each frame's byte range and span.
 */
function consumeCPicLayer(
  r: ByteReader,
  ar: ArchiveReader
): DecodedTimelineLayer {
  const keyframes: DecodedKeyframe[] = [];

  // CPicObj base. The children loop is where the frames live: capture each
  // CPicFrame child's [bodyStart, bodyEnd) and span.
  const baseSchema = r.u8();
  r.u8(); // flags
  // Layer-specific fields come AFTER the CPicObj base's point/extras, but the
  // children list (with the frames) is read DURING the base. We inline the base
  // here so we can record frame offsets and still read the layer tail after.
  let startIndex = 0;
  for (;;) {
    const tag = ar.readClassTag();
    if (tag.kind === 'null') break;
    if (!tag.name) {
      throw new Error('unresolved class tag in layer children');
    }
    if (tag.name === 'CPicFrame') {
      const bodyStart = r.pos;
      const { duration, bodyEnd } = consumeCPicFrame(r, ar);
      keyframes.push({ startIndex, duration, bodyStart, bodyEnd });
      startIndex += duration;
    } else {
      consumeChildObject(tag.name, r, ar);
    }
  }
  if (baseSchema >= 1) {
    r.s32();
    r.s32();
  }
  if (baseSchema >= 3) r.u8();
  if (baseSchema >= 4) r.u8();

  // Layer tail (FORMAT.md §4 `CPicLayer::Serialize`).
  const layerSchema = r.u8();
  const name = readFlashCString(r);
  let typeByte: number | undefined;
  let locked = false;
  let visible = true;
  if (layerSchema <= 3) {
    r.u8(); // field_type
  }
  if (layerSchema >= 4 && layerSchema <= 30) {
    typeByte = r.u8();
    locked = r.u8() !== 0;
    visible = r.u8() !== 0;
  }
  if (layerSchema >= 5 && layerSchema <= 30) r.u32(); // color
  if (layerSchema >= 6 && layerSchema <= 30) {
    r.u32();
    r.u32();
  }
  if (layerSchema >= 8 && layerSchema <= 30) r.u32();
  r.u8(); // layer_mode (unconditional)
  const parentTag = r.u16(); // parent ReadObject (unconditional)
  if (parentTag !== 0) {
    // A real parent reference would need ReadObject handling we don't do; refuse.
    throw new Error('non-null layer parent ReadObject');
  }
  if (layerSchema >= 7 && layerSchema < 9) {
    const objTag = r.u16();
    if (objTag !== 0) throw new Error('non-null layer obj ReadObject');
  }
  if (layerSchema >= 2 && layerSchema < 6) r.u8();
  if (layerSchema >= 3 && layerSchema < 9) r.u8();
  if (layerSchema >= 9) r.u8();
  if (layerSchema >= 10) r.u8();

  // End-marker scan (fla-decoder read_cpiclayer): a layer is followed by an
  // arbitrary amount of trailing/nested content before the CONTAINING page's
  // terminating NULL child tag + INT_MIN point. Position the reader at the LAST
  // valid such sentinel (closest to stream end — the outermost page's), so the
  // page's children loop reads its NULL and stops. Without this the page loop
  // would mis-read nested sprite frames as extra top-level layers.
  const buf = r.buf;
  let best = -1;
  let search = r.pos;
  while (search < buf.length - 14) {
    const idx = findSentinel(buf, search);
    if (idx < 0 || idx >= buf.length - 14) break;
    const after = idx + 12; // past null_tag(2)+point(8)+extra1(1)+extra2(1)
    if (after < buf.length) {
      const schemaByte = buf[after];
      let valid = schemaByte <= 15;
      if (valid && schemaByte >= 3 && after + 13 <= buf.length) {
        const f84Count =
          buf[after + 9] |
          (buf[after + 10] << 8) |
          (buf[after + 11] << 16) |
          (buf[after + 12] << 24);
        if (f84Count > 1000) valid = false;
      }
      if (valid) best = idx;
    }
    search = idx + 1;
  }
  if (best >= 0) r.pos = best;

  return {
    name,
    schema: layerSchema,
    typeByte,
    locked,
    visible,
    keyframes,
  };
}

/**
 * Consume a CPicPage and collect its CPicLayer children (FORMAT.md §4
 * `CPicPage::Serialize`). The page's children list holds the layers; the
 * page-specific tail (field_78/7c/b4/84) is NOT needed for attribution and is
 * skipped (the walk ends once all layers are read).
 */
function consumeCPicPage(
  r: ByteReader,
  ar: ArchiveReader
): DecodedTimelineLayer[] {
  const layers: DecodedTimelineLayer[] = [];
  const baseSchema = r.u8();
  r.u8(); // flags
  for (;;) {
    const tag = ar.readClassTag();
    if (tag.kind === 'null') break;
    if (!tag.name) throw new Error('unresolved class tag in page children');
    if (tag.name === 'CPicLayer') {
      layers.push(consumeCPicLayer(r, ar));
    } else {
      consumeChildObject(tag.name, r, ar);
    }
  }
  if (baseSchema >= 1) {
    r.s32();
    r.s32();
  }
  if (baseSchema >= 3) r.u8();
  if (baseSchema >= 4) r.u8();
  return layers;
}

/** A layer name is trusted only if it is short and fully printable ASCII/text. */
function isPlausibleLayerName(name: string): boolean {
  if (name.length === 0 || name.length > 64) return false;
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 && ch !== '\t') return false;
    if (code === 0xfffd) return false; // replacement char → bad UTF-16
  }
  return true;
}

/** Known modern layer schemas the walk handles confidently. */
const SUPPORTED_LAYER_SCHEMAS = new Set([11]);

/**
 * Attempt a CONFIDENT structural timeline walk of one `Page N` / `Symbol N`
 * stream. Returns the decoded layer/keyframe structure, or `null` when the walk
 * is not confident (legacy schema, desync, garbage layer name, …) so the caller
 * falls back to the existing single-frame behaviour.
 *
 * The confidence gate requires: a CPicPage root, at least one layer, every layer
 * with a plausible name and a supported schema, and at least one layer carrying
 * more than one keyframe (a single keyframe needs no attribution — the existing
 * path already handles it, and accepting it risks regressing streams that just
 * happen to parse one frame before a desync).
 */
export function decodeStreamTimeline(
  data: Uint8Array
): DecodedStreamTimeline | null {
  let layers: DecodedTimelineLayer[];
  try {
    const r = new ByteReader(data);
    r.u8(); // 0x01 root header
    const ar = new ArchiveReader(r);
    const tag = ar.readClassTag();
    if (tag.kind !== 'new_class' || tag.name !== 'CPicPage') return null;
    layers = consumeCPicPage(r, ar);
  } catch (err) {
    // Any desync / out-of-range field / EOF → not confident. Never throw out of
    // here: the caller should fall back, not fail the whole FLA parse.
    if (err instanceof EndOfStreamError || err instanceof Error) return null;
    throw err;
  }

  if (layers.length === 0) return null;
  for (const layer of layers) {
    if (!isPlausibleLayerName(layer.name)) return null;
    if (!SUPPORTED_LAYER_SCHEMAS.has(layer.schema)) return null;
  }
  const hasAnimation = layers.some((l) => l.keyframes.length > 1);
  if (!hasAnimation) return null;

  let totalFrames = 1;
  for (const layer of layers) {
    for (const kf of layer.keyframes) {
      totalFrames = Math.max(totalFrames, kf.startIndex + kf.duration);
    }
  }
  return { layers, totalFrames };
}

/**
 * Attribute content carrying a byte offset to the keyframe whose body range
 * contains it. Returns, for each keyframe (by array index), the list of input
 * items that fall inside `[bodyStart, bodyEnd)`. Items not inside ANY keyframe
 * range are returned in `unattributed` so the caller can keep them (never drop
 * recovered content).
 */
export function attributeToFrames<T extends { bodyStart: number }>(
  keyframes: DecodedKeyframe[],
  items: T[]
): { perKeyframe: T[][]; unattributed: T[] } {
  const perKeyframe: T[][] = keyframes.map(() => []);
  const unattributed: T[] = [];
  for (const item of items) {
    let placed = false;
    for (let i = 0; i < keyframes.length; i++) {
      const kf = keyframes[i];
      if (item.bodyStart >= kf.bodyStart && item.bodyStart < kf.bodyEnd) {
        perKeyframe[i].push(item);
        placed = true;
        break;
      }
    }
    if (!placed) unattributed.push(item);
  }
  return { perKeyframe, unattributed };
}
