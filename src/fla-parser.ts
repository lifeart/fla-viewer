import JSZip from 'jszip';
import pako from 'pako';
import { decodeADPCMToAudioBuffer } from './adpcm-decoder';
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
  ColorTransform,
  BlendMode,
  Rectangle
} from './types';
import { decodeEdgesWithStyleChanges } from './edge-decoder';
import {
  normalizePath,
  setWithNormalizedPath,
  hasWithNormalizedPath,
  getFilename
} from './path-utils';
import {
  parseFLV,
  getVideoCodecName,
  getAudioCodecName,
  getKeyframes
} from './flv-parser';

// Debug flag - enabled via ?debug=true URL parameter or setParserDebug(true)
let DEBUG = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug') === 'true';

// Export setter for testing
export function setParserDebug(value: boolean): void {
  DEBUG = value;
}

export type ProgressCallback = (message: string) => void;
export type SkipCheckCallback = () => boolean;

export class FLAParser {
  private zip: JSZip | null = null;
  private symbolCache: Map<string, Symbol> = new Map();
  private parser = new DOMParser();
  private lastYieldTime = 0;

  // Yield to browser if more than 50ms has passed since last yield
  private async yieldIfNeeded(): Promise<void> {
    const now = performance.now();
    if (now - this.lastYieldTime > 50) {
      await new Promise(resolve => setTimeout(resolve, 0));
      this.lastYieldTime = performance.now();
    }
  }

