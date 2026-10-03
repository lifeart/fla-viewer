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
  ComponentParameter,
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
  PathCommand,
  Filter,
  MorphShape,
  MorphSegment,
  ColorTransform,
  BlendMode,
  Rectangle,
  WidthMarker
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
import { isOLE2, OLE2File } from './ole2-reader';
import { parseBinaryFLA } from './binary-fla-parser';
import { getMaskLayerIndex } from './layer-utils';
import { isXFLStub, xflFolderToZip, type XFLFolderEntry } from './xfl-folder';
import { rectanglePrimitivePath, ovalPrimitivePath } from './primitive-shapes';
import { parseAnimationCore } from './motion-object';

export type { XFLFolderEntry } from './xfl-folder';

// Debug flag - enabled via ?debug=true URL parameter or setParserDebug(true)
let DEBUG = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug') === 'true';

// Export setter for testing
export function setParserDebug(value: boolean): void {
  DEBUG = value;
}

export type ProgressCallback = (message: string) => void;
export type SkipCheckCallback = () => boolean;

/**
 * Anything the parser can ingest. Browser callers pass a `File`/`Blob`; headless
 * or library callers (Node, the VS Code extension host) pass raw bytes.
 */
export type FLAInput = File | Blob | ArrayBuffer | Uint8Array;

/** A constructor compatible with the WHATWG `DOMParser` (browser global or linkedom). */
export type DOMParserCtor = {
  new (): { parseFromString(source: string, mimeType: string): Document };
};

export interface FLAParserOptions {
  /**
   * XML parser implementation. Defaults to the global `DOMParser` (browsers).
   * Outside a browser, inject one — e.g. linkedom's `DOMParser` in Node or the
   * VS Code extension host: `new FLAParser({ DOMParser })`.
   */
  DOMParser?: DOMParserCtor;
}

export interface ParseOptions {
  /**
   * Skip browser-only media decoding (bitmap pixels, audio samples, FLV/video).
   * Library/headless consumers that only need timeline structure + types should
   * set this. Media *item metadata* (names, dimensions, formats) is still parsed.
   */
  structureOnly?: boolean;
}

/** Normalize any accepted input to bytes. JSZip and the OLE2 sniff both accept Uint8Array. */
async function toBytes(input: FLAInput): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  // File | Blob
  return new Uint8Array(await input.arrayBuffer());
}

// Animate's default "Dashed" line style when <DashedStroke> omits dash1/dash2.
// Source: the Property Inspector "Dashed" stroke style (Stroke Style dialog) defaults; the
// Adobe JSFL Stroke object documents dash1 (solid run) and dash2 (gap) as integers but does
// not publish the absent-attribute defaults, so we mirror the UI default 4-unit dash + 4-unit
// gap. Units match `weight` (1:1 with canvas lineWidth/user space), so no conversion is needed.
const DEFAULT_DASH_LENGTH = 4;
const DEFAULT_DASH_SPACE_LENGTH = 4;
// Default gap between dots of a <DottedStroke> without `dotSpace` (flacomdoc's XFL reader).
const DEFAULT_DOT_SPACE = 3;

/**
 * A variable-width stroke profile (Animate CC Width tool and width profiles), as saved:
 *   <SolidStroke weight="3"><fill>…</fill>
 *     <VariablePointWidth>
 *       <WidthMarker position="0" left="0" right="0" type="corner"/>
 *       <WidthMarker position="0.5" left="0.5" right="0.5"/>
 *       <WidthMarker position="1" left="0" right="0" type="corner"/>
 *     </VariablePointWidth></SolidStroke>
 * Real files only carry it on <SolidStroke>. Returns {} for a constant-width stroke.
 */
function parseWidthProfile(solidStroke: globalThis.Element): { widthMarkers?: WidthMarker[] } {
  const markers: WidthMarker[] = [];
  for (const el of solidStroke.querySelectorAll(':scope > VariablePointWidth > WidthMarker')) {
    const num = (name: string, fallback: number) => {
      const v = parseFloat(el.getAttribute(name) ?? '');
      return Number.isFinite(v) ? v : fallback;
    };
    const position = num('position', NaN);
    if (Number.isNaN(position)) continue;
    markers.push({
      position: Math.min(1, Math.max(0, position)),
      left: Math.max(0, num('left', 0.5)),
      right: Math.max(0, num('right', 0.5)),
      ...(el.getAttribute('type') === 'corner' && { corner: true }),
    });
  }
  if (markers.length === 0) return {};
  markers.sort((a, b) => a.position - b.position);
  return { widthMarkers: markers };
}

/**
 * Normalize a classic tween's `motionTweenRotate`. Animate writes the long forms
 * `"clockwise"` / `"counter-clockwise"` (JSFL `frame.motionTweenRotate`); the short
 * `cw`/`ccw` forms are accepted too. Anything else (`"auto"`, absent) means no forced spin.
 */
export function parseMotionTweenRotate(value: string | null): 'cw' | 'ccw' | 'none' | undefined {
  switch (value) {
    case 'clockwise':
    case 'cw':
      return 'cw';
    case 'counter-clockwise':
    case 'ccw':
      return 'ccw';
    case 'none':
      return 'none';
    default:
      return undefined;
  }
}

/**
 * Normalize an XFL `symbolType` (on a DOMSymbolItem or a symbol instance).
 * Animate writes it only for `"graphic"` and `"button"`; a movie clip is the
 * default and has no attribute (JSFL spells that type `"movie clip"`, which is
 * accepted too, as is the internal `"movieclip"`).
 */
export function parseSymbolType(value: string | null): 'graphic' | 'movieclip' | 'button' {
  return value === 'graphic' || value === 'button' ? value : 'movieclip';
}

export class FLAParser {
  private zip: JSZip | null = null;
  private symbolCache: Map<string, Symbol> = new Map();
  private parser: { parseFromString(source: string, mimeType: string): Document };
  private lastYieldTime = 0;

  constructor(options: FLAParserOptions = {}) {
    const Ctor = options.DOMParser ?? (typeof DOMParser !== 'undefined' ? DOMParser : null);
    if (!Ctor) {
      throw new Error(
        'FLAParser: no DOMParser available. Pass one via `new FLAParser({ DOMParser })` ' +
        "(e.g. linkedom's DOMParser) when running outside a browser."
      );
    }
    this.parser = new Ctor();
  }

  // Yield to browser if more than 50ms has passed since last yield
  private async yieldIfNeeded(): Promise<void> {
    const now = performance.now();
    if (now - this.lastYieldTime > 50) {
      await new Promise(resolve => setTimeout(resolve, 0));
      this.lastYieldTime = performance.now();
    }
  }

  /**
   * Parse a .fla (zipped XFL, or a pre-CS5 binary FLA) or, given the files of an
   * uncompressed XFL folder (CS5+ "Save as XFL"), that folder.
   */
  async parse(input: FLAInput | XFLFolderEntry[], onProgress?: ProgressCallback, isSkipImagesFix?: SkipCheckCallback, options: ParseOptions = {}): Promise<FLADocument> {
    const progress = onProgress || (() => {});
    const shouldSkipImagesFix = isSkipImagesFix || (() => false);

    if (Array.isArray(input)) {
      progress('Reading XFL folder...');
      this.zip = xflFolderToZip(input);
    } else {
      // A pre-CS5 binary FLA is parsed completely while opening.
      const binaryDoc = await this.openArchive(input, progress, options);
      if (binaryDoc) return binaryDoc;
    }
    this.symbolCache.clear();
    return this.parseXfl(progress, shouldSkipImagesFix, options);
  }

