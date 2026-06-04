import type { FLADocument, SoundItem, FrameSound } from './types';
import { isLayerVisibleInFla } from './layer-utils';
import { FLARenderer } from './renderer';

export interface ExportProgress {
  currentFrame: number;
  totalFrames: number;
  stage: 'encoding' | 'encoding-audio' | 'finalizing';
}

export type ProgressCallback = (progress: ExportProgress) => void;
export type CancellationCheck = () => boolean;

/**
 * Check whether an AudioEncoder for the given config can be constructed in the
 * current environment. Some browsers / headless CI environments lack particular
 * audio codecs (e.g. AAC `mp4a.40.2`), in which case constructing an
 * AudioEncoder with that codec throws `NotSupportedError`. We detect this up
 * front so the export can gracefully degrade to a video-only file instead of
 * crashing.
 */
async function isAudioCodecSupported(
  config: AudioEncoderConfig
): Promise<boolean> {
  // AudioEncoder may be entirely absent (older browsers, some test envs).
  if (typeof AudioEncoder === 'undefined') {
    return false;
  }

  // isConfigSupported is the spec'd way to feature-detect a codec without
  // constructing an encoder. Guard for environments where it is missing.
  if (typeof AudioEncoder.isConfigSupported !== 'function') {
    return false;
  }

  const result = await AudioEncoder.isConfigSupported(config);
  return result.supported === true;
}

interface StreamSound {
  sound: FrameSound;
  soundItem: SoundItem;
  startFrame: number;
  duration: number;
}

export async function exportVideo(
  doc: FLADocument,
  onProgress?: ProgressCallback,
  isCancelled?: CancellationCheck
): Promise<Blob> {
  // Lazy load mp4-muxer
  const mp4Muxer = await import('mp4-muxer');
  const { Muxer, ArrayBufferTarget } = mp4Muxer;

  const width = doc.width;
  const height = doc.height;
  const frameRate = doc.frameRate;
  const totalFrames = doc.timelines[0]?.totalFrames || 1;

  // Create offscreen canvas for rendering
  const canvas = new OffscreenCanvas(width, height);

  // Create a minimal mock canvas for OffscreenCanvas compatibility
  const mockCanvas = {
    width,
    height,
    style: { width: '', height: '' },
    getContext: (type: string) => canvas.getContext(type as '2d'),
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
  } as unknown as HTMLCanvasElement;

  const renderer = new FLARenderer(mockCanvas);
  await renderer.setDocument(doc, true); // true = skip resize

  // Calculate frame duration in microseconds
  const frameDurationMicros = Math.round(1_000_000 / frameRate);

  // Find stream sounds for audio export
  const streamSounds = findStreamSounds(doc);
  const hasAudio = streamSounds.length > 0;

  // Prepare audio data if we have sounds
  let audioData: Float32Array | null = null;
  let sampleRate = 44100;

  if (hasAudio) {
    const result = mixAudio(streamSounds, totalFrames, frameRate);
    audioData = result.data;
    sampleRate = result.sampleRate;
  }

  // Determine whether we can actually encode the audio track. The AAC encoder
  // (`mp4a.40.2`) is unavailable in some environments (e.g. headless CI
  // Chromium), where constructing an AudioEncoder would otherwise throw
  // NotSupportedError. If the codec is unsupported we degrade gracefully and
  // export a valid video-only file rather than crashing the whole export.
  const audioEncoderConfig: AudioEncoderConfig = {
    codec: 'mp4a.40.2', // AAC-LC
    numberOfChannels: 2,
    sampleRate,
    bitrate: 128_000, // 128 kbps
  };
  const encodeAudio =
    hasAudio && audioData !== null && (await isAudioCodecSupported(audioEncoderConfig));

  if (hasAudio && !encodeAudio) {
    console.warn(
      'exportVideo: audio codec "mp4a.40.2" (AAC) is not supported in this ' +
        'environment; exporting video-only without an audio track.'
    );
  }

  // Create MP4 muxer target
  const target = new ArrayBufferTarget();

  // Create MP4 muxer with optional audio
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const muxerOptions: any = {
    target,
    video: {
      codec: 'avc',
      width,
      height,
    },
    fastStart: 'in-memory',
  };

  if (encodeAudio) {
    muxerOptions.audio = {
      codec: 'aac',
      numberOfChannels: 2,
      sampleRate,
    };
  }

  const muxer = new Muxer(muxerOptions);

  // Create video encoder
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
    },
    error: (e) => {
      console.error('VideoEncoder error:', e);
    },
  });

  // Configure video encoder
  videoEncoder.configure({
    codec: 'avc1.42001f', // H.264 Baseline Profile Level 3.1
    width,
    height,
    bitrate: 5_000_000, // 5 Mbps
    framerate: frameRate,
  });

  // Get 2D context for flushing
  const ctx = canvas.getContext('2d')!;

  // Encode each video frame
  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
    // Check cancellation before each frame
    if (isCancelled?.()) {
      videoEncoder.close();
      throw new Error('Export cancelled');
    }

    onProgress?.({
      currentFrame: frameIndex + 1,
      totalFrames,
      stage: 'encoding',
    });

    // Render frame to canvas
    renderer.renderFrame(frameIndex);

    // Force canvas to complete rendering (prevents black frames when tab is hidden)
    // Reading a pixel forces the GPU to flush all pending operations
    ctx.getImageData(0, 0, 1, 1);

    // Create VideoFrame from canvas
    const frame = new VideoFrame(canvas, {
      timestamp: frameIndex * frameDurationMicros,
      duration: frameDurationMicros,
    });

    // Encode frame (keyframe every 30 frames)
    const isKeyFrame = frameIndex % 30 === 0;
    videoEncoder.encode(frame, { keyFrame: isKeyFrame });

    // Close frame to free memory
    frame.close();

    // Yield every frame to allow UI updates and cancel button clicks
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  await videoEncoder.flush();
  videoEncoder.close();

  // Encode audio if present and the codec is supported
  if (encodeAudio && audioData) {
    onProgress?.({
      currentFrame: totalFrames,
      totalFrames,
      stage: 'encoding-audio',
    });

    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => {
        muxer.addAudioChunk(chunk, meta);
      },
      error: (e) => {
        console.error('AudioEncoder error:', e);
      },
    });

    audioEncoder.configure(audioEncoderConfig);

    // Encode audio in chunks
    const samplesPerChunk = 1024;
    const totalSamples = audioData.length / 2; // stereo
    let sampleOffset = 0;

    while (sampleOffset < totalSamples) {
      const chunkSamples = Math.min(samplesPerChunk, totalSamples - sampleOffset);
      const chunkData = new Float32Array(chunkSamples * 2);

      for (let i = 0; i < chunkSamples * 2; i++) {
        chunkData[i] = audioData[sampleOffset * 2 + i] || 0;
      }

      const planarData = interleaveToPlanes(chunkData, chunkSamples);
      const audioFrame = new AudioData({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: chunkSamples,
        numberOfChannels: 2,
        timestamp: Math.round((sampleOffset / sampleRate) * 1_000_000),
        data: planarData.buffer as ArrayBuffer,
      });

      audioEncoder.encode(audioFrame);
      audioFrame.close();

      sampleOffset += chunkSamples;

      // Yield periodically
      if (sampleOffset % (samplesPerChunk * 100) === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    await audioEncoder.flush();
    audioEncoder.close();
  }

  // Finalize encoding
  onProgress?.({
    currentFrame: totalFrames,
    totalFrames,
    stage: 'finalizing',
  });

  // Finalize muxer
  muxer.finalize();

  // Get the video data
  const buffer = target.buffer;
  return new Blob([buffer], { type: 'video/mp4' });
}

/**
 * Export animation as WebM video (VP8/VP9 codec with Opus/Vorbis audio)
 */