  async parse(file: File, onProgress?: ProgressCallback, isSkipImagesFix?: SkipCheckCallback): Promise<FLADocument> {
    const progress = onProgress || (() => {});
    const shouldSkipImagesFix = isSkipImagesFix || (() => false);

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
    const bitmaps = await this.parseBitmaps(root, progress, shouldSkipImagesFix);

    // Parse sound items from media section and load audio
    progress('Loading audio...');
    const sounds = await this.parseSounds(root);

    // Parse video items from media section and load FLV data
    progress('Loading videos...');
    const videos = await this.parseVideos(root);

    // Parse main timeline (pass dimensions for camera detection)
    progress('Building timeline...');
    const timelines = await this.parseTimelines(root, width, height);

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

      // Yield to browser periodically to keep UI responsive
      await this.yieldIfNeeded();

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

        // Parse 9-slice scaling grid if present
        const scalingGrid = symbolRoot.getAttribute('scalingGrid') === 'true';
        let scale9Grid: Rectangle | undefined;
        if (scalingGrid) {
          const scalingGridRect = symbolRoot.getAttribute('scalingGridRect');
          if (scalingGridRect) {
            // Format: "left top right bottom" (in twips)
            const parts = scalingGridRect.split(' ').map(v => parseFloat(v) / 20);
            if (parts.length === 4) {
              const [left, top, right, bottom] = parts;
              scale9Grid = {
                left,
                top,
                width: right - left,
                height: bottom - top
              };
            }
          }
        }

        // Parse symbol's timeline
        const timelines = await this.parseTimelines(symbolRoot);
        const timeline = timelines[0] || {
          name: name,
          layers: [],
          totalFrames: 1
        };

        // For button symbols, detect the hit area frame (frame 4 or frame with "hit" label)
        let hitAreaFrame: number | undefined;
        if (symbolType === 'button') {
          hitAreaFrame = this.findButtonHitAreaFrame(timeline);
        }

        const symbol: Symbol = {
          name,
          itemID,
          symbolType,
          timeline,
          ...(scale9Grid && { scale9Grid }),
          ...(hitAreaFrame !== undefined && { hitAreaFrame })
        };

        // Store with both normalized and original names
        setWithNormalizedPath(this.symbolCache, rawName, symbol);
      }
    } catch (e) {
      console.warn(`Failed to parse symbol: ${filename}`, e);
    }
  }

  /**
   * Find the hit area frame in a button symbol's timeline.
   * In Flash buttons, the hit area is typically:
   * - Frame 4 (standard button timeline: Up, Over, Down, Hit)
   * - Or a frame with label "hit" or "_hit"
   * Returns the 0-based frame index or undefined if not found.
   */
  private findButtonHitAreaFrame(timeline: Timeline): number | undefined {
    // First, look for a frame with "hit" label in any layer
    for (const layer of timeline.layers) {
      for (const frame of layer.frames) {
        const labelLower = frame.label?.toLowerCase();
        if (labelLower === 'hit' || labelLower === '_hit') {
          return frame.index;
        }
      }
    }

    // If no labeled hit frame, check if timeline has at least 4 frames
    // Frame 4 (index 3) is traditionally the hit area
    if (timeline.totalFrames >= 4) {
      // Verify frame 4 has content (not just empty)
      for (const layer of timeline.layers) {
        for (const frame of layer.frames) {
          // Check if this frame covers index 3 (frame 4)
          if (frame.index <= 3 && frame.index + frame.duration > 3) {
            if (frame.elements.length > 0) {
              return 3; // 0-based index for frame 4
            }
          }
        }
      }
    }

    return undefined;
  }

  private async parseTimelines(parent: globalThis.Element, docWidth?: number, docHeight?: number): Promise<Timeline[]> {
    const timelines: Timeline[] = [];
    const timelineElements = parent.querySelectorAll(':scope > timelines > DOMTimeline, :scope > timeline > DOMTimeline');

    for (const tl of timelineElements) {
      const name = tl.getAttribute('name') || 'Timeline';
      const layers = await this.parseLayers(tl);

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

  private async parseLayers(timeline: globalThis.Element): Promise<Layer[]> {
    const layers: Layer[] = [];
    const layerElements = timeline.querySelectorAll(':scope > layers > DOMLayer');

    for (const layerEl of layerElements) {
      // Yield to browser periodically to keep UI responsive
      await this.yieldIfNeeded();

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

      const frames = await this.parseFrames(layerEl);

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

  private async parseFrames(layer: globalThis.Element): Promise<Frame[]> {
    const frames: Frame[] = [];
    const frameElements = layer.querySelectorAll(':scope > frames > DOMFrame');

    for (const frameEl of frameElements) {
      // Yield to browser periodically to keep UI responsive
      await this.yieldIfNeeded();

      const index = parseInt(frameEl.getAttribute('index') || '0');
      // Duration must be at least 1 to avoid division by zero in tween calculations
      const duration = Math.max(1, parseInt(frameEl.getAttribute('duration') || '1') || 1);
      const keyMode = parseInt(frameEl.getAttribute('keyMode') || '0');
      const tweenType = frameEl.getAttribute('tweenType') as 'motion' | 'shape' | undefined;
      const acceleration = frameEl.getAttribute('acceleration');

      // Motion tween properties
      const motionTweenRotate = frameEl.getAttribute('motionTweenRotate') as 'cw' | 'ccw' | 'none' | null;
      const motionTweenRotateTimes = frameEl.getAttribute('motionTweenRotateTimes');
      const motionTweenScale = frameEl.getAttribute('motionTweenScale');
      const motionTweenOrientToPath = frameEl.getAttribute('motionTweenOrientToPath');

      const elements = this.parseElements(frameEl);
      const tweens = this.parseTweens(frameEl);

      // Parse sound reference
      const sound = this.parseFrameSound(frameEl);

      // Parse morph shape for shape tweens
      const morphShape = tweenType === 'shape' ? this.parseMorphShape(frameEl) : undefined;

      // Parse frame label (name attribute is the label text, labelType is the label kind)
      const label = frameEl.getAttribute('name') || undefined;
      const labelType = frameEl.getAttribute('labelType') as 'name' | 'comment' | 'anchor' | null;

      frames.push({
        index,
        duration,
        keyMode,
        tweenType: tweenType || 'none',
        acceleration: acceleration ? parseInt(acceleration) : undefined,
        elements,
        tweens,
        sound,
        ...(morphShape && { morphShape }),
        ...(label && { label }),
        ...(labelType && { labelType }),
        ...(motionTweenRotate && { motionTweenRotate }),
        ...(motionTweenRotateTimes && { motionTweenRotateTimes: parseInt(motionTweenRotateTimes) }),
        ...(motionTweenScale === 'true' && { motionTweenScale: true }),
        ...(motionTweenOrientToPath === 'true' && { motionTweenOrientToPath: true })
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
    const lastFrame = el.getAttribute('lastFrame');

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

    // Parse 3D rotation properties
    const rotationXAttr = el.getAttribute('rotationX');
    const rotationYAttr = el.getAttribute('rotationY');
    const rotationZAttr = el.getAttribute('rotationZ');
    const zAttr = el.getAttribute('z');

    const rotationX = rotationXAttr ? parseFloat(rotationXAttr) : undefined;
    const rotationY = rotationYAttr ? parseFloat(rotationYAttr) : undefined;
    const rotationZ = rotationZAttr ? parseFloat(rotationZAttr) : undefined;
    const z = zAttr ? parseFloat(zAttr) : undefined;

    // Parse cache as bitmap
    const cacheAsBitmapAttr = el.getAttribute('cacheAsBitmap');
    const cacheAsBitmap = cacheAsBitmapAttr === 'true' ? true : undefined;

    // Parse filters
    const filters = this.parseFilters(el);

    // Parse color transform
    const colorTransform = this.parseColorTransform(el);

    // Parse blend mode
    const blendModeAttr = el.getAttribute('blendMode');
    const blendMode = this.parseBlendMode(blendModeAttr);

    // Parse visibility (default is true if not specified)
    const isVisibleAttr = el.getAttribute('isVisible');
    const isVisible = isVisibleAttr === 'false' ? false : undefined; // Only set if explicitly false

    return {
      type: 'symbol',
      libraryItemName,
      symbolType,
      matrix,
      transformationPoint,
      centerPoint3D,
      loop,
      firstFrame: firstFrame ? parseInt(firstFrame) : undefined,
      lastFrame: lastFrame ? parseInt(lastFrame) : undefined,
      ...(filters.length > 0 && { filters }),
      ...(colorTransform && { colorTransform }),
      ...(blendMode && { blendMode }),
      ...(isVisible === false && { isVisible }),
      ...(rotationX !== undefined && { rotationX }),
      ...(rotationY !== undefined && { rotationY }),
      ...(rotationZ !== undefined && { rotationZ }),
      ...(z !== undefined && { z }),
      ...(cacheAsBitmap && { cacheAsBitmap })
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
      const underline = attrsEl?.getAttribute('underline') === 'true';
      const letterSpacing = attrsEl?.getAttribute('letterSpacing')
        ? parseFloat(attrsEl.getAttribute('letterSpacing')!)
        : undefined;

      // Parse additional text attributes
      const indent = attrsEl?.getAttribute('indent')
        ? parseFloat(attrsEl.getAttribute('indent')!)
        : undefined;
      const leftMargin = attrsEl?.getAttribute('leftMargin')
        ? parseFloat(attrsEl.getAttribute('leftMargin')!)
        : undefined;
      const rightMargin = attrsEl?.getAttribute('rightMargin')
        ? parseFloat(attrsEl.getAttribute('rightMargin')!)
        : undefined;
      const url = attrsEl?.getAttribute('url') || undefined;
      const target = attrsEl?.getAttribute('target') || undefined;

      // Parse character position (subscript/superscript)
      const charPosition = attrsEl?.getAttribute('characterPosition');
      const characterPosition = charPosition === 'subscript' || charPosition === 'superscript'
        ? charPosition
        : undefined;

      // Parse auto kerning
      const autoKernAttr = attrsEl?.getAttribute('autoKern');
      const autoKern = autoKernAttr === 'true' ? true : undefined;

      // Parse per-character rotation
      const rotationAttr = attrsEl?.getAttribute('rotation');
      const rotation = rotationAttr ? parseFloat(rotationAttr) : undefined;

      const run: TextRun = {
        characters,
        alignment,
        size,
        lineHeight,
        face,
        fillColor,
        bold,
        italic,
        letterSpacing
      };

      // Only add optional properties if they have values
      if (underline) run.underline = true;
      if (indent !== undefined) run.indent = indent;
      if (leftMargin !== undefined) run.leftMargin = leftMargin;
      if (rightMargin !== undefined) run.rightMargin = rightMargin;
      if (url) run.url = url;
      if (target) run.target = target;
      if (characterPosition) run.characterPosition = characterPosition;
      if (autoKern) run.autoKern = autoKern;
      if (rotation !== undefined) run.rotation = rotation;

      textRuns.push(run);
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
        const fill: FillStyle = {
          index,
          type: 'linear',
          gradient: this.parseGradientEntries(linearGradient),
          matrix: this.parseMatrix(linearGradient.querySelector('matrix > Matrix'))
        };
        // Parse spread method (XFL: spreadMethod attribute)
        const spreadMethod = linearGradient.getAttribute('spreadMethod');
        if (spreadMethod === 'reflect' || spreadMethod === 'repeat') {
          fill.spreadMethod = spreadMethod;
        }
        // Parse interpolation method (XFL: interpolationMethod attribute)
        const interpolation = linearGradient.getAttribute('interpolationMethod');
        if (interpolation === 'linearRGB') {
          fill.interpolationMethod = 'linearRGB';
        }
        fills.push(fill);
        continue;
      }

      // Check for radial gradient
      const radialGradient = fillEl.querySelector('RadialGradient');
      if (radialGradient) {
        const fill: FillStyle = {
          index,
          type: 'radial',
          gradient: this.parseGradientEntries(radialGradient),
          matrix: this.parseMatrix(radialGradient.querySelector('matrix > Matrix'))
        };
        // Parse spread method
        const spreadMethod = radialGradient.getAttribute('spreadMethod');
        if (spreadMethod === 'reflect' || spreadMethod === 'repeat') {
          fill.spreadMethod = spreadMethod;
        }
        // Parse interpolation method
        const interpolation = radialGradient.getAttribute('interpolationMethod');
        if (interpolation === 'linearRGB') {
          fill.interpolationMethod = 'linearRGB';
        }
        // Parse focal point ratio (XFL: focalPointRatio attribute, -1 to 1)
        const focalPoint = radialGradient.getAttribute('focalPointRatio');
        if (focalPoint !== null) {
          fill.focalPointRatio = parseFloat(focalPoint);
        }
        fills.push(fill);
        continue;
      }

      // Check for bitmap fill
      // BitmapFill can be: repeating, clipped, non-smoothed repeating, non-smoothed clipped
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
        // Check for clipped mode (XFL: bitmapIsClipped="true")
        if (bitmapFill.getAttribute('bitmapIsClipped') === 'true') {
          fill.bitmapIsClipped = true;
        }
        // Check for smoothed mode (default is true, XFL: allowSmoothing="false" means no smoothing)
        const allowSmoothing = bitmapFill.getAttribute('allowSmoothing');
        if (allowSmoothing === 'false') {
          fill.bitmapIsSmoothed = false;
        }
        fills.push(fill);
        continue;
      }

      // Check for ClippedBitmapFill (alternative XFL format)
      const clippedBitmapFill = fillEl.querySelector('ClippedBitmapFill');
      if (clippedBitmapFill) {
        const bitmapPath = clippedBitmapFill.getAttribute('bitmapPath') || '';
        const matrixEl = clippedBitmapFill.querySelector('matrix > Matrix');
        const fill: FillStyle = {
          index,
          type: 'bitmap',
          bitmapPath: normalizePath(bitmapPath),
          bitmapIsClipped: true,
        };
        if (matrixEl) {
          fill.matrix = this.parseMatrix(matrixEl);
        }
        const allowSmoothing = clippedBitmapFill.getAttribute('allowSmoothing');
        if (allowSmoothing === 'false') {
          fill.bitmapIsSmoothed = false;
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

      // Helper to parse common stroke properties
      const parseCommonStrokeProps = (strokeNode: globalThis.Element): Partial<StrokeStyle> => {
        const weight = parseFloat(strokeNode.getAttribute('weight') || '1');
        const caps = (strokeNode.getAttribute('caps') || 'round') as 'none' | 'round' | 'square';
        const joints = (strokeNode.getAttribute('joints') || 'round') as 'miter' | 'round' | 'bevel';
        const miterLimit = strokeNode.getAttribute('miterLimit');
        const scaleMode = strokeNode.getAttribute('scaleMode') as 'normal' | 'horizontal' | 'vertical' | 'none' | null;
        const pixelHinting = strokeNode.getAttribute('pixelHinting') === 'true';

        return {
          weight,
          caps,
          joints,
          ...(miterLimit !== null && { miterLimit: parseFloat(miterLimit) }),
          ...(scaleMode && scaleMode !== 'normal' && { scaleMode }),
          ...(pixelHinting && { pixelHinting })
        };
      };

      // Check for SolidStroke
      const solidStroke = strokeEl.querySelector('SolidStroke');
      if (solidStroke) {
        const commonProps = parseCommonStrokeProps(solidStroke);
        const fillEl = solidStroke.querySelector('fill');

        if (fillEl) {
          // Check for SolidColor fill
          const solidColor = fillEl.querySelector('SolidColor');
          if (solidColor) {
            const color = solidColor.getAttribute('color') || '#000000';
            strokes.push({
              index,
              type: 'solid',
              color,
              ...commonProps
            } as StrokeStyle);
            continue;
          }

          // Check for LinearGradient fill
          const linearGradient = fillEl.querySelector('LinearGradient');
          if (linearGradient) {
            const gradient = this.parseGradientEntries(linearGradient);
            const matrix = this.parseMatrix(linearGradient.querySelector('matrix > Matrix'));
            const spreadMethod = (linearGradient.getAttribute('spreadMethod') || 'pad') as 'pad' | 'reflect' | 'repeat';
            const interpolationMethod = (linearGradient.getAttribute('interpolationMethod') || 'rgb') as 'rgb' | 'linearRGB';

            strokes.push({
              index,
              type: 'linear',
              gradient,
              matrix,
              spreadMethod,
              interpolationMethod,
              ...commonProps
            } as StrokeStyle);
            continue;
          }

          // Check for RadialGradient fill
          const radialGradient = fillEl.querySelector('RadialGradient');
          if (radialGradient) {
            const gradient = this.parseGradientEntries(radialGradient);
            const matrix = this.parseMatrix(radialGradient.querySelector('matrix > Matrix'));
            const spreadMethod = (radialGradient.getAttribute('spreadMethod') || 'pad') as 'pad' | 'reflect' | 'repeat';
            const interpolationMethod = (radialGradient.getAttribute('interpolationMethod') || 'rgb') as 'rgb' | 'linearRGB';
            const focalPointRatio = parseFloat(radialGradient.getAttribute('focalPointRatio') || '0');

            strokes.push({
              index,
              type: 'radial',
              gradient,
              matrix,
              spreadMethod,
              interpolationMethod,
              focalPointRatio,
              ...commonProps
            } as StrokeStyle);
            continue;
          }

          // Check for BitmapFill
          const bitmapFill = fillEl.querySelector('BitmapFill');
          if (bitmapFill) {
            const bitmapPath = normalizePath(bitmapFill.getAttribute('bitmapPath') || '');
            const matrix = this.parseMatrix(bitmapFill.querySelector('matrix > Matrix'));
            const bitmapIsClipped = bitmapFill.getAttribute('bitmapIsClipped') === 'true';
            const bitmapIsSmoothed = bitmapFill.getAttribute('bitmapIsSmoothed') !== 'false';

            strokes.push({
              index,
              type: 'bitmap',
              bitmapPath,
              matrix,
              bitmapIsClipped,
              bitmapIsSmoothed,
              ...commonProps
            } as StrokeStyle);
            continue;
          }
        }

        // Fallback to black solid stroke
        strokes.push({
          index,
          type: 'solid',
          color: '#000000',
          ...commonProps
        } as StrokeStyle);
        continue;
      }

      // Check for DashedStroke (treat similar to SolidStroke)
      const dashedStroke = strokeEl.querySelector('DashedStroke');
      if (dashedStroke) {
        const commonProps = parseCommonStrokeProps(dashedStroke);
        const solidColor = dashedStroke.querySelector('fill > SolidColor');
        const color = solidColor?.getAttribute('color') || '#000000';

        strokes.push({
          index,
          type: 'solid',
          color,
          ...commonProps
        } as StrokeStyle);
        continue;
      }
    }

    return strokes;
  }

  private async parseBitmaps(root: globalThis.Element, progress: ProgressCallback, shouldSkipImagesFix: SkipCheckCallback): Promise<Map<string, BitmapItem>> {
    const bitmaps = new Map<string, BitmapItem>();
    const bitmapElements = root.querySelectorAll('media > DOMBitmapItem');

    const bitmapItems: BitmapItem[] = [];

    for (const bitmapEl of bitmapElements) {
      const rawName = bitmapEl.getAttribute('name') || '';
      const name = normalizePath(rawName);
      const href = bitmapEl.getAttribute('href') || rawName;
      const bitmapDataHRef = bitmapEl.getAttribute('bitmapDataHRef') || undefined;
      const frameRight = bitmapEl.getAttribute('frameRight');
      const frameBottom = bitmapEl.getAttribute('frameBottom');
      const sourceExternalFilepath = bitmapEl.getAttribute('sourceExternalFilepath') || undefined;

      // Dimensions are in twips (1/20 of a pixel)
      const width = frameRight ? parseInt(frameRight) / 20 : 0;
      const height = frameBottom ? parseInt(frameBottom) / 20 : 0;

      const bitmapItem: BitmapItem = {
        name,
        href,
        bitmapDataHRef,
        width,
        height,
        sourceExternalFilepath
      };

      // Store with both normalized and original names
      setWithNormalizedPath(bitmaps, rawName, bitmapItem);

      bitmapItems.push(bitmapItem);
    }

    // Load images sequentially with progress updates
    const totalImages = bitmapItems.length;
    for (let i = 0; i < totalImages; i++) {
      if (shouldSkipImagesFix()) {
        progress('Skipping remaining images...');
        break;
      }
      const imageProgress = (algo: string) => {
        progress(`Fixing images ${i + 1}/${totalImages} [${algo}]`);
      };
      imageProgress('loading');
      await this.loadBitmapImage(bitmapItems[i], imageProgress);
    }

    return bitmaps;
  }

  private async loadBitmapImage(bitmapItem: BitmapItem, onAlgoProgress?: (algo: string) => void): Promise<void> {
    let imageData: ArrayBuffer | null = null;
    let sourceRef = bitmapItem.href;

    // First try bitmapDataHRef from bin/ folder (preferred for .dat files)
    if (bitmapItem.bitmapDataHRef) {
      imageData = await this.findFileData(bitmapItem.bitmapDataHRef, 'bin');
      if (imageData) {
        sourceRef = bitmapItem.bitmapDataHRef;
      }
    }

    // Fall back to href from LIBRARY/ folder
    if (!imageData) {
      imageData = await this.findFileData(bitmapItem.href);
    }

    if (!imageData) {
      if (DEBUG) {
        console.warn(`Bitmap image not found: ${bitmapItem.href} (bitmapDataHRef: ${bitmapItem.bitmapDataHRef})`);
      }
      return;
    }

    // Determine MIME type from magic bytes or extension
    const mimeType = this.detectImageMimeType(imageData, sourceRef);

    // Handle Adobe FLA bitmap format (proprietary .dat files)
    if (mimeType === 'application/x-fla-bitmap') {
      const img = await this.decodeFlaBitmap(imageData, bitmapItem.width, bitmapItem.height, onAlgoProgress);
      if (img) {
        bitmapItem.imageData = img;
      } else if (DEBUG) {
        console.warn(`Failed to decode FLA bitmap: ${bitmapItem.href}`);
      }
      return;
    }

    // Create blob and load as standard image
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

  private detectImageMimeType(data: ArrayBuffer, filename: string): string {
    // Check magic bytes first
    const bytes = new Uint8Array(data.slice(0, 8));

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
      return 'image/png';
    }

    // JPEG: FF D8 FF
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
      return 'image/jpeg';
    }

    // GIF: 47 49 46 38 (GIF8)
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
      return 'image/gif';
    }

    // Adobe FLA bitmap format: 03 05 (32-bit) or 03 03 (8-bit palette)
    if (bytes[0] === 0x03 && (bytes[1] === 0x05 || bytes[1] === 0x03)) {
      return 'application/x-fla-bitmap';
    }

    // Fall back to extension-based detection
    const ext = getFilename(filename).toLowerCase().split('.').pop();
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'gif') return 'image/gif';

    // Default to PNG for unknown types (including .dat files)
    return 'image/png';
  }

  /**
   * Decode Adobe FLA bitmap format (.dat files in bin/ folder).
   *
   * Reference: JPEXS Free Flash Decompiler
   * https://github.com/jindrapetrik/jpexs-decompiler
   * - ImageBinDataGenerator.java (writer)
   * - LosslessImageBinDataReader.java (reader)
   *
   * Format structure:
   * - Bytes 0-1: Format marker (0x03 0x05 for 32-bit, 0x03 0x03 for 8-bit)
   * - Bytes 2-3: Row stride (width * 4, little endian)
   * - Bytes 4-5: Width in pixels (little endian)
   * - Bytes 6-7: Height in pixels (little endian)
   * - Bytes 8-11: frameLeft in twips (always 0)
   * - Bytes 12-15: frameRight in twips (little endian)
   * - Bytes 16-19: frameTop in twips (always 0)
   * - Bytes 20-23: frameBottom in twips (little endian)
   * - Byte 24: hasAlpha (0 or 1)
   * - Byte 25: variant (1 = chunked compression)
   * - Bytes 26+: Chunked compressed data:
   *   [UI16 chunk_length][chunk_data]... [UI16 0x0000 terminator]
   *   First chunk starts with zlib header (0x78 0x01)
   *
   * Decompression strategy (in order of attempts):
   * 1. Raw deflate - works for most well-formed files
   * 2. Dictionary decompression - uses zero-filled 32KB dictionary for files
   *    that reference a preset dictionary (gives complete results)
   * 3. Streaming recovery - uses onData callback to capture partial data from
   *    corrupted/truncated deflate streams (recovers 60-90% typically)
   * 4. Streaming with dictionary - for files that need dictionary from byte 0
   *    and also have mid-stream errors
   * 5. Multi-segment recovery - for severely corrupted files (<50% recovery):
   *    - Extracts stored blocks (uncompressed data) directly from the stream
   *    - Scans for valid deflate segments after corruption points
   *    - Combines all recovered segments to maximize data recovery
   *
   * Pixel format: ABGR (alpha, blue, green, red), converted to RGBA for Canvas
   * Colors are stored premultiplied by alpha and must be unmultiplied when reading.
   */
  private async decodeFlaBitmap(data: ArrayBuffer, expectedWidth: number, expectedHeight: number, onAlgoProgress?: (algo: string) => void): Promise<HTMLImageElement | null> {
    const algoProgress = onAlgoProgress || (() => {});
    const bytes = new Uint8Array(data);

    // Validate magic bytes: must be 03 05 (32-bit) or 03 03 (8-bit)
    if (bytes[0] !== 0x03 || (bytes[1] !== 0x05 && bytes[1] !== 0x03)) {
      if (DEBUG) {
        console.warn(`Invalid FLA bitmap magic: ${bytes[0].toString(16)} ${bytes[1].toString(16)}`);
      }
      return null;
    }

    // Check format type: 03 05 = 32-bit, 03 03 = 8-bit palette
    const is8Bit = bytes[1] === 0x03;

    // Parse header per JPEXS specification
    const headerWidth = bytes[4] | (bytes[5] << 8);
    const headerHeight = bytes[6] | (bytes[7] << 8);
    const hasAlpha = bytes[24] === 1;
    const variant = bytes[25];

    if (DEBUG) {
      console.log(`FLA bitmap: ${headerWidth}x${headerHeight}, hasAlpha=${hasAlpha}, variant=${variant}, is8Bit=${is8Bit}, expected=${expectedWidth}x${expectedHeight}`);
    }

    // Handle 8-bit palette mode
    if (is8Bit) {
      return this.decode8BitFlaBitmap(bytes, headerWidth, headerHeight, hasAlpha);
    }

    // Decompress the data using pako
    const zeroDict = new Uint8Array(32768);

    try {
      let pixelData: Uint8Array;

      // Extract compressed data based on format
      // Per JPEXS: variant=1 means chunked compression
      // Chunks start at offset 26 with [UI16 length][data]... [UI16 0x0000]
      let compData: Uint8Array;

      if (variant === 1) {
        // Chunked format: read and concatenate all chunks
        const chunks: Uint8Array[] = [];
        let pos = 26;

        while (pos + 2 <= bytes.length) {
          const chunkLen = bytes[pos] | (bytes[pos + 1] << 8);
          pos += 2;

          if (chunkLen === 0) break; // Terminator
          if (pos + chunkLen > bytes.length) break; // Truncated

          chunks.push(bytes.slice(pos, pos + chunkLen));
          pos += chunkLen;
        }

        // Concatenate all chunks
        const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
        compData = new Uint8Array(totalLen);
        let offset = 0;
        for (const chunk of chunks) {
          compData.set(chunk, offset);
          offset += chunk.length;
        }

        // Skip zlib header (78 xx) if present - we use raw deflate
        if (compData.length >= 2 && compData[0] === 0x78) {
          compData = compData.slice(2);
        }

        if (DEBUG) {
          console.log(`Chunked format: ${chunks.length} chunks, ${totalLen} bytes total`);
        }
      } else {
        // Non-chunked: raw data starts at offset 26
        // Skip zlib header if present
        let offset = 26;
        if (bytes[offset] === 0x78) {
          offset += 2;
        }
        compData = bytes.slice(offset);
      }

      // Validate we have enough compressed data to work with
      // Empty or very small data (< 4 bytes) cannot be valid deflate stream
      if (compData.length < 4) {
        if (DEBUG) {
          console.warn(`Insufficient compressed data: ${compData.length} bytes`);
        }
        return null;
      }

      // Check if data looks like valid deflate (not all zeros)
      // First byte of deflate has block type bits that are rarely all zero
      let hasNonZero = false;
      for (let i = 0; i < Math.min(compData.length, 16); i++) {
        if (compData[i] !== 0) {
          hasNonZero = true;
          break;
        }
      }
      if (!hasNonZero) {
        if (DEBUG) {
          console.warn('Compressed data appears to be all zeros (invalid)');
        }
        return null;
      }

      const expectedSize = headerWidth * headerHeight * 4;

      // Helper function for streaming partial recovery
      // Uses onData callback to capture chunks as they're produced,
      // allowing recovery of partial data when decompression errors occur mid-stream
      const tryStreamingRecovery = (useDict: boolean = false): Uint8Array | null => {
        try {
          const chunks: Uint8Array[] = [];
          const options: pako.InflateOptions = { raw: true, chunkSize: 16384 };
          if (useDict) {
            options.dictionary = zeroDict;
          }
          const inflater = new pako.Inflate(options);

          // Capture chunks via onData callback - this is key for partial recovery
          inflater.onData = (chunk: Uint8Array) => {
            chunks.push(new Uint8Array(chunk));
          };

          const chunkSize = 4096;

          for (let i = 0; i < compData.length; i += chunkSize) {
            const isLast = i + chunkSize >= compData.length;
            const chunk = compData.slice(i, Math.min(i + chunkSize, compData.length));

            try {
              inflater.push(chunk, isLast);
            } catch {
              break;
            }

            if (inflater.err) {
              break;
            }
          }

          // Combine collected chunks
          if (chunks.length === 0) return null;

          let totalSize = 0;
          for (const chunk of chunks) totalSize += chunk.length;

          const result = new Uint8Array(totalSize);
          let offset = 0;
          for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
          }
          return result;
        } catch {
          // Streaming failed entirely
        }
        return null;
      };

      // Multi-segment recovery for severely corrupted files
      // Combines: baseline streaming + stored blocks + valid deflate segments found after corruption
      const tryMultiSegmentRecovery = (): Uint8Array | null => {
        const segments: Uint8Array[] = [];

        // 1. Get baseline streaming data
        const baseline = tryStreamingRecovery(false) || tryStreamingRecovery(true);
        if (baseline && baseline.length > 0) {
          segments.push(baseline);
        }

        // 2. Find stored blocks (uncompressed data embedded in deflate stream)
        // Stored block format: [byte with BTYPE=00] [LEN:2] [NLEN:2] [DATA:LEN]
        for (let i = 0; i < compData.length - 5; i++) {
          const byte = compData[i];
          const BTYPE = (byte >> 1) & 0x03;
          if (BTYPE === 0) { // Stored block
            const len = compData[i + 1] | (compData[i + 2] << 8);
            const nlen = compData[i + 3] | (compData[i + 4] << 8);
            // Validate: NLEN should be one's complement of LEN
            if ((len ^ nlen) === 0xFFFF && len > 1000 && i + 5 + len <= compData.length) {
              const blockData = compData.slice(i + 5, i + 5 + len);
              segments.push(new Uint8Array(blockData));
            }
          }
        }

        // 3. Scan for valid deflate segments after baseline
        // Coarse scan with step 500, directly trying decompression at each point
        // This is slower but ensures we don't miss valid segments
        const baselineLen = baseline?.length || 0;
        if (baselineLen < expectedSize * 0.5) {
          const foundOffsets = new Set<number>();

          for (let scanOffset = 1000; scanOffset < compData.length - 100; scanOffset += 500) {
            // Try at exact offset and nearby (within +/- 50, step 1)
            for (let delta = -50; delta <= 50; delta++) {
              const tryOffset = scanOffset + delta;
              if (tryOffset < 1000 || tryOffset >= compData.length - 100) continue;
              if (foundOffsets.has(Math.floor(tryOffset / 1000))) continue; // Skip if already found in this 1K region

              const byte = compData[tryOffset];
              const BTYPE = (byte >> 1) & 0x03;
              if (BTYPE === 3) continue;

              try {
                const result = pako.inflateRaw(compData.slice(tryOffset), { dictionary: zeroDict } as pako.InflateOptions);
                if (result.length > 50000) {
                  const isDupe = segments.some(s => Math.abs(s.length - result.length) < 10000);
                  if (!isDupe) {
                    segments.push(result);
                    foundOffsets.add(Math.floor(tryOffset / 1000));
                    scanOffset += 10000; // Skip ahead
                    break;
                  }
                }
              } catch {
                try {
                  const result = pako.inflateRaw(compData.slice(tryOffset));
                  if (result.length > 50000) {
                    const isDupe = segments.some(s => Math.abs(s.length - result.length) < 10000);
                    if (!isDupe) {
                      segments.push(result);
                      foundOffsets.add(Math.floor(tryOffset / 1000));
                      scanOffset += 10000;
                      break;
                    }
                  }
                } catch { /* ignore */ }
              }
            }
          }
        }

        // Combine all segments sequentially
        if (segments.length === 0) return null;

        let totalLen = 0;
        for (const seg of segments) totalLen += seg.length;

        // Cap at expected size
        const cappedLen = Math.min(totalLen, expectedSize);
        const result = new Uint8Array(cappedLen);
        let writeOffset = 0;

        for (const seg of segments) {
          const remaining = cappedLen - writeOffset;
          if (remaining <= 0) break;
          const copyLen = Math.min(seg.length, remaining);
          result.set(seg.subarray(0, copyLen), writeOffset);
          writeOffset += copyLen;
        }

        return result;
      };

      // Try raw deflate first (most common)
      algoProgress('deflate');
      try {
        pixelData = pako.inflateRaw(compData);
      } catch (rawError) {
        // Raw deflate failed - try dictionary first (gives complete results for some files)
        algoProgress('dictionary');
        if (DEBUG) console.log(`Raw deflate failed for ${headerWidth}x${headerHeight}, trying dictionary...`);
        try {
          pixelData = pako.inflateRaw(compData, { dictionary: zeroDict } as pako.InflateOptions);
          if (DEBUG) console.log(`Dictionary decompress: ${pixelData.length} bytes for ${headerWidth}x${headerHeight}`);
        } catch (dictError) {
          // Dictionary failed - try streaming recovery (gets partial data)
          algoProgress('streaming');
          if (DEBUG) console.log(`Dictionary failed, trying streaming for ${headerWidth}x${headerHeight}...`);
          const streamResult = tryStreamingRecovery(false);

          if (streamResult && streamResult.length > 0) {
            pixelData = streamResult;
            const pct = (100 * pixelData.length / expectedSize).toFixed(1);
            if (DEBUG) console.log(`Streaming recovery: ${pixelData.length}/${expectedSize} bytes (${pct}%) for ${headerWidth}x${headerHeight}`);

            // If streaming recovered less than 50%, try multi-segment recovery
            if (pixelData.length < expectedSize * 0.5) {
              algoProgress('multi-segment');
              if (DEBUG) console.log(`Low recovery, trying multi-segment for ${headerWidth}x${headerHeight}...`);
              const multiResult = tryMultiSegmentRecovery();
              if (multiResult && multiResult.length > pixelData.length) {
                pixelData = multiResult;
                const newPct = (100 * pixelData.length / expectedSize).toFixed(1);
                if (DEBUG) console.log(`Multi-segment recovery: ${pixelData.length}/${expectedSize} bytes (${newPct}%) for ${headerWidth}x${headerHeight}`);
              }
            }
          } else {
            // Streaming without dict failed - try with dictionary
            algoProgress('stream+dict');
            if (DEBUG) console.log(`Streaming failed, trying streaming with dictionary for ${headerWidth}x${headerHeight}...`);
            const streamDictResult = tryStreamingRecovery(true);
            if (streamDictResult && streamDictResult.length > 0) {
              pixelData = streamDictResult;
              const pct = (100 * pixelData.length / expectedSize).toFixed(1);
              if (DEBUG) console.log(`Streaming+dict recovery: ${pixelData.length}/${expectedSize} bytes (${pct}%) for ${headerWidth}x${headerHeight}`);

              // If streaming+dict recovered less than 50%, try multi-segment recovery
              if (pixelData.length < expectedSize * 0.5) {
                algoProgress('multi-segment');
                if (DEBUG) console.log(`Low recovery, trying multi-segment for ${headerWidth}x${headerHeight}...`);
                const multiResult = tryMultiSegmentRecovery();
                if (multiResult && multiResult.length > pixelData.length) {
                  pixelData = multiResult;
                  const newPct = (100 * pixelData.length / expectedSize).toFixed(1);
                  if (DEBUG) console.log(`Multi-segment recovery: ${pixelData.length}/${expectedSize} bytes (${newPct}%) for ${headerWidth}x${headerHeight}`);
                }
              }
            } else {
              // All streaming failed - try multi-segment as last resort
              algoProgress('multi-segment');
              if (DEBUG) console.log(`All streaming failed, trying multi-segment for ${headerWidth}x${headerHeight}...`);
              const multiResult = tryMultiSegmentRecovery();
              if (multiResult && multiResult.length > 0) {
                pixelData = multiResult;
                const pct = (100 * pixelData.length / expectedSize).toFixed(1);
                if (DEBUG) console.log(`Multi-segment recovery: ${pixelData.length}/${expectedSize} bytes (${pct}%) for ${headerWidth}x${headerHeight}`);
              } else {
                console.warn(`All decompression methods failed for ${headerWidth}x${headerHeight}`);
                return null;
              }
            }
          }
        }
      }

      // Use header dimensions
      let width = headerWidth;
      let height = headerHeight;

      // Extract pixel data - extra bytes are trailing padding, just truncate
      let actualPixelData: Uint8Array;

      if (pixelData.length >= expectedSize) {
        // Use first expectedSize bytes as pixel data (truncate trailing padding)
        actualPixelData = pixelData.slice(0, expectedSize);
      } else {
        // Data is smaller than expected - adjust height
        const actualPixels = Math.floor(pixelData.length / 4);
        height = Math.floor(actualPixels / width);
        if (height === 0) height = 1;
        actualPixelData = pixelData;
      }

      // Create canvas
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      const imageData = ctx.createImageData(width, height);
      const rgba = imageData.data;

      // Copy pixel data - ABGR format (Adobe FLA native format per JPEXS decompiler)
      // Reference: https://github.com/jindrapetrik/jpexs-decompiler
      // File: libsrc/ffdec_lib/src/com/jpexs/decompiler/flash/xfl/LosslessImageBinDataReader.java
      // ABGR → RGBA conversion for Canvas ImageData
      // Also handles alpha premultiplication (colors are stored premultiplied)
      const pixelCount = width * height;
      for (let i = 0; i < pixelCount; i++) {
        const srcIdx = i * 4;
        const dstIdx = i * 4;
        if (srcIdx + 3 < actualPixelData.length) {
          const a = actualPixelData[srcIdx];     // Alpha (byte 0)
          let b = actualPixelData[srcIdx + 1];   // Blue  (byte 1)
          let g = actualPixelData[srcIdx + 2];   // Green (byte 2)
          let r = actualPixelData[srcIdx + 3];   // Red   (byte 3)

          // Unmultiply alpha (colors are stored premultiplied)
          // Per JPEXS: if alpha is not 0 or 255, unmultiply using: color = floor(color * 256 / alpha)
          if (a > 0 && a < 255) {
            r = Math.min(255, Math.floor(r * 256 / a));
            g = Math.min(255, Math.floor(g * 256 / a));
            b = Math.min(255, Math.floor(b * 256 / a));
          }

          rgba[dstIdx] = r;         // R ← byte 3 (unmultiplied)
          rgba[dstIdx + 1] = g;     // G ← byte 2 (unmultiplied)
          rgba[dstIdx + 2] = b;     // B ← byte 1 (unmultiplied)
          rgba[dstIdx + 3] = a;     // A ← byte 0
        }
      }

      ctx.putImageData(imageData, 0, 0);

      // Convert canvas to image
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = canvas.toDataURL('image/png');
      });
    } catch (e) {
      if (DEBUG) {
        console.warn('Failed to decode FLA bitmap:', e);
      }
      return null;
    }
  }

  /**
   * Decode 8-bit palette-indexed FLA bitmap format (magic: 03 03).
   *
   * Format per JPEXS:
   * - Header: 26 bytes (same as 32-bit)
   * - Palette count: UI16 LE (number of palette entries)
   * - Palette data: count × 4 bytes (ABGR per entry if hasAlpha, else RGB)
   * - Pixel data: 1 byte per pixel (palette index)
   */
  private decode8BitFlaBitmap(
    bytes: Uint8Array,
    width: number,
    height: number,
    hasAlpha: boolean
  ): Promise<HTMLImageElement | null> {
    try {
      let pos = 26;

      // Read palette count
      const paletteCount = bytes[pos] | (bytes[pos + 1] << 8);
      pos += 2;

      if (DEBUG) {
        console.log(`8-bit bitmap: ${width}x${height}, palette=${paletteCount} entries, hasAlpha=${hasAlpha}`);
      }

      // Read palette (ABGR format, 4 bytes each)
      const palette: { r: number; g: number; b: number; a: number }[] = [];
      const bytesPerEntry = 4; // Always 4 bytes per JPEXS (ABGR)

      for (let i = 0; i < paletteCount && pos + bytesPerEntry <= bytes.length; i++) {
        const a = hasAlpha ? bytes[pos] : 255;
        const b = bytes[pos + 1];
        const g = bytes[pos + 2];
        const r = bytes[pos + 3];
        palette.push({ r, g, b, a });
        pos += bytesPerEntry;
      }

      // Remaining bytes are pixel indices
      const pixelData = bytes.slice(pos);
      const pixelCount = width * height;

      // Create canvas
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return Promise.resolve(null);

      const imageData = ctx.createImageData(width, height);
      const rgba = imageData.data;

      // Convert indexed pixels to RGBA
      for (let i = 0; i < pixelCount && i < pixelData.length; i++) {
        const index = pixelData[i];
        const color = palette[index] || { r: 0, g: 0, b: 0, a: 255 };
        const dstIdx = i * 4;
        rgba[dstIdx] = color.r;
        rgba[dstIdx + 1] = color.g;
        rgba[dstIdx + 2] = color.b;
        rgba[dstIdx + 3] = color.a;
      }

      ctx.putImageData(imageData, 0, 0);

      // Convert canvas to image
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = canvas.toDataURL('image/png');
      });
    } catch (e) {
      if (DEBUG) {
        console.warn('Failed to decode 8-bit FLA bitmap:', e);
      }
      return Promise.resolve(null);
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
      const soundDataHRef = soundEl.getAttribute('soundDataHRef') || undefined;
      const format = soundEl.getAttribute('format') || undefined;
      const sampleCount = soundEl.getAttribute('sampleCount')
        ? parseInt(soundEl.getAttribute('sampleCount')!)
        : undefined;

      // Parse format string to extract sample rate, bit depth, and channels
      // Format examples: "44kHz 16bit Stereo", "22kHz 8bit Mono", "mp3"
      const formatInfo = this.parseSoundFormat(format);

      const soundItem: SoundItem = {
        name,
        href,
        soundDataHRef,
        format,
        sampleCount,
        ...formatInfo
      };

      sounds.set(name, soundItem);

      // Load actual audio data from ZIP
      loadPromises.push(this.loadSoundAudio(soundItem));
    }

    // Wait for all sounds to load
    await Promise.all(loadPromises);

    return sounds;
  }

  // Parse sound format string to extract sample rate, bit depth, channels, and compression type
  private parseSoundFormat(format: string | undefined): { sampleRate?: number; bitDepth?: number; channels?: number; isADPCM?: boolean } {
    if (!format) return {};

    const result: { sampleRate?: number; bitDepth?: number; channels?: number; isADPCM?: boolean } = {};

    // Parse sample rate (e.g., "44kHz", "22kHz", "11kHz")
    const rateMatch = format.match(/(\d+)kHz/i);
    if (rateMatch) {
      result.sampleRate = parseInt(rateMatch[1]) * 1000;
    }

    // Parse bit depth (e.g., "16bit", "8bit")
    const bitMatch = format.match(/(\d+)bit/i);
    if (bitMatch) {
      result.bitDepth = parseInt(bitMatch[1]);
    }

    // Parse channels (Stereo = 2, Mono = 1)
    if (/stereo/i.test(format)) {
      result.channels = 2;
    } else if (/mono/i.test(format)) {
      result.channels = 1;
    }

    // Detect ADPCM compression
    if (/adpcm/i.test(format)) {
      result.isADPCM = true;
    }

    return result;
  }

  private async loadSoundAudio(soundItem: SoundItem): Promise<void> {
    // Initialize AudioContext lazily
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }

    // Check audio format type
    const isADPCM = soundItem.isADPCM === true;
    const isPCM = !isADPCM && soundItem.sampleRate && soundItem.bitDepth &&
                  (!soundItem.format || !soundItem.format.toLowerCase().includes('mp3'));

    // Try to load from soundDataHRef first (bin/ folder), then href
    let audioData: ArrayBuffer | null = null;
    let sourceRef = '';

    if (soundItem.soundDataHRef) {
      audioData = await this.findFileData(soundItem.soundDataHRef, 'bin');
      sourceRef = soundItem.soundDataHRef;
    }

    if (!audioData) {
      audioData = await this.findFileData(soundItem.href);
      sourceRef = soundItem.href;
    }

    if (!audioData) {
      if (DEBUG) {
        console.warn(`Sound file not found: ${soundItem.href} (soundDataHRef: ${soundItem.soundDataHRef})`);
      }
      return;
    }

    try {
      if (isADPCM) {
        // Decode ADPCM compressed audio
        const sampleRate = soundItem.sampleRate || 44100;
        const channels = soundItem.channels || 1;
        soundItem.audioData = decodeADPCMToAudioBuffer(
          this.audioContext,
          audioData,
          sampleRate,
          channels,
          soundItem.sampleCount
        );
        if (DEBUG) {
          console.log(`Loaded ADPCM sound: ${soundItem.name}, duration: ${soundItem.audioData.duration.toFixed(2)}s, ` +
                      `${sampleRate}Hz ${channels === 2 ? 'Stereo' : 'Mono'}`);
        }
      } else if (isPCM) {
        // Convert raw PCM data to AudioBuffer
        soundItem.audioData = this.convertPCMToAudioBuffer(
          audioData,
          soundItem.sampleRate!,
          soundItem.bitDepth!,
          soundItem.channels || 1
        );
        if (DEBUG) {
          console.log(`Loaded PCM sound: ${soundItem.name}, duration: ${soundItem.audioData.duration.toFixed(2)}s, ` +
                      `${soundItem.sampleRate}Hz ${soundItem.bitDepth}bit ${soundItem.channels === 2 ? 'Stereo' : 'Mono'}`);
        }
      } else {
        // Use browser's built-in decoder for MP3 and other compressed formats
        soundItem.audioData = await this.audioContext.decodeAudioData(audioData);
        if (DEBUG) {
          console.log(`Loaded sound: ${soundItem.name}, duration: ${soundItem.audioData.duration.toFixed(2)}s`);
        }
      }
    } catch (e) {
      if (DEBUG) {
        console.warn(`Failed to decode audio: ${sourceRef}`, e);
      }
    }
  }

  // Convert raw PCM data to AudioBuffer
  private convertPCMToAudioBuffer(
    data: ArrayBuffer,
    sampleRate: number,
    bitDepth: number,
    channels: number
  ): AudioBuffer {
    const bytesPerSample = bitDepth / 8;
    const bytesPerFrame = bytesPerSample * channels;
    const totalFrames = Math.floor(data.byteLength / bytesPerFrame);

    // Create AudioBuffer with the appropriate number of channels
    const audioBuffer = this.audioContext!.createBuffer(channels, totalFrames, sampleRate);
    const dataView = new DataView(data);

    // Extract samples for each channel
    for (let channel = 0; channel < channels; channel++) {
      const channelData = audioBuffer.getChannelData(channel);

      for (let frame = 0; frame < totalFrames; frame++) {
        const byteOffset = frame * bytesPerFrame + channel * bytesPerSample;
        let sample: number;

        if (bitDepth === 8) {
          // 8-bit PCM is unsigned (0-255), convert to -1.0 to 1.0
          const unsigned = dataView.getUint8(byteOffset);
          sample = (unsigned - 128) / 128;
        } else if (bitDepth === 16) {
          // 16-bit PCM is signed little-endian, convert to -1.0 to 1.0
          const signed = dataView.getInt16(byteOffset, true); // little-endian
          sample = signed / 32768;
        } else if (bitDepth === 24) {
          // 24-bit PCM is signed little-endian
          const b0 = dataView.getUint8(byteOffset);
          const b1 = dataView.getUint8(byteOffset + 1);
          const b2 = dataView.getUint8(byteOffset + 2);
          let signed = b0 | (b1 << 8) | (b2 << 16);
          // Sign extend
          if (signed & 0x800000) {
            signed |= 0xFF000000;
          }
          sample = signed / 8388608;
        } else if (bitDepth === 32) {
          // 32-bit PCM could be int or float, assume float
          sample = dataView.getFloat32(byteOffset, true);
        } else {
          // Unsupported bit depth, default to 0
          sample = 0;
        }

        channelData[frame] = sample;
      }
    }

    return audioBuffer;
  }

  private async parseVideos(root: globalThis.Element): Promise<Map<string, VideoItem>> {
    const videos = new Map<string, VideoItem>();
    const videoElements = root.querySelectorAll('media > DOMVideoItem');
    const loadPromises: Promise<void>[] = [];

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

      // Load and parse FLV data
      if (href) {
        loadPromises.push(this.loadVideoFLV(videoItem));
      }

      if (DEBUG) {
        console.log(`Found video: ${name}, ${videoItem.width}x${videoItem.height}, ${videoItem.fps}fps`);
      }
    }

    // Wait for all FLV files to be parsed
    await Promise.all(loadPromises);

    return videos;
  }

  private async loadVideoFLV(videoItem: VideoItem): Promise<void> {
    try {
      // Try to load from bin/ folder first (common for embedded video)
      let flvData = await this.findFileData(videoItem.href, 'bin');

      // Fallback to LIBRARY folder
      if (!flvData) {
        flvData = await this.findFileData(videoItem.href);
      }

      if (!flvData) {
        if (DEBUG) {
          console.warn(`Video file not found: ${videoItem.href}`);
        }
        return;
      }

      // Parse FLV data
      const parsed = parseFLV(flvData);

      // Store simplified FLV data in VideoItem
      const keyframes = getKeyframes(parsed.videoTags);

      videoItem.flvData = {
        hasVideo: parsed.header.hasVideo,
        hasAudio: parsed.header.hasAudio,
        videoCodec: parsed.videoCodec !== null ? getVideoCodecName(parsed.videoCodec) : null,
        audioCodec: parsed.audioCodec !== null ? getAudioCodecName(parsed.audioCodec) : null,
        duration: parsed.duration,
        frameCount: parsed.videoTags.length,
        keyframeCount: keyframes.length,
        audioSampleRate: parsed.audioTags.length > 0 ? parsed.audioTags[0].sampleRate : undefined,
        audioChannels: parsed.audioTags.length > 0 ? (parsed.audioTags[0].stereo ? 2 : 1) : undefined
      };

      // Update duration from FLV if not set in XML
      if (!videoItem.duration && parsed.duration > 0) {
        videoItem.duration = parsed.duration;
      }

      // Update dimensions from FLV metadata if not set
      if (parsed.metadata.width && parsed.metadata.height) {
        if (!videoItem.width) videoItem.width = parsed.metadata.width;
        if (!videoItem.height) videoItem.height = parsed.metadata.height;
      }

      // Update FPS from FLV metadata if not set
      if (parsed.metadata.framerate && !videoItem.fps) {
        videoItem.fps = parsed.metadata.framerate;
      }

      if (DEBUG) {
        console.log(`Parsed FLV: ${videoItem.name}, ` +
          `video: ${videoItem.flvData.videoCodec || 'none'}, ` +
          `audio: ${videoItem.flvData.audioCodec || 'none'}, ` +
          `frames: ${videoItem.flvData.frameCount}, ` +
          `keyframes: ${videoItem.flvData.keyframeCount}, ` +
          `duration: ${videoItem.flvData.duration.toFixed(2)}s`);
      }
    } catch (e) {
      if (DEBUG) {
        console.warn(`Failed to parse FLV: ${videoItem.href}`, e);
      }
    }
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

      // Use decodeEdgesWithStyleChanges but ignore style changes for now
      // (style changes within an edge are rare and the XML attributes are authoritative)
      const { commands } = decodeEdgesWithStyleChanges(pathData);

      edges.push({
        fillStyle0: fillStyle0 ? parseInt(fillStyle0) : undefined,
        fillStyle1: fillStyle1 ? parseInt(fillStyle1) : undefined,
        strokeStyle: strokeStyle ? parseInt(strokeStyle) : undefined,
        commands
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

        case 'BevelFilter':
          filters.push({
            type: 'bevel',
            blurX: parseFloat(child.getAttribute('blurX') || '4'),
            blurY: parseFloat(child.getAttribute('blurY') || '4'),
            strength: parseFloat(child.getAttribute('strength') || '100') / 255,
            highlightColor: child.getAttribute('highlightColor') || '#FFFFFF',
            highlightAlpha: parseFloat(child.getAttribute('highlightAlpha') || '1'),
            shadowColor: child.getAttribute('shadowColor') || '#000000',
            shadowAlpha: parseFloat(child.getAttribute('shadowAlpha') || '1'),
            distance: parseFloat(child.getAttribute('distance') || '4'),
            angle: parseFloat(child.getAttribute('angle') || '45'),
            inner: child.getAttribute('inner') === 'true',
            knockout: child.getAttribute('knockout') === 'true',
            quality: parseInt(child.getAttribute('quality') || '1'),
            bevelType: (child.getAttribute('type') as 'inner' | 'outer' | 'full') || 'inner'
          });
          break;

        case 'AdjustColorFilter':
        case 'ColorMatrixFilter':
          // ColorMatrixFilter in XFL stores a 4x5 matrix (20 values)
          // AdjustColorFilter is a simplified version that generates a color matrix
          const matrixAttr = child.getAttribute('matrix');
          let matrix: number[] = [];

          if (matrixAttr) {
            // Parse comma-separated matrix values
            matrix = matrixAttr.split(',').map(v => parseFloat(v.trim()));
          } else {
            // AdjustColorFilter uses individual attributes: brightness, contrast, saturation, hue
            const brightness = parseFloat(child.getAttribute('brightness') || '0');
            const contrast = parseFloat(child.getAttribute('contrast') || '0');
            const saturation = parseFloat(child.getAttribute('saturation') || '0');
            const hue = parseFloat(child.getAttribute('hue') || '0');

            // Build color matrix from adjustment values
            matrix = this.buildAdjustColorMatrix(brightness, contrast, saturation, hue);
          }

          // Ensure we have a valid 20-element matrix
          if (matrix.length === 20) {
            filters.push({
              type: 'colorMatrix',
              matrix
            });
          }
          break;

        case 'ConvolutionFilter':
          const matrixX = parseInt(child.getAttribute('matrixX') || '3');
          const matrixY = parseInt(child.getAttribute('matrixY') || '3');
          const convMatrixAttr = child.getAttribute('matrix');
          let convMatrix: number[] = [];

          if (convMatrixAttr) {
            convMatrix = convMatrixAttr.split(',').map(v => parseFloat(v.trim()));
          }

          filters.push({
            type: 'convolution',
            matrixX,
            matrixY,
            matrix: convMatrix,
            divisor: parseFloat(child.getAttribute('divisor') || '1'),
            bias: parseFloat(child.getAttribute('bias') || '0'),
            preserveAlpha: child.getAttribute('preserveAlpha') !== 'false',
            clamp: child.getAttribute('clamp') !== 'false',
            color: child.getAttribute('color') || '#000000',
            alpha: parseFloat(child.getAttribute('alpha') || '0')
          });
          break;

        case 'GradientGlowFilter':
          filters.push({
            type: 'gradientGlow',
            blurX: parseFloat(child.getAttribute('blurX') || '4'),
            blurY: parseFloat(child.getAttribute('blurY') || '4'),
            strength: parseFloat(child.getAttribute('strength') || '100') / 255,
            distance: parseFloat(child.getAttribute('distance') || '4'),
            angle: parseFloat(child.getAttribute('angle') || '45'),
            colors: this.parseGradientFilterColors(child),
            inner: child.getAttribute('inner') === 'true',
            knockout: child.getAttribute('knockout') === 'true',
            quality: parseInt(child.getAttribute('quality') || '1')
          });
          break;

        case 'GradientBevelFilter':
          filters.push({
            type: 'gradientBevel',
            blurX: parseFloat(child.getAttribute('blurX') || '4'),
            blurY: parseFloat(child.getAttribute('blurY') || '4'),
            strength: parseFloat(child.getAttribute('strength') || '100') / 255,
            distance: parseFloat(child.getAttribute('distance') || '4'),
            angle: parseFloat(child.getAttribute('angle') || '45'),
            colors: this.parseGradientFilterColors(child),
            inner: child.getAttribute('inner') === 'true',
            knockout: child.getAttribute('knockout') === 'true',
            quality: parseInt(child.getAttribute('quality') || '1')
          });
          break;
      }
    }

    return filters;
  }

  // Parse gradient colors for GradientGlowFilter and GradientBevelFilter
  private parseGradientFilterColors(el: globalThis.Element): { color: string; alpha: number; ratio: number }[] {
    const colors: { color: string; alpha: number; ratio: number }[] = [];

    // XFL stores gradient colors as child elements or attributes
    // Try child elements first (GradientEntry elements)
    const gradientEntries = el.querySelectorAll(':scope > GradientEntry');
    if (gradientEntries.length > 0) {
      for (const entry of gradientEntries) {
        colors.push({
          color: entry.getAttribute('color') || '#000000',
          alpha: parseFloat(entry.getAttribute('alpha') || '1'),
          ratio: parseFloat(entry.getAttribute('ratio') || '0')
        });
      }
      return colors;
    }

    // Try comma-separated attributes
    const colorsAttr = el.getAttribute('colors');
    const alphasAttr = el.getAttribute('alphas');
    const ratiosAttr = el.getAttribute('ratios');

    if (colorsAttr && ratiosAttr) {
      const colorValues = colorsAttr.split(',').map(c => c.trim());
      const alphaValues = alphasAttr ? alphasAttr.split(',').map(a => parseFloat(a.trim())) : colorValues.map(() => 1);
      const ratioValues = ratiosAttr.split(',').map(r => parseFloat(r.trim()));

      for (let i = 0; i < colorValues.length && i < ratioValues.length; i++) {
        colors.push({
          color: colorValues[i] || '#000000',
          alpha: alphaValues[i] ?? 1,
          ratio: ratioValues[i] ?? 0
        });
      }
    }

    // Default gradient if no colors found
    if (colors.length === 0) {
      colors.push(
        { color: '#FFFFFF', alpha: 1, ratio: 0 },
        { color: '#000000', alpha: 1, ratio: 255 }
      );
    }

    return colors;
  }

  // Build a color matrix from AdjustColorFilter parameters
  private buildAdjustColorMatrix(brightness: number, contrast: number, saturation: number, hue: number): number[] {
    // Start with identity matrix
    let matrix = [
      1, 0, 0, 0, 0,  // Red
      0, 1, 0, 0, 0,  // Green
      0, 0, 1, 0, 0,  // Blue
      0, 0, 0, 1, 0   // Alpha
    ];

    // Apply brightness (add to RGB offsets)
    // Brightness is typically -100 to 100, map to -255 to 255
    const b = brightness * 2.55;
    matrix[4] += b;
    matrix[9] += b;
    matrix[14] += b;

    // Apply contrast
    // Contrast is typically -100 to 100
    if (contrast !== 0) {
      const c = (contrast + 100) / 100; // Convert to multiplier
      const t = 0.5 * (1 - c);
      matrix = this.multiplyColorMatrices(matrix, [
        c, 0, 0, 0, t * 255,
        0, c, 0, 0, t * 255,
        0, 0, c, 0, t * 255,
        0, 0, 0, 1, 0
      ]);
    }

    // Apply saturation
    // Saturation is typically -100 to 100
    if (saturation !== 0) {
      const s = (saturation + 100) / 100;
      const sr = (1 - s) * 0.299;
      const sg = (1 - s) * 0.587;
      const sb = (1 - s) * 0.114;
      matrix = this.multiplyColorMatrices(matrix, [
        sr + s, sg, sb, 0, 0,
        sr, sg + s, sb, 0, 0,
        sr, sg, sb + s, 0, 0,
        0, 0, 0, 1, 0
      ]);
    }

    // Apply hue rotation
    // Hue is typically -180 to 180 degrees
    if (hue !== 0) {
      const angle = hue * Math.PI / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const lumR = 0.299;
      const lumG = 0.587;
      const lumB = 0.114;

      matrix = this.multiplyColorMatrices(matrix, [
        lumR + cos * (1 - lumR) + sin * (-lumR), lumG + cos * (-lumG) + sin * (-lumG), lumB + cos * (-lumB) + sin * (1 - lumB), 0, 0,
        lumR + cos * (-lumR) + sin * (0.143), lumG + cos * (1 - lumG) + sin * (0.140), lumB + cos * (-lumB) + sin * (-0.283), 0, 0,
        lumR + cos * (-lumR) + sin * (-(1 - lumR)), lumG + cos * (-lumG) + sin * (lumG), lumB + cos * (1 - lumB) + sin * (lumB), 0, 0,
        0, 0, 0, 1, 0
      ]);
    }

    return matrix;
  }

  // Multiply two 4x5 color matrices
  private multiplyColorMatrices(a: number[], b: number[]): number[] {
    const result = new Array(20).fill(0);

    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 5; col++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          sum += a[row * 5 + k] * b[k * 5 + col];
        }
        // Add the offset column
        if (col === 4) {
          sum += a[row * 5 + 4];
        }
        result[row * 5 + col] = sum;
      }
    }

    return result;
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
