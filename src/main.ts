import { FLAParser } from './fla-parser';
import { FLAPlayer } from './player';
import type { PlayerState, FLADocument, Layer } from './types';

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
  private timeline: HTMLElement;
  private timelineProgress: HTMLElement;
  private frameInfo: HTMLElement;
  private infoPanel: HTMLElement;
  private debugPanel: HTMLElement;
  private layerList: HTMLElement;
  private layerOrderSelect: HTMLSelectElement;
  private nestedOrderSelect: HTMLSelectElement;

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
    this.timeline = document.getElementById('timeline')!;
    this.timelineProgress = document.getElementById('timeline-progress')!;
    this.frameInfo = document.getElementById('frame-info')!;
    this.infoPanel = document.getElementById('info-panel')!;
    this.debugPanel = document.getElementById('debug-panel')!;
    this.layerList = document.getElementById('layer-list')!;
    this.layerOrderSelect = document.getElementById('layer-order-select') as HTMLSelectElement;
    this.nestedOrderSelect = document.getElementById('nested-order-select') as HTMLSelectElement;

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
      }
    });
  }

  private debugMode: boolean = false;
  private hiddenLayers: Set<number> = new Set();

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
        <span class="layer-index">#${i}</span>
        <span class="layer-color" style="background: ${layer.color}"></span>
        <span class="layer-name">${layer.name}</span>
        ${layer.parentLayerIndex !== undefined ? `<span class="layer-parent">(in ${layer.parentLayerIndex})</span>` : ''}
        ${isRenderable ? `<span class="render-order-indicator">${orderNum}</span>` : ''}
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

  private async loadFile(file: File): Promise<void> {
    if (!file.name.toLowerCase().endsWith('.fla')) {
      alert('Please select a valid FLA file');
      return;
    }

    try {
      // Show loading state
      this.dropZone.style.display = 'none';
      this.loading.classList.add('active');
      this.viewer.classList.remove('active');

      // Parse FLA file
      const doc = await this.parser.parse(file);
      this.currentDoc = doc;

      // Create player
      this.player = new FLAPlayer(this.canvas);
      this.player.setDocument(doc);
      this.player.onStateUpdate((state) => this.updateUI(state));

      // Update info panel
      this.infoPanel.innerHTML = `
        <strong>File:</strong> ${file.name} |
        <strong>Size:</strong> ${doc.width}x${doc.height} |
        <strong>FPS:</strong> ${doc.frameRate} |
        <strong>Frames:</strong> ${this.player.getState().totalFrames} |
        <strong>Symbols:</strong> ${doc.symbols.size}
      `;

      // Show viewer
      this.loading.classList.remove('active');
      this.viewer.classList.add('active');

      // Update initial state
      this.updateUI(this.player.getState());

    } catch (error) {
      console.error('Failed to load FLA file:', error);
      alert('Failed to load FLA file: ' + (error as Error).message);
      this.loading.classList.remove('active');
      this.dropZone.style.display = 'block';
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

  private updateUI(state: PlayerState): void {
    // Update play button text
    this.playBtn.textContent = state.playing ? 'Pause' : 'Play';

    // Update frame info
    this.frameInfo.textContent = `Frame ${state.currentFrame + 1}/${state.totalFrames}`;

    // Update timeline progress
    const progress = state.totalFrames > 1
      ? (state.currentFrame / (state.totalFrames - 1)) * 100
      : 0;
    this.timelineProgress.style.width = `${progress}%`;
  }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new FLAViewerApp();
});