export async function exportWebM(
  doc: FLADocument,
  onProgress?: ProgressCallback,
  isCancelled?: CancellationCheck
): Promise<Blob> {
  // Lazy load webm-muxer
  const webmMuxer = await import('webm-muxer');
  const { Muxer, ArrayBufferTarget } = webmMuxer;

  const width = doc.width;
  const height = doc.height;
  const frameRate = doc.frameRate;
  const totalFrames = doc.timelines[0]?.totalFrames || 1;

  // Create offscreen canvas for rendering
  const canvas = new OffscreenCanvas(width, height);

  const mockCanvas = {
    width,
    height,
    style: { width: '', height: '' },
    getContext: (type: string) => canvas.getContext(type as '2d'),
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
  } as unknown as HTMLCanvasElement;

  const renderer = new FLARenderer(mockCanvas);
  await renderer.setDocument(doc, true);

  // Calculate frame duration in microseconds
  const frameDurationMicros = Math.round(1_000_000 / frameRate);

  // Find stream sounds for audio export
  const streamSounds = findStreamSounds(doc);
  const hasAudio = streamSounds.length > 0;

  // Prepare audio data if we have sounds
  let audioData: Float32Array | null = null;
  let sampleRate = 44100;

  if (hasAudio) {
    const result = mixAudio(streamSounds, totalFrames, frameRate);
    audioData = result.data;
    sampleRate = result.sampleRate;
  }

  // Determine whether we can actually encode the audio track. The Opus encoder
  // may be unavailable in some environments, where constructing an AudioEncoder
  // would otherwise throw NotSupportedError. Degrade gracefully to a valid
  // video-only file instead of crashing the export.
  const audioEncoderConfig: AudioEncoderConfig = {
    codec: 'opus',
    numberOfChannels: 2,
    sampleRate,
    bitrate: 128_000, // 128 kbps
  };
  const encodeAudio =
    hasAudio && audioData !== null && (await isAudioCodecSupported(audioEncoderConfig));

  if (hasAudio && !encodeAudio) {
    console.warn(
      'exportWebM: audio codec "opus" is not supported in this environment; ' +
        'exporting video-only without an audio track.'
    );
  }

  // Create WebM muxer target
  const target = new ArrayBufferTarget();

  // Create WebM muxer with optional audio
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const muxerOptions: any = {
    target,
    video: {
      codec: 'V_VP9',
      width,
      height,
    },
    firstTimestampBehavior: 'offset',
  };

  if (encodeAudio) {
    muxerOptions.audio = {
      codec: 'A_OPUS',
      numberOfChannels: 2,
      sampleRate,
    };
  }

  const muxer = new Muxer(muxerOptions);

  // Create video encoder with VP9 codec
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
    },
    error: (e) => {
      console.error('VideoEncoder error:', e);
    },
  });

  // Configure video encoder for VP9
  videoEncoder.configure({
    codec: 'vp09.00.10.08', // VP9 Profile 0, Level 1.0, 8-bit
    width,
    height,
    bitrate: 5_000_000, // 5 Mbps
    framerate: frameRate,
  });

  // Get 2D context for flushing
  const ctx = canvas.getContext('2d')!;

  // Encode each video frame
  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
    if (isCancelled?.()) {
      videoEncoder.close();
      throw new Error('Export cancelled');
    }

    onProgress?.({
      currentFrame: frameIndex + 1,
      totalFrames,
      stage: 'encoding',
    });

    // Render frame to canvas
    renderer.renderFrame(frameIndex);

    // Force canvas to complete rendering
    ctx.getImageData(0, 0, 1, 1);

    // Create VideoFrame from canvas
    const frame = new VideoFrame(canvas, {
      timestamp: frameIndex * frameDurationMicros,
      duration: frameDurationMicros,
    });

    // Encode frame (keyframe every 30 frames)
    const isKeyFrame = frameIndex % 30 === 0;
    videoEncoder.encode(frame, { keyFrame: isKeyFrame });

    // Close frame to free memory
    frame.close();

    // Yield every frame to allow UI updates
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  await videoEncoder.flush();
  videoEncoder.close();

  // Encode audio if present and the codec is supported
  if (encodeAudio && audioData) {
    onProgress?.({
      currentFrame: totalFrames,
      totalFrames,
      stage: 'encoding-audio',
    });

    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => {
        muxer.addAudioChunk(chunk, meta);
      },
      error: (e) => {
        console.error('AudioEncoder error:', e);
      },
    });

    audioEncoder.configure(audioEncoderConfig);

    // Encode audio in chunks
    const samplesPerChunk = 1024;
    const totalSamples = audioData.length / 2;
    let sampleOffset = 0;

    while (sampleOffset < totalSamples) {
      const chunkSamples = Math.min(samplesPerChunk, totalSamples - sampleOffset);
      const chunkData = new Float32Array(chunkSamples * 2);

      for (let i = 0; i < chunkSamples * 2; i++) {
        chunkData[i] = audioData[sampleOffset * 2 + i] || 0;
      }

      const planarData = interleaveToPlanes(chunkData, chunkSamples);
      const audioFrame = new AudioData({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: chunkSamples,
        numberOfChannels: 2,
        timestamp: Math.round((sampleOffset / sampleRate) * 1_000_000),
        data: planarData.buffer as ArrayBuffer,
      });

      audioEncoder.encode(audioFrame);
      audioFrame.close();

      sampleOffset += chunkSamples;

      // Yield periodically
      if (sampleOffset % (samplesPerChunk * 100) === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    await audioEncoder.flush();
    audioEncoder.close();
  }

  // Finalize encoding
  onProgress?.({
    currentFrame: totalFrames,
    totalFrames,
    stage: 'finalizing',
  });

  // Finalize muxer
  muxer.finalize();

  // Get the video data
  const buffer = target.buffer;
  return new Blob([buffer], { type: 'video/webm' });
}

function findStreamSounds(doc: FLADocument): StreamSound[] {
  const streamSounds: StreamSound[] = [];
  if (!doc.timelines[0]) return streamSounds;

  const timeline = doc.timelines[0];
  for (const layer of timeline.layers) {
    for (const frame of layer.frames) {
      if (frame.sound && frame.sound.sync === 'stream') {
        const soundItem = doc.sounds.get(frame.sound.name);
        if (soundItem && soundItem.audioData) {
          streamSounds.push({
            sound: frame.sound,
            soundItem,
            startFrame: frame.index,
            duration: frame.duration,
          });
        }
      }
    }
  }

  return streamSounds;
}

function mixAudio(
  streamSounds: StreamSound[],
  totalFrames: number,
  frameRate: number
): { data: Float32Array; sampleRate: number } {
  const sampleRate = 44100;
  const totalDuration = totalFrames / frameRate;
  const totalSamples = Math.ceil(totalDuration * sampleRate);

  // Stereo buffer
  const mixBuffer = new Float32Array(totalSamples * 2);

  for (const stream of streamSounds) {
    const audioBuffer = stream.soundItem.audioData;
    if (!audioBuffer) continue;

    // Calculate start position in output
    const startTime = stream.startFrame / frameRate;
    const startSample = Math.floor(startTime * sampleRate);

    // Calculate source offset from inPoint44
    const inPointSamples = stream.sound.inPoint44 || 0;
    // Convert from 44kHz reference to actual sample rate
    const sourceOffset = Math.floor((inPointSamples / 44100) * audioBuffer.sampleRate);

    // Get audio data (convert to stereo if needed)
    const leftChannel = audioBuffer.getChannelData(0);
    const rightChannel = audioBuffer.numberOfChannels > 1
      ? audioBuffer.getChannelData(1)
      : leftChannel;

    // Mix into output buffer
    const soundDuration = stream.duration / frameRate;
    const samplesToMix = Math.min(
      Math.ceil(soundDuration * sampleRate),
      Math.floor((audioBuffer.length - sourceOffset) * (sampleRate / audioBuffer.sampleRate))
    );

    for (let i = 0; i < samplesToMix; i++) {
      const outputIdx = startSample + i;
      if (outputIdx >= totalSamples) break;

      // Resample if needed
      const sourceIdx = sourceOffset + Math.floor(i * (audioBuffer.sampleRate / sampleRate));
      if (sourceIdx >= audioBuffer.length) break;

      mixBuffer[outputIdx * 2] += leftChannel[sourceIdx] || 0;
      mixBuffer[outputIdx * 2 + 1] += rightChannel[sourceIdx] || 0;
    }
  }

  // Clamp values to [-1, 1]
  for (let i = 0; i < mixBuffer.length; i++) {
    mixBuffer[i] = Math.max(-1, Math.min(1, mixBuffer[i]));
  }

  return { data: mixBuffer, sampleRate };
}

