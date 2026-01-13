import { FLAParser } from './fla-parser';
import { FLAPlayer } from './player';
import { exportVideo, downloadBlob, isWebCodecsSupported } from './video-exporter';
import type { PlayerState, FLADocument } from './types';

class FLAViewerApp {
  private parser: FLAParser;
  private player: FLAPlayer | null = null;
  private currentDoc: FLADocument | null = null;

  // DOM elements
  private dropZone: HTMLElement;
  private fileInput: HTMLInputElement;
  private loading: HTMLElement;
  private viewer: HTMLElement;
  private canvas: HTMLCanvasElement;
  private playBtn: HTMLButtonElement;
  private stopBtn: HTMLButtonElement;
  private prevBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private debugBtn: HTMLButtonElement;
  private muteBtn: HTMLButtonElement;
  private volumeSlider: HTMLInputElement;
  private fullscreenBtn: HTMLButtonElement;
  private timeline: HTMLElement;
  private timelineProgress: HTMLElement;
  private frameInfo: HTMLElement;
  private infoPanel: HTMLElement;
  private debugPanel: HTMLElement;
  private layerList: HTMLElement;
  private layerOrderSelect: HTMLSelectElement;
  private nestedOrderSelect: HTMLSelectElement;
  private elementOrderSelect: HTMLSelectElement;
  private followCameraCheckbox: HTMLInputElement;
  private cameraLayerInfo: HTMLElement;
  private videoControls: HTMLElement;
  private audioControls: HTMLElement;
  private loadingText: HTMLElement;
  private downloadBtn: HTMLButtonElement;
  private exportModal: HTMLElement;
  private exportProgressFill: HTMLElement;
  private exportStatus: HTMLElement;
  private exportCancelBtn: HTMLButtonElement;
  private exportCancelled: boolean = false;
  private currentFileName: string = 'animation';

