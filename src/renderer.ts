import type {
  FLADocument,
  Timeline,
  Layer,
  Frame,
  DisplayElement,
  SymbolInstance,
  VideoInstance,
  BitmapInstance,
  TextInstance,
  Shape,
  Matrix,
  FillStyle,
  StrokeStyle,
  Edge,
  Tween,
  Point,
  PathCommand,
  Filter,
  MorphShape,
  ColorTransform,
  BlendMode,
  Rectangle,
  Symbol,
  MovieClipInstanceState
} from './types';
import { getWithNormalizedPath } from './path-utils';

// Debug flag - enabled via ?debug=true URL parameter or setRendererDebug(true)
let DEBUG = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug') === 'true';

// Export setter for testing
export function setRendererDebug(value: boolean): void {
  DEBUG = value;
}

interface DebugElement {
  type: 'shape' | 'symbol' | 'bitmap' | 'video' | 'text' | 'button-hit-area';
  element: DisplayElement;
  path: Path2D;
  transform: DOMMatrix;
  depth: number;
  parentPath: string[];  // Symbol hierarchy path
  fillStyles?: Map<number, FillStyle>;
  strokeStyles?: Map<number, StrokeStyle>;
  edges?: Edge[];
  // For button hit areas
  isHitArea?: boolean;
  symbolName?: string;
}

// Cache for computed shape paths (avoids recomputing every frame)
interface CachedShapePaths {
  fillPaths: Map<number, Path2D>;
  strokePaths: Map<number, Path2D>;
  combinedPath: Path2D;
}

export class FLARenderer {
  private ctx: CanvasRenderingContext2D;
  private doc: FLADocument | null = null;
  private canvas: HTMLCanvasElement;
  private scale: number = 1;
  private dpr: number = 1;
  private debugMode: boolean = false;
  private debugElements: DebugElement[] = [];
  private debugSymbolPath: string[] = [];  // Current symbol hierarchy for debug
  private clickHandler: ((e: MouseEvent) => void) | null = null;
  private hiddenLayers: Set<number> = new Set();
  private hiddenElements: Map<number, Set<number>> = new Map(); // layerIndex -> Set of hidden element indices
  private layerOrder: 'forward' | 'reverse' = 'reverse';
  private nestedLayerOrder: 'forward' | 'reverse' = 'reverse';
  private elementOrder: 'forward' | 'reverse' = 'forward';
  private shapePathCache = new WeakMap<Shape, CachedShapePaths>();
  private symbolBitmapCache = new Map<string, { canvas: HTMLCanvasElement, bounds: { width: number, height: number, offsetX: number, offsetY: number } }>();
  private followCamera: boolean = false;
  private manualCameraLayerIndex: number | undefined = undefined;

  // MovieClip instance state tracking for independent playback
  // Key format: "instancePath:symbolName" where instancePath is the path through nested symbols
  private movieClipStates = new Map<string, MovieClipInstanceState>();
  private currentInstancePath: string[] = []; // Stack of instance identifiers for nested symbols