function interleaveToPlanes(interleaved: Float32Array, frames: number): Float32Array {
  // AudioData with f32-planar expects [L0,L1,L2...,R0,R1,R2...]
  const planar = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    planar[i] = interleaved[i * 2]; // Left channel
    planar[frames + i] = interleaved[i * 2 + 1]; // Right channel
  }
  return planar;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function isWebCodecsSupported(): boolean {
  return (
    typeof VideoEncoder !== 'undefined' &&
    typeof VideoFrame !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof AudioEncoder !== 'undefined'
  );
}

export interface PNGSequenceProgress {
  currentFrame: number;
  totalFrames: number;
  stage: 'rendering' | 'zipping';
}

export type PNGProgressCallback = (progress: PNGSequenceProgress) => void;

export interface PNGSequenceOptions {
  startFrame?: number;
  endFrame?: number;
  framePrefix?: string;
  padLength?: number;
}

/**
 * Export animation frames as a sequence of PNG images packed in a ZIP file
 */
export async function exportPNGSequence(
  doc: FLADocument,
  options: PNGSequenceOptions = {},
  onProgress?: PNGProgressCallback,
  isCancelled?: CancellationCheck
): Promise<Blob> {
  // Lazy load JSZip
  const JSZip = (await import('jszip')).default;

  const {
    startFrame = 0,
    endFrame = doc.timelines[0]?.totalFrames || 1,
    framePrefix = 'frame_',
    padLength = 5
  } = options;

  const width = doc.width;
  const height = doc.height;
  const totalFrames = Math.max(1, endFrame - startFrame);

  // Create offscreen canvas for rendering
  const canvas = new OffscreenCanvas(width, height);

  // Create a minimal mock canvas for OffscreenCanvas compatibility
  const mockCanvas = {
    width,
    height,
    style: { width: '', height: '' },
    getContext: (type: string) => canvas.getContext(type as '2d'),
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
  } as unknown as HTMLCanvasElement;

  const renderer = new FLARenderer(mockCanvas);
  await renderer.setDocument(doc, true); // true = skip resize

  const zip = new JSZip();

  // Render each frame and add to ZIP
  for (let i = 0; i < totalFrames; i++) {
    const frameIndex = startFrame + i;

    // Check cancellation
    if (isCancelled?.()) {
      throw new Error('Export cancelled');
    }

    onProgress?.({
      currentFrame: i + 1,
      totalFrames,
      stage: 'rendering',
    });

    // Render frame to canvas
    renderer.renderFrame(frameIndex);

    // Convert to PNG blob
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const arrayBuffer = await blob.arrayBuffer();

    // Create filename with padding
    const frameNumber = String(frameIndex).padStart(padLength, '0');
    const filename = `${framePrefix}${frameNumber}.png`;

    zip.file(filename, arrayBuffer);

    // Yield to allow UI updates
    if (i % 10 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  onProgress?.({
    currentFrame: totalFrames,
    totalFrames,
    stage: 'zipping',
  });

  // Generate ZIP file
  const zipBlob = await zip.generateAsync({ type: 'blob' });
  return zipBlob;
}

/**
 * Export a single frame as PNG
 */
export async function exportSingleFrame(
  doc: FLADocument,
  frameIndex: number
): Promise<Blob> {
  const width = doc.width;
  const height = doc.height;

  // Create offscreen canvas for rendering
  const canvas = new OffscreenCanvas(width, height);

  // Create a minimal mock canvas for OffscreenCanvas compatibility
  const mockCanvas = {
    width,
    height,
    style: { width: '', height: '' },
    getContext: (type: string) => canvas.getContext(type as '2d'),
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
  } as unknown as HTMLCanvasElement;

  const renderer = new FLARenderer(mockCanvas);
  await renderer.setDocument(doc, true);

  // Render frame
  renderer.renderFrame(frameIndex);

  // Convert to PNG
  return canvas.convertToBlob({ type: 'image/png' });
}

export interface SpriteSheetProgress {
  currentFrame: number;
  totalFrames: number;
  stage: 'rendering' | 'compositing';
}

export type SpriteSheetProgressCallback = (progress: SpriteSheetProgress) => void;

export interface SpriteSheetOptions {
  startFrame?: number;
  endFrame?: number;
  columns?: number; // Number of columns (auto-calculated if not specified)
  padding?: number; // Padding between frames in pixels
  includeJson?: boolean; // Include JSON metadata file
}

export interface SpriteSheetResult {
  image: Blob;
  json?: string; // JSON metadata for game engines
  columns: number;
  rows: number;
  frameWidth: number;
  frameHeight: number;
  totalFrames: number;
}

/**
 * Export animation frames as a sprite sheet (texture atlas)
 */
export interface GIFExportProgress {
  currentFrame: number;
  totalFrames: number;
  stage: 'rendering' | 'encoding' | 'finalizing';
}

export type GIFProgressCallback = (progress: GIFExportProgress) => void;

export interface GIFExportOptions {
  startFrame?: number;
  endFrame?: number;
  loop?: boolean; // Default: true (loop forever)
  quality?: number; // 1-30, lower is better quality (default: 10)
}

/**
 * Export animation as an animated GIF
 */
export async function exportGIF(
  doc: FLADocument,
  options: GIFExportOptions = {},
  onProgress?: GIFProgressCallback,
  isCancelled?: CancellationCheck
): Promise<Blob> {
  // Lazy load gifenc
  const gifenc = await import('gifenc');
  const { GIFEncoder, quantize, applyPalette } = gifenc;

  const {
    startFrame = 0,
    endFrame = doc.timelines[0]?.totalFrames || 1,
    loop = true,
    quality = 10,
  } = options;

  const width = doc.width;
  const height = doc.height;
  const frameRate = doc.frameRate;
  const totalFrames = Math.max(1, endFrame - startFrame);

  // GIF frame delay is in centiseconds (1/100th of a second)
  const frameDelay = Math.round(100 / frameRate);

  // Create offscreen canvas for rendering
  const canvas = new OffscreenCanvas(width, height);

  const mockCanvas = {
    width,
    height,
    style: { width: '', height: '' },
    getContext: (type: string) => canvas.getContext(type as '2d'),
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
  } as unknown as HTMLCanvasElement;

  const renderer = new FLARenderer(mockCanvas);
  await renderer.setDocument(doc, true);

  // Create GIF encoder
  const gif = GIFEncoder();

  // Render each frame
  for (let i = 0; i < totalFrames; i++) {
    const frameIndex = startFrame + i;

    if (isCancelled?.()) {
      throw new Error('Export cancelled');
    }

    onProgress?.({
      currentFrame: i + 1,
      totalFrames,
      stage: 'rendering',
    });

    // Render frame
    renderer.renderFrame(frameIndex);

    // Get pixel data
    const ctx = canvas.getContext('2d')!;
    const imageData = ctx.getImageData(0, 0, width, height);
    const { data } = imageData;

    onProgress?.({
      currentFrame: i + 1,
      totalFrames,
      stage: 'encoding',
    });

    // Convert RGBA to indexed color using gifenc's quantize
    // quality affects palette size (lower = more colors = better quality)
    const maxColors = Math.min(256, Math.max(2, Math.round(256 / quality * 25)));
    const palette = quantize(data, maxColors);
    const indexedPixels = applyPalette(data, palette);

    // Add frame to GIF
    gif.writeFrame(indexedPixels, width, height, {
      palette,
      delay: frameDelay,
      repeat: loop ? 0 : -1, // 0 = loop forever, -1 = no loop
    });

    // Yield periodically
    if (i % 5 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  onProgress?.({
    currentFrame: totalFrames,
    totalFrames,
    stage: 'finalizing',
  });

  // Finish encoding
  gif.finish();

  // Get the GIF bytes and create a clean ArrayBuffer for Blob compatibility
  const bytes = gif.bytes();
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  return new Blob([arrayBuffer], { type: 'image/gif' });
}

export async function exportSpriteSheet(
  doc: FLADocument,
  options: SpriteSheetOptions = {},
  onProgress?: SpriteSheetProgressCallback,
  isCancelled?: CancellationCheck
): Promise<SpriteSheetResult> {
  const {
    startFrame = 0,
    endFrame = doc.timelines[0]?.totalFrames || 1,
    padding = 0,
    includeJson = true
  } = options;

  const frameWidth = doc.width;
  const frameHeight = doc.height;
  const totalFrames = Math.max(1, endFrame - startFrame);

  // Calculate optimal grid layout
  let columns = options.columns;
  if (!columns) {
    // Auto-calculate: aim for roughly square sprite sheet
    columns = Math.ceil(Math.sqrt(totalFrames));
  }
  const rows = Math.ceil(totalFrames / columns);

  // Calculate sprite sheet dimensions
  const sheetWidth = columns * (frameWidth + padding) - padding;
  const sheetHeight = rows * (frameHeight + padding) - padding;

  // Create offscreen canvas for individual frames
  const frameCanvas = new OffscreenCanvas(frameWidth, frameHeight);
  const mockCanvas = {
    width: frameWidth,
    height: frameHeight,
    style: { width: '', height: '' },
    getContext: (type: string) => frameCanvas.getContext(type as '2d'),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: frameWidth, height: frameHeight }),
  } as unknown as HTMLCanvasElement;

  const renderer = new FLARenderer(mockCanvas);
  await renderer.setDocument(doc, true);

  // Create sprite sheet canvas
  const sheetCanvas = new OffscreenCanvas(sheetWidth, sheetHeight);
  const sheetCtx = sheetCanvas.getContext('2d')!;

  // Clear with transparent background
  sheetCtx.clearRect(0, 0, sheetWidth, sheetHeight);

  // Render each frame to the sprite sheet
  for (let i = 0; i < totalFrames; i++) {
    const frameIndex = startFrame + i;

    if (isCancelled?.()) {
      throw new Error('Export cancelled');
    }

    onProgress?.({
      currentFrame: i + 1,
      totalFrames,
      stage: 'rendering',
    });

    // Render frame
    renderer.renderFrame(frameIndex);

    // Calculate position on sprite sheet
    const col = i % columns;
    const row = Math.floor(i / columns);
    const x = col * (frameWidth + padding);
    const y = row * (frameHeight + padding);

    // Copy frame to sprite sheet
    sheetCtx.drawImage(frameCanvas, x, y);

    // Yield periodically
    if (i % 10 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  onProgress?.({
    currentFrame: totalFrames,
    totalFrames,
    stage: 'compositing',
  });

  // Generate PNG blob
  const imageBlob = await sheetCanvas.convertToBlob({ type: 'image/png' });

  // Generate JSON metadata for game engines
  let json: string | undefined;
  if (includeJson) {
    const frames: Record<string, {
      frame: { x: number; y: number; w: number; h: number };
      sourceSize: { w: number; h: number };
    }> = {};

    for (let i = 0; i < totalFrames; i++) {
      const frameIndex = startFrame + i;
      const col = i % columns;
      const row = Math.floor(i / columns);
      const frameNum = String(frameIndex).padStart(5, '0');

      frames[`frame_${frameNum}`] = {
        frame: {
          x: col * (frameWidth + padding),
          y: row * (frameHeight + padding),
          w: frameWidth,
          h: frameHeight,
        },
        sourceSize: {
          w: frameWidth,
          h: frameHeight,
        },
      };
    }

    const metadata = {
      frames,
      meta: {
        app: 'FLA Viewer',
        version: '1.0',
        image: 'spritesheet.png',
        format: 'RGBA8888',
        size: { w: sheetWidth, h: sheetHeight },
        scale: 1,
        framerate: doc.frameRate,
      },
    };

    json = JSON.stringify(metadata, null, 2);
  }

  return {
    image: imageBlob,
    json,
    columns,
    rows,
    frameWidth,
    frameHeight,
    totalFrames,
  };
}

/**
 * Export a single frame as SVG
 */
export async function exportSVG(
  doc: FLADocument,
  frameIndex: number = 0
): Promise<Blob> {
  const width = doc.width;
  const height = doc.height;

  // Track unique IDs for gradients and patterns
  let defIdCounter = 0;
  const defs: string[] = [];

  // Helper to generate unique IDs
  const genId = (prefix: string) => `${prefix}_${defIdCounter++}`;

  // Dedupe cache for <filter> defs, keyed on the serialized filter chain so
  // reused filter stacks (symbols frequently share the same filters) share one
  // <filter id> and avoid bloating <defs> (mirrors createFilterDef below).
  const filterDefCache = new Map<string, string | null>();

  // Helper to escape XML
  const escapeXml = (str: string) => str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  // Convert matrix to SVG transform string
  const matrixToTransform = (m: import('./types').Matrix): string => {
    if (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.tx === 0 && m.ty === 0) {
      return '';
    }
    return `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.tx} ${m.ty})`;
  };

  // Convert path commands to SVG path data
  const commandsToPath = (commands: import('./types').PathCommand[]): string => {
    return commands.map(cmd => {
      switch (cmd.type) {
        case 'M': return `M${cmd.x} ${cmd.y}`;
        case 'L': return `L${cmd.x} ${cmd.y}`;
        case 'Q': return `Q${cmd.cx} ${cmd.cy} ${cmd.x} ${cmd.y}`;
        case 'C': return `C${cmd.c1x} ${cmd.c1y} ${cmd.c2x} ${cmd.c2y} ${cmd.x} ${cmd.y}`;
        case 'Z': return 'Z';
      }
    }).join(' ');
  };

  // Create fill definition and return reference
  const createFillDef = (fill: import('./types').FillStyle): string => {
    if (fill.type === 'solid') {
      const alpha = fill.alpha !== undefined ? fill.alpha : 1;
      if (alpha < 1) {
        return `${fill.color || '#000000'}` + (alpha < 1 ? `" fill-opacity="${alpha}` : '');
      }
      return fill.color || '#000000';
    }

    if (fill.type === 'linear' || fill.type === 'radial') {
      const gradId = genId('grad');
      const stops = (fill.gradient || []).map(entry => {
        const stopOpacity = entry.alpha < 1 ? ` stop-opacity="${entry.alpha}"` : '';
        return `<stop offset="${entry.ratio * 100}%" stop-color="${entry.color}"${stopOpacity}/>`;
      }).join('\n      ');

      if (fill.type === 'linear') {
        // Default linear gradient direction (left to right in local space)
        const m = fill.matrix;
        let gradientTransform = '';
        if (m) {
          gradientTransform = ` gradientTransform="matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.tx} ${m.ty})"`;
        }
        defs.push(`<linearGradient id="${gradId}" x1="-819.2" y1="0" x2="819.2" y2="0" gradientUnits="userSpaceOnUse"${gradientTransform}>
      ${stops}
    </linearGradient>`);
      } else {
        // Radial gradient
        const m = fill.matrix;
        let gradientTransform = '';
        if (m) {
          gradientTransform = ` gradientTransform="matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.tx} ${m.ty})"`;
        }
        // Place the focal point in the gradient's LOCAL (pre-transform) space:
        // fx is along the gradient-box X axis (radius 819.2 = 16384 twips / 20),
        // fy stays 0. The gradientTransform (fill matrix) then maps it into shape
        // space, so the NET focal position matches the canvas renderer, which bakes
        // the same matrix into fx/fy (renderer.ts createRadialGradient).
        //
        // Clamp focalPointRatio to [-0.98, 0.98] (same as renderer.ts:3318): the
        // raw range is -1..1, but focalPointRatio=-1 would land the focus exactly
        // on the outer rim, degenerating the radial gradient into a hard edge. The
        // clamp keeps the focus strictly inside the disc. focal==0/absent => fx=0
        // (centered), a strict no-op vs. before.
        const focalRatio = fill.focalPointRatio ?? 0;
        const clampedFocal = Math.max(-0.98, Math.min(0.98, focalRatio));
        const fx = clampedFocal * 819.2;
        defs.push(`<radialGradient id="${gradId}" cx="0" cy="0" r="819.2" fx="${fx}" fy="0" gradientUnits="userSpaceOnUse"${gradientTransform}>
      ${stops}
    </radialGradient>`);
      }
      return `url(#${gradId})`;
    }

    if (fill.type === 'bitmap' && fill.bitmapPath) {
      // For bitmap fills, we'd need to embed the image
      // For now, return a placeholder pattern
      const patternId = genId('pattern');
      const bitmap = doc.bitmaps.get(fill.bitmapPath);
      if (bitmap && bitmap.imageData) {
        // Create a canvas to get base64 data
        const imgCanvas = document.createElement('canvas');
        imgCanvas.width = bitmap.width;
        imgCanvas.height = bitmap.height;
        const imgCtx = imgCanvas.getContext('2d')!;
        imgCtx.drawImage(bitmap.imageData, 0, 0);
        const dataUrl = imgCanvas.toDataURL('image/png');

        const m = fill.matrix;
        let patternTransform = '';
        if (m) {
          // XFL bitmap-fill matrices are in TWIP space (a typical 1:1 fill is
          // a=20,d=20, tx/ty in twips). But this SVG path draws geometry in PIXEL
          // space: commandsToPath emits raw cmd.x/cmd.y and viewBox is document
          // pixels, with no global 1/20 scale to cancel the twips. Emitting the raw
          // matrix as patternTransform over-scales/mis-translates the bitmap ~20x.
          // Pre-divide every component (scale AND translation) by 20 to convert into
          // pixel space (same twip->pixel rationale as renderer.ts:3229 and
          // edge-decoder.ts COORD_SCALE=20). Gradient gradientTransform matrices are
          // already pixel-space and are NOT touched (see renderer.ts:3225-3228).
          const TWIPS_PER_PIXEL = 20;
          patternTransform = ` patternTransform="matrix(${m.a / TWIPS_PER_PIXEL} ${m.b / TWIPS_PER_PIXEL} ${m.c / TWIPS_PER_PIXEL} ${m.d / TWIPS_PER_PIXEL} ${m.tx / TWIPS_PER_PIXEL} ${m.ty / TWIPS_PER_PIXEL})"`;
        }

        defs.push(`<pattern id="${patternId}" width="${bitmap.width}" height="${bitmap.height}" patternUnits="userSpaceOnUse"${patternTransform}>
      <image href="${dataUrl}" width="${bitmap.width}" height="${bitmap.height}"/>
    </pattern>`);
        return `url(#${patternId})`;
      }
      return '#808080'; // Fallback gray
    }

    return '#000000';
  };

  // Map a Flash blend mode to its CSS mix-blend-mode value, or null when no
  // blend should be emitted (default 'normal' compositing). This mirrors the
  // canvas renderer's mapBlendMode (renderer.ts:3673-3693) intent:
  //   add      -> canvas 'lighter'  -> CSS 'plus-lighter' (the CSS equivalent)
  //   subtract -> canvas 'difference' (approx) -> CSS 'difference'
  //   invert   -> canvas 'exclusion' (approx)  -> CSS 'exclusion'
  // normal/layer/alpha all composite as source-over in the renderer, so they
  // emit NOTHING here (CSS default). 'erase' is destination-out in canvas and
  // has NO mix-blend-mode equivalent (it would need destination compositing) —
  // it is intentionally skipped (returns null, no blend emitted). Unknown
  // values also fall through to null.
  const blendModeToCss = (
    mode: import('./types').BlendMode | undefined
  ): string | null => {
    switch (mode) {
      case 'multiply': return 'multiply';
      case 'screen': return 'screen';
      case 'overlay': return 'overlay';
      case 'darken': return 'darken';
      case 'lighten': return 'lighten';
      case 'hardlight': return 'hard-light';
      case 'difference': return 'difference';
      case 'add': return 'plus-lighter'; // canvas 'lighter' equivalent
      case 'subtract': return 'difference'; // mirror renderer's approximation
      case 'invert': return 'exclusion'; // mirror renderer's approximation
      // normal / layer / alpha -> source-over (default); erase -> destination-out
      // (no CSS equivalent); undefined / unknown -> default. All emit nothing.
      default: return null;
    }
  };

  // Create a <filter> def for an instance's filter chain and return a
  // `filter="url(#...)"` attribute string (with a leading space), or '' when
  // there's nothing renderable. Mirrors the SUPPORTED set of the canvas
  // renderer's applyFilters (renderer.ts:3514): blur, glow, dropShadow and
  // colorMatrix. Other filter types (bevel/gradientGlow/gradientBevel/
  // convolution) are intentionally UNSUPPORTED in SVG export v1 — they have no
  // real-file usage and the canvas renderer only crudely approximates them, so
  // we skip them gracefully (emit no primitive, never throw).
  const createFilterDef = (
    filters: import('./types').Filter[] | undefined,
    colorTransform?: import('./types').ColorTransform
  ): string => {
    // Does the color transform have a non-identity RGB part (tint)? Mirrors the
    // canvas renderer's colorTransformAffectsRGB (renderer.ts:3775) EXACTLY,
    // including the 1e-6 threshold, so SVG and canvas agree on when a tint is
    // present. Alpha is intentionally excluded (handled via the <g> opacity).
    const hasRgbTint = (() => {
      if (!colorTransform) return false;
      const rMult = colorTransform.redMultiplier ?? 1;
      const gMult = colorTransform.greenMultiplier ?? 1;
      const bMult = colorTransform.blueMultiplier ?? 1;
      const rOff = colorTransform.redOffset ?? 0;
      const gOff = colorTransform.greenOffset ?? 0;
      const bOff = colorTransform.blueOffset ?? 0;
      return (
        Math.abs(rMult - 1) > 1e-6 || Math.abs(gMult - 1) > 1e-6 || Math.abs(bMult - 1) > 1e-6 ||
        Math.abs(rOff) > 1e-6 || Math.abs(gOff) > 1e-6 || Math.abs(bOff) > 1e-6
      );
    })();

    const hasFilters = !!filters && filters.length > 0;
    // Neither filters NOR an RGB tint → no <filter> attribute at all.
    if (!hasFilters && !hasRgbTint) return '';

    // Dedupe key: the serialized filter chain PLUS the RGB color transform, so a
    // tinted chain and an untinted-but-otherwise-identical chain don't collide.
    const cacheKey = JSON.stringify({
      f: filters ?? null,
      ct: hasRgbTint
        ? {
            rm: colorTransform!.redMultiplier ?? 1,
            gm: colorTransform!.greenMultiplier ?? 1,
            bm: colorTransform!.blueMultiplier ?? 1,
            ro: colorTransform!.redOffset ?? 0,
            go: colorTransform!.greenOffset ?? 0,
            bo: colorTransform!.blueOffset ?? 0,
          }
        : null,
    });
    if (filterDefCache.has(cacheKey)) {
      const cached = filterDefCache.get(cacheKey)!;
      return cached ? ` filter="url(#${cached})"` : '';
    }

    // SVG filter primitives (one entry per supported filter in the chain). Each
    // produces a result region; we composite shadows BEHIND the source graphic.
    const primitives: string[] = [];
    // Track named results so a trailing feMerge can stack shadows then source.
    const shadowResults: string[] = [];
    let resultCounter = 0;

    // feFlood flood-opacity must stay within [0,1].
    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

    // 1) RGB color transform (tint) FIRST — matching the canvas, which renders
    // the symbol's pixels into an offscreen buffer, applies c' =
    // clamp(c*mult + offset, 0, 255) per channel (renderer.ts
    // applyColorTransformToImage), then composites the tinted buffer through any
    // filters. So the <feColorMatrix> reads SourceGraphic and its tinted result
    // becomes the input the geometric filters (blur) consume below. Offsets are
    // stored on the 0..255 scale by the parser (fla-parser.ts
    // parseColorTransform: redOffset = tintColorR * tintMultiplier) and the
    // canvas; feColorMatrix uses 0..1 offsets, so each offset is divided by 255.
    // e.g. #FF0000 @ tint 0.32 -> redOffset 81.6 -> R-offset slot 81.6/255 ≈
    // 0.32. Alpha row is identity: alphaMultiplier is applied once via the <g>
    // opacity attribute, so alpha is never doubled.
    let tintResult: string | null = null;
    if (hasRgbTint) {
      const rMult = colorTransform!.redMultiplier ?? 1;
      const gMult = colorTransform!.greenMultiplier ?? 1;
      const bMult = colorTransform!.blueMultiplier ?? 1;
      const rOff = (colorTransform!.redOffset ?? 0) / 255;
      const gOff = (colorTransform!.greenOffset ?? 0) / 255;
      const bOff = (colorTransform!.blueOffset ?? 0) / 255;
      const m = [
        rMult, 0, 0, 0, rOff,
        0, gMult, 0, 0, gOff,
        0, 0, bMult, 0, bOff,
        0, 0, 0, 1, 0,
      ];
      tintResult = `f${resultCounter++}`;
      primitives.push(
        `<feColorMatrix in="SourceGraphic" type="matrix" values="${m.join(' ')}" result="${tintResult}"/>`
      );
    }
    // When a tint is prepended, geometric filters must consume the TINTED pixels
    // (not the raw SourceGraphic), matching the canvas order. These map the
    // default inputs onto the tint result so the existing primitive emission
    // below stays unchanged.
    const sourceGraphicIn = tintResult ?? 'SourceGraphic';
    const sourceAlphaIn = tintResult ?? 'SourceAlpha';

    for (const filter of filters ?? []) {
      switch (filter.type) {
        case 'blur': {
          // Flash blurX/blurY (px) ≈ 2× SVG stdDeviation; the renderer uses CSS
          // blur((blurX+blurY)/2 px) which itself ≈ 2× stdDeviation, so divide
          // each axis by 2 to match the canvas appearance.
          const sx = filter.blurX / 2;
          const sy = filter.blurY / 2;
          primitives.push(
            `<feGaussianBlur in="${sourceGraphicIn}" stdDeviation="${sx} ${sy}"/>`
          );
          break;
        }
        case 'glow':
        case 'dropShadow': {
          // glow == distance-0 colored shadow; dropShadow offsets it by
          // distance@angle. The renderer sets shadowBlur = max(blurX,blurY)*
          // strength and the shadow color = color@alpha; we approximate that
          // intent: blur radius from max axis (÷2 for stdDeviation), opacity =
          // alpha×strength clamped.
          const stdDev = Math.max(filter.blurX, filter.blurY) / 2;
          const strength = filter.strength ?? 1;
          const alpha = filter.alpha ?? 1;
          const floodOpacity = clamp01(alpha * strength);

          const blurResult = `f${resultCounter++}`;
          const offsetResult = `f${resultCounter++}`;
          const floodResult = `f${resultCounter++}`;
          const shadowResult = `f${resultCounter++}`;

          primitives.push(
            `<feGaussianBlur in="${sourceAlphaIn}" stdDeviation="${stdDev}" result="${blurResult}"/>`
          );

          let composeIn = blurResult;
          if (filter.type === 'dropShadow') {
            const angleRad = ((filter.angle ?? 45) * Math.PI) / 180;
            const dx = Math.cos(angleRad) * filter.distance;
            const dy = Math.sin(angleRad) * filter.distance;
            primitives.push(
              `<feOffset in="${blurResult}" dx="${dx}" dy="${dy}" result="${offsetResult}"/>`
            );
            composeIn = offsetResult;
          }

          primitives.push(
            `<feFlood flood-color="${filter.color}" flood-opacity="${floodOpacity}" result="${floodResult}"/>`
          );
          primitives.push(
            `<feComposite in="${floodResult}" in2="${composeIn}" operator="in" result="${shadowResult}"/>`
          );
          shadowResults.push(shadowResult);
          break;
        }
        case 'colorMatrix': {
          // Reuse the EXACT normalization the renderer uses
          // (renderer.ts:3624-3634): offsets at indices 4,9,14,19 are divided by
          // 255 so canvas (which builds the same feColorMatrix via a data URL)
          // and SVG export agree.
          if (filter.matrix && filter.matrix.length === 20) {
            const m = [...filter.matrix];
            m[4] /= 255;
            m[9] /= 255;
            m[14] /= 255;
            m[19] /= 255;
            primitives.push(
              `<feColorMatrix in="${sourceGraphicIn}" type="matrix" values="${m.join(' ')}"/>`
            );
          }
          break;
        }
        // bevel / gradientGlow / gradientBevel / convolution:
        // intentionally UNSUPPORTED in SVG export v1 (see header comment).
        // Skip gracefully — no primitive emitted, no throw.
      }
    }

    // If any shadow primitives were produced, stack them behind the source so
    // the glow/dropShadow shows around the original graphic.
    if (shadowResults.length > 0) {
      const merges = shadowResults
        .map((r) => `<feMergeNode in="${r}"/>`)
        .join('');
      primitives.push(
        `<feMerge>${merges}<feMergeNode in="${sourceGraphicIn}"/></feMerge>`
      );
    }

    // Nothing renderable (e.g. only unsupported filters) → cache the miss.
    if (primitives.length === 0) {
      filterDefCache.set(cacheKey, null);
      return '';
    }

    const filterId = genId('filter');
    // Explicit oversized region so blur/shadow don't clip at the bbox edge.
    defs.push(
      `<filter id="${filterId}" x="-50%" y="-50%" width="200%" height="200%">${primitives.join(
        ''
      )}</filter>`
    );
    filterDefCache.set(cacheKey, filterId);
    return ` filter="url(#${filterId})"`;
  };

  // Render a shape element to SVG
  const renderShape = (shape: import('./types').Shape): string => {
    const paths: string[] = [];
    const transform = matrixToTransform(shape.matrix);
    const transformAttr = transform ? ` transform="${transform}"` : '';

    for (const edge of shape.edges) {
      const pathData = commandsToPath(edge.commands);
      if (!pathData) continue;

      let fill = 'none';
      let stroke = 'none';
      let strokeWidth = 0;
      let strokeLinecap = '';
      let strokeLinejoin = '';
      let strokeDasharray = '';

      // Get fill style
      if (edge.fillStyle0 !== undefined || edge.fillStyle1 !== undefined) {
        const fillIdx = edge.fillStyle0 || edge.fillStyle1;
        const fillStyle = shape.fills.find(f => f.index === fillIdx);
        if (fillStyle) {
          fill = createFillDef(fillStyle);
        }
      }

      // Get stroke style
      if (edge.strokeStyle !== undefined) {
        const strokeStyle = shape.strokes.find(s => s.index === edge.strokeStyle);
        if (strokeStyle && strokeStyle.color) {
          stroke = strokeStyle.color;
          strokeWidth = strokeStyle.weight;
          if (strokeStyle.caps === 'round') strokeLinecap = ' stroke-linecap="round"';
          else if (strokeStyle.caps === 'square') strokeLinecap = ' stroke-linecap="square"';
          if (strokeStyle.joints === 'round') strokeLinejoin = ' stroke-linejoin="round"';
          else if (strokeStyle.joints === 'bevel') strokeLinejoin = ' stroke-linejoin="bevel"';
          // Dashed strokes carry a [dash, gap] pattern in user-space units, 1:1 with
          // stroke-width (= strokeStyle.weight, same units the canvas uses for lineWidth/
          // setLineDash). Emit only for a non-empty dash; absent/empty -> solid (no attr).
          if (Array.isArray(strokeStyle.dash) && strokeStyle.dash.length > 0) {
            strokeDasharray = ` stroke-dasharray="${strokeStyle.dash.join(' ')}"`;
          }
        }
      }

      const fillAttr = fill.includes('fill-opacity') ? `fill="${fill.split('"')[0]}" fill-opacity="${fill.split('"')[1]}"` : `fill="${fill}"`;
      const strokeAttr = stroke !== 'none' ? ` stroke="${stroke}" stroke-width="${strokeWidth}"${strokeLinecap}${strokeLinejoin}${strokeDasharray}` : '';

      paths.push(`<path d="${pathData}" ${fillAttr}${strokeAttr}/>`);
    }

    if (paths.length === 0) return '';
    return `<g${transformAttr}>\n    ${paths.join('\n    ')}\n  </g>`;
  };

  // Emit the FILL geometry of a single mask shape as <path> clip elements,
  // wrapped in a <g transform> for the shape's matrix so the clip sits in the
  // same pixel space as the masked content (the masked children render in that
  // same parent transform). This mirrors the canvas renderer's mask clip
  // (renderer.ts:933-944): it clips with the shape's FILL paths under the
  // shape matrix. We use a hard, geometry-only clip (clip-rule nonzero — the
  // SVG default, matching ctx.clip(path,'nonzero')); no luminance/soft edges.
  // Only edges that participate in a fill (fillStyle0/fillStyle1) contribute,
  // exactly like fillPaths in the renderer. clip-path ignores fill/stroke
  // paint, so we emit pure `d` geometry without paint attributes.
  const maskShapeToClipPaths = (shape: import('./types').Shape): string => {
    const paths: string[] = [];
    for (const edge of shape.edges) {
      // A mask clips by FILLED regions only (mirror renderer fillPaths).
      if (edge.fillStyle0 === undefined && edge.fillStyle1 === undefined) {
        continue;
      }
      const pathData = commandsToPath(edge.commands);
      if (!pathData) continue;
      paths.push(`<path d="${pathData}"/>`);
    }
    if (paths.length === 0) return '';
    const transform = matrixToTransform(shape.matrix);
    const transformAttr = transform ? ` transform="${transform}"` : '';
    if (transformAttr) {
      return `<g${transformAttr}>${paths.join('')}</g>`;
    }
    return paths.join('');
  };

  // Build a <clipPath> def from a mask layer's frame and return its id, or null
  // when the mask contributes no clip (so the caller renders the masked children
  // unclipped — matching renderer.ts:915-928 "no mask content" path). Symbol /
  // non-shape mask elements fall back to a full-document rect clip, mirroring the
  // renderer's full-rect fallback (renderer.ts:947-953); real files use shape
  // masks, so this path is defensive.
  const buildMaskClipDef = (
    maskFrame: import('./types').Frame
  ): string | null => {
    const clipChildren: string[] = [];
    let usedSymbolFallback = false;
    for (const element of maskFrame.elements) {
      if (element.type === 'shape') {
        const clipPaths = maskShapeToClipPaths(element);
        if (clipPaths) clipChildren.push(clipPaths);
      } else if (element.type === 'symbol') {
        // Symbol-as-mask: the renderer falls back to a full-rect clip (it does
        // not rasterize the symbol's geometry). Mirror that — clip to the whole
        // document so masked content shows everywhere (effectively unclipped),
        // rather than dropping it. Only one full-rect is needed.
        usedSymbolFallback = true;
      }
      // text / bitmap / video as a mask: no geometry to clip with; skip (the
      // renderer also only handles shape + symbol in renderMaskGroup).
    }
    if (clipChildren.length === 0 && usedSymbolFallback) {
      clipChildren.push(`<rect x="0" y="0" width="${width}" height="${height}"/>`);
    }
    if (clipChildren.length === 0) return null;
    const clipId = genId('clip');
    defs.push(`<clipPath id="${clipId}">${clipChildren.join('')}</clipPath>`);
    return clipId;
  };

  // Render text element to SVG
  const renderText = (text: import('./types').TextInstance): string => {
    const transform = matrixToTransform(text.matrix);
    const transformAttr = transform ? ` transform="${transform}"` : '';

    const textElements: string[] = [];
    let y = text.textRuns[0]?.size || 12;

    for (const run of text.textRuns) {
      const fontSize = run.size;
      const fontFamily = run.face || 'Arial';
      const fontWeight = run.bold ? 'bold' : 'normal';
      const fontStyle = run.italic ? 'italic' : 'normal';
      const fill = run.fillColor;
      const anchor = run.alignment === 'center' ? 'middle' : run.alignment === 'right' ? 'end' : 'start';

      // Handle multi-line text
      const lines = run.characters.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          const decoration = run.underline ? ' text-decoration="underline"' : '';
          textElements.push(`<text x="${text.left}" y="${y}" font-family="${escapeXml(fontFamily)}" font-size="${fontSize}" font-weight="${fontWeight}" font-style="${fontStyle}" fill="${fill}" text-anchor="${anchor}"${decoration}>${escapeXml(line)}</text>`);
        }
        y += run.lineHeight || fontSize * 1.2;
      }
    }

    if (textElements.length === 0) return '';
    // TextInstance also carries filters (types.ts:209) — emit the same supported
    // blur/glow/dropShadow/colorMatrix SVG <filter> on its group.
    const svgFilterAttr = createFilterDef(text.filters);
    return `<g${transformAttr}${svgFilterAttr}>\n    ${textElements.join('\n    ')}\n  </g>`;
  };

  // Render bitmap instance to SVG
  const renderBitmap = (bitmap: import('./types').BitmapInstance): string => {
    const bitmapItem = doc.bitmaps.get(bitmap.libraryItemName);
    if (!bitmapItem || !bitmapItem.imageData) return '';

    const transform = matrixToTransform(bitmap.matrix);
    const transformAttr = transform ? ` transform="${transform}"` : '';

    // Convert image to data URL
    const imgCanvas = document.createElement('canvas');
    imgCanvas.width = bitmapItem.width;
    imgCanvas.height = bitmapItem.height;
    const imgCtx = imgCanvas.getContext('2d')!;
    imgCtx.drawImage(bitmapItem.imageData, 0, 0);
    const dataUrl = imgCanvas.toDataURL('image/png');

    return `<image${transformAttr} href="${dataUrl}" width="${bitmapItem.width}" height="${bitmapItem.height}"/>`;
  };

  // Render element with keyframe start tracking for symbol frame calculation
  const renderElementWithKeyframe = (element: import('./types').DisplayElement, depth: number, keyframeStart: number): string => {
    if (depth > 10) return ''; // Prevent infinite recursion

    switch (element.type) {
      case 'shape':
        return renderShape(element);
      case 'text':
        return renderText(element);
      case 'bitmap':
        return renderBitmap(element);
      case 'symbol':
        return renderSymbol(element, depth, keyframeStart);
      case 'video':
        // Video placeholder
        const transform = matrixToTransform(element.matrix);
        const transformAttr = transform ? ` transform="${transform}"` : '';
        return `<rect${transformAttr} width="${element.width}" height="${element.height}" fill="#333" stroke="#666"/>`;
    }
    return '';
  };

  // Render symbol instance to SVG
  const renderSymbol = (instance: import('./types').SymbolInstance, depth: number, keyframeStart: number = 0): string => {
    if (instance.isVisible === false) return '';

    const symbol = doc.symbols.get(instance.libraryItemName);
    if (!symbol) return '';

    const transform = matrixToTransform(instance.matrix);
    const transformAttr = transform ? ` transform="${transform}"` : '';

    // Calculate which frame to render based on symbol type and loop mode
    // This matches the renderer's logic
    const firstFrame = instance.firstFrame || 0;
    const lastFrame = instance.lastFrame;
    const totalSymbolFrames = Math.max(1, symbol.timeline.totalFrames);

    // Determine effective frame range
    const effectiveLastFrame = lastFrame !== undefined
      ? Math.min(lastFrame, totalSymbolFrames - 1)
      : totalSymbolFrames - 1;
    const frameRange = effectiveLastFrame - firstFrame + 1;

    let symbolFrame: number;

    // MovieClips and Buttons play independently - use firstFrame for static rendering
    const effectiveLoop = (instance.symbolType === 'movieclip' || instance.symbolType === 'button')
      ? 'single frame'
      : instance.loop;

    if (effectiveLoop === 'single frame') {
      // Always show the specified firstFrame
      symbolFrame = firstFrame % totalSymbolFrames;
    } else if (effectiveLoop === 'loop') {
      // Sync with parent timeline: advance from firstFrame based on parent frame offset
      const frameOffset = frameIndex - keyframeStart;
      if (lastFrame !== undefined) {
        symbolFrame = firstFrame + (frameOffset % frameRange);
      } else {
        symbolFrame = (firstFrame + frameOffset) % totalSymbolFrames;
      }
    } else {
      // 'play once' - advance but clamp at last frame
      const frameOffset = frameIndex - keyframeStart;
      symbolFrame = Math.min(firstFrame + frameOffset, effectiveLastFrame);
    }

    // Collect elements from all layers at the symbolFrame, mask-aware (mask
    // grouping + <clipPath>) just like the main timeline. Symbol timelines
    // historically did not skip referenceLayers here, so pass an empty set to
    // preserve that behavior while gaining mask support.
    const elements: string[] = [];
    renderLayerStack(
      symbol.timeline.layers,
      symbolFrame,
      depth + 1,
      new Set<number>(),
      elements
    );

    if (elements.length === 0) return '';

    // Apply color transform's alphaMultiplier as group opacity if needed.
    let opacityAttr = '';
    if (instance.colorTransform) {
      const ct = instance.colorTransform;
      if (ct.alphaMultiplier !== undefined && ct.alphaMultiplier !== 1) {
        opacityAttr = ` opacity="${ct.alphaMultiplier}"`;
      }
    }

    // Emit blur/glow/dropShadow/colorMatrix AND the instance's per-channel RGB
    // color transform (tint) as a single SVG <filter> on this group: the tint
    // <feColorMatrix> is prepended FIRST so geometric filters operate on the
    // tinted pixels, matching the canvas. Coexists with opacity (alphaMultiplier
    // is applied once on the <g>; the matrix alpha row is identity) — both
    // attributes are kept.
    const svgFilterAttr = createFilterDef(instance.filters, instance.colorTransform);

    // Emit the instance blend mode as a CSS mix-blend-mode on this group, with
    // isolation:isolate so it composites against its sibling stack (the symbol's
    // own children) rather than the whole document. null -> no blend (normal /
    // erase / unknown). This coexists with transform/opacity/filter — it is a
    // separate `style` attribute, so there's no attribute collision.
    const cssBlend = blendModeToCss(instance.blendMode);
    const blendStyleAttr = cssBlend
      ? ` style="mix-blend-mode:${cssBlend};isolation:isolate"`
      : '';

    return `<g${transformAttr}${opacityAttr}${svgFilterAttr}${blendStyleAttr}>\n    ${elements.join('\n    ')}\n  </g>`;
  };

  // Find the frame active at a given frame index for a layer (same scan the
  // renderer uses: index <= frame.index < index + duration).
  const findActiveFrame = (
    layer: import('./types').Layer,
    atFrameIndex: number
  ): import('./types').Frame | null => {
    for (const frame of layer.frames) {
      if (atFrameIndex >= frame.index && atFrameIndex < frame.index + frame.duration) {
        return frame;
      }
    }
    return null;
  };

  // Render one layer's active-frame elements into SVG strings.
  const renderLayerElements = (
    layer: import('./types').Layer,
    atFrameIndex: number,
    depth: number,
    out: string[]
  ): void => {
    const currentFrame = findActiveFrame(layer, atFrameIndex);
    if (!currentFrame) return;
    for (const element of currentFrame.elements) {
      const rendered = renderElementWithKeyframe(element, depth, currentFrame.index);
      if (rendered) out.push(rendered);
    }
  };

  // Render a stack of timeline layers (main timeline or a symbol's timeline)
  // with MASK support, mirroring renderer.ts renderTimelineLayers/renderMaskGroup
  // (renderer.ts:832-968). Layers are iterated in reverse (bottom first, top
  // last) to match the renderer and the prior export behavior.
  //
  // Mask handling:
  //  - Build masked-layer -> mask-layer grouping from layer.maskLayerIndex
  //    (renderer.ts:833-837).
  //  - A `mask` layer: if hidden, the WHOLE group is omitted (renderer.ts:874-
  //    875). Otherwise its shape geometry becomes a <clipPath> and its masked
  //    children render inside one <g clip-path="url(#...)">.
  //  - Each masked child still honors isLayerVisibleInFla on its own (the shared
  //    cascade helper). Because a masked child's parentLayerIndex points at the
  //    mask, isLayerVisibleInFla already returns false when the mask is hidden —
  //    but the mask block returns first, so there is no double-hide.
  //  - Masked children are NOT rendered again when their index comes up in the
  //    normal loop (tracked via maskedLayers).
  const renderLayerStack = (
    layers: import('./types').Layer[],
    atFrameIndex: number,
    depth: number,
    referenceLayers: Set<number>,
    out: string[]
  ): void => {
    // masked layer index -> mask layer index (renderer.ts:833-837)
    const maskedLayers = new Map<number, number>();
    for (let i = 0; i < layers.length; i++) {
      if (layers[i].maskLayerIndex !== undefined) {
        maskedLayers.set(i, layers[i].maskLayerIndex!);
      }
    }

    const indices = [...Array(layers.length).keys()].reverse();
    for (const layerIndex of indices) {
      const layer = layers[layerIndex];

      if (referenceLayers.has(layerIndex)) continue;
      if (layer.layerType === 'guide' || layer.layerType === 'folder') continue;

      // Mask layer: its own visibility gates the whole group (renderer.ts:874).
      if (layer.layerType === 'mask') {
        if (!isLayerVisibleInFla(layers, layerIndex)) continue; // hidden mask hides group

        // Collect the layers masked by this mask (renderer.ts:878-884).
        const maskedByThis: number[] = [];
        for (const [maskedIdx, maskIdx] of maskedLayers) {
          if (maskIdx === layerIndex) maskedByThis.push(maskedIdx);
        }
        if (maskedByThis.length === 0) continue; // mask with no children: nothing to draw

        // Render the masked children (bottom first, top last) honoring each
        // child's own visibility. No double-hide: isLayerVisibleInFla here is
        // the child's check; the mask gate above is separate.
        const childOut: string[] = [];
        for (const maskedIdx of [...maskedByThis].sort((a, b) => b - a)) {
          if (!isLayerVisibleInFla(layers, maskedIdx)) continue;
          renderLayerElements(layers[maskedIdx], atFrameIndex, depth, childOut);
        }
        if (childOut.length === 0) continue; // nothing visible to clip

        // Build the clip from the mask layer's frame geometry. null clip =>
        // no mask content; render children unclipped (renderer.ts:915-928).
        const maskFrame = findActiveFrame(layer, atFrameIndex);
        const clipId = maskFrame ? buildMaskClipDef(maskFrame) : null;
        if (clipId) {
          out.push(`<g clip-path="url(#${clipId})">\n    ${childOut.join('\n    ')}\n  </g>`);
        } else {
          out.push(...childOut);
        }
        continue;
      }

      // Masked children are drawn by their mask block above; skip here.
      if (maskedLayers.has(layerIndex)) continue;

      // Normal layer: honor visibility cascade.
      if (!isLayerVisibleInFla(layers, layerIndex)) continue;
      renderLayerElements(layer, atFrameIndex, depth, out);
    }
  };

  // Render the frame
  const timeline = doc.timelines[0];
  if (!timeline) {
    return new Blob(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], { type: 'image/svg+xml' });
  }

  const renderedElements: string[] = [];
  // Mask-aware reverse-order layer rendering (mask grouping + <clipPath>),
  // mirroring the canvas renderer. Reference layers are skipped (as before).
  renderLayerStack(
    timeline.layers,
    frameIndex,
    0,
    timeline.referenceLayers,
    renderedElements
  );

  // Build SVG
  const defsSection = defs.length > 0 ? `\n  <defs>\n    ${defs.join('\n    ')}\n  </defs>` : '';
  const bgRect = doc.backgroundColor !== '#ffffff' && doc.backgroundColor !== 'transparent'
    ? `\n  <rect width="${width}" height="${height}" fill="${doc.backgroundColor}"/>`
    : '';

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${defsSection}${bgRect}
  ${renderedElements.join('\n  ')}
</svg>`;

  return new Blob([svg], { type: 'image/svg+xml' });
}
