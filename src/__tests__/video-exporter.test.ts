import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { exportVideo, downloadBlob, isWebCodecsSupported, exportPNGSequence, exportSingleFrame, exportSpriteSheet, exportGIF } from '../video-exporter';
import JSZip from 'jszip';
import {
  createMinimalDoc,
  createTimeline,
  createLayer,
  createFrame,
  createMatrix,
} from './test-utils';

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
      URL.createObjectURL = vi.fn((_blob: Blob) => {
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
                  type: 'solid',
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
                fills: [{ index: 1, type: 'solid', color: '#00FF00' }],
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
                  fills: [{ index: 1, type: 'solid', color: '#0000FF' }],
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
                  fills: [{ index: 1, type: 'solid', color: '#0000FF' }],
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
                fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
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

  describe('exportPNGSequence', () => {
    it('should export frames as PNG sequence in ZIP', async () => {
      const doc = createMinimalDoc({
        width: 80,
        height: 60,
        frameRate: 12,
        timelines: [createTimeline({
          totalFrames: 3,
          layers: [createLayer({
            frames: [createFrame({
              duration: 3,
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
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

      const blob = await exportPNGSequence(doc);

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('application/zip');
      expect(blob.size).toBeGreaterThan(0);

      // Verify ZIP contents
      const zip = await JSZip.loadAsync(blob);
      const files = Object.keys(zip.files);
      expect(files).toHaveLength(3);
      expect(files).toContain('frame_00000.png');
      expect(files).toContain('frame_00001.png');
      expect(files).toContain('frame_00002.png');
    });

    it('should support custom frame prefix and padding', async () => {
      const doc = createMinimalDoc({
        width: 40,
        height: 30,
        timelines: [createTimeline({
          totalFrames: 2,
          layers: [createLayer({
            frames: [createFrame({ duration: 2 })],
          })],
        })],
      });

      const blob = await exportPNGSequence(doc, {
        framePrefix: 'img_',
        padLength: 3,
      });

      const zip = await JSZip.loadAsync(blob);
      const files = Object.keys(zip.files);
      expect(files).toContain('img_000.png');
      expect(files).toContain('img_001.png');
    });

    it('should support frame range export', async () => {
      const doc = createMinimalDoc({
        width: 40,
        height: 30,
        timelines: [createTimeline({
          totalFrames: 10,
          layers: [createLayer({
            frames: [createFrame({ duration: 10 })],
          })],
        })],
      });

      const blob = await exportPNGSequence(doc, {
        startFrame: 3,
        endFrame: 6,
      });

      const zip = await JSZip.loadAsync(blob);
      const files = Object.keys(zip.files);
      expect(files).toHaveLength(3);
      expect(files).toContain('frame_00003.png');
      expect(files).toContain('frame_00004.png');
      expect(files).toContain('frame_00005.png');
    });

    it('should call progress callback', async () => {
      const doc = createMinimalDoc({
        width: 40,
        height: 30,
        timelines: [createTimeline({
          totalFrames: 2,
          layers: [createLayer({
            frames: [createFrame({ duration: 2 })],
          })],
        })],
      });

      const progressCalls: { currentFrame: number; totalFrames: number; stage: string }[] = [];
      await exportPNGSequence(doc, {}, (progress) => {
        progressCalls.push({ ...progress });
      });

      expect(progressCalls.length).toBeGreaterThan(0);
      expect(progressCalls.some(p => p.stage === 'rendering')).toBe(true);
      expect(progressCalls.some(p => p.stage === 'zipping')).toBe(true);
    });

    it('should handle cancellation', async () => {
      const doc = createMinimalDoc({
        width: 40,
        height: 30,
        timelines: [createTimeline({
          totalFrames: 5,
          layers: [createLayer({
            frames: [createFrame({ duration: 5 })],
          })],
        })],
      });

      let frameCount = 0;
      await expect(
        exportPNGSequence(doc, {}, () => { frameCount++; }, () => frameCount >= 2)
      ).rejects.toThrow('Export cancelled');
    });
  });

  describe('exportSingleFrame', () => {
    it('should export single frame as PNG', async () => {
      const doc = createMinimalDoc({
        width: 100,
        height: 80,
        timelines: [createTimeline({
          totalFrames: 5,
          layers: [createLayer({
            frames: [createFrame({
              duration: 5,
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, type: 'solid', color: '#00FF00' }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 20, y: 20 },
                    { type: 'L', x: 80, y: 20 },
                    { type: 'L', x: 80, y: 60 },
                    { type: 'L', x: 20, y: 60 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });

      const blob = await exportSingleFrame(doc, 2);

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('image/png');
      expect(blob.size).toBeGreaterThan(0);
    });

    it('should export first frame (frame 0)', async () => {
      const doc = createMinimalDoc({
        width: 50,
        height: 50,
        timelines: [createTimeline({
          totalFrames: 1,
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, type: 'solid', color: '#0000FF' }],
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

      const blob = await exportSingleFrame(doc, 0);

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('image/png');
    });
  });

  describe('exportSpriteSheet', () => {
    it('should export frames as sprite sheet PNG', async () => {
      const doc = createMinimalDoc({
        width: 40,
        height: 30,
        frameRate: 12,
        timelines: [createTimeline({
          totalFrames: 4,
          layers: [createLayer({
            frames: [createFrame({
              duration: 4,
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 5, y: 5 },
                    { type: 'L', x: 35, y: 5 },
                    { type: 'L', x: 35, y: 25 },
                    { type: 'L', x: 5, y: 25 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });

      const result = await exportSpriteSheet(doc);

      expect(result.image).toBeInstanceOf(Blob);
      expect(result.image.type).toBe('image/png');
      expect(result.totalFrames).toBe(4);
      expect(result.frameWidth).toBe(40);
      expect(result.frameHeight).toBe(30);
      // 4 frames should fit in 2x2 grid
      expect(result.columns).toBe(2);
      expect(result.rows).toBe(2);
    });

    it('should include JSON metadata when requested', async () => {
      const doc = createMinimalDoc({
        width: 32,
        height: 32,
        frameRate: 24,
        timelines: [createTimeline({
          totalFrames: 3,
          layers: [createLayer({
            frames: [createFrame({ duration: 3 })],
          })],
        })],
      });

      const result = await exportSpriteSheet(doc, { includeJson: true });

      expect(result.json).toBeDefined();
      const metadata = JSON.parse(result.json!);
      expect(metadata.frames).toBeDefined();
      expect(Object.keys(metadata.frames)).toHaveLength(3);
      expect(metadata.meta.framerate).toBe(24);
      expect(metadata.meta.app).toBe('FLA Viewer');
    });

    it('should support custom column count', async () => {
      const doc = createMinimalDoc({
        width: 20,
        height: 20,
        timelines: [createTimeline({
          totalFrames: 6,
          layers: [createLayer({
            frames: [createFrame({ duration: 6 })],
          })],
        })],
      });

      const result = await exportSpriteSheet(doc, { columns: 3 });

      expect(result.columns).toBe(3);
      expect(result.rows).toBe(2);
    });

    it('should support frame range', async () => {
      const doc = createMinimalDoc({
        width: 20,
        height: 20,
        timelines: [createTimeline({
          totalFrames: 10,
          layers: [createLayer({
            frames: [createFrame({ duration: 10 })],
          })],
        })],
      });

      const result = await exportSpriteSheet(doc, { startFrame: 2, endFrame: 5 });

      expect(result.totalFrames).toBe(3);
    });

    it('should call progress callback', async () => {
      const doc = createMinimalDoc({
        width: 20,
        height: 20,
        timelines: [createTimeline({
          totalFrames: 2,
          layers: [createLayer({
            frames: [createFrame({ duration: 2 })],
          })],
        })],
      });

      const progressCalls: { currentFrame: number; stage: string }[] = [];
      await exportSpriteSheet(doc, {}, (progress) => {
        progressCalls.push({ currentFrame: progress.currentFrame, stage: progress.stage });
      });

      expect(progressCalls.length).toBeGreaterThan(0);
      expect(progressCalls.some(p => p.stage === 'rendering')).toBe(true);
      expect(progressCalls.some(p => p.stage === 'compositing')).toBe(true);
    });

    it('should handle cancellation', async () => {
      const doc = createMinimalDoc({
        width: 20,
        height: 20,
        timelines: [createTimeline({
          totalFrames: 5,
          layers: [createLayer({
            frames: [createFrame({ duration: 5 })],
          })],
        })],
      });

      let frameCount = 0;
      await expect(
        exportSpriteSheet(doc, {}, () => { frameCount++; }, () => frameCount >= 2)
      ).rejects.toThrow('Export cancelled');
    });
  });

  describe('exportGIF', () => {
    it('should export animation as GIF', async () => {
      const doc = createMinimalDoc({
        width: 80,
        height: 60,
        frameRate: 12,
        timelines: [createTimeline({
          totalFrames: 3,
          layers: [createLayer({
            frames: [createFrame({
              duration: 3,
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
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

      const blob = await exportGIF(doc);

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('image/gif');
      expect(blob.size).toBeGreaterThan(0);
    });

    it('should support frame range export', async () => {
      const doc = createMinimalDoc({
        width: 40,
        height: 30,
        frameRate: 10,
        timelines: [createTimeline({
          totalFrames: 10,
          layers: [createLayer({
            frames: [createFrame({ duration: 10 })],
          })],
        })],
      });

      const blob = await exportGIF(doc, { startFrame: 2, endFrame: 5 });

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('image/gif');
    });

    it('should support quality option', async () => {
      const doc = createMinimalDoc({
        width: 40,
        height: 30,
        timelines: [createTimeline({
          totalFrames: 2,
          layers: [createLayer({
            frames: [createFrame({ duration: 2 })],
          })],
        })],
      });

      const highQuality = await exportGIF(doc, { quality: 1 });
      const lowQuality = await exportGIF(doc, { quality: 30 });

      expect(highQuality).toBeInstanceOf(Blob);
      expect(lowQuality).toBeInstanceOf(Blob);
      // Higher quality typically means larger file size due to more colors
      // But this depends on content, so we just check both are valid
      expect(highQuality.type).toBe('image/gif');
      expect(lowQuality.type).toBe('image/gif');
    });

    it('should call progress callback', async () => {
      const doc = createMinimalDoc({
        width: 40,
        height: 30,
        timelines: [createTimeline({
          totalFrames: 2,
          layers: [createLayer({
            frames: [createFrame({ duration: 2 })],
          })],
        })],
      });

      const progressCalls: { currentFrame: number; totalFrames: number; stage: string }[] = [];
      await exportGIF(doc, {}, (progress) => {
        progressCalls.push({ ...progress });
      });

      expect(progressCalls.length).toBeGreaterThan(0);
      expect(progressCalls.some(p => p.stage === 'rendering')).toBe(true);
      expect(progressCalls.some(p => p.stage === 'encoding')).toBe(true);
      expect(progressCalls.some(p => p.stage === 'finalizing')).toBe(true);
    });

    it('should handle cancellation', async () => {
      const doc = createMinimalDoc({
        width: 40,
        height: 30,
        timelines: [createTimeline({
          totalFrames: 5,
          layers: [createLayer({
            frames: [createFrame({ duration: 5 })],
          })],
        })],
      });

      let frameCount = 0;
      await expect(
        exportGIF(doc, {}, () => { frameCount++; }, () => frameCount >= 2)
      ).rejects.toThrow('Export cancelled');
    });

    it('should handle single frame animation', async () => {
      const doc = createMinimalDoc({
        width: 50,
        height: 50,
        frameRate: 24,
        timelines: [createTimeline({
          totalFrames: 1,
          layers: [createLayer({
            frames: [createFrame({
              duration: 1,
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, type: 'solid', color: '#0000FF' }],
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

      const blob = await exportGIF(doc);

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('image/gif');
    });
  });
});