  /**
   * Load a .fla into `this.zip`. Returns the finished document instead when the
   * input is a pre-CS5 binary FLA, which has no XFL inside.
   */
  private async openArchive(input: FLAInput, progress: ProgressCallback, options: ParseOptions): Promise<FLADocument | null> {
    const bytes = await toBytes(input);

    // Detect format by leading bytes. CS5+ FLAs are ZIP archives ("PK"…);
    // pre-CS5 FLAs are OLE2 compound documents (D0 CF 11 E0 …) — a completely
    // different container that JSZip cannot read (GitHub issue #8). Branch
    // before touching JSZip so binary files take the dedicated code path
    // instead of failing later with "DOMDocument.xml not found".
    const headerBytes = bytes.subarray(0, 8);
    if (isOLE2(headerBytes)) {
      progress('Reading binary (pre-CS5) FLA...');
      // parseBinaryFLA throws with a specific message on unrecognized binary
      // FLAs; let it propagate so the UI shows real feedback (no silent catch).
      const binaryDoc = parseBinaryFLA(bytes);
      // Like the XFL path, structure-only parsing skips audio decoding.
      if (binaryDoc.sounds.size > 0 && !options.structureOnly) {
        progress('Loading sounds...');
        await this.loadBinarySounds(binaryDoc.sounds, bytes);
      }
      return binaryDoc;
    }

    if (isXFLStub(bytes)) {
      throw new Error(
        'This is the .xfl file of an uncompressed XFL document (Flash CS5+ "Save as XFL"). ' +
        'Open the whole folder that contains it instead.'
      );
    }

    // Try to load ZIP, handling potentially corrupted files
    progress('Extracting archive...');
    try {
      this.zip = await JSZip.loadAsync(bytes);
    } catch (e) {
      // Some FLA files have minor corruption - try to repair by truncating
      progress('Repairing archive...');
      const repaired = await this.tryRepairZip(bytes);
      if (repaired) {
        this.zip = repaired;
      } else {
        throw e;
      }
    }
    return null;
  }

  private async parseXfl(progress: ProgressCallback, shouldSkipImagesFix: SkipCheckCallback, options: ParseOptions): Promise<FLADocument> {
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
    const bitmaps = await this.parseBitmaps(root, progress, shouldSkipImagesFix, options.structureOnly);

    // Parse sound items from media section and load audio
    progress('Loading audio...');
    const sounds = await this.parseSounds(root, options.structureOnly);

    // Parse video items from media section and load FLV data
    progress('Loading videos...');
    const videos = await this.parseVideos(root, options.structureOnly);

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

  private async tryRepairZip(input: Uint8Array): Promise<JSZip | null> {
    // The "missing X bytes" error usually means the central directory size is wrong
    // We can try to fix this by finding and patching the End of Central Directory record

    // Work on a standalone ArrayBuffer copy so DataView/slice offsets stay simple
    // even when `input` is a subarray view over a larger buffer. The cast drops
    // the SharedArrayBuffer arm of ArrayBufferLike — FLA bytes are never backed
    // by shared memory, and JSZip.loadAsync only accepts a plain ArrayBuffer.
    const buffer = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
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

      // A Component Inspector / SWC component lives in the library as a COMPILED
      // CLIP — a <DOMCompiledClipItem>, not a <DOMSymbolItem>. It still carries
      // name + linkageClassName (the registerClass'd AS class), so a stage
      // instance referencing it can be typed. Load it the same way; without it
      // the symbol is absent from doc.symbols and the instance can't be typed.
      const isCompiledClip = symbolRoot.tagName === 'DOMCompiledClipItem';
      if (symbolRoot.tagName === 'DOMSymbolItem' || isCompiledClip) {
        const rawName = symbolRoot.getAttribute('name') || filename.replace('.xml', '');
        const name = normalizePath(rawName);

        // Skip if already cached
        if (hasWithNormalizedPath(this.symbolCache, rawName)) return;

        const itemID = symbolRoot.getAttribute('itemID') || '';
        // Movie clips (compiled clips included) carry no symbolType attribute.
        const symbolType = parseSymbolType(symbolRoot.getAttribute('symbolType'));

        // ActionScript linkage (Export for ActionScript). Used by tooling to map
        // a library symbol to its AS class / attachMovie identifier.
        const linkageExportForAS = symbolRoot.getAttribute('linkageExportForAS') === 'true' ? true : undefined;
        const linkageClassName = symbolRoot.getAttribute('linkageClassName') || undefined;
        const linkageIdentifier = symbolRoot.getAttribute('linkageIdentifier') || undefined;
        const linkageBaseClass = symbolRoot.getAttribute('linkageBaseClass') || undefined;

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
          ...(hitAreaFrame !== undefined && { hitAreaFrame }),
          ...(linkageExportForAS && { linkageExportForAS }),
          ...(linkageClassName && { linkageClassName }),
          ...(linkageIdentifier && { linkageIdentifier }),
          ...(linkageBaseClass && { linkageBaseClass })
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

      // Animate's native camera layer, unless the timeline marks the camera
      // disabled (files with a camera write cameraLayerEnabled="true").
      const nativeCameraIndex = layers.findIndex((layer) => layer.layerType === 'camera');
      const nativeCameraLayerIndex = nativeCameraIndex >= 0 && tl.getAttribute('cameraLayerEnabled') !== 'false'
        ? nativeCameraIndex
        : undefined;

      // Detect all reference layers that should not be rendered
      const referenceLayers = this.detectReferenceLayers(layers, docWidth, docHeight);

      // Also add camera layer to reference layers if detected
      if (cameraLayerIndex !== undefined) {
        referenceLayers.add(cameraLayerIndex);
      }

      timelines.push({
        name, layers, totalFrames, cameraLayerIndex, referenceLayers,
        ...(nativeCameraLayerIndex !== undefined && { nativeCameraLayerIndex })
      });
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

      // Animate's native camera layer is applied on its own (nativeCameraLayerIndex).
      if (!isCameraName || layer.layerType === 'camera') continue;

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
      const attachedToCamera = layerEl.getAttribute('attachedToCamera') === 'true';

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
        ...(attachedToCamera && { attachedToCamera }),
        frames
      });
    }

