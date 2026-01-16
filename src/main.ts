import { FLAParser } from './fla-parser';
import { FLAPlayer } from './player';
import { exportVideo, downloadBlob, isWebCodecsSupported, exportPNGSequence, exportSingleFrame, exportSpriteSheet, exportGIF, exportWebM, exportSVG } from './video-exporter';
import { generateSampleFLA } from './sample-generator';
import { setEdgeDecoderDebug, setImplicitMoveToAfterClose, setEdgeSplittingOnStyleChange } from './edge-decoder';
import type { PlayerState, FLADocument, DisplayElement, Symbol } from './types';

export class FLAViewerApp {
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
  private edgeDebugCheckbox: HTMLInputElement;
  private implicitMoveToCheckbox: HTMLInputElement;
  private edgeSplittingCheckbox: HTMLInputElement;
  private cameraLayerInfo: HTMLElement;
  private videoControls: HTMLElement;
  private audioControls: HTMLElement;
  private loadingText: HTMLElement;
  private downloadBtn: HTMLButtonElement;
  private exportModal: HTMLElement;
  private exportOptions: HTMLElement;
  private exportProgress: HTMLElement;
  private exportHeader: HTMLElement;
  private exportProgressFill: HTMLElement;
  private exportStatus: HTMLElement;
  private exportStartBtn: HTMLButtonElement;
  private exportCloseBtn: HTMLButtonElement;
  private exportCancelBtn: HTMLButtonElement;
  private exportCancelled: boolean = false;
  private currentFileName: string = 'animation';
  private skipImagesBtn: HTMLButtonElement;
  private skipImagesFix: boolean = false;
  private loadSampleBtn: HTMLButtonElement;
  private loadingStages: HTMLElement;
  private loadingProgressFill: HTMLElement;

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
    this.edgeDebugCheckbox = document.getElementById('edge-debug-checkbox') as HTMLInputElement;
    this.implicitMoveToCheckbox = document.getElementById('implicit-moveto-checkbox') as HTMLInputElement;
    this.edgeSplittingCheckbox = document.getElementById('edge-splitting-checkbox') as HTMLInputElement;
    this.cameraLayerInfo = document.getElementById('camera-layer-info')!;
    this.videoControls = document.getElementById('video-controls')!;
    this.audioControls = document.getElementById('audio-controls')!;
    this.loadingText = document.getElementById('loading-text')!;
    this.downloadBtn = document.getElementById('download-btn') as HTMLButtonElement;
    this.exportModal = document.getElementById('export-modal')!;
    this.exportOptions = document.getElementById('export-options')!;
    this.exportProgress = document.getElementById('export-progress')!;
    this.exportHeader = document.getElementById('export-header')!;
    this.exportProgressFill = document.getElementById('export-progress-fill')!;
    this.exportStatus = document.getElementById('export-status')!;
    this.exportStartBtn = document.getElementById('export-start-btn') as HTMLButtonElement;
    this.exportCloseBtn = document.getElementById('export-close-btn') as HTMLButtonElement;
    this.exportCancelBtn = document.getElementById('export-cancel-btn') as HTMLButtonElement;
    this.skipImagesBtn = document.getElementById('skip-images-btn') as HTMLButtonElement;
    this.loadSampleBtn = document.getElementById('load-sample-btn') as HTMLButtonElement;
    this.loadingStages = document.getElementById('loading-stages')!;
    this.loadingProgressFill = document.getElementById('loading-progress-fill')!;
    this.debugCloseBtn = document.getElementById('debug-close-btn') as HTMLButtonElement;

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

    // Load sample button
    this.loadSampleBtn.addEventListener('click', async (e) => {
      e.stopPropagation(); // Prevent drop zone click handler
      const sampleFile = await generateSampleFLA();
      this.loadFile(sampleFile);
    });

