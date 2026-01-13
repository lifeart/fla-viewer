import type { FLADocument, PlayerState, FrameSound, SoundItem } from './types';
import { FLARenderer } from './renderer';

interface StreamSound {
  sound: FrameSound;
  soundItem: SoundItem;
  startFrame: number;
  duration: number; // in frames
}

export class FLAPlayer {
  private renderer: FLARenderer;
  private doc: FLADocument | null = null;
  private state: PlayerState = {
    playing: false,
    currentFrame: 0,
    totalFrames: 1,
    fps: 24
  };
  private animationId: number | null = null;
  private lastFrameTime: number = 0;
  private onStateChange: ((state: PlayerState) => void) | null = null;

  // Audio playback
  private audioContext: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private activeAudioSource: AudioBufferSourceNode | null = null;
  private streamSounds: StreamSound[] = [];
  private volume: number = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new FLARenderer(canvas);
  }

  async setDocument(doc: FLADocument): Promise<void> {
    // Cancel any ongoing animation before setting new document
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    // Stop any playing audio
    this.stopAudio();

    this.doc = doc;

    // Wait for renderer to set up document (including font preloading)
    await this.renderer.setDocument(doc);

    // Get total frames from main timeline
    const totalFrames = doc.timelines[0]?.totalFrames || 1;

    this.state = {
      playing: false,
      currentFrame: 0,
      totalFrames,
      fps: doc.frameRate
    };

    // Find stream sounds in the timeline
    this.findStreamSounds();

    this.render();
    this.notifyStateChange();
  }

  private findStreamSounds(): void {
    this.streamSounds = [];
    if (!this.doc || !this.doc.timelines[0]) return;

    const timeline = this.doc.timelines[0];
    for (const layer of timeline.layers) {
      for (const frame of layer.frames) {
        if (frame.sound && frame.sound.sync === 'stream') {
          const soundItem = this.doc.sounds.get(frame.sound.name);
          if (soundItem && soundItem.audioData) {
            this.streamSounds.push({
              sound: frame.sound,
              soundItem,
              startFrame: frame.index,
              duration: frame.duration
            });
          }
        }
      }
    }
  }

  onStateUpdate(callback: (state: PlayerState) => void): void {
    this.onStateChange = callback;
  }

  getState(): PlayerState {
    return { ...this.state };
  }

  play(): void {
    if (this.state.playing) return;

    this.state.playing = true;
    this.lastFrameTime = performance.now();
    this.startAudio();
    this.animate();
    this.notifyStateChange();
  }

  pause(): void {
    this.state.playing = false;
    this.stopAudio();
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.notifyStateChange();
  }

  stop(): void {
    this.pause();
    this.state.currentFrame = 0;
    this.render();
    this.notifyStateChange();
  }

  private startAudio(): void {
    if (this.streamSounds.length === 0) return;

    // Initialize AudioContext on first use (requires user interaction)
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = this.volume;
      this.gainNode.connect(this.audioContext.destination);
    }

    // Resume context if suspended (autoplay policy)
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }

    // Find stream sound that covers current frame
    const currentFrame = this.state.currentFrame;
    for (const stream of this.streamSounds) {
      const endFrame = stream.startFrame + stream.duration;
      if (currentFrame >= stream.startFrame && currentFrame < endFrame) {
        this.playStreamSound(stream, currentFrame);
        break;
      }
    }
  }

  private playStreamSound(stream: StreamSound, fromFrame: number): void {
    if (!this.audioContext || !stream.soundItem.audioData) return;

    // Stop any currently playing audio
    this.stopAudio();

    const audioBuffer = stream.soundItem.audioData;
    const fps = this.state.fps;

    // Calculate audio start position
    // inPoint44 is the start offset in the original audio (in samples at 44kHz)
    const inPointSeconds = (stream.sound.inPoint44 || 0) / 44100;

    // Calculate how far into the sound we should be based on current frame
    const framesIntoSound = fromFrame - stream.startFrame;
    const timeIntoSound = framesIntoSound / fps;

    const audioOffset = inPointSeconds + timeIntoSound;

    // Don't play if offset is beyond the audio
    if (audioOffset >= audioBuffer.duration) return;

    // Create source and play through gain node
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.gainNode!);
    this.activeAudioSource = source;

    source.start(0, audioOffset);
  }

  private stopAudio(): void {
    if (this.activeAudioSource) {
      try {
        this.activeAudioSource.stop();
      } catch {
        // Ignore errors if already stopped
      }
      this.activeAudioSource = null;
    }
  }

  nextFrame(): void {
    this.pause();
    this.state.currentFrame = (this.state.currentFrame + 1) % this.state.totalFrames;
    this.render();
    this.notifyStateChange();
  }

  prevFrame(): void {
    this.pause();
    this.state.currentFrame = (this.state.currentFrame - 1 + this.state.totalFrames) % this.state.totalFrames;
    this.render();
    this.notifyStateChange();
  }

  goToFrame(frame: number): void {
    const wasPlaying = this.state.playing;
    this.state.currentFrame = Math.max(0, Math.min(frame, this.state.totalFrames - 1));

    // Restart audio at new position if playing
    if (wasPlaying) {
      this.startAudio();
    }

    this.render();
    this.notifyStateChange();
  }

  seekToProgress(progress: number): void {
    const frame = Math.floor(progress * (this.state.totalFrames - 1));
    this.goToFrame(frame);
  }

  private animate = (): void => {
    if (!this.state.playing) return;

    const now = performance.now();
    const elapsed = now - this.lastFrameTime;
    // Guard against fps <= 0 which would cause division by zero or negative intervals
    const fps = Math.max(1, this.state.fps);
    const frameInterval = 1000 / fps;

    if (elapsed >= frameInterval) {
      this.lastFrameTime = now - (elapsed % frameInterval);
      const prevFrame = this.state.currentFrame;
      this.state.currentFrame = (this.state.currentFrame + 1) % this.state.totalFrames;

      // Restart audio when looping back to beginning
      if (this.state.currentFrame < prevFrame) {
        this.startAudio();
      }

      this.render();
      this.notifyStateChange();
    }

    this.animationId = requestAnimationFrame(this.animate);
  };

  private render(): void {
    this.renderer.renderFrame(this.state.currentFrame);
  }

  private notifyStateChange(): void {
    if (this.onStateChange) {
      this.onStateChange(this.getState());
    }
  }

  enableDebugMode(): void {
    this.renderer.enableDebugMode();
    // Re-render current frame to populate debug elements
    this.render();
  }

  disableDebugMode(): void {
    this.renderer.disableDebugMode();
  }

  setHiddenLayers(hiddenLayers: Set<number>): void {
    this.renderer.setHiddenLayers(hiddenLayers);
    this.render();
  }

  setLayerOrder(order: 'forward' | 'reverse'): void {
    this.renderer.setLayerOrder(order);
    this.render();
  }

  setNestedLayerOrder(order: 'forward' | 'reverse'): void {
    this.renderer.setNestedLayerOrder(order);
    this.render();
  }

  setElementOrder(order: 'forward' | 'reverse'): void {
    this.renderer.setElementOrder(order);
    this.render();
  }

  setFollowCamera(enabled: boolean): void {
    this.renderer.setFollowCamera(enabled);
    this.render();
  }

  getFollowCamera(): boolean {
    return this.renderer.getFollowCamera();
  }

  getCameraLayers(): { index: number; name: string }[] {
    return this.renderer.getCameraLayers();
  }

  updateCanvasSize(): void {
    this.renderer.updateCanvasSize();
    this.render();
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.gainNode) {
      this.gainNode.gain.value = this.volume;
    }
  }

  getVolume(): number {
    return this.volume;
  }
}
