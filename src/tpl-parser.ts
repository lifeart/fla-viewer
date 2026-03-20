import JSZip from 'jszip';
import { parseTVG, renderTVGToCanvas, resolveExternalPalette, loadBitmapTiles } from './tvg-parser';
import type { ExternalPaletteColor } from './tvg-parser';
import { parseSceneGraph, renderCompositeFrame } from './tpl-compositor';
import type {
  FLADocument,
  Timeline,
  Layer,
  Frame,
  BitmapItem,
  BitmapInstance,
} from './types';

export type ProgressCallback = (message: string) => void;

/** Metadata extracted from scene.xstage */
export interface TPLMetadata {
  harmonyVersion: string;
  width: number;
  height: number;
  frameRate: number;
  totalFrames: number;
  sceneName: string;
  elementCount: number;
  paletteNames: string[];
  /** Parsed palette colors */
  palettes: TPLPalette[];
  /** Node types found in the scene graph */
  nodeTypes: string[];
  /** Parsed element registry */
  elements: TPLElement[];
  /** Node graph hierarchy */
  nodeTree: TPLNode[];
  /** Drawing exposure columns (element -> frame -> drawing name) */
  exposures: TPLExposure[];
}

/** Units per field in TVG coordinate space. fieldChart × this = viewport size in TVG units. */
export const TVG_UNITS_PER_FIELD = 28;

export interface TPLElement {
  id: number;
  name: string;
  folder: string;
  fieldChart: number;
  drawingCount: number;
  drawings: string[];
}

export interface TPLNode {
  type: 'group' | 'module';
  name: string;
  moduleType?: string; // e.g. READ, PEG, COMPOSITE, etc.
  children?: TPLNode[];
  elementCol?: string; // For READ nodes, the column reference
  color?: string; // Group color
}

export interface TPLExposure {
  elementId: number;
  elementName: string;
  columnName: string;
  /** Map of frame range string to drawing name */
  frames: { start: number; end: number; drawing: string }[];
}

export interface TPLPaletteColor {
  type: 'solid' | 'gradient';
  name: string;
  id: string;
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface TPLPalette {
  name: string;
  colors: TPLPaletteColor[];
}

/**
 * Detect whether a ZIP file is a Toon Boom .tpl archive.
 * Checks for the presence of scene.xstage inside the ZIP.
 */
export async function isTPLFile(zip: JSZip): Promise<boolean> {
  // scene.xstage may be at root or inside a single top-level folder
  const xstagePath = findFile(zip, 'scene.xstage');
  return xstagePath !== null;
}

/**
 * Find a file in the ZIP, handling the case where everything
 * is nested inside a single top-level directory.
 */
function findFile(zip: JSZip, filename: string): string | null {
  // Direct match at root
  if (zip.file(filename)) return filename;

  // Check inside top-level folders (e.g., "MyProject.tpl/scene.xstage")
  const topDirs = new Set<string>();
  zip.forEach((relativePath) => {
    const firstSlash = relativePath.indexOf('/');
    if (firstSlash > 0) {
      topDirs.add(relativePath.substring(0, firstSlash + 1));
    }
  });

  for (const dir of topDirs) {
    const path = dir + filename;
    if (zip.file(path)) return path;
  }

  return null;
}

/**
 * Find all files matching a pattern prefix in the ZIP.
 */
function findFiles(zip: JSZip, prefix: string): string[] {
  const results: string[] = [];

  // Try direct
  zip.forEach((path) => {
    if (path.startsWith(prefix)) {
      results.push(path);
    }
  });

  if (results.length > 0) return results;

  // Try inside top-level folders
  const topDirs = new Set<string>();
  zip.forEach((relativePath) => {
    const firstSlash = relativePath.indexOf('/');
    if (firstSlash > 0) {
      topDirs.add(relativePath.substring(0, firstSlash + 1));
    }
  });

  for (const dir of topDirs) {
    zip.forEach((path) => {
      if (path.startsWith(dir + prefix)) {
        results.push(path);
      }
    });
    if (results.length > 0) return results;
  }

  return results;
}

/**
 * Parse a Toon Boom .tpl ZIP archive into an FLADocument for playback.
 * Phase 1: Uses pre-rendered thumbnails for frame display.
 */
export async function parseTPL(
  file: File,
  onProgress?: ProgressCallback
): Promise<{ doc: FLADocument; metadata: TPLMetadata }> {
  const progress = onProgress || (() => {});

  progress('Extracting archive...');
  const zip = await JSZip.loadAsync(file);

  // Parse scene.xstage for metadata
  progress('Parsing scene...');
  const xstagePath = findFile(zip, 'scene.xstage');
  if (!xstagePath) {
    throw new Error('Invalid TPL file: scene.xstage not found');
  }

  const xstageXml = await zip.file(xstagePath)!.async('text');
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xstageXml, 'text/xml');

