import type { FLADocument, SoundItem, FrameSound } from './types';
import { FLARenderer } from './renderer';

export interface ExportProgress {
  currentFrame: number;
  totalFrames: number;
  stage: 'encoding' | 'encoding-audio' | 'finalizing';
}

export type ProgressCallback = (progress: ExportProgress) => void;
export type CancellationCheck = () => boolean;

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

  if (hasAudio && audioData) {
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

  // Encode audio if present
  if (hasAudio && audioData) {
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

    audioEncoder.configure({
      codec: 'mp4a.40.2', // AAC-LC
      numberOfChannels: 2,
      sampleRate,
      bitrate: 128_000, // 128 kbps
    });

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

  if (hasAudio && audioData) {
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

  // Encode audio if present
  if (hasAudio && audioData) {
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

    audioEncoder.configure({
      codec: 'opus',
      numberOfChannels: 2,
      sampleRate,
      bitrate: 128_000, // 128 kbps
    });

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
        const fx = fill.focalPointRatio !== undefined ? fill.focalPointRatio * 819.2 : 0;
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
          patternTransform = ` patternTransform="matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.tx} ${m.ty})"`;
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
        if (strokeStyle) {
          stroke = strokeStyle.color;
          strokeWidth = strokeStyle.weight;
          if (strokeStyle.caps === 'round') strokeLinecap = ' stroke-linecap="round"';
          else if (strokeStyle.caps === 'square') strokeLinecap = ' stroke-linecap="square"';
          if (strokeStyle.joints === 'round') strokeLinejoin = ' stroke-linejoin="round"';
          else if (strokeStyle.joints === 'bevel') strokeLinejoin = ' stroke-linejoin="bevel"';
        }
      }

      const fillAttr = fill.includes('fill-opacity') ? `fill="${fill.split('"')[0]}" fill-opacity="${fill.split('"')[1]}"` : `fill="${fill}"`;
      const strokeAttr = stroke !== 'none' ? ` stroke="${stroke}" stroke-width="${strokeWidth}"${strokeLinecap}${strokeLinejoin}` : '';

      paths.push(`<path d="${pathData}" ${fillAttr}${strokeAttr}/>`);
    }

    if (paths.length === 0) return '';
    return `<g${transformAttr}>\n    ${paths.join('\n    ')}\n  </g>`;
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
    return `<g${transformAttr}>\n    ${textElements.join('\n    ')}\n  </g>`;
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

    // Collect elements from all layers at the symbolFrame
    const elements: string[] = [];
    const layerIndices = [...Array(symbol.timeline.layers.length).keys()].reverse();

    for (const layerIndex of layerIndices) {
      const layer = symbol.timeline.layers[layerIndex];
      if (!layer.visible || layer.layerType === 'guide' || layer.layerType === 'folder') continue;

      // Find frame at symbolFrame
      let currentFrame: import('./types').Frame | null = null;
      for (const frame of layer.frames) {
        if (symbolFrame >= frame.index && symbolFrame < frame.index + frame.duration) {
          currentFrame = frame;
          break;
        }
      }

      if (currentFrame) {
        for (const elem of currentFrame.elements) {
          const rendered = renderElementWithKeyframe(elem, depth + 1, currentFrame.index);
          if (rendered) elements.push(rendered);
        }
      }
    }

    if (elements.length === 0) return '';

    // Apply color transform as filter if needed
    let filterAttr = '';
    if (instance.colorTransform) {
      const ct = instance.colorTransform;
      if (ct.alphaMultiplier !== undefined && ct.alphaMultiplier !== 1) {
        filterAttr = ` opacity="${ct.alphaMultiplier}"`;
      }
    }

    return `<g${transformAttr}${filterAttr}>\n    ${elements.join('\n    ')}\n  </g>`;
  };

  // Render the frame
  const timeline = doc.timelines[0];
  if (!timeline) {
    return new Blob(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], { type: 'image/svg+xml' });
  }

  const renderedElements: string[] = [];
  // Use reversed indices like the renderer (bottom layers rendered first, top layers last)
  const layerIndices = [...Array(timeline.layers.length).keys()].reverse();

  for (const layerIndex of layerIndices) {
    const layer = timeline.layers[layerIndex];
    if (!layer.visible || layer.layerType === 'guide' || layer.layerType === 'folder') continue;
    if (timeline.referenceLayers.has(layerIndex)) continue;

    // Find frame at frameIndex
    let currentFrame: import('./types').Frame | null = null;
    for (const frame of layer.frames) {
      if (frameIndex >= frame.index && frameIndex < frame.index + frame.duration) {
        currentFrame = frame;
        break;
      }
    }

    if (currentFrame) {
      for (const element of currentFrame.elements) {
        const rendered = renderElementWithKeyframe(element, 0, currentFrame.index);
        if (rendered) renderedElements.push(rendered);
      }
    }
  }

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
