import type { FLADocument, SoundItem, FrameSound } from './types';
import { FLARenderer } from './renderer';

export interface ExportProgress {
  currentFrame: number;
  totalFrames: number;
  stage: 'encoding' | 'encoding-audio' | 'finalizing';
}

export type ProgressCallback = (progress: ExportProgress) => void;

interface StreamSound {
  sound: FrameSound;
  soundItem: SoundItem;
  startFrame: number;
  duration: number;
}

export async function exportVideo(
  doc: FLADocument,
  onProgress?: ProgressCallback
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
  const renderer = new FLARenderer(canvas as unknown as HTMLCanvasElement);
  await renderer.setDocument(doc);

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

  // Encode each video frame
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
    videoEncoder.encode(frame, { keyFrame: isKeyFrame });

    // Close frame to free memory
    frame.close();

    // Yield to prevent blocking UI
    if (frameIndex % 10 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
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
