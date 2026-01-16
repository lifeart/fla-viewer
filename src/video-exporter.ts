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
