import { describe, it, expect } from 'vitest';
import {
  parseFLV,
  getVideoCodecName,
  getAudioCodecName,
  getKeyframes,
  findVideoTagAtTime,
  FLV_TAG_VIDEO,
  FLV_TAG_AUDIO,
  VIDEO_CODEC_H263,
  VIDEO_CODEC_VP6,
  VIDEO_CODEC_AVC,
  AUDIO_CODEC_MP3,
  AUDIO_CODEC_AAC,
  FRAME_TYPE_KEYFRAME,
  FRAME_TYPE_INTER
} from '../flv-parser';

// Helper to create a minimal FLV file
function createFLVBuffer(options: {
  hasVideo?: boolean;
  hasAudio?: boolean;
  tags?: Array<{
    type: number;
    timestamp: number;
    data: number[];
  }>;
} = {}): ArrayBuffer {
  const { hasVideo = true, hasAudio = false, tags = [] } = options;

  // Calculate total size
  let totalSize = 9 + 4; // Header + first previous tag size
  for (const tag of tags) {
    totalSize += 11 + tag.data.length + 4; // Tag header + data + previous tag size
  }

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let offset = 0;

  // Write FLV header
  bytes[offset++] = 0x46; // 'F'
  bytes[offset++] = 0x4C; // 'L'
  bytes[offset++] = 0x56; // 'V'
  bytes[offset++] = 0x01; // Version 1

  // Flags
  let flags = 0;
  if (hasAudio) flags |= 0x04;
  if (hasVideo) flags |= 0x01;
  bytes[offset++] = flags;

  // Header size (4 bytes, big-endian)
  view.setUint32(offset, 9, false);
  offset += 4;

  // First previous tag size (always 0)
  view.setUint32(offset, 0, false);
  offset += 4;

  // Write tags
  for (const tag of tags) {
    const tagStart = offset;

    // Tag type
    bytes[offset++] = tag.type;

    // Data size (3 bytes, big-endian)
    bytes[offset++] = (tag.data.length >> 16) & 0xFF;
    bytes[offset++] = (tag.data.length >> 8) & 0xFF;
    bytes[offset++] = tag.data.length & 0xFF;

    // Timestamp (3 bytes + 1 extended)
    bytes[offset++] = (tag.timestamp >> 16) & 0xFF;
    bytes[offset++] = (tag.timestamp >> 8) & 0xFF;
    bytes[offset++] = tag.timestamp & 0xFF;
    bytes[offset++] = (tag.timestamp >> 24) & 0xFF; // Extended

    // Stream ID (3 bytes, always 0)
    bytes[offset++] = 0;
    bytes[offset++] = 0;
    bytes[offset++] = 0;

    // Tag data
    for (const byte of tag.data) {
      bytes[offset++] = byte;
    }

    // Previous tag size
    const tagSize = offset - tagStart;
    view.setUint32(offset, tagSize, false);
    offset += 4;
  }

  return buffer;
}