  const metadata = parseXStageMetadata(xmlDoc);

  // Parse structure data
  progress('Parsing elements...');
  metadata.elements = parseElements(xmlDoc);
  metadata.nodeTree = parseNodeTree(xmlDoc);
  metadata.exposures = parseExposures(xmlDoc, metadata.elements);

  // Parse palettes
  progress('Loading palettes...');
  metadata.palettes = await loadPalettes(zip);
  metadata.paletteNames = metadata.palettes.map(p => p.name);

  // Always render TVG vector art as the primary display.
  // Pre-rendered frame thumbnails are used as fallback for animation playback
  // when per-frame compositor rendering isn't available yet.
  let thumbnails = new Map<number, HTMLImageElement>();

  // Step 1: Render TVG vector art as the primary display (frame 0)
  progress('Rendering TVG vector art...');
  const tvgRendered = await renderTVGElements(zip, metadata, progress);
  if (tvgRendered) {
    thumbnails.set(0, tvgRendered);
  }

  // Step 2: Load pre-rendered frame thumbnails for animation playback (frames 1+)
  progress('Loading frame thumbnails...');
  const frameThumbs = await loadFrameThumbnails(zip, progress);
  if (frameThumbs.size > 0) {
    // Use frame thumbnails for animation frames.
    // If we have a TVG render for frame 0, keep it as the first frame
    // and add the pre-rendered thumbnails for the remaining frames.
    if (thumbnails.has(0)) {
      // Replace frame 0 with our vector render, use pre-rendered for rest
      for (const [frameIdx, img] of frameThumbs) {
        if (frameIdx > 0 || !thumbnails.has(0)) {
          thumbnails.set(frameIdx, img);
        }
      }
      // Set total frames to match the animation length
      metadata.totalFrames = Math.max(metadata.totalFrames, frameThumbs.size);
    } else {
      // No TVG render succeeded, use all pre-rendered thumbnails
      thumbnails = frameThumbs;
    }
  } else if (thumbnails.size === 0) {
    // No frame thumbs either — try element thumbnail PNGs
    progress('Loading element thumbnails...');
    const elementThumbs = await loadElementThumbnails(zip, progress);
    if (elementThumbs.length > 0) {
      progress('Composing element overview...');
      const overview = await composeElementOverview(elementThumbs, metadata.width, metadata.height);
      thumbnails.set(0, overview);
    }
  }

  // Ensure at least 1 frame
  if (thumbnails.size > 0 && metadata.totalFrames < 1) {
    metadata.totalFrames = thumbnails.size;
  }

  // Build FLADocument from thumbnails
  progress('Building timeline...');
  const doc = buildDocument(metadata, thumbnails);

  return { doc, metadata };
}

/**
 * Extract metadata from the scene.xstage XML.
 */
