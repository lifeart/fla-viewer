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
  PathCommand
} from './types';
import { getWithNormalizedPath } from './path-utils';

// Debug flag - enabled via ?debug=true URL parameter
const DEBUG = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug') === 'true';

interface DebugElement {
  type: 'shape' | 'symbol' | 'bitmap' | 'video' | 'text';
  element: DisplayElement;
  path: Path2D;
  transform: DOMMatrix;
  depth: number;
  parentPath: string[];  // Symbol hierarchy path
  fillStyles?: Map<number, FillStyle>;
  strokeStyles?: Map<number, StrokeStyle>;
  edges?: Edge[];
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
  private layerOrder: 'forward' | 'reverse' = 'reverse';
  private nestedLayerOrder: 'forward' | 'reverse' = 'reverse';
  private elementOrder: 'forward' | 'reverse' = 'forward';
  private shapePathCache = new WeakMap<Shape, CachedShapePaths>();
  private followCamera: boolean = false;
  private manualCameraLayerIndex: number | undefined = undefined;

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

  setLayerOrder(order: 'forward' | 'reverse'): void {
    this.layerOrder = order;
  }

  setNestedLayerOrder(order: 'forward' | 'reverse'): void {
    this.nestedLayerOrder = order;
  }

  setElementOrder(order: 'forward' | 'reverse'): void {
    this.elementOrder = order;
  }

