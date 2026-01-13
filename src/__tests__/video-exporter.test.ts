import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { exportVideo, downloadBlob, isWebCodecsSupported } from '../video-exporter';
import type { FLADocument, Timeline, Layer, Frame, Matrix } from '../types';

// Helper to create minimal document structure
function createMinimalDoc(overrides: Partial<FLADocument> = {}): FLADocument {
  return {
    width: 320,
    height: 240,
    frameRate: 24,
    backgroundColor: '#FFFFFF',
    timelines: [],
    symbols: new Map(),
    bitmaps: new Map(),
    sounds: new Map(),
    ...overrides,
  };
}

function createMatrix(overrides: Partial<Matrix> = {}): Matrix {
  return {
    a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0,
    ...overrides,
  };
}

function createTimeline(overrides: Partial<Timeline> = {}): Timeline {
  return {
    name: 'Timeline 1',
    layers: [],
    totalFrames: 1,
    referenceLayers: new Set(),
    ...overrides,
  };
}

function createLayer(overrides: Partial<Layer> = {}): Layer {
  return {
    name: 'Layer 1',
    frames: [],
    ...overrides,
  };
}

function createFrame(overrides: Partial<Frame> = {}): Frame {
  return {
    index: 0,
    duration: 1,
    elements: [],
    ...overrides,
  };
}

