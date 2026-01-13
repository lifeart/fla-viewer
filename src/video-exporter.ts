import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { FLADocument } from './types';
import { FLARenderer } from './renderer';

export interface ExportOptions {
  width?: number;
  height?: number;
  frameRate?: number;
  bitrate?: number;
}

export interface ExportProgress {
  currentFrame: number;
  totalFrames: number;
  stage: 'encoding' | 'finalizing';
}

export type ProgressCallback = (progress: ExportProgress) => void;

export async function exportVideo(
  doc: FLADocument,
  onProgress?: ProgressCallback
): Promise<Blob> {
  const width = doc.width;
  const height = doc.height;
  const frameRate = doc.frameRate;
  const totalFrames = doc.timelines[0]?.totalFrames || 1;

  // Create offscreen canvas for rendering
  const canvas = new OffscreenCanvas(width, height);
  const renderer = new FLARenderer(canvas as unknown as HTMLCanvasElement);
  await renderer.setDocument(doc);

  // Calculate frame duration in microseconds
  const frameDurationMicros = Math.round(1_000_000 / frameRate);

  // Create MP4 muxer
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: 'avc',
      width,
      height,
    },
    fastStart: 'in-memory',
  });

  // Create video encoder
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
    },
    error: (e) => {
      console.error('VideoEncoder error:', e);
    },
  });

  // Configure encoder
  encoder.configure({
    codec: 'avc1.42001f', // H.264 Baseline Profile Level 3.1
    width,
    height,
    bitrate: 5_000_000, // 5 Mbps
    framerate: frameRate,
  });

  // Encode each frame
  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
    onProgress?.({
      currentFrame: frameIndex + 1,
      totalFrames,
      stage: 'encoding',
    });

    // Render frame to canvas
    renderer.renderFrame(frameIndex);

    // Create VideoFrame from canvas
    const frame = new VideoFrame(canvas, {
      timestamp: frameIndex * frameDurationMicros,
      duration: frameDurationMicros,
    });

    // Encode frame (keyframe every 30 frames)
    const isKeyFrame = frameIndex % 30 === 0;
    encoder.encode(frame, { keyFrame: isKeyFrame });

    // Close frame to free memory
    frame.close();

    // Yield to prevent blocking UI
    if (frameIndex % 10 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  // Finalize encoding
  onProgress?.({
    currentFrame: totalFrames,
    totalFrames,
    stage: 'finalizing',
  });

  await encoder.flush();
  encoder.close();

  // Finalize muxer
  muxer.finalize();

  // Get the video data
  const { buffer } = muxer.target;
  return new Blob([buffer], { type: 'video/mp4' });
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
    typeof OffscreenCanvas !== 'undefined'
  );
}
