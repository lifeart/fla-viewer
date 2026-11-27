/**
 * Embedded FLV video (Sorenson Spark / "h263 media") in an XFL FLA.
 *
 * Animate stores a video that was embedded from an FLV in `bin/M <n> <ts>.dat`,
 * not as an FLV: a fixed media header, a frame index, then the raw video frame
 * payloads back to back (audio, decoded to PCM, follows). Layout, as written by
 * Animate and mirrored by JPEXS' MovieBinDataGenerator (little-endian):
 *
 *   0      u8      0x03 (media .dat marker)
 *   1      u8      FLV video codec id (2 = Sorenson H.263, 4/5 = VP6, …)
 *   29     u32     width
 *   33     u32     height
 *   37     f64     duration (s)
 *   75     u8      1 if a frame index entry follows
 *   then per frame: u32 offset, u32 size, 8 bytes flags, u8 "another entry follows"
 *   then   u32     total size of the frame data, followed by the frame data
 *
 * The fixed offsets come from one writer, so the index is also searched for
 * (an offset-0 entry whose chain is contiguous and whose first frame starts with
 * a picture start code), and as a last resort the frames are split on H.263
 * picture start codes.
 */

import type { ParsedFLV } from './flv-parser';
import { VIDEO_CODEC_H263 } from './flv-parser';
import { readSorensonHeader, SorensonH263Decoder, type SorensonPicture } from './sorenson-h263';

export interface EmbeddedVideoStream {
  /** FLV video codec id (2 = Sorenson H.263). */
  codecId: number;
  width: number;
  height: number;
  /** One encoded picture per video frame, in display order. */
  frames: Uint8Array[];
}

const ENTRY_SIZE = 17;

function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

/** True if `b[o..]` begins with a Sorenson picture start code (17 bits `0…01`, version 0/1). */
function isPictureStart(b: Uint8Array, o: number): boolean {
  return o + 2 < b.length && b[o] === 0 && b[o + 1] === 0 && (b[o + 2] & 0xf8) === 0x80;
}

/**
 * Read a frame index whose "entry follows" flag sits at `flagPos`. Returns the
 * frames if the index is self-consistent, else null.
 */
function readIndexAt(bytes: Uint8Array, flagPos: number): Uint8Array[] | null {
  const entries: { offset: number; size: number }[] = [];
  let pos = flagPos;
  let expected = 0;
  while (pos < bytes.length && bytes[pos] === 1) {
    if (pos + 1 + ENTRY_SIZE > bytes.length) return null;
    const offset = u32(bytes, pos + 1);
    const size = u32(bytes, pos + 5);
    if (offset !== expected || size === 0) return null;
    entries.push({ offset, size });
    expected = offset + size;
    pos += ENTRY_SIZE;
  }
  if (bytes[pos] !== 0 || entries.length === 0) return null;
  const totalPos = pos + 1;
  if (totalPos + 4 > bytes.length || u32(bytes, totalPos) !== expected) return null;
  const base = totalPos + 4;
  if (base + expected > bytes.length || !isPictureStart(bytes, base)) return null;
  return entries.map((e) => bytes.subarray(base + e.offset, base + e.offset + e.size));
}

/** Split on picture start codes (fallback when no index is recognised). */
function splitOnStartCodes(bytes: Uint8Array, from: number): Uint8Array[] {
  const starts: number[] = [];
  for (let i = from; i + 2 < bytes.length; i++) {
    if (isPictureStart(bytes, i) && readSorensonHeader(bytes.subarray(i)) !== null) starts.push(i);
  }
  return starts.map((s, k) => bytes.subarray(s, k + 1 < starts.length ? starts[k + 1] : bytes.length));
}