    // Player controls
    this.playBtn.addEventListener('click', () => this.togglePlay());
    this.stopBtn.addEventListener('click', () => this.player?.stop());
    this.prevBtn.addEventListener('click', () => this.player?.prevFrame());
    this.nextBtn.addEventListener('click', () => this.player?.nextFrame());
    this.debugBtn.addEventListener('click', () => this.toggleDebug());
    this.debugCloseBtn?.addEventListener('click', () => this.closeDebug());

    // Audio controls
    this.muteBtn.addEventListener('click', () => this.toggleMute());
    this.volumeSlider.addEventListener('input', () => this.updateVolume());

    // Fullscreen
    this.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
    document.addEventListener('fullscreenchange', () => this.updateFullscreenButton());

    // Download/Export
    this.downloadBtn.addEventListener('click', () => this.showExportModal());
    this.exportStartBtn.addEventListener('click', () => this.startExport());
    this.exportCloseBtn.addEventListener('click', () => this.hideExportModal());
    this.exportCancelBtn.addEventListener('click', () => this.cancelExport());

    // Skip images fix
    this.skipImagesBtn.addEventListener('click', () => {
      this.skipImagesFix = true;
      this.skipImagesBtn.classList.add('hidden');
    });

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

    // Edge decoder debug toggle
    this.edgeDebugCheckbox.addEventListener('change', () => {
      setEdgeDecoderDebug(this.edgeDebugCheckbox.checked);
      // Clear caches and re-render to apply changes
      if (this.player) {
        this.player.clearCachesAndRender();
      }
      if (this.edgeDebugCheckbox.checked) {
        console.log('Edge debug enabled. Reload file to see edge decoding debug output.');
      }
    });

    // Implicit moveTo after close path toggle (experimental)
    this.implicitMoveToCheckbox.addEventListener('change', () => {
      setImplicitMoveToAfterClose(this.implicitMoveToCheckbox.checked);
      // Clear caches and re-render to apply changes
      if (this.player) {
        this.player.clearCachesAndRender();
      }
      if (this.implicitMoveToCheckbox.checked) {
        console.log('Implicit MoveTo enabled. Reload file to apply to edge decoding.');
      }
    });

    // Edge splitting on style change toggle (experimental)
    this.edgeSplittingCheckbox.addEventListener('change', () => {
      setEdgeSplittingOnStyleChange(this.edgeSplittingCheckbox.checked);
      // Clear caches and re-render to apply changes
      if (this.player) {
        this.player.clearCachesAndRender();
      }
      if (this.edgeSplittingCheckbox.checked) {
        console.log('Edge Splitting enabled. Reload file to apply to edge parsing.');
      }
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
  private hiddenElements: Map<number, Set<number>> = new Map(); // layerIndex -> Set of hidden element indices
  private collapsedLayers: Set<number> = new Set();
  private collapsedSymbols: Set<string> = new Set(); // Track collapsed symbols by path
  private lastDebugFrame: number = -1; // Track frame for debug panel refresh
  private debugCloseBtn: HTMLButtonElement;
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
      document.exitFullscreen().catch(() => {
        // Ignore fullscreen exit errors (e.g., no user gesture in tests)
      });
    } else {
      this.viewer.requestFullscreen().catch(() => {
        // Ignore fullscreen request errors (e.g., no user gesture in tests)
      });
    }
  }

  private updateFullscreenButton(): void {
    this.fullscreenBtn.innerHTML = document.fullscreenElement
      ? this.exitFullscreenIcon
      : this.fullscreenIcon;
  }

  private toggleDebug(): void {
    if (!this.player) return;

    if (!this.debugMode) {
      this.debugMode = true;
      this.player.enableDebugMode();
      this.debugBtn.classList.add('active');
      this.debugPanel.classList.add('active');
      this.lastDebugFrame = this.player.getState().currentFrame;
      this.populateLayerList();
    } else {
      this.closeDebug();
    }
  }

