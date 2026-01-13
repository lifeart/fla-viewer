import JSZip from 'jszip';
import type {
  FLADocument,
  Timeline,
  Layer,
  Frame,
  DisplayElement,
  SymbolInstance,
  Shape,
  Matrix,
  FillStyle,
  Symbol,
  Point,
  Tween,
  Edge
} from './types';
import { decodeEdges } from './edge-decoder';

// XFL namespace (for reference)

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
    const width = parseFloat(root.getAttribute('width') || '550');
    const height = parseFloat(root.getAttribute('height') || '400');
    const frameRate = parseFloat(root.getAttribute('frameRate') || '24');
    const backgroundColor = root.getAttribute('backgroundColor') || '#FFFFFF';

    // Parse symbol references and load them
    await this.loadSymbols(root);

    // Parse main timeline
    const timelines = this.parseTimelines(root);

    return {
      width,
      height,
      frameRate,
      backgroundColor,
      timelines,
      symbols: this.symbolCache
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
        console.log(`ZIP repaired by trimming to EOCD boundary`);
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
        console.log(`ZIP repaired by patching CD size: ${cdSize} -> ${actualCdSize}`);
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

      console.log(`Found ${libraryFiles.length} XML files in LIBRARY folder`);

      for (const path of libraryFiles) {
        const symbolXml = await this.getFileContent(path);
        if (!symbolXml) continue;

        const filename = path.replace('LIBRARY/', '');
        await this.parseAndCacheSymbol(symbolXml, filename);
      }
    }

    console.log(`Loaded ${this.symbolCache.size} symbols`);
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

  private parseTimelines(parent: globalThis.Element): Timeline[] {
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

      timelines.push({ name, layers, totalFrames });
    }

    return timelines;
  }

  private parseLayers(timeline: globalThis.Element): Layer[] {
    const layers: Layer[] = [];
    const layerElements = timeline.querySelectorAll(':scope > layers > DOMLayer');

    for (const layerEl of layerElements) {
      const name = layerEl.getAttribute('name') || 'Layer';
      const color = layerEl.getAttribute('color') || '#000000';
      const visible = layerEl.getAttribute('visible') !== 'false';
      const locked = layerEl.getAttribute('locked') === 'true';
      const layerType = layerEl.getAttribute('layerType') as 'normal' | 'guide' | 'folder' | undefined;
      const parentLayerIndex = layerEl.getAttribute('parentLayerIndex');

      const frames = this.parseFrames(layerEl);

      layers.push({
        name,
        color,
        visible,
        locked,
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
      const duration = parseInt(frameEl.getAttribute('duration') || '1');
      const keyMode = parseInt(frameEl.getAttribute('keyMode') || '0');
      const tweenType = frameEl.getAttribute('tweenType') as 'motion' | 'shape' | undefined;
      const acceleration = frameEl.getAttribute('acceleration');

      const elements = this.parseElements(frameEl);
      const tweens = this.parseTweens(frameEl);

      frames.push({
        index,
        duration,
        keyMode,
        tweenType: tweenType || 'none',
        acceleration: acceleration ? parseInt(acceleration) : undefined,
        elements,
        tweens
      });
    }

    return frames;
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

    // Parse symbol instances (direct children and nested in groups)
    const symbolInstances = elementsContainer.querySelectorAll('DOMSymbolInstance');
    for (const inst of symbolInstances) {
      elements.push(this.parseSymbolInstance(inst));
    }

    // Parse shapes (direct children only, not nested in groups)
    const directShapes = elementsContainer.querySelectorAll(':scope > DOMShape');
    for (const shape of directShapes) {
      elements.push(this.parseShape(shape));
    }

    // Parse DOMGroup elements and extract shapes from their members
    const groups = elementsContainer.querySelectorAll(':scope > DOMGroup');
    for (const group of groups) {
      this.parseGroupMembers(group, elements);
    }

    return elements;
  }

  private parseGroupMembers(group: globalThis.Element, elements: DisplayElement[]): void {
    const members = group.querySelector(':scope > members');
    if (!members) return;

    // Parse shapes inside the group
    const shapes = members.querySelectorAll(':scope > DOMShape');
    for (const shape of shapes) {
      elements.push(this.parseShape(shape));
    }

    // Parse nested groups recursively
    const nestedGroups = members.querySelectorAll(':scope > DOMGroup');
    for (const nestedGroup of nestedGroups) {
      this.parseGroupMembers(nestedGroup, elements);
    }

    // Parse symbol instances inside groups
    const symbolInstances = members.querySelectorAll(':scope > DOMSymbolInstance');
    for (const inst of symbolInstances) {
      elements.push(this.parseSymbolInstance(inst));
    }
  }

  private parseSymbolInstance(el: globalThis.Element): SymbolInstance {
    const libraryItemName = el.getAttribute('libraryItemName') || '';
    const symbolType = (el.getAttribute('symbolType') || 'graphic') as 'graphic' | 'movieclip' | 'button';
    const loop = (el.getAttribute('loop') || 'loop') as 'loop' | 'play once' | 'single frame';
    const firstFrame = el.getAttribute('firstFrame');

    const matrix = this.parseMatrix(el.querySelector('matrix > Matrix'));
    const transformationPoint = this.parsePoint(el.querySelector('transformationPoint > Point'));

    return {
      type: 'symbol',
      libraryItemName,
      symbolType,
      matrix,
      transformationPoint,
      loop,
      firstFrame: firstFrame ? parseInt(firstFrame) : undefined
    };
  }

  private parseShape(el: globalThis.Element): Shape {
    const matrix = this.parseMatrix(el.querySelector('matrix > Matrix'));
    const fills = this.parseFills(el);
    const edges = this.parseShapeEdges(el);

    return {
      type: 'shape',
      matrix,
      fills,
      strokes: [],
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

  private parseShapeEdges(shape: globalThis.Element): Edge[] {
    const edges: Edge[] = [];
    const edgeElements = shape.querySelectorAll('edges > Edge');

    for (const edgeEl of edgeElements) {
      const fillStyle0 = edgeEl.getAttribute('fillStyle0');
      const fillStyle1 = edgeEl.getAttribute('fillStyle1');
      const strokeStyle = edgeEl.getAttribute('strokeStyle');
      const edgesAttr = edgeEl.getAttribute('edges') || '';

      edges.push({
        fillStyle0: fillStyle0 ? parseInt(fillStyle0) : undefined,
        fillStyle1: fillStyle1 ? parseInt(fillStyle1) : undefined,
        strokeStyle: strokeStyle ? parseInt(strokeStyle) : undefined,
        commands: decodeEdges(edgesAttr)
      });
    }

    return edges;
  }

  private parseMatrix(el: Element | null): Matrix {
    if (!el) {
      return { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
    }

    return {
      a: parseFloat(el.getAttribute('a') || '1'),
      b: parseFloat(el.getAttribute('b') || '0'),
      c: parseFloat(el.getAttribute('c') || '0'),
      d: parseFloat(el.getAttribute('d') || '1'),
      tx: parseFloat(el.getAttribute('tx') || '0'),
      ty: parseFloat(el.getAttribute('ty') || '0')
    };
  }

  private parsePoint(el: Element | null): Point {
    if (!el) {
      return { x: 0, y: 0 };
    }

    return {
      x: parseFloat(el.getAttribute('x') || '0'),
      y: parseFloat(el.getAttribute('y') || '0')
    };
  }
}