function parseXStageMetadata(xmlDoc: Document): TPLMetadata {
  const project = xmlDoc.documentElement;
  const version = project.getAttribute('version') || '';
  const source = project.getAttribute('source') || '';
  const harmonyVersion = source || `v${version}`;

  // Canvas dimensions from <metrics>
  const metrics = xmlDoc.querySelector('options > metrics');
  let width = 1920;
  let height = 1080;
  if (metrics) {
    // Metrics can specify resolution directly or via field chart
    const resX = metrics.getAttribute('x');
    const resY = metrics.getAttribute('y');
    if (resX && resY) {
      width = parseInt(resX, 10) || width;
      height = parseInt(resY, 10) || height;
    }
  }

  // Resolution override
  const resolution = xmlDoc.querySelector('options > resolution');
  if (resolution) {
    const resX = resolution.getAttribute('x');
    const resY = resolution.getAttribute('y');
    if (resX && resY) {
      width = parseInt(resX, 10) || width;
      height = parseInt(resY, 10) || height;
    } else {
      // Handle size="W,H" format (e.g., size="4096,3112")
      const sizeStr = resolution.getAttribute('size');
      if (sizeStr) {
        const parts = sizeStr.split(',');
        if (parts.length === 2) {
          const w = parseInt(parts[0], 10);
          const h = parseInt(parts[1], 10);
          if (w > 0 && h > 0) {
            width = w;
            height = h;
          }
        }
      }
    }
  }

  // Frame rate
  const framerateEl = xmlDoc.querySelector('options > framerate');
  const frameRate = framerateEl ? parseInt(framerateEl.getAttribute('val') || '24', 10) : 24;

  // Scene info
  const sceneEl = xmlDoc.querySelector('scenes > scene');
  const totalFrames = sceneEl ? parseInt(sceneEl.getAttribute('nbframes') || '1', 10) : 1;
  const sceneName = sceneEl?.getAttribute('name') || 'Top';

  // Element count
  const elements = xmlDoc.querySelectorAll('elements > element');
  const elementCount = elements.length;

  // Node types
  const nodeTypes = new Set<string>();
  const modules = xmlDoc.querySelectorAll('module');
  modules.forEach(m => {
    const type = m.getAttribute('type');
    if (type) nodeTypes.add(type);
  });
  const groups = xmlDoc.querySelectorAll('group');
  if (groups.length > 0) nodeTypes.add('group');

  return {
    harmonyVersion,
    width,
    height,
    frameRate,
    totalFrames,
    sceneName,
    elementCount,
    paletteNames: [],
    palettes: [],
    nodeTypes: Array.from(nodeTypes).sort(),
    elements: [],
    nodeTree: [],
    exposures: [],
  };
}

/**
 * Parse element registry from scene.xstage.
 */
function parseElements(xmlDoc: Document): TPLElement[] {
  const elements: TPLElement[] = [];
  const elNodes = xmlDoc.querySelectorAll('elements > element');
  elNodes.forEach(el => {
    const drawings: string[] = [];
    el.querySelectorAll('drawings > dwg').forEach(dwg => {
      const name = dwg.getAttribute('name');
      if (name) drawings.push(name);
    });

    elements.push({
      id: parseInt(el.getAttribute('id') || '0', 10),
      name: el.getAttribute('elementName') || '',
      folder: el.getAttribute('elementFolder') || '',
      fieldChart: parseInt(el.getAttribute('fieldChart') || '12', 10),
      drawingCount: drawings.length,
      drawings,
    });
  });
  return elements;
}

/**
 * Parse the node graph hierarchy from the rootgroup.
 */
function parseNodeTree(xmlDoc: Document): TPLNode[] {
  // Find the rootgroup (inside scenes > scene > rootgroup)
  const rootGroup = xmlDoc.querySelector('scenes > scene > rootgroup');
  if (!rootGroup) return [];

  const nodesList = rootGroup.querySelector(':scope > nodeslist');
  if (!nodesList) return [];

  return parseNodesList(nodesList);
}

