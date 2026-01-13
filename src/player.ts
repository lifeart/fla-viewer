import type { FLADocument, PlayerState } from './types';
import { FLARenderer } from './renderer';

export class FLAPlayer {
  private renderer: FLARenderer;
  private state: PlayerState = {
    playing: false,
    currentFrame: 0,
    totalFrames: 1,
    fps: 24
  };
  private animationId: number | null = null;
  private lastFrameTime: number = 0;
  private onStateChange: ((state: PlayerState) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new FLARenderer(canvas);
  }

  async setDocument(doc: FLADocument): Promise<void> {
    // Cancel any ongoing animation before setting new document
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

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

    this.render();
    this.notifyStateChange();
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
    this.animate();
    this.notifyStateChange();
  }

  pause(): void {
    this.state.playing = false;
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
    this.state.currentFrame = Math.max(0, Math.min(frame, this.state.totalFrames - 1));
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
      this.state.currentFrame = (this.state.currentFrame + 1) % this.state.totalFrames;
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
}