  constructor() {
    this.parser = new FLAParser();

    // Get DOM elements
    this.dropZone = document.getElementById('drop-zone')!;
    this.fileInput = document.getElementById('file-input') as HTMLInputElement;
    this.loading = document.getElementById('loading')!;
    this.viewer = document.getElementById('viewer')!;
    this.canvas = document.getElementById('stage') as HTMLCanvasElement;
    this.playBtn = document.getElementById('play-btn') as HTMLButtonElement;
    this.stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;
    this.prevBtn = document.getElementById('prev-btn') as HTMLButtonElement;
    this.nextBtn = document.getElementById('next-btn') as HTMLButtonElement;
    this.debugBtn = document.getElementById('debug-btn') as HTMLButtonElement;
    this.muteBtn = document.getElementById('mute-btn') as HTMLButtonElement;
    this.volumeSlider = document.getElementById('volume-slider') as HTMLInputElement;
    this.fullscreenBtn = document.getElementById('fullscreen-btn') as HTMLButtonElement;
    this.timeline = document.getElementById('timeline')!;
    this.timelineProgress = document.getElementById('timeline-progress')!;
    this.frameInfo = document.getElementById('frame-info')!;
    this.infoPanel = document.getElementById('info-panel')!;
    this.debugPanel = document.getElementById('debug-panel')!;
    this.layerList = document.getElementById('layer-list')!;
    this.layerOrderSelect = document.getElementById('layer-order-select') as HTMLSelectElement;
    this.nestedOrderSelect = document.getElementById('nested-order-select') as HTMLSelectElement;
    this.elementOrderSelect = document.getElementById('element-order-select') as HTMLSelectElement;
    this.followCameraCheckbox = document.getElementById('follow-camera-checkbox') as HTMLInputElement;
    this.cameraLayerInfo = document.getElementById('camera-layer-info')!;
    this.videoControls = document.getElementById('video-controls')!;
    this.audioControls = document.getElementById('audio-controls')!;
    this.loadingText = document.getElementById('loading-text')!;
    this.downloadBtn = document.getElementById('download-btn') as HTMLButtonElement;
    this.exportModal = document.getElementById('export-modal')!;
    this.exportProgressFill = document.getElementById('export-progress-fill')!;
    this.exportStatus = document.getElementById('export-status')!;
    this.exportCancelBtn = document.getElementById('export-cancel-btn') as HTMLButtonElement;

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    // File drop zone
    this.dropZone.addEventListener('click', () => this.fileInput.click());
    this.dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.dropZone.classList.add('dragover');
    });
    this.dropZone.addEventListener('dragleave', () => {
      this.dropZone.classList.remove('dragover');
    });
    this.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      this.dropZone.classList.remove('dragover');
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        this.loadFile(files[0]);
      }
    });

    // File input
    this.fileInput.addEventListener('change', () => {
      const files = this.fileInput.files;
      if (files && files.length > 0) {
        this.loadFile(files[0]);
      }
    });

    // Player controls
    this.playBtn.addEventListener('click', () => this.togglePlay());
    this.stopBtn.addEventListener('click', () => this.player?.stop());
    this.prevBtn.addEventListener('click', () => this.player?.prevFrame());
    this.nextBtn.addEventListener('click', () => this.player?.nextFrame());
    this.debugBtn.addEventListener('click', () => this.toggleDebug());

    // Audio controls
    this.muteBtn.addEventListener('click', () => this.toggleMute());
    this.volumeSlider.addEventListener('input', () => this.updateVolume());

    // Fullscreen
    this.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
    document.addEventListener('fullscreenchange', () => this.updateFullscreenButton());

    // Download/Export
    this.downloadBtn.addEventListener('click', () => this.startExport());
    this.exportCancelBtn.addEventListener('click', () => this.cancelExport());

    // Timeline scrubbing
    this.timeline.addEventListener('click', (e) => {
      const rect = this.timeline.getBoundingClientRect();
      const progress = (e.clientX - rect.left) / rect.width;
      this.player?.seekToProgress(progress);
    });

    // Layer order change
    this.layerOrderSelect.addEventListener('change', () => {
      this.player?.setLayerOrder(this.layerOrderSelect.value as 'forward' | 'reverse');
      this.populateLayerList();
    });

    // Nested layer order change
    this.nestedOrderSelect.addEventListener('change', () => {
      this.player?.setNestedLayerOrder(this.nestedOrderSelect.value as 'forward' | 'reverse');
    });

    // Element order change
    this.elementOrderSelect.addEventListener('change', () => {
      this.player?.setElementOrder(this.elementOrderSelect.value as 'forward' | 'reverse');
    });

    // Follow camera toggle
    this.followCameraCheckbox.addEventListener('change', () => {
      this.player?.setFollowCamera(this.followCameraCheckbox.checked);
    });

    // Window resize handler
    let resizeTimeout: number | null = null;
    window.addEventListener('resize', () => {
      // Debounce resize events
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      resizeTimeout = window.setTimeout(() => {
        this.player?.updateCanvasSize();
        resizeTimeout = null;
      }, 100);
    });

    // Keyboard controls
    document.addEventListener('keydown', (e) => {
      if (!this.player) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          this.togglePlay();
          break;
        case 'ArrowLeft':
          this.player.prevFrame();
          break;
        case 'ArrowRight':
          this.player.nextFrame();
          break;
        case 'Home':
          this.player.goToFrame(0);
          break;
        case 'End':
          this.player.goToFrame(this.player.getState().totalFrames - 1);
          break;
        case 'd':
        case 'D':
          this.toggleDebug();
          break;
        case 'm':
        case 'M':
          this.toggleMute();
          break;
        case 'f':
        case 'F':
          this.toggleFullscreen();
          break;
      }
    });
  }

  private debugMode: boolean = false;
  private hiddenLayers: Set<number> = new Set();
  private isMuted: boolean = false;
  private lastVolume: number = 100;

  // Audio icons
  private volumeIcon = '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
  private mutedIcon = '<svg viewBox="0 0 24 24"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>';
  private fullscreenIcon = '<svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';
  private exitFullscreenIcon = '<svg viewBox="0 0 24 24"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>';

  private toggleMute(): void {
    this.isMuted = !this.isMuted;
    if (this.isMuted) {
      this.lastVolume = parseInt(this.volumeSlider.value);
      this.volumeSlider.value = '0';
      this.muteBtn.classList.add('muted');
    } else {
      this.volumeSlider.value = String(this.lastVolume);
      this.muteBtn.classList.remove('muted');
    }
    this.updateVolume();
    this.updateMuteButton();
  }

  private updateMuteButton(): void {
    this.muteBtn.innerHTML = this.isMuted ? this.mutedIcon : this.volumeIcon;
  }

  private updateVolume(): void {
    const volume = parseInt(this.volumeSlider.value) / 100;
    this.player?.setVolume(volume);

    // Update muted state based on slider
    if (volume === 0 && !this.isMuted) {
      this.isMuted = true;
      this.muteBtn.classList.add('muted');
      this.updateMuteButton();
    } else if (volume > 0 && this.isMuted) {
      this.isMuted = false;
      this.muteBtn.classList.remove('muted');
      this.updateMuteButton();
    }
  }

  private toggleFullscreen(): void {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      this.viewer.requestFullscreen();
    }
  }

  private updateFullscreenButton(): void {
    this.fullscreenBtn.innerHTML = document.fullscreenElement
      ? this.exitFullscreenIcon
      : this.fullscreenIcon;
  }

  private toggleDebug(): void {
    if (!this.player) return;

    this.debugMode = !this.debugMode;
    if (this.debugMode) {
      this.player.enableDebugMode();
      this.debugBtn.classList.add('active');
      this.debugPanel.classList.add('active');
      this.populateLayerList();
    } else {
      this.player.disableDebugMode();
      this.debugBtn.classList.remove('active');
      this.debugPanel.classList.remove('active');
    }
  }

  private populateLayerList(): void {
    if (!this.currentDoc || !this.currentDoc.timelines[0]) return;

    const layers = this.currentDoc.timelines[0].layers;
    const isReverse = this.layerOrderSelect.value === 'reverse';

    this.layerList.innerHTML = '';

    // Update camera layer info
    this.updateCameraInfo();

    // Create layer items in render order
    const indices = isReverse
      ? [...Array(layers.length).keys()].reverse()
      : [...Array(layers.length).keys()];

    let renderOrder = 1;
    for (const i of indices) {
      const layer = layers[i];
      const div = document.createElement('div');
      div.className = 'layer-item';
      if (layer.layerType === 'folder') div.className += ' folder';
      if (layer.layerType === 'guide') div.className += ' guide';

      const isRenderable = layer.layerType !== 'guide' && layer.layerType !== 'folder';
      const orderNum = isRenderable ? renderOrder++ : '-';

      div.innerHTML = `
        <input type="checkbox" ${this.hiddenLayers.has(i) ? '' : 'checked'} data-layer="${i}" ${!isRenderable ? 'disabled' : ''}>
        <span class="layer-index">${i}</span>
        <span class="layer-color" style="background: ${layer.color}"></span>
        <span class="layer-name">${layer.name}</span>
        ${layer.parentLayerIndex !== undefined ? `<span class="layer-parent">(${layer.parentLayerIndex})</span>` : ''}
        ${isRenderable ? `<span class="render-order">${orderNum}</span>` : ''}
      `;

      const checkbox = div.querySelector('input') as HTMLInputElement;
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          this.hiddenLayers.delete(i);
        } else {
          this.hiddenLayers.add(i);
        }
        this.player?.setHiddenLayers(this.hiddenLayers);
      });

      this.layerList.appendChild(div);
    }
  }

  private updateCameraInfo(): void {
    if (!this.player) {
      this.cameraLayerInfo.textContent = '';
      return;
    }

    const cameraLayers = this.player.getCameraLayers();
    if (cameraLayers.length > 0) {
      const names = cameraLayers.map(l => `"${l.name}"`).join(', ');
      this.cameraLayerInfo.textContent = `Found: ${names}`;
      this.followCameraCheckbox.disabled = false;
    } else {
      this.cameraLayerInfo.textContent = 'No camera layer found';
      this.followCameraCheckbox.disabled = true;
      this.followCameraCheckbox.checked = false;
    }
  }

  private hasLoadedAudio(doc: FLADocument): boolean {
    for (const sound of doc.sounds.values()) {
      if (sound.audioData) {
        return true;
      }
    }
    return false;
  }

  private async loadFile(file: File): Promise<void> {
    if (!file.name.toLowerCase().endsWith('.fla')) {
      alert('Please select a valid FLA file');
      return;
    }

    try {
      // Show loading state
      this.dropZone.classList.add('hidden');
      this.loading.classList.add('active');
      this.viewer.classList.remove('active');
      this.loadingText.textContent = 'Loading...';

      // Parse FLA file with progress updates
      const doc = await this.parser.parse(file, (message) => {
        this.loadingText.textContent = message;
      });
      this.currentDoc = doc;

      // Create player and wait for fonts to load
      this.loadingText.textContent = 'Loading fonts...';
      this.player = new FLAPlayer(this.canvas);
      await this.player.setDocument(doc);
      this.player.onStateUpdate((state) => this.updateUI(state));

      this.loadingText.textContent = 'Preparing...';

      // Update info panel
      const totalFrames = this.player.getState().totalFrames;
      this.infoPanel.innerHTML = `
        <span><span class="label">File:</span> <span class="value">${file.name}</span></span>
        <span><span class="label">Size:</span> <span class="value">${doc.width}x${doc.height}</span></span>
        <span><span class="label">FPS:</span> <span class="value">${doc.frameRate}</span></span>
        <span><span class="label">Frames:</span> <span class="value">${totalFrames}</span></span>
        <span><span class="label">Symbols:</span> <span class="value">${doc.symbols.size}</span></span>
      `;

      // Show viewer
      this.loading.classList.remove('active');
      this.viewer.classList.add('active');

      // Check if we have audio and multiple frames
      const hasAudio = this.hasLoadedAudio(doc);
      const hasMultipleFrames = totalFrames > 1;

      // Show/hide controls based on content
      if (hasMultipleFrames) {
        this.videoControls.classList.remove('hidden');
      } else {
        this.videoControls.classList.add('hidden');
      }

      if (hasAudio && hasMultipleFrames) {
        this.audioControls.classList.remove('hidden');
      } else {
        this.audioControls.classList.add('hidden');
      }

      // Show download button if WebCodecs supported and has multiple frames
      this.currentFileName = file.name.replace(/\.fla$/i, '');
      if (isWebCodecsSupported() && hasMultipleFrames) {
        this.downloadBtn.classList.remove('hidden');
      } else {
        this.downloadBtn.classList.add('hidden');
      }

      // Reset follow camera state for new file
      this.followCameraCheckbox.checked = false;
      this.updateCameraInfo();

      // Update initial state
      this.updateUI(this.player.getState());

    } catch (error) {
      console.error('Failed to load FLA file:', error);
      alert('Failed to load FLA file: ' + (error as Error).message);
      this.loading.classList.remove('active');
      this.dropZone.classList.remove('hidden');
    }
  }

  private togglePlay(): void {
    if (!this.player) return;

    const state = this.player.getState();
    if (state.playing) {
      this.player.pause();
    } else {
      this.player.play();
    }
  }

  // SVG icons for play/pause
  private playIcon = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  private pauseIcon = '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';

  private updateUI(state: PlayerState): void {
    // Update play button icon
    this.playBtn.innerHTML = state.playing ? this.pauseIcon : this.playIcon;

    // Update frame info (timecode style)
    this.frameInfo.innerHTML = `<span class="current">${state.currentFrame + 1}</span> / ${state.totalFrames}`;

    // Update timeline progress
    const progress = state.totalFrames > 1
      ? (state.currentFrame / (state.totalFrames - 1)) * 100
      : 0;
    this.timelineProgress.style.width = `${progress}%`;
  }

  private async startExport(): Promise<void> {
    if (!this.currentDoc) return;

    // Pause playback during export
    this.player?.pause();

    // Show export modal
    this.exportCancelled = false;
    this.exportModal.classList.add('active');
    this.exportProgressFill.style.width = '0%';
    this.exportStatus.textContent = 'Preparing...';

    try {
      const blob = await exportVideo(this.currentDoc, (progress) => {
        if (this.exportCancelled) {
          throw new Error('Export cancelled');
        }

        const percent = (progress.currentFrame / progress.totalFrames) * 100;
        this.exportProgressFill.style.width = `${percent}%`;

        if (progress.stage === 'encoding') {
          this.exportStatus.textContent = `Encoding frame ${progress.currentFrame} / ${progress.totalFrames}`;
        } else {
          this.exportStatus.textContent = 'Finalizing video...';
        }
      });

      if (!this.exportCancelled) {
        downloadBlob(blob, `${this.currentFileName}.mp4`);
      }
    } catch (error) {
      if ((error as Error).message !== 'Export cancelled') {
        console.error('Export failed:', error);
        alert('Export failed: ' + (error as Error).message);
      }
    } finally {
      this.exportModal.classList.remove('active');
    }
  }

  private cancelExport(): void {
    this.exportCancelled = true;
  }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new FLAViewerApp();
});
