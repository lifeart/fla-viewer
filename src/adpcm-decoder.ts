/**
 * SWF ADPCM Decoder
 *
 * Decodes ADPCM (Adaptive Differential Pulse Code Modulation) audio data
 * according to the SWF File Format Specification.
 *
 * SWF uses a variant of IMA ADPCM with variable bits per sample (2-5 bits).
 *
 * References:
 * - SWF File Format Specification Version 10
 * - IMA ADPCM: https://wiki.multimedia.cx/index.php/IMA_ADPCM
 */

// IMA ADPCM step size table (89 entries)
const STEP_TABLE: number[] = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
  19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
  337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
  876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
  2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
  5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
  15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767
];

// Index adjustment tables for different bits per sample
// For 2-bit ADPCM
const INDEX_TABLE_2BIT: number[] = [-1, 2, -1, 2];

// For 3-bit ADPCM
const INDEX_TABLE_3BIT: number[] = [-1, -1, 2, 4, -1, -1, 2, 4];

// For 4-bit ADPCM (standard IMA)
const INDEX_TABLE_4BIT: number[] = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

// For 5-bit ADPCM
const INDEX_TABLE_5BIT: number[] = [
  -1, -1, -1, -1, -1, -1, -1, -1, 1, 2, 4, 6, 8, 10, 13, 16,
  -1, -1, -1, -1, -1, -1, -1, -1, 1, 2, 4, 6, 8, 10, 13, 16
];

/**
 * Get the index table for the given bits per sample
 */
function getIndexTable(bitsPerSample: number): number[] {
  switch (bitsPerSample) {
    case 2: return INDEX_TABLE_2BIT;
    case 3: return INDEX_TABLE_3BIT;
    case 4: return INDEX_TABLE_4BIT;
    case 5: return INDEX_TABLE_5BIT;
    default: return INDEX_TABLE_4BIT;
  }
}

/**
 * Clamp a value between min and max
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Bit reader for reading variable-length bit fields from a byte stream
 */
class BitReader {
  private data: DataView;
  private bytePos: number = 0;
  private bitPos: number = 0;

  constructor(data: ArrayBuffer, startOffset: number = 0) {
    this.data = new DataView(data);
    this.bytePos = startOffset;
  }

  /**
   * Read n bits from the stream (up to 32 bits)
   */
  readBits(n: number): number {
    let result = 0;
    let bitsRemaining = n;

    while (bitsRemaining > 0) {
      if (this.bytePos >= this.data.byteLength) {
        return result; // End of data
      }

      const currentByte = this.data.getUint8(this.bytePos);
      const bitsAvailable = 8 - this.bitPos;
      const bitsToRead = Math.min(bitsRemaining, bitsAvailable);

      // Extract bits from current byte (reading from MSB to LSB within each byte)
      const shift = bitsAvailable - bitsToRead;
      const mask = ((1 << bitsToRead) - 1) << shift;
      const bits = (currentByte & mask) >> shift;

      result = (result << bitsToRead) | bits;
      bitsRemaining -= bitsToRead;
      this.bitPos += bitsToRead;

      if (this.bitPos >= 8) {
        this.bitPos = 0;
        this.bytePos++;
      }
    }

    return result;
  }

  /**
   * Read a signed value with sign extension
   */
  readSignedBits(n: number): number {
    const value = this.readBits(n);
    // Sign extend if the high bit is set
    const signBit = 1 << (n - 1);
    if (value & signBit) {
      return value - (1 << n);
    }
    return value;
  }

  /**
   * Check if we have more data
   */
  hasMore(): boolean {
    return this.bytePos < this.data.byteLength;
  }
}

// Reusable result object to avoid allocation in hot loop
const sampleResult = { sample: 0, stepIndex: 0 };

/**
 * Decode a single ADPCM sample
 * Note: Returns a shared object - copy values before next call
 */
function decodeADPCMSample(
  code: number,
  bitsPerSample: number,
  predictor: number,
  stepIndex: number,
  indexTable: number[]
): { sample: number; stepIndex: number } {
  const step = STEP_TABLE[stepIndex];

  // Determine sign bit position (highest bit of the code)
  const signMask = 1 << (bitsPerSample - 1);
  const magnitudeMask = signMask - 1;

  const sign = code & signMask;
  const magnitude = code & magnitudeMask;

  // Calculate difference using the formula:
  // diff = (code + 0.5) * step / 2^(bitsPerSample-2)
  // Which expands to: diff = step * (magnitude * 2 + 1) / 2^(bitsPerSample-1)
  let diff = step >> (bitsPerSample - 1);

  if (magnitude & 1) diff += step >> (bitsPerSample - 2);
  if (bitsPerSample >= 3 && (magnitude & 2)) diff += step >> (bitsPerSample - 3);
  if (bitsPerSample >= 4 && (magnitude & 4)) diff += step >> (bitsPerSample - 4);
  if (bitsPerSample >= 5 && (magnitude & 8)) diff += step >> (bitsPerSample - 5);

  // Apply sign
  if (sign) {
    predictor -= diff;
  } else {
    predictor += diff;
  }

  // Clamp to 16-bit signed range
  predictor = clamp(predictor, -32768, 32767);

  // Update step index
  stepIndex += indexTable[code];
  stepIndex = clamp(stepIndex, 0, 88);

  // Reuse object to avoid allocation
  sampleResult.sample = predictor;
  sampleResult.stepIndex = stepIndex;
  return sampleResult;
}