  // Current scene index for multiple scene support
  private currentScene: number = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get 2D context');
    }
    this.ctx = ctx;
    this.dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
  }

  enableDebugMode(): void {
    if (this.debugMode) return;
    this.debugMode = true;

    this.clickHandler = (e: MouseEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      // Convert click position from CSS pixels to canvas buffer coordinates
      // This properly handles any scaling between CSS display size and canvas buffer size
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;
      const canvasX = (e.clientX - rect.left) * scaleX;
      const canvasY = (e.clientY - rect.top) * scaleY;

      // Convert to document coordinates (remove the base scale applied during rendering)
      const combinedScale = this.scale * this.dpr;
      const docX = canvasX / combinedScale;
      const docY = canvasY / combinedScale;

      console.log(`Click at doc coords: (${docX.toFixed(1)}, ${docY.toFixed(1)}), canvas: (${canvasX.toFixed(1)}, ${canvasY.toFixed(1)}), tracking ${this.debugElements.length} elements`);

      // Find all elements under the click point (from top to bottom)
      const hitElements: DebugElement[] = [];

      // Save current transform and reset to identity for hit testing
      this.ctx.save();
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);

      for (const debugEl of this.debugElements) {
        // The stored transform includes the base combinedScale, so we use canvas coordinates
        // and transform them to local element coordinates
        const inverse = debugEl.transform.inverse();
        const localX = inverse.a * canvasX + inverse.c * canvasY + inverse.e;
        const localY = inverse.b * canvasX + inverse.d * canvasY + inverse.f;

        // Test if point is in path (path is in local coordinates)
        // Use 'evenodd' fill rule to match rendering
        if (this.ctx.isPointInPath(debugEl.path, localX, localY, 'evenodd')) {
          hitElements.push(debugEl);
        }
      }

      this.ctx.restore();

      if (hitElements.length > 0) {
        // Sort by depth (deepest first - top of visual stack) and get the topmost one
        hitElements.sort((a, b) => b.depth - a.depth);
        const el = hitElements[0];

        const pathStr = el.parentPath.length > 0 ? el.parentPath.join(' > ') : '(root)';
        console.group(`${el.type.toUpperCase()} in ${pathStr}`);
        console.log('Path:', el.parentPath.length > 0 ? el.parentPath : ['(root timeline)']);
        console.log('Element:', el.element);
        console.log('Transform:', {
          a: el.transform.a.toFixed(4),
          b: el.transform.b.toFixed(4),
          c: el.transform.c.toFixed(4),
          d: el.transform.d.toFixed(4),
          tx: el.transform.e.toFixed(2),
          ty: el.transform.f.toFixed(2)
        });

        if (el.type === 'shape') {
          const shape = el.element as Shape;
          console.log('Fill Styles:', el.fillStyles ? Object.fromEntries(el.fillStyles) : {});
          console.log('Stroke Styles:', el.strokeStyles ? Object.fromEntries(el.strokeStyles) : {});
          console.log('Shape Matrix:', shape.matrix);

          // Only show edges with out-of-bounds coordinates
          const BOUNDS = 10000; // Reasonable max coordinate
          const isOutOfBounds = (v: number) => !Number.isFinite(v) || Math.abs(v) > BOUNDS;

          const badEdges: { index: number; edge: Edge; badCommands: string[] }[] = [];
          el.edges?.forEach((edge, i) => {
            const badCommands: string[] = [];
            edge.commands.forEach((cmd, j) => {
              if (cmd.type === 'M' || cmd.type === 'L') {
                if (isOutOfBounds(cmd.x) || isOutOfBounds(cmd.y)) {
                  badCommands.push(`${j}: ${cmd.type} ${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)}`);
                }
              } else if (cmd.type === 'Q') {
                if (isOutOfBounds(cmd.x) || isOutOfBounds(cmd.y) || isOutOfBounds(cmd.cx) || isOutOfBounds(cmd.cy)) {
                  badCommands.push(`${j}: Q cx=${cmd.cx.toFixed(2)}, cy=${cmd.cy.toFixed(2)} -> ${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)}`);
                }
              } else if (cmd.type === 'C') {
                if (isOutOfBounds(cmd.x) || isOutOfBounds(cmd.y) ||
                    isOutOfBounds(cmd.c1x) || isOutOfBounds(cmd.c1y) ||
                    isOutOfBounds(cmd.c2x) || isOutOfBounds(cmd.c2y)) {
                  badCommands.push(`${j}: C c1=(${cmd.c1x.toFixed(2)}, ${cmd.c1y.toFixed(2)}) c2=(${cmd.c2x.toFixed(2)}, ${cmd.c2y.toFixed(2)}) -> ${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)}`);
                }
              }
            });
            if (badCommands.length > 0) {
              badEdges.push({ index: i, edge, badCommands });
            }
          });

          console.log(`Edges: ${el.edges?.length || 0} total, ${badEdges.length} with out-of-bounds coords (>${BOUNDS})`);

          // If few edges or has bad edges, show details
          if ((el.edges?.length || 0) <= 5 || badEdges.length > 0) {
            el.edges?.forEach((edge, i) => {
              console.log(`  Edge ${i}: fill0=${edge.fillStyle0}, fill1=${edge.fillStyle1}, stroke=${edge.strokeStyle}, commands=${edge.commands.length}`);
              edge.commands.forEach((cmd, j) => {
                if (cmd.type === 'M') {
                  console.log(`    ${j}: M ${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)}`);
                } else if (cmd.type === 'L') {
                  console.log(`    ${j}: L ${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)}`);
                } else if (cmd.type === 'Q') {
                  console.log(`    ${j}: Q cx=${cmd.cx.toFixed(2)}, cy=${cmd.cy.toFixed(2)} -> ${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)}`);
                } else if (cmd.type === 'C') {
                  console.log(`    ${j}: C c1=(${cmd.c1x.toFixed(2)}, ${cmd.c1y.toFixed(2)}) c2=(${cmd.c2x.toFixed(2)}, ${cmd.c2y.toFixed(2)}) -> ${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)}`);
                } else if (cmd.type === 'Z') {
                  console.log(`    ${j}: Z`);
                }
              });
            });
          } else {
            badEdges.forEach(({ index, edge, badCommands }) => {
              console.log(`  Edge ${index}: fill0=${edge.fillStyle0}, fill1=${edge.fillStyle1}, stroke=${edge.strokeStyle}`);
              badCommands.forEach(cmd => console.log(`    ${cmd}`));
            });
          }
        } else if (el.type === 'symbol') {
          const symbol = el.element as SymbolInstance;
          console.log('Library Item:', symbol.libraryItemName);
          console.log('Loop:', symbol.loop);
          console.log('First Frame:', symbol.firstFrame);
        } else if (el.type === 'bitmap') {
          const bitmap = el.element as BitmapInstance;
          console.log('Library Item:', bitmap.libraryItemName);
        } else if (el.type === 'button-hit-area') {
          const button = el.element as SymbolInstance;
          console.log('Button Symbol:', el.symbolName);
          console.log('Library Item:', button.libraryItemName);
          console.log('Hit Area: This is the clickable region (invisible at runtime)');
        }

        console.groupEnd();
      } else {
        console.log('No elements found at click position');
      }
    };

    this.canvas.addEventListener('click', this.clickHandler);
    this.canvas.style.cursor = 'crosshair';
    console.log('Debug mode enabled - click on canvas to inspect elements');
  }

  disableDebugMode(): void {
    if (!this.debugMode) return;
    this.debugMode = false;

    if (this.clickHandler) {
      this.canvas.removeEventListener('click', this.clickHandler);
      this.clickHandler = null;
    }
    this.canvas.style.cursor = 'default';
    console.log('Debug mode disabled');
  }

  setHiddenLayers(hiddenLayers: Set<number>): void {
    this.hiddenLayers = new Set(hiddenLayers);
  }

  setHiddenElements(hiddenElements: Map<number, Set<number>>): void {
    this.hiddenElements = new Map(
      Array.from(hiddenElements.entries()).map(([k, v]) => [k, new Set(v)])
    );
  }

  setLayerOrder(order: 'forward' | 'reverse'): void {
    this.layerOrder = order;
  }

  setNestedLayerOrder(order: 'forward' | 'reverse'): void {
    this.nestedLayerOrder = order;
  }

  setElementOrder(order: 'forward' | 'reverse'): void {
    this.elementOrder = order;
  }

  /**
   * Set the current scene index for rendering.
   */
  setCurrentScene(sceneIndex: number): void {
    if (!this.doc) return;
    if (sceneIndex >= 0 && sceneIndex < this.doc.timelines.length) {
      this.currentScene = sceneIndex;
    }
  }

  /**
   * Get the current scene index.
   */
  getCurrentScene(): number {
    return this.currentScene;
  }

  // Clear all cached data to force recomputation
  clearCaches(): void {
    // Clear shape path cache by creating a new WeakMap
    this.shapePathCache = new WeakMap<Shape, CachedShapePaths>();
    // Clear symbol bitmap cache
    this.symbolBitmapCache.clear();
    // Clear MovieClip instance states
    this.movieClipStates.clear();
    this.currentInstancePath = [];
  }

  // Generate a unique key for a MovieClip instance based on its position in the hierarchy
  private generateInstanceKey(symbolName: string, elementIndex: number): string {
    const pathKey = this.currentInstancePath.length > 0
      ? this.currentInstancePath.join('/') + '/'
      : '';
    return `${pathKey}${symbolName}@${elementIndex}`;
  }

  // Get or create state for a MovieClip instance
  private getOrCreateMovieClipState(
    key: string,
    totalFrames: number,
    parentFrame: number
  ): MovieClipInstanceState {
    let state = this.movieClipStates.get(key);
    if (!state) {
      // New instance - create initial state
      state = {
        playhead: 0,
        totalFrames,
        startParentFrame: parentFrame,
        isPlaying: true
      };
      this.movieClipStates.set(key, state);
    }
    return state;
  }

  // Advance all MovieClip playheads by one frame
  // Called by the player when advancing to the next frame
  advanceMovieClipPlayheads(): void {
    for (const state of this.movieClipStates.values()) {
      if (state.isPlaying && state.totalFrames > 1) {
        state.playhead = (state.playhead + 1) % state.totalFrames;
      }
    }
  }

  // Reset all MovieClip playheads to frame 0
  // Called when seeking to a specific frame or restarting
  resetMovieClipPlayheads(): void {
    this.movieClipStates.clear();
  }

  // Enable/disable following the camera/ramka layer as viewport
  setFollowCamera(enabled: boolean): void {
    this.followCamera = enabled;
    if (enabled && this.doc) {
      this.manualCameraLayerIndex = this.findCameraLayerByName();
      if (DEBUG && this.manualCameraLayerIndex !== undefined) {
        const layer = this.doc.timelines[this.currentScene]?.layers[this.manualCameraLayerIndex];
        console.log(`Follow camera enabled: layer "${layer?.name}" at index ${this.manualCameraLayerIndex}`);
      }
    } else {
      this.manualCameraLayerIndex = undefined;
    }
    // Update canvas size when camera following changes
    this.updateCanvasSize();
  }

  getFollowCamera(): boolean {
    return this.followCamera;
  }

  // Find camera layer by name (less strict than auto-detection)
  // Returns the index of a layer named ramka/camera/viewport/etc.
  private findCameraLayerByName(): number | undefined {
    if (!this.doc || !this.doc.timelines[this.currentScene]) return undefined;

    const layers = this.doc.timelines[this.currentScene].layers;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const nameLower = layer.name.toLowerCase();

      // Match camera-related layer names
      if (nameLower === 'ramka' ||
          nameLower === 'camera' ||
          nameLower === 'cam' ||
          nameLower === 'viewport' ||
          nameLower === 'frame' ||
          nameLower.includes('camera') ||
          nameLower.includes('viewport')) {
        // Verify layer has at least one symbol element
        if (layer.frames.length > 0 && layer.frames[0].elements.length > 0) {
          const element = layer.frames[0].elements[0];
          if (element.type === 'symbol') {
            return i;
          }
        }
      }
    }
    return undefined;
  }

  // Get list of potential camera layers for UI
  getCameraLayers(): { index: number; name: string }[] {
    if (!this.doc || !this.doc.timelines[this.currentScene]) return [];

    const result: { index: number; name: string }[] = [];
    const layers = this.doc.timelines[this.currentScene].layers;

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const nameLower = layer.name.toLowerCase();

      if (nameLower === 'ramka' ||
          nameLower === 'camera' ||
          nameLower === 'cam' ||
          nameLower === 'viewport' ||
          nameLower === 'frame' ||
          nameLower.includes('camera') ||
          nameLower.includes('viewport')) {
        result.push({ index: i, name: layer.name });
      }
    }
    return result;
  }

  async setDocument(doc: FLADocument, skipResize: boolean = false): Promise<void> {
    this.doc = doc;
    this.dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;

    // Clear state from previous document
    this.missingSymbols.clear();
    this.loadedFonts.clear();
    this.loadingFonts.clear();
    this.movieClipStates.clear();
    this.currentInstancePath = [];

    // Update canvas size (skip for offscreen rendering)
    if (!skipResize) {
      this.updateCanvasSize();
    } else {
      // For offscreen rendering, use 1:1 scale
      this.scale = 1;
      this.dpr = 1;
    }

    // Preload all fonts used in the document (skip for offscreen)
    if (!skipResize) {
      await this.preloadDocumentFonts(doc);
    }

    // Pre-compute shape paths asynchronously to warm up cache
    this.precomputeShapePaths(doc);
  }

  // Collect all fonts used in the document and preload them
  private async preloadDocumentFonts(doc: FLADocument): Promise<void> {
    const fontsToLoad = new Set<string>();

    // Scan main timeline
    for (const timeline of doc.timelines) {
      this.collectFontsFromTimeline(timeline, fontsToLoad);
    }

    // Scan all symbols
    for (const symbol of doc.symbols.values()) {
      this.collectFontsFromTimeline(symbol.timeline, fontsToLoad);
    }

    if (fontsToLoad.size === 0) return;

    if (DEBUG) {
      console.log('Fonts to preload:', Array.from(fontsToLoad));
    }

    // Load all fonts in parallel
    const loadPromises: Promise<void>[] = [];
    for (const fontName of fontsToLoad) {
      const googleFontId = this.googleFonts[fontName];
      if (googleFontId && !this.loadedFonts.has(fontName)) {
        loadPromises.push(
          this.loadGoogleFont(fontName, googleFontId)
            .then(() => {
              this.loadedFonts.add(fontName);
              if (DEBUG) console.log(`Font loaded: ${fontName}`);
            })
            .catch((err) => {
              console.warn(`Failed to load font ${fontName}:`, err);
            })
        );
      }
    }

    // Wait for all fonts to load (with timeout)
    if (loadPromises.length > 0) {
      await Promise.race([
        Promise.all(loadPromises),
        new Promise<void>(resolve => setTimeout(resolve, 3000)) // 3 second timeout
      ]);
    }
  }

  // Collect font names from a timeline
  private collectFontsFromTimeline(timeline: Timeline, fonts: Set<string>): void {
    for (const layer of timeline.layers) {
      for (const frame of layer.frames) {
        for (const element of frame.elements) {
          if (element.type === 'text') {
            for (const run of element.textRuns) {
              if (run.face) {
                const webFontName = this.getWebFontName(run.face);
                if (webFontName) {
                  fonts.add(webFontName);
                }
              }
            }
          }
        }
      }
    }
  }

  // Get web font name from FLA font name (without triggering load)
  private getWebFontName(flaFontName: string): string | null {
    const fontMap: Record<string, string> = {
      'PressStart2P-Regular': 'Press Start 2P',
      'PressStart2P': 'Press Start 2P',
    };

    if (fontMap[flaFontName]) {
      return fontMap[flaFontName];
    }

    for (const [key, value] of Object.entries(fontMap)) {
      if (flaFontName.startsWith(key) || key.startsWith(flaFontName)) {
        return value;
      }
    }

    return null;
  }

  // Recalculate and update canvas size based on current settings
  updateCanvasSize(): void {
    if (!this.doc) return;

    this.dpr = window.devicePixelRatio || 1;

    // Determine effective viewport size
    // When following camera, use detected camera viewport size
    const viewportSize = this.getEffectiveViewportSize();

    // Calculate scale to fit canvas while maintaining aspect ratio
    const maxWidth = Math.min(window.innerWidth - 100, 1920);
    const maxHeight = Math.min(window.innerHeight - 300, 1080);

    const scaleX = maxWidth / viewportSize.width;
    const scaleY = maxHeight / viewportSize.height;
    this.scale = Math.min(scaleX, scaleY, 1);

    // Calculate CSS display size
    const displayWidth = viewportSize.width * this.scale;
    const displayHeight = viewportSize.height * this.scale;

    // Set canvas buffer size (scaled by DPR for crisp rendering)
    this.canvas.width = displayWidth * this.dpr;
    this.canvas.height = displayHeight * this.dpr;

    // Set CSS display size
    this.canvas.style.width = `${displayWidth}px`;
    this.canvas.style.height = `${displayHeight}px`;

    if (DEBUG) {
      console.log('Viewport size:', viewportSize.width, 'x', viewportSize.height);
      console.log('Canvas size:', this.canvas.width, 'x', this.canvas.height);
      console.log('Scale:', this.scale, 'DPR:', this.dpr);
    }
  }

  // Get the effective viewport size (camera viewport or full document)
  private getEffectiveViewportSize(): { width: number; height: number } {
    if (!this.doc) return { width: 550, height: 400 };

    // When following camera, try to detect camera viewport size
    if (this.followCamera && this.manualCameraLayerIndex !== undefined) {
      const cameraViewport = this.detectCameraViewportSize();
      if (cameraViewport) {
        return cameraViewport;
      }
    }

    // Default to full document size
    return { width: this.doc.width, height: this.doc.height };
  }

  // Detect camera viewport size from the camera symbol and document dimensions
  private detectCameraViewportSize(): { width: number; height: number } | null {
    if (!this.doc || this.manualCameraLayerIndex === undefined) return null;

    const timeline = this.doc.timelines[this.currentScene];
    if (!timeline) return null;

    const cameraLayer = timeline.layers[this.manualCameraLayerIndex];
    if (!cameraLayer || cameraLayer.frames.length === 0) return null;

    const firstFrame = cameraLayer.frames[0];
    if (firstFrame.elements.length === 0) return null;

    const element = firstFrame.elements[0];
    if (element.type !== 'symbol') return null;

    // Get camera matrix scale (affects viewport size when zooming)
    const matrix = element.matrix;
    const scaleX = Math.sqrt(matrix.a * matrix.a + matrix.b * matrix.b);
    const scaleY = Math.sqrt(matrix.c * matrix.c + matrix.d * matrix.d);

    // Common animation workflow: ultrawide documents (3840x1080) with 1920x1080 output
    // The camera pans across the wide document, but output is standard 16:9
    const docAspect = this.doc.width / this.doc.height;

    let baseWidth: number;
    let baseHeight: number;

    if (docAspect > 2.5) {
      // Ultrawide document (e.g., 3840x1080, aspect ~3.56)
      // Assume standard 16:9 viewport (1920x1080)
      baseHeight = this.doc.height;
      baseWidth = baseHeight * (16 / 9);
    } else if (docAspect > 1.9) {
      // Wide document but not extreme
      // Use height and 16:9 aspect
      baseHeight = this.doc.height;
      baseWidth = baseHeight * (16 / 9);
    } else {
      // Normal aspect ratio - use document size
      baseWidth = this.doc.width;
      baseHeight = this.doc.height;
    }

    // Apply inverse scale for zoom
    const viewportWidth = baseWidth / scaleX;
    const viewportHeight = baseHeight / scaleY;

    if (DEBUG) {
      console.log(`Camera viewport: ${Math.round(viewportWidth)}x${Math.round(viewportHeight)} (doc: ${this.doc.width}x${this.doc.height}, scale: ${scaleX.toFixed(2)})`);
    }

    return {
      width: Math.round(viewportWidth),
      height: Math.round(viewportHeight)
    };
  }

  // Pre-compute all shape paths in the background to warm up cache
  private precomputeShapePaths(doc: FLADocument): void {
    const shapes = this.collectAllShapes(doc);
    if (shapes.length === 0) return;

    if (DEBUG) {
      console.log(`Pre-computing ${shapes.length} shapes...`);
    }

    // Process shapes in batches to avoid blocking UI
    const BATCH_SIZE = 10;
    let index = 0;

    const processBatch = () => {
      const end = Math.min(index + BATCH_SIZE, shapes.length);
      for (let i = index; i < end; i++) {
        this.getOrComputeShapePaths(shapes[i]);
      }
      index = end;

      if (index < shapes.length) {
        // Use requestIdleCallback if available, otherwise setTimeout
        if ('requestIdleCallback' in window) {
          (window as Window & { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(processBatch);
        } else {
          setTimeout(processBatch, 0);
        }
      } else if (DEBUG) {
        console.log(`Pre-computed ${shapes.length} shapes`);
      }
    };

    // Start processing after a short delay to not block initial render
    setTimeout(processBatch, 16);
  }

  // Collect all shapes from document (main timeline + all symbols)
  private collectAllShapes(doc: FLADocument): Shape[] {
    const shapes: Shape[] = [];

    const processTimeline = (timeline: Timeline) => {
      for (const layer of timeline.layers) {
        for (const frame of layer.frames) {
          for (const element of frame.elements) {
            if (element.type === 'shape') {
              shapes.push(element);
            }
          }
        }
      }
    };

    // Process main timeline
    for (const timeline of doc.timelines) {
      processTimeline(timeline);
    }

    // Process all symbols
    for (const symbol of doc.symbols.values()) {
      processTimeline(symbol.timeline);
    }

    return shapes;
  }

  renderFrame(frameIndex: number): void {
    if (!this.doc) return;

    const ctx = this.ctx;
    const doc = this.doc;

    // Clear debug elements for this frame
    if (this.debugMode) {
      this.debugElements = [];
      this.debugSymbolPath = [];
    }

    // Fully reset canvas state
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Get effective viewport size
    const viewport = this.getEffectiveViewportSize();

    // Apply DPR and content scale together
    const combinedScale = this.scale * this.dpr;
    ctx.setTransform(combinedScale, 0, 0, combinedScale, 0, 0);

    // Fill with background color (fill the viewport area)
    ctx.fillStyle = doc.backgroundColor;
    ctx.fillRect(0, 0, viewport.width, viewport.height);

    // Render current scene's timeline
    if (doc.timelines.length > this.currentScene) {
      this.renderTimelineWithCamera(doc.timelines[this.currentScene], frameIndex, viewport);
    }
  }

  // Render timeline with proper camera handling
  private renderTimelineWithCamera(
    timeline: Timeline,
    frameIndex: number,
    viewport: { width: number; height: number }
  ): void {
    const ctx = this.ctx;

    // Check if we're following camera
    if (this.followCamera && this.manualCameraLayerIndex !== undefined) {
      const cameraLayer = timeline.layers[this.manualCameraLayerIndex];
      if (cameraLayer) {
        const cameraElement = this.getCameraElement(cameraLayer, frameIndex);
        if (cameraElement) {
          ctx.save();

          // The camera symbol's transformation point is the pivot/center of the viewport frame
          // The matrix tx/ty positions the symbol's origin on the document
          // The actual camera center on the document is: tx + transformationPoint.x, ty + transformationPoint.y

          const matrix = cameraElement.matrix;
          const tp = cameraElement.transformationPoint || { x: 0, y: 0 };

          const scaleX = Math.sqrt(matrix.a * matrix.a + matrix.b * matrix.b);
          const scaleY = Math.sqrt(matrix.c * matrix.c + matrix.d * matrix.d);

          // Camera center in document coordinates
          const cameraCenterX = matrix.tx + tp.x * scaleX;
          const cameraCenterY = matrix.ty + tp.y * scaleY;

          // Viewport center
          const viewportCenterX = viewport.width / 2;
          const viewportCenterY = viewport.height / 2;

          if (DEBUG) {
            console.log(`Camera: center=(${cameraCenterX.toFixed(1)}, ${cameraCenterY.toFixed(1)}), scale=(${scaleX.toFixed(3)}, ${scaleY.toFixed(3)}), tp=(${tp.x}, ${tp.y})`);
          }

          // Transform: move camera center to viewport center, apply inverse scale
          ctx.translate(viewportCenterX, viewportCenterY);
          ctx.scale(1 / scaleX, 1 / scaleY);
          ctx.translate(-cameraCenterX, -cameraCenterY);

          // Render all layers except camera
          this.renderTimelineLayers(timeline, frameIndex, 0, this.manualCameraLayerIndex);

          ctx.restore();
          return;
        }
      }
    }

    // Normal rendering (no camera following)
    this.renderTimeline(timeline, frameIndex);
  }

  // Render timeline layers (extracted for reuse)
  private renderTimelineLayers(
    timeline: Timeline,
    frameIndex: number,
    depth: number,
    skipLayerIndex?: number
  ): void {
    const order = depth === 0 ? this.layerOrder : this.nestedLayerOrder;
    const indices = order === 'reverse'
      ? [...Array(timeline.layers.length).keys()].reverse()
      : [...Array(timeline.layers.length).keys()];

    // Track which layers are masked and their mask layer index
    const maskedLayers = new Map<number, number>(); // masked layer index -> mask layer index
    for (let i = 0; i < timeline.layers.length; i++) {
      const layer = timeline.layers[i];
      if (layer.maskLayerIndex !== undefined) {
        maskedLayers.set(i, layer.maskLayerIndex);
      }
    }

    // Track which masked layers have been rendered (so we don't render them twice)
    const renderedMasked = new Set<number>();

    for (const i of indices) {
      // Skip specified layer (camera layer)
      if (i === skipLayerIndex) continue;

      // Skip hidden layers (only for main timeline, depth 0)
      if (depth === 0 && this.hiddenLayers.has(i)) continue;

      // Skip reference layers
      if (timeline.referenceLayers.has(i)) continue;

      // Skip if already rendered as part of a mask group
      if (renderedMasked.has(i)) continue;

      const layer = timeline.layers[i];
      const layerTypeLower = (layer.layerType as string)?.toLowerCase() || '';
      if (layer.layerType === 'guide' || layerTypeLower === 'guide' ||
          layer.layerType === 'folder' || layerTypeLower === 'folder') {
        continue;
      }

      // Check if this is a mask layer
      if (layer.layerType === 'mask' || layerTypeLower === 'mask') {
        // Find all layers masked by this layer
        const maskedByThis: number[] = [];
        for (const [maskedIdx, maskIdx] of maskedLayers) {
          if (maskIdx === i) {
            maskedByThis.push(maskedIdx);
            renderedMasked.add(maskedIdx);
          }
        }

        if (maskedByThis.length > 0) {
          // Render mask layer with clipping
          this.renderMaskGroup(timeline, frameIndex, depth, i, maskedByThis);
        }
        continue; // Don't render mask layer normally
      }

      // Skip masked layers - they'll be rendered as part of their mask group
      if (maskedLayers.has(i)) {
        continue;
      }

      this.renderLayer(layer, frameIndex, depth, i);
    }
  }

  // Render a mask layer and its masked children
  private renderMaskGroup(
    timeline: Timeline,
    frameIndex: number,
    depth: number,
    maskLayerIndex: number,
    maskedLayerIndices: number[]
  ): void {
    const ctx = this.ctx;
    const maskLayer = timeline.layers[maskLayerIndex];

    // Find the frame at the current index for the mask layer
    const maskFrame = this.findFrameAtIndex(maskLayer.frames, frameIndex);
    if (!maskFrame || maskFrame.elements.length === 0) {
      // No mask content, just render masked layers normally
      for (const maskedIdx of maskedLayerIndices) {
        const maskedLayer = timeline.layers[maskedIdx];
        if (maskedLayer) {
          this.renderLayer(maskedLayer, frameIndex, depth, maskedIdx);
        }
      }
      return;
    }

    ctx.save();

    // Create clip path from mask layer content
    ctx.beginPath();
    for (const element of maskFrame.elements) {
      if (element.type === 'shape') {
        // Apply shape's matrix
        ctx.save();
        this.applyMatrix(element.matrix);

        // Add shape edges to clip path
        const cached = this.getOrComputeShapePaths(element);
        for (const [, path] of cached.fillPaths) {
          ctx.clip(path, 'nonzero');
        }

        ctx.restore();
      } else if (element.type === 'symbol') {
        // For symbol masks, we need to render the symbol's shapes as clip paths
        // This is a simplified version - complex symbol masks may need more work
        const path = new Path2D();
        path.rect(-10000, -10000, 20000, 20000); // Fallback full rect
        ctx.clip(path);
      }
    }

    // Render masked layers within the clip
    for (const maskedIdx of maskedLayerIndices) {
      const maskedLayer = timeline.layers[maskedIdx];
      if (maskedLayer) {
        this.renderLayer(maskedLayer, frameIndex, depth, maskedIdx);
      }
    }

    ctx.restore();
  }

  private renderTimeline(timeline: Timeline, frameIndex: number, depth: number = 0): void {
    if (depth > 50) return; // Prevent infinite recursion

    const ctx = this.ctx;

    // Determine which camera layer to use (if any)
    // Manual follow camera takes precedence over auto-detected camera
    let activeCameraIndex: number | undefined;
    if (depth === 0) {
      if (this.followCamera && this.manualCameraLayerIndex !== undefined) {
        activeCameraIndex = this.manualCameraLayerIndex;
      } else {
        activeCameraIndex = timeline.cameraLayerIndex;
      }
    }

    // Apply camera transform at root level only
    let hasCameraTransform = false;
    if (depth === 0 && activeCameraIndex !== undefined) {
      const cameraLayer = timeline.layers[activeCameraIndex];
      if (cameraLayer) {
        const cameraTransform = this.getCameraTransform(cameraLayer, frameIndex);
        if (cameraTransform) {
          ctx.save();
          // Apply inverse camera transform to simulate camera movement
          this.applyInverseCameraTransform(cameraTransform);
          hasCameraTransform = true;
        }
      }
    }

    // Render layers based on layerOrder setting (main) or nestedLayerOrder (nested symbols)
    const order = depth === 0 ? this.layerOrder : this.nestedLayerOrder;
    const indices = order === 'reverse'
      ? [...Array(timeline.layers.length).keys()].reverse()  // [len-1, len-2, ..., 0]
      : [...Array(timeline.layers.length).keys()];           // [0, 1, ..., len-1]

    // Track which layers are masked and their mask layer index
    const maskedLayers = new Map<number, number>(); // masked layer index -> mask layer index
    for (let i = 0; i < timeline.layers.length; i++) {
      const layer = timeline.layers[i];
      if (layer.maskLayerIndex !== undefined) {
        maskedLayers.set(i, layer.maskLayerIndex);
      }
    }

    // Track which masked layers have been rendered
    const renderedMasked = new Set<number>();

    for (const i of indices) {
      const layer = timeline.layers[i];

      // Skip camera layer (it's a reference, not rendered content)
      if (i === activeCameraIndex) {
        continue;
      }

      // Skip hidden layers (only for main timeline, depth 0)
      if (depth === 0 && this.hiddenLayers.has(i)) {
        continue;
      }

      // Skip reference layers (guides, camera frames, folders, etc.)
      // These are detected during parsing based on layer type, position, and structure
      if (timeline.referenceLayers.has(i)) {
        continue;
      }

      // Skip if already rendered as part of a mask group
      if (renderedMasked.has(i)) {
        continue;
      }

      // Also skip guide/folder layers that might not have been detected
      const layerTypeLower = (layer.layerType as string)?.toLowerCase() || '';
      const isGuideLayer = layer.layerType === 'guide' || layerTypeLower === 'guide';
      const isFolderLayer = layer.layerType === 'folder' || layerTypeLower === 'folder';

      if (isGuideLayer || isFolderLayer) {
        continue;
      }

      // Check if this is a mask layer
      if (layer.layerType === 'mask' || layerTypeLower === 'mask') {
        // Find all layers masked by this layer
        const maskedByThis: number[] = [];
        for (const [maskedIdx, maskIdx] of maskedLayers) {
          if (maskIdx === i) {
            maskedByThis.push(maskedIdx);
            renderedMasked.add(maskedIdx);
          }
        }

        if (maskedByThis.length > 0) {
          // Render mask layer with clipping
          this.renderMaskGroup(timeline, frameIndex, depth, i, maskedByThis);
        }
        continue; // Don't render mask layer normally
      }

      // Skip masked layers - they'll be rendered as part of their mask group
      if (maskedLayers.has(i)) {
        continue;
      }

      this.renderLayer(layer, frameIndex, depth, i);
    }

    if (hasCameraTransform) {
      ctx.restore();
    }
  }

  private getCameraTransform(cameraLayer: Layer, frameIndex: number): Matrix | null {
    const frame = this.findFrameAtIndex(cameraLayer.frames, frameIndex);
    if (!frame || frame.elements.length === 0) return null;

    // Get the first symbol instance (should be the Ramka/camera symbol)
    const element = frame.elements[0];
    if (element.type !== 'symbol') return null;

    // Check for motion tween interpolation
    if (frame.tweenType === 'motion') {
      const nextKeyframe = this.findNextKeyframe(cameraLayer.frames, frame);
      if (nextKeyframe && nextKeyframe.elements.length > 0) {
        const nextElement = nextKeyframe.elements[0];
        if (nextElement.type === 'symbol') {
          const progress = this.calculateTweenProgress(
            frameIndex,
            frame,
            nextKeyframe,
            frame.acceleration,
            frame.tweens
          );

          // Interpolate camera matrix
          return {
            a: this.lerp(element.matrix.a, nextElement.matrix.a, progress),
            b: this.lerp(element.matrix.b, nextElement.matrix.b, progress),
            c: this.lerp(element.matrix.c, nextElement.matrix.c, progress),
            d: this.lerp(element.matrix.d, nextElement.matrix.d, progress),
            tx: this.lerp(element.matrix.tx, nextElement.matrix.tx, progress),
            ty: this.lerp(element.matrix.ty, nextElement.matrix.ty, progress)
          };
        }
      }
    }

    return element.matrix;
  }

  // Get full camera element with transformation point (for follow camera mode)
  private getCameraElement(cameraLayer: Layer, frameIndex: number): SymbolInstance | null {
    const frame = this.findFrameAtIndex(cameraLayer.frames, frameIndex);
    if (!frame || frame.elements.length === 0) return null;

    const element = frame.elements[0];
    if (element.type !== 'symbol') return null;

    // Check for motion tween interpolation
    if (frame.tweenType === 'motion') {
      const nextKeyframe = this.findNextKeyframe(cameraLayer.frames, frame);
      if (nextKeyframe && nextKeyframe.elements.length > 0) {
        const nextElement = nextKeyframe.elements[0];
        if (nextElement.type === 'symbol') {
          const progress = this.calculateTweenProgress(
            frameIndex,
            frame,
            nextKeyframe,
            frame.acceleration,
            frame.tweens
          );

          // Return interpolated element
          return {
            ...element,
            matrix: {
              a: this.lerp(element.matrix.a, nextElement.matrix.a, progress),
              b: this.lerp(element.matrix.b, nextElement.matrix.b, progress),
              c: this.lerp(element.matrix.c, nextElement.matrix.c, progress),
              d: this.lerp(element.matrix.d, nextElement.matrix.d, progress),
              tx: this.lerp(element.matrix.tx, nextElement.matrix.tx, progress),
              ty: this.lerp(element.matrix.ty, nextElement.matrix.ty, progress)
            }
            // Keep original transformationPoint (pivot doesn't change during tween)
          };
        }
      }
    }

    return element;
  }

  private applyInverseCameraTransform(matrix: Matrix): void {
    // The camera matrix represents where the "camera frame" is positioned
    // To render content from the camera's perspective, we need the inverse transform
    //
    // For a 2D affine matrix [a c tx; b d ty; 0 0 1]:
    // The inverse is [d -c (c*ty - d*tx); -b a (b*tx - a*ty); 0 0 1] / determinant

    const det = matrix.a * matrix.d - matrix.b * matrix.c;
    if (Math.abs(det) < 0.0001) return; // Degenerate matrix

    const invDet = 1 / det;
    const invA = matrix.d * invDet;
    const invB = -matrix.b * invDet;
    const invC = -matrix.c * invDet;
    const invD = matrix.a * invDet;
    const invTx = (matrix.c * matrix.ty - matrix.d * matrix.tx) * invDet;
    const invTy = (matrix.b * matrix.tx - matrix.a * matrix.ty) * invDet;

    this.ctx.transform(invA, invB, invC, invD, invTx, invTy);
  }

  private renderLayer(layer: Layer, frameIndex: number, depth: number, layerIndex?: number): void {
    // Find the frame at the current index
    const frame = this.findFrameAtIndex(layer.frames, frameIndex);
    if (!frame) return;

    // Note: Reference layer filtering (camera frames, guides, etc.) is handled
    // in renderTimeline() using timeline.referenceLayers which is populated
    // by detectReferenceLayers() during parsing. That logic is more accurate
    // because it considers both layer name AND visibility/outline status.

    // Track keyframe start for symbol loop calculations
    this.currentKeyframeStart = frame.index;

    // Check if we need to interpolate (tween)
    const nextKeyframe = this.findNextKeyframe(layer.frames, frame);

    // Get hidden elements for this layer (only for main timeline layers with index)
    const hiddenSet = layerIndex !== undefined ? this.hiddenElements.get(layerIndex) : undefined;

    // Render elements based on elementOrder setting
    const elementIndices = this.elementOrder === 'reverse'
      ? [...Array(frame.elements.length).keys()].reverse()
      : [...Array(frame.elements.length).keys()];

    for (const elementIndex of elementIndices) {
      // Skip hidden elements (only for main timeline, depth 0)
      if (depth === 0 && hiddenSet?.has(elementIndex)) continue;

      const element = frame.elements[elementIndex];

      // Handle shape tweens with morphShape
      if (frame.tweenType === 'shape' && frame.morphShape && element.type === 'shape') {
        // Calculate interpolation progress for shape tween
        const progress = nextKeyframe
          ? this.calculateTweenProgress(
              frameIndex,
              frame,
              nextKeyframe,
              frame.acceleration,
              frame.tweens
            )
          : 0;

        this.renderMorphShape(frame.morphShape, element, progress, depth);
      } else if (frame.tweenType === 'motion' && nextKeyframe && nextKeyframe.elements.length > 0) {
        // Calculate interpolation progress
        const progress = this.calculateTweenProgress(
          frameIndex,
          frame,
          nextKeyframe,
          frame.acceleration,
          frame.tweens
        );

        // Find matching element in next keyframe
        // For symbols, match by libraryItemName; otherwise use same index or first element
        let nextDisplayElement = nextKeyframe.elements[0];
        if (element.type === 'symbol') {
          const matchingElement = nextKeyframe.elements.find(
            (e) => e.type === 'symbol' && e.libraryItemName === element.libraryItemName
          );
          if (matchingElement) {
            nextDisplayElement = matchingElement;
          }
        } else if (elementIndex < nextKeyframe.elements.length) {
          nextDisplayElement = nextKeyframe.elements[elementIndex];
        }

        this.renderDisplayElementWithTween(element, nextDisplayElement, progress, depth, frameIndex, frame, elementIndex);
      } else {
        this.renderDisplayElement(element, depth, frameIndex, elementIndex);
      }
    }
  }

  private findFrameAtIndex(frames: Frame[], index: number): Frame | null {
    for (const frame of frames) {
      if (index >= frame.index && index < frame.index + frame.duration) {
        return frame;
      }
    }
    return null;
  }

  private findNextKeyframe(frames: Frame[], currentFrame: Frame): Frame | null {
    const nextIndex = currentFrame.index + currentFrame.duration;
    for (const frame of frames) {
      if (frame.index === nextIndex) {
        return frame;
      }
    }
    return null;
  }

  private calculateTweenProgress(
    frameIndex: number,
    startFrame: Frame,
    _endFrame: Frame,
    acceleration?: number,
    tweens?: Tween[]
  ): number {
    const frameOffset = frameIndex - startFrame.index;
    // Guard against division by zero (duration should never be 0, but protect anyway)
    let progress = startFrame.duration > 0 ? frameOffset / startFrame.duration : 0;

    // Apply easing
    if (tweens && tweens.length > 0) {
      const tween = tweens[0];
      if (tween.customEase && tween.customEase.length >= 4) {
        progress = this.evaluateBezierEase(progress, tween.customEase);
      } else if (tween.intensity !== undefined) {
        progress = this.applyEaseIntensity(progress, tween.intensity);
      }
    } else if (acceleration !== undefined) {
      progress = this.applyEaseIntensity(progress, acceleration);
    }

    return Math.max(0, Math.min(1, progress));
  }

  private applyEaseIntensity(t: number, intensity: number): number {
    // Intensity: -100 to 100
    // Negative = ease in, Positive = ease out
    if (intensity === 0) return t;

    const strength = Math.abs(intensity) / 100;

    if (intensity < 0) {
      // Ease in (slow start)
      return Math.pow(t, 1 + strength * 2);
    } else {
      // Ease out (slow end)
      return 1 - Math.pow(1 - t, 1 + strength * 2);
    }
  }

  private evaluateBezierEase(t: number, points: Point[]): number {
    // Cubic bezier evaluation
    if (points.length < 4) return t;

    const p0 = points[0];
    const p1 = points[1];
    const p2 = points[2];
    const p3 = points[3];

    // Find t value on x axis using Newton-Raphson
    let x = t;
    for (let i = 0; i < 10; i++) {
      const bx = this.cubicBezier(x, p0.x, p1.x, p2.x, p3.x);
      const dx = this.cubicBezierDerivative(x, p0.x, p1.x, p2.x, p3.x);
      if (Math.abs(dx) < 0.0001) break;
      x = x - (bx - t) / dx;
    }

    return this.cubicBezier(x, p0.y, p1.y, p2.y, p3.y);
  }

  private cubicBezier(t: number, p0: number, p1: number, p2: number, p3: number): number {
    const t2 = t * t;
    const t3 = t2 * t;
    const mt = 1 - t;
    const mt2 = mt * mt;
    const mt3 = mt2 * mt;
    return mt3 * p0 + 3 * mt2 * t * p1 + 3 * mt * t2 * p2 + t3 * p3;
  }

  private cubicBezierDerivative(t: number, p0: number, p1: number, p2: number, p3: number): number {
    const t2 = t * t;
    const mt = 1 - t;
    const mt2 = mt * mt;
    return 3 * mt2 * (p1 - p0) + 6 * mt * t * (p2 - p1) + 3 * t2 * (p3 - p2);
  }

  private renderDisplayElementWithTween(element: DisplayElement, nextDisplayElement: DisplayElement, progress: number, depth: number, parentFrameIndex: number, frame?: Frame, elementIndex: number = 0): void {
    if (element.type === 'symbol' && nextDisplayElement.type === 'symbol') {
      // Interpolate matrix transforms
      const startMatrix = element.matrix;
      const endMatrix = nextDisplayElement.matrix;

      let interpolatedMatrix: Matrix;

      // Check for rotation tween (CW/CCW with additional rotations)
      if (frame?.motionTweenRotate && frame.motionTweenRotate !== 'none') {
        interpolatedMatrix = this.interpolateMatrixWithRotation(
          startMatrix,
          endMatrix,
          progress,
          frame.motionTweenRotate,
          frame.motionTweenRotateTimes || 0
        );
      } else {
        interpolatedMatrix = {
          a: this.lerp(startMatrix.a, endMatrix.a, progress),
          b: this.lerp(startMatrix.b, endMatrix.b, progress),
          c: this.lerp(startMatrix.c, endMatrix.c, progress),
          d: this.lerp(startMatrix.d, endMatrix.d, progress),
          tx: this.lerp(startMatrix.tx, endMatrix.tx, progress),
          ty: this.lerp(startMatrix.ty, endMatrix.ty, progress)
        };
      }

      // Apply orient-to-path rotation if enabled
      if (frame?.motionTweenOrientToPath) {
        interpolatedMatrix = this.applyOrientToPath(
          interpolatedMatrix,
          startMatrix,
          endMatrix
        );
      }

      // Interpolate color transform if either element has one
      const interpolatedColorTransform = this.lerpColorTransform(
        element.colorTransform,
        nextDisplayElement.colorTransform,
        progress
      );

      // Note: Do NOT interpolate firstFrame - it's an offset for the keyframe start,
      // and frameOffset in renderSymbolInstance already handles animation progress.
      // Interpolating firstFrame would cause double-counting and "lagging" animation.
      const tweenedDisplayElement: SymbolInstance = {
        ...element,
        matrix: interpolatedMatrix,
        // firstFrame stays as element.firstFrame (the keyframe's starting offset)
        ...(interpolatedColorTransform && { colorTransform: interpolatedColorTransform })
      };

      this.renderDisplayElement(tweenedDisplayElement, depth, parentFrameIndex, elementIndex);
    } else {
      this.renderDisplayElement(element, depth, parentFrameIndex, elementIndex);
    }
  }

  private interpolateMatrixWithRotation(
    startMatrix: Matrix,
    endMatrix: Matrix,
    progress: number,
    direction: 'cw' | 'ccw',
    additionalRotations: number
  ): Matrix {
    // Decompose matrices into scale, rotation, and translation
    const startScale = Math.sqrt(startMatrix.a * startMatrix.a + startMatrix.b * startMatrix.b);
    const endScale = Math.sqrt(endMatrix.a * endMatrix.a + endMatrix.b * endMatrix.b);

    const startScaleY = Math.sqrt(startMatrix.c * startMatrix.c + startMatrix.d * startMatrix.d);
    const endScaleY = Math.sqrt(endMatrix.c * endMatrix.c + endMatrix.d * endMatrix.d);

    // Extract rotation angle
    let startAngle = Math.atan2(startMatrix.b, startMatrix.a);
    let endAngle = Math.atan2(endMatrix.b, endMatrix.a);

    // Calculate angle difference with direction
    let angleDiff = endAngle - startAngle;

    // Add additional full rotations
    const fullRotation = Math.PI * 2 * additionalRotations;

    if (direction === 'cw') {
      // Clockwise: ensure positive rotation
      if (angleDiff < 0) angleDiff += Math.PI * 2;
      angleDiff += fullRotation;
    } else {
      // Counter-clockwise: ensure negative rotation
      if (angleDiff > 0) angleDiff -= Math.PI * 2;
      angleDiff -= fullRotation;
    }

    // Interpolate
    const angle = startAngle + angleDiff * progress;
    const scaleX = this.lerp(startScale, endScale, progress);
    const scaleY = this.lerp(startScaleY, endScaleY, progress);
    const tx = this.lerp(startMatrix.tx, endMatrix.tx, progress);
    const ty = this.lerp(startMatrix.ty, endMatrix.ty, progress);

    // Reconstruct matrix
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    return {
      a: cos * scaleX,
      b: sin * scaleX,
      c: -sin * scaleY,
      d: cos * scaleY,
      tx,
      ty
    };
  }

  /**
   * Apply orient-to-path rotation to a matrix.
   * Calculates the tangent angle from the motion path and applies additional rotation.
   */
  private applyOrientToPath(
    interpolatedMatrix: Matrix,
    startMatrix: Matrix,
    endMatrix: Matrix
  ): Matrix {
    // Calculate the direction of motion (tangent to the path)
    const dx = endMatrix.tx - startMatrix.tx;
    const dy = endMatrix.ty - startMatrix.ty;

    // Only apply if there's actual movement
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < 0.001) {
      return interpolatedMatrix;
    }

    // Calculate tangent angle (direction of motion)
    const tangentAngle = Math.atan2(dy, dx);

    // Extract current scale from the interpolated matrix
    const scaleX = Math.sqrt(interpolatedMatrix.a * interpolatedMatrix.a + interpolatedMatrix.b * interpolatedMatrix.b);
    const scaleY = Math.sqrt(interpolatedMatrix.c * interpolatedMatrix.c + interpolatedMatrix.d * interpolatedMatrix.d);

    // Extract current rotation
    const currentAngle = Math.atan2(interpolatedMatrix.b, interpolatedMatrix.a);

    // The new angle is the tangent angle plus any existing rotation offset
    // We preserve the relative rotation from the start
    const startAngle = Math.atan2(startMatrix.b, startMatrix.a);
    const rotationOffset = currentAngle - startAngle;
    const newAngle = tangentAngle + rotationOffset;

    // Reconstruct matrix with new rotation
    const cos = Math.cos(newAngle);
    const sin = Math.sin(newAngle);

    return {
      a: cos * scaleX,
      b: sin * scaleX,
      c: -sin * scaleY,
      d: cos * scaleY,
      tx: interpolatedMatrix.tx,
      ty: interpolatedMatrix.ty
    };
  }

  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

  private lerpColorTransform(start: ColorTransform | undefined, end: ColorTransform | undefined, t: number): ColorTransform | undefined {
    // If neither has color transform, return undefined
    if (!start && !end) return undefined;

    // Default values for color transform (identity)
    const defaultCT: ColorTransform = {
      alphaMultiplier: 1,
      redMultiplier: 1,
      greenMultiplier: 1,
      blueMultiplier: 1,
      alphaOffset: 0,
      redOffset: 0,
      greenOffset: 0,
      blueOffset: 0
    };

    const s = start || defaultCT;
    const e = end || defaultCT;

    return {
      alphaMultiplier: this.lerp(s.alphaMultiplier ?? 1, e.alphaMultiplier ?? 1, t),
      redMultiplier: this.lerp(s.redMultiplier ?? 1, e.redMultiplier ?? 1, t),
      greenMultiplier: this.lerp(s.greenMultiplier ?? 1, e.greenMultiplier ?? 1, t),
      blueMultiplier: this.lerp(s.blueMultiplier ?? 1, e.blueMultiplier ?? 1, t),
      alphaOffset: this.lerp(s.alphaOffset ?? 0, e.alphaOffset ?? 0, t),
      redOffset: this.lerp(s.redOffset ?? 0, e.redOffset ?? 0, t),
      greenOffset: this.lerp(s.greenOffset ?? 0, e.greenOffset ?? 0, t),
      blueOffset: this.lerp(s.blueOffset ?? 0, e.blueOffset ?? 0, t)
    };
  }

  private renderDisplayElement(element: DisplayElement, depth: number, parentFrameIndex: number, elementIndex: number = 0): void {
    if (element.type === 'symbol') {
      this.renderSymbolInstance(element, depth, parentFrameIndex, elementIndex);
    } else if (element.type === 'shape') {
      this.renderShape(element, depth);
    } else if (element.type === 'video') {
      this.renderVideoInstance(element, depth);
    } else if (element.type === 'bitmap') {
      this.renderBitmapInstance(element, depth);
    } else if (element.type === 'text') {
      this.renderTextInstance(element, depth);
    }
  }

  private missingSymbols = new Set<string>();
  private currentKeyframeStart: number = 0;  // Track keyframe start for loop calculation

  private renderSymbolInstance(instance: SymbolInstance, depth: number, parentFrameIndex: number, elementIndex: number = 0): void {
    if (!this.doc) return;

    // Skip rendering if instance is explicitly set to invisible
    if (instance.isVisible === false) {
      return;
    }

    const symbol = getWithNormalizedPath(this.doc.symbols, instance.libraryItemName);
    if (!symbol) {
      // Log missing symbols only once
      if (!this.missingSymbols.has(instance.libraryItemName)) {
        this.missingSymbols.add(instance.libraryItemName);
        console.warn('Missing symbol:', JSON.stringify(instance.libraryItemName),
          'Available:', Array.from(this.doc.symbols.keys()).slice(0, 5).map(k => JSON.stringify(k)));
      }
      return;
    }

    const ctx = this.ctx;
    ctx.save();

    // Apply filters if present
    const hasFilters = instance.filters && instance.filters.length > 0;
    if (hasFilters) {
      this.applyFilters(ctx, instance.filters!);
    }

    // Apply color transform if present
    const savedAlpha = ctx.globalAlpha;
    const savedFilter = ctx.filter;
    if (instance.colorTransform) {
      this.applyColorTransform(ctx, instance.colorTransform);
    }

    // Apply blend mode if present
    const savedCompositeOp = ctx.globalCompositeOperation;
    if (instance.blendMode) {
      ctx.globalCompositeOperation = this.mapBlendMode(instance.blendMode);
    }

    // Track symbol path for debugging
    if (this.debugMode) {
      this.debugSymbolPath.push(instance.libraryItemName);
    }

    // Check if symbol has 9-slice scaling grid
    const has9SliceGrid = symbol.scale9Grid !== undefined;

    // Check for 3D transforms
    const has3DTransform = instance.rotationX !== undefined ||
                           instance.rotationY !== undefined ||
                           instance.rotationZ !== undefined ||
                           instance.z !== undefined;

    // Apply transformation matrix (skip if using 9-slice, handled separately)
    // Note: The matrix tx/ty already positions the symbol correctly
    // The transformationPoint is metadata about the pivot, but it's already
    // accounted for in how the matrix was calculated by Flash
    if (!has9SliceGrid) {
      if (has3DTransform) {
        // Apply 3D transform using perspective projection
        this.apply3DTransform(instance);
      } else {
        this.applyMatrix(instance.matrix);
      }
    }

    // Calculate which frame to render based on symbol type and loop mode
    // In Flash:
    // - Graphic symbols: sync with parent timeline based on loop mode
    //   - 'single frame': Always shows the specified firstFrame
    //   - 'loop': Internal timeline advances with parent, loops when done
    //   - 'play once': Internal timeline advances, stops at last frame
    // - MovieClip symbols: play their own timeline independently (use 'play once' for static rendering)
    // - Button symbols: show first frame (up state)
    const firstFrame = instance.firstFrame || 0;
    const lastFrame = instance.lastFrame;
    const totalSymbolFrames = Math.max(1, symbol.timeline.totalFrames);

    // Determine effective frame range
    // If lastFrame is specified, it limits the playback range
    const effectiveLastFrame = lastFrame !== undefined
      ? Math.min(lastFrame, totalSymbolFrames - 1)
      : totalSymbolFrames - 1;
    const frameRange = effectiveLastFrame - firstFrame + 1;

    let symbolFrame: number;

    // MovieClips play independently from parent timeline with their own playhead
    if (instance.symbolType === 'movieclip') {
      // Generate unique instance key for this MovieClip
      const instanceKey = this.generateInstanceKey(instance.libraryItemName, elementIndex);

      // Get or create instance state
      const state = this.getOrCreateMovieClipState(
        instanceKey,
        totalSymbolFrames,
        parentFrameIndex
      );

      // Use the instance's independent playhead
      symbolFrame = state.playhead % totalSymbolFrames;

      // Push this instance onto the path for nested MovieClips
      this.currentInstancePath.push(`${instance.libraryItemName}@${elementIndex}`);
    } else if (instance.symbolType === 'button') {
      // Buttons show first frame (up state) without ActionScript
      symbolFrame = 0;

      // Track button hit area for debug click detection
      if (this.debugMode && symbol.hitAreaFrame !== undefined) {
        const hitAreaPath = this.buildButtonHitAreaPath(symbol, symbol.hitAreaFrame);
        if (hitAreaPath) {
          this.debugElements.push({
            type: 'button-hit-area',
            element: instance,
            path: hitAreaPath,
            transform: ctx.getTransform(),
            depth,
            parentPath: [...this.debugSymbolPath],
            isHitArea: true,
            symbolName: symbol.name
          });
        }
      }
    } else {
      // Graphic symbols sync with parent timeline based on loop mode
      if (instance.loop === 'single frame') {
        // Always show the specified firstFrame
        symbolFrame = firstFrame % totalSymbolFrames;
      } else if (instance.loop === 'loop') {
        // Sync with parent timeline: advance from firstFrame based on parent frame offset
        // Loop within the specified frame range (firstFrame to lastFrame)
        const frameOffset = parentFrameIndex - this.currentKeyframeStart;
        if (lastFrame !== undefined) {
          // Loop within the specified range
          symbolFrame = firstFrame + (frameOffset % frameRange);
        } else {
          symbolFrame = (firstFrame + frameOffset) % totalSymbolFrames;
        }
      } else {
        // 'play once' - advance but clamp at last frame (or effectiveLastFrame)
        const frameOffset = parentFrameIndex - this.currentKeyframeStart;
        symbolFrame = Math.min(firstFrame + frameOffset, effectiveLastFrame);
      }
    }

    // Render symbol's timeline (with 9-slice scaling if applicable)
    if (has9SliceGrid && symbol.scale9Grid) {
      this.renderSymbolWith9Slice(symbol, instance, symbol.scale9Grid, symbolFrame, depth);
    } else if (instance.cacheAsBitmap && symbolFrame === 0) {
      // Use cached bitmap rendering for symbols with cacheAsBitmap enabled
      // Only cache frame 0 to avoid excessive memory usage
      this.renderSymbolFromCache(symbol, instance, depth);
    } else {
      this.renderTimeline(symbol.timeline, symbolFrame, depth + 1);
    }

    // Draw hit area indicator for buttons in debug mode
    if (this.debugMode && instance.symbolType === 'button' && symbol.hitAreaFrame !== undefined) {
      this.drawHitAreaIndicator(symbol, symbol.hitAreaFrame);
    }

    // Pop symbol path for debugging
    if (this.debugMode) {
      this.debugSymbolPath.pop();
    }

    // Pop instance path for MovieClips (for nested MovieClip tracking)
    if (instance.symbolType === 'movieclip') {
      this.currentInstancePath.pop();
    }

    // Clear filters if applied
    if (hasFilters) {
      this.clearFilters(ctx);
    }

    // Restore color transform state
    if (instance.colorTransform) {
      ctx.globalAlpha = savedAlpha;
      ctx.filter = savedFilter;
    }

    // Restore blend mode
    if (instance.blendMode) {
      ctx.globalCompositeOperation = savedCompositeOp;
    }

    ctx.restore();
  }

  /**
   * Build a Path2D from the shapes in a button's hit area frame.
   * The hit area defines the clickable region for the button.
   */
  private buildButtonHitAreaPath(symbol: Symbol, hitAreaFrameIndex: number): Path2D | null {
    const path = new Path2D();
    let hasContent = false;

    // Iterate through all layers to find shapes at the hit area frame
    for (const layer of symbol.timeline.layers) {
      // Skip guide and other non-renderable layers
      if (layer.layerType === 'guide' || layer.layerType === 'folder') {
        continue;
      }

      // Find the frame that contains the hit area frame index
      for (const frame of layer.frames) {
        const frameStart = frame.index;
        const frameEnd = frame.index + frame.duration;

        if (hitAreaFrameIndex >= frameStart && hitAreaFrameIndex < frameEnd) {
          // This frame covers the hit area frame index
          for (const element of frame.elements) {
            if (element.type === 'shape') {
              // Build path from shape edges
              const shapePath = this.buildShapePath(element);
              if (shapePath) {
                path.addPath(shapePath);
                hasContent = true;
              }
            } else if (element.type === 'symbol') {
              // For nested symbols, create a bounding rect approximation
              // This is a simplification - ideally we'd recursively build the path
              const nestedSymbol = this.doc?.symbols.get(element.libraryItemName);
              if (nestedSymbol) {
                // Use a simple rect based on transformation
                const m = element.matrix;
                // Approximate bounds (this is simplified)
                const rect = new Path2D();
                rect.rect(m.tx - 50, m.ty - 50, 100, 100);
                path.addPath(rect);
                hasContent = true;
              }
            }
          }
          break;
        }
      }
    }

    return hasContent ? path : null;
  }

  /**
   * Build a Path2D from a shape's edges (for hit testing).
   */
  private buildShapePath(shape: Shape): Path2D | null {
    const path = new Path2D();
    let hasContent = false;

    for (const edge of shape.edges) {
      // Only include edges that have fill or stroke
      if (edge.fillStyle0 || edge.fillStyle1 || edge.strokeStyle) {
        for (const cmd of edge.commands) {
          switch (cmd.type) {
            case 'M':
              path.moveTo(cmd.x, cmd.y);
              hasContent = true;
              break;
            case 'L':
              path.lineTo(cmd.x, cmd.y);
              break;
            case 'Q':
              path.quadraticCurveTo(cmd.cx!, cmd.cy!, cmd.x, cmd.y);
              break;
            case 'C':
              path.bezierCurveTo(cmd.c1x!, cmd.c1y!, cmd.c2x!, cmd.c2y!, cmd.x, cmd.y);
              break;
            case 'Z':
              path.closePath();
              break;
          }
        }
      }
    }

    return hasContent ? path : null;
  }

  /**
   * Draw a visual indicator showing the button's hit area in debug mode.
   * The hit area is drawn as a semi-transparent cyan overlay.
   */
  private drawHitAreaIndicator(symbol: Symbol, hitAreaFrameIndex: number): void {
    const ctx = this.ctx;
    ctx.save();

    // Draw hit area shapes with semi-transparent cyan fill
    ctx.fillStyle = 'rgba(0, 255, 255, 0.2)';
    ctx.strokeStyle = 'rgba(0, 255, 255, 0.6)';
    ctx.lineWidth = 1;

    // Iterate through all layers to find shapes at the hit area frame
    for (const layer of symbol.timeline.layers) {
      // Skip guide and other non-renderable layers
      if (layer.layerType === 'guide' || layer.layerType === 'folder') {
        continue;
      }

      // Find the frame that contains the hit area frame index
      for (const frame of layer.frames) {
        const frameStart = frame.index;
        const frameEnd = frame.index + frame.duration;

        if (hitAreaFrameIndex >= frameStart && hitAreaFrameIndex < frameEnd) {
          // This frame covers the hit area frame index
          for (const element of frame.elements) {
            if (element.type === 'shape') {
              // Draw the shape's path
              const shapePath = this.buildShapePath(element);
              if (shapePath) {
                ctx.fill(shapePath, 'evenodd');
                ctx.stroke(shapePath);
              }
            }
          }
          break;
        }
      }
    }

    ctx.restore();
  }

  private renderVideoInstance(video: VideoInstance, depth: number = 0): void {
    const ctx = this.ctx;
    ctx.save();

    // Apply transformation
    this.applyMatrix(video.matrix);

    // Create path for hit testing
    if (this.debugMode) {
      const path = new Path2D();
      path.rect(0, 0, video.width, video.height);
      this.debugElements.push({
        type: 'video',
        element: video,
        path,
        transform: ctx.getTransform(),
        depth,
        parentPath: [...this.debugSymbolPath]
      });
    }

    // Render placeholder rectangle for video
    ctx.fillStyle = '#333333';
    ctx.fillRect(0, 0, video.width, video.height);

    // Draw video icon/indicator
    ctx.strokeStyle = '#666666';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, video.width, video.height);

    // Draw play button triangle
    const centerX = video.width / 2;
    const centerY = video.height / 2;
    const size = Math.min(video.width, video.height) * 0.2;

    ctx.fillStyle = '#888888';
    ctx.beginPath();
    ctx.moveTo(centerX - size / 2, centerY - size);
    ctx.lineTo(centerX - size / 2, centerY + size);
    ctx.lineTo(centerX + size, centerY);
    ctx.closePath();
    ctx.fill();

    // Draw video name and metadata if space permits
    if (video.width > 100 && video.height > 60) {
      ctx.fillStyle = '#AAAAAA';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';

      // Show video name
      const displayName = video.libraryItemName.length > 30
        ? video.libraryItemName.substring(0, 27) + '...'
        : video.libraryItemName;
      ctx.fillText(displayName, centerX, 8);

      // Show video info from metadata if available
      if (this.doc) {
        const videoItem = this.doc.videos.get(video.libraryItemName);
        if (videoItem) {
          const info: string[] = [];
          if (videoItem.width && videoItem.height) {
            info.push(`${videoItem.width}×${videoItem.height}`);
          }
          if (videoItem.fps) {
            info.push(`${videoItem.fps}fps`);
          }
          if (videoItem.duration) {
            info.push(`${videoItem.duration.toFixed(1)}s`);
          }
          if (info.length > 0) {
            ctx.fillText(info.join(' • '), centerX, video.height - 20);
          }

          // Show FLV codec info if available
          if (videoItem.flvData) {
            const flvInfo: string[] = [];
            if (videoItem.flvData.videoCodec) {
              flvInfo.push(videoItem.flvData.videoCodec);
            }
            if (videoItem.flvData.audioCodec) {
              flvInfo.push(videoItem.flvData.audioCodec);
            }
            if (flvInfo.length > 0) {
              ctx.fillText(flvInfo.join(' + '), centerX, video.height - 36);
            }
          }
        }
      }
    }

    ctx.restore();
  }

  private renderBitmapInstance(bitmap: BitmapInstance, depth: number = 0): void {
    if (!this.doc) return;

    if (DEBUG) {
      console.log('renderBitmap:', bitmap.libraryItemName);
    }

    const ctx = this.ctx;
    ctx.save();

    // Apply transformation
    this.applyMatrix(bitmap.matrix);

    // Look up bitmap item from library
    const bitmapItem = getWithNormalizedPath(this.doc.bitmaps, bitmap.libraryItemName);

    // Create path for hit testing
    if (this.debugMode) {
      const path = new Path2D();
      // Use actual image dimensions if available, otherwise fall back to BitmapItem dimensions
      const img = bitmapItem?.imageData;
      const width = img ? (img.naturalWidth || img.width) : (bitmapItem?.width || 100);
      const height = img ? (img.naturalHeight || img.height) : (bitmapItem?.height || 100);
      path.rect(0, 0, width, height);
      this.debugElements.push({
        type: 'bitmap',
        element: bitmap,
        path,
        transform: ctx.getTransform(),
        depth,
        parentPath: [...this.debugSymbolPath]
      });
    }

    if (bitmapItem && bitmapItem.imageData) {
      // If we have loaded image data, draw it at its natural dimensions
      // The actual image may be smaller than BitmapItem dimensions due to FLA format quirks
      const img = bitmapItem.imageData;
      ctx.drawImage(img, 0, 0, img.naturalWidth || img.width, img.naturalHeight || img.height);
    } else if (bitmapItem) {
      // Bitmap exists but imageData failed to load (e.g., corrupted data)
      // Skip drawing placeholder to avoid visual artifacts - just log in debug mode
      if (DEBUG) {
        console.log('Skipping bitmap (no imageData):', bitmap.libraryItemName, bitmapItem.width, 'x', bitmapItem.height);
      }
      // Don't draw gray placeholder - it creates visual artifacts
    } else {
      // No bitmap info at all - skip silently
      if (DEBUG) {
        console.log('Skipping missing bitmap:', bitmap.libraryItemName);
      }
      // Don't draw placeholder
    }

    ctx.restore();
  }

  private renderTextInstance(text: TextInstance, depth: number = 0): void {
    const ctx = this.ctx;
    ctx.save();

    // Apply filters if present
    const hasFilters = text.filters && text.filters.length > 0;
    if (hasFilters) {
      this.applyFilters(ctx, text.filters!);
    }

    // Apply transformation
    this.applyMatrix(text.matrix);

    // Create path for hit testing (text bounding box)
    if (this.debugMode) {
      const path = new Path2D();
      path.rect(text.left, 0, text.width, text.height);
      this.debugElements.push({
        type: 'text',
        element: text,
        path,
        transform: ctx.getTransform(),
        depth,
        parentPath: [...this.debugSymbolPath]
      });
    }

    // Render each text run
    let yOffset = 0;
    let isFirstParagraph = true;

    for (const run of text.textRuns) {
      // Build font string
      const fontStyle = run.italic ? 'italic ' : '';
      const fontWeight = run.bold ? 'bold ' : '';
      let fontSize = run.size;

      // Adjust font size for subscript/superscript
      if (run.characterPosition === 'subscript' || run.characterPosition === 'superscript') {
        fontSize = fontSize * 0.7; // Smaller for sub/super
      }

      // Map FLA font names to web font names
      const fontFace = this.mapFontName(run.face || 'sans-serif');
      ctx.font = `${fontStyle}${fontWeight}${fontSize}px ${fontFace}, sans-serif`;
      ctx.fillStyle = run.fillColor;
      ctx.textBaseline = 'top';

      // Split by line breaks first
      const paragraphs = run.characters.split(/\r|\n/);
      const lineHeight = run.lineHeight || run.size * 1.2;

      // Letter spacing (default 0, can be negative to compress)
      const letterSpacing = run.letterSpacing || 0;

      // Margins (in twips, convert to pixels by dividing by 20)
      const leftMargin = (run.leftMargin || 0) / 20;
      const rightMargin = (run.rightMargin || 0) / 20;
      const indent = (run.indent || 0) / 20;

      // Calculate effective width for wrapping
      const effectiveWidth = text.width - leftMargin - rightMargin;

      for (let paraIndex = 0; paraIndex < paragraphs.length; paraIndex++) {
        const paragraph = paragraphs[paraIndex];
        if (paragraph.length === 0) {
          yOffset += lineHeight;
          isFirstParagraph = false;
          continue;
        }

        // Word wrap within effective width
        const wrappedLines = this.wrapText(ctx, paragraph, effectiveWidth - (isFirstParagraph ? indent : 0), letterSpacing);

        for (let lineIndex = 0; lineIndex < wrappedLines.length; lineIndex++) {
          const line = wrappedLines[lineIndex];
          // Calculate line width for alignment
          const lineWidth = this.measureTextWidth(ctx, line, letterSpacing);

          // Calculate x position based on alignment with margins
          let xPos = text.left + leftMargin;

          // Apply indent only to first line of first paragraph
          if (lineIndex === 0 && isFirstParagraph && indent > 0) {
            xPos += indent;
          }

          if (run.alignment === 'center') {
            xPos = text.left + leftMargin + (effectiveWidth - lineWidth) / 2;
          } else if (run.alignment === 'right') {
            xPos = text.left + leftMargin + effectiveWidth - lineWidth;
          }

          // Calculate y position with subscript/superscript offset
          let renderY = yOffset;
          if (run.characterPosition === 'subscript') {
            renderY += run.size * 0.3; // Move down for subscript
          } else if (run.characterPosition === 'superscript') {
            renderY -= run.size * 0.2; // Move up for superscript
          }

          // Render with letter spacing, kerning, and rotation
          this.renderTextWithSpacing(ctx, line, xPos, renderY, letterSpacing, run.autoKern, run.rotation);

          // Render underline if enabled
          if (run.underline) {
            ctx.save();
            ctx.strokeStyle = run.fillColor;
            ctx.lineWidth = Math.max(1, fontSize / 12);
            const underlineY = renderY + fontSize + 2;
            ctx.beginPath();
            ctx.moveTo(xPos, underlineY);
            ctx.lineTo(xPos + lineWidth, underlineY);
            ctx.stroke();
            ctx.restore();
          }

          yOffset += lineHeight;
        }

        isFirstParagraph = false;
      }
    }

    // Clear filters if applied
    if (hasFilters) {
      this.clearFilters(ctx);
    }

    ctx.restore();
  }

  // Word wrap text to fit within maxWidth
  private wrapText(
    ctx: CanvasRenderingContext2D,
    text: string,
    maxWidth: number,
    letterSpacing: number
  ): string[] {
    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine ? currentLine + ' ' + word : word;
      const testWidth = this.measureTextWidth(ctx, testLine, letterSpacing);

      if (testWidth > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    return lines.length > 0 ? lines : [''];
  }

  // Measure text width including letter spacing
  private measureTextWidth(ctx: CanvasRenderingContext2D, text: string, letterSpacing: number): number {
    if (letterSpacing === 0) {
      return ctx.measureText(text).width;
    }
    // For custom letter spacing, measure each character
    let width = 0;
    for (let i = 0; i < text.length; i++) {
      width += ctx.measureText(text[i]).width;
      if (i < text.length - 1) {
        width += letterSpacing;
      }
    }
    return width;
  }

  // Render text character by character with letter spacing, kerning, and rotation
  private renderTextWithSpacing(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    letterSpacing: number,
    autoKern?: boolean,
    rotation?: number
  ): void {
    // If no special effects, use fast path
    if (letterSpacing === 0 && !autoKern && !rotation) {
      ctx.fillText(text, x, y);
      return;
    }

    // Render each character with spacing, kerning, and rotation
    let currentX = x;

    // Common kerning pairs (approximated values)
    // These are rough approximations since we can't access actual font kerning tables
    const kerningPairs: Record<string, number> = {
      'AV': -0.08, 'AW': -0.06, 'AY': -0.08, 'AT': -0.08,
      'AO': -0.03, 'AC': -0.03, 'AG': -0.03, 'AQ': -0.03,
      'FA': -0.06, 'FO': -0.03, 'LT': -0.08, 'LV': -0.08,
      'LW': -0.06, 'LY': -0.08, 'PA': -0.06, 'TA': -0.08,
      'TO': -0.06, 'TR': -0.04, 'Tr': -0.06, 'Tu': -0.04,
      'Tw': -0.04, 'Ty': -0.04, 'VA': -0.08, 'Ve': -0.03,
      'Vo': -0.03, 'WA': -0.06, 'We': -0.03, 'Wo': -0.03,
      'YA': -0.08, 'Ye': -0.04, 'Yo': -0.04, 'av': -0.03,
      'aw': -0.02, 'ay': -0.03, 'fa': -0.02, 'fe': -0.02,
      'fo': -0.02, 'ov': -0.02, 'ow': -0.02, 'oy': -0.02,
      'va': -0.03, 've': -0.02, 'vo': -0.02, 'wa': -0.02,
      'we': -0.02, 'wo': -0.02, 'ya': -0.02, 'ye': -0.02, 'yo': -0.02
    };

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const charWidth = ctx.measureText(char).width;

      if (rotation) {
        // Apply per-character rotation
        ctx.save();
        const charCenterX = currentX + charWidth / 2;
        ctx.translate(charCenterX, y);
        ctx.rotate(rotation * Math.PI / 180);
        ctx.fillText(char, -charWidth / 2, 0);
        ctx.restore();
      } else {
        ctx.fillText(char, currentX, y);
      }

      // Calculate next position
      let advance = charWidth + letterSpacing;

      // Apply kerning adjustment if enabled
      if (autoKern && i < text.length - 1) {
        const pair = char + text[i + 1];
        const kernValue = kerningPairs[pair];
        if (kernValue !== undefined) {
          // Kerning value is a fraction of the font size
          const fontSize = parseFloat(ctx.font);
          advance += kernValue * fontSize;
        }
      }

      currentX += advance;
    }
  }

  // Track loaded fonts to avoid duplicate loading
  private loadedFonts = new Set<string>();
  private loadingFonts = new Map<string, Promise<void>>();

  // Google Fonts that can be loaded dynamically
  private googleFonts: Record<string, string> = {
    'Press Start 2P': 'Press+Start+2P',
  };

  // Map FLA font names to web-compatible font names
  private mapFontName(flaFontName: string): string {
    // Common font name mappings from FLA to web fonts
    const fontMap: Record<string, string> = {
      'PressStart2P-Regular': 'Press Start 2P',
      'PressStart2P': 'Press Start 2P',
      'Arial': 'Arial',
      'Arial-BoldMT': 'Arial',
      'ArialMT': 'Arial',
      'Times New Roman': 'Times New Roman',
      'TimesNewRomanPSMT': 'Times New Roman',
      'Courier New': 'Courier New',
      'CourierNewPSMT': 'Courier New',
      'Verdana': 'Verdana',
      'Georgia': 'Georgia',
      'Impact': 'Impact',
      'Comic Sans MS': 'Comic Sans MS',
    };

    // Check for exact match
    if (fontMap[flaFontName]) {
      const webFontName = fontMap[flaFontName];
      this.ensureFontLoaded(webFontName);
      return `"${webFontName}"`;
    }

    // Try to find partial match (font family without style suffix)
    for (const [key, value] of Object.entries(fontMap)) {
      if (flaFontName.startsWith(key) || key.startsWith(flaFontName)) {
        this.ensureFontLoaded(value);
        return `"${value}"`;
      }
    }

    // Return quoted font name as-is
    return `"${flaFontName}"`;
  }

  // Dynamically load a font if it's a Google Font
  private ensureFontLoaded(fontName: string): void {
    // Skip if already loaded or loading
    if (this.loadedFonts.has(fontName) || this.loadingFonts.has(fontName)) {
      return;
    }

    // Check if it's a Google Font we can load
    const googleFontId = this.googleFonts[fontName];
    if (!googleFontId) {
      return; // Not a known Google Font, skip
    }

    // Start loading the font
    const loadPromise = this.loadGoogleFont(fontName, googleFontId);
    this.loadingFonts.set(fontName, loadPromise);

    loadPromise.then(() => {
      this.loadedFonts.add(fontName);
      this.loadingFonts.delete(fontName);
      if (DEBUG) {
        console.log(`Font loaded: ${fontName}`);
      }
    }).catch((err) => {
      console.warn(`Failed to load font ${fontName}:`, err);
      this.loadingFonts.delete(fontName);
    });
  }

  // Load a Google Font dynamically
  private async loadGoogleFont(fontName: string, googleFontId: string): Promise<void> {
    const url = `https://fonts.googleapis.com/css2?family=${googleFontId}&display=swap`;

    // Create and inject stylesheet link
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    document.head.appendChild(link);

    // Wait for font to be ready
    return document.fonts.ready.then(() => {
      // Check if the font is actually available
      return document.fonts.load(`16px "${fontName}"`).then(() => {});
    });
  }

  private renderShape(shape: Shape, depth: number = 0): void {
    const ctx = this.ctx;
    ctx.save();

    // Apply shape's transformation matrix
    this.applyMatrix(shape.matrix);

    // Build fill style lookup
    const fillStyles = new Map<number, FillStyle>();
    for (const fill of shape.fills) {
      fillStyles.set(fill.index, fill);
    }

    // Build stroke style lookup
    const strokeStyles = new Map<number, StrokeStyle>();
    for (const stroke of shape.strokes) {
      strokeStyles.set(stroke.index, stroke);
    }

    // Get cached paths or compute them
    const cached = this.getOrComputeShapePaths(shape);
    const { fillPaths, strokePaths, combinedPath } = cached;

    // Capture debug element before rendering
    if (this.debugMode) {
      this.debugElements.push({
        type: 'shape',
        element: shape,
        path: combinedPath,
        transform: ctx.getTransform(),
        depth,
        parentPath: [...this.debugSymbolPath],
        fillStyles,
        strokeStyles,
        edges: shape.edges
      });
    }

    // Render filled paths - sort by style index for consistent ordering
    const sortedFillStyles = Array.from(fillPaths.entries()).sort((a, b) => a[0] - b[0]);

    for (const [styleIndex, path] of sortedFillStyles) {
      const fill = fillStyles.get(styleIndex);
      if (fill) {
        ctx.fillStyle = this.getFillStyle(fill);
        // Use nonzero fill rule - evenodd can create holes with overlapping subpaths
        ctx.fill(path, 'nonzero');
      }
    }

    // Render stroked paths
    const sortedStrokeStyles = Array.from(strokePaths.entries()).sort((a, b) => a[0] - b[0]);

    for (const [styleIndex, path] of sortedStrokeStyles) {
      const stroke = strokeStyles.get(styleIndex);
      if (stroke) {
        ctx.strokeStyle = this.getStrokeStyle(stroke);
        ctx.lineWidth = stroke.weight;
        ctx.lineCap = stroke.caps === 'none' ? 'butt' : stroke.caps || 'round';
        ctx.lineJoin = stroke.joints || 'round';
        // Apply miter limit (Flash default is 3)
        ctx.miterLimit = stroke.miterLimit ?? 3;
        ctx.stroke(path);
      }
    }

    ctx.restore();
  }

  // Compute and cache shape paths (expensive operation done once per shape)
  private getOrComputeShapePaths(shape: Shape): CachedShapePaths {
    // Check cache first
    const cached = this.shapePathCache.get(shape);
    if (cached) {
      return cached;
    }

    // Compute paths (this is the expensive part)
    const combinedPath = new Path2D();
    const fillEdgeContributions = new Map<number, { commands: PathCommand[], startX: number, startY: number, endX: number, endY: number }[]>();

    for (const edge of shape.edges) {
      // Add to combined path for hit testing
      const path = this.edgeToPath(edge);
      combinedPath.addPath(path);

      // Split edge commands into segments (at internal MoveTo commands that create gaps)
      const segments: PathCommand[][] = [];
      let currentSegment: PathCommand[] = [];
      let lastEndX = NaN;
      let lastEndY = NaN;
      const SPLIT_EPSILON = 0.5;

      for (const cmd of edge.commands) {
        if (cmd.type === 'M') {
          const isContinuous = !Number.isNaN(lastEndX) &&
            Math.abs(cmd.x - lastEndX) <= SPLIT_EPSILON &&
            Math.abs(cmd.y - lastEndY) <= SPLIT_EPSILON;

          if (isContinuous) {
            currentSegment.push(cmd);
          } else {
            if (currentSegment.length > 0) {
              const hasDrawing = currentSegment.some(c => c.type !== 'M');
              if (hasDrawing) {
                segments.push(currentSegment);
              }
            }
            currentSegment = [cmd];
          }
          lastEndX = cmd.x;
          lastEndY = cmd.y;
        } else {
          currentSegment.push(cmd);
          if ('x' in cmd && Number.isFinite(cmd.x)) {
            lastEndX = cmd.x;
            lastEndY = cmd.y;
          }
        }
      }
      if (currentSegment.length > 0) {
        const hasDrawing = currentSegment.some(c => c.type !== 'M');
        if (hasDrawing) {
          segments.push(currentSegment);
        }
      }

      // Process each segment as a separate contribution
      for (const segmentCmds of segments) {
        const startPoint = this.getFirstPoint(segmentCmds);
        const endPoint = this.getLastPoint(segmentCmds);
        if (!startPoint || !endPoint) continue;

        // Skip edges where fillStyle0 === fillStyle1 - these are internal lines
        // within a filled region, not boundary edges
        const isInternalEdge = edge.fillStyle0 !== undefined &&
                               edge.fillStyle1 !== undefined &&
                               edge.fillStyle0 === edge.fillStyle1;

        if (edge.fillStyle1 !== undefined && !isInternalEdge) {
          if (!fillEdgeContributions.has(edge.fillStyle1)) {
            fillEdgeContributions.set(edge.fillStyle1, []);
          }
          fillEdgeContributions.get(edge.fillStyle1)!.push({
            commands: segmentCmds,
            startX: startPoint.x,
            startY: startPoint.y,
            endX: endPoint.x,
            endY: endPoint.y
          });
        }

        if (edge.fillStyle0 !== undefined && edge.fillStyle0 !== edge.fillStyle1) {
          if (!fillEdgeContributions.has(edge.fillStyle0)) {
            fillEdgeContributions.set(edge.fillStyle0, []);
          }
          const reversedCmds = this.reverseCommands(segmentCmds);
          fillEdgeContributions.get(edge.fillStyle0)!.push({
            commands: reversedCmds,
            startX: endPoint.x,
            startY: endPoint.y,
            endX: startPoint.x,
            endY: startPoint.y
          });
        }
      }
    }

    // Build fill paths by sorting edges into connected chains
    const fillPaths = new Map<number, Path2D>();
    const EPSILON = 8.0;

    for (const [styleIndex, contributions] of fillEdgeContributions) {
      const path = new Path2D();
      const sortedContributions = this.sortEdgeContributions(contributions, EPSILON);

      let currentX = NaN;
      let currentY = NaN;
      let subpathStartX = NaN;
      let subpathStartY = NaN;

      for (let i = 0; i < sortedContributions.length; i++) {
        const contrib = sortedContributions[i];
        const isNewSubpath = Number.isNaN(currentX) ||
            Math.abs(contrib.startX - currentX) > EPSILON ||
            Math.abs(contrib.startY - currentY) > EPSILON;

        if (isNewSubpath && !Number.isNaN(subpathStartX)) {
          const atStart = Math.abs(currentX - subpathStartX) <= EPSILON &&
                          Math.abs(currentY - subpathStartY) <= EPSILON;
          if (!atStart) {
            path.lineTo(subpathStartX, subpathStartY);
          }
          path.closePath();
        }

        if (isNewSubpath) {
          path.moveTo(contrib.startX, contrib.startY);
          subpathStartX = contrib.startX;
          subpathStartY = contrib.startY;
        }

        for (const cmd of contrib.commands) {
          if (cmd.type === 'M') continue;
          this.addCommandToPath(path, cmd);
        }

        currentX = contrib.endX;
        currentY = contrib.endY;
      }

      if (!Number.isNaN(subpathStartX)) {
        const atStart = Math.abs(currentX - subpathStartX) <= EPSILON &&
                        Math.abs(currentY - subpathStartY) <= EPSILON;
        if (!atStart) {
          path.lineTo(subpathStartX, subpathStartY);
        }
        path.closePath();
      }

      fillPaths.set(styleIndex, path);
    }

    // Handle strokes separately (they don't need sorting)
    const strokePaths = new Map<number, Path2D>();
    for (const edge of shape.edges) {
      if (edge.strokeStyle !== undefined) {
        if (!strokePaths.has(edge.strokeStyle)) {
          strokePaths.set(edge.strokeStyle, new Path2D());
        }
        strokePaths.get(edge.strokeStyle)!.addPath(this.edgeToPath(edge));
      }
    }

    // Cache the result
    const result: CachedShapePaths = { fillPaths, strokePaths, combinedPath };
    this.shapePathCache.set(shape, result);
    return result;
  }

  private edgeToPath(edge: Edge): Path2D {
    const path = new Path2D();
    let currentX = NaN;
    let currentY = NaN;
    const EPSILON = 0.5; // Tolerance for considering points as same

    for (const cmd of edge.commands) {
      // Skip commands with invalid coordinates
      if ('x' in cmd && (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y))) {
        continue;
      }

      switch (cmd.type) {
        case 'M':
          // Skip redundant moveTo to same position
          if (Number.isNaN(currentX) || Math.abs(cmd.x - currentX) > EPSILON || Math.abs(cmd.y - currentY) > EPSILON) {
            path.moveTo(cmd.x, cmd.y);
          }
          currentX = cmd.x;
          currentY = cmd.y;
          break;
        case 'L':
          // Only draw line if it's not to the same point
          if (Math.abs(cmd.x - currentX) > EPSILON || Math.abs(cmd.y - currentY) > EPSILON) {
            path.lineTo(cmd.x, cmd.y);
          }
          currentX = cmd.x;
          currentY = cmd.y;
          break;
        case 'Q':
          if (!Number.isFinite(cmd.cx) || !Number.isFinite(cmd.cy)) continue;
          path.quadraticCurveTo(cmd.cx, cmd.cy, cmd.x, cmd.y);
          currentX = cmd.x;
          currentY = cmd.y;
          break;
        case 'C':
          if (!Number.isFinite(cmd.c1x) || !Number.isFinite(cmd.c1y) ||
              !Number.isFinite(cmd.c2x) || !Number.isFinite(cmd.c2y)) continue;
          path.bezierCurveTo(cmd.c1x, cmd.c1y, cmd.c2x, cmd.c2y, cmd.x, cmd.y);
          currentX = cmd.x;
          currentY = cmd.y;
          break;
        case 'Z':
          path.closePath();
          break;
      }
    }

    return path;
  }

  // Get the last point from a command list
  private getLastPoint(commands: PathCommand[]): { x: number; y: number } | null {
    for (let i = commands.length - 1; i >= 0; i--) {
      const cmd = commands[i];
      if ('x' in cmd && Number.isFinite(cmd.x) && Number.isFinite(cmd.y)) {
        return { x: cmd.x, y: cmd.y };
      }
    }
    return null;
  }

  // Reverse commands for fillStyle0 (left-side fill)
  private reverseCommands(commands: PathCommand[]): PathCommand[] {
    const points: { x: number; y: number; type: string; cx?: number; cy?: number; c1x?: number; c1y?: number; c2x?: number; c2y?: number }[] = [];

    for (const cmd of commands) {
      if (cmd.type === 'M' || cmd.type === 'L') {
        points.push({ x: cmd.x, y: cmd.y, type: cmd.type });
      } else if (cmd.type === 'Q') {
        points.push({ x: cmd.x, y: cmd.y, type: 'Q', cx: cmd.cx, cy: cmd.cy });
      } else if (cmd.type === 'C') {
        points.push({ x: cmd.x, y: cmd.y, type: 'C', c1x: cmd.c1x, c1y: cmd.c1y, c2x: cmd.c2x, c2y: cmd.c2y });
      }
    }

    if (points.length === 0) return [];

    const result: PathCommand[] = [];
    const lastPoint = points[points.length - 1];
    result.push({ type: 'M', x: lastPoint.x, y: lastPoint.y });

    for (let i = points.length - 1; i > 0; i--) {
      const current = points[i];
      const prev = points[i - 1];

      if (current.type === 'L' || current.type === 'M') {
        result.push({ type: 'L', x: prev.x, y: prev.y });
      } else if (current.type === 'Q' && current.cx !== undefined && current.cy !== undefined) {
        result.push({ type: 'Q', cx: current.cx, cy: current.cy, x: prev.x, y: prev.y });
      } else if (current.type === 'C' && current.c1x !== undefined) {
        result.push({ type: 'C', c1x: current.c2x!, c1y: current.c2y!, c2x: current.c1x, c2y: current.c1y!, x: prev.x, y: prev.y });
      }
    }

    return result;
  }

  // Get the first point from a command list
  private getFirstPoint(commands: PathCommand[]): { x: number; y: number } | null {
    for (const cmd of commands) {
      if ('x' in cmd && Number.isFinite(cmd.x) && Number.isFinite(cmd.y)) {
        return { x: cmd.x, y: cmd.y };
      }
    }
    return null;
  }

  // Sort edge contributions to form connected chains
  // This resolves the "edge soup" problem in Flash shapes
  private sortEdgeContributions(
    contributions: { commands: PathCommand[], startX: number, startY: number, endX: number, endY: number }[],
    epsilon: number
  ): { commands: PathCommand[], startX: number, startY: number, endX: number, endY: number }[] {
    if (contributions.length <= 1) return contributions;

    const result: typeof contributions = [];
    const used = new Set<number>();

    // Track chain starts for better loop closing
    let chainStartX = contributions[0].startX;
    let chainStartY = contributions[0].startY;

    // Start with the first contribution
    let current = contributions[0];
    result.push(current);
    used.add(0);

    // Extended epsilon for closing chains (allow larger gaps to close loops)
    const closeEpsilon = epsilon * 3;

    // Greedily find connected contributions
    while (used.size < contributions.length) {
      let bestIdx = -1;
      let bestDist = Infinity;

      // Look for the BEST (closest) contribution that starts where the current one ends
      for (let i = 0; i < contributions.length; i++) {
        if (used.has(i)) continue;

        const candidate = contributions[i];
        const dx = Math.abs(candidate.startX - current.endX);
        const dy = Math.abs(candidate.startY - current.endY);
        const dist = dx + dy; // Manhattan distance

        if (dx <= epsilon && dy <= epsilon && dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }

      if (bestIdx >= 0) {
        // Found a connection
        current = contributions[bestIdx];
        result.push(current);
        used.add(bestIdx);
      } else {
        // No direct continuation found - try to find a contribution that could help close the loop
        // Look for contribution that starts near current end AND ends near chain start
        let closingIdx = -1;
        let closingDist = Infinity;

        for (let i = 0; i < contributions.length; i++) {
          if (used.has(i)) continue;

          const candidate = contributions[i];
          const startDx = Math.abs(candidate.startX - current.endX);
          const startDy = Math.abs(candidate.startY - current.endY);
          const endDx = Math.abs(candidate.endX - chainStartX);
          const endDy = Math.abs(candidate.endY - chainStartY);

          // Check if this contribution could close the loop with extended epsilon
          if (startDx <= closeEpsilon && startDy <= closeEpsilon &&
              endDx <= closeEpsilon && endDy <= closeEpsilon) {
            const dist = startDx + startDy + endDx + endDy;
            if (dist < closingDist) {
              closingDist = dist;
              closingIdx = i;
            }
          }
        }

        if (closingIdx >= 0) {
          // Found a closing contribution
          current = contributions[closingIdx];
          result.push(current);
          used.add(closingIdx);
        } else {
          // Start a new chain
          let newChainIdx = -1;
          for (let i = 0; i < contributions.length; i++) {
            if (!used.has(i)) {
              newChainIdx = i;
              break;
            }
          }

          if (newChainIdx >= 0) {
            current = contributions[newChainIdx];
            result.push(current);
            used.add(newChainIdx);
            // Update chain start for the new chain
            chainStartX = current.startX;
            chainStartY = current.startY;
          }
        }
      }
    }

    return result;
  }

  // Add a single command to a path
  private addCommandToPath(path: Path2D, cmd: PathCommand): void {
    switch (cmd.type) {
      case 'M':
        path.moveTo(cmd.x, cmd.y);
        break;
      case 'L':
        path.lineTo(cmd.x, cmd.y);
        break;
      case 'Q':
        if (Number.isFinite(cmd.cx) && Number.isFinite(cmd.cy)) {
          path.quadraticCurveTo(cmd.cx, cmd.cy, cmd.x, cmd.y);
        }
        break;
      case 'C':
        if (Number.isFinite(cmd.c1x) && Number.isFinite(cmd.c1y) &&
            Number.isFinite(cmd.c2x) && Number.isFinite(cmd.c2y)) {
          path.bezierCurveTo(cmd.c1x, cmd.c1y, cmd.c2x, cmd.c2y, cmd.x, cmd.y);
        }
        break;
      case 'Z':
        path.closePath();
        break;
    }
  }

  private getFillStyle(fill: FillStyle): string | CanvasGradient | CanvasPattern {
    if (fill.type === 'solid' && fill.color) {
      if (fill.alpha !== undefined && fill.alpha < 1) {
        return this.colorWithAlpha(fill.color, fill.alpha);
      }
      return fill.color;
    }

    // Handle gradient fills
    if (fill.type === 'linear' && fill.gradient && fill.gradient.length > 0) {
      return this.createLinearGradient(fill);
    }

    if (fill.type === 'radial' && fill.gradient && fill.gradient.length > 0) {
      return this.createRadialGradient(fill);
    }

    // Handle bitmap fills
    if (fill.type === 'bitmap' && fill.bitmapPath) {
      return this.createBitmapPattern(fill);
    }

    return '#000000';
  }

  private getStrokeStyle(stroke: StrokeStyle): string | CanvasGradient | CanvasPattern {
    // Handle solid strokes
    if (stroke.type === 'solid' || !stroke.type) {
      return stroke.color || '#000000';
    }

    // Handle linear gradient strokes
    if (stroke.type === 'linear' && stroke.gradient && stroke.gradient.length > 0) {
      return this.createLinearGradient({
        type: 'linear',
        index: stroke.index,
        gradient: stroke.gradient,
        matrix: stroke.matrix,
        spreadMethod: stroke.spreadMethod,
        interpolationMethod: stroke.interpolationMethod
      });
    }

    // Handle radial gradient strokes
    if (stroke.type === 'radial' && stroke.gradient && stroke.gradient.length > 0) {
      return this.createRadialGradient({
        type: 'radial',
        index: stroke.index,
        gradient: stroke.gradient,
        matrix: stroke.matrix,
        spreadMethod: stroke.spreadMethod,
        interpolationMethod: stroke.interpolationMethod,
        focalPointRatio: stroke.focalPointRatio
      });
    }

    // Handle bitmap strokes
    if (stroke.type === 'bitmap' && stroke.bitmapPath) {
      return this.createBitmapPattern({
        type: 'bitmap',
        index: stroke.index,
        bitmapPath: stroke.bitmapPath,
        matrix: stroke.matrix,
        bitmapIsClipped: stroke.bitmapIsClipped,
        bitmapIsSmoothed: stroke.bitmapIsSmoothed
      });
    }

    return stroke.color || '#000000';
  }

  private createBitmapPattern(fill: FillStyle): CanvasPattern | string {
    if (!this.doc || !fill.bitmapPath) {
      return '#808080'; // Gray fallback for missing bitmap
    }

    // Look up bitmap by path in the document's bitmaps
    const bitmapItem = this.doc.bitmaps.get(fill.bitmapPath);
    if (!bitmapItem || !bitmapItem.imageData) {
      // Try case-insensitive lookup
      for (const [key, item] of this.doc.bitmaps) {
        if (key.toLowerCase() === fill.bitmapPath.toLowerCase() && item.imageData) {
          return this.createPatternFromBitmap(
            item.imageData,
            fill.matrix,
            fill.bitmapIsClipped,
            fill.bitmapIsSmoothed
          );
        }
      }
      return '#808080'; // Gray fallback for missing bitmap
    }

    return this.createPatternFromBitmap(
      bitmapItem.imageData,
      fill.matrix,
      fill.bitmapIsClipped,
      fill.bitmapIsSmoothed
    );
  }

  private createPatternFromBitmap(
    image: HTMLImageElement,
    matrix?: Matrix,
    isClipped?: boolean,
    isSmoothed?: boolean
  ): CanvasPattern | string {
    // Determine repetition mode
    // 'repeat' for normal tiled fills, 'no-repeat' for clipped fills
    const repetition = isClipped ? 'no-repeat' : 'repeat';

    // Handle image smoothing (non-smoothed = pixel-perfect)
    // Note: imageSmoothingEnabled is set at the context level, so we save/restore
    const savedSmoothing = this.ctx.imageSmoothingEnabled;
    if (isSmoothed === false) {
      this.ctx.imageSmoothingEnabled = false;
    }

    const pattern = this.ctx.createPattern(image, repetition);

    // Restore smoothing setting
    this.ctx.imageSmoothingEnabled = savedSmoothing;

    if (!pattern) {
      return '#808080';
    }

    // Apply the bitmap matrix transform
    if (matrix) {
      // Flash bitmap fills use a matrix to position and scale the bitmap
      // The matrix transforms from bitmap space to shape-local space
      pattern.setTransform(new DOMMatrix([
        matrix.a, matrix.b,
        matrix.c, matrix.d,
        matrix.tx, matrix.ty
      ]));
    }

    return pattern;
  }

  private createLinearGradient(fill: FillStyle): CanvasGradient | string {
    if (!fill.gradient || fill.gradient.length === 0) {
      return fill.gradient?.[0]?.color || '#000000';
    }

    // Flash gradient coordinate system: gradients span from -819.2 to 819.2 in local space
    // (16384 twips / 20 = 819.2 pixels)
    const GRADIENT_SIZE = 819.2;

    let x0: number, y0: number, x1: number, y1: number;

    if (fill.matrix) {
      const m = fill.matrix;
      // The gradient matrix transforms from gradient space to shape-local space
      // Base gradient is horizontal from (-GRADIENT_SIZE, 0) to (GRADIENT_SIZE, 0)
      x0 = m.a * (-GRADIENT_SIZE) + m.tx;
      y0 = m.b * (-GRADIENT_SIZE) + m.ty;
      x1 = m.a * GRADIENT_SIZE + m.tx;
      y1 = m.b * GRADIENT_SIZE + m.ty;
    } else {
      // Default horizontal gradient
      x0 = -GRADIENT_SIZE;
      y0 = 0;
      x1 = GRADIENT_SIZE;
      y1 = 0;
    }

    const gradient = this.ctx.createLinearGradient(x0, y0, x1, y1);

    // Add color stops, handling spread modes
    const stops = this.getGradientStopsWithSpreadMode(fill);
    for (const stop of stops) {
      gradient.addColorStop(stop.ratio, stop.color);
    }

    return gradient;
  }

  private createRadialGradient(fill: FillStyle): CanvasGradient | string {
    if (!fill.gradient || fill.gradient.length === 0) {
      return fill.gradient?.[0]?.color || '#000000';
    }

    // Flash radial gradient: circle centered at (0, 0) with radius 819.2
    const GRADIENT_SIZE = 819.2;

    let cx = 0;
    let cy = 0;
    let fx = 0; // Focal point x
    let fy = 0; // Focal point y
    let radius = GRADIENT_SIZE;

    if (fill.matrix) {
      const m = fill.matrix;
      // Gradient center from matrix translation
      cx = m.tx;
      cy = m.ty;

      // Calculate average scale for radius
      const scaleX = Math.sqrt(m.a * m.a + m.b * m.b);
      const scaleY = Math.sqrt(m.c * m.c + m.d * m.d);
      radius = GRADIENT_SIZE * ((scaleX + scaleY) / 2);

      // Apply focal point ratio if specified
      // focalPointRatio is -1 to 1, where 0 is centered, negative is left/up, positive is right/down
      if (fill.focalPointRatio !== undefined && fill.focalPointRatio !== 0) {
        // Focal point is offset along the gradient's primary axis (transformed by matrix)
        const focalOffset = fill.focalPointRatio * radius;
        // Apply the focal point offset using the matrix's primary direction
        const normX = m.a / scaleX;
        const normY = m.b / scaleX;
        fx = cx + normX * focalOffset;
        fy = cy + normY * focalOffset;
      } else {
        fx = cx;
        fy = cy;
      }
    } else {
      fx = cx;
      fy = cy;
    }

    // Create radial gradient with focal point support
    // Canvas createRadialGradient(x0, y0, r0, x1, y1, r1) where:
    // - (x0, y0) is the focal point (inner circle center), r0 is inner radius
    // - (x1, y1) is the outer circle center, r1 is outer radius
    const gradient = this.ctx.createRadialGradient(fx, fy, 0, cx, cy, radius);

    // Add color stops, handling spread modes
    const stops = this.getGradientStopsWithSpreadMode(fill);
    for (const stop of stops) {
      gradient.addColorStop(stop.ratio, stop.color);
    }

    return gradient;
  }

  // Process gradient entries and handle spread modes (reflect/repeat)
  // Canvas doesn't natively support spread modes, so we simulate them by extending the color stops
  private getGradientStopsWithSpreadMode(fill: FillStyle): Array<{ ratio: number; color: string }> {
    if (!fill.gradient || fill.gradient.length === 0) {
      return [];
    }

    const baseStops = fill.gradient.map(entry => ({
      ratio: Math.max(0, Math.min(1, entry.ratio)),
      color: entry.alpha < 1
        ? this.colorWithAlpha(entry.color, entry.alpha)
        : entry.color
    }));

    // Default 'pad' mode - just use the stops as-is
    if (!fill.spreadMethod || fill.spreadMethod === 'pad') {
      return baseStops;
    }

    // For 'reflect' and 'repeat', we need to extend the gradient
    // However, Canvas gradients are clamped to [0,1], so we can only simulate
    // these modes within the visible gradient bounds
    // The simulation works by extending color stops if the gradient is visible beyond 0-1

    // For now, we provide a best-effort approximation:
    // - 'repeat': Simply use the original stops (clamped by Canvas)
    // - 'reflect': Duplicate stops in reverse to create a mirrored effect within bounds

    if (fill.spreadMethod === 'reflect') {
      // Create a reflected pattern by mirroring the stops
      // This gives a symmetric gradient appearance
      const reflectedStops: Array<{ ratio: number; color: string }> = [];

      // First half: compress original gradient to 0-0.5
      for (const stop of baseStops) {
        reflectedStops.push({
          ratio: stop.ratio * 0.5,
          color: stop.color
        });
      }

      // Second half: mirror the gradient from 0.5-1
      for (let i = baseStops.length - 1; i >= 0; i--) {
        const stop = baseStops[i];
        reflectedStops.push({
          ratio: 1 - (stop.ratio * 0.5),
          color: stop.color
        });
      }

      return reflectedStops;
    }

    // For 'repeat', return original stops (Canvas clamps, but appearance is close enough)
    return baseStops;
  }

  private colorWithAlpha(color: string, alpha: number): string {
    // Convert hex color to rgba
    if (color.startsWith('#')) {
      const hex = color.substring(1);
      let r: number, g: number, b: number;

      if (hex.length === 3) {
        // #RGB format - expand to #RRGGBB
        r = parseInt(hex[0] + hex[0], 16);
        g = parseInt(hex[1] + hex[1], 16);
        b = parseInt(hex[2] + hex[2], 16);
      } else if (hex.length >= 6) {
        // #RRGGBB or #RRGGBBAA format
        r = parseInt(hex.substring(0, 2), 16);
        g = parseInt(hex.substring(2, 4), 16);
        b = parseInt(hex.substring(4, 6), 16);
      } else {
        // Invalid format, return as-is
        return color;
      }

      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    return color;
  }

  private applyMatrix(matrix: Matrix): void {
    this.ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty);
  }

  /**
   * Apply 3D transform using perspective projection to 2D canvas.
   * This simulates 3D rotations by applying appropriate 2D transforms.
   */
  private apply3DTransform(instance: SymbolInstance): void {
    const ctx = this.ctx;
    const matrix = instance.matrix;

    // Get 3D rotation angles in radians
    const rotX = (instance.rotationX || 0) * Math.PI / 180;
    const rotY = (instance.rotationY || 0) * Math.PI / 180;
    const rotZ = (instance.rotationZ || 0) * Math.PI / 180;
    const zPos = instance.z || 0;

    // Get the center point for 3D rotation
    const centerX = instance.centerPoint3D?.x || instance.transformationPoint.x;
    const centerY = instance.centerPoint3D?.y || instance.transformationPoint.y;

    // First apply the 2D matrix translation
    ctx.translate(matrix.tx, matrix.ty);

    // Apply perspective projection for 3D effect
    // Using a simple perspective distance
    const perspectiveDistance = 1000;

    // Calculate 3D rotation matrices and project to 2D
    // Rotation around X-axis affects Y scale and skew
    const cosX = Math.cos(rotX);
    const sinX = Math.sin(rotX);

    // Rotation around Y-axis affects X scale and skew
    const cosY = Math.cos(rotY);
    const sinY = Math.sin(rotY);

    // Apply Z-position scaling (objects further away appear smaller)
    const zScale = perspectiveDistance / (perspectiveDistance + zPos);

    // Extract scale from original matrix
    const origScaleX = Math.sqrt(matrix.a * matrix.a + matrix.b * matrix.b);
    const origScaleY = Math.sqrt(matrix.c * matrix.c + matrix.d * matrix.d);

    // Combine all transformations:
    // 1. Translate to center point
    // 2. Apply 3D rotations (projected to 2D)
    // 3. Apply perspective scale
    // 4. Translate back

    // Move to transformation center
    ctx.translate(centerX, centerY);

    // Apply Z rotation (in 2D plane)
    ctx.rotate(rotZ);

    // Apply Y rotation effect (horizontal compression/skew)
    // When rotating around Y-axis, the X dimension compresses
    const scaleXFromRotY = cosY * zScale;

    // Apply X rotation effect (vertical compression/skew)
    // When rotating around X-axis, the Y dimension compresses
    const scaleYFromRotX = cosX * zScale;

    // Apply the combined scale
    ctx.scale(origScaleX * scaleXFromRotY, origScaleY * scaleYFromRotX);

    // Apply skew from 3D rotations
    // Y rotation creates horizontal skew
    if (Math.abs(sinY) > 0.001) {
      ctx.transform(1, 0, sinY * 0.5, 1, 0, 0);
    }

    // X rotation creates vertical skew
    if (Math.abs(sinX) > 0.001) {
      ctx.transform(1, sinX * 0.5, 0, 1, 0, 0);
    }

    // Translate back from center
    ctx.translate(-centerX, -centerY);
  }

  // Apply filters using Canvas 2D shadow and filter API
  private applyFilters(ctx: CanvasRenderingContext2D, filters: Filter[]): void {
    // Combine multiple blur filters
    let totalBlurX = 0;
    let totalBlurY = 0;
    const cssFilters: string[] = [];

    for (const filter of filters) {
      switch (filter.type) {
        case 'blur':
          totalBlurX += filter.blurX;
          totalBlurY += filter.blurY;
          break;
        case 'glow':
          // Use shadow for glow effect
          ctx.shadowColor = this.colorWithAlpha(filter.color, filter.alpha ?? 1);
          ctx.shadowBlur = Math.max(filter.blurX, filter.blurY) * (filter.strength ?? 1);
          ctx.shadowOffsetX = 0;
          ctx.shadowOffsetY = 0;
          break;
        case 'dropShadow':
          const dsAngle = (filter.angle || 45) * Math.PI / 180;
          ctx.shadowColor = this.colorWithAlpha(filter.color, filter.alpha ?? 1);
          ctx.shadowBlur = Math.max(filter.blurX, filter.blurY) * (filter.strength ?? 1);
          ctx.shadowOffsetX = Math.cos(dsAngle) * filter.distance;
          ctx.shadowOffsetY = Math.sin(dsAngle) * filter.distance;
          break;
        case 'bevel':
          // Bevel creates an embossed effect with highlight and shadow
          // We approximate this using two offset shadows rendered in sequence
          // For simplicity, we use the highlight color with offset
          const bevelAngle = (filter.angle || 45) * Math.PI / 180;
          const highlightOffsetX = -Math.cos(bevelAngle) * filter.distance;
          const highlightOffsetY = -Math.sin(bevelAngle) * filter.distance;

          // Use shadow color for the primary shadow effect
          ctx.shadowColor = this.colorWithAlpha(filter.shadowColor, filter.shadowAlpha ?? 1);
          ctx.shadowBlur = Math.max(filter.blurX, filter.blurY) * (filter.strength ?? 1);
          ctx.shadowOffsetX = -highlightOffsetX;
          ctx.shadowOffsetY = -highlightOffsetY;
          break;
        case 'colorMatrix':
          // Apply color matrix using SVG filter
          // Build SVG feColorMatrix filter string
          if (filter.matrix && filter.matrix.length === 20) {
            // Convert 4x5 matrix to SVG feColorMatrix format (5x4 transposed, no alpha offset row)
            // SVG format: R->R, R->G, R->B, R->A, R->offset, G->R, ...
            const m = filter.matrix;
            // Build url() filter using inline SVG
            const svgFilter = this.buildColorMatrixSVGFilter(m);
            cssFilters.push(`url("data:image/svg+xml,${encodeURIComponent(svgFilter)}")`);
          }
          break;
        case 'convolution':
          // Convolution filters (sharpen, emboss, etc.) require pixel manipulation
          // Canvas 2D doesn't support convolution natively, but we can approximate
          // common effects like sharpen using CSS filters
          if (this.isIdentityConvolution(filter.matrix, filter.matrixX, filter.matrixY)) {
            // Identity matrix - no effect needed
            break;
          }
          if (this.isSharpenConvolution(filter.matrix)) {
            // Approximate sharpen with contrast
            cssFilters.push('contrast(1.1)');
          } else if (this.isEdgeDetectConvolution(filter.matrix)) {
            // Edge detection - approximate with high contrast
            cssFilters.push('contrast(2) saturate(0)');
          }
          // Note: Full convolution support would require getImageData/putImageData
          break;
        case 'gradientGlow':
          // Gradient glow is similar to regular glow but with gradient colors
          // We approximate using the first and last colors
          const ggColors = filter.colors;
          if (ggColors && ggColors.length > 0) {
            const midColor = ggColors[Math.floor(ggColors.length / 2)];
            ctx.shadowColor = this.colorWithAlpha(midColor.color, midColor.alpha);
            ctx.shadowBlur = Math.max(filter.blurX, filter.blurY) * (filter.strength ?? 1);
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;
          }
          break;
        case 'gradientBevel':
          // Gradient bevel is similar to regular bevel but with gradient colors
          const gbColors = filter.colors;
          const gbAngle = (filter.angle || 45) * Math.PI / 180;
          if (gbColors && gbColors.length > 0) {
            const midColor = gbColors[Math.floor(gbColors.length / 2)];
            ctx.shadowColor = this.colorWithAlpha(midColor.color, midColor.alpha);
            ctx.shadowBlur = Math.max(filter.blurX, filter.blurY) * (filter.strength ?? 1);
            ctx.shadowOffsetX = Math.cos(gbAngle) * filter.distance;
            ctx.shadowOffsetY = Math.sin(gbAngle) * filter.distance;
          }
          break;
      }
    }

    // Apply combined blur using CSS filter
    if (totalBlurX > 0 || totalBlurY > 0) {
      const avgBlur = (totalBlurX + totalBlurY) / 2;
      cssFilters.push(`blur(${avgBlur}px)`);
    }

    // Combine all CSS filters
    if (cssFilters.length > 0) {
      ctx.filter = cssFilters.join(' ');
    }
  }

  // Build an inline SVG filter for color matrix transformation
  private buildColorMatrixSVGFilter(matrix: number[]): string {
    // Normalize matrix values for SVG (divide offsets by 255)
    const m = [...matrix];
    // Offsets are at indices 4, 9, 14, 19 - convert from 0-255 to 0-1
    m[4] /= 255;
    m[9] /= 255;
    m[14] /= 255;
    m[19] /= 255;

    return `<svg xmlns="http://www.w3.org/2000/svg"><filter id="cm"><feColorMatrix type="matrix" values="${m.join(' ')}"/></filter></svg>#cm`;
  }

  // Check if convolution matrix is identity (no effect)
  private isIdentityConvolution(matrix: number[], matrixX: number, matrixY: number): boolean {
    if (matrixX !== matrixY || matrixX < 1) return false;
    const center = Math.floor(matrixX * matrixY / 2);
    for (let i = 0; i < matrix.length; i++) {
      if (i === center && matrix[i] !== 1) return false;
      if (i !== center && matrix[i] !== 0) return false;
    }
    return true;
  }

  // Check if convolution is a sharpen filter
  private isSharpenConvolution(matrix: number[]): boolean {
    // Common sharpen kernel: [0, -1, 0, -1, 5, -1, 0, -1, 0]
    if (matrix.length !== 9) return false;
    const sharpen = [0, -1, 0, -1, 5, -1, 0, -1, 0];
    return matrix.every((v, i) => Math.abs(v - sharpen[i]) < 0.1);
  }

  // Check if convolution is an edge detection filter
  private isEdgeDetectConvolution(matrix: number[]): boolean {
    // Common edge detect kernels have sum close to 0 and high center value
    if (matrix.length < 9) return false;
    const sum = matrix.reduce((a, b) => a + b, 0);
    const center = matrix[Math.floor(matrix.length / 2)];
    return Math.abs(sum) < 0.1 && center > 0;
  }

  // Clear all filter effects
  private clearFilters(ctx: CanvasRenderingContext2D): void {
    ctx.filter = 'none';
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }

  // Map Flash blend mode to Canvas globalCompositeOperation
  private mapBlendMode(blendMode: BlendMode): GlobalCompositeOperation {
    const blendModeMap: Record<BlendMode, GlobalCompositeOperation> = {
      'normal': 'source-over',
      'layer': 'source-over',      // Layer behaves like normal in most cases
      'multiply': 'multiply',
      'screen': 'screen',
      'overlay': 'overlay',
      'darken': 'darken',
      'lighten': 'lighten',
      'hardlight': 'hard-light',
      'add': 'lighter',            // 'add' in Flash is 'lighter' in Canvas
      'subtract': 'difference',    // Approximate - Canvas doesn't have true subtract
      'difference': 'difference',
      'invert': 'exclusion',       // Approximate - Canvas doesn't have true invert
      'alpha': 'source-over',      // Alpha mode is complex, fallback to normal
      'erase': 'destination-out',  // Erases underlying content
    };

    return blendModeMap[blendMode] || 'source-over';
  }

  // Apply color transform to context
  private applyColorTransform(ctx: CanvasRenderingContext2D, transform: ColorTransform): void {
    // Apply alpha multiplier
    if (transform.alphaMultiplier !== undefined) {
      ctx.globalAlpha *= transform.alphaMultiplier;
    }

    // Build CSS filter string for color transforms
    const filters: string[] = [];

    // Calculate brightness adjustment from color multipliers
    // Average of RGB multipliers gives us an approximate brightness
    const rMult = transform.redMultiplier ?? 1;
    const gMult = transform.greenMultiplier ?? 1;
    const bMult = transform.blueMultiplier ?? 1;
    const avgMult = (rMult + gMult + bMult) / 3;

    // If multipliers are uniform, we can use brightness filter
    if (Math.abs(rMult - gMult) < 0.01 && Math.abs(gMult - bMult) < 0.01) {
      if (avgMult !== 1) {
        filters.push(`brightness(${avgMult})`);
      }
    }

    // Apply offsets as contrast/brightness if uniform
    const rOff = transform.redOffset ?? 0;
    const gOff = transform.greenOffset ?? 0;
    const bOff = transform.blueOffset ?? 0;
    const avgOff = (rOff + gOff + bOff) / 3;

    if (Math.abs(rOff - gOff) < 1 && Math.abs(gOff - bOff) < 1 && avgOff !== 0) {
      // Offset adds to all channels - simulate with brightness
      // 255 offset = double brightness, -255 = black
      const offsetBrightness = 1 + (avgOff / 255);
      if (offsetBrightness > 0) {
        filters.push(`brightness(${offsetBrightness})`);
      }
    }

    // Apply the combined filter
    if (filters.length > 0) {
      const existingFilter = ctx.filter !== 'none' ? ctx.filter + ' ' : '';
      ctx.filter = existingFilter + filters.join(' ');
    }
  }

  // Render a morph shape (shape tween) at the given progress
  private renderMorphShape(
    morphShape: MorphShape,
    startShape: Shape,
    progress: number,
    depth: number
  ): void {
    const ctx = this.ctx;
    ctx.save();

    // Apply shape's transformation matrix
    this.applyMatrix(startShape.matrix);

    // Build fill style lookup from start shape
    const fillStyles = new Map<number, FillStyle>();
    for (const fill of startShape.fills) {
      fillStyles.set(fill.index, fill);
    }

    // Build stroke style lookup from start shape
    const strokeStyles = new Map<number, StrokeStyle>();
    for (const stroke of startShape.strokes) {
      strokeStyles.set(stroke.index, stroke);
    }

    // Render each segment
    for (const segment of morphShape.segments) {
      const path = new Path2D();

      // Interpolate start point
      const startX = this.lerp(segment.startPointA.x, segment.startPointB.x, progress);
      const startY = this.lerp(segment.startPointA.y, segment.startPointB.y, progress);
      path.moveTo(startX, startY);

      // Interpolate each curve
      for (const curve of segment.curves) {
        const ctrlX = this.lerp(curve.controlPointA.x, curve.controlPointB.x, progress);
        const ctrlY = this.lerp(curve.controlPointA.y, curve.controlPointB.y, progress);
        const anchorX = this.lerp(curve.anchorPointA.x, curve.anchorPointB.x, progress);
        const anchorY = this.lerp(curve.anchorPointA.y, curve.anchorPointB.y, progress);

        if (curve.isLine) {
          path.lineTo(anchorX, anchorY);
        } else {
          path.quadraticCurveTo(ctrlX, ctrlY, anchorX, anchorY);
        }
      }

      path.closePath();

      // Apply fill from segment indices
      const fillIndex = segment.fillIndex1 ?? segment.fillIndex2;
      if (fillIndex !== undefined) {
        const fill = fillStyles.get(fillIndex);
        if (fill) {
          ctx.fillStyle = this.getFillStyle(fill);
          ctx.fill(path, 'nonzero');
        }
      }

      // Apply stroke from segment indices
      const strokeIndex = segment.strokeIndex1 ?? segment.strokeIndex2;
      if (strokeIndex !== undefined) {
        const stroke = strokeStyles.get(strokeIndex);
        if (stroke && stroke.color) {
          ctx.strokeStyle = stroke.color;
          ctx.lineWidth = stroke.weight;
          ctx.lineCap = stroke.caps === 'none' ? 'butt' : stroke.caps || 'round';
          ctx.lineJoin = stroke.joints || 'round';
          // Apply miter limit (Flash default is 3)
          ctx.miterLimit = stroke.miterLimit ?? 3;
          ctx.stroke(path);
        }
      }
    }

    // Track for debug mode
    if (this.debugMode) {
      const combinedPath = new Path2D();
      for (const segment of morphShape.segments) {
        const startX = this.lerp(segment.startPointA.x, segment.startPointB.x, progress);
        const startY = this.lerp(segment.startPointA.y, segment.startPointB.y, progress);
        combinedPath.moveTo(startX, startY);
        for (const curve of segment.curves) {
          const anchorX = this.lerp(curve.anchorPointA.x, curve.anchorPointB.x, progress);
          const anchorY = this.lerp(curve.anchorPointA.y, curve.anchorPointB.y, progress);
          if (curve.isLine) {
            combinedPath.lineTo(anchorX, anchorY);
          } else {
            const ctrlX = this.lerp(curve.controlPointA.x, curve.controlPointB.x, progress);
            const ctrlY = this.lerp(curve.controlPointA.y, curve.controlPointB.y, progress);
            combinedPath.quadraticCurveTo(ctrlX, ctrlY, anchorX, anchorY);
          }
        }
        combinedPath.closePath();
      }

      this.debugElements.push({
        type: 'shape',
        element: startShape,
        path: combinedPath,
        transform: ctx.getTransform(),
        depth,
        parentPath: [...this.debugSymbolPath],
        fillStyles,
        strokeStyles,
        edges: startShape.edges
      });
    }

    ctx.restore();
  }

  /**
   * Render a symbol with 9-slice scaling.
   *
   * 9-slice scaling divides the symbol into 9 regions:
   * +---+---+---+
   * | 1 | 2 | 3 |  (top row)
   * +---+---+---+
   * | 4 | 5 | 6 |  (middle row)
   * +---+---+---+
   * | 7 | 8 | 9 |  (bottom row)
   * +---+---+---+
   *
   * - Corners (1,3,7,9): No scaling
   * - Top/Bottom edges (2,8): Horizontal scaling only
   * - Left/Right edges (4,6): Vertical scaling only
   * - Center (5): Both horizontal and vertical scaling
   */

  /**
   * Render a symbol using cached bitmap for improved performance.
   * The symbol is rendered once to an offscreen canvas and then reused.
   */
  private renderSymbolFromCache(
    symbol: Symbol,
    _instance: SymbolInstance,
    depth: number
  ): void {
    const cacheKey = `${symbol.name}:${symbol.itemID}`;
    let cached = this.symbolBitmapCache.get(cacheKey);

    if (!cached) {
      // Calculate symbol bounds (estimate based on document size or use a default)
      const symbolWidth = this.doc?.width || 550;
      const symbolHeight = this.doc?.height || 400;
      const padding = 50;

      // Create offscreen canvas
      const offscreenCanvas = document.createElement('canvas');
      offscreenCanvas.width = Math.ceil(symbolWidth + padding * 2);
      offscreenCanvas.height = Math.ceil(symbolHeight + padding * 2);
      const offCtx = offscreenCanvas.getContext('2d');

      if (!offCtx) {
        // Fallback to normal rendering
        this.renderTimeline(symbol.timeline, 0, depth + 1);
        return;
      }

      // Temporarily swap context to render to offscreen canvas
      const savedCtx = this.ctx;
      const savedScale = this.scale;
      this.ctx = offCtx;
      this.scale = 1;

      // Translate to center the content
      offCtx.translate(padding, padding);

      // Render the symbol's timeline at frame 0
      this.renderTimeline(symbol.timeline, 0, depth + 1);

      // Restore original context
      this.ctx = savedCtx;
      this.scale = savedScale;

      // Cache the result
      cached = {
        canvas: offscreenCanvas,
        bounds: {
          width: symbolWidth,
          height: symbolHeight,
          offsetX: padding,
          offsetY: padding
        }
      };
      this.symbolBitmapCache.set(cacheKey, cached);
    }

    // Draw the cached bitmap
    this.ctx.drawImage(
      cached.canvas,
      cached.bounds.offsetX, cached.bounds.offsetY,
      cached.bounds.width, cached.bounds.height,
      0, 0,
      cached.bounds.width, cached.bounds.height
    );
  }

  private renderSymbolWith9Slice(
    symbol: Symbol,
    instance: SymbolInstance,
    scale9Grid: Rectangle,
    symbolFrame: number,
    depth: number
  ): void {
    const ctx = this.ctx;

    // Calculate the symbol's original bounds
    // The scale9Grid is defined relative to the symbol's internal coordinates
    const gridLeft = scale9Grid.left;
    const gridTop = scale9Grid.top;
    const gridRight = gridLeft + scale9Grid.width;
    const gridBottom = gridTop + scale9Grid.height;

    // Get the instance's transformation matrix
    const m = instance.matrix;

    // Extract scale factors from the matrix
    // For a 2D affine matrix [a, b, c, d, tx, ty]:
    // scaleX = sqrt(a² + b²), scaleY = sqrt(c² + d²)
    const scaleX = Math.sqrt(m.a * m.a + m.b * m.b);
    const scaleY = Math.sqrt(m.c * m.c + m.d * m.d);

    // If scales are very close to 1, just render normally without 9-slice
    if (Math.abs(scaleX - 1) < 0.01 && Math.abs(scaleY - 1) < 0.01) {
      this.applyMatrix(m);
      this.renderTimeline(symbol.timeline, symbolFrame, depth + 1);
      return;
    }

    // We need to estimate the symbol's bounds for 9-slice to work
    // Use the scale9Grid as a hint for the symbol size
    // Typically the grid is inside the symbol, so we expand it
    const symbolWidth = gridRight + gridLeft; // Assume symmetric
    const symbolHeight = gridBottom + gridTop;

    // Calculate the scaled dimensions
    const scaledWidth = symbolWidth * scaleX;
    const scaledHeight = symbolHeight * scaleY;

    // Calculate the 9-slice region sizes
    // Original sizes
    const leftWidth = gridLeft;
    const centerWidth = scale9Grid.width;
    const rightWidth = symbolWidth - gridRight;
    const topHeight = gridTop;
    const centerHeight = scale9Grid.height;
    const bottomHeight = symbolHeight - gridBottom;

    // Scaled center size (corners stay fixed)
    const scaledCenterWidth = Math.max(0, scaledWidth - leftWidth - rightWidth);
    const scaledCenterHeight = Math.max(0, scaledHeight - topHeight - bottomHeight);

    // Save current state
    ctx.save();

    // Apply translation and rotation from the matrix (but not scale)
    // We'll handle scaling ourselves per-region
    const rotation = Math.atan2(m.b, m.a);
    ctx.translate(m.tx, m.ty);
    ctx.rotate(rotation);

    // Create an offscreen canvas to render the symbol at original size
    const offscreenCanvas = document.createElement('canvas');
    const padding = 10; // Add padding to avoid edge clipping
    offscreenCanvas.width = Math.ceil(symbolWidth + padding * 2);
    offscreenCanvas.height = Math.ceil(symbolHeight + padding * 2);
    const offCtx = offscreenCanvas.getContext('2d');

    if (!offCtx) {
      // Fallback to normal rendering
      ctx.restore();
      this.applyMatrix(m);
      this.renderTimeline(symbol.timeline, symbolFrame, depth + 1);
      return;
    }

    // Temporarily swap context to render to offscreen canvas
    const savedCtx = this.ctx;
    const savedScale = this.scale;
    this.ctx = offCtx;
    this.scale = 1;

    // Translate to center the content in the offscreen canvas
    offCtx.translate(padding, padding);

    // Render the symbol's content to the offscreen canvas
    this.renderTimeline(symbol.timeline, symbolFrame, depth + 1);

    // Restore original context
    this.ctx = savedCtx;
    this.scale = savedScale;

    // Now draw the 9 regions with appropriate scaling
    // Region coordinates in the source (offscreen canvas)
    const srcRegions = {
      // x, y, width, height for each region in source
      topLeft: { x: padding, y: padding, w: leftWidth, h: topHeight },
      topCenter: { x: padding + leftWidth, y: padding, w: centerWidth, h: topHeight },
      topRight: { x: padding + leftWidth + centerWidth, y: padding, w: rightWidth, h: topHeight },
      middleLeft: { x: padding, y: padding + topHeight, w: leftWidth, h: centerHeight },
      middleCenter: { x: padding + leftWidth, y: padding + topHeight, w: centerWidth, h: centerHeight },
      middleRight: { x: padding + leftWidth + centerWidth, y: padding + topHeight, w: rightWidth, h: centerHeight },
      bottomLeft: { x: padding, y: padding + topHeight + centerHeight, w: leftWidth, h: bottomHeight },
      bottomCenter: { x: padding + leftWidth, y: padding + topHeight + centerHeight, w: centerWidth, h: bottomHeight },
      bottomRight: { x: padding + leftWidth + centerWidth, y: padding + topHeight + centerHeight, w: rightWidth, h: bottomHeight }
    };

    // Destination coordinates
    const dstRegions = {
      topLeft: { x: 0, y: 0, w: leftWidth, h: topHeight },
      topCenter: { x: leftWidth, y: 0, w: scaledCenterWidth, h: topHeight },
      topRight: { x: leftWidth + scaledCenterWidth, y: 0, w: rightWidth, h: topHeight },
      middleLeft: { x: 0, y: topHeight, w: leftWidth, h: scaledCenterHeight },
      middleCenter: { x: leftWidth, y: topHeight, w: scaledCenterWidth, h: scaledCenterHeight },
      middleRight: { x: leftWidth + scaledCenterWidth, y: topHeight, w: rightWidth, h: scaledCenterHeight },
      bottomLeft: { x: 0, y: topHeight + scaledCenterHeight, w: leftWidth, h: bottomHeight },
      bottomCenter: { x: leftWidth, y: topHeight + scaledCenterHeight, w: scaledCenterWidth, h: bottomHeight },
      bottomRight: { x: leftWidth + scaledCenterWidth, y: topHeight + scaledCenterHeight, w: rightWidth, h: bottomHeight }
    };

    // Draw each region (skip if width or height is 0)
    const drawRegion = (src: { x: number; y: number; w: number; h: number }, dst: { x: number; y: number; w: number; h: number }) => {
      if (src.w > 0 && src.h > 0 && dst.w > 0 && dst.h > 0) {
        ctx.drawImage(
          offscreenCanvas,
          src.x, src.y, src.w, src.h,
          dst.x, dst.y, dst.w, dst.h
        );
      }
    };

    // Draw all 9 regions
    drawRegion(srcRegions.topLeft, dstRegions.topLeft);
    drawRegion(srcRegions.topCenter, dstRegions.topCenter);
    drawRegion(srcRegions.topRight, dstRegions.topRight);
    drawRegion(srcRegions.middleLeft, dstRegions.middleLeft);
    drawRegion(srcRegions.middleCenter, dstRegions.middleCenter);
    drawRegion(srcRegions.middleRight, dstRegions.middleRight);
    drawRegion(srcRegions.bottomLeft, dstRegions.bottomLeft);
    drawRegion(srcRegions.bottomCenter, dstRegions.bottomCenter);
    drawRegion(srcRegions.bottomRight, dstRegions.bottomRight);

    ctx.restore();
  }
}