  private closeDebug(): void {
    if (!this.debugMode) return;
    this.debugMode = false;
    this.player?.disableDebugMode();
    this.debugBtn.classList.remove('active');
    this.debugPanel.classList.remove('active');
  }

  private findFrameAtIndex(frames: { index: number; duration: number; elements: DisplayElement[] }[], index: number) {
    for (const frame of frames) {
      if (index >= frame.index && index < frame.index + frame.duration) {
        return frame;
      }
    }
    return null;
  }

  private populateLayerList(): void {
    if (!this.currentDoc || !this.currentDoc.timelines[0]) return;

    const layers = this.currentDoc.timelines[0].layers;
    const isReverse = this.layerOrderSelect.value === 'reverse';
    const currentFrame = this.player?.getState().currentFrame ?? 0;

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
      const layerContainer = document.createElement('div');
      layerContainer.className = 'layer-container';

      const div = document.createElement('div');
      div.className = 'layer-item';
      if (layer.layerType === 'folder') div.className += ' folder';
      if (layer.layerType === 'guide') div.className += ' guide';

      const isRenderable = layer.layerType !== 'guide' && layer.layerType !== 'folder';
      const orderNum = isRenderable ? renderOrder++ : '-';

      // Get elements from the current frame for display
      const frame = this.findFrameAtIndex(layer.frames, currentFrame);
      const elements = frame?.elements || [];
      const hasElements = elements.length > 0 && isRenderable;
      const isCollapsed = this.collapsedLayers.has(i);

      div.innerHTML = `
        <span class="layer-toggle ${isCollapsed ? 'collapsed' : ''} ${!hasElements ? 'no-children' : ''}">&#9660;</span>
        <input type="checkbox" ${this.hiddenLayers.has(i) ? '' : 'checked'} data-layer="${i}" ${!isRenderable ? 'disabled' : ''}>
        <span class="layer-index">${i}</span>
        <span class="layer-color" style="background: ${layer.color}"></span>
        <span class="layer-name">${layer.name}</span>
        ${layer.parentLayerIndex !== undefined ? `<span class="layer-parent">(${layer.parentLayerIndex})</span>` : ''}
        ${isRenderable ? `<span class="render-order">${orderNum}</span>` : ''}
      `;

      // Layer visibility checkbox
      const checkbox = div.querySelector('input') as HTMLInputElement;
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          this.hiddenLayers.delete(i);
        } else {
          this.hiddenLayers.add(i);
        }
        this.player?.setHiddenLayers(this.hiddenLayers);
      });

      // Toggle collapse/expand
      const toggleBtn = div.querySelector('.layer-toggle') as HTMLElement;
      if (hasElements) {
        toggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.collapsedLayers.has(i)) {
            this.collapsedLayers.delete(i);
            toggleBtn.classList.remove('collapsed');
            elementsContainer.classList.add('expanded');
          } else {
            this.collapsedLayers.add(i);
            toggleBtn.classList.add('collapsed');
            elementsContainer.classList.remove('expanded');
          }
        });
      }

      layerContainer.appendChild(div);

      // Create elements container
      const elementsContainer = document.createElement('div');
      elementsContainer.className = `layer-elements ${!isCollapsed && hasElements ? 'expanded' : ''}`;

      // Add element items
      if (hasElements) {
        for (let j = 0; j < elements.length; j++) {
          const element = elements[j];
          const elementContainer = this.createElementItem(element, i, j, `layer-${i}-el-${j}`);
          elementsContainer.appendChild(elementContainer);
        }
      }

      layerContainer.appendChild(elementsContainer);
      this.layerList.appendChild(layerContainer);
    }
  }

  private createElementItem(
    element: DisplayElement,
    layerIndex: number,
    elementIndex: number,
    path: string,
    depth: number = 0
  ): HTMLElement {
    const container = document.createElement('div');
    container.className = 'element-container';

    const elementDiv = document.createElement('div');
    elementDiv.className = 'element-item';

    // Generate element name based on type
    let elementName = '';
    let symbol: Symbol | undefined;
    if (element.type === 'symbol') {
      elementName = element.libraryItemName;
      symbol = this.currentDoc?.symbols.get(element.libraryItemName);
    } else if (element.type === 'text') {
      const text = element.textRuns.map(r => r.characters).join('');
      elementName = text.length > 20 ? text.substring(0, 20) + '...' : text;
    } else if (element.type === 'bitmap') {
      elementName = element.libraryItemName;
    } else if (element.type === 'video') {
      elementName = element.libraryItemName;
    } else if (element.type === 'shape') {
      elementName = `${element.fills.length}f/${element.strokes.length}s`;
    }

    // Check if this element is hidden (only for top-level elements)
    const hiddenSet = this.hiddenElements.get(layerIndex);
    const isHidden = depth === 0 ? (hiddenSet?.has(elementIndex) ?? false) : false;

    // Check if symbol has content to expand
    const hasSymbolContent = symbol && symbol.timeline.layers.length > 0;
    const isCollapsed = this.collapsedSymbols.has(path);

    // Build element HTML
    const toggleHtml = hasSymbolContent
      ? `<span class="element-toggle ${isCollapsed ? 'collapsed' : ''}">&#9660;</span>`
      : `<span class="element-toggle no-children"></span>`;

    const checkboxHtml = depth === 0
      ? `<input type="checkbox" ${isHidden ? '' : 'checked'} data-layer="${layerIndex}" data-element="${elementIndex}">`
      : '';

    elementDiv.innerHTML = `
      ${toggleHtml}
      ${checkboxHtml}
      <span class="element-id">#${elementIndex}</span>
      <span class="element-type ${element.type}">${element.type}</span>
      <span class="element-name" title="${elementName}">${elementName}</span>
    `;

    // Element visibility checkbox (only for top-level)
    if (depth === 0) {
      const elCheckbox = elementDiv.querySelector('input') as HTMLInputElement;
      if (elCheckbox) {
        elCheckbox.addEventListener('change', () => {
          if (!this.hiddenElements.has(layerIndex)) {
            this.hiddenElements.set(layerIndex, new Set());
          }
          const set = this.hiddenElements.get(layerIndex)!;
          if (elCheckbox.checked) {
            set.delete(elementIndex);
          } else {
            set.add(elementIndex);
          }
          this.player?.setHiddenElements(this.hiddenElements);
        });
      }
    }

    container.appendChild(elementDiv);

    // Create symbol content container
    if (hasSymbolContent && symbol) {
      const symbolContent = document.createElement('div');
      symbolContent.className = `symbol-content ${!isCollapsed ? 'expanded' : ''}`;

      // Add symbol layers and their elements
      const timeline = symbol.timeline;
      for (let li = 0; li < timeline.layers.length; li++) {
        const layer = timeline.layers[li];
        const layerDiv = document.createElement('div');
        layerDiv.className = 'symbol-layer';
        layerDiv.innerHTML = `
          <span class="sym-layer-color" style="background: ${layer.color}"></span>
          <span class="sym-layer-name">${layer.name}</span>
          <span class="sym-layer-info">(${layer.frames[0]?.elements.length || 0} el)</span>
        `;
        symbolContent.appendChild(layerDiv);

        // Add elements from first frame
        const frameElements = layer.frames[0]?.elements || [];
        for (let ei = 0; ei < frameElements.length; ei++) {
          const childElement = frameElements[ei];
          const childPath = `${path}/${symbol.name}-L${li}-E${ei}`;
          // Limit depth to prevent infinite recursion and performance issues
          if (depth < 3) {
            const childContainer = this.createElementItem(
              childElement,
              layerIndex,
              elementIndex,
              childPath,
              depth + 1
            );
            symbolContent.appendChild(childContainer);
          } else {
            // Just show a summary for deep nesting
            const summaryDiv = document.createElement('div');
            summaryDiv.className = 'element-item';
            summaryDiv.innerHTML = `
              <span class="element-toggle no-children"></span>
              <span class="element-id">#${ei}</span>
              <span class="element-type ${childElement.type}">${childElement.type}</span>
              <span class="element-name">...</span>
            `;
            symbolContent.appendChild(summaryDiv);
          }
        }
      }

      container.appendChild(symbolContent);

      // Toggle collapse/expand for symbol
      const toggleBtn = elementDiv.querySelector('.element-toggle') as HTMLElement;
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.collapsedSymbols.has(path)) {
          this.collapsedSymbols.delete(path);
          toggleBtn.classList.remove('collapsed');
          symbolContent.classList.add('expanded');
        } else {
          this.collapsedSymbols.add(path);
          toggleBtn.classList.add('collapsed');
          symbolContent.classList.remove('expanded');
        }
      });
    }

    return container;
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

  private readonly loadingStageOrder = ['extract', 'symbols', 'images', 'audio', 'timeline'];

  private updateLoadingStage(message: string): void {
    // Determine current stage from message
    let currentStage = '';
    let progress = 0;

    if (message.startsWith('Extracting') || message.startsWith('Repairing')) {
      currentStage = 'extract';
      progress = 10;
    } else if (message.startsWith('Parsing document')) {
      currentStage = 'extract';
      progress = 15;
    } else if (message.startsWith('Loading symbols')) {
      currentStage = 'symbols';
      progress = 20;
      // Extract progress from "Loading symbols... (X/Y)"
      const match = message.match(/\((\d+)\/(\d+)\)/);
      if (match) {
        const current = parseInt(match[1]);
        const total = parseInt(match[2]);
        progress = 20 + (current / total) * 20;
      }
    } else if (message.startsWith('Loading images') || message.startsWith('Fixing images') || message.startsWith('Skipping')) {
      currentStage = 'images';
      progress = 45;
      const match = message.match(/(\d+)\/(\d+)/);
      if (match) {
        const current = parseInt(match[1]);
        const total = parseInt(match[2]);
        progress = 45 + (current / total) * 25;
      }
    } else if (message.startsWith('Loading audio')) {
      currentStage = 'audio';
      progress = 75;
    } else if (message.startsWith('Loading videos')) {
      currentStage = 'audio'; // Combined with audio stage
      progress = 80;
    } else if (message.startsWith('Building timeline')) {
      currentStage = 'timeline';
      progress = 85;
    } else if (message.startsWith('Loading fonts') || message.startsWith('Preparing')) {
      currentStage = 'timeline';
      progress = 95;
    }

    // Update stage indicators
    const stageIndex = this.loadingStageOrder.indexOf(currentStage);
    const stages = this.loadingStages.querySelectorAll('.loading-stage');
    stages.forEach((stage, i) => {
      stage.classList.remove('active', 'done');
      if (i < stageIndex) {
        stage.classList.add('done');
      } else if (i === stageIndex) {
        stage.classList.add('active');
      }
    });

    // Update progress bar
    this.loadingProgressFill.style.width = `${progress}%`;
  }

  private resetLoadingStages(): void {
    const stages = this.loadingStages.querySelectorAll('.loading-stage');
    stages.forEach(stage => {
      stage.classList.remove('active', 'done');
    });
    this.loadingProgressFill.style.width = '0%';
  }

  private async loadFile(file: File): Promise<void> {
    if (!file.name.toLowerCase().endsWith('.fla')) {
      alert(`Please select a valid FLA file.\nReceived: "${file.name}" (${file.type || 'unknown type'})`);
      return;
    }

    try {
      // Show loading state
      this.dropZone.classList.add('hidden');
      this.loading.classList.add('active');
      this.viewer.classList.remove('active');
      this.loadingText.textContent = 'Loading...';
      this.skipImagesFix = false;
      this.skipImagesBtn.classList.add('hidden');
      this.resetLoadingStages();

      // Parse FLA file with progress updates
      const doc = await this.parser.parse(file, (message) => {
        this.loadingText.textContent = message;
        this.updateLoadingStage(message);
        // Show skip button when fixing images
        if (message.startsWith('Fixing images')) {
          this.skipImagesBtn.classList.remove('hidden');
        } else {
          this.skipImagesBtn.classList.add('hidden');
        }
      }, () => this.skipImagesFix);
      this.currentDoc = doc;

      // Create player and wait for fonts to load
      this.loadingText.textContent = 'Loading fonts...';
      this.updateLoadingStage('Loading fonts...');
      this.player = new FLAPlayer(this.canvas);
      await this.player.setDocument(doc);
      this.player.onStateUpdate((state) => this.updateUI(state));

      this.loadingText.textContent = 'Preparing...';
      this.updateLoadingStage('Preparing...');

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
      this.skipImagesBtn.classList.add('hidden');
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

    // Refresh debug panel when frame changes
    if (this.debugMode && state.currentFrame !== this.lastDebugFrame) {
      this.lastDebugFrame = state.currentFrame;
      this.populateLayerList();
    }
  }

  private showExportModal(): void {
    // Reset to options view
    this.exportOptions.style.display = 'block';
    this.exportProgress.style.display = 'none';
    this.exportHeader.textContent = 'Export';
    this.exportModal.classList.add('active');
  }

  private hideExportModal(): void {
    this.exportModal.classList.remove('active');
  }

  private async startExport(): Promise<void> {
    if (!this.currentDoc) return;

    // Get selected format
    const formatRadio = document.querySelector('input[name="export-format"]:checked') as HTMLInputElement;
    const format = formatRadio?.value || 'mp4';

    // Pause playback during export
    this.player?.pause();

    // Switch to progress view
    this.exportOptions.style.display = 'none';
    this.exportProgress.style.display = 'block';
    this.exportCancelled = false;
    this.exportProgressFill.style.width = '0%';
    this.exportStatus.textContent = 'Preparing...';

    try {
      if (format === 'mp4') {
        this.exportHeader.textContent = 'Exporting Video';
        const blob = await exportVideo(
          this.currentDoc,
          (progress) => {
            const percent = (progress.currentFrame / progress.totalFrames) * 100;
            this.exportProgressFill.style.width = `${percent}%`;

            if (progress.stage === 'encoding') {
              this.exportStatus.textContent = `Encoding frame ${progress.currentFrame} / ${progress.totalFrames}`;
            } else if (progress.stage === 'encoding-audio') {
              this.exportStatus.textContent = 'Encoding audio...';
            } else {
              this.exportStatus.textContent = 'Finalizing video...';
            }
          },
          () => this.exportCancelled
        );

        if (!this.exportCancelled) {
          downloadBlob(blob, `${this.currentFileName}.mp4`);
        }
      } else if (format === 'webm') {
        this.exportHeader.textContent = 'Exporting WebM Video';
        const blob = await exportWebM(
          this.currentDoc,
          (progress) => {
            const percent = (progress.currentFrame / progress.totalFrames) * 100;
            this.exportProgressFill.style.width = `${percent}%`;

            if (progress.stage === 'encoding') {
              this.exportStatus.textContent = `Encoding frame ${progress.currentFrame} / ${progress.totalFrames}`;
            } else if (progress.stage === 'encoding-audio') {
              this.exportStatus.textContent = 'Encoding audio...';
            } else {
              this.exportStatus.textContent = 'Finalizing video...';
            }
          },
          () => this.exportCancelled
        );

        if (!this.exportCancelled) {
          downloadBlob(blob, `${this.currentFileName}.webm`);
        }
      } else if (format === 'png-sequence') {
        this.exportHeader.textContent = 'Exporting PNG Sequence';
        const blob = await exportPNGSequence(
          this.currentDoc,
          { framePrefix: `${this.currentFileName}_` },
          (progress) => {
            const percent = (progress.currentFrame / progress.totalFrames) * 100;
            this.exportProgressFill.style.width = `${percent}%`;

            if (progress.stage === 'rendering') {
              this.exportStatus.textContent = `Rendering frame ${progress.currentFrame} / ${progress.totalFrames}`;
            } else {
              this.exportStatus.textContent = 'Creating ZIP file...';
            }
          },
          () => this.exportCancelled
        );

        if (!this.exportCancelled) {
          downloadBlob(blob, `${this.currentFileName}_frames.zip`);
        }
      } else if (format === 'png-frame') {
        this.exportHeader.textContent = 'Exporting Frame';
        this.exportStatus.textContent = 'Rendering frame...';
        this.exportProgressFill.style.width = '50%';

        const currentFrame = this.player?.getState().currentFrame || 0;
        const blob = await exportSingleFrame(this.currentDoc, currentFrame);

        this.exportProgressFill.style.width = '100%';

        if (!this.exportCancelled) {
          const frameNum = String(currentFrame).padStart(5, '0');
          downloadBlob(blob, `${this.currentFileName}_frame_${frameNum}.png`);
        }
      } else if (format === 'svg') {
        this.exportHeader.textContent = 'Exporting SVG';
        this.exportStatus.textContent = 'Generating SVG...';
        this.exportProgressFill.style.width = '50%';

        const currentFrame = this.player?.getState().currentFrame || 0;
        const blob = await exportSVG(this.currentDoc, currentFrame);

        this.exportProgressFill.style.width = '100%';

        if (!this.exportCancelled) {
          const frameNum = String(currentFrame).padStart(5, '0');
          downloadBlob(blob, `${this.currentFileName}_frame_${frameNum}.svg`);
        }
      } else if (format === 'gif') {
        this.exportHeader.textContent = 'Exporting GIF';
        const blob = await exportGIF(
          this.currentDoc,
          {},
          (progress) => {
            const percent = (progress.currentFrame / progress.totalFrames) * 100;
            this.exportProgressFill.style.width = `${percent}%`;

            if (progress.stage === 'rendering') {
              this.exportStatus.textContent = `Rendering frame ${progress.currentFrame} / ${progress.totalFrames}`;
            } else if (progress.stage === 'encoding') {
              this.exportStatus.textContent = `Encoding frame ${progress.currentFrame} / ${progress.totalFrames}`;
            } else {
              this.exportStatus.textContent = 'Finalizing GIF...';
            }
          },
          () => this.exportCancelled
        );

        if (!this.exportCancelled) {
          downloadBlob(blob, `${this.currentFileName}.gif`);
        }
      } else if (format === 'sprite-sheet') {
        this.exportHeader.textContent = 'Exporting Sprite Sheet';
        const result = await exportSpriteSheet(
          this.currentDoc,
          { includeJson: true },
          (progress) => {
            const percent = (progress.currentFrame / progress.totalFrames) * 100;
            this.exportProgressFill.style.width = `${percent}%`;

            if (progress.stage === 'rendering') {
              this.exportStatus.textContent = `Rendering frame ${progress.currentFrame} / ${progress.totalFrames}`;
            } else {
              this.exportStatus.textContent = 'Compositing sprite sheet...';
            }
          },
          () => this.exportCancelled
        );

        if (!this.exportCancelled) {
          // Download both PNG and JSON
          downloadBlob(result.image, `${this.currentFileName}_spritesheet.png`);
          if (result.json) {
            const jsonBlob = new Blob([result.json], { type: 'application/json' });
            downloadBlob(jsonBlob, `${this.currentFileName}_spritesheet.json`);
          }
        }
      }
    } catch (error) {
      if ((error as Error).message !== 'Export cancelled') {
        console.error('Export failed:', error);
        alert('Export failed: ' + (error as Error).message);
      }
    } finally {
      this.hideExportModal();
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