/**
 * Decode SWF ADPCM audio data
 *
 * @param data - The ADPCM encoded data
 * @param sampleCount - Expected number of output samples (optional, for validation)
 * @param channels - Number of channels (1 = mono, 2 = stereo)
 * @returns Decoded PCM samples as Int16Array (interleaved for stereo)
 */
export function decodeADPCM(
  data: ArrayBuffer,
  sampleCount?: number,
  channels: number = 1
): Int16Array {
  // Validate channels (must be 1 or 2)
  const validChannels = Math.max(1, Math.min(2, channels));

  const reader = new BitReader(data);

  // Read ADPCM code type (2 bits) - indicates bits per sample minus 2
  const adpcmCodeType = reader.readBits(2);
  const bitsPerSample = adpcmCodeType + 2; // 2, 3, 4, or 5 bits

  const indexTable = getIndexTable(bitsPerSample);
  const samplesPerBlock = 4095; // 4096 samples minus the initial sample

  // Estimate output size if not provided (in frames, not total samples)
  let frameCount: number;
  if (sampleCount) {
    frameCount = Math.floor(sampleCount / validChannels);
  } else {
    // Rough estimate: each block has 4096 frames
    // Each block starts with 22 bits header per channel (16-bit sample + 6-bit index)
    // Then samplesPerBlock * bitsPerSample bits per channel
    const bitsPerBlock = validChannels * (22 + samplesPerBlock * bitsPerSample);
    const totalBits = (data.byteLength * 8) - 2; // minus the 2-bit header
    const estimatedBlocks = Math.ceil(totalBits / bitsPerBlock);
    frameCount = estimatedBlocks * 4096;
  }

  const totalSamples = frameCount * validChannels;
  const output = new Int16Array(totalSamples);
  let frameIndex = 0; // Track frames (consistent for mono and stereo)

  // State for each channel
  const predictors: number[] = new Array(validChannels).fill(0);
  const stepIndices: number[] = new Array(validChannels).fill(0);

  // Process blocks
  while (reader.hasMore() && frameIndex < frameCount) {
    // Read initial values for each channel
    for (let ch = 0; ch < validChannels; ch++) {
      // Initial sample (16-bit signed)
      predictors[ch] = reader.readSignedBits(16);
      // Initial step index (6 bits)
      stepIndices[ch] = reader.readBits(6);

      // Output initial sample (interleaved for stereo)
      if (frameIndex < frameCount) {
        output[frameIndex * validChannels + ch] = predictors[ch];
      }
    }
    frameIndex++;

    // Process samples in this block
    sampleLoop:
    for (let i = 0; i < samplesPerBlock && frameIndex < frameCount; i++) {
      for (let ch = 0; ch < validChannels; ch++) {
        if (!reader.hasMore()) break sampleLoop;

        const code = reader.readBits(bitsPerSample);
        const result = decodeADPCMSample(
          code,
          bitsPerSample,
          predictors[ch],
          stepIndices[ch],
          indexTable
        );

        predictors[ch] = result.sample;
        stepIndices[ch] = result.stepIndex;

        output[frameIndex * validChannels + ch] = result.sample;
      }
      frameIndex++;
    }
  }

  // Trim output to actual samples decoded
  if (frameIndex < frameCount) {
    return output.slice(0, frameIndex * validChannels);
  }

  return output;
}

/**
 * Convert ADPCM data to AudioBuffer for Web Audio API
 *
 * @param audioContext - The AudioContext to create the buffer with
 * @param data - The ADPCM encoded data
 * @param sampleRate - Sample rate in Hz (e.g., 44100, 22050, 11025)
 * @param channels - Number of channels (1 = mono, 2 = stereo)
 * @param sampleCount - Expected number of output samples (optional)
 * @returns AudioBuffer ready for playback
 */
export function decodeADPCMToAudioBuffer(
  audioContext: AudioContext,
  data: ArrayBuffer,
  sampleRate: number,
  channels: number = 1,
  sampleCount?: number
): AudioBuffer {
  // Validate inputs
  const validChannels = Math.max(1, Math.min(2, channels));
  const validSampleRate = Math.max(1, sampleRate);

  const pcmSamples = decodeADPCM(data, sampleCount, validChannels);
  const numFrames = Math.floor(pcmSamples.length / validChannels);

  // createBuffer throws if numFrames is 0, so return a minimal silent buffer
  if (numFrames === 0) {
    return audioContext.createBuffer(validChannels, 1, validSampleRate);
  }

  const audioBuffer = audioContext.createBuffer(validChannels, numFrames, validSampleRate);

  // Convert Int16 samples to Float32 and de-interleave for stereo
  for (let ch = 0; ch < validChannels; ch++) {
    const channelData = audioBuffer.getChannelData(ch);
    for (let i = 0; i < numFrames; i++) {
      // Convert from Int16 range (-32768 to 32767) to Float32 range (-1.0 to 1.0)
      channelData[i] = pcmSamples[i * validChannels + ch] / 32768;
    }
  }

  return audioBuffer;
}
