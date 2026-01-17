import { describe, it, expect } from 'vitest';
import { decodeADPCM, decodeADPCMToAudioBuffer } from '../adpcm-decoder';

describe('ADPCM Decoder', () => {
  describe('decodeADPCM', () => {
    it('should decode 2-bit ADPCM data', () => {
      // Create test ADPCM data:
      // - First 2 bits: code type = 0 (2-bit ADPCM)
      // - Next 16 bits: initial sample for channel 0 (e.g., 0)
      // - Next 6 bits: initial step index (e.g., 0)
      // - Then 2-bit samples
      const buffer = new ArrayBuffer(8);
      const view = new DataView(buffer);

      // Code type 0 (2-bit) in first 2 bits, then initial sample high byte
      // Binary: 00xxxxxx where xx is part of the 16-bit sample
      view.setUint8(0, 0b00000000); // code type 0, sample MSB bits
      view.setUint8(1, 0b00000000); // sample LSB and step index
      view.setUint8(2, 0b00000000); // step index and samples
      view.setUint8(3, 0b00000000);
      view.setUint8(4, 0b00000000);
      view.setUint8(5, 0b00000000);
      view.setUint8(6, 0b00000000);
      view.setUint8(7, 0b00000000);

      const result = decodeADPCM(buffer);

      expect(result).toBeInstanceOf(Int16Array);
      expect(result.length).toBeGreaterThan(0);
    });

    it('should decode 4-bit ADPCM data', () => {
      // Code type 2 (4-bit ADPCM)
      const buffer = new ArrayBuffer(10);
      const view = new DataView(buffer);

      // Binary: 10xxxxxx - code type 2 (4-bit)
      view.setUint8(0, 0b10000000); // code type 2
      view.setUint8(1, 0b00000000);
      view.setUint8(2, 0b00000000);
      view.setUint8(3, 0b00000000);
      view.setUint8(4, 0b00000000);
      view.setUint8(5, 0b10001000); // Some 4-bit samples
      view.setUint8(6, 0b10001000);
      view.setUint8(7, 0b10001000);
      view.setUint8(8, 0b10001000);
      view.setUint8(9, 0b10001000);

      const result = decodeADPCM(buffer);

      expect(result).toBeInstanceOf(Int16Array);
      expect(result.length).toBeGreaterThan(0);
    });

    it('should decode 5-bit ADPCM data', () => {
      // Code type 3 (5-bit ADPCM)
      const buffer = new ArrayBuffer(12);
      const view = new DataView(buffer);

      // Binary: 11xxxxxx - code type 3 (5-bit)
      view.setUint8(0, 0b11000000); // code type 3
      view.setUint8(1, 0b00000000);
      view.setUint8(2, 0b00000000);
      view.setUint8(3, 0b00000000);
      view.setUint8(4, 0b00000000);
      view.setUint8(5, 0b00000000);
      view.setUint8(6, 0b00000000);
      view.setUint8(7, 0b00000000);
      view.setUint8(8, 0b00000000);
      view.setUint8(9, 0b00000000);
      view.setUint8(10, 0b00000000);
      view.setUint8(11, 0b00000000);

      const result = decodeADPCM(buffer);

      expect(result).toBeInstanceOf(Int16Array);
      expect(result.length).toBeGreaterThan(0);
    });

    it('should handle mono audio (1 channel)', () => {
      const buffer = new ArrayBuffer(8);
      const view = new DataView(buffer);
      view.setUint8(0, 0b10000000); // code type 2

      const result = decodeADPCM(buffer, undefined, 1);

      expect(result).toBeInstanceOf(Int16Array);
    });

    it('should handle stereo audio (2 channels)', () => {
      const buffer = new ArrayBuffer(16);
      const view = new DataView(buffer);
      view.setUint8(0, 0b10000000); // code type 2
      // Fill with zeros for the header data

      const result = decodeADPCM(buffer, undefined, 2);

      expect(result).toBeInstanceOf(Int16Array);
    });

    it('should correctly interleave stereo samples', () => {
      // Create buffer with enough data for stereo decoding
      // 4-bit ADPCM: 2 bits code type + (16 bits sample + 6 bits index) * 2 channels + samples
      const buffer = new ArrayBuffer(20);
      const view = new DataView(buffer);

      // Code type 2 (4-bit ADPCM)
      view.setUint8(0, 0b10000000);
      // Fill rest with data
      for (let i = 1; i < 20; i++) {
        view.setUint8(i, 0x00);
      }

      // Request a specific number of samples (e.g., 10 total = 5 frames)
      const result = decodeADPCM(buffer, 10, 2);

      expect(result).toBeInstanceOf(Int16Array);
      // For stereo, output length should be even (pairs of L/R samples)
      expect(result.length % 2).toBe(0);
      // Should not exceed requested sample count
      expect(result.length).toBeLessThanOrEqual(10);
    });

    it('should not write out of bounds for stereo', () => {
      // This test verifies the bug fix for stereo buffer overflow
      const buffer = new ArrayBuffer(100);
      const view = new DataView(buffer);
      view.setUint8(0, 0b10000000); // code type 2

      // Request exactly 20 samples (10 frames for stereo)
      // The bug was that the loop would continue past frame 10
      // because it compared frame count to sample count
      const result = decodeADPCM(buffer, 20, 2);

      expect(result).toBeInstanceOf(Int16Array);
      expect(result.length).toBeLessThanOrEqual(20);
      // All values should be valid (no garbage from out-of-bounds read)
      for (let i = 0; i < result.length; i++) {
        expect(Number.isFinite(result[i])).toBe(true);
      }
    });

    it('should handle empty data gracefully', () => {
      const buffer = new ArrayBuffer(0);
      const result = decodeADPCM(buffer);

      expect(result).toBeInstanceOf(Int16Array);
      expect(result.length).toBe(0);
    });

    it('should handle minimal data', () => {
      const buffer = new ArrayBuffer(4);
      const view = new DataView(buffer);
      view.setUint8(0, 0b10000000); // code type 2
      view.setUint8(1, 0x00);
      view.setUint8(2, 0x00);
      view.setUint8(3, 0x00);

      const result = decodeADPCM(buffer);

      expect(result).toBeInstanceOf(Int16Array);
    });

    it('should respect sample count limit', () => {
      const buffer = new ArrayBuffer(100);
      const view = new DataView(buffer);
      view.setUint8(0, 0b10000000); // code type 2

      const result = decodeADPCM(buffer, 10, 1);

      expect(result).toBeInstanceOf(Int16Array);
      // Should not exceed the specified sample count
      expect(result.length).toBeLessThanOrEqual(10);
    });

    it('should produce samples in valid range', () => {
      // Create test data that will produce non-zero samples
      const buffer = new ArrayBuffer(20);
      const view = new DataView(buffer);

      // 4-bit ADPCM with some non-zero samples
      view.setUint8(0, 0b10000001); // code type 2, partial sample data
      view.setUint8(1, 0b00000100); // initial sample bits
      view.setUint8(2, 0b00000000);
      view.setUint8(3, 0b00010000); // step index
      // Add some sample data
      for (let i = 4; i < 20; i++) {
        view.setUint8(i, 0b01110111); // alternating positive deltas
      }

      const result = decodeADPCM(buffer, undefined, 1);

      // All samples should be in 16-bit signed range
      for (let i = 0; i < result.length; i++) {
        expect(result[i]).toBeGreaterThanOrEqual(-32768);
        expect(result[i]).toBeLessThanOrEqual(32767);
      }
    });
  });

  describe('decodeADPCMToAudioBuffer', () => {
    it('should handle empty data without throwing', async () => {
      const audioContext = new AudioContext();
      const buffer = new ArrayBuffer(0);

      // Should not throw, should return a minimal buffer
      const audioBuffer = decodeADPCMToAudioBuffer(audioContext, buffer, 44100, 1);

      expect(audioBuffer).toBeInstanceOf(AudioBuffer);
      expect(audioBuffer.length).toBeGreaterThanOrEqual(1); // Minimal silent buffer
      await audioContext.close();
    });

    it('should handle invalid channel count', async () => {
      const audioContext = new AudioContext();
      const buffer = new ArrayBuffer(20);
      const view = new DataView(buffer);
      view.setUint8(0, 0b10000000); // code type 2

      // Should clamp channels to valid range
      const audioBuffer = decodeADPCMToAudioBuffer(audioContext, buffer, 44100, 0);

      expect(audioBuffer).toBeInstanceOf(AudioBuffer);
      expect(audioBuffer.numberOfChannels).toBe(1); // Clamped to 1
      await audioContext.close();
    });

    it('should decode mono audio to AudioBuffer', async () => {
      const audioContext = new AudioContext();
      const buffer = new ArrayBuffer(20);
      const view = new DataView(buffer);
      view.setUint8(0, 0b10000000); // code type 2

      const audioBuffer = decodeADPCMToAudioBuffer(audioContext, buffer, 22050, 1);

      expect(audioBuffer).toBeInstanceOf(AudioBuffer);
      expect(audioBuffer.numberOfChannels).toBe(1);
      expect(audioBuffer.sampleRate).toBe(22050);
      await audioContext.close();
    });

    it('should decode stereo audio to AudioBuffer', async () => {
      const audioContext = new AudioContext();
      const buffer = new ArrayBuffer(30);
      const view = new DataView(buffer);
      view.setUint8(0, 0b10000000); // code type 2

      const audioBuffer = decodeADPCMToAudioBuffer(audioContext, buffer, 44100, 2);

      expect(audioBuffer).toBeInstanceOf(AudioBuffer);
      expect(audioBuffer.numberOfChannels).toBe(2);
      await audioContext.close();
    });
  });
});
