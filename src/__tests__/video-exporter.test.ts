import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { exportVideo, downloadBlob, isWebCodecsSupported, exportPNGSequence, exportSingleFrame, exportSpriteSheet, exportGIF, exportWebM, exportSVG } from '../video-exporter';
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

      // Export must always produce a valid, non-empty MP4 blob, whether or not
      // the audio codec is available in this environment.
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('video/mp4');
      expect(blob.size).toBeGreaterThan(0);

      // Only assert the audio-encoding stage ran when the AAC codec is actually
      // supported here; otherwise the exporter degrades to video-only.
      const aacSupported =
        typeof AudioEncoder !== 'undefined' &&
        typeof AudioEncoder.isConfigSupported === 'function' &&
        (await AudioEncoder.isConfigSupported({
          codec: 'mp4a.40.2',
          numberOfChannels: 2,
          sampleRate,
          bitrate: 128_000,
        })).supported === true;

      if (aacSupported) {
        expect(progressCalls.some(p => p.stage === 'encoding-audio')).toBe(true);
      } else {
        // Graceful video-only degradation: no audio stage was emitted.
        expect(progressCalls.some(p => p.stage === 'encoding-audio')).toBe(false);
      }

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

      // Export completes with a valid blob whether or not audio is supported.
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

      // Export completes with a valid blob whether or not audio is supported.
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBeGreaterThan(0);

      await audioContext.close();
    });

    it('should gracefully export video-only when audio codec is unsupported', async () => {
      // Force the unsupported-codec path deterministically (the AAC codec IS
      // available on most dev machines, so we stub support detection to false).
      // This is the load-bearing test for the graceful-degradation path: it
      // verifies that a missing audio codec yields a valid video-only file
      // with a warning, instead of an unhandled NotSupportedError crash.
      const audioContext = new AudioContext();
      const sampleRate = audioContext.sampleRate;
      const duration = 0.5;
      const audioBuffer = audioContext.createBuffer(2, Math.ceil(sampleRate * duration), sampleRate);

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
          totalFrames: 6,
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

      // Stub support detection so the AAC codec is reported as unsupported,
      // exercising the degradation guard even on machines where it IS supported.
      const isConfigSupportedSpy = vi
        .spyOn(AudioEncoder, 'isConfigSupported')
        .mockResolvedValue({ supported: false, config: {} } as AudioEncoderSupport);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const progressCalls: { stage: string }[] = [];

        // Must NOT throw — it should degrade to a valid video-only export.
        const blob = await exportVideo(doc, (progress) => {
          progressCalls.push({ stage: progress.stage });
        });

        expect(blob).toBeInstanceOf(Blob);
        expect(blob.type).toBe('video/mp4');
        expect(blob.size).toBeGreaterThan(0);

        // No audio was encoded, so the audio stage must be absent.
        expect(progressCalls.some(p => p.stage === 'encoding-audio')).toBe(false);

        // The degradation is surfaced via a warning (no silent swallowing).
        expect(warnSpy).toHaveBeenCalled();
        expect(
          warnSpy.mock.calls.some(call =>
            String(call[0]).includes('mp4a.40.2')
          )
        ).toBe(true);
      } finally {
        isConfigSupportedSpy.mockRestore();
        warnSpy.mockRestore();
        await audioContext.close();
      }
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

  describe('exportWebM', () => {
    it('should export simple animation to WebM blob', async () => {
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

      const blob = await exportWebM(doc);

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('video/webm');
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

      await exportWebM(doc, (progress) => {
        progressCalls.push({
          currentFrame: progress.currentFrame,
          stage: progress.stage,
        });
      });

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

      await expect(exportWebM(doc, undefined, isCancelled)).rejects.toThrow('Export cancelled');
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

      const blob = await exportWebM(doc);

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBeGreaterThan(0);
    });

    it('should export animation with audio', async () => {
      const audioContext = new AudioContext();
      const sampleRate = audioContext.sampleRate;
      const duration = 0.5;
      const audioBuffer = audioContext.createBuffer(2, Math.ceil(sampleRate * duration), sampleRate);

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
          totalFrames: 6,
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

      const blob = await exportWebM(doc, (progress) => {
        progressCalls.push({ stage: progress.stage });
      });

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('video/webm');
      expect(blob.size).toBeGreaterThan(0);

      // Should have encoding-audio stage
      expect(progressCalls.some(p => p.stage === 'encoding-audio')).toBe(true);

      await audioContext.close();
    });
  });

  describe('exportSVG', () => {
    it('should export frame as SVG blob', async () => {
      const doc = createMinimalDoc({
        width: 100,
        height: 80,
        timelines: [createTimeline({
          totalFrames: 1,
          layers: [createLayer({
            frames: [createFrame({
              duration: 1,
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 10, y: 10 },
                    { type: 'L', x: 90, y: 10 },
                    { type: 'L', x: 90, y: 70 },
                    { type: 'L', x: 10, y: 70 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });

      const blob = await exportSVG(doc, 0);

      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('image/svg+xml');
      expect(blob.size).toBeGreaterThan(0);

      // Verify SVG content
      const text = await blob.text();
      expect(text).toContain('<svg');
      expect(text).toContain('width="100"');
      expect(text).toContain('height="80"');
      expect(text).toContain('<path');
      expect(text).toContain('#FF0000');
    });

    it('should export shape with stroke', async () => {
      const doc = createMinimalDoc({
        width: 100,
        height: 100,
        timelines: [createTimeline({
          totalFrames: 1,
          layers: [createLayer({
            frames: [createFrame({
              duration: 1,
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [],
                strokes: [{ type: 'solid', index: 1, color: '#0000FF', weight: 2 }],
                edges: [{
                  strokeStyle: 1,
                  commands: [
                    { type: 'M', x: 10, y: 10 },
                    { type: 'L', x: 90, y: 90 },
                  ],
                }],
              }],
            })],
          })],
        })],
      });

      const blob = await exportSVG(doc, 0);
      const text = await blob.text();

      expect(text).toContain('stroke="#0000FF"');
      expect(text).toContain('stroke-width="2"');
    });

    it('should handle text elements', async () => {
      const doc = createMinimalDoc({
        width: 200,
        height: 100,
        timelines: [createTimeline({
          totalFrames: 1,
          layers: [createLayer({
            frames: [createFrame({
              duration: 1,
              elements: [{
                type: 'text',
                matrix: createMatrix(),
                left: 10,
                width: 180,
                height: 40,
                textRuns: [{
                  characters: 'Hello World',
                  size: 24,
                  fillColor: '#000000',
                  face: 'Arial',
                }],
              }],
            })],
          })],
        })],
      });

      const blob = await exportSVG(doc, 0);
      const text = await blob.text();

      expect(text).toContain('<text');
      expect(text).toContain('Hello World');
      expect(text).toContain('font-size="24"');
    });

    it('should handle empty document', async () => {
      const doc = createMinimalDoc({
        width: 100,
        height: 100,
        timelines: [createTimeline({
          totalFrames: 1,
          layers: [],
        })],
      });

      const blob = await exportSVG(doc, 0);
      const text = await blob.text();

      expect(text).toContain('<svg');
      expect(text).toContain('width="100"');
    });

    it('should handle linear gradient fill', async () => {
      const doc = createMinimalDoc({
        width: 100,
        height: 100,
        timelines: [createTimeline({
          totalFrames: 1,
          layers: [createLayer({
            frames: [createFrame({
              duration: 1,
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{
                  index: 1,
                  type: 'linear',
                  gradient: [
                    { color: '#FF0000', alpha: 1, ratio: 0 },
                    { color: '#0000FF', alpha: 1, ratio: 1 },
                  ],
                }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 0, y: 0 },
                    { type: 'L', x: 100, y: 0 },
                    { type: 'L', x: 100, y: 100 },
                    { type: 'L', x: 0, y: 100 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });

      const blob = await exportSVG(doc, 0);
      const text = await blob.text();

      expect(text).toContain('<defs>');
      expect(text).toContain('<linearGradient');
      expect(text).toContain('url(#grad_');
    });

    it('should export specific frame', async () => {
      const doc = createMinimalDoc({
        width: 100,
        height: 100,
        timelines: [createTimeline({
          totalFrames: 3,
          layers: [createLayer({
            frames: [
              createFrame({
                index: 0,
                duration: 1,
                elements: [{
                  type: 'shape',
                  matrix: createMatrix(),
                  fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 0 },
                      { type: 'L', x: 50, y: 50 },
                      { type: 'Z' },
                    ],
                  }],
                }],
              }),
              createFrame({
                index: 1,
                duration: 1,
                elements: [{
                  type: 'shape',
                  matrix: createMatrix(),
                  fills: [{ index: 1, type: 'solid', color: '#00FF00' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 25, y: 25 },
                      { type: 'L', x: 75, y: 75 },
                      { type: 'Z' },
                    ],
                  }],
                }],
              }),
              createFrame({
                index: 2,
                duration: 1,
                elements: [{
                  type: 'shape',
                  matrix: createMatrix(),
                  fills: [{ index: 1, type: 'solid', color: '#0000FF' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 50, y: 50 },
                      { type: 'L', x: 100, y: 100 },
                      { type: 'Z' },
                    ],
                  }],
                }],
              }),
            ],
          })],
        })],
      });

      // Export frame 1 (green)
      const blob = await exportSVG(doc, 1);
      const text = await blob.text();

      expect(text).toContain('#00FF00');
      expect(text).not.toContain('#FF0000');
      expect(text).not.toContain('#0000FF');
    });

    it('should render graphic symbol with single frame mode at firstFrame', async () => {
      // Create a symbol with 3 frames (red, green, blue)
      const symbols = new Map();
      symbols.set('TestSymbol', {
        name: 'TestSymbol',
        itemID: 'test-1',
        symbolType: 'graphic' as const,
        timeline: {
          name: 'TestSymbol',
          layers: [{
            name: 'Layer 1',
            color: '#000000',
            visible: true,
            locked: false,
            outline: false,
            frames: [
              {
                index: 0,
                duration: 1,
                keyMode: 9728,
                elements: [{
                  type: 'shape' as const,
                  matrix: createMatrix(),
                  fills: [{ index: 1, type: 'solid' as const, color: '#FF0000' }],
                  strokes: [],
                  edges: [{ fillStyle0: 1, commands: [{ type: 'M' as const, x: 0, y: 0 }, { type: 'L' as const, x: 10, y: 10 }, { type: 'Z' as const }] }],
                }],
              },
              {
                index: 1,
                duration: 1,
                keyMode: 9728,
                elements: [{
                  type: 'shape' as const,
                  matrix: createMatrix(),
                  fills: [{ index: 1, type: 'solid' as const, color: '#00FF00' }],
                  strokes: [],
                  edges: [{ fillStyle0: 1, commands: [{ type: 'M' as const, x: 0, y: 0 }, { type: 'L' as const, x: 10, y: 10 }, { type: 'Z' as const }] }],
                }],
              },
              {
                index: 2,
                duration: 1,
                keyMode: 9728,
                elements: [{
                  type: 'shape' as const,
                  matrix: createMatrix(),
                  fills: [{ index: 1, type: 'solid' as const, color: '#0000FF' }],
                  strokes: [],
                  edges: [{ fillStyle0: 1, commands: [{ type: 'M' as const, x: 0, y: 0 }, { type: 'L' as const, x: 10, y: 10 }, { type: 'Z' as const }] }],
                }],
              },
            ],
          }],
          totalFrames: 3,
          referenceLayers: new Set<number>(),
        },
      });

      const doc = createMinimalDoc({
        width: 100,
        height: 100,
        symbols,
        timelines: [createTimeline({
          totalFrames: 5,
          layers: [createLayer({
            frames: [createFrame({
              index: 0,
              duration: 5,
              elements: [{
                type: 'symbol',
                libraryItemName: 'TestSymbol',
                symbolType: 'graphic',
                matrix: createMatrix(),
                transformationPoint: { x: 0, y: 0 },
                loop: 'single frame',
                firstFrame: 1, // Should show green (frame 1)
              }],
            })],
          })],
        })],
      });

      // Export at frame 3 - should still show green because it's single frame mode at firstFrame=1
      const blob = await exportSVG(doc, 3);
      const text = await blob.text();

      expect(text).toContain('#00FF00'); // Green from symbol's frame 1
      expect(text).not.toContain('#FF0000');
      expect(text).not.toContain('#0000FF');
    });

    it('should render graphic symbol with loop mode advancing with parent timeline', async () => {
      // Create a symbol with 3 frames (red, green, blue)
      const symbols = new Map();
      symbols.set('TestSymbol', {
        name: 'TestSymbol',
        itemID: 'test-1',
        symbolType: 'graphic' as const,
        timeline: {
          name: 'TestSymbol',
          layers: [{
            name: 'Layer 1',
            color: '#000000',
            visible: true,
            locked: false,
            outline: false,
            frames: [
              {
                index: 0,
                duration: 1,
                keyMode: 9728,
                elements: [{
                  type: 'shape' as const,
                  matrix: createMatrix(),
                  fills: [{ index: 1, type: 'solid' as const, color: '#FF0000' }],
                  strokes: [],
                  edges: [{ fillStyle0: 1, commands: [{ type: 'M' as const, x: 0, y: 0 }, { type: 'L' as const, x: 10, y: 10 }, { type: 'Z' as const }] }],
                }],
              },
              {
                index: 1,
                duration: 1,
                keyMode: 9728,
                elements: [{
                  type: 'shape' as const,
                  matrix: createMatrix(),
                  fills: [{ index: 1, type: 'solid' as const, color: '#00FF00' }],
                  strokes: [],
                  edges: [{ fillStyle0: 1, commands: [{ type: 'M' as const, x: 0, y: 0 }, { type: 'L' as const, x: 10, y: 10 }, { type: 'Z' as const }] }],
                }],
              },
              {
                index: 2,
                duration: 1,
                keyMode: 9728,
                elements: [{
                  type: 'shape' as const,
                  matrix: createMatrix(),
                  fills: [{ index: 1, type: 'solid' as const, color: '#0000FF' }],
                  strokes: [],
                  edges: [{ fillStyle0: 1, commands: [{ type: 'M' as const, x: 0, y: 0 }, { type: 'L' as const, x: 10, y: 10 }, { type: 'Z' as const }] }],
                }],
              },
            ],
          }],
          totalFrames: 3,
          referenceLayers: new Set<number>(),
        },
      });

      const doc = createMinimalDoc({
        width: 100,
        height: 100,
        symbols,
        timelines: [createTimeline({
          totalFrames: 6,
          layers: [createLayer({
            frames: [createFrame({
              index: 0,
              duration: 6,
              elements: [{
                type: 'symbol',
                libraryItemName: 'TestSymbol',
                symbolType: 'graphic',
                matrix: createMatrix(),
                transformationPoint: { x: 0, y: 0 },
                loop: 'loop',
                firstFrame: 0,
              }],
            })],
          })],
        })],
      });

      // At frame 0: symbol shows frame 0 (red)
      let blob = await exportSVG(doc, 0);
      let text = await blob.text();
      expect(text).toContain('#FF0000');

      // At frame 1: symbol shows frame 1 (green)
      blob = await exportSVG(doc, 1);
      text = await blob.text();
      expect(text).toContain('#00FF00');

      // At frame 2: symbol shows frame 2 (blue)
      blob = await exportSVG(doc, 2);
      text = await blob.text();
      expect(text).toContain('#0000FF');

      // At frame 3: symbol loops back to frame 0 (red)
      blob = await exportSVG(doc, 3);
      text = await blob.text();
      expect(text).toContain('#FF0000');
    });

    it('should render movieclip at firstFrame regardless of parent timeline', async () => {
      // Create a movieclip symbol with 3 frames
      const symbols = new Map();
      symbols.set('TestClip', {
        name: 'TestClip',
        itemID: 'test-1',
        symbolType: 'movieclip' as const,
        timeline: {
          name: 'TestClip',
          layers: [{
            name: 'Layer 1',
            color: '#000000',
            visible: true,
            locked: false,
            outline: false,
            frames: [
              {
                index: 0,
                duration: 1,
                keyMode: 9728,
                elements: [{
                  type: 'shape' as const,
                  matrix: createMatrix(),
                  fills: [{ index: 1, type: 'solid' as const, color: '#FF0000' }],
                  strokes: [],
                  edges: [{ fillStyle0: 1, commands: [{ type: 'M' as const, x: 0, y: 0 }, { type: 'L' as const, x: 10, y: 10 }, { type: 'Z' as const }] }],
                }],
              },
              {
                index: 1,
                duration: 1,
                keyMode: 9728,
                elements: [{
                  type: 'shape' as const,
                  matrix: createMatrix(),
                  fills: [{ index: 1, type: 'solid' as const, color: '#00FF00' }],
                  strokes: [],
                  edges: [{ fillStyle0: 1, commands: [{ type: 'M' as const, x: 0, y: 0 }, { type: 'L' as const, x: 10, y: 10 }, { type: 'Z' as const }] }],
                }],
              },
            ],
          }],
          totalFrames: 2,
          referenceLayers: new Set<number>(),
        },
      });

      const doc = createMinimalDoc({
        width: 100,
        height: 100,
        symbols,
        timelines: [createTimeline({
          totalFrames: 5,
          layers: [createLayer({
            frames: [createFrame({
              index: 0,
              duration: 5,
              elements: [{
                type: 'symbol',
                libraryItemName: 'TestClip',
                symbolType: 'movieclip',
                matrix: createMatrix(),
                transformationPoint: { x: 0, y: 0 },
                loop: 'loop', // Ignored for movieclips
                firstFrame: 0,
              }],
            })],
          })],
        })],
      });

      // MovieClips always show firstFrame in static SVG export
      // At frame 0, 1, 2, 3, 4 - all should show red (frame 0)
      for (const frameIdx of [0, 1, 2, 3, 4]) {
        const blob = await exportSVG(doc, frameIdx);
        const text = await blob.text();
        expect(text).toContain('#FF0000'); // Always red
        expect(text).not.toContain('#00FF00');
      }
    });

    it('should clamp radial gradient focalPointRatio to keep focus inside the disc', async () => {
      // focalPointRatio=-1 is degenerate (focus on the rim). The SVG export must
      // clamp to -0.98 and emit fx in the gradient's LOCAL (pre-transform) space:
      // -0.98 * 819.2 = -802.816. This mirrors the canvas renderer clamp
      // (renderer.ts createRadialGradient), whose net focal position matches
      // because the SVG <radialGradient> carries gradientTransform = fill matrix.
      const doc = createMinimalDoc({
        width: 100,
        height: 100,
        timelines: [createTimeline({
          totalFrames: 1,
          layers: [createLayer({
            frames: [createFrame({
              duration: 1,
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{
                  index: 1,
                  type: 'radial',
                  focalPointRatio: -1,
                  gradient: [
                    { color: '#FFFFFF', alpha: 1, ratio: 0 },
                    { color: '#000000', alpha: 1, ratio: 1 },
                  ],
                }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 0, y: 0 },
                    { type: 'L', x: 100, y: 0 },
                    { type: 'L', x: 100, y: 100 },
                    { type: 'L', x: 0, y: 100 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });

      const blob = await exportSVG(doc, 0);
      const text = await blob.text();

      expect(text).toContain('<radialGradient');
      // Clamped focal point (-0.98 * 819.2), NOT the raw degenerate -819.2.
      expect(text).toContain('fx="-802.816"');
      expect(text).not.toContain('fx="-819.2"');
      // fy stays 0; the fill matrix (gradientTransform) maps fx/fy into shape space.
      expect(text).toContain('fy="0"');
    });

    it('should convert bitmap-fill matrix from twip-space to pixel-space (÷20)', async () => {
      // XFL bitmap-fill matrices are twip-space (1:1 fill a=d=20, tx/ty twips), but
      // the SVG path draws geometry in pixel space. The patternTransform must be
      // pre-divided by 20: a=d=20,tx=ty=200 -> matrix(1 0 0 1 10 10).
      const png2x2 =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGNkYPhfz8DAwAAACAYBAAF1GxgAAAAASUVORK5CYII=';
      const img = new Image();
      img.src = png2x2;
      await img.decode();

      const bitmaps = new Map();
      bitmaps.set('tile.png', {
        name: 'tile.png',
        href: 'tile.png',
        imageData: img,
        width: 2,
        height: 2,
      });

      const doc = createMinimalDoc({
        width: 100,
        height: 100,
        bitmaps,
        timelines: [createTimeline({
          totalFrames: 1,
          layers: [createLayer({
            frames: [createFrame({
              duration: 1,
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{
                  index: 1,
                  type: 'bitmap',
                  bitmapPath: 'tile.png',
                  matrix: { a: 20, b: 0, c: 0, d: 20, tx: 200, ty: 200 },
                }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 0, y: 0 },
                    { type: 'L', x: 100, y: 0 },
                    { type: 'L', x: 100, y: 100 },
                    { type: 'L', x: 0, y: 100 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });

      const blob = await exportSVG(doc, 0);
      const text = await blob.text();

      expect(text).toContain('<pattern');
      // Twip->pixel converted matrix.
      expect(text).toContain('patternTransform="matrix(1 0 0 1 10 10)"');
      // The raw twip-space matrix must NOT be emitted (the ~20x over-scale bug).
      expect(text).not.toContain('matrix(20 0 0 20 200 200)');
    });

    // --- Filter export (blur / glow / dropShadow / colorMatrix) ---------------
    // Build a doc with ONE graphic symbol (a red shape) carrying `filters`, plus
    // an optional SECOND identical instance to exercise the dedupe cache. These
    // mirror the symbol fixtures above but focus on the <filter> emission.
    const buildFilteredSymbolDoc = (
      filters: import('../types').Filter[],
      instanceCount = 1
    ): import('../types').FLADocument => {
      const symbols = new Map();
      symbols.set('Filtered', {
        name: 'Filtered',
        itemID: 'filt-1',
        symbolType: 'graphic' as const,
        timeline: {
          name: 'Filtered',
          layers: [{
            name: 'Layer 1',
            color: '#000000',
            visible: true,
            locked: false,
            outline: false,
            frames: [{
              index: 0,
              duration: 1,
              keyMode: 9728,
              elements: [{
                type: 'shape' as const,
                matrix: createMatrix(),
                fills: [{ index: 1, type: 'solid' as const, color: '#FF0000' }],
                strokes: [],
                edges: [{ fillStyle0: 1, commands: [
                  { type: 'M' as const, x: 0, y: 0 },
                  { type: 'L' as const, x: 10, y: 10 },
                  { type: 'Z' as const },
                ] }],
              }],
            }],
          }],
          totalFrames: 1,
          referenceLayers: new Set<number>(),
        },
      });

      const instances = Array.from({ length: instanceCount }, () => ({
        type: 'symbol' as const,
        libraryItemName: 'Filtered',
        symbolType: 'graphic' as const,
        matrix: createMatrix(),
        transformationPoint: { x: 0, y: 0 },
        loop: 'single frame' as const,
        firstFrame: 0,
        filters,
      }));

      return createMinimalDoc({
        width: 100,
        height: 100,
        symbols,
        timelines: [createTimeline({
          totalFrames: 1,
          layers: [createLayer({
            frames: [createFrame({ index: 0, duration: 1, elements: instances })],
          })],
        })],
      });
    };

    it('emits a blur <filter> with halved stdDeviation on the symbol group', async () => {
      const doc = buildFilteredSymbolDoc([
        { type: 'blur', blurX: 4, blurY: 4 },
      ]);
      const blob = await exportSVG(doc, 0);
      const text = await blob.text();

      // The symbol <g> references the filter.
      expect(text).toMatch(/<g[^>]*filter="url\(#filter_\d+\)"/);
      // A <filter> def exists.
      expect(text).toContain('<filter id="filter_');
      // Flash blurX=4 -> SVG stdDeviation 2 per axis (÷2 to match CSS blur()).
      expect(text).toContain('<feGaussianBlur in="SourceGraphic" stdDeviation="2 2"/>');
      // Oversized region so blur doesn't clip.
      expect(text).toContain('x="-50%" y="-50%" width="200%" height="200%"');
    });

    it('emits a dropShadow <filter> with offset from distance/angle', async () => {
      const doc = buildFilteredSymbolDoc([
        { type: 'dropShadow', blurX: 6, blurY: 6, color: '#000000', strength: 1, alpha: 1, distance: 4, angle: 45 },
      ]);
      const blob = await exportSVG(doc, 0);
      const text = await blob.text();

      expect(text).toMatch(/<g[^>]*filter="url\(#filter_\d+\)"/);
      // Shadow blur uses max(blurX,blurY)/2 = 3 off SourceAlpha.
      expect(text).toContain('<feGaussianBlur in="SourceAlpha" stdDeviation="3"');
      // distance=4 @ 45deg -> dx=cos(45)*4, dy=sin(45)*4 (both ≈ 2.83; they
      // differ only in the last fp ULP, so compute each separately).
      const angleRad = (45 * Math.PI) / 180;
      const dx = Math.cos(angleRad) * 4; // ~2.8284271247461903
      const dy = Math.sin(angleRad) * 4; // ~2.82842712474619
      expect(dx).toBeCloseTo(2.8284271247461903, 10);
      expect(text).toContain(`<feOffset in="f0" dx="${dx}" dy="${dy}"`);
      // Colored flood composited "in" the shadow alpha, then merged with source.
      expect(text).toContain('flood-color="#000000"');
      expect(text).toContain('operator="in"');
      expect(text).toContain('<feMerge>');
      expect(text).toContain('<feMergeNode in="SourceGraphic"/>');
    });

    it('emits a colorMatrix <filter> with renderer-normalized offsets (÷255)', async () => {
      // AdjustColor-equivalent matrix: identity RGB with a brightness offset of
      // 51 (0-255 scale) on each RGB row. The exporter must divide offsets at
      // indices 4,9,14,19 by 255 (renderer.ts:3624-3634) -> 51/255 = 0.2.
      const matrix = [
        1, 0, 0, 0, 51,
        0, 1, 0, 0, 51,
        0, 0, 1, 0, 51,
        0, 0, 0, 1, 0,
      ];
      const doc = buildFilteredSymbolDoc([{ type: 'colorMatrix', matrix }]);
      const blob = await exportSVG(doc, 0);
      const text = await blob.text();

      expect(text).toMatch(/<g[^>]*filter="url\(#filter_\d+\)"/);
      // Normalized values: offsets 51 -> 0.2, alpha-row offset 0 stays 0.
      expect(text).toContain(
        '<feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0.2 0 1 0 0 0.2 0 0 1 0 0.2 0 0 0 1 0"/>'
      );
    });

    it('dedupes identical filter chains into a single <filter> def', async () => {
      // Two instances with the SAME filter chain must share ONE def.
      const doc = buildFilteredSymbolDoc(
        [{ type: 'blur', blurX: 4, blurY: 4 }],
        2
      );
      const blob = await exportSVG(doc, 0);
      const text = await blob.text();

      // Two group references...
      const refs = text.match(/filter="url\(#filter_\d+\)"/g) || [];
      expect(refs.length).toBe(2);
      // ...but only ONE <filter> def.
      const defsMatched = text.match(/<filter id="filter_\d+"/g) || [];
      expect(defsMatched.length).toBe(1);
      // Both references point at the same id.
      expect(refs[0]).toBe(refs[1]);
    });

    it('skips unsupported filters (bevel) gracefully without throwing', async () => {
      // bevel is intentionally unsupported in SVG export v1 — no primitive, no
      // throw, and (when it is the ONLY filter) no filter attr at all.
      const doc = buildFilteredSymbolDoc([
        {
          type: 'bevel', blurX: 4, blurY: 4, strength: 1,
          highlightColor: '#FFFFFF', shadowColor: '#000000',
          distance: 4, angle: 45,
        },
      ]);
      const blob = await exportSVG(doc, 0);
      const text = await blob.text();

      // The shape still renders.
      expect(text).toContain('#FF0000');
      // No filter emitted for the unsupported bevel.
      expect(text).not.toContain('<filter id="filter_');
      expect(text).not.toMatch(/filter="url\(#filter_\d+\)"/);
    });

    // Build a doc with a single symbol instance carrying an optional blendMode
    // (and optional filters) so we can assert the emitted mix-blend-mode/filter
    // on the symbol <g>. Mirrors buildFilteredSymbolDoc's fixture shape.
    const buildBlendSymbolDoc = (
      blendMode: import('../types').BlendMode | undefined,
      filters?: import('../types').Filter[]
    ): import('../types').FLADocument => {
      const symbols = new Map();
      symbols.set('Blended', {
        name: 'Blended',
        itemID: 'blend-1',
        symbolType: 'graphic' as const,
        timeline: {
          name: 'Blended',
          layers: [{
            name: 'Layer 1',
            color: '#000000',
            visible: true,
            locked: false,
            outline: false,
            frames: [{
              index: 0,
              duration: 1,
              keyMode: 9728,
              elements: [{
                type: 'shape' as const,
                matrix: createMatrix(),
                fills: [{ index: 1, type: 'solid' as const, color: '#FF0000' }],
                strokes: [],
                edges: [{ fillStyle0: 1, commands: [
                  { type: 'M' as const, x: 0, y: 0 },
                  { type: 'L' as const, x: 10, y: 10 },
                  { type: 'Z' as const },
                ] }],
              }],
            }],
          }],
          totalFrames: 1,
          referenceLayers: new Set<number>(),
        },
      });

      const instance: import('../types').SymbolInstance = {
        type: 'symbol' as const,
        libraryItemName: 'Blended',
        symbolType: 'graphic' as const,
        matrix: createMatrix(),
        transformationPoint: { x: 0, y: 0 },
        loop: 'single frame' as const,
        firstFrame: 0,
        ...(blendMode !== undefined ? { blendMode } : {}),
        ...(filters ? { filters } : {}),
      };

      return createMinimalDoc({
        width: 100,
        height: 100,
        symbols,
        timelines: [createTimeline({
          totalFrames: 1,
          layers: [createLayer({
            frames: [createFrame({ index: 0, duration: 1, elements: [instance] })],
          })],
        })],
      });
    };

    it('emits mix-blend-mode:overlay with isolation on the symbol group', async () => {
      const doc = buildBlendSymbolDoc('overlay');
      const blob = await exportSVG(doc, 0);
      const text = await blob.text();

      // The symbol <g> carries the blend style.
      expect(text).toMatch(/<g[^>]*style="mix-blend-mode:overlay;isolation:isolate"/);
      expect(text).toContain('mix-blend-mode:overlay');
      // isolation:isolate is required so it blends against the sibling stack.
      expect(text).toContain('isolation:isolate');
    });

    it("maps Flash 'add' to CSS plus-lighter (canvas 'lighter' equivalent)", async () => {
      const doc = buildBlendSymbolDoc('add');
      const blob = await exportSVG(doc, 0);
      const text = await blob.text();

      expect(text).toContain('mix-blend-mode:plus-lighter');
      expect(text).toMatch(/<g[^>]*style="mix-blend-mode:plus-lighter;isolation:isolate"/);
    });

    it("maps Flash 'lighten' to CSS lighten (real-file value from p0tatomango)", async () => {
      const doc = buildBlendSymbolDoc('lighten');
      const blob = await exportSVG(doc, 0);
      const text = await blob.text();

      expect(text).toContain('mix-blend-mode:lighten');
    });

    it("emits NO mix-blend-mode for blendMode='normal'", async () => {
      const doc = buildBlendSymbolDoc('normal');
      const blob = await exportSVG(doc, 0);
      const text = await blob.text();

      // The shape still renders, but no blend style is emitted (default normal).
      expect(text).toContain('#FF0000');
      expect(text).not.toContain('mix-blend-mode');
    });

    it('emits NO mix-blend-mode when blendMode is unset', async () => {
      const doc = buildBlendSymbolDoc(undefined);
      const blob = await exportSVG(doc, 0);
      const text = await blob.text();

      expect(text).toContain('#FF0000');
      expect(text).not.toContain('mix-blend-mode');
    });

    it("skips blendMode='erase' gracefully (no destination-out equivalent)", async () => {
      // erase maps to canvas destination-out — no CSS mix-blend-mode equivalent.
      // It must be skipped: shape still renders, no blend style emitted, no throw.
      const doc = buildBlendSymbolDoc('erase');
      const blob = await exportSVG(doc, 0);
      const text = await blob.text();

      expect(text).toContain('#FF0000');
      expect(text).not.toContain('mix-blend-mode');
    });

    it('emits BOTH a filter and a blend style without attribute collision', async () => {
      // A symbol with a supported filter AND a blendMode must carry both the
      // filter="url(#...)" attr and the style="mix-blend-mode:..." attr on the
      // same <g> — distinct attributes, no merge/collision.
      const doc = buildBlendSymbolDoc('multiply', [
        { type: 'blur', blurX: 4, blurY: 4 },
      ]);
      const blob = await exportSVG(doc, 0);
      const text = await blob.text();

      // Both attributes present on the symbol group.
      expect(text).toMatch(
        /<g[^>]*filter="url\(#filter_\d+\)"[^>]*style="mix-blend-mode:multiply;isolation:isolate"/
      );
      expect(text).toContain('<filter id="filter_');
      // Exactly one style attribute on that group (no duplicate style= attrs).
      const gTag = text.match(/<g[^>]*filter="url\(#filter_\d+\)"[^>]*>/)?.[0] ?? '';
      expect((gTag.match(/style=/g) || []).length).toBe(1);
    });

    // ---- Mask layer support (shape masks) ----------------------------------
    //
    // Mirrors the parser: a `mask` layer's child layers carry
    // parentLayerIndex = mask index and are reclassified as `masked` with
    // maskLayerIndex = mask index (fla-parser.ts:620-627). The export must emit
    // a <clipPath> from the mask's shape geometry and wrap the masked children
    // in a <g clip-path="url(#...)"> (mirroring renderer.ts:903-968 renderMaskGroup
    // hard nonzero clip). A hidden mask hides the whole group (renderer.ts:874-875).

    // Build a doc: a mask layer (small rect, the clip) above a masked child
    // layer (larger rect, the clipped content). `maskHidden` toggles the cascade
    // case (a hidden mask => whole group omitted).
    const buildMaskDoc = (maskHidden = false) =>
      createMinimalDoc({
        width: 200,
        height: 200,
        timelines: [
          createTimeline({
            totalFrames: 1,
            layers: [
              // index 0: the MASK layer (small 50x50 rect clip in the corner)
              createLayer({
                name: 'MaskLayer',
                layerType: 'mask',
                visible: !maskHidden,
                frames: [
                  createFrame({
                    duration: 1,
                    elements: [
                      {
                        type: 'shape',
                        matrix: createMatrix(),
                        fills: [{ index: 1, type: 'solid', color: '#000000' }],
                        strokes: [],
                        edges: [
                          {
                            fillStyle0: 1,
                            commands: [
                              { type: 'M', x: 0, y: 0 },
                              { type: 'L', x: 50, y: 0 },
                              { type: 'L', x: 50, y: 50 },
                              { type: 'L', x: 0, y: 50 },
                              { type: 'Z' },
                            ],
                          },
                        ],
                      },
                    ],
                  }),
                ],
              }),
              // index 1: the MASKED child layer (large 150x150 red rect)
              createLayer({
                name: 'MaskedChild',
                layerType: 'masked',
                parentLayerIndex: 0,
                maskLayerIndex: 0,
                frames: [
                  createFrame({
                    duration: 1,
                    elements: [
                      {
                        type: 'shape',
                        matrix: createMatrix(),
                        fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
                        strokes: [],
                        edges: [
                          {
                            fillStyle0: 1,
                            commands: [
                              { type: 'M', x: 10, y: 10 },
                              { type: 'L', x: 160, y: 10 },
                              { type: 'L', x: 160, y: 160 },
                              { type: 'L', x: 10, y: 160 },
                              { type: 'Z' },
                            ],
                          },
                        ],
                      },
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      });

    it('emits a <clipPath> from the mask shape and wraps masked children in <g clip-path>', async () => {
      const doc = buildMaskDoc();
      const blob = await exportSVG(doc, 0);
      const text = await blob.text();

      // A clipPath def exists, containing the mask shape's 50x50 geometry.
      const clipMatch = text.match(/<clipPath id="(clip_\d+)">([\s\S]*?)<\/clipPath>/);
      expect(clipMatch).not.toBeNull();
      const clipId = clipMatch![1];
      const clipBody = clipMatch![2];
      // The mask geometry (the 50x50 rect path) is inside the clipPath.
      expect(clipBody).toContain('<path');
      expect(clipBody).toContain('M0 0');
      expect(clipBody).toContain('L50 0');
      // clipPath holds pure geometry — no paint attributes leak in.
      expect(clipBody).not.toContain('fill=');
      expect(clipBody).not.toContain('stroke=');

      // The masked child is wrapped in a <g clip-path="url(#clip_N)"> that
      // references that exact clip, and the red child content lives inside it.
      const wrapMatch = text.match(
        new RegExp(`<g clip-path="url\\(#${clipId}\\)">([\\s\\S]*?)</g>`)
      );
      expect(wrapMatch).not.toBeNull();
      expect(wrapMatch![1]).toContain('#FF0000');

      // The clip-path wrapper is what carries the masked child (load-bearing).
      expect(text).toContain(`clip-path="url(#${clipId})"`);
    });

    it('omits the whole masked group when the mask layer is hidden (cascade)', async () => {
      const doc = buildMaskDoc(/* maskHidden */ true);
      const blob = await exportSVG(doc, 0);
      const text = await blob.text();

      // Hidden mask => no clip emitted and the masked child (#FF0000) is gone.
      expect(text).not.toContain('clip-path');
      expect(text).not.toContain('<clipPath');
      expect(text).not.toContain('#FF0000');
    });

    it('rasterizes the masked child clipped to the mask geometry (pixels)', async () => {
      // Render confirmation: load the exported SVG into an <img>, draw to a
      // canvas, and read pixels. A pixel INSIDE the 50x50 mask shows the red
      // child; a pixel OUTSIDE the mask (but inside the red child) is clipped
      // away (transparent) — matching the renderer's hard nonzero clip.
      const doc = buildMaskDoc();
      // Suppress the opaque white background rect so an OUTSIDE-mask pixel reads
      // as transparent (proving the clip) rather than white background.
      doc.backgroundColor = 'transparent';
      const blob = await exportSVG(doc, 0);
      const svgText = await blob.text();

      const dataUrl =
        'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('SVG image failed to load'));
        img.src = dataUrl;
      });

      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 200;
      const c = canvas.getContext('2d')!;
      c.clearRect(0, 0, 200, 200);
      c.drawImage(img, 0, 0, 200, 200);

      // Inside the 50x50 mask (and inside the red child) => opaque red.
      const inside = c.getImageData(25, 25, 1, 1).data;
      // Outside the mask (100,100) but inside the red child => clipped away.
      const outside = c.getImageData(100, 100, 1, 1).data;

      expect(inside[0]).toBeGreaterThan(200); // red channel high
      expect(inside[3]).toBeGreaterThan(200); // opaque
      expect(outside[3]).toBeLessThan(20);    // clipped => transparent
    });
  });
});
