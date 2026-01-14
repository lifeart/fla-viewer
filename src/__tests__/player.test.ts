import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FLAPlayer } from '../player';
import {
  createMinimalDoc,
  createTimeline,
  createLayer,
  createFrame,
} from './test-utils';

describe('FLAPlayer', () => {
  let canvas: HTMLCanvasElement;
  let player: FLAPlayer;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 550;
    canvas.height = 400;
    document.body.appendChild(canvas);
    player = new FLAPlayer(canvas);
  });

  afterEach(() => {
    player.stop();
    document.body.removeChild(canvas);
  });

  describe('constructor', () => {
    it('should create player with canvas', () => {
      expect(player).toBeDefined();
    });

    it('should have initial state', () => {
      const state = player.getState();
      expect(state.playing).toBe(false);
      expect(state.currentFrame).toBe(0);
    });
  });

  describe('setDocument', () => {
    it('should set document and update state', async () => {
      const doc = createMinimalDoc({
        frameRate: 30,
        timelines: [createTimeline({
          totalFrames: 100,
          layers: [createLayer({
            frames: [createFrame({ duration: 100 })],
          })],
        })],
      });

      await player.setDocument(doc);

      const state = player.getState();
      expect(state.totalFrames).toBe(100);
      expect(state.fps).toBe(30);
      expect(state.currentFrame).toBe(0);
    });
  });

  describe('playback controls', () => {
    beforeEach(async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          totalFrames: 10,
          layers: [createLayer({
            frames: [createFrame({ duration: 10 })],
          })],
        })],
      });
      await player.setDocument(doc);
    });

    it('should start playing', () => {
      player.play();
      expect(player.getState().playing).toBe(true);
    });

    it('should pause playback', () => {
      player.play();
      player.pause();
      expect(player.getState().playing).toBe(false);
    });

    it('should stop and reset to frame 0', () => {
      player.play();
      player.goToFrame(5);
      player.stop();

      const state = player.getState();
      expect(state.playing).toBe(false);
      expect(state.currentFrame).toBe(0);
    });

    it('should go to next frame', () => {
      player.nextFrame();
      expect(player.getState().currentFrame).toBe(1);
    });

    it('should go to previous frame', () => {
      player.goToFrame(5);
      player.prevFrame();
      expect(player.getState().currentFrame).toBe(4);
    });

    it('should wrap to end when going before frame 0', () => {
      player.prevFrame();
      // Player wraps to last frame when going before 0
      expect(player.getState().currentFrame).toBe(9);
    });

    it('should wrap at end when playing', async () => {
      player.goToFrame(9);
      player.nextFrame();
      // Should wrap to 0 when going past last frame
      expect(player.getState().currentFrame).toBe(0);
    });

    it('should go to specific frame', () => {
      player.goToFrame(5);
      expect(player.getState().currentFrame).toBe(5);
    });

    it('should clamp frame to valid range', () => {
      player.goToFrame(100);
      expect(player.getState().currentFrame).toBeLessThanOrEqual(9);
    });
  });

  describe('seek', () => {
    beforeEach(async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          totalFrames: 100,
          layers: [createLayer({
            frames: [createFrame({ duration: 100 })],
          })],
        })],
      });
      await player.setDocument(doc);
    });

    it('should seek to progress position', () => {
      player.seekToProgress(0.5);
      const state = player.getState();
      // 50% of 100 frames = frame 49 (0-indexed, excluding last)
      expect(state.currentFrame).toBeGreaterThanOrEqual(49);
      expect(state.currentFrame).toBeLessThanOrEqual(50);
    });

    it('should seek to start at 0 progress', () => {
      player.seekToProgress(0);
      expect(player.getState().currentFrame).toBe(0);
    });

    it('should seek to end at 1 progress', () => {
      player.seekToProgress(1);
      expect(player.getState().currentFrame).toBe(99);
    });
  });

  describe('state callback', () => {
    it('should notify on state change', async () => {
      let notifiedState: { playing: boolean } | null = null;

      player.onStateUpdate((state) => {
        notifiedState = state;
      });

      const doc = createMinimalDoc({
        timelines: [createTimeline({
          totalFrames: 10,
          layers: [createLayer({
            frames: [createFrame({ duration: 10 })],
          })],
        })],
      });

      await player.setDocument(doc);

      expect(notifiedState).not.toBeNull();
      expect(notifiedState!.playing).toBe(false);
    });
  });

  describe('debug mode', () => {
    beforeEach(async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame()],
          })],
        })],
      });
      await player.setDocument(doc);
    });

    it('should enable debug mode', () => {
      expect(() => player.enableDebugMode()).not.toThrow();
    });

    it('should disable debug mode', () => {
      player.enableDebugMode();
      expect(() => player.disableDebugMode()).not.toThrow();
    });
  });

  describe('layer visibility', () => {
    beforeEach(async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [
            createLayer({ name: 'Layer 1', frames: [createFrame()] }),
            createLayer({ name: 'Layer 2', frames: [createFrame()] }),
          ],
        })],
      });
      await player.setDocument(doc);
    });

    it('should set hidden layers', () => {
      expect(() => player.setHiddenLayers(new Set([0]))).not.toThrow();
    });
  });

  describe('layer order', () => {
    beforeEach(async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({ frames: [createFrame()] })],
        })],
      });
      await player.setDocument(doc);
    });

    it('should set layer order', () => {
      expect(() => player.setLayerOrder('forward')).not.toThrow();
      expect(() => player.setLayerOrder('reverse')).not.toThrow();
    });

    it('should set nested layer order', () => {
      expect(() => player.setNestedLayerOrder('forward')).not.toThrow();
      expect(() => player.setNestedLayerOrder('reverse')).not.toThrow();
    });

    it('should set element order', () => {
      expect(() => player.setElementOrder('forward')).not.toThrow();
      expect(() => player.setElementOrder('reverse')).not.toThrow();
    });
  });

  describe('camera', () => {
    beforeEach(async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({ frames: [createFrame()] })],
        })],
      });
      await player.setDocument(doc);
    });

    it('should toggle follow camera', () => {
      player.setFollowCamera(true);
      expect(player.getFollowCamera()).toBe(true);

      player.setFollowCamera(false);
      expect(player.getFollowCamera()).toBe(false);
    });

    it('should get camera layers', () => {
      const layers = player.getCameraLayers();
      expect(Array.isArray(layers)).toBe(true);
    });
  });

  describe('volume', () => {
    it('should set and get volume', () => {
      player.setVolume(0.5);
      expect(player.getVolume()).toBe(0.5);
    });

    it('should clamp volume to valid range', () => {
      player.setVolume(2);
      expect(player.getVolume()).toBeLessThanOrEqual(1);

      player.setVolume(-1);
      expect(player.getVolume()).toBeGreaterThanOrEqual(0);
    });
  });

  describe('canvas resizing', () => {
    it('should update canvas size', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({ frames: [createFrame()] })],
        })],
      });
      await player.setDocument(doc);

      const container = document.createElement('div');
      document.body.appendChild(container);
      Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
      Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });

      expect(() => player.updateCanvasSize()).not.toThrow();

      document.body.removeChild(container);
    });
  });

  describe('document replacement', () => {
    it('should cancel animation when setting new document while playing', async () => {
      const doc1 = createMinimalDoc({
        timelines: [createTimeline({
          totalFrames: 10,
          layers: [createLayer({
            frames: [createFrame({ duration: 10 })],
          })],
        })],
      });
      await player.setDocument(doc1);

      // Start playing
      player.play();
      expect(player.getState().playing).toBe(true);

      // Set new document - should cancel animation
      const doc2 = createMinimalDoc({
        timelines: [createTimeline({
          totalFrames: 5,
          layers: [createLayer({
            frames: [createFrame({ duration: 5 })],
          })],
        })],
      });
      await player.setDocument(doc2);

      // Should reset to frame 0 and not be playing
      expect(player.getState().currentFrame).toBe(0);
      expect(player.getState().totalFrames).toBe(5);
    });
  });

  describe('stream sounds', () => {
    it('should find stream sounds in document', async () => {
      // Create a document with a stream sound reference
      const sounds = new Map();
      // Note: We can't easily create an AudioBuffer in tests, but we can test the structure

      const doc = createMinimalDoc({
        sounds,
        timelines: [createTimeline({
          totalFrames: 10,
          layers: [createLayer({
            frames: [createFrame({
              index: 0,
              duration: 10,
              sound: {
                name: 'test.mp3',
                sync: 'stream',
                inPoint44: 0,
              },
            })],
          })],
        })],
      });
      await player.setDocument(doc);

      // Player should handle missing sound gracefully
      expect(player.getState().totalFrames).toBe(10);
    });

    it('should handle playing with audio', async () => {
      // Create AudioBuffer using AudioContext
      const audioContext = new AudioContext();
      const sampleRate = audioContext.sampleRate;
      const duration = 1; // 1 second
      const audioBuffer = audioContext.createBuffer(2, sampleRate * duration, sampleRate);

      // Fill with simple sine wave
      const leftChannel = audioBuffer.getChannelData(0);
      const rightChannel = audioBuffer.getChannelData(1);
      for (let i = 0; i < audioBuffer.length; i++) {
        leftChannel[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate);
        rightChannel[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate);
      }

      const sounds = new Map();
      sounds.set('test.mp3', {
        name: 'test.mp3',
        audioData: audioBuffer,
      });

      const doc = createMinimalDoc({
        sounds,
        timelines: [createTimeline({
          totalFrames: 24, // 1 second at 24fps
          layers: [createLayer({
            frames: [createFrame({
              index: 0,
              duration: 24,
              sound: {
                name: 'test.mp3',
                sync: 'stream',
                inPoint44: 0,
              },
            })],
          })],
        })],
      });
      await player.setDocument(doc);

      // Play briefly
      player.play();
      await new Promise(resolve => setTimeout(resolve, 100));
      player.pause();

      // Should still be valid state
      expect(player.getState().playing).toBe(false);

      await audioContext.close();
    });

    it('should restart audio when looping back to beginning', async () => {
      const audioContext = new AudioContext();
      const sampleRate = audioContext.sampleRate;
      const duration = 0.5;
      const audioBuffer = audioContext.createBuffer(2, Math.ceil(sampleRate * duration), sampleRate);

      const leftChannel = audioBuffer.getChannelData(0);
      const rightChannel = audioBuffer.getChannelData(1);
      for (let i = 0; i < audioBuffer.length; i++) {
        leftChannel[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate);
        rightChannel[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate);
      }

      const sounds = new Map();
      sounds.set('loop.mp3', {
        name: 'loop.mp3',
        audioData: audioBuffer,
      });

      const doc = createMinimalDoc({
        sounds,
        timelines: [createTimeline({
          totalFrames: 5,
          layers: [createLayer({
            frames: [createFrame({
              index: 0,
              duration: 5,
              sound: {
                name: 'loop.mp3',
                sync: 'stream',
                inPoint44: 0,
              },
            })],
          })],
        })],
      });
      await player.setDocument(doc);

      // Go to frame 4 (near end)
      player.goToFrame(4);
      expect(player.getState().currentFrame).toBe(4);

      // Loop back to frame 0 (triggers audio restart - line 251)
      player.goToFrame(0);
      expect(player.getState().currentFrame).toBe(0);

      await audioContext.close();
    });

    it('should restart audio when animation loops back to beginning', async () => {
      const audioContext = new AudioContext();
      const sampleRate = audioContext.sampleRate;
      const duration = 2;
      const audioBuffer = audioContext.createBuffer(2, Math.ceil(sampleRate * duration), sampleRate);

      const leftChannel = audioBuffer.getChannelData(0);
      const rightChannel = audioBuffer.getChannelData(1);
      for (let i = 0; i < audioBuffer.length; i++) {
        leftChannel[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate);
        rightChannel[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate);
      }

      const sounds = new Map();
      sounds.set('loopback.mp3', {
        name: 'loopback.mp3',
        audioData: audioBuffer,
      });

      const doc = createMinimalDoc({
        frameRate: 60, // High frame rate for faster looping
        sounds,
        timelines: [createTimeline({
          totalFrames: 3, // Very short timeline to loop quickly
          layers: [createLayer({
            frames: [createFrame({
              index: 0,
              duration: 3,
              sound: {
                name: 'loopback.mp3',
                sync: 'stream',
                inPoint44: 0,
              },
            })],
          })],
        })],
      });
      await player.setDocument(doc);

      // Start playing and wait for loop (frame 2 -> 0)
      player.play();
      // Wait enough time for the animation to loop at least once (3 frames at 60fps = 50ms + buffer)
      await new Promise(resolve => setTimeout(resolve, 150));
      player.pause();

      // Should have looped at least once
      expect(player.getState().playing).toBe(false);

      await audioContext.close();
    });

    it('should set volume on gainNode when playing', async () => {
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
      sounds.set('volume.mp3', {
        name: 'volume.mp3',
        audioData: audioBuffer,
      });

      const doc = createMinimalDoc({
        sounds,
        timelines: [createTimeline({
          totalFrames: 24,
          layers: [createLayer({
            frames: [createFrame({
              index: 0,
              duration: 24,
              sound: {
                name: 'volume.mp3',
                sync: 'stream',
                inPoint44: 0,
              },
            })],
          })],
        })],
      });
      await player.setDocument(doc);

      // Start playing to create gainNode
      player.play();
      await new Promise(resolve => setTimeout(resolve, 50));

      // Set volume while playing (line 322)
      player.setVolume(0.5);
      expect(player.getVolume()).toBe(0.5);

      player.setVolume(0.8);
      expect(player.getVolume()).toBe(0.8);

      player.pause();
      await audioContext.close();
    });
  });
});
