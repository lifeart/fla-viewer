import JSZip from 'jszip';
import type {
  FLADocument,
  Timeline,
  Layer,
  Frame,
  FrameSound,
  DisplayElement,
  SymbolInstance,
  VideoInstance,
  BitmapInstance,
  TextInstance,
  TextRun,
  Shape,
  Matrix,
  FillStyle,
  StrokeStyle,
  Symbol,
  BitmapItem,
  SoundItem,
  VideoItem,
  Point,
  Tween,
  Edge,
  Filter,
  MorphShape,
  MorphSegment,
  MorphCurve,
  ColorTransform,
  BlendMode
} from './types';
import { decodeEdges } from './edge-decoder';
import {
  normalizePath,
  setWithNormalizedPath,
  hasWithNormalizedPath,
  getFilename
} from './path-utils';

// Debug flag - enabled via ?debug=true URL parameter or setParserDebug(true)
let DEBUG = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug') === 'true';

// Export setter for testing
export function setParserDebug(value: boolean): void {
  DEBUG = value;
}

export type ProgressCallback = (message: string) => void;

export class FLAParser {
  private zip: JSZip | null = null;
  private symbolCache: Map<string, Symbol> = new Map();
  private parser = new DOMParser();

  async parse(file: File, onProgress?: ProgressCallback): Promise<FLADocument> {
    const progress = onProgress || (() => {});

    // Try to load ZIP, handling potentially corrupted files
    progress('Extracting archive...');
    try {
      this.zip = await JSZip.loadAsync(file);
    } catch (e) {
      // Some FLA files have minor corruption - try to repair by truncating
      progress('Repairing archive...');
      const arrayBuffer = await file.arrayBuffer();
      const repaired = await this.tryRepairZip(arrayBuffer);
      if (repaired) {
        this.zip = repaired;
      } else {
        throw e;
      }
    }
    this.symbolCache.clear();

    // Parse main document
    progress('Parsing document...');
    const domDocXml = await this.getFileContent('DOMDocument.xml');
    if (!domDocXml) {
      throw new Error('Invalid FLA file: DOMDocument.xml not found');
    }

    const doc = this.parser.parseFromString(domDocXml, 'text/xml');
    const root = doc.documentElement;

    // Get document properties
    const width = parseFloat(root.getAttribute('width') || '550') || 550;
    const height = parseFloat(root.getAttribute('height') || '400') || 400;
    const frameRate = parseFloat(root.getAttribute('frameRate') || '24') || 24;
    const backgroundColor = root.getAttribute('backgroundColor') || '#FFFFFF';

    // Parse symbol references and load them
    await this.loadSymbols(root, progress);

    // Parse bitmap items from media section and load images
    progress('Loading images...');
    const bitmaps = await this.parseBitmaps(root);

    // Parse sound items from media section and load audio
    progress('Loading audio...');
    const sounds = await this.parseSounds(root);

    // Parse video items from media section
    progress('Loading videos...');
    const videos = this.parseVideos(root);

    // Parse main timeline (pass dimensions for camera detection)
    progress('Building timeline...');
    const timelines = this.parseTimelines(root, width, height);

    return {
      width,
      height,
      frameRate,
      backgroundColor,
      timelines,
      symbols: this.symbolCache,
      bitmaps,
      sounds,
      videos
    };
  }