function parseNodesList(nodesList: Element): TPLNode[] {
  const nodes: TPLNode[] = [];

  for (let i = 0; i < nodesList.children.length; i++) {
    const child = nodesList.children[i];
    if (child.tagName === 'group') {
      const name = child.getAttribute('name') || '';
      const colorEl = child.querySelector(':scope > options > color');
      const color = colorEl?.getAttribute('val') || undefined;

      const childNodesList = child.querySelector(':scope > nodeslist');
      const children = childNodesList ? parseNodesList(childNodesList) : [];

      nodes.push({ type: 'group', name, color, children });
    } else if (child.tagName === 'module') {
      const moduleType = child.getAttribute('type') || '';
      const name = child.getAttribute('name') || '';

      const node: TPLNode = { type: 'module', name, moduleType };

      // For READ modules, extract element column reference
      if (moduleType === 'READ') {
        const elementEl = child.querySelector('element');
        if (elementEl) {
          node.elementCol = elementEl.getAttribute('col') || undefined;
        }
      }

      nodes.push(node);
    }
  }

  return nodes;
}

/**
 * Parse drawing exposure columns from the scene.
 */
function parseExposures(xmlDoc: Document, elements: TPLElement[]): TPLExposure[] {
  const exposures: TPLExposure[] = [];
  const elementById = new Map(elements.map(e => [e.id, e]));

  const columns = xmlDoc.querySelectorAll('scenes > scene > columns > column');
  columns.forEach(col => {
    const colType = col.getAttribute('type');
    if (colType !== '0') return; // Only drawing exposure columns

    const colName = col.getAttribute('name') || '';
    const elementSeq = col.querySelector('elementSeq');
    if (!elementSeq) return;

    const elementId = parseInt(elementSeq.getAttribute('id') || '0', 10);
    const element = elementById.get(elementId);
    const drawingVal = elementSeq.getAttribute('val') || '';
    const exposuresStr = elementSeq.getAttribute('exposures') || '';

    if (!exposuresStr) return;

    const frames: { start: number; end: number; drawing: string }[] = [];
    // Parse exposure string like "1-99,100,101-107,108,109"
    const parts = exposuresStr.split(',');
    for (const part of parts) {
      const trimmed = part.trim();
      const rangeParts = trimmed.split('-');
      if (rangeParts.length === 2) {
        frames.push({
          start: parseInt(rangeParts[0], 10),
          end: parseInt(rangeParts[1], 10),
          drawing: drawingVal,
        });
      } else if (rangeParts.length === 1) {
        const f = parseInt(rangeParts[0], 10);
        frames.push({ start: f, end: f, drawing: drawingVal });
      }
    }

    exposures.push({
      elementId,
      elementName: element?.name || `Element ${elementId}`,
      columnName: colName,
      frames,
    });
  });

  return exposures;
}

/**
 * Load palette files from the archive.
 */
async function loadPalettes(zip: JSZip): Promise<TPLPalette[]> {
  const palettes: TPLPalette[] = [];
  // Find ALL .plt files, including element-level palette-library/ directories
  const pltFiles = findFiles(zip, 'palette-library/');

  // Also find element-level palettes that might be nested deeper
  const seenPaths = new Set(pltFiles);
  zip.forEach((path) => {
    if (path.endsWith('.plt') && path.includes('palette-library/') && !seenPaths.has(path)) {
      pltFiles.push(path);
    }
  });

  for (const path of pltFiles) {
    if (!path.endsWith('.plt')) continue;
    const file = zip.file(path);
    if (!file) continue;

    const text = await file.async('text');
    const palette = parsePLT(text, path);
    if (palette) palettes.push(palette);
  }

  return palettes;
}

/**
 * Parse a .plt palette file.
 */
