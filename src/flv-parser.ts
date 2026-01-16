/**
 * FLV (Flash Video) Parser
 *
 * Parses the FLV container format to extract video frames, audio data, and metadata.
 * FLV is a container format - the actual video/audio codecs (H.263, VP6, MP3, etc.)
 * require separate decoders.
 *
 * FLV Format Structure:
 * - Header (9 bytes): signature "FLV", version, flags, header size
 * - Tags (repeated): previous tag size, tag type, data size, timestamp, stream ID, data
 *
 * Tag Types:
 * - 8: Audio tag
 * - 9: Video tag
 * - 18: Script data (metadata)
 */

// FLV tag types
export const FLV_TAG_AUDIO = 8;
export const FLV_TAG_VIDEO = 9;
export const FLV_TAG_SCRIPT = 18;

// Video codec IDs (lower 4 bits of first byte of video tag data)
export const VIDEO_CODEC_H263 = 2;      // Sorenson H.263
export const VIDEO_CODEC_SCREEN = 3;    // Screen video
export const VIDEO_CODEC_VP6 = 4;       // On2 VP6
export const VIDEO_CODEC_VP6_ALPHA = 5; // On2 VP6 with alpha
export const VIDEO_CODEC_SCREEN_V2 = 6; // Screen video v2
export const VIDEO_CODEC_AVC = 7;       // H.264/AVC

// Video frame types (upper 4 bits of first byte of video tag data)
export const FRAME_TYPE_KEYFRAME = 1;
export const FRAME_TYPE_INTER = 2;
export const FRAME_TYPE_DISPOSABLE = 3;
export const FRAME_TYPE_GENERATED = 4;
export const FRAME_TYPE_INFO = 5;

// Audio codec IDs (upper 4 bits of first byte of audio tag data)
export const AUDIO_CODEC_PCM_PLATFORM = 0;  // Linear PCM, platform endian
export const AUDIO_CODEC_ADPCM = 1;         // ADPCM
export const AUDIO_CODEC_MP3 = 2;           // MP3
export const AUDIO_CODEC_PCM_LE = 3;        // Linear PCM, little endian
export const AUDIO_CODEC_NELLYMOSER_16K = 4; // Nellymoser 16kHz
export const AUDIO_CODEC_NELLYMOSER_8K = 5;  // Nellymoser 8kHz
export const AUDIO_CODEC_NELLYMOSER = 6;     // Nellymoser
export const AUDIO_CODEC_ALAW = 7;           // G.711 A-law
export const AUDIO_CODEC_MULAW = 8;          // G.711 mu-law
export const AUDIO_CODEC_AAC = 10;           // AAC
export const AUDIO_CODEC_SPEEX = 11;         // Speex

// Audio sample rates (bits 2-3 of first byte)
export const AUDIO_RATE_5500 = 0;
export const AUDIO_RATE_11025 = 1;
export const AUDIO_RATE_22050 = 2;
export const AUDIO_RATE_44100 = 3;

export interface FLVHeader {
  signature: string;
  version: number;
  hasAudio: boolean;
  hasVideo: boolean;
  headerSize: number;
}

export interface FLVTag {
  type: number;
  dataSize: number;
  timestamp: number; // in milliseconds
  streamId: number;
  data: Uint8Array;
}

export interface FLVVideoTag extends FLVTag {
  type: typeof FLV_TAG_VIDEO;
  frameType: number;
  codecId: number;
  compositionTime?: number; // For AVC only
  avcPacketType?: number;   // For AVC only
  videoData: Uint8Array;    // Raw codec data (without FLV header byte)
}

export interface FLVAudioTag extends FLVTag {
  type: typeof FLV_TAG_AUDIO;
  codecId: number;
  sampleRate: number;     // Actual sample rate in Hz
  sampleSize: number;     // 8 or 16 bits
  stereo: boolean;
  aacPacketType?: number; // For AAC only
  audioData: Uint8Array;  // Raw codec data (without FLV header byte)
}

export interface FLVScriptTag extends FLVTag {
  type: typeof FLV_TAG_SCRIPT;
  metadata: FLVMetadata;
}