describe('FLV Parser', () => {
  describe('parseFLV', () => {
    it('should parse FLV header correctly', () => {
      const buffer = createFLVBuffer({ hasVideo: true, hasAudio: true });
      const result = parseFLV(buffer);

      expect(result.header.signature).toBe('FLV');
      expect(result.header.version).toBe(1);
      expect(result.header.hasVideo).toBe(true);
      expect(result.header.hasAudio).toBe(true);
      expect(result.header.headerSize).toBe(9);
    });

    it('should throw error for invalid FLV signature', () => {
      const buffer = new ArrayBuffer(9);
      const bytes = new Uint8Array(buffer);
      bytes[0] = 0x00; // Invalid signature

      expect(() => parseFLV(buffer)).toThrow('Invalid FLV signature');
    });

    it('should parse video tags', () => {
      const buffer = createFLVBuffer({
        hasVideo: true,
        tags: [
          {
            type: FLV_TAG_VIDEO,
            timestamp: 0,
            // Frame type (keyframe) | codec (H.263) = 0x12
            data: [0x12, 0x00, 0x00, 0x00]
          },
          {
            type: FLV_TAG_VIDEO,
            timestamp: 33,
            // Frame type (inter) | codec (H.263) = 0x22
            data: [0x22, 0x00, 0x00, 0x00]
          }
        ]
      });

      const result = parseFLV(buffer);

      expect(result.videoTags).toHaveLength(2);
      expect(result.videoTags[0].frameType).toBe(FRAME_TYPE_KEYFRAME);
      expect(result.videoTags[0].codecId).toBe(VIDEO_CODEC_H263);
      expect(result.videoTags[0].timestamp).toBe(0);

      expect(result.videoTags[1].frameType).toBe(FRAME_TYPE_INTER);
      expect(result.videoTags[1].codecId).toBe(VIDEO_CODEC_H263);
      expect(result.videoTags[1].timestamp).toBe(33);

      expect(result.videoCodec).toBe(VIDEO_CODEC_H263);
    });

    it('should parse audio tags', () => {
      const buffer = createFLVBuffer({
        hasAudio: true,
        hasVideo: false,
        tags: [
          {
            type: FLV_TAG_AUDIO,
            timestamp: 0,
            // Codec (MP3) | rate (44100) | size (16bit) | stereo = 0x2F
            data: [0x2F, 0xFF, 0xFB, 0x90, 0x00] // MP3 frame header
          }
        ]
      });

      const result = parseFLV(buffer);

      expect(result.audioTags).toHaveLength(1);
      expect(result.audioTags[0].codecId).toBe(AUDIO_CODEC_MP3);
      expect(result.audioTags[0].sampleRate).toBe(44100);
      expect(result.audioTags[0].sampleSize).toBe(16);
      expect(result.audioTags[0].stereo).toBe(true);

      expect(result.audioCodec).toBe(AUDIO_CODEC_MP3);
    });

    it('should calculate duration from max timestamp', () => {
      const buffer = createFLVBuffer({
        hasVideo: true,
        tags: [
          { type: FLV_TAG_VIDEO, timestamp: 0, data: [0x12] },
          { type: FLV_TAG_VIDEO, timestamp: 1000, data: [0x22] },
          { type: FLV_TAG_VIDEO, timestamp: 2000, data: [0x22] }
        ]
      });

      const result = parseFLV(buffer);

      expect(result.duration).toBe(2); // 2000ms = 2s
    });

    it('should parse VP6 video codec', () => {
      const buffer = createFLVBuffer({
        hasVideo: true,
        tags: [
          {
            type: FLV_TAG_VIDEO,
            timestamp: 0,
            // Frame type (keyframe) | codec (VP6) = 0x14
            data: [0x14, 0x00, 0x00]
          }
        ]
      });

      const result = parseFLV(buffer);

      expect(result.videoTags[0].codecId).toBe(VIDEO_CODEC_VP6);
      expect(result.videoCodec).toBe(VIDEO_CODEC_VP6);
    });

    it('should handle AVC video with composition time', () => {
      const buffer = createFLVBuffer({
        hasVideo: true,
        tags: [
          {
            type: FLV_TAG_VIDEO,
            timestamp: 0,
            // Frame type (keyframe) | codec (AVC) = 0x17
            // AVC packet type = 0x01 (NALU)
            // Composition time = 0x000064 (100)
            data: [0x17, 0x01, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00]
          }
        ]
      });

      const result = parseFLV(buffer);

      expect(result.videoTags[0].codecId).toBe(VIDEO_CODEC_AVC);
      expect(result.videoTags[0].avcPacketType).toBe(0x01);
      expect(result.videoTags[0].compositionTime).toBe(100);
    });

    it('should handle empty FLV with no tags', () => {
      const buffer = createFLVBuffer({ hasVideo: true, hasAudio: false, tags: [] });
      const result = parseFLV(buffer);

      expect(result.videoTags).toHaveLength(0);
      expect(result.audioTags).toHaveLength(0);
      expect(result.duration).toBe(0);
    });
  });

  describe('getVideoCodecName', () => {
    it('should return correct codec names', () => {
      expect(getVideoCodecName(VIDEO_CODEC_H263)).toBe('Sorenson H.263');
      expect(getVideoCodecName(VIDEO_CODEC_VP6)).toBe('On2 VP6');
      expect(getVideoCodecName(VIDEO_CODEC_AVC)).toBe('H.264/AVC');
      expect(getVideoCodecName(99)).toBe('Unknown (99)');
    });
  });

  describe('getAudioCodecName', () => {
    it('should return correct codec names', () => {
      expect(getAudioCodecName(AUDIO_CODEC_MP3)).toBe('MP3');
      expect(getAudioCodecName(AUDIO_CODEC_AAC)).toBe('AAC');
      expect(getAudioCodecName(99)).toBe('Unknown (99)');
    });
  });

  describe('getKeyframes', () => {
    it('should extract keyframes from video tags', () => {
      const buffer = createFLVBuffer({
        hasVideo: true,
        tags: [
          { type: FLV_TAG_VIDEO, timestamp: 0, data: [0x12] },    // keyframe
          { type: FLV_TAG_VIDEO, timestamp: 33, data: [0x22] },   // inter
          { type: FLV_TAG_VIDEO, timestamp: 66, data: [0x22] },   // inter
          { type: FLV_TAG_VIDEO, timestamp: 1000, data: [0x12] }, // keyframe
          { type: FLV_TAG_VIDEO, timestamp: 1033, data: [0x22] }  // inter
        ]
      });

      const result = parseFLV(buffer);
      const keyframes = getKeyframes(result.videoTags);

      expect(keyframes).toHaveLength(2);
      expect(keyframes[0].timestamp).toBe(0);
      expect(keyframes[0].index).toBe(0);
      expect(keyframes[1].timestamp).toBe(1000);
      expect(keyframes[1].index).toBe(3);
    });

    it('should return empty array for no keyframes', () => {
      const buffer = createFLVBuffer({
        hasVideo: true,
        tags: [
          { type: FLV_TAG_VIDEO, timestamp: 0, data: [0x22] }, // inter frame only
        ]
      });

      const result = parseFLV(buffer);
      const keyframes = getKeyframes(result.videoTags);

      expect(keyframes).toHaveLength(0);
    });
  });

  describe('findVideoTagAtTime', () => {
    it('should find video tag at exact timestamp', () => {
      const buffer = createFLVBuffer({
        hasVideo: true,
        tags: [
          { type: FLV_TAG_VIDEO, timestamp: 0, data: [0x12] },
          { type: FLV_TAG_VIDEO, timestamp: 100, data: [0x22] },
          { type: FLV_TAG_VIDEO, timestamp: 200, data: [0x22] }
        ]
      });

      const result = parseFLV(buffer);
      const tag = findVideoTagAtTime(result.videoTags, 100);

      expect(tag).not.toBeNull();
      expect(tag!.timestamp).toBe(100);
    });

    it('should find video tag before timestamp', () => {
      const buffer = createFLVBuffer({
        hasVideo: true,
        tags: [
          { type: FLV_TAG_VIDEO, timestamp: 0, data: [0x12] },
          { type: FLV_TAG_VIDEO, timestamp: 100, data: [0x22] },
          { type: FLV_TAG_VIDEO, timestamp: 200, data: [0x22] }
        ]
      });

      const result = parseFLV(buffer);
      const tag = findVideoTagAtTime(result.videoTags, 150);

      expect(tag).not.toBeNull();
      expect(tag!.timestamp).toBe(100);
    });

    it('should return null for empty array', () => {
      const tag = findVideoTagAtTime([], 100);
      expect(tag).toBeNull();
    });

    it('should return last tag if timestamp exceeds all', () => {
      const buffer = createFLVBuffer({
        hasVideo: true,
        tags: [
          { type: FLV_TAG_VIDEO, timestamp: 0, data: [0x12] },
          { type: FLV_TAG_VIDEO, timestamp: 100, data: [0x22] }
        ]
      });

      const result = parseFLV(buffer);
      const tag = findVideoTagAtTime(result.videoTags, 500);

      expect(tag).not.toBeNull();
      expect(tag!.timestamp).toBe(100);
    });
  });
});

describe('FLV Parser Integration', () => {
  it('should parse FLV with mixed video and audio tags', () => {
    const buffer = createFLVBuffer({
      hasVideo: true,
      hasAudio: true,
      tags: [
        { type: FLV_TAG_VIDEO, timestamp: 0, data: [0x12, 0x00] },   // keyframe H.263
        { type: FLV_TAG_AUDIO, timestamp: 0, data: [0x2F, 0xFF] },   // MP3 stereo 44100
        { type: FLV_TAG_VIDEO, timestamp: 33, data: [0x22, 0x00] },  // inter H.263
        { type: FLV_TAG_AUDIO, timestamp: 26, data: [0x2F, 0xFF] },  // MP3
        { type: FLV_TAG_VIDEO, timestamp: 66, data: [0x22, 0x00] },  // inter H.263
      ]
    });

    const result = parseFLV(buffer);

    expect(result.header.hasVideo).toBe(true);
    expect(result.header.hasAudio).toBe(true);
    expect(result.videoTags).toHaveLength(3);
    expect(result.audioTags).toHaveLength(2);
    expect(result.videoCodec).toBe(VIDEO_CODEC_H263);
    expect(result.audioCodec).toBe(AUDIO_CODEC_MP3);
  });
});
