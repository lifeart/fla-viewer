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
    fps: 24,
    currentScene: 0,
    totalScenes: 1,
    sceneName: 'Scene 1',
    globalFrame: 0,
    globalTotalFrames: 1
  };
  private animationId: number | null = null;
  private lastFrameTime: number = 0;
  private onStateChange: ((state: PlayerState) => void) | null = null;
  // Scene frame offsets for calculating global frame position
  private sceneFrameOffsets: number[] = [];

  // Audio playback
  private audioContext: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private activeAudioSource: AudioBufferSourceNode | null = null;
  private streamSounds: StreamSound[] = [];
  private volume: number = 1;
  // Reference point for keeping audio locked to the rendered frame. Audio
  // plays on the realtime audio clock, but the video advances one frame per
  // render tick, so it falls behind under heavy rendering load. We track where
  // the active source started (offset into the buffer + audio-context time at
  // start) so we can detect drift and re-seek the audio back to the frame.
  private activeStream: StreamSound | null = null;
  private audioStartOffset: number = 0;
  private audioStartContextTime: number = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new FLARenderer(canvas);
    // Let the renderer ask for a repaint when an embedded video frame decodes
    // while the timeline is paused (otherwise it would stay on the placeholder).
    this.renderer.setNeedsRedrawCallback(() => this.render());
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

    // Calculate scene frame offsets for global frame navigation
    this.sceneFrameOffsets = [];
    let globalTotalFrames = 0;
    for (const timeline of doc.timelines) {
      this.sceneFrameOffsets.push(globalTotalFrames);
      globalTotalFrames += timeline.totalFrames;
    }

    // Get info from first scene
    const totalScenes = doc.timelines.length;
    const totalFrames = doc.timelines[0]?.totalFrames || 1;
    const sceneName = doc.timelines[0]?.name || 'Scene 1';

    this.state = {
      playing: false,
      currentFrame: 0,
      totalFrames,
      fps: doc.frameRate,
      currentScene: 0,
      totalScenes,
      sceneName,
      globalFrame: 0,
      globalTotalFrames
    };

    // Find stream sounds in the current scene's timeline
    this.findStreamSounds();

    this.render();
    this.notifyStateChange();
  }

  private findStreamSounds(): void {
    this.streamSounds = [];
    if (!this.doc) return;

    const timeline = this.doc.timelines[this.state.currentScene];
    if (!timeline) return;
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
    this.renderer.setPlaying(true);
    this.startAudio();
    this.animate();
    this.notifyStateChange();
  }

  pause(): void {
    this.state.playing = false;
    this.renderer.setPlaying(false);
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
    this.state.globalFrame = 0;
    // Reset to first scene
    if (this.state.currentScene !== 0) {
      this.goToScene(0);
    }
    // Reset MovieClip playheads when stopping
    this.renderer.resetMovieClipPlayheads();
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

    // Remember where playback started so we can keep it aligned to the frame.
    this.activeStream = stream;
    this.audioStartOffset = audioOffset;
    this.audioStartContextTime = this.audioContext.currentTime;
  }

  /**
   * Keep the audio aligned with the rendered frame. The video advances one
   * frame per render tick, so when rendering can't keep up it lags behind the
   * realtime audio clock. Rather than let the sound race ahead, we re-seek the
   * audio back to the current frame's position whenever drift gets audible, so
   * picture and sound lag together.
   */
  private syncAudioToFrame(): void {
    if (!this.audioContext || !this.activeAudioSource || !this.activeStream) return;

    const stream = this.activeStream;
    const fps = Math.max(1, this.state.fps);
    const framesIntoSound = this.state.currentFrame - stream.startFrame;

    // Playhead moved outside this stream's range — stop the sound.
    if (framesIntoSound < 0 || this.state.currentFrame >= stream.startFrame + stream.duration) {
      this.stopAudio();
      return;
    }

    const inPointSeconds = (stream.sound.inPoint44 || 0) / 44100;
    const expectedPos = inPointSeconds + framesIntoSound / fps;
    const actualPos = this.audioStartOffset + (this.audioContext.currentTime - this.audioStartContextTime);

    // Only correct when the audio has run *ahead* of the rendered frame (the
    // render-lag case). Each correction restarts the buffer source, which is an
    // audible discontinuity, so use a generous threshold (~quarter second) and
    // re-seek occasionally rather than many times per second under heavy lag.
    // We never pull the audio forward: the frame can't outrun realtime audio,
    // so a negative drift is noise not worth a clicky restart.
    const drift = actualPos - expectedPos;
    const threshold = Math.max(0.25, 3 / fps);
    if (drift > threshold) {
      this.playStreamSound(stream, this.state.currentFrame);
    }
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
    this.activeStream = null;
  }

  nextFrame(): void {
    this.pause();
    this.state.currentFrame = (this.state.currentFrame + 1) % this.state.totalFrames;
    // Advance MovieClip playheads along with main timeline
    this.renderer.advanceMovieClipPlayheads();
    this.render();
    this.notifyStateChange();
  }

  prevFrame(): void {
    this.pause();
    this.state.currentFrame = (this.state.currentFrame - 1 + this.state.totalFrames) % this.state.totalFrames;
    // Reset MovieClip playheads when going backwards (can't easily reverse independent playheads)
    this.renderer.resetMovieClipPlayheads();
    this.render();
    this.notifyStateChange();
  }

  goToFrame(frame: number): void {
    const wasPlaying = this.state.playing;

    // Stop animation loop while seeking
    if (wasPlaying) {
      this.state.playing = false;
      this.stopAudio();
      if (this.animationId !== null) {
        cancelAnimationFrame(this.animationId);
        this.animationId = null;
      }
    }

    this.state.currentFrame = Math.max(0, Math.min(frame, this.state.totalFrames - 1));
    // Update global frame
    this.state.globalFrame = this.sceneFrameOffsets[this.state.currentScene] + this.state.currentFrame;
    // Reset MovieClip playheads when seeking (accurate state would require full replay)
    this.renderer.resetMovieClipPlayheads();
    this.render();
    this.notifyStateChange();

    // Resume playback if it was playing
    if (wasPlaying) {
      this.play();
    }
  }

  seekToProgress(progress: number): void {
    const frame = Math.floor(progress * (this.state.totalFrames - 1));
    this.goToFrame(frame);
  }

  /**
   * Seek to a global frame position across all scenes.
   */
  seekToGlobalFrame(globalFrame: number): void {
    globalFrame = Math.max(0, Math.min(globalFrame, this.state.globalTotalFrames - 1));

    // Find which scene this global frame belongs to
    let targetScene = 0;
    for (let i = 0; i < this.sceneFrameOffsets.length; i++) {
      const nextOffset = this.sceneFrameOffsets[i + 1] ?? this.state.globalTotalFrames;
      if (globalFrame < nextOffset) {
        targetScene = i;
        break;
      }
    }

    // Switch scene if needed
    if (targetScene !== this.state.currentScene) {
      this.switchToScene(targetScene);
    }

    // Calculate local frame within scene
    const localFrame = globalFrame - this.sceneFrameOffsets[targetScene];
    this.goToFrame(localFrame);
  }

  /**
   * Go to a specific scene by index (0-based).
   */
  goToScene(sceneIndex: number): void {
    if (!this.doc) return;
    if (sceneIndex < 0 || sceneIndex >= this.state.totalScenes) return;

    const wasPlaying = this.state.playing;
    if (wasPlaying) {
      this.pause();
    }

    this.switchToScene(sceneIndex);
    this.state.currentFrame = 0;
    this.state.globalFrame = this.sceneFrameOffsets[sceneIndex];
    this.renderer.resetMovieClipPlayheads();
    this.findStreamSounds();
    this.render();
    this.notifyStateChange();

    if (wasPlaying) {
      this.play();
    }
  }

  /**
   * Go to the next scene. Wraps to first scene if at the end.
   */
  nextScene(): void {
    const nextIndex = (this.state.currentScene + 1) % this.state.totalScenes;
    this.goToScene(nextIndex);
  }

  /**
   * Go to the previous scene. Wraps to last scene if at the beginning.
   */
  prevScene(): void {
    const prevIndex = (this.state.currentScene - 1 + this.state.totalScenes) % this.state.totalScenes;
    this.goToScene(prevIndex);
  }

  /**
   * Get scene names for UI display.
   */
  getSceneNames(): string[] {
    if (!this.doc) return [];
    return this.doc.timelines.map(t => t.name);
  }

  /**
   * Internal: Switch to a different scene without stopping/starting playback.
   */
  private switchToScene(sceneIndex: number): void {
    if (!this.doc) return;
    const timeline = this.doc.timelines[sceneIndex];
    if (!timeline) return;

    this.state.currentScene = sceneIndex;
    this.state.currentFrame = 0;
    this.state.totalFrames = timeline.totalFrames;
    this.state.sceneName = timeline.name;
    this.renderer.setCurrentScene(sceneIndex);
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
      this.state.currentFrame++;
      this.state.globalFrame++;

      // Check if we've reached the end of the current scene
      if (this.state.currentFrame >= this.state.totalFrames) {
        // Move to next scene or loop back to first scene
        if (this.state.currentScene < this.state.totalScenes - 1) {
          // Go to next scene
          this.switchToScene(this.state.currentScene + 1);
        } else {
          // Loop back to first scene
          this.switchToScene(0);
          this.state.globalFrame = 0;
          // Reset MovieClip playheads when looping
          this.renderer.resetMovieClipPlayheads();
        }
        this.startAudio();
      } else {
        // Advance MovieClip playheads along with main timeline
        this.renderer.advanceMovieClipPlayheads();
      }

      this.render();
      // Keep the sound aligned with the (possibly lagging) rendered frame.
      this.syncAudioToFrame();
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

  setHiddenElements(hiddenElements: Map<number, Set<number>>): void {
    this.renderer.setHiddenElements(hiddenElements);
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

  // Clear all caches and force a re-render
  clearCachesAndRender(): void {
    this.renderer.clearCaches();
    this.render();
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

  // Zoom controls
  zoomIn(): void {
    this.renderer.zoomIn();
    this.render();
  }

  zoomOut(): void {
    this.renderer.zoomOut();
    this.render();
  }

  resetZoom(): void {
    this.renderer.resetZoom();
    this.render();
  }

  getZoomLevel(): number {
    return this.renderer.getZoomLevel();
  }

  // Pan controls
  pan(dx: number, dy: number): void {
    this.renderer.pan(dx, dy);
    this.render();
  }

  resetPan(): void {
    this.renderer.resetPan();
    this.render();
  }

  // Reset zoom and pan together with a single re-render
  resetView(): void {
    this.renderer.resetZoom();
    this.renderer.resetPan();
    this.render();
  }

  getPanOffset(): { x: number; y: number } {
    return this.renderer.getPanOffset();
  }
}
