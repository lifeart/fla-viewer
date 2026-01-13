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
  Point,
  Tween,
  Edge
} from './types';
import { decodeEdges } from './edge-decoder';

// Debug flag - enabled via ?debug=true URL parameter
const DEBUG = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug') === 'true';

export class FLAParser {
  private zip: JSZip | null = null;
  private symbolCache: Map<string, Symbol> = new Map();
  private parser = new DOMParser();

  async parse(file: File): Promise<FLADocument> {
    // Try to load ZIP, handling potentially corrupted files
    try {
      this.zip = await JSZip.loadAsync(file);
    } catch (e) {
      // Some FLA files have minor corruption - try to repair by truncating
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
    await this.loadSymbols(root);

    // Parse bitmap items from media section and load images
    const bitmaps = await this.parseBitmaps(root);

    // Parse sound items from media section and load audio
    const sounds = await this.parseSounds(root);

    // Parse main timeline (pass dimensions for camera detection)
    const timelines = this.parseTimelines(root, width, height);

    return {
      width,
      height,
      frameRate,
      backgroundColor,
      timelines,
      symbols: this.symbolCache,
      bitmaps,
      sounds
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

  private async loadSymbols(root: Element): Promise<void> {
    // First, try loading from Include references
    const includes = root.querySelectorAll('symbols > Include');

    for (const inc of includes) {
      const href = inc.getAttribute('href');
      if (!href) continue;

      // Load symbol XML from LIBRARY folder
      const symbolXml = await this.getFileContent(`LIBRARY/${href}`);
      if (!symbolXml) continue;

      await this.parseAndCacheSymbol(symbolXml, href);
    }

    // Also scan all XML files in LIBRARY folder directly (handles encoding issues)
    if (this.zip) {
      const libraryFiles = Object.keys(this.zip.files).filter(
        path => path.startsWith('LIBRARY/') && path.endsWith('.xml')
      );

      if (DEBUG) console.log(`Found ${libraryFiles.length} XML files in LIBRARY folder`);

      for (const path of libraryFiles) {
        const symbolXml = await this.getFileContent(path);
        if (!symbolXml) continue;

        const filename = path.replace('LIBRARY/', '');
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
        const name = symbolRoot.getAttribute('name') || filename.replace('.xml', '');

        // Skip if already cached
        if (this.symbolCache.has(name)) return;

        const itemID = symbolRoot.getAttribute('itemID') || '';
        const symbolType = (symbolRoot.getAttribute('symbolType') || 'graphic') as 'graphic' | 'movieclip' | 'button';

        // Parse symbol's timeline
        const timelines = this.parseTimelines(symbolRoot);
        const timeline = timelines[0] || {
          name: name,
          layers: [],
          totalFrames: 1
        };

        this.symbolCache.set(name, {
          name,
          itemID,
          symbolType,
          timeline
        });
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

      // Always skip guide and folder layers (explicit layer types)
      if (layer.layerType === 'guide' || layer.layerType === 'folder') {
        referenceLayers.add(i);
        continue;
      }

      // Skip camera/frame reference layers only if they have additional indicators
      // that they're not meant to be rendered (hidden, outline view, etc.)
      const isCameraRefName = layerNameLower === 'ramka' ||
                              layerNameLower === 'camera' ||
                              layerNameLower === 'cam' ||
                              layerNameLower === 'viewport';

      // Only filter by name if the layer is also hidden or using outline view
      // This prevents filtering legitimate content layers that happen to have these names
      if (isCameraRefName && (!layer.visible || layer.outline)) {
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
      const layerType = layerEl.getAttribute('layerType') as 'normal' | 'guide' | 'folder' | undefined;
      const parentLayerIndex = layerEl.getAttribute('parentLayerIndex');

      const frames = this.parseFrames(layerEl);

      layers.push({
        name,
        color,
        visible,
        locked,
        outline,
        layerType: layerType || 'normal',
        parentLayerIndex: parentLayerIndex ? parseInt(parentLayerIndex) : undefined,
        frames
      });
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

      frames.push({
        index,
        duration,
        keyMode,
        tweenType: tweenType || 'none',
        acceleration: acceleration ? parseInt(acceleration) : undefined,
        elements,
        tweens,
        sound
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

    return {
      type: 'symbol',
      libraryItemName,
      symbolType,
      matrix,
      transformationPoint,
      centerPoint3D,
      loop,
      firstFrame: firstFrame ? parseInt(firstFrame) : undefined
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

    return {
      type: 'text',
      matrix,
      left,
      width,
      height,
      textRuns
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
      const name = bitmapEl.getAttribute('name') || '';
      const href = bitmapEl.getAttribute('href') || name;
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

      bitmaps.set(name, bitmapItem);

      // Load actual image data from ZIP
      loadPromises.push(this.loadBitmapImage(bitmapItem));
    }

    // Wait for all images to load
    await Promise.all(loadPromises);

    return bitmaps;
  }

  private async loadBitmapImage(bitmapItem: BitmapItem): Promise<void> {
    if (!this.zip) return;

    // Try to find the image in LIBRARY folder
    const possiblePaths = [
      `LIBRARY/${bitmapItem.href}`,
      bitmapItem.href,
      `library/${bitmapItem.href}`,
    ];

    let imageData: ArrayBuffer | null = null;
    let foundPath = '';

    for (const path of possiblePaths) {
      const file = this.zip.file(path);
      if (file) {
        imageData = await file.async('arraybuffer');
        foundPath = path;
        break;
      }
    }

    if (!imageData) {
      if (DEBUG) {
        console.warn(`Bitmap image not found: ${bitmapItem.href}`);
      }
      return;
    }

    // Determine MIME type from extension
    const ext = bitmapItem.href.toLowerCase().split('.').pop();
    let mimeType = 'image/png';
    if (ext === 'jpg' || ext === 'jpeg') {
      mimeType = 'image/jpeg';
    } else if (ext === 'gif') {
      mimeType = 'image/gif';
    }

    // Create blob and load as image
    const blob = new Blob([imageData], { type: mimeType });
    const url = URL.createObjectURL(blob);

    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(`Failed to load image: ${foundPath}`));
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
    if (!this.zip) return;

    // Initialize AudioContext lazily
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }

    // Try to find the audio in LIBRARY folder
    const possiblePaths = [
      `LIBRARY/${soundItem.href}`,
      soundItem.href,
      `library/${soundItem.href}`,
    ];

    let audioData: ArrayBuffer | null = null;

    for (const path of possiblePaths) {
      const file = this.zip.file(path);
      if (file) {
        audioData = await file.async('arraybuffer');
        break;
      }
    }

    if (!audioData) {
      if (DEBUG) {
        console.warn(`Sound file not found: ${soundItem.href}`);
      }
      return;
    }

    try {
      // Decode audio data
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
}