function parsePLT(text: string, path: string): TPLPalette | null {
  const lines = text.split('\n');
  if (lines.length < 1 || !lines[0].includes('PaletteFile')) return null;

  // Extract palette name from path
  const name = path.split('/').pop()?.replace('.plt', '') || 'Unknown';

  const colors: TPLPaletteColor[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('{') || line.startsWith('}')) continue;

    // Solid format: Solid  Name  0xID  R G B A
    const solidMatch = line.match(/^Solid\s+(\S+)\s+(0x\w+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
    if (solidMatch) {
      colors.push({
        type: 'solid',
        name: solidMatch[1],
        id: solidMatch[2],
        r: parseInt(solidMatch[3], 10),
        g: parseInt(solidMatch[4], 10),
        b: parseInt(solidMatch[5], 10),
        a: parseInt(solidMatch[6], 10),
      });
      continue;
    }

    // Gradient format: Gradient  Name  0xID  Linear/Radial
    const gradMatch = line.match(/^Gradient\s+(\S+)\s+(0x\w+)/);
    if (gradMatch) {
      colors.push({
        type: 'gradient',
        name: gradMatch[1],
        id: gradMatch[2],
        r: 128, g: 128, b: 128, a: 255, // placeholder
      });
    }
  }

  return { name, colors };
}

/**
 * Parse and render TVG vector drawings into a composite overview image.
 * Returns null if no TVG files could be parsed.
 */
async function renderTVGElements(
  zip: JSZip,
  metadata: TPLMetadata,
  progress: ProgressCallback
): Promise<HTMLImageElement | null> {
  // Find TVG files
  const allFiles: string[] = [];
  zip.forEach((p) => { allFiles.push(p); });
  const tvgFiles = allFiles.filter(p => p.endsWith('.tvg')).sort();

  if (tvgFiles.length === 0) return null;

  // Build external palette from .plt files for color resolution
  const externalColors: ExternalPaletteColor[] = [];
  for (const palette of metadata.palettes) {
    for (const color of palette.colors) {
      if (color.type === 'solid') {
        externalColors.push({ r: color.r, g: color.g, b: color.b, a: color.a, id: color.id, name: color.name, paletteName: palette.name });
      }
    }
  }

  // Build element lookup by folder name to get fieldChart
  const elementByFolder = new Map<string, TPLElement>();
  for (const el of metadata.elements) {
    elementByFolder.set(el.folder, el);
  }

  // Render a subset of TVG files into small canvases
  const maxElements = 48;
  const step = Math.max(1, Math.floor(tvgFiles.length / maxElements));
  const renderedCanvases: HTMLCanvasElement[] = [];
  const thumbSize = 200;

  let parsed = 0;
  for (let i = 0; i < tvgFiles.length && renderedCanvases.length < maxElements; i += step) {
    const file = zip.file(tvgFiles[i]);
    if (!file) continue;

    try {
      const buffer = await file.async('arraybuffer');
      const drawing = parseTVG(buffer);
      // Resolve colors from the project palette (.plt files)
      if (externalColors.length > 0) {
        resolveExternalPalette(drawing, externalColors);
      }
      // Determine viewport from element's fieldChart
      let viewportSize: number | undefined;
      const pathParts = tvgFiles[i].split('/');
      const elemFolder = pathParts.find((_, idx) =>
        idx > 0 && pathParts[idx - 1] === 'elements'
      );
      if (elemFolder) {
        const elem = elementByFolder.get(elemFolder);
        if (elem) {
          viewportSize = elem.fieldChart * TVG_UNITS_PER_FIELD;
        }
      }
      const canvas = renderTVGToCanvas(drawing, thumbSize, thumbSize, viewportSize, { skipClipping: true });
      if (canvas) {
        // Load bitmap tiles asynchronously if present
        if ((canvas as any).__bitmapTiles) {
          await loadBitmapTiles(canvas);
        }
        renderedCanvases.push(canvas);
      }
    } catch (e) {
      console.warn('[TPL] TVG render failed:', tvgFiles[i].split('/').pop(), e);
    }

    parsed++;
    if (parsed % 5 === 0) {
      progress(`Parsing TVG drawings ${parsed}/${Math.min(tvgFiles.length, maxElements)}...`);
    }
  }

  if (renderedCanvases.length === 0) return null;

  // Compose into a grid
  const canvasWidth = metadata.width;
  const canvasHeight = metadata.height;
  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#f8f8f8';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  const count = renderedCanvases.length;
  const cols = Math.ceil(Math.sqrt(count * (canvasWidth / canvasHeight)));
  const rows = Math.ceil(count / cols);
  const cellW = canvasWidth / cols;
  const cellH = canvasHeight / rows;

  for (let i = 0; i < count; i++) {
    const src = renderedCanvases[i];
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * cellW;
    const y = row * cellH;
    ctx.drawImage(src, x, y, cellW, cellH);
  }

  // Label
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, canvasHeight - 40, canvasWidth, 40);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`TVG Vector Drawings — ${count} elements rendered`, canvasWidth / 2, canvasHeight - 15);

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.src = canvas.toDataURL('image/png');
  });
}