  private async tryRepairZip(buffer: ArrayBuffer): Promise<JSZip | null> {
    // The "missing X bytes" error usually means the central directory size is wrong
    // We can try to fix this by finding and patching the End of Central Directory record

    const bytes = new Uint8Array(buffer);

    // Find EOCD signature (0x06054b50) - search from end of file
    let eocdOffset = -1;
    for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 65557; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b &&
          bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
        eocdOffset = i;
        break;
      }
    }

    if (eocdOffset === -1) {
      console.warn('Could not find EOCD signature');
      return null;
    }

    // Try loading with the data up to and including EOCD
    // Sometimes files have extra data after EOCD that confuses parsers
    const view = new DataView(buffer);
    const commentLength = view.getUint16(eocdOffset + 20, true);
    const expectedEnd = eocdOffset + 22 + commentLength;

    if (expectedEnd < bytes.length) {
      try {
        const trimmedBuffer = buffer.slice(0, expectedEnd);
        const zip = await JSZip.loadAsync(trimmedBuffer);
        if (DEBUG) console.log(`ZIP repaired by trimming to EOCD boundary`);
        return zip;
      } catch {
        // Continue to other repair methods
      }
    }

    // Try patching the central directory size in EOCD
    const cdSize = view.getUint32(eocdOffset + 12, true);
    const cdOffset = view.getUint32(eocdOffset + 16, true);

    // Calculate actual size from offset to EOCD
    const actualCdSize = eocdOffset - cdOffset;

    if (actualCdSize !== cdSize) {
      try {
        // Create a patched copy
        const patched = new Uint8Array(buffer.slice(0));
        const patchedView = new DataView(patched.buffer);
        patchedView.setUint32(eocdOffset + 12, actualCdSize, true);

        const zip = await JSZip.loadAsync(patched.buffer);
        if (DEBUG) console.log(`ZIP repaired by patching CD size: ${cdSize} -> ${actualCdSize}`);
        return zip;
      } catch (e) {
        console.warn('CD size patch failed:', e);
      }
    }

    return null;
  }

  private async getFileContent(path: string): Promise<string | null> {
    if (!this.zip) return null;

    const file = this.zip.file(path);
    if (!file) return null;

    return await file.async('string');
  }

  /**
   * Find a file in the ZIP archive, handling path separator differences.
   * Tries multiple path variations and falls back to filename search.
   */
  private async findFileData(href: string, folder: string = 'LIBRARY'): Promise<ArrayBuffer | null> {
    if (!this.zip) return null;

    const normalizedHref = normalizePath(href);

    // Build list of paths to try
    const pathsToTry = [
      `${folder}/${normalizedHref}`,
      normalizedHref,
      `${folder.toLowerCase()}/${normalizedHref}`,
      `${folder}/${href}`,
      href,
    ];

    // Try each path with both forward and backslash variants
    for (const path of pathsToTry) {
      let file = this.zip.file(path);
      if (!file) {
        file = this.zip.file(path.replace(/\//g, '\\'));
      }
      if (file) {
        return await file.async('arraybuffer');
      }
    }

    // Fallback: search all files for matching filename
    const filename = getFilename(normalizedHref);
    const allFiles = Object.keys(this.zip.files);
    for (const filepath of allFiles) {
      const fileBasename = getFilename(filepath);
      if (fileBasename === filename) {
        const file = this.zip.file(filepath);
        if (file && !file.dir) {
          return await file.async('arraybuffer');
        }
      }
    }

    return null;
  }

  private async loadSymbols(root: Element, progress: ProgressCallback): Promise<void> {
    // Collect all symbol files to load (using Set with normalized paths to avoid duplicates)
    const seenPaths = new Set<string>();
    const symbolFiles: { path: string; filename: string }[] = [];

    const addSymbolFile = (path: string, filename: string) => {
      const normalizedFilename = normalizePath(filename);
      if (!seenPaths.has(normalizedFilename)) {
        seenPaths.add(normalizedFilename);
        symbolFiles.push({ path, filename });
      }
    };

    // First, collect from Include references
    const includes = root.querySelectorAll('symbols > Include');
    for (const inc of includes) {
      const href = inc.getAttribute('href');
      if (href) {
        addSymbolFile(`LIBRARY/${href}`, href);
      }
    }

    // Also scan all XML files in LIBRARY folder directly (handles encoding issues)
    if (this.zip) {
      const libraryFiles = Object.keys(this.zip.files).filter(
        path => (path.startsWith('LIBRARY/') || path.startsWith('LIBRARY\\')) &&
                (path.toLowerCase().endsWith('.xml'))
      );

      if (DEBUG) console.log(`Found ${libraryFiles.length} XML files in LIBRARY folder`);

      for (const path of libraryFiles) {
        const normalizedPath = normalizePath(path);
        const filename = normalizedPath.replace('LIBRARY/', '');
        addSymbolFile(path, filename);
      }
    }

    // Load symbols with progress
    const total = symbolFiles.length;
    for (let i = 0; i < total; i++) {
      const { path, filename } = symbolFiles[i];
      progress(`Loading symbols... (${i + 1}/${total})`);

      const symbolXml = await this.getFileContent(path);
      if (symbolXml) {
        await this.parseAndCacheSymbol(symbolXml, filename);
      }
    }

    if (DEBUG) {
      console.log(`Loaded ${this.symbolCache.size} symbols`);
      const symbolNames = Array.from(this.symbolCache.keys()).slice(0, 10);
      console.log('Symbol names (first 10):', symbolNames.map(n => JSON.stringify(n)));
    }
  }

  private async parseAndCacheSymbol(symbolXml: string, filename: string): Promise<void> {
    try {
      const symbolDoc = this.parser.parseFromString(symbolXml, 'text/xml');
      const symbolRoot = symbolDoc.documentElement;

      if (symbolRoot.tagName === 'DOMSymbolItem') {
        const rawName = symbolRoot.getAttribute('name') || filename.replace('.xml', '');
        const name = normalizePath(rawName);

        // Skip if already cached
        if (hasWithNormalizedPath(this.symbolCache, rawName)) return;

        const itemID = symbolRoot.getAttribute('itemID') || '';
        const symbolType = (symbolRoot.getAttribute('symbolType') || 'graphic') as 'graphic' | 'movieclip' | 'button';

        // Parse symbol's timeline
        const timelines = this.parseTimelines(symbolRoot);
        const timeline = timelines[0] || {
          name: name,
          layers: [],
          totalFrames: 1
        };

        const symbol: Symbol = { name, itemID, symbolType, timeline };

        // Store with both normalized and original names
        setWithNormalizedPath(this.symbolCache, rawName, symbol);
      }
    } catch (e) {
      console.warn(`Failed to parse symbol: ${filename}`, e);
    }
  }

  private parseTimelines(parent: globalThis.Element, docWidth?: number, docHeight?: number): Timeline[] {
    const timelines: Timeline[] = [];
    const timelineElements = parent.querySelectorAll(':scope > timelines > DOMTimeline, :scope > timeline > DOMTimeline');

    for (const tl of timelineElements) {
      const name = tl.getAttribute('name') || 'Timeline';
      const layers = this.parseLayers(tl);

      // Calculate total frames
      let totalFrames = 1;
      for (const layer of layers) {
        for (const frame of layer.frames) {
          const endFrame = frame.index + frame.duration;
          if (endFrame > totalFrames) {
            totalFrames = endFrame;
          }
        }
      }

      // Find camera layer using generic detection
      const cameraLayerIndex = this.detectCameraLayer(layers, docWidth, docHeight);

      // Detect all reference layers that should not be rendered
      const referenceLayers = this.detectReferenceLayers(layers, docWidth, docHeight);

      // Also add camera layer to reference layers if detected
      if (cameraLayerIndex !== undefined) {
        referenceLayers.add(cameraLayerIndex);
      }

      timelines.push({ name, layers, totalFrames, cameraLayerIndex, referenceLayers });
    }

    return timelines;
  }

  private detectCameraLayer(layers: Layer[], docWidth?: number, docHeight?: number): number | undefined {
    // Camera layer detection based on STRICT criteria:
    // Camera layers must have ALL of:
    // 1. A camera-related name (ramka, camera, cam, viewport)
    // 2. Be a guide layer OR hidden/outline layer
    // 3. Have exactly one symbol element centered in the document
    //
    // This is very conservative to avoid false positives that shift the viewport incorrectly

    if (!docWidth || !docHeight) return undefined;

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const layerNameLower = layer.name.toLowerCase();

      // REQUIRED: Layer name must indicate it's a camera/viewport layer
      const isCameraName = layerNameLower === 'ramka' ||
                           layerNameLower === 'camera' ||
                           layerNameLower === 'cam' ||
                           layerNameLower === 'viewport' ||
                           layerNameLower.includes('camera') ||
                           layerNameLower.includes('viewport');

      if (!isCameraName) continue;

      // Check if layer has frames with elements
      if (layer.frames.length === 0) continue;

      const firstFrame = layer.frames[0];
      if (firstFrame.elements.length !== 1) continue;

      const element = firstFrame.elements[0];
      if (element.type !== 'symbol') continue;

      // Check for explicit camera layer indicators
      const isGuideLayer = layer.layerType === 'guide';
      const isHiddenOrOutline = !layer.visible || layer.outline;

      // Only consider guide layers or hidden/outline layers as camera candidates
      if (!isGuideLayer && !isHiddenOrOutline) continue;

      // Check if transformation point is near document center
      // Use per-axis tolerances to handle non-square aspect ratios correctly
      let isNearCenter = false;
      if (element.transformationPoint) {
        const centerX = docWidth / 2;
        const centerY = docHeight / 2;
        // Use 15% of each dimension separately
        const toleranceX = docWidth * 0.15;
        const toleranceY = docHeight * 0.15;

        const dx = Math.abs(element.transformationPoint.x - centerX);
        const dy = Math.abs(element.transformationPoint.y - centerY);
        isNearCenter = dx < toleranceX && dy < toleranceY;
      }

      if (isNearCenter) {
        if (DEBUG) console.log(`Detected camera layer: "${layer.name}" at index ${i} (guide=${isGuideLayer}, hiddenOrOutline=${isHiddenOrOutline}, nearCenter=${isNearCenter})`);
        return i;
      }
    }

    return undefined;
  }

  // Detect all reference layers that should not be rendered (camera frames, guides, etc.)
  // Note: Be conservative - only filter layers that are CLEARLY reference layers
  // to avoid accidentally hiding legitimate content layers
  detectReferenceLayers(layers: Layer[], _docWidth?: number, _docHeight?: number): Set<number> {
    const referenceLayers = new Set<number>();

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const layerNameLower = layer.name.toLowerCase();

      // Always skip guide, folder, and camera layers (explicit layer types)
      if (layer.layerType === 'guide' || layer.layerType === 'folder' || layer.layerType === 'camera') {
        referenceLayers.add(i);
        continue;
      }

      // Skip transparent reference layers (used for tracing/onion-skinning)
      // These are layers with transparency enabled and low alpha, meant as reference only
      if (layer.transparent && layer.alphaPercent !== undefined && layer.alphaPercent < 50) {
        if (DEBUG) console.log(`Skipping transparent reference layer: "${layer.name}" at index ${i} (alpha=${layer.alphaPercent}%)`);
        referenceLayers.add(i);
        continue;
      }

      // Skip camera/frame reference layers only if they have additional indicators
      // that they're not meant to be rendered (outline view, etc.)
      const isCameraRefName = layerNameLower === 'ramka' ||
                              layerNameLower === 'camera' ||
                              layerNameLower === 'cam' ||
                              layerNameLower === 'viewport';

      // Only filter by name if the layer is also using outline view
      // This prevents filtering legitimate content layers that happen to have these names
      if (isCameraRefName && layer.outline) {
        referenceLayers.add(i);
        continue;
      }
    }

    // Note: Removed the locked && isNearCenter heuristic as it was too aggressive
    // and incorrectly filtered legitimate background layers

    return referenceLayers;
  }

  private parseLayers(timeline: globalThis.Element): Layer[] {
    const layers: Layer[] = [];
    const layerElements = timeline.querySelectorAll(':scope > layers > DOMLayer');

    for (const layerEl of layerElements) {
      const name = layerEl.getAttribute('name') || 'Layer';
      const color = layerEl.getAttribute('color') || '#000000';
      const visible = layerEl.getAttribute('visible') !== 'false';
      const locked = layerEl.getAttribute('locked') === 'true';
      const outline = layerEl.getAttribute('outline') === 'true';
      const transparent = layerEl.getAttribute('transparent') === 'true';
      const alphaPercentAttr = layerEl.getAttribute('alphaPercent');
      const alphaPercent = alphaPercentAttr ? parseInt(alphaPercentAttr) : undefined;
      const layerType = layerEl.getAttribute('layerType') as Layer['layerType'];
      const parentLayerIndex = layerEl.getAttribute('parentLayerIndex');

      const frames = this.parseFrames(layerEl);

      layers.push({
        name,
        color,
        visible,
        locked,
        outline,
        transparent,
        alphaPercent,
        layerType: layerType || 'normal',
        parentLayerIndex: parentLayerIndex ? parseInt(parentLayerIndex) : undefined,
        frames
      });
    }

    // Build mask relationships: layers with parentLayerIndex pointing to a mask layer are masked
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      if (layer.parentLayerIndex !== undefined) {
        const parentLayer = layers[layer.parentLayerIndex];
        if (parentLayer && parentLayer.layerType === 'mask') {
          layer.layerType = 'masked';
          layer.maskLayerIndex = layer.parentLayerIndex;
        }
      }
    }

    return layers;
  }

  private parseFrames(layer: globalThis.Element): Frame[] {
    const frames: Frame[] = [];
    const frameElements = layer.querySelectorAll(':scope > frames > DOMFrame');

    for (const frameEl of frameElements) {
      const index = parseInt(frameEl.getAttribute('index') || '0');
      // Duration must be at least 1 to avoid division by zero in tween calculations
      const duration = Math.max(1, parseInt(frameEl.getAttribute('duration') || '1') || 1);
      const keyMode = parseInt(frameEl.getAttribute('keyMode') || '0');
      const tweenType = frameEl.getAttribute('tweenType') as 'motion' | 'shape' | undefined;
      const acceleration = frameEl.getAttribute('acceleration');

      const elements = this.parseElements(frameEl);
      const tweens = this.parseTweens(frameEl);

      // Parse sound reference
      const sound = this.parseFrameSound(frameEl);

      // Parse morph shape for shape tweens
      const morphShape = tweenType === 'shape' ? this.parseMorphShape(frameEl) : undefined;

      frames.push({
        index,
        duration,
        keyMode,
        tweenType: tweenType || 'none',
        acceleration: acceleration ? parseInt(acceleration) : undefined,
        elements,
        tweens,
        sound,
        ...(morphShape && { morphShape })
      });
    }

    return frames;
  }

  private parseFrameSound(frame: globalThis.Element): FrameSound | undefined {
    const soundName = frame.getAttribute('soundName');
    if (!soundName) return undefined;

    const soundSync = (frame.getAttribute('soundSync') || 'event') as FrameSound['sync'];
    const inPoint44 = frame.getAttribute('inPoint44');
    const outPoint44 = frame.getAttribute('outPoint44');
    const loopCount = frame.getAttribute('soundLoopMode') === 'loop'
      ? parseInt(frame.getAttribute('soundLoop') || '1')
      : undefined;

    return {
      name: soundName,
      sync: soundSync,
      inPoint44: inPoint44 ? parseInt(inPoint44) : undefined,
      outPoint44: outPoint44 ? parseInt(outPoint44) : undefined,
      loopCount
    };
  }

  private parseTweens(frame: globalThis.Element): Tween[] {
    const tweens: Tween[] = [];
    const tweenElements = frame.querySelectorAll(':scope > tweens > Ease, :scope > tweens > CustomEase');

    for (const tweenEl of tweenElements) {
      const target = tweenEl.getAttribute('target') || 'all';

      if (tweenEl.tagName === 'Ease') {
        const intensity = tweenEl.getAttribute('intensity');
        tweens.push({
          target,
          intensity: intensity ? parseInt(intensity) : 0
        });
      } else if (tweenEl.tagName === 'CustomEase') {
        const points: Point[] = [];
        const pointElements = tweenEl.querySelectorAll('Point');
        for (const pt of pointElements) {
          points.push({
            x: parseFloat(pt.getAttribute('x') || '0'),
            y: parseFloat(pt.getAttribute('y') || '0')
          });
        }
        tweens.push({ target, customEase: points });
      }
    }

    return tweens;
  }

  private parseElements(frame: globalThis.Element): DisplayElement[] {
    const elements: DisplayElement[] = [];
    const elementsContainer = frame.querySelector(':scope > elements');
    if (!elementsContainer) return elements;

    // Identity matrix as the starting parent transform
    const identityMatrix: Matrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

    // Parse direct children in document order to preserve z-ordering
    for (const child of elementsContainer.children) {
      switch (child.tagName) {
        case 'DOMSymbolInstance':
          elements.push(this.parseSymbolInstance(child, identityMatrix));
          break;
        case 'DOMShape':
          elements.push(this.parseShape(child, identityMatrix));
          break;
        case 'DOMGroup':
          this.parseGroupMembers(child, elements, identityMatrix);
          break;
        case 'DOMVideoInstance':
          elements.push(this.parseVideoInstance(child));
          break;
        case 'DOMBitmapInstance':
          elements.push(this.parseBitmapInstance(child, identityMatrix));
          break;
        case 'DOMStaticText':
        case 'DOMDynamicText':
        case 'DOMInputText':
          elements.push(this.parseTextInstance(child, identityMatrix));
          break;
      }
    }

    return elements;
  }

  private parseGroupMembers(group: globalThis.Element, elements: DisplayElement[], ancestorMatrix: Matrix): void {
    const members = group.querySelector(':scope > members');
    if (!members) return;

    // Get the group's own matrix and compose with ancestors for nested groups
    const groupMatrix = this.parseMatrix(group.querySelector(':scope > matrix > Matrix'));
    const composedMatrix = this.composeMatrices(ancestorMatrix, groupMatrix);

    // Parse children in document order to preserve z-ordering
    // Elements WITH matrix: use their matrix directly (Flash stores absolute matrices)
    // Elements WITHOUT matrix: use composedMatrix (element at identity within parent's coordinate space)
    for (const child of members.children) {
      switch (child.tagName) {
        case 'DOMShape':
          elements.push(this.parseShape(child, composedMatrix));
          break;
        case 'DOMGroup':
          this.parseGroupMembers(child, elements, composedMatrix);
          break;
        case 'DOMSymbolInstance':
          elements.push(this.parseSymbolInstance(child, composedMatrix));
          break;
        case 'DOMVideoInstance':
          elements.push(this.parseVideoInstance(child));
          break;
        case 'DOMBitmapInstance':
          elements.push(this.parseBitmapInstance(child, composedMatrix));
          break;
        case 'DOMStaticText':
        case 'DOMDynamicText':
        case 'DOMInputText':
          elements.push(this.parseTextInstance(child, composedMatrix));
          break;
      }
    }
  }

  // Compose two matrices: result = parent * child
  private composeMatrices(parent: Matrix, child: Matrix): Matrix {
    return {
      a: parent.a * child.a + parent.c * child.b,
      b: parent.b * child.a + parent.d * child.b,
      c: parent.a * child.c + parent.c * child.d,
      d: parent.b * child.c + parent.d * child.d,
      tx: parent.a * child.tx + parent.c * child.ty + parent.tx,
      ty: parent.b * child.tx + parent.d * child.ty + parent.ty
    };
  }


  private parseSymbolInstance(el: globalThis.Element, composedMatrix?: Matrix): SymbolInstance {
    const libraryItemName = el.getAttribute('libraryItemName') || '';
    const symbolType = (el.getAttribute('symbolType') || 'graphic') as 'graphic' | 'movieclip' | 'button';
    const loop = (el.getAttribute('loop') || 'loop') as 'loop' | 'play once' | 'single frame';
    const firstFrame = el.getAttribute('firstFrame');

    const matrixEl = el.querySelector('matrix > Matrix');
    let matrix: Matrix;
    const transformationPoint = this.parsePoint(el.querySelector('transformationPoint > Point'));

    if (matrixEl) {
      // Element has its own matrix - use it directly
      // Flash appears to store the final/absolute matrix on elements
      matrix = this.parseMatrix(matrixEl);
    } else {
      // Element has NO matrix - use composedMatrix (full ancestor chain)
      matrix = composedMatrix || this.parseMatrix(null);
    }

    // Parse 3D center point if present
    const centerPoint3DX = el.getAttribute('centerPoint3DX');
    const centerPoint3DY = el.getAttribute('centerPoint3DY');
    const centerPoint3D = (centerPoint3DX || centerPoint3DY)
      ? { x: parseFloat(centerPoint3DX || '0'), y: parseFloat(centerPoint3DY || '0') }
      : undefined;

    // Parse filters
    const filters = this.parseFilters(el);

    // Parse color transform
    const colorTransform = this.parseColorTransform(el);

    // Parse blend mode
    const blendModeAttr = el.getAttribute('blendMode');
    const blendMode = this.parseBlendMode(blendModeAttr);

    return {
      type: 'symbol',
      libraryItemName,
      symbolType,
      matrix,
      transformationPoint,
      centerPoint3D,
      loop,
      firstFrame: firstFrame ? parseInt(firstFrame) : undefined,
      ...(filters.length > 0 && { filters }),
      ...(colorTransform && { colorTransform }),
      ...(blendMode && { blendMode })
    };
  }

  private parseVideoInstance(el: globalThis.Element): VideoInstance {
    const libraryItemName = el.getAttribute('libraryItemName') || '';
    const frameRight = el.getAttribute('frameRight');
    const frameBottom = el.getAttribute('frameBottom');
    const matrix = this.parseMatrix(el.querySelector('matrix > Matrix'));

    return {
      type: 'video',
      libraryItemName,
      matrix,
      // frameRight/frameBottom are in twips (1/20 of a pixel)
      width: frameRight ? parseInt(frameRight) / 20 : 320,
      height: frameBottom ? parseInt(frameBottom) / 20 : 240
    };
  }

  private parseBitmapInstance(el: globalThis.Element, composedMatrix?: Matrix): BitmapInstance {
    const libraryItemName = el.getAttribute('libraryItemName') || '';
    const matrixEl = el.querySelector('matrix > Matrix');
    let matrix: Matrix;

    if (matrixEl) {
      // Element has its own matrix - use it directly
      // Flash appears to store the final/absolute matrix on elements
      matrix = this.parseMatrix(matrixEl);
    } else {
      // Element has NO matrix - use composedMatrix (full ancestor chain)
      matrix = composedMatrix || this.parseMatrix(null);
    }

    return {
      type: 'bitmap',
      libraryItemName,
      matrix
    };
  }

  private parseTextInstance(el: globalThis.Element, composedMatrix?: Matrix): TextInstance {
    const matrixEl = el.querySelector(':scope > matrix > Matrix');
    let matrix: Matrix;

    if (matrixEl) {
      matrix = this.parseMatrix(matrixEl);
    } else {
      matrix = composedMatrix || this.parseMatrix(null);
    }

    const left = parseFloat(el.getAttribute('left') || '0');
    const width = parseFloat(el.getAttribute('width') || '100');
    const height = parseFloat(el.getAttribute('height') || '20');

    const textRuns: TextRun[] = [];
    const textRunElements = el.querySelectorAll('textRuns > DOMTextRun');

    for (const runEl of textRunElements) {
      const charactersEl = runEl.querySelector('characters');
      const characters = charactersEl?.textContent || '';

      const attrsEl = runEl.querySelector('textAttrs > DOMTextAttrs');
      const alignment = (attrsEl?.getAttribute('alignment') || 'left') as TextRun['alignment'];
      const size = parseFloat(attrsEl?.getAttribute('size') || '12');
      const lineHeight = parseFloat(attrsEl?.getAttribute('lineHeight') || String(size));
      const face = attrsEl?.getAttribute('face') || undefined;
      const fillColor = attrsEl?.getAttribute('fillColor') || '#000000';
      const bold = attrsEl?.getAttribute('bold') === 'true';
      const italic = attrsEl?.getAttribute('italic') === 'true';
      const letterSpacing = attrsEl?.getAttribute('letterSpacing')
        ? parseFloat(attrsEl.getAttribute('letterSpacing')!)
        : undefined;

      textRuns.push({
        characters,
        alignment,
        size,
        lineHeight,
        face,
        fillColor,
        bold,
        italic,
        letterSpacing
      });
    }

    // Parse filters
    const filters = this.parseFilters(el);

    return {
      type: 'text',
      matrix,
      left,
      width,
      height,
      textRuns,
      ...(filters.length > 0 && { filters })
    };
  }

  private parseShape(el: globalThis.Element, composedMatrix?: Matrix): Shape {
    // Use :scope to only look for direct child matrix, not gradient matrices inside fills
    const matrixEl = el.querySelector(':scope > matrix > Matrix');
    let matrix: Matrix;

    if (matrixEl) {
      // Element has its own matrix - use it directly
      // Flash appears to store the final/absolute matrix on elements
      matrix = this.parseMatrix(matrixEl);
    } else {
      // Shape has NO matrix - use composedMatrix (full ancestor chain)
      // Shape is at identity position within parent's coordinate space
      matrix = composedMatrix || this.parseMatrix(null);
    }
    const fills = this.parseFills(el);
    const strokes = this.parseStrokes(el);
    const edges = this.parseShapeEdges(el);

    return {
      type: 'shape',
      matrix,
      fills,
      strokes,
      edges
    };
  }

  private parseFills(shape: globalThis.Element): FillStyle[] {
    const fills: FillStyle[] = [];
    const fillElements = shape.querySelectorAll('fills > FillStyle');

    for (const fillEl of fillElements) {
      const index = parseInt(fillEl.getAttribute('index') || '1');

      // Check for solid color
      const solidColor = fillEl.querySelector('SolidColor');
      if (solidColor) {
        const color = solidColor.getAttribute('color') || '#000000';
        const alpha = solidColor.getAttribute('alpha');
        fills.push({
          index,
          type: 'solid',
          color,
          alpha: alpha ? parseFloat(alpha) : 1
        });
        continue;
      }

      // Check for linear gradient
      const linearGradient = fillEl.querySelector('LinearGradient');
      if (linearGradient) {
        fills.push({
          index,
          type: 'linear',
          gradient: this.parseGradientEntries(linearGradient),
          matrix: this.parseMatrix(linearGradient.querySelector('matrix > Matrix'))
        });
        continue;
      }

      // Check for radial gradient
      const radialGradient = fillEl.querySelector('RadialGradient');
      if (radialGradient) {
        fills.push({
          index,
          type: 'radial',
          gradient: this.parseGradientEntries(radialGradient),
          matrix: this.parseMatrix(radialGradient.querySelector('matrix > Matrix'))
        });
        continue;
      }

      // Check for bitmap fill
      const bitmapFill = fillEl.querySelector('BitmapFill');
      if (bitmapFill) {
        const bitmapPath = bitmapFill.getAttribute('bitmapPath') || '';
        const matrixEl = bitmapFill.querySelector('matrix > Matrix');
        const fill: FillStyle = {
          index,
          type: 'bitmap',
          bitmapPath: normalizePath(bitmapPath),
        };
        if (matrixEl) {
          fill.matrix = this.parseMatrix(matrixEl);
        }
        fills.push(fill);
        continue;
      }
    }

    return fills;
  }

  private parseGradientEntries(gradient: globalThis.Element): { color: string; alpha: number; ratio: number }[] {
    const entries: { color: string; alpha: number; ratio: number }[] = [];
    const entryElements = gradient.querySelectorAll('GradientEntry');

    for (const entry of entryElements) {
      entries.push({
        color: entry.getAttribute('color') || '#000000',
        alpha: parseFloat(entry.getAttribute('alpha') || '1'),
        ratio: parseFloat(entry.getAttribute('ratio') || '0')
      });
    }

    return entries;
  }

  private parseStrokes(shape: globalThis.Element): StrokeStyle[] {
    const strokes: StrokeStyle[] = [];
    const strokeElements = shape.querySelectorAll('strokes > StrokeStyle');

    for (const strokeEl of strokeElements) {
      const index = parseInt(strokeEl.getAttribute('index') || '1');

      // Check for SolidStroke
      const solidStroke = strokeEl.querySelector('SolidStroke');
      if (solidStroke) {
        const weight = parseFloat(solidStroke.getAttribute('weight') || '1');
        const caps = (solidStroke.getAttribute('caps') || 'round') as 'none' | 'round' | 'square';
        const joints = (solidStroke.getAttribute('joints') || 'round') as 'miter' | 'round' | 'bevel';

        // Get stroke color from nested fill > SolidColor
        const solidColor = solidStroke.querySelector('fill > SolidColor');
        const color = solidColor?.getAttribute('color') || '#000000';

        strokes.push({
          index,
          color,
          weight,
          caps,
          joints
        });
        continue;
      }

      // Check for DashedStroke (treat similar to SolidStroke for now)
      const dashedStroke = strokeEl.querySelector('DashedStroke');
      if (dashedStroke) {
        const weight = parseFloat(dashedStroke.getAttribute('weight') || '1');
        const caps = (dashedStroke.getAttribute('caps') || 'round') as 'none' | 'round' | 'square';
        const joints = (dashedStroke.getAttribute('joints') || 'round') as 'miter' | 'round' | 'bevel';

        const solidColor = dashedStroke.querySelector('fill > SolidColor');
        const color = solidColor?.getAttribute('color') || '#000000';

        strokes.push({
          index,
          color,
          weight,
          caps,
          joints
        });
        continue;
      }
    }

    return strokes;
  }

  private async parseBitmaps(root: globalThis.Element): Promise<Map<string, BitmapItem>> {
    const bitmaps = new Map<string, BitmapItem>();
    const bitmapElements = root.querySelectorAll('media > DOMBitmapItem');

    const loadPromises: Promise<void>[] = [];

    for (const bitmapEl of bitmapElements) {
      const rawName = bitmapEl.getAttribute('name') || '';
      const name = normalizePath(rawName);
      const href = bitmapEl.getAttribute('href') || rawName;
      const frameRight = bitmapEl.getAttribute('frameRight');
      const frameBottom = bitmapEl.getAttribute('frameBottom');
      const sourceExternalFilepath = bitmapEl.getAttribute('sourceExternalFilepath') || undefined;

      // Dimensions are in twips (1/20 of a pixel)
      const width = frameRight ? parseInt(frameRight) / 20 : 0;
      const height = frameBottom ? parseInt(frameBottom) / 20 : 0;

      const bitmapItem: BitmapItem = {
        name,
        href,
        width,
        height,
        sourceExternalFilepath
      };

      // Store with both normalized and original names
      setWithNormalizedPath(bitmaps, rawName, bitmapItem);

      // Load actual image data from ZIP
      loadPromises.push(this.loadBitmapImage(bitmapItem));
    }

    // Wait for all images to load
    await Promise.all(loadPromises);

    return bitmaps;
  }

  private async loadBitmapImage(bitmapItem: BitmapItem): Promise<void> {
    const imageData = await this.findFileData(bitmapItem.href);

    if (!imageData) {
      if (DEBUG) {
        console.warn(`Bitmap image not found: ${bitmapItem.href}`);
      }
      return;
    }

    // Determine MIME type from extension
    const ext = getFilename(bitmapItem.href).toLowerCase().split('.').pop();
    const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
                   : ext === 'gif' ? 'image/gif'
                   : 'image/png';

    // Create blob and load as image
    const blob = new Blob([imageData], { type: mimeType });
    const url = URL.createObjectURL(blob);

    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(`Failed to load image: ${bitmapItem.href}`));
        img.src = url;
      });
      bitmapItem.imageData = img;
    } catch (e) {
      if (DEBUG) {
        console.warn(`Failed to load bitmap: ${bitmapItem.href}`, e);
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private audioContext: AudioContext | null = null;

  private async parseSounds(root: globalThis.Element): Promise<Map<string, SoundItem>> {
    const sounds = new Map<string, SoundItem>();
    const soundElements = root.querySelectorAll('media > DOMSoundItem');

    const loadPromises: Promise<void>[] = [];

    for (const soundEl of soundElements) {
      const name = soundEl.getAttribute('name') || '';
      const href = soundEl.getAttribute('href') || name;
      const format = soundEl.getAttribute('format') || undefined;
      const sampleCount = soundEl.getAttribute('sampleCount')
        ? parseInt(soundEl.getAttribute('sampleCount')!)
        : undefined;

      const soundItem: SoundItem = {
        name,
        href,
        format,
        sampleCount
      };

      sounds.set(name, soundItem);

      // Load actual audio data from ZIP
      loadPromises.push(this.loadSoundAudio(soundItem));
    }

    // Wait for all sounds to load
    await Promise.all(loadPromises);

    return sounds;
  }

  private async loadSoundAudio(soundItem: SoundItem): Promise<void> {
    // Initialize AudioContext lazily
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }

    const audioData = await this.findFileData(soundItem.href);

    if (!audioData) {
      if (DEBUG) {
        console.warn(`Sound file not found: ${soundItem.href}`);
      }
      return;
    }

    try {
      soundItem.audioData = await this.audioContext.decodeAudioData(audioData);
      if (DEBUG) {
        console.log(`Loaded sound: ${soundItem.name}, duration: ${soundItem.audioData.duration.toFixed(2)}s`);
      }
    } catch (e) {
      if (DEBUG) {
        console.warn(`Failed to decode audio: ${soundItem.href}`, e);
      }
    }
  }

  private parseVideos(root: globalThis.Element): Map<string, VideoItem> {
    const videos = new Map<string, VideoItem>();
    const videoElements = root.querySelectorAll('media > DOMVideoItem');

    for (const videoEl of videoElements) {
      const name = videoEl.getAttribute('name') || '';
      const href = videoEl.getAttribute('videoDataHRef') || '';
      const frameRight = videoEl.getAttribute('width');
      const frameBottom = videoEl.getAttribute('height');
      const fps = videoEl.getAttribute('fps');
      const length = videoEl.getAttribute('length');
      const videoType = videoEl.getAttribute('videoType') || undefined;
      const sourceExternalFilepath = videoEl.getAttribute('sourceExternalFilepath') || undefined;

      const videoItem: VideoItem = {
        name,
        href,
        width: frameRight ? parseInt(frameRight) : 0,
        height: frameBottom ? parseInt(frameBottom) : 0,
        fps: fps ? parseFloat(fps) : undefined,
        duration: length ? parseFloat(length) : undefined,
        videoType,
        sourceExternalFilepath
      };

      videos.set(name, videoItem);

      if (DEBUG) {
        console.log(`Found video: ${name}, ${videoItem.width}x${videoItem.height}, ${videoItem.fps}fps`);
      }
    }

    return videos;
  }

  private parseShapeEdges(shape: globalThis.Element): Edge[] {
    const edges: Edge[] = [];
    const edgeElements = shape.querySelectorAll('edges > Edge');

    for (const edgeEl of edgeElements) {
      const fillStyle0 = edgeEl.getAttribute('fillStyle0');
      const fillStyle1 = edgeEl.getAttribute('fillStyle1');
      const strokeStyle = edgeEl.getAttribute('strokeStyle');

      // Check for cubics attribute first (cubic bezier), fallback to edges (quadratic)
      const cubicsAttr = edgeEl.getAttribute('cubics');
      const edgesAttr = edgeEl.getAttribute('edges');
      const pathData = cubicsAttr || edgesAttr || '';

      edges.push({
        fillStyle0: fillStyle0 ? parseInt(fillStyle0) : undefined,
        fillStyle1: fillStyle1 ? parseInt(fillStyle1) : undefined,
        strokeStyle: strokeStyle ? parseInt(strokeStyle) : undefined,
        commands: decodeEdges(pathData)
      });
    }

    return edges;
  }

  private parseMatrix(el: Element | null): Matrix {
    if (!el) {
      return { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
    }

    // parseFloat on empty string returns NaN, so we need to handle that
    const a = parseFloat(el.getAttribute('a') || '1');
    const b = parseFloat(el.getAttribute('b') || '0');
    const c = parseFloat(el.getAttribute('c') || '0');
    const d = parseFloat(el.getAttribute('d') || '1');
    const tx = parseFloat(el.getAttribute('tx') || '0');
    const ty = parseFloat(el.getAttribute('ty') || '0');

    return {
      a: Number.isFinite(a) ? a : 1,
      b: Number.isFinite(b) ? b : 0,
      c: Number.isFinite(c) ? c : 0,
      d: Number.isFinite(d) ? d : 1,
      tx: Number.isFinite(tx) ? tx : 0,
      ty: Number.isFinite(ty) ? ty : 0
    };
  }

  private parsePoint(el: Element | null): Point {
    if (!el) {
      return { x: 0, y: 0 };
    }

    const x = parseFloat(el.getAttribute('x') || '0');
    const y = parseFloat(el.getAttribute('y') || '0');

    return {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0
    };
  }

  // Parse filters from <filters> element
  private parseFilters(el: globalThis.Element): Filter[] {
    const filtersEl = el.querySelector(':scope > filters');
    if (!filtersEl) return [];

    const filters: Filter[] = [];

    for (const child of filtersEl.children) {
      switch (child.tagName) {
        case 'BlurFilter':
          filters.push({
            type: 'blur',
            blurX: parseFloat(child.getAttribute('blurX') || '0'),
            blurY: parseFloat(child.getAttribute('blurY') || '0'),
            quality: parseInt(child.getAttribute('quality') || '1')
          });
          break;

        case 'GlowFilter':
          filters.push({
            type: 'glow',
            blurX: parseFloat(child.getAttribute('blurX') || '0'),
            blurY: parseFloat(child.getAttribute('blurY') || '0'),
            color: child.getAttribute('color') || '#000000',
            // Strength is stored as 0-255 in XFL, normalize to 0-1
            strength: parseFloat(child.getAttribute('strength') || '100') / 255,
            alpha: parseFloat(child.getAttribute('alpha') || '1'),
            inner: child.getAttribute('inner') === 'true',
            knockout: child.getAttribute('knockout') === 'true',
            quality: parseInt(child.getAttribute('quality') || '1')
          });
          break;

        case 'DropShadowFilter':
          filters.push({
            type: 'dropShadow',
            blurX: parseFloat(child.getAttribute('blurX') || '0'),
            blurY: parseFloat(child.getAttribute('blurY') || '0'),
            color: child.getAttribute('color') || '#000000',
            strength: parseFloat(child.getAttribute('strength') || '100') / 255,
            alpha: parseFloat(child.getAttribute('alpha') || '1'),
            distance: parseFloat(child.getAttribute('distance') || '4'),
            angle: parseFloat(child.getAttribute('angle') || '45'),
            inner: child.getAttribute('inner') === 'true',
            knockout: child.getAttribute('knockout') === 'true',
            hideObject: child.getAttribute('hideObject') === 'true',
            quality: parseInt(child.getAttribute('quality') || '1')
          });
          break;
      }
    }

    return filters;
  }

  // Parse ColorTransform from <color> element
  private parseColorTransform(el: globalThis.Element): ColorTransform | undefined {
    const colorEl = el.querySelector(':scope > color > Color');
    if (!colorEl) return undefined;

    const transform: ColorTransform = {};
    let hasValues = false;

    // Alpha multiplier (0-1)
    const alphaMultiplier = colorEl.getAttribute('alphaMultiplier');
    if (alphaMultiplier !== null) {
      transform.alphaMultiplier = parseFloat(alphaMultiplier);
      hasValues = true;
    }

    // Alpha offset (-255 to 255)
    const alphaOffset = colorEl.getAttribute('alphaOffset');
    if (alphaOffset !== null) {
      transform.alphaOffset = parseFloat(alphaOffset);
      hasValues = true;
    }

    // Red multiplier (0-1)
    const redMultiplier = colorEl.getAttribute('redMultiplier');
    if (redMultiplier !== null) {
      transform.redMultiplier = parseFloat(redMultiplier);
      hasValues = true;
    }

    // Red offset (-255 to 255)
    const redOffset = colorEl.getAttribute('redOffset');
    if (redOffset !== null) {
      transform.redOffset = parseFloat(redOffset);
      hasValues = true;
    }

    // Green multiplier (0-1)
    const greenMultiplier = colorEl.getAttribute('greenMultiplier');
    if (greenMultiplier !== null) {
      transform.greenMultiplier = parseFloat(greenMultiplier);
      hasValues = true;
    }

    // Green offset (-255 to 255)
    const greenOffset = colorEl.getAttribute('greenOffset');
    if (greenOffset !== null) {
      transform.greenOffset = parseFloat(greenOffset);
      hasValues = true;
    }

    // Blue multiplier (0-1)
    const blueMultiplier = colorEl.getAttribute('blueMultiplier');
    if (blueMultiplier !== null) {
      transform.blueMultiplier = parseFloat(blueMultiplier);
      hasValues = true;
    }

    // Blue offset (-255 to 255)
    const blueOffset = colorEl.getAttribute('blueOffset');
    if (blueOffset !== null) {
      transform.blueOffset = parseFloat(blueOffset);
      hasValues = true;
    }

    // Brightness (-1 to 1)
    const brightness = colorEl.getAttribute('brightness');
    if (brightness !== null) {
      // Convert brightness to color multipliers/offsets
      // Positive brightness increases all colors, negative decreases
      const b = parseFloat(brightness);
      if (b >= 0) {
        // Positive: multiply by (1-b) and add b*255
        transform.redMultiplier = 1 - b;
        transform.greenMultiplier = 1 - b;
        transform.blueMultiplier = 1 - b;
        transform.redOffset = b * 255;
        transform.greenOffset = b * 255;
        transform.blueOffset = b * 255;
      } else {
        // Negative: multiply by (1+b)
        transform.redMultiplier = 1 + b;
        transform.greenMultiplier = 1 + b;
        transform.blueMultiplier = 1 + b;
      }
      hasValues = true;
    }

    // Tint (tintMultiplier + tintColor)
    const tintMultiplier = colorEl.getAttribute('tintMultiplier');
    const tintColor = colorEl.getAttribute('tintColor');
    if (tintMultiplier !== null && tintColor !== null) {
      const tint = parseFloat(tintMultiplier);
      // Parse tint color
      const colorHex = tintColor.replace('#', '');
      const r = parseInt(colorHex.substring(0, 2), 16);
      const g = parseInt(colorHex.substring(2, 4), 16);
      const b = parseInt(colorHex.substring(4, 6), 16);

      // Apply tint: newColor = originalColor * (1 - tint) + tintColor * tint
      transform.redMultiplier = 1 - tint;
      transform.greenMultiplier = 1 - tint;
      transform.blueMultiplier = 1 - tint;
      transform.redOffset = r * tint;
      transform.greenOffset = g * tint;
      transform.blueOffset = b * tint;
      hasValues = true;
    }

    return hasValues ? transform : undefined;
  }

  // Parse blend mode from attribute value
  private parseBlendMode(value: string | null): BlendMode | undefined {
    if (!value || value === 'normal') return undefined;

    // Map Flash blend mode names to our BlendMode type
    const blendModeMap: Record<string, BlendMode> = {
      'normal': 'normal',
      'layer': 'layer',
      'multiply': 'multiply',
      'screen': 'screen',
      'overlay': 'overlay',
      'darken': 'darken',
      'lighten': 'lighten',
      'hardlight': 'hardlight',
      'hard light': 'hardlight',  // Alternative format
      'add': 'add',
      'subtract': 'subtract',
      'difference': 'difference',
      'invert': 'invert',
      'alpha': 'alpha',
      'erase': 'erase',
    };

    const normalized = value.toLowerCase();
    return blendModeMap[normalized] || undefined;
  }

  // Parse MorphShape for shape tweens
  private parseMorphShape(frame: globalThis.Element): MorphShape | undefined {
    const morphShapeEl = frame.querySelector(':scope > MorphShape');
    if (!morphShapeEl) return undefined;

    const segments: MorphSegment[] = [];
    const morphSegments = morphShapeEl.querySelector('morphSegments');
    if (!morphSegments) return undefined;

    for (const segEl of morphSegments.querySelectorAll(':scope > MorphSegment')) {
      const segment: MorphSegment = {
        startPointA: this.parseMorphPoint(segEl.getAttribute('startPointA')),
        startPointB: this.parseMorphPoint(segEl.getAttribute('startPointB')),
        fillIndex1: segEl.getAttribute('fillIndex1') ? parseInt(segEl.getAttribute('fillIndex1')!) : undefined,
        fillIndex2: segEl.getAttribute('fillIndex2') ? parseInt(segEl.getAttribute('fillIndex2')!) : undefined,
        strokeIndex1: segEl.getAttribute('strokeIndex1') ? parseInt(segEl.getAttribute('strokeIndex1')!) : undefined,
        strokeIndex2: segEl.getAttribute('strokeIndex2') ? parseInt(segEl.getAttribute('strokeIndex2')!) : undefined,
        curves: []
      };

      for (const curveEl of segEl.querySelectorAll(':scope > MorphCurves')) {
        segment.curves.push({
          controlPointA: this.parseMorphPoint(curveEl.getAttribute('controlPointA')),
          anchorPointA: this.parseMorphPoint(curveEl.getAttribute('anchorPointA')),
          controlPointB: this.parseMorphPoint(curveEl.getAttribute('controlPointB')),
          anchorPointB: this.parseMorphPoint(curveEl.getAttribute('anchorPointB')),
          isLine: curveEl.getAttribute('isLine') === 'true'
        });
      }

      segments.push(segment);
    }

    return segments.length > 0 ? { segments } : undefined;
  }

  // Parse morph point from string like "x, y" or "#hex, #hex"
  private parseMorphPoint(value: string | null): Point {
    if (!value) return { x: 0, y: 0 };

    // Split on comma (may have spaces)
    const parts = value.split(',').map(s => s.trim());
    if (parts.length !== 2) return { x: 0, y: 0 };

    return {
      x: this.decodeMorphCoord(parts[0]),
      y: this.decodeMorphCoord(parts[1])
    };
  }

  // Decode morph coordinate (same hex format as edges)
  private decodeMorphCoord(value: string): number {
    const COORD_SCALE = 20; // Twips to pixels

    if (value.startsWith('#')) {
      // Hex encoded format: #XXXX.YY or #XX.YY
      const hex = value.substring(1);
      const dotIndex = hex.indexOf('.');

      let intHex: string;
      let fracHex: string | null = null;

      if (dotIndex !== -1) {
        intHex = hex.substring(0, dotIndex);
        fracHex = hex.substring(dotIndex + 1);
      } else {
        intHex = hex;
      }

      if (intHex.length === 0) intHex = '0';

      let intPart = parseInt(intHex, 16);
      if (Number.isNaN(intPart)) return 0;

      // Apply two's complement for 6+ char hex values
      if (intHex.length >= 6) {
        const bitWidth = intHex.length * 4;
        const signBit = 1 << (bitWidth - 1);
        if (intPart >= signBit) {
          intPart = intPart - (1 << bitWidth);
        }
      }

      let fracPart = 0;
      if (fracHex && fracHex.length > 0) {
        const fracValue = parseInt(fracHex, 16);
        if (!Number.isNaN(fracValue)) {
          const fracBits = fracHex.length * 4;
          fracPart = fracValue / (1 << fracBits);
        }
      }

      const result = intPart >= 0 ? intPart + fracPart : intPart - fracPart;
      return result / COORD_SCALE;
    } else {
      // Decimal value in twips
      const parsed = parseFloat(value);
      return Number.isFinite(parsed) ? parsed / COORD_SCALE : 0;
    }
  }
}