export interface FLVMetadata {
  duration?: number;
  width?: number;
  height?: number;
  videocodecid?: number;
  audiocodecid?: number;
  framerate?: number;
  videodatarate?: number;
  audiodatarate?: number;
  audiosamplerate?: number;
  audiosamplesize?: number;
  stereo?: boolean;
  filesize?: number;
  [key: string]: unknown;
}

export interface ParsedFLV {
  header: FLVHeader;
  metadata: FLVMetadata;
  videoTags: FLVVideoTag[];
  audioTags: FLVAudioTag[];
  duration: number;        // Total duration in seconds
  videoCodec: number | null;
  audioCodec: number | null;
}

/**
 * Parse an FLV file from binary data
 */
export function parseFLV(data: ArrayBuffer): ParsedFLV {
  const view = new DataView(data);
  const bytes = new Uint8Array(data);
  let offset = 0;

  // Parse header
  const header = parseFLVHeader(view, offset);
  offset = header.headerSize;

  // Skip first previous tag size (always 0)
  offset += 4;

  const videoTags: FLVVideoTag[] = [];
  const audioTags: FLVAudioTag[] = [];
  let metadata: FLVMetadata = {};
  let videoCodec: number | null = null;
  let audioCodec: number | null = null;
  let maxTimestamp = 0;

  // Parse tags
  while (offset < data.byteLength - 11) { // Need at least 11 bytes for tag header
    const tag = parseFLVTag(view, bytes, offset);
    if (!tag) break;

    // Track max timestamp for duration calculation
    if (tag.timestamp > maxTimestamp) {
      maxTimestamp = tag.timestamp;
    }

    if (tag.type === FLV_TAG_VIDEO) {
      const videoTag = parseVideoTag(tag);
      videoTags.push(videoTag);
      if (videoCodec === null) {
        videoCodec = videoTag.codecId;
      }
    } else if (tag.type === FLV_TAG_AUDIO) {
      const audioTag = parseAudioTag(tag);
      audioTags.push(audioTag);
      if (audioCodec === null) {
        audioCodec = audioTag.codecId;
      }
    } else if (tag.type === FLV_TAG_SCRIPT) {
      metadata = parseScriptTag(tag.data);
    }

    // Move to next tag (tag header + data + previous tag size)
    offset += 11 + tag.dataSize + 4;
  }

  // Calculate duration from metadata or max timestamp
  const duration = metadata.duration ?? (maxTimestamp / 1000);

  return {
    header,
    metadata,
    videoTags,
    audioTags,
    duration,
    videoCodec,
    audioCodec
  };
}

/**
 * Parse FLV header (9 bytes)
 */
function parseFLVHeader(view: DataView, offset: number): FLVHeader {
  // Signature: "FLV" (3 bytes)
  const signature = String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2)
  );

  if (signature !== 'FLV') {
    throw new Error(`Invalid FLV signature: ${signature}`);
  }

  // Version (1 byte)
  const version = view.getUint8(offset + 3);

  // Flags (1 byte): bit 0 = has video, bit 2 = has audio
  const flags = view.getUint8(offset + 4);
  const hasAudio = (flags & 0x04) !== 0;
  const hasVideo = (flags & 0x01) !== 0;

  // Header size (4 bytes, big-endian)
  const headerSize = view.getUint32(offset + 5, false);

  return { signature, version, hasAudio, hasVideo, headerSize };
}

/**
 * Parse a single FLV tag
 */