  // Enable/disable following the camera/ramka layer as viewport
  setFollowCamera(enabled: boolean): void {
    this.followCamera = enabled;
    if (enabled && this.doc) {
      this.manualCameraLayerIndex = this.findCameraLayerByName();
      if (DEBUG && this.manualCameraLayerIndex !== undefined) {
        const layer = this.doc.timelines[0]?.layers[this.manualCameraLayerIndex];
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
    if (!this.doc || !this.doc.timelines[0]) return undefined;

    const layers = this.doc.timelines[0].layers;
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
    if (!this.doc || !this.doc.timelines[0]) return [];

    const result: { index: number; name: string }[] = [];
    const layers = this.doc.timelines[0].layers;

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

    const timeline = this.doc.timelines[0];
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

    // Render main timeline
    if (doc.timelines.length > 0) {
      this.renderTimelineWithCamera(doc.timelines[0], frameIndex, viewport);
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

    for (const i of indices) {
      // Skip specified layer (camera layer)
      if (i === skipLayerIndex) continue;

      // Skip hidden layers (only for main timeline, depth 0)
      if (depth === 0 && this.hiddenLayers.has(i)) continue;

      // Skip reference layers
      if (timeline.referenceLayers.has(i)) continue;

      const layer = timeline.layers[i];
      const layerTypeLower = (layer.layerType as string)?.toLowerCase() || '';
      if (layer.layerType === 'guide' || layerTypeLower === 'guide' ||
          layer.layerType === 'folder' || layerTypeLower === 'folder') {
        continue;
      }

      this.renderLayer(layer, frameIndex, depth);
    }
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

      // Also skip guide/folder layers that might not have been detected
      const layerTypeLower = (layer.layerType as string)?.toLowerCase() || '';
      const isGuideLayer = layer.layerType === 'guide' || layerTypeLower === 'guide';
      const isFolderLayer = layer.layerType === 'folder' || layerTypeLower === 'folder';

      if (isGuideLayer || isFolderLayer) {
        continue;
      }

      this.renderLayer(layer, frameIndex, depth);
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

  private renderLayer(layer: Layer, frameIndex: number, depth: number): void {
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

    // Render elements based on elementOrder setting
    const elementIndices = this.elementOrder === 'reverse'
      ? [...Array(frame.elements.length).keys()].reverse()
      : [...Array(frame.elements.length).keys()];

    for (const elementIndex of elementIndices) {
      const element = frame.elements[elementIndex];
      if (frame.tweenType === 'motion' && nextKeyframe && nextKeyframe.elements.length > 0) {
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

        this.renderDisplayElementWithTween(element, nextDisplayElement, progress, depth, frameIndex);
      } else {
        this.renderDisplayElement(element, depth, frameIndex);
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

  private renderDisplayElementWithTween(element: DisplayElement, nextDisplayElement: DisplayElement, progress: number, depth: number, parentFrameIndex: number): void {
    if (element.type === 'symbol' && nextDisplayElement.type === 'symbol') {
      // Interpolate matrix transforms
      const startMatrix = element.matrix;
      const endMatrix = nextDisplayElement.matrix;

      const interpolatedMatrix: Matrix = {
        a: this.lerp(startMatrix.a, endMatrix.a, progress),
        b: this.lerp(startMatrix.b, endMatrix.b, progress),
        c: this.lerp(startMatrix.c, endMatrix.c, progress),
        d: this.lerp(startMatrix.d, endMatrix.d, progress),
        tx: this.lerp(startMatrix.tx, endMatrix.tx, progress),
        ty: this.lerp(startMatrix.ty, endMatrix.ty, progress)
      };

      // Note: Do NOT interpolate firstFrame - it's an offset for the keyframe start,
      // and frameOffset in renderSymbolInstance already handles animation progress.
      // Interpolating firstFrame would cause double-counting and "lagging" animation.
      const tweenedDisplayElement: SymbolInstance = {
        ...element,
        matrix: interpolatedMatrix
        // firstFrame stays as element.firstFrame (the keyframe's starting offset)
      };

      this.renderDisplayElement(tweenedDisplayElement, depth, parentFrameIndex);
    } else {
      this.renderDisplayElement(element, depth, parentFrameIndex);
    }
  }

  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

  private renderDisplayElement(element: DisplayElement, depth: number, parentFrameIndex: number): void {
    if (element.type === 'symbol') {
      this.renderSymbolInstance(element, depth, parentFrameIndex);
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

  private renderSymbolInstance(instance: SymbolInstance, depth: number, parentFrameIndex: number): void {
    if (!this.doc) return;

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

    // Track symbol path for debugging
    if (this.debugMode) {
      this.debugSymbolPath.push(instance.libraryItemName);
    }

    // Apply transformation matrix
    // Note: The matrix tx/ty already positions the symbol correctly
    // The transformationPoint is metadata about the pivot, but it's already
    // accounted for in how the matrix was calculated by Flash
    this.applyMatrix(instance.matrix);

    // Calculate which frame to render based on symbol type and loop mode
    // In Flash:
    // - Graphic symbols: sync with parent timeline based on loop mode
    //   - 'single frame': Always shows the specified firstFrame
    //   - 'loop': Internal timeline advances with parent, loops when done
    //   - 'play once': Internal timeline advances, stops at last frame
    // - MovieClip symbols: play their own timeline independently (use 'play once' for static rendering)
    // - Button symbols: show first frame (up state)
    const firstFrame = instance.firstFrame || 0;
    const totalSymbolFrames = Math.max(1, symbol.timeline.totalFrames);
    let symbolFrame: number;

    // MovieClips and Buttons play independently from parent timeline
    // For static rendering without ActionScript, treat them as 'play once'
    const effectiveLoop = (instance.symbolType === 'movieclip' || instance.symbolType === 'button')
      ? 'play once'
      : instance.loop;

    if (effectiveLoop === 'single frame') {
      // Always show the specified firstFrame
      symbolFrame = firstFrame % totalSymbolFrames;
    } else if (effectiveLoop === 'loop') {
      // Sync with parent timeline: advance from firstFrame based on parent frame offset
      const frameOffset = parentFrameIndex - this.currentKeyframeStart;
      symbolFrame = (firstFrame + frameOffset) % totalSymbolFrames;
    } else {
      // 'play once' - advance but clamp at last frame
      const frameOffset = parentFrameIndex - this.currentKeyframeStart;
      symbolFrame = Math.min(firstFrame + frameOffset, totalSymbolFrames - 1);
    }

    // Render symbol's timeline
    this.renderTimeline(symbol.timeline, symbolFrame, depth + 1);

    // Pop symbol path
    if (this.debugMode) {
      this.debugSymbolPath.pop();
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

    ctx.restore();
  }

  private renderBitmapInstance(bitmap: BitmapInstance, depth: number = 0): void {
    if (!this.doc) return;

    const ctx = this.ctx;
    ctx.save();

    // Apply transformation
    this.applyMatrix(bitmap.matrix);

    // Look up bitmap item from library
    const bitmapItem = getWithNormalizedPath(this.doc.bitmaps, bitmap.libraryItemName);

    // Create path for hit testing
    if (this.debugMode) {
      const path = new Path2D();
      const width = bitmapItem?.width || 100;
      const height = bitmapItem?.height || 100;
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
      // If we have loaded image data, draw it
      ctx.drawImage(bitmapItem.imageData, 0, 0, bitmapItem.width, bitmapItem.height);
    } else if (bitmapItem) {
      // Draw placeholder with bitmap dimensions
      ctx.fillStyle = '#555555';
      ctx.fillRect(0, 0, bitmapItem.width, bitmapItem.height);
      ctx.strokeStyle = '#777777';
      ctx.lineWidth = 1;
      ctx.strokeRect(0, 0, bitmapItem.width, bitmapItem.height);
    } else {
      // No bitmap info, draw small placeholder
      ctx.fillStyle = '#555555';
      ctx.fillRect(0, 0, 100, 100);
    }

    ctx.restore();
  }

  private renderTextInstance(text: TextInstance, depth: number = 0): void {
    const ctx = this.ctx;
    ctx.save();

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
    for (const run of text.textRuns) {
      // Build font string
      const fontStyle = run.italic ? 'italic ' : '';
      const fontWeight = run.bold ? 'bold ' : '';
      const fontSize = run.size;
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

      for (const paragraph of paragraphs) {
        if (paragraph.length === 0) {
          yOffset += lineHeight;
          continue;
        }

        // Word wrap within text.width
        const wrappedLines = this.wrapText(ctx, paragraph, text.width, letterSpacing);

        for (const line of wrappedLines) {
          // Calculate line width for alignment
          const lineWidth = this.measureTextWidth(ctx, line, letterSpacing);

          // Calculate x position based on alignment
          let xPos = text.left;
          if (run.alignment === 'center') {
            xPos = text.left + (text.width - lineWidth) / 2;
          } else if (run.alignment === 'right') {
            xPos = text.left + text.width - lineWidth;
          }

          // Render with letter spacing
          this.renderTextWithSpacing(ctx, line, xPos, yOffset, letterSpacing);
          yOffset += lineHeight;
        }
      }
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

  // Render text character by character with letter spacing
  private renderTextWithSpacing(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    letterSpacing: number
  ): void {
    if (letterSpacing === 0) {
      ctx.fillText(text, x, y);
      return;
    }
    // Render each character with spacing
    let currentX = x;
    for (let i = 0; i < text.length; i++) {
      ctx.fillText(text[i], currentX, y);
      currentX += ctx.measureText(text[i]).width + letterSpacing;
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
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = stroke.weight;
        ctx.lineCap = stroke.caps === 'none' ? 'butt' : stroke.caps || 'round';
        ctx.lineJoin = stroke.joints || 'round';
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

        if (edge.fillStyle1 !== undefined) {
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

  private getFillStyle(fill: FillStyle): string | CanvasGradient {
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

    return '#000000';
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

    // Add color stops
    for (const entry of fill.gradient) {
      const color = entry.alpha < 1
        ? this.colorWithAlpha(entry.color, entry.alpha)
        : entry.color;
      gradient.addColorStop(Math.max(0, Math.min(1, entry.ratio)), color);
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
    }

    const gradient = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);

    // Add color stops
    for (const entry of fill.gradient) {
      const color = entry.alpha < 1
        ? this.colorWithAlpha(entry.color, entry.alpha)
        : entry.color;
      gradient.addColorStop(Math.max(0, Math.min(1, entry.ratio)), color);
    }

    return gradient;
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
}