/** Parse Animate's embedded-video `.dat`. Returns null if it isn't one. */
export function parseEmbeddedVideoDat(bytes: Uint8Array): EmbeddedVideoStream | null {
  if (bytes.length < 80 || bytes[0] !== 0x03) return null;
  const codecId = bytes[1];
  // FLV video codec ids are 2..7.
  if (codecId < 2 || codecId > 7) return null;
  let width = u32(bytes, 29);
  let height = u32(bytes, 33);

  let frames = readIndexAt(bytes, 75);
  if (!frames) {
    for (let p = 17; p < Math.min(bytes.length, 1024) && !frames; p++) {
      if (bytes[p] === 1 && u32(bytes, p + 1) === 0) frames = readIndexAt(bytes, p);
    }
  }
  if (!frames && codecId === VIDEO_CODEC_H263) frames = splitOnStartCodes(bytes, 17);
  if (!frames) frames = [];

  if (codecId === VIDEO_CODEC_H263 && frames.length > 0) {
    const h = readSorensonHeader(frames[0]);
    if (h && (!width || !height || width > 8192 || height > 8192)) {
      width = h.width;
      height = h.height;
    }
  }
  return { codecId, width, height, frames };
}

/** The Sorenson H.263 stream of a parsed FLV, or null if it has another codec. */
export function embeddedVideoFromFLV(parsed: ParsedFLV): EmbeddedVideoStream | null {
  const tags = parsed.videoTags.filter((t) => t.codecId === VIDEO_CODEC_H263 && t.videoData.length > 0);
  if (tags.length === 0) return null;
  const header = readSorensonHeader(tags[0].videoData);
  return {
    codecId: VIDEO_CODEC_H263,
    width: header?.width ?? parsed.metadata.width ?? 0,
    height: header?.height ?? parsed.metadata.height ?? 0,
    frames: tags.map((t) => t.videoData),
  };
}

/**
 * Random access to the decoded frames of a Sorenson stream. P pictures depend
 * on the previous I/P picture, so a seek decodes forward from the nearest I
 * picture; playing forward decodes one picture per frame.
 */
export class EmbeddedVideoDecoder {
  private readonly decoder = new SorensonH263Decoder();
  private readonly types: (string | null)[];
  /** Index of the last I/P picture held as the decoder's reference, or -1. */
  private referenceIndex = -1;
  private lastIndex = -1;
  private lastPicture: SorensonPicture | null = null;
  private warned = false;

  constructor(private readonly stream: EmbeddedVideoStream) {
    this.types = stream.frames.map((f) => readSorensonHeader(f)?.type ?? null);
  }

  get frameCount(): number {
    return this.stream.frames.length;
  }

  /** The picture for frame `index` (clamped to the stream), or null if nothing decodes. */
  getFrame(index: number): SorensonPicture | null {
    const n = this.stream.frames.length;
    if (n === 0) return null;
    const target = Math.max(0, Math.min(n - 1, Math.floor(index)));
    if (target === this.lastIndex) return this.lastPicture;

    // Nearest I picture at or before the target.
    let keyIndex = target;
    while (keyIndex > 0 && this.types[keyIndex] !== 'I') keyIndex--;
    // Continue from the current reference when it lies on the path; else restart.
    let start = keyIndex;
    if (this.referenceIndex >= keyIndex && this.referenceIndex < target) start = this.referenceIndex + 1;
    if (start === keyIndex) this.decoder.reset();

    try {
      for (let i = start; i < target; i++) {
        if (this.types[i] === 'D') continue; // never referenced
        this.decoder.decode(this.stream.frames[i]);
        this.referenceIndex = i;
      }
      const pic = this.decoder.decode(this.stream.frames[target]);
      if (pic.header.type !== 'D') this.referenceIndex = target;
      this.lastIndex = target;
      this.lastPicture = pic;
      return pic;
    } catch (e) {
      if (!this.warned) {
        this.warned = true;
        console.warn(`Embedded video frame ${target} failed to decode:`, e);
      }
      // The reference may be half-updated; force a restart next time.
      this.referenceIndex = -1;
      this.lastIndex = target;
      return this.lastPicture;
    }
  }
}