function parseFLVTag(view: DataView, bytes: Uint8Array, offset: number): FLVTag | null {
  if (offset + 11 > view.byteLength) return null;

  // Tag type (1 byte)
  const type = view.getUint8(offset);

  // Data size (3 bytes, big-endian)
  const dataSize = (view.getUint8(offset + 1) << 16) |
                   (view.getUint8(offset + 2) << 8) |
                   view.getUint8(offset + 3);

  // Timestamp (3 bytes) + timestamp extended (1 byte)
  const timestamp = (view.getUint8(offset + 4) << 16) |
                    (view.getUint8(offset + 5) << 8) |
                    view.getUint8(offset + 6) |
                    (view.getUint8(offset + 7) << 24); // Extended timestamp (upper 8 bits)

  // Stream ID (3 bytes, always 0)
  const streamId = (view.getUint8(offset + 8) << 16) |
                   (view.getUint8(offset + 9) << 8) |
                   view.getUint8(offset + 10);

  // Tag data
  const dataStart = offset + 11;
  if (dataStart + dataSize > bytes.length) return null;

  const data = bytes.slice(dataStart, dataStart + dataSize);

  return { type, dataSize, timestamp, streamId, data };
}

/**
 * Parse video tag data
 */
function parseVideoTag(tag: FLVTag): FLVVideoTag {
  const firstByte = tag.data[0];
  const frameType = (firstByte >> 4) & 0x0F;
  const codecId = firstByte & 0x0F;

  let videoData: Uint8Array;
  let compositionTime: number | undefined;
  let avcPacketType: number | undefined;

  if (codecId === VIDEO_CODEC_AVC) {
    // AVC/H.264 has additional header
    avcPacketType = tag.data[1];
    // Composition time offset (3 bytes, signed big-endian)
    compositionTime = ((tag.data[2] << 16) | (tag.data[3] << 8) | tag.data[4]);
    // Sign extend if negative
    if (compositionTime & 0x800000) {
      compositionTime |= 0xFF000000;
    }
    videoData = tag.data.slice(5);
  } else {
    videoData = tag.data.slice(1);
  }

  return {
    ...tag,
    type: FLV_TAG_VIDEO,
    frameType,
    codecId,
    compositionTime,
    avcPacketType,
    videoData
  };
}

/**
 * Parse audio tag data
 */
function parseAudioTag(tag: FLVTag): FLVAudioTag {
  const firstByte = tag.data[0];
  const codecId = (firstByte >> 4) & 0x0F;
  const sampleRateIndex = (firstByte >> 2) & 0x03;
  const sampleSizeBit = (firstByte >> 1) & 0x01;
  const stereoBit = firstByte & 0x01;

  // Map sample rate index to actual Hz
  const sampleRates = [5500, 11025, 22050, 44100];
  const sampleRate = sampleRates[sampleRateIndex];
  const sampleSize = sampleSizeBit === 0 ? 8 : 16;
  const stereo = stereoBit === 1;

  let audioData: Uint8Array;
  let aacPacketType: number | undefined;

  if (codecId === AUDIO_CODEC_AAC) {
    aacPacketType = tag.data[1];
    audioData = tag.data.slice(2);
  } else {
    audioData = tag.data.slice(1);
  }

  return {
    ...tag,
    type: FLV_TAG_AUDIO,
    codecId,
    sampleRate,
    sampleSize,
    stereo,
    aacPacketType,
    audioData
  };
}

/**
 * Parse script tag data (AMF-encoded metadata)
 * Simplified parser for common onMetaData object
 */
function parseScriptTag(data: Uint8Array): FLVMetadata {
  const metadata: FLVMetadata = {};

  try {
    let offset = 0;

    // First value should be string "onMetaData"
    if (data[offset] !== 0x02) return metadata; // Not a string
    offset++;

    // String length (2 bytes, big-endian)
    const nameLength = (data[offset] << 8) | data[offset + 1];
    offset += 2;

    // Skip the name
    offset += nameLength;

    // Second value should be ECMA array or object
    const type = data[offset];
    offset++;

    if (type === 0x08) {
      // ECMA array - has 4-byte count prefix
      offset += 4; // Skip array length

      // Parse key-value pairs until end marker
      while (offset < data.length - 3) {
        // Key length (2 bytes)
        const keyLength = (data[offset] << 8) | data[offset + 1];
        offset += 2;

        if (keyLength === 0) {
          // Check for end marker (0x00 0x00 0x09)
          if (data[offset] === 0x09) break;
          continue;
        }

        // Key string
        const key = String.fromCharCode(...data.slice(offset, offset + keyLength));
        offset += keyLength;

        // Value type
        const valueType = data[offset];
        offset++;

        // Parse value based on type
        const value = parseAMFValue(data, offset, valueType);
        if (value !== null) {
          metadata[key] = value.value;
          offset = value.newOffset;
        } else {
          break; // Unknown type, stop parsing
        }
      }
    }
  } catch {
    // Return partial metadata on parse error
  }

  return metadata;
}