describe('video-exporter', () => {
  describe('isWebCodecsSupported', () => {
    it('should return true in modern browser', () => {
      // Chromium supports WebCodecs
      const supported = isWebCodecsSupported();
      expect(typeof supported).toBe('boolean');
      // In headless Chromium, this should be true
      expect(supported).toBe(true);
    });

    it('should check for VideoEncoder', () => {
      expect(typeof VideoEncoder).toBe('function');
    });

    it('should check for VideoFrame', () => {
      expect(typeof VideoFrame).toBe('function');
    });

    it('should check for OffscreenCanvas', () => {
      expect(typeof OffscreenCanvas).toBe('function');
    });

    it('should check for AudioEncoder', () => {
      expect(typeof AudioEncoder).toBe('function');
    });
  });

  describe('downloadBlob', () => {
    let originalCreateObjectURL: typeof URL.createObjectURL;
    let originalRevokeObjectURL: typeof URL.revokeObjectURL;
    let createdUrls: string[] = [];
    let revokedUrls: string[] = [];

    beforeEach(() => {
      originalCreateObjectURL = URL.createObjectURL;
      originalRevokeObjectURL = URL.revokeObjectURL;
      createdUrls = [];
      revokedUrls = [];

      // Track URL creation/revocation
      URL.createObjectURL = vi.fn((blob: Blob) => {
        const url = `blob:test-${createdUrls.length}`;
        createdUrls.push(url);
        return url;
      });

      URL.revokeObjectURL = vi.fn((url: string) => {
        revokedUrls.push(url);
      });
    });

    afterEach(() => {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    });

    it('should create and revoke blob URL', () => {
      const blob = new Blob(['test'], { type: 'video/mp4' });
      downloadBlob(blob, 'test.mp4');

      expect(createdUrls).toHaveLength(1);
      expect(revokedUrls).toHaveLength(1);
      expect(revokedUrls[0]).toBe(createdUrls[0]);
    });

    it('should create anchor element with correct attributes', () => {
      const blob = new Blob(['test'], { type: 'video/mp4' });

      // Spy on anchor clicks
      let clickedAnchor: HTMLAnchorElement | null = null;
      const originalClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function() {
        clickedAnchor = this;
      };

      try {
        downloadBlob(blob, 'animation.mp4');

        expect(clickedAnchor).not.toBeNull();
        expect(clickedAnchor!.download).toBe('animation.mp4');
        expect(clickedAnchor!.href).toContain('blob:');
      } finally {
        HTMLAnchorElement.prototype.click = originalClick;
      }
    });
  });

  describe('exportVideo', () => {
    it('should export simple animation to MP4 blob', async () => {
      const doc = createMinimalDoc({
        width: 160,
        height: 120,
        frameRate: 12,
        timelines: [createTimeline({
          totalFrames: 3,
          layers: [createLayer({
            frames: [createFrame({
              duration: 3,
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{
                  index: 1,
                  color: '#FF0000',
                }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 0, y: 0 },
                    { type: 'L', x: 50, y: 0 },
                    { type: 'L', x: 50, y: 50 },
                    { type: 'L', x: 0, y: 50 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });

      const blob = await exportVideo(doc);

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('video/mp4');
      expect(blob.size).toBeGreaterThan(0);
    });

    it('should call progress callback', async () => {
      const doc = createMinimalDoc({
        width: 80,
        height: 60,
        frameRate: 10,
        timelines: [createTimeline({
          totalFrames: 2,
          layers: [createLayer({
            frames: [createFrame({ duration: 2 })],
          })],
        })],
      });

      const progressCalls: { currentFrame: number; stage: string }[] = [];

      await exportVideo(doc, (progress) => {
        progressCalls.push({
          currentFrame: progress.currentFrame,
          stage: progress.stage,
        });
      });

      // Should have progress for encoding frames
      expect(progressCalls.length).toBeGreaterThan(0);
      expect(progressCalls.some(p => p.stage === 'encoding')).toBe(true);
      expect(progressCalls.some(p => p.stage === 'finalizing')).toBe(true);
    });

    it('should cancel when cancellation check returns true', async () => {
      const doc = createMinimalDoc({
        width: 80,
        height: 60,
        frameRate: 10,
        timelines: [createTimeline({
          totalFrames: 10,
          layers: [createLayer({
            frames: [createFrame({ duration: 10 })],
          })],
        })],
      });

      let frameCount = 0;
      const isCancelled = () => {
        frameCount++;
        return frameCount > 2;
      };

      await expect(exportVideo(doc, undefined, isCancelled)).rejects.toThrow('Export cancelled');
    });

    it('should handle empty timeline', async () => {
      const doc = createMinimalDoc({
        width: 80,
        height: 60,
        frameRate: 10,
        timelines: [createTimeline({
          totalFrames: 1,
          layers: [],
        })],
      });

      const blob = await exportVideo(doc);

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('video/mp4');
    });

    it('should handle single frame animation', async () => {
      const doc = createMinimalDoc({
        width: 80,
        height: 60,
        frameRate: 24,
        timelines: [createTimeline({
          totalFrames: 1,
          layers: [createLayer({
            frames: [createFrame({
              duration: 1,
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#00FF00' }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 10, y: 10 },
                    { type: 'L', x: 70, y: 10 },
                    { type: 'L', x: 70, y: 50 },
                    { type: 'L', x: 10, y: 50 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });

      const blob = await exportVideo(doc);

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBeGreaterThan(0);
    });

    it('should export animation with motion tween', async () => {
      const doc = createMinimalDoc({
        width: 160,
        height: 120,
        frameRate: 12,
        timelines: [createTimeline({
          totalFrames: 5,
          layers: [createLayer({
            frames: [
              createFrame({
                index: 0,
                duration: 4,
                tweenType: 'motion',
                elements: [{
                  type: 'shape',
                  matrix: createMatrix({ tx: 0 }),
                  fills: [{ index: 1, color: '#0000FF' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 0 },
                      { type: 'L', x: 30, y: 0 },
                      { type: 'L', x: 30, y: 30 },
                      { type: 'L', x: 0, y: 30 },
                      { type: 'Z' },
                    ],
                  }],
                }],
              }),
              createFrame({
                index: 4,
                duration: 1,
                elements: [{
                  type: 'shape',
                  matrix: createMatrix({ tx: 100 }),
                  fills: [{ index: 1, color: '#0000FF' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 0 },
                      { type: 'L', x: 30, y: 0 },
                      { type: 'L', x: 30, y: 30 },
                      { type: 'L', x: 0, y: 30 },
                      { type: 'Z' },
                    ],
                  }],
                }],
              }),
            ],
          })],
        })],
      });

      const blob = await exportVideo(doc);

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBeGreaterThan(0);
    });

    it('should export animation with audio', async () => {
      // Create AudioBuffer using AudioContext
      const audioContext = new AudioContext();
      const sampleRate = audioContext.sampleRate;
      const duration = 0.5; // 0.5 second
      const audioBuffer = audioContext.createBuffer(2, Math.ceil(sampleRate * duration), sampleRate);

      // Fill with simple sine wave
      const leftChannel = audioBuffer.getChannelData(0);
      const rightChannel = audioBuffer.getChannelData(1);
      for (let i = 0; i < audioBuffer.length; i++) {
        leftChannel[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate) * 0.5;
        rightChannel[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate) * 0.5;
      }

      const sounds = new Map();
      sounds.set('test.mp3', {
        name: 'test.mp3',
        audioData: audioBuffer,
      });

      const doc = createMinimalDoc({
        width: 80,
        height: 60,
        frameRate: 12,
        sounds,
        timelines: [createTimeline({
          totalFrames: 6, // 0.5 second at 12fps
          layers: [createLayer({
            frames: [createFrame({
              index: 0,
              duration: 6,
              sound: {
                name: 'test.mp3',
                sync: 'stream',
                inPoint44: 0,
              },
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#FF0000' }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 10, y: 10 },
                    { type: 'L', x: 70, y: 10 },
                    { type: 'L', x: 70, y: 50 },
                    { type: 'L', x: 10, y: 50 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });

      const progressCalls: { stage: string }[] = [];

      const blob = await exportVideo(doc, (progress) => {
        progressCalls.push({ stage: progress.stage });
      });

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('video/mp4');
      expect(blob.size).toBeGreaterThan(0);

      // Should have encoding-audio stage
      expect(progressCalls.some(p => p.stage === 'encoding-audio')).toBe(true);

      await audioContext.close();
    });

    it('should handle mono audio', async () => {
      // Create mono AudioBuffer
      const audioContext = new AudioContext();
      const sampleRate = audioContext.sampleRate;
      const duration = 0.25;
      const audioBuffer = audioContext.createBuffer(1, Math.ceil(sampleRate * duration), sampleRate); // mono

      const channel = audioBuffer.getChannelData(0);
      for (let i = 0; i < audioBuffer.length; i++) {
        channel[i] = Math.sin(2 * Math.PI * 880 * i / sampleRate) * 0.3;
      }

      const sounds = new Map();
      sounds.set('mono.mp3', {
        name: 'mono.mp3',
        audioData: audioBuffer,
      });

      const doc = createMinimalDoc({
        width: 80,
        height: 60,
        frameRate: 12,
        sounds,
        timelines: [createTimeline({
          totalFrames: 3,
          layers: [createLayer({
            frames: [createFrame({
              index: 0,
              duration: 3,
              sound: {
                name: 'mono.mp3',
                sync: 'stream',
                inPoint44: 0,
              },
            })],
          })],
        })],
      });

      const blob = await exportVideo(doc);

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBeGreaterThan(0);

      await audioContext.close();
    });

    it('should handle audio with inPoint offset', async () => {
      const audioContext = new AudioContext();
      const sampleRate = audioContext.sampleRate;
      const duration = 1;
      const audioBuffer = audioContext.createBuffer(2, Math.ceil(sampleRate * duration), sampleRate);

      const leftChannel = audioBuffer.getChannelData(0);
      const rightChannel = audioBuffer.getChannelData(1);
      for (let i = 0; i < audioBuffer.length; i++) {
        leftChannel[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate) * 0.5;
        rightChannel[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate) * 0.5;
      }

      const sounds = new Map();
      sounds.set('offset.mp3', {
        name: 'offset.mp3',
        audioData: audioBuffer,
      });

      const doc = createMinimalDoc({
        width: 80,
        height: 60,
        frameRate: 12,
        sounds,
        timelines: [createTimeline({
          totalFrames: 6,
          layers: [createLayer({
            frames: [createFrame({
              index: 0,
              duration: 6,
              sound: {
                name: 'offset.mp3',
                sync: 'stream',
                inPoint44: 22050, // Start at 0.5 seconds (44100/2)
              },
            })],
          })],
        })],
      });

      const blob = await exportVideo(doc);

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBeGreaterThan(0);

      await audioContext.close();
    });
  });
});