    // Build mask relationships: layers linked (directly, or through a folder
    // nested in the mask group) under a mask layer are masked by it. Guide and
    // folder children keep their type — re-typing them as 'masked' would make a
    // guide render, and would leave a masked folder's children unclipped.
    for (let i = 0; i < layers.length; i++) {
      const maskIndex = getMaskLayerIndex(layers, i);
      if (maskIndex !== undefined) {
        layers[i].layerType = 'masked';
        layers[i].maskLayerIndex = maskIndex;
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
      const tweenType = frameEl.getAttribute('tweenType') as Frame['tweenType'] | null;
      const acceleration = frameEl.getAttribute('acceleration');

      // Motion tween properties
      const motionTweenRotate = parseMotionTweenRotate(frameEl.getAttribute('motionTweenRotate'));
      const motionTweenRotateTimes = frameEl.getAttribute('motionTweenRotateTimes');
      const motionTweenScale = frameEl.getAttribute('motionTweenScale');
      const motionTweenOrientToPath = frameEl.getAttribute('motionTweenOrientToPath');

      const elements = this.parseElements(frameEl);
      const tweens = this.parseTweens(frameEl);

      // Parse sound reference
      const sound = this.parseFrameSound(frameEl);

      // Parse morph shape for shape tweens
      const morphShape = tweenType === 'shape' ? this.parseMorphShape(frameEl) : undefined;

      // CS4+ object motion tween: the property curves live in <motionObjectXML>.
      const animationCore = tweenType === 'motion object'
        ? frameEl.querySelector(':scope > motionObjectXML > AnimationCore')
        : null;
      const motionObject = animationCore ? parseAnimationCore(animationCore) : undefined;

      // IK pose span (Bone tool armature): Flash's baked per-frame transforms.
      const ikPoseMatrices = tweenType === 'IK pose'
        ? this.parseIKPoseMatrices(frameEl, elements.length, duration)
        : undefined;

      // Parse frame label (name attribute is the label text, labelType is the label kind)
      const label = frameEl.getAttribute('name') || undefined;
      const labelType = frameEl.getAttribute('labelType') as 'name' | 'comment' | 'anchor' | null;

      // Parse the keyframe's frame action (XFL <Actionscript><script> CDATA).
      const scriptEl = frameEl.querySelector(':scope > Actionscript > script');
      const actionScript = scriptEl?.textContent?.trim() || undefined;

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
        ...(motionObject && { motionObject }),
        ...(ikPoseMatrices && { ikPoseMatrices }),
        ...(label && { label }),
        ...(labelType && { labelType }),
        ...(actionScript && { actionScript }),
        ...(motionTweenRotate && { motionTweenRotate }),
        ...(motionTweenRotateTimes && { motionTweenRotateTimes: parseInt(motionTweenRotateTimes) }),
        ...(motionTweenScale === 'true' && { motionTweenScale: true }),
        ...(motionTweenOrientToPath === 'true' && { motionTweenOrientToPath: true })
      });
    }

    return frames;
  }

  /**
   * The `<betweenFrameMatrixList>` of an IK pose span (`tweenType="IK pose"`),
   * split per element. Flash writes one `<Matrix>` per element per frame of the
   * span, element-major: every frame of the first element in `<elements>`, then
   * the second's, and so on. Each matrix is applied in the parent's space on top
   * of the element's stored matrix; the first is the identity. Checked on a CS6
   * save, where `pose * matrix` reproduces the per-frame position and angle each
   * `<IKTree>` node stores (`xArray`, `yArray`, `angleArray`) and the bone
   * lengths of its pose `<State>`s. Undefined when the count doesn't fit the
   * parsed elements, so the lists can't be matched to them (this also catches
   * a group in `<elements>`, which flattens into several elements).
   */
  private parseIKPoseMatrices(frameEl: globalThis.Element, elementCount: number, duration: number): Matrix[][] | undefined {
    const matrixEls = frameEl.querySelectorAll(':scope > betweenFrameMatrixList > Matrix');
    if (elementCount === 0 || matrixEls.length !== elementCount * duration) return undefined;
    const perElement: Matrix[][] = [];
    for (let e = 0; e < elementCount; e++) {
      const poses: Matrix[] = [];
      for (let f = 0; f < duration; f++) poses.push(this.parseMatrix(matrixEls[e * duration + f]));
      perElement.push(poses);
    }
    return perElement;
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
        // Modern Adobe Animate tweens encode the easing TYPE+DIRECTION in
        // `method` as a CreateJS-style token (e.g. "cubicIn", "backOut",
        // "quadInOut"). It is stored raw and decomposed in the renderer.
        // When `method` is absent the ease is the legacy intensity-only one.
        const method = tweenEl.getAttribute('method');
        tweens.push({
          target,
          intensity: intensity ? parseInt(intensity) : 0,
          ...(method && { method })
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
        // A Component Inspector component (`<DOMComponentInstance>`, e.g. SkyUI's
        // lists/buttons) carries the same libraryItemName + instance name as a
        // symbol instance, plus a <persistentData> params block we ignore here.
        // Without this case its named instances are dropped from frame.elements.
        case 'DOMComponentInstance':
          elements.push(this.parseSymbolInstance(child, identityMatrix));
          break;
        case 'DOMShape':
          elements.push(this.parseShape(child, identityMatrix));
          break;
        case 'DOMRectangleObject':
        case 'DOMOvalObject':
          elements.push(this.parsePrimitiveShape(child, identityMatrix));
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
        case 'DOMTLFText':
          elements.push(this.parseTLFText(child, identityMatrix));
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
        case 'DOMRectangleObject':
        case 'DOMOvalObject':
          elements.push(this.parsePrimitiveShape(child, composedMatrix));
          break;
        case 'DOMGroup':
          this.parseGroupMembers(child, elements, composedMatrix);
          break;
        case 'DOMSymbolInstance':
        case 'DOMComponentInstance':
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
        case 'DOMTLFText':
          elements.push(this.parseTLFText(child, composedMatrix));
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
    // Instance name (Properties panel) — the AS identifier for this object.
    // The renderer ignores it; tooling (code completion) relies on it.
    const name = el.getAttribute('name') || undefined;
    // Movie clip instances (components included) carry no symbolType attribute.
    const symbolType = parseSymbolType(el.getAttribute('symbolType'));
    const loop = (el.getAttribute('loop') || 'loop') as SymbolInstance['loop'];
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

    // Parse author-time component parameters (Component Inspector)
    const componentParameters = this.parseComponentParameters(el);

    return {
      type: 'symbol',
      libraryItemName,
      ...(name && { name }),
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
      ...(cacheAsBitmap && { cacheAsBitmap }),
      ...(componentParameters && { componentParameters })
    };
  }

  /**
   * Parse author-time component (Component Inspector) parameters from an
   * instance. Animate stores these as <persistentData><PD n="name" t="type"
   * v="value"/></persistentData> on the <DOMSymbolInstance>. Returns undefined
   * when the instance is not a component (no persistent data).
   */
  private parseComponentParameters(el: globalThis.Element): SymbolInstance['componentParameters'] {
    const pd = el.querySelector(':scope > persistentData');
    if (!pd) return undefined;
    const items = pd.querySelectorAll(':scope > PD');
    const params: ComponentParameter[] = [];
    for (const item of items) {
      const name = item.getAttribute('n');
      if (!name) continue;
      const type = item.getAttribute('t') || undefined;
      params.push({
        name,
        value: item.getAttribute('v') || '',
        ...(type && { type })
      });
    }
    return params.length > 0 ? params : undefined;
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
    // Instance name + kind. Dynamic/input fields carry an AS-visible name; static
    // text does not. Captured for tooling; the renderer ignores both.
    const name = el.getAttribute('name') || undefined;
    const textType: TextInstance['textType'] =
      el.tagName === 'DOMDynamicText' ? 'dynamic'
      : el.tagName === 'DOMInputText' ? 'input'
      : 'static';

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
      // lineSpacing = leading: extra space ADDED between lines, in the SAME
      // point/pixel scale as `lineHeight`/`size` (no twips conversion). Absent
      // => undefined => treated as 0 (no change) by the renderer. See
      // Adobe "Extending Flash Professional" TextAttrs.lineSpacing.
      const lineSpacing = attrsEl?.getAttribute('lineSpacing')
        ? parseFloat(attrsEl.getAttribute('lineSpacing')!)
        : undefined;
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
      if (lineSpacing !== undefined) run.lineSpacing = lineSpacing;
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
      ...(name && { name }),
      textType,
      matrix,
      left,
      width,
      height,
      textRuns,
      ...(filters.length > 0 && { filters })
    };
  }

  /**
   * <DOMTLFText> (TLF text, Flash CS5-CS6 only; Animate CC converts it to classic
   * text on open). The box is `left/top/right/bottom` in twips plus the
   * <tlfTextObject> padding; the content is a Text Layout Framework <TextFlow>
   * of paragraphs (<p>) holding <span>s, with formats inherited from ancestors.
   * Rendered as classic static text: one run per span, paragraphs separated by
   * a line break.
   */
  private parseTLFText(el: globalThis.Element, composedMatrix?: Matrix): TextInstance {
    const matrixEl = el.querySelector(':scope > matrix > Matrix');
    const baseMatrix = matrixEl ? this.parseMatrix(matrixEl) : (composedMatrix || this.parseMatrix(null));
    const twips = (name: string) => (parseFloat(el.getAttribute(name) || '0') || 0) / 20;
    const textObject = Array.from(el.getElementsByTagName('*')).find((n) => n.localName === 'tlfTextObject');
    const padding = (side: string) => parseFloat(textObject?.getAttribute(`padding${side}`) || '0') || 0;

    const left = twips('left') + padding('Left');
    const top = twips('top') + padding('Top');
    const width = Math.max(0, twips('right') - twips('left') - padding('Left') - padding('Right'));
    const height = Math.max(0, twips('bottom') - twips('top') - padding('Top') - padding('Bottom'));
    // Text is laid out from y = 0 in its own space, so fold the box top into the matrix.
    const matrix = { ...baseMatrix, tx: baseMatrix.tx + baseMatrix.c * top, ty: baseMatrix.ty + baseMatrix.d * top };

    // TLF formats cascade from TextFlow > div > p > span; "inherit" defers upward.
    const format = (node: globalThis.Element, name: string): string | undefined => {
      for (let n: globalThis.Element | null = node; n && n !== el; n = n.parentElement) {
        const v = n.getAttribute(name);
        if (v !== null && v !== 'inherit') return v;
        if (n.localName === 'TextFlow') break;
      }
      return undefined;
    };
    const alignOf = (p: globalThis.Element): TextRun['alignment'] => {
      const a = format(p, 'textAlign');
      return a === 'center' ? 'center' : a === 'right' || a === 'end' ? 'right' : a === 'justify' ? 'justify' : 'left';
    };

    const textRuns: TextRun[] = [];
    const runFor = (leaf: globalThis.Element, characters: string, alignment: TextRun['alignment']): TextRun => {
      const size = parseFloat(format(leaf, 'fontSize') || '12') || 12;
      const lineHeightAttr = format(leaf, 'lineHeight') || '120%';
      const lineHeight = lineHeightAttr.endsWith('%')
        ? size * (parseFloat(lineHeightAttr) || 120) / 100
        : parseFloat(lineHeightAttr) || size * 1.2;
      const tracking = format(leaf, 'trackingRight');
      const letterSpacing = tracking
        ? (tracking.endsWith('%') ? size * (parseFloat(tracking) || 0) / 100 : parseFloat(tracking) || 0)
        : 0;
      const color = format(leaf, 'color') || '#000000';
      const alpha = parseFloat(format(leaf, 'textAlpha') ?? '1');
      const run: TextRun = {
        characters,
        alignment,
        size,
        lineHeight,
        face: format(leaf, 'fontFamily'),
        // textAlpha (0..1) becomes the hex color's alpha byte.
        fillColor: alpha >= 0 && alpha < 1 && /^#[0-9a-f]{6}$/i.test(color)
          ? color + Math.round(alpha * 255).toString(16).padStart(2, '0')
          : color,
        bold: format(leaf, 'fontWeight') === 'bold',
        italic: format(leaf, 'fontStyle') === 'italic',
        ...(letterSpacing !== 0 && { letterSpacing }),
      };
      if (format(leaf, 'textDecoration') === 'underline') run.underline = true;
      return run;
    };

    const paragraphs = Array.from(el.getElementsByTagName('*')).filter((n) => n.localName === 'p');
    paragraphs.forEach((p, pIndex) => {
      const alignment = alignOf(p);
      const runsBefore = textRuns.length;
      // Walk the paragraph in document order: text inside <span>s becomes runs,
      // <br/> a line break and <tab/> a tab (markup whitespace between tags is ignored).
      const walk = (node: globalThis.Element) => {
        for (const child of Array.from(node.childNodes)) {
          if (child.nodeType === 3) {
            const parent = child.parentElement;
            if (parent && parent.localName === 'span' && child.textContent) {
              textRuns.push(runFor(parent, child.textContent, alignment));
            }
          } else if (child.nodeType === 1) {
            const element = child as globalThis.Element;
            if (element.localName === 'br' || element.localName === 'tab') {
              textRuns.push(runFor(element, element.localName === 'br' ? '\n' : '\t', alignment));
            } else {
              walk(element);
            }
          }
        }
      };
      walk(p);
      // A paragraph ends with a line break (the renderer breaks after a run's \r).
      // An empty paragraph is a blank line, formatted by its (empty) span if it has one.
      if (pIndex < paragraphs.length - 1) {
        if (textRuns.length > runsBefore) {
          textRuns[textRuns.length - 1].characters += '\r';
        } else {
          const span = Array.from(p.getElementsByTagName('*')).find((n) => n.localName === 'span');
          textRuns.push(runFor(span ?? p, '\r', alignment));
        }
      }
    });

    const filters = this.parseFilters(el);
    return {
      type: 'text',
      textType: 'static',
      matrix,
      left,
      width,
      height,
      textRuns,
      ...(filters.length > 0 && { filters }),
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

  // `fillElements` defaults to the shape's <fills><FillStyle> list; primitive shapes
  // pass their single <fill> (same children, no index attribute, so index 1).
  /**
   * <DOMRectangleObject>/<DOMOvalObject> (CS3+ primitive tools): parameters plus a
   * singular <fill>/<stroke> and no edges. Rebuilt as an ordinary shape with fill
   * style 1 and stroke style 1 so every renderer path (masks, hit tests, export)
   * handles it like a drawn shape.
   */
  private parsePrimitiveShape(el: globalThis.Element, composedMatrix?: Matrix): Shape {
    const matrixEl = el.querySelector(':scope > matrix > Matrix');
    const matrix = matrixEl ? this.parseMatrix(matrixEl) : (composedMatrix || this.parseMatrix(null));
    const num = (name: string, fallback = 0) => {
      const v = parseFloat(el.getAttribute(name) ?? '');
      return Number.isFinite(v) ? v : fallback;
    };
    const fillEl = el.querySelector(':scope > fill');
    const strokeEl = el.querySelector(':scope > stroke');
    const fills = fillEl ? this.parseFills(el, [fillEl]) : [];
    const strokes = strokeEl ? this.parseStrokes(el, [strokeEl]) : [];
    const box = { x: num('x'), y: num('y'), width: num('objectWidth'), height: num('objectHeight') };

    let contours: PathCommand[][];
    let closed = true;
    if (el.tagName === 'DOMRectangleObject') {
      const topLeftRadius = num('topLeftRadius');
      // With the corner lock on, Flash uses the top-left radius for every corner.
      const locked = el.getAttribute('lockFlag') === 'true';
      const corner = (name: string) => (locked && el.getAttribute(name) === null ? topLeftRadius : num(name));
      contours = [rectanglePrimitivePath({
        ...box,
        topLeftRadius,
        topRightRadius: corner('topRightRadius'),
        bottomRightRadius: corner('bottomRightRadius'),
        bottomLeftRadius: corner('bottomLeftRadius'),
      })];
    } else {
      const oval = ovalPrimitivePath({
        ...box,
        startAngle: num('startAngle'),
        endAngle: num('endAngle'),
        innerRadius: num('innerRadius'),
        closePath: el.getAttribute('closePath') !== 'false',
      });
      contours = oval.contours;
      closed = oval.closed;
    }

    const hasFill = closed && fills.length > 0;
    const hasStroke = strokes.length > 0;
    // One edge for all contours, so exporters that fill edge by edge (SVG) keep
    // a ring's hole as part of the same nonzero path.
    const edges: Edge[] = [{
      ...(hasFill && { fillStyle1: 1 }),
      ...(hasStroke && { strokeStyle: 1 }),
      commands: contours.flat(),
    }];

    // The outline is exact, so contours are stitched without the 8px XFL gap
    // tolerance (which would join a thin ring's hole onto its outer edge).
    return { type: 'shape', matrix, fills: hasFill ? fills : [], strokes, edges, exactEdges: true };
  }

  private parseFills(shape: globalThis.Element, fillElements: Iterable<globalThis.Element> = shape.querySelectorAll('fills > FillStyle')): FillStyle[] {
    const fills: FillStyle[] = [];

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

  // Like parseFills: primitive shapes pass their single <stroke> element.
  private parseStrokes(shape: globalThis.Element, strokeElements: Iterable<globalThis.Element> = shape.querySelectorAll('strokes > StrokeStyle')): StrokeStyle[] {
    const strokes: StrokeStyle[] = [];

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
        const commonProps = { ...parseCommonStrokeProps(solidStroke), ...parseWidthProfile(solidStroke) };
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

      // Patterned strokes: Dashed plus the older "artistic" styles (Dotted, Hatched,
      // Ragged, Stipple) that Flash MX..CS6 could draw and that still appear in
      // XFL files. They are solid-colored; only Dashed and Dotted map to a canvas
      // dash pattern, the rest are drawn as a plain line so the outline is not lost.
      const styledStroke = strokeEl.querySelector(
        ':scope > DashedStroke, :scope > DottedStroke, :scope > HatchedStroke, :scope > RaggedStroke, :scope > StippleStroke'
      );
      if (styledStroke) {
        const commonProps = parseCommonStrokeProps(styledStroke);
        const solidColor = styledStroke.querySelector('fill > SolidColor');
        const color = solidColor?.getAttribute('color') || '#000000';

        let dash: number[] | undefined;
        let caps = commonProps.caps;
        if (styledStroke.tagName === 'DashedStroke') {
          // Animate writes <DashedStroke dash1="…" dash2="…"> (JSFL stroke.dash1/dash2:
          // solid run, then gap). `dashLength`/`spaceLength` are accepted as aliases.
          // Lengths are in the same user-space units as `weight`, so they map 1:1 to
          // canvas setLineDash. Files often omit both and rely on the UI default.
          const dash1 = styledStroke.getAttribute('dash1') ?? styledStroke.getAttribute('dashLength');
          const dash2 = styledStroke.getAttribute('dash2') ?? styledStroke.getAttribute('spaceLength');
          dash = [
            dash1 !== null ? parseFloat(dash1) : DEFAULT_DASH_LENGTH,
            dash2 !== null ? parseFloat(dash2) : DEFAULT_DASH_SPACE_LENGTH,
          ];
        } else if (styledStroke.tagName === 'DottedStroke') {
          // Round dots `weight` wide with `dotSpace` between them (JSFL stroke.dotSpace).
          // A zero-length dash with round caps draws one dot per period.
          const dotSpaceAttr = styledStroke.getAttribute('dotSpace');
          const dotSpace = dotSpaceAttr !== null ? parseFloat(dotSpaceAttr) : DEFAULT_DOT_SPACE;
          dash = [0, (commonProps.weight ?? 1) + dotSpace];
          caps = 'round';
        }

        strokes.push({
          index,
          type: 'solid',
          color,
          ...commonProps,
          ...(caps && { caps }),
          ...(dash && { dash }),
        } as StrokeStyle);
        continue;
      }
    }

    return strokes;
  }

  private async parseBitmaps(root: globalThis.Element, progress: ProgressCallback, shouldSkipImagesFix: SkipCheckCallback, structureOnly = false): Promise<Map<string, BitmapItem>> {
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

    // Decode pixel data sequentially with progress updates. Skipped in
    // structure-only/headless mode (no Image/canvas available, and unneeded).
    if (!structureOnly) {
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
   * Pixel byte layout: A,R,G,B (byte0=alpha, byte1=red, byte2=green, byte3=blue),
   * converted to RGBA for Canvas. This matches JPEXS ImageBinDataGenerator (writer)
   * and LosslessImageBinDataReader (reader); reading it as ABGR swaps red/blue (issue #10).
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
    const headerRowSize = bytes[2] | (bytes[3] << 8);
    const headerWidth = bytes[4] | (bytes[5] << 8);
    const headerHeight = bytes[6] | (bytes[7] << 8);
    const hasAlpha = bytes[24] === 1;
    // Byte 25 means different things per format: for 32-bit it is the chunk
    // variant flag (1 = chunked); for 8-bit it is the palette colour count
    // (0 means 256). See decode8BitFlaBitmap.
    const variant = bytes[25];

    if (DEBUG) {
      console.log(`FLA bitmap: ${headerWidth}x${headerHeight}, hasAlpha=${hasAlpha}, variant=${variant}, is8Bit=${is8Bit}, expected=${expectedWidth}x${expectedHeight}`);
    }

    // Handle 8-bit palette mode
    if (is8Bit) {
      return this.decode8BitFlaBitmap(bytes, headerWidth, headerHeight, headerRowSize, hasAlpha);
    }

    // Decompress the data using pako
    const zeroDict = new Uint8Array(32768);

    try {
      let pixelData: Uint8Array;

      // Extract compressed data based on format
      // Per JPEXS: variant=1 means chunked compression
      // Chunks start at offset 26 with [UI16 length][data]... [UI16 0x0000]
      let compData: Uint8Array;
      const expectedSize = headerWidth * headerHeight * 4;
      const maxBitmapOutput = 512 * 1024 * 1024;
      if (expectedSize > maxBitmapOutput) {
        console.warn(`FLA bitmap dimensions exceed the safe decode limit: ${headerWidth}x${headerHeight}`);
        return null;
      }
      const maxOutput = Math.min(
        Math.max(expectedSize, headerRowSize * headerHeight) + 64 * 1024,
        maxBitmapOutput,
      );
      const rawPayloadLength = bytes.length - 26;
      const rawPaddingLength = rawPayloadLength - expectedSize;
      const hasValidRawPadding = rawPaddingLength >= 0
        && rawPaddingLength <= 3
        && bytes.subarray(26 + expectedSize).every((value) => value === 0);
      const isRawPixelPlane = variant === 0 && hasValidRawPadding;

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
      } else if (isRawPixelPlane) {
        // Animate can store variant-0 32-bit bitmaps as a verbatim A,R,G,B
        // pixel plane. Do not interpret exact-size data as deflate: arbitrary
        // pixels may look like a valid stream and expand without bound.
        compData = bytes.slice(26, 26 + expectedSize);
      } else {
        // Non-chunked: raw data starts at offset 26
        // Skip zlib header if present
        let offset = 26;
        if (bytes[offset] === 0x78) {
          offset += 2;
        }
        compData = bytes.slice(offset);
      }

      // Validate we have enough compressed data to work with. A raw pixel
      // plane may legitimately be all zero (fully transparent), so compressed
      // stream heuristics apply only to data that will be inflated.
      // Empty or very small data (< 4 bytes) cannot be valid deflate stream
      if (compData.length < 4) {
        if (DEBUG) {
          console.warn(`Insufficient compressed data: ${compData.length} bytes`);
        }
        return null;
      }

      // Check if data looks like valid deflate (not all zeros)
      // First byte of deflate has block type bits that are rarely all zero
      if (!isRawPixelPlane) {
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
      }

      type NativeInflateResult =
        | { status: 'unavailable' }
        | { status: 'decoded'; data: Uint8Array }
        | { status: 'decode_error' };

      // Chromium's native inflater is dramatically faster and more memory
      // efficient for large Animate bitmap streams than pako's one-shot path.
      // Consume it incrementally and stop once output reaches the dimensions
      // declared by the bitmap header plus a small padding allowance. Bytes
      // past that are trailing padding, so they are dropped rather than
      // failing the whole bitmap.
      const tryNativeInflateRaw = async (): Promise<NativeInflateResult> => {
        if (typeof DecompressionStream === 'undefined') return { status: 'unavailable' };

        try {
          const input = new Uint8Array(compData);
          const stream = new Blob([input]).stream().pipeThrough(
            new DecompressionStream('deflate-raw' as CompressionFormat)
          );
          const reader = stream.getReader();
          const chunks: Uint8Array[] = [];
          let totalSize = 0;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;

            const kept = Math.min(value.length, maxOutput - totalSize);
            chunks.push(kept === value.length ? value : value.subarray(0, kept));
            totalSize += kept;
            if (totalSize >= maxOutput) {
              await reader.cancel('FLA bitmap output reached declared dimensions');
              break;
            }
          }

          const result = new Uint8Array(totalSize);
          let offset = 0;
          for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
          }
          return { status: 'decoded', data: result };
        } catch {
          return { status: 'decode_error' };
        }
      };

      const inflateRawWithLimit = (useDict: boolean = false): Uint8Array => {
        const chunks: Uint8Array[] = [];
        const options: pako.InflateOptions = { raw: true, chunkSize: 16384 };
        if (useDict) options.dictionary = zeroDict;
        const inflater = new pako.Inflate(options);
        let totalSize = 0;
        let outputLimitReached = false;

        // Keep output up to maxOutput; anything past it is trailing padding.
        inflater.onData = (chunk: Uint8Array) => {
          const kept = Math.min(chunk.length, maxOutput - totalSize);
          if (kept > 0) chunks.push(new Uint8Array(chunk.subarray(0, kept)));
          totalSize += kept;
          if (totalSize >= maxOutput) outputLimitReached = true;
        };

        const inputChunkSize = 4096;
        for (let offset = 0; offset < compData.length; offset += inputChunkSize) {
          const end = Math.min(offset + inputChunkSize, compData.length);
          inflater.push(compData.subarray(offset, end), end === compData.length);
          if (outputLimitReached) break;
          if (inflater.err) throw new Error(inflater.msg || 'Raw deflate failed');
        }

        const result = new Uint8Array(totalSize);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.length;
        }
        return result;
      };

      // Helper function for streaming partial recovery
      // Uses onData callback to capture chunks as they're produced,
      // allowing recovery of partial data when decompression errors occur mid-stream
      const tryStreamingRecovery = (useDict: boolean = false): Uint8Array | null => {
        try {
          const chunks: Uint8Array[] = [];
          let totalSize = 0;
          let outputLimitReached = false;
          const options: pako.InflateOptions = { raw: true, chunkSize: 16384 };
          if (useDict) {
            options.dictionary = zeroDict;
          }
          const inflater = new pako.Inflate(options);

          // Capture chunks via onData callback - this is key for partial recovery
          inflater.onData = (chunk: Uint8Array) => {
            const kept = Math.min(chunk.length, maxOutput - totalSize);
            if (kept > 0) chunks.push(new Uint8Array(chunk.subarray(0, kept)));
            totalSize += kept;
            if (totalSize >= maxOutput) outputLimitReached = true;
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

            if (outputLimitReached) break;
            if (inflater.err) {
              break;
            }
          }

          // Combine collected chunks
          if (chunks.length === 0) return null;

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

      // Exact-size variant-0 data is already the pixel plane. Otherwise prefer
      // native raw deflate and retain pako only for browsers without the API.
      if (isRawPixelPlane) {
        algoProgress('raw');
        pixelData = compData;
      } else {
        const nativeInflate = await tryNativeInflateRaw();
        try {
          if (nativeInflate.status === 'decoded') {
            algoProgress('native-deflate');
            pixelData = nativeInflate.data;
          } else {
            algoProgress('deflate');
            pixelData = inflateRawWithLimit();
          }
        } catch {
          // Raw deflate failed - try dictionary first (gives complete results for some files)
          algoProgress('dictionary');
          if (DEBUG) console.log(`Raw deflate failed for ${headerWidth}x${headerHeight}, trying dictionary...`);
          try {
            pixelData = inflateRawWithLimit(true);
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
          // Channel order per JPEXS LosslessImageBinDataReader: the stored int
          // is byte0=A, byte1=R, byte2=G, byte3=B (it reads a,b,g,r then emits
          // r|(g<<8)|(b<<16)|(a<<24) into an ARGB BufferedImage, i.e. byte1→R,
          // byte3→B). Reading it as ABGR swaps red and blue (issue #10).
          const a = actualPixelData[srcIdx];     // Alpha (byte 0)
          let r = actualPixelData[srcIdx + 1];   // Red   (byte 1)
          let g = actualPixelData[srcIdx + 2];   // Green (byte 2)
          let b = actualPixelData[srcIdx + 3];   // Blue  (byte 3)

          // Unmultiply alpha (colors are stored premultiplied).
          // Per JPEXS LosslessImageBinDataReader, the reader does `a = a - 1`
          // first (pairing with the writer ImageBinDataGenerator's `a + 1`),
          // then unmultiplies with: color = floor(color * 256 / (a - 1)).
          // Without the -1 the recovered colors are slightly too dark and the
          // emitted alpha is 1 too high on semi-transparent pixels. Opaque
          // (a=255) and fully transparent (a=0) pixels are stored literally.
          let outA = a;
          if (a > 0 && a < 255) {
            const a1 = a - 1;
            if (a1 > 0) {
              r = Math.min(255, Math.floor(r * 256 / a1));
              g = Math.min(255, Math.floor(g * 256 / a1));
              b = Math.min(255, Math.floor(b * 256 / a1));
            }
            outA = a1;
          }

          rgba[dstIdx] = r;         // R ← byte 1 (unmultiplied)
          rgba[dstIdx + 1] = g;     // G ← byte 2 (unmultiplied)
          rgba[dstIdx + 2] = b;     // B ← byte 3 (unmultiplied)
          rgba[dstIdx + 3] = outA;  // A ← byte 0 (a-1 for semi-transparent)
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
   * Strip the FLA chunk-length framing from a deflate/zlib stream and return
   * the concatenated payload. Adobe stores the compressed pixel/index data as a
   * sequence of `[UI16 chunkLen][chunkLen bytes]` records terminated by a zero
   * length. The first chunk begins with a zlib header (0x78 0xNN). This framing
   * is used by both the 32-bit (decodeFlaBitmap) and 8-bit pixel streams.
   *
   * The first chunk's two header bytes (0x78 0xNN) are dropped so the result is
   * a raw deflate stream suitable for pako.inflateRaw.
   */
  private static dechunkFlaDeflateStream(bytes: Uint8Array, start: number): Uint8Array {
    const chunks: Uint8Array[] = [];
    let pos = start;

    while (pos + 2 <= bytes.length) {
      const chunkLen = bytes[pos] | (bytes[pos + 1] << 8);
      pos += 2;
      if (chunkLen === 0) break; // Terminator
      const truncated = pos + chunkLen > bytes.length;
      const end = truncated ? bytes.length : pos + chunkLen;
      chunks.push(bytes.slice(pos, end));
      pos = end;
      if (truncated) break; // Last chunk was cut short by EOF
    }

    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    let combined = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    // Drop the zlib header (0x78 0xNN) so callers can use raw inflate.
    if (combined.length >= 2 && combined[0] === 0x78) {
      combined = combined.slice(2);
    }
    return combined;
  }

  /**
   * Decode 8-bit palette-indexed FLA bitmap format (magic: 03 03).
   *
   * Layout (reverse-engineered from real Adobe Animate .fla bitmaps; see the
   * "Blue in Super Mario 2.fla" Media streams M 3 / M 12-18):
   *
   * - Bytes 0-1:   magic 0x03 0x03
   * - Bytes 2-3:   rowSize (UI16 LE) — bytes per index row, padded to a 4-byte
   *                multiple (so rowSize >= width and rows are NOT tightly packed)
   * - Bytes 4-5:   width  (UI16 LE)
   * - Bytes 6-7:   height (UI16 LE)
   * - Bytes 8-23:  frame bounds (twips, unused here)
   * - Byte 24:     hasAlpha (0 or 1)
   * - Byte 25:     palette colour count, where 0 means 256 (single byte, so the
   *                max of 256 colours wraps to 0). This is the field byte 25
   *                holds for the *32-bit* format's "variant"; for 8-bit it is
   *                the colour-table size, matching SWF DefineBitsLossless's
   *                `BitmapColorTableSize` semantics.
   * - Bytes 26-27: 2-byte palette/stream prefix (observed `01 ff`/`00 ff` when
   *                hasAlpha=0, `00 00` when hasAlpha=1). Not needed for decoding.
   * - Byte 28..:   palette — `count` entries of 4 bytes each in R,G,B,A order
   *                (red first, alpha last). This matches SWF DefineBitsLossless
   *                colormaps (RGB/RGBA), and is DELIBERATELY NOT the A,R,G,B /
   *                ABGR order used by the verified 32-bit path.
   * - After the palette: the pixel indices, deflate-compressed with the same
   *                `[UI16 chunkLen][data]…[UI16 0]` chunk framing as the 32-bit
   *                stream. After inflating, indices are `rowSize` bytes per row
   *                (only the first `width` of each row are real pixels).
   *
   * CHANNEL ORDER EVIDENCE: rendered the real M 3 bitmap with each candidate
   * order; R,G,B,A produced Bowser Jr. with natural green/tan/orange colours,
   * while a B/R swap turned the skin blue. Alpha is the 4th byte (the palette
   * shows a clean 10→25→43→64→…→255 alpha ramp in byte 3). 8-bit palettes are
   * NOT alpha-premultiplied (unlike the 32-bit pixels), so colours are used
   * literally.
   */
  private decode8BitFlaBitmap(
    bytes: Uint8Array,
    width: number,
    height: number,
    rowSize: number,
    hasAlpha: boolean
  ): Promise<HTMLImageElement | null> {
    try {
      // Byte 25 = palette colour count (0 => 256).
      const paletteCount = bytes[25] === 0 ? 256 : bytes[25];

      // Palette starts at byte 28 (after the 26-byte header + 2-byte prefix).
      const paletteStart = 28;
      const bytesPerEntry = 4;

      if (DEBUG) {
        console.log(`8-bit bitmap: ${width}x${height}, rowSize=${rowSize}, palette=${paletteCount} entries, hasAlpha=${hasAlpha}`);
      }

      // Read palette in R,G,B,A order (red first, alpha last).
      const palette: { r: number; g: number; b: number; a: number }[] = [];
      let pos = paletteStart;
      for (let i = 0; i < paletteCount && pos + bytesPerEntry <= bytes.length; i++) {
        const r = bytes[pos];
        const g = bytes[pos + 1];
        const b = bytes[pos + 2];
        const a = hasAlpha ? bytes[pos + 3] : 255;
        palette.push({ r, g, b, a });
        pos += bytesPerEntry;
      }

      // The pixel indices follow the palette as a chunk-framed deflate stream.
      const indexStart = paletteStart + paletteCount * bytesPerEntry;
      const compData = FLAParser.dechunkFlaDeflateStream(bytes, indexStart);

      let indices: Uint8Array;
      try {
        indices = pako.inflateRaw(compData);
      } catch {
        // Some streams reference a preset (zero) dictionary, like the 32-bit
        // path. If this also fails it throws to the outer catch (no swallowing).
        const zeroDict = new Uint8Array(32768);
        indices = pako.inflateRaw(compData, { dictionary: zeroDict } as pako.InflateOptions);
      }

      // Rows are padded to `rowSize` bytes; fall back to width if the header's
      // rowSize looks wrong (smaller than width, or 0).
      const stride = rowSize >= width && rowSize > 0 ? rowSize : width;

      // Create canvas
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return Promise.resolve(null);

      const imageData = ctx.createImageData(width, height);
      const rgba = imageData.data;

      // Convert indexed pixels to RGBA, honouring the row stride.
      for (let y = 0; y < height; y++) {
        const rowBase = y * stride;
        for (let x = 0; x < width; x++) {
          const srcIdx = rowBase + x;
          if (srcIdx >= indices.length) break;
          const index = indices[srcIdx];
          const color = palette[index] || { r: 0, g: 0, b: 0, a: 255 };
          const dstIdx = (y * width + x) * 4;
          rgba[dstIdx] = color.r;
          rgba[dstIdx + 1] = color.g;
          rgba[dstIdx + 2] = color.b;
          rgba[dstIdx + 3] = color.a;
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
        console.warn('Failed to decode 8-bit FLA bitmap:', e);
      }
      return Promise.resolve(null);
    }
  }

  private audioContext: AudioContext | null = null;

  private async parseSounds(root: globalThis.Element, structureOnly = false): Promise<Map<string, SoundItem>> {
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
      // Byte length of the actual stored (e.g. MP3) stream. Adobe appends a
      // low-rate PCM "cache" after the compressed frames inside the same .dat,
      // so this lets us hand only the real stream to the decoder.
      const dataLength = soundEl.getAttribute('dataLength')
        ? parseInt(soundEl.getAttribute('dataLength')!)
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
        dataLength,
        ...formatInfo
      };

      sounds.set(name, soundItem);

      // Load actual audio data from ZIP (skipped in structure-only/headless mode)
      if (!structureOnly) {
        loadPromises.push(this.loadSoundAudio(soundItem));
      }
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

    // Adobe Animate frequently stores the sound as an MP3 stream while still
    // writing format="44kHz 16bit Stereo" (the *uncompressed* playback props),
    // so the format string is not a reliable codec indicator. Sniff the real
    // codec from the leading bytes and prefer it. Without this, MP3 bytes are
    // fed to the raw-PCM path and play as static (issue #10 "sound glitches").
    const head = new Uint8Array(audioData, 0, Math.min(4, audioData.byteLength));
    const isMp3 = (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) || // MPEG frame sync (FF Ex)
                  (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33); // "ID3" tag

    try {
      if (isMp3) {
        // Trim any trailing PCM cache Adobe appends after the MP3 frames so the
        // decoder only sees the compressed stream. slice() copies, leaving
        // audioData intact for the format-string fallback below.
        const end = soundItem.dataLength && soundItem.dataLength < audioData.byteLength
          ? soundItem.dataLength
          : audioData.byteLength;
        try {
          soundItem.audioData = await this.audioContext.decodeAudioData(audioData.slice(0, end));
          if (DEBUG) {
            console.log(`Loaded MP3 sound: ${soundItem.name}, duration: ${soundItem.audioData.duration.toFixed(2)}s`);
          }
          return;
        } catch (e) {
          // Magic looked like MP3 but the browser couldn't decode it; fall
          // through to the format-string driven path rather than giving up.
          if (DEBUG) {
            console.warn(`MP3 magic detected but decode failed, falling back: ${sourceRef}`, e);
          }
        }
      }
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

  /**
   * Decode binary-FLA sounds: each SoundItem's `href` names the OLE2 stream
   * (`Media N`) holding raw PCM or MP3 (see binary-fla-parser extractSounds).
   */
  private async loadBinarySounds(
    sounds: Map<string, SoundItem>,
    bytes: Uint8Array
  ): Promise<void> {
    if (typeof AudioContext === 'undefined') {
      console.warn('Web Audio unavailable; binary FLA sounds not loaded');
      return;
    }
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    const ole = new OLE2File(bytes);
    for (const sound of sounds.values()) {
      try {
        const data = ole.readStream(sound.href);
        // Copy into a standalone ArrayBuffer (decodeAudioData detaches it).
        const buffer = data.slice().buffer;
        if (sound.format === 'mp3') {
          sound.audioData = await this.audioContext.decodeAudioData(buffer);
        } else {
          sound.audioData = this.convertPCMToAudioBuffer(
            buffer,
            sound.sampleRate!,
            sound.bitDepth!,
            sound.channels!
          );
        }
      } catch (err) {
        console.warn(`Failed to decode binary FLA sound "${sound.name}":`, err);
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

  private async parseVideos(root: globalThis.Element, structureOnly = false): Promise<Map<string, VideoItem>> {
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

      // Load and parse FLV data (skipped in structure-only/headless mode)
      if (href && !structureOnly) {
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

  /**
   * Locate an embedded native video container inside a `.dat` blob and return
   * the playable slice + MIME type. Adobe prefixes its own small media header
   * (e.g. `03 08` + 8 bytes) before the real stream, so we find the container
   * by signature rather than hardcoding the prefix length:
   * - ISO base media (MP4/MOV/M4V): an early `ftyp` box; the stream starts 4
   *   bytes before `ftyp` (the box-size field).
   * - WebM/Matroska: the EBML header `1A 45 DF A3` at the start.
   */
  private static extractNativeVideo(bytes: Uint8Array): { bytes: Uint8Array; mime: string } | null {
    const limit = Math.min(bytes.length - 4, 64);
    for (let i = 0; i <= limit; i++) {
      // 'ftyp'
      if (bytes[i] === 0x66 && bytes[i + 1] === 0x74 && bytes[i + 2] === 0x79 && bytes[i + 3] === 0x70) {
        const start = i >= 4 ? i - 4 : 0; // back up over the 4-byte box size
        return { bytes: bytes.subarray(start), mime: 'video/mp4' };
      }
    }
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      return { bytes, mime: 'video/webm' };
    }
    return null;
  }

  private async loadVideoFLV(videoItem: VideoItem): Promise<void> {
    // Try to load from bin/ folder first (common for embedded video)
    let data = await this.findFileData(videoItem.href, 'bin');

    // Fallback to LIBRARY folder
    if (!data) {
      data = await this.findFileData(videoItem.href);
    }

    if (!data) {
      console.warn(`Video file not found: ${videoItem.href}`);
      return;
    }

    const bytes = new Uint8Array(data);

    // Embedded video in XFL is usually NOT an FLV: Adobe wraps a native MP4/MOV
    // (or WebM) in the `.dat` behind a small media header. Hand that straight to
    // the browser as an object URL so the renderer can decode/draw real frames.
    // (The FLV path below only ever extracted metadata — never pixels.)
    const isFlv = bytes[0] === 0x46 && bytes[1] === 0x4c && bytes[2] === 0x56; // 'FLV'
    if (!isFlv) {
      const native = FLAParser.extractNativeVideo(bytes);
      if (native && typeof URL !== 'undefined' && URL.createObjectURL) {
        // Copy the slice into a fresh ArrayBuffer-backed view so Blob accepts it.
        const payload = new Uint8Array(native.bytes.byteLength);
        payload.set(native.bytes);
        videoItem.videoUrl = URL.createObjectURL(new Blob([payload], { type: native.mime }));
        if (DEBUG) {
          console.log(`Embedded video ready: ${videoItem.name} (${native.mime}, ${native.bytes.length} bytes)`);
        }
      } else {
        // Don't swallow this silently — an unrecognized embedded format is why a
        // video renders as the gray placeholder, and that should be visible.
        console.warn(
          `Unrecognized embedded video format for ${videoItem.href} ` +
          `(first bytes: ${Array.from(bytes.slice(0, 4)).map((b) => b.toString(16).padStart(2, '0')).join(' ')}); ` +
          `showing placeholder.`
        );
      }
      return;
    }

    try {
      const flvData = data;
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
      // Surface FLV parse failures (not DEBUG-gated) so broken video wiring is
      // visible instead of silently degrading to the placeholder.
      console.warn(`Failed to parse FLV: ${videoItem.href}`, e);
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

  // Parse filters from <filters> element. `strength` is a ratio (1 = 100%, the
  // default): JPEXS writes SWF's FIXED8 strength as is, and Animate saves a 60%
  // drop shadow as strength="0.6" (its object tween curve says 60).
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
          // Animate omits defaults: a saved <GlowFilter quality="3"/> tweens from
          // blur 5, strength 100% and opaque red (its object tween's Glow_* curves).
          filters.push({
            type: 'glow',
            blurX: parseFloat(child.getAttribute('blurX') || '5'),
            blurY: parseFloat(child.getAttribute('blurY') || '5'),
            color: child.getAttribute('color') || '#FF0000',
            strength: parseFloat(child.getAttribute('strength') || '1'),
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
            strength: parseFloat(child.getAttribute('strength') || '1'),
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
            strength: parseFloat(child.getAttribute('strength') || '1'),
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
            strength: parseFloat(child.getAttribute('strength') || '1'),
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
            strength: parseFloat(child.getAttribute('strength') || '1'),
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