/**
 * Parse a single AMF0 value
 */
function parseAMFValue(data: Uint8Array, offset: number, type: number): { value: unknown; newOffset: number } | null {
  switch (type) {
    case 0x00: { // Number (8-byte IEEE 754)
      const view = new DataView(data.buffer, data.byteOffset + offset, 8);
      return { value: view.getFloat64(0, false), newOffset: offset + 8 };
    }
    case 0x01: { // Boolean
      return { value: data[offset] !== 0, newOffset: offset + 1 };
    }
    case 0x02: { // String
      const length = (data[offset] << 8) | data[offset + 1];
      const str = String.fromCharCode(...data.slice(offset + 2, offset + 2 + length));
      return { value: str, newOffset: offset + 2 + length };
    }
    case 0x05: { // Null
      return { value: null, newOffset: offset };
    }
    case 0x06: { // Undefined
      return { value: undefined, newOffset: offset };
    }
    default:
      return null; // Unknown type
  }
}

/**
 * Get codec name from codec ID
 */
export function getVideoCodecName(codecId: number): string {
  switch (codecId) {
    case VIDEO_CODEC_H263: return 'Sorenson H.263';
    case VIDEO_CODEC_SCREEN: return 'Screen Video';
    case VIDEO_CODEC_VP6: return 'On2 VP6';
    case VIDEO_CODEC_VP6_ALPHA: return 'On2 VP6 with Alpha';
    case VIDEO_CODEC_SCREEN_V2: return 'Screen Video v2';
    case VIDEO_CODEC_AVC: return 'H.264/AVC';
    default: return `Unknown (${codecId})`;
  }
}

/**
 * Get audio codec name from codec ID
 */
export function getAudioCodecName(codecId: number): string {
  switch (codecId) {
    case AUDIO_CODEC_PCM_PLATFORM: return 'PCM (Platform Endian)';
    case AUDIO_CODEC_ADPCM: return 'ADPCM';
    case AUDIO_CODEC_MP3: return 'MP3';
    case AUDIO_CODEC_PCM_LE: return 'PCM (Little Endian)';
    case AUDIO_CODEC_NELLYMOSER_16K: return 'Nellymoser 16kHz';
    case AUDIO_CODEC_NELLYMOSER_8K: return 'Nellymoser 8kHz';
    case AUDIO_CODEC_NELLYMOSER: return 'Nellymoser';
    case AUDIO_CODEC_ALAW: return 'G.711 A-law';
    case AUDIO_CODEC_MULAW: return 'G.711 mu-law';
    case AUDIO_CODEC_AAC: return 'AAC';
    case AUDIO_CODEC_SPEEX: return 'Speex';
    default: return `Unknown (${codecId})`;
  }
}

/**
 * Get keyframes from video tags (for seeking)
 */
export function getKeyframes(videoTags: FLVVideoTag[]): { timestamp: number; index: number }[] {
  return videoTags
    .map((tag, index) => ({ tag, index }))
    .filter(({ tag }) => tag.frameType === FRAME_TYPE_KEYFRAME)
    .map(({ tag, index }) => ({ timestamp: tag.timestamp, index }));
}

/**
 * Find the video tag at or before a given timestamp
 */
export function findVideoTagAtTime(videoTags: FLVVideoTag[], timeMs: number): FLVVideoTag | null {
  if (videoTags.length === 0) return null;

  // Binary search for the tag at or before the timestamp
  let left = 0;
  let right = videoTags.length - 1;
  let result: FLVVideoTag | null = null;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const tag = videoTags[mid];

    if (tag.timestamp <= timeMs) {
      result = tag;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return result;
}