/**
 * Load frame thumbnail PNGs from top-level .thumbnails/ directory.
 * These are composited frame renders (t-0001.png, t-0002.png, ...).
 */
async function loadFrameThumbnails(
  zip: JSZip,
  progress: ProgressCallback
): Promise<Map<number, HTMLImageElement>> {
  const thumbnails = new Map<number, HTMLImageElement>();

  // Find thumbnail files — only top-level .thumbnails/ (not elements/*/.thumbnails/)
  const allFiles: string[] = [];
  zip.forEach((p) => { allFiles.push(p); });

  // Match only top-level .thumbnails/t-NNNN.png (may be inside one wrapper folder)
  const pngFiles = allFiles
    .filter(p => {
      // Pattern: [optional-folder/].thumbnails/t-NNNN.png
      // Must NOT have elements/ in path
      return p.match(/\.thumbnails\/t-\d+\.png$/i) && !p.includes('/elements/');
    })
    .sort();

  if (pngFiles.length === 0) {
    return thumbnails;
  }

  let loaded = 0;
  for (const path of pngFiles) {
    const match = path.match(/t-(\d+)\.png$/i);
    if (!match) continue;
    const frameIndex = parseInt(match[1], 10) - 1; // 1-based to 0-based

    const file = zip.file(path);
    if (!file) continue;

    const blob = await file.async('blob');
    const img = await loadImage(blob);
    thumbnails.set(frameIndex, img);

    loaded++;
    if (loaded % 10 === 0 || loaded === pngFiles.length) {
      progress(`Loading thumbnails ${loaded}/${pngFiles.length}...`);
    }
  }

  return thumbnails;
}

/**
 * Load element drawing thumbnails from elements subdirectories.
 * Used as fallback when no frame thumbnails exist (e.g., rig files).
 */
async function loadElementThumbnails(
  zip: JSZip,
  progress: ProgressCallback
): Promise<HTMLImageElement[]> {
  const allFiles: string[] = [];
  zip.forEach((p) => { allFiles.push(p); });

  const pngFiles = allFiles
    .filter(p => p.includes('/elements/') && p.endsWith('.png'))
    .sort();

  if (pngFiles.length === 0) return [];

  const images: HTMLImageElement[] = [];
  // Limit to avoid loading hundreds of tiny thumbnails
  const maxThumbs = 64;
  const step = Math.max(1, Math.floor(pngFiles.length / maxThumbs));

  let loaded = 0;
  for (let i = 0; i < pngFiles.length && images.length < maxThumbs; i += step) {
    const file = zip.file(pngFiles[i]);
    if (!file) continue;

    try {
      const blob = await file.async('blob');
      const img = await loadImage(blob);
      // Skip very tiny thumbnails (likely blank)
      if (img.naturalWidth >= 4 && img.naturalHeight >= 4) {
        images.push(img);
      }
    } catch (_e) {
      // Skip failed images
    }

    loaded++;
    if (loaded % 10 === 0) {
      progress(`Loading element thumbnails ${loaded}...`);
    }
  }

  return images;
}

/**
 * Compose element drawing thumbnails into a single overview image
 * arranged in a grid layout.
 */
async function composeElementOverview(
  images: HTMLImageElement[],
  canvasWidth: number,
  canvasHeight: number
): Promise<HTMLImageElement> {
  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext('2d')!;

  // Light background
  ctx.fillStyle = '#f0f0f0';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Calculate grid layout
  const count = images.length;
  const cols = Math.ceil(Math.sqrt(count * (canvasWidth / canvasHeight)));
  const rows = Math.ceil(count / cols);
  const cellW = canvasWidth / cols;
  const cellH = canvasHeight / rows;
  const padding = 2;

  for (let i = 0; i < count; i++) {
    const img = images[i];
    const col = i % cols;
    const row = Math.floor(i / cols);

    const x = col * cellW + padding;
    const y = row * cellH + padding;
    const w = cellW - padding * 2;
    const h = cellH - padding * 2;

    // Fit image within cell, maintaining aspect ratio
    const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight);
    const drawW = img.naturalWidth * scale;
    const drawH = img.naturalHeight * scale;
    const drawX = x + (w - drawW) / 2;
    const drawY = y + (h - drawH) / 2;

    ctx.drawImage(img, drawX, drawY, drawW, drawH);
  }

  // Add label
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, canvasHeight - 40, canvasWidth, 40);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`Rig Overview — ${count} element drawings`, canvasWidth / 2, canvasHeight - 15);

  // Convert canvas to image
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.src = canvas.toDataURL('image/png');
  });
}

/**
 * Convert a canvas to an HTMLImageElement.
 */
function canvasToImage(canvas: HTMLCanvasElement): Promise<HTMLImageElement> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.src = canvas.toDataURL('image/png');
  });
}

/**
 * Load an image from a Blob.
 */
function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load thumbnail image'));
    };
    img.src = url;
  });
}

/**
 * Build an FLADocument from TPL metadata and thumbnails.
 * Each frame gets a single BitmapInstance displaying the thumbnail.
 */
function buildDocument(
  metadata: TPLMetadata,
  thumbnails: Map<number, HTMLImageElement>
): FLADocument {
  const bitmaps = new Map<string, BitmapItem>();
  const frames: Frame[] = [];

  // Use the thumbnail's native resolution as the document size.
  // This prevents blurry upscaling (e.g., 320x240 thumbnails scaled to 4096x3112).
  // The FLA player will fit-to-viewport anyway, so native thumbnail size looks sharp.
  let renderWidth = metadata.width;
  let renderHeight = metadata.height;
  const firstThumb = thumbnails.get(0);
  if (firstThumb && firstThumb.naturalWidth > 0) {
    renderWidth = firstThumb.naturalWidth;
    renderHeight = firstThumb.naturalHeight;
  }

  for (let i = 0; i < metadata.totalFrames; i++) {
    const img = thumbnails.get(i);
    const bitmapName = `_tpl_thumb_${i}`;

    if (img) {
      bitmaps.set(bitmapName, {
        name: bitmapName,
        href: `thumbnail_${i}.png`,
        width: img.naturalWidth,
        height: img.naturalHeight,
        imageData: img,
      });

      // Scale thumbnail to fill the document canvas
      const scaleX = renderWidth / img.naturalWidth;
      const scaleY = renderHeight / img.naturalHeight;

      const element: BitmapInstance = {
        type: 'bitmap',
        libraryItemName: bitmapName,
        matrix: { a: scaleX, b: 0, c: 0, d: scaleY, tx: 0, ty: 0 },
      };

      frames.push({
        index: i,
        duration: 1,
        keyMode: 9728,
        elements: [element],
      });
    } else {
      // Empty frame (no thumbnail available)
      frames.push({
        index: i,
        duration: 1,
        keyMode: 9728,
        elements: [],
      });
    }
  }

  const layer: Layer = {
    name: 'Thumbnails',
    color: '#000000',
    visible: true,
    locked: false,
    outline: false,
    frames,
  };

  const timeline: Timeline = {
    name: metadata.sceneName,
    layers: [layer],
    totalFrames: metadata.totalFrames,
    referenceLayers: new Set(),
  };

  return {
    width: renderWidth,
    height: renderHeight,
    frameRate: metadata.frameRate,
    backgroundColor: '#FFFFFF',
    timelines: [timeline],
    symbols: new Map(),
    bitmaps,
    sounds: new Map(),
    videos: new Map(),
  };
}
