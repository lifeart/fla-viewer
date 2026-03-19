/**
 * Toon Boom node graph compositor.
 * Evaluates the scene DAG to produce composited frames from individual TVG elements.
 */

import { parseTVG, renderTVGToCanvas, resolveExternalPalette, loadBitmapTiles } from './tvg-parser';
import type { ExternalPaletteColor } from './tvg-parser';
import type { TPLElement, TPLPalette } from './tpl-parser';
import { TVG_UNITS_PER_FIELD } from './tpl-parser';
import JSZip from 'jszip';

// ── Types ──

export interface SceneGraph {
  nodes: Map<string, SceneNode>;
  /** edges indexed by TARGET nodeId -> list of incoming edges */
  inEdges: Map<string, SceneEdge[]>;
  /** Drawing exposure columns: colName -> entries */
  drawingColumns: Map<string, DrawingColumnEntry[]>;
  /** Function value columns: colName -> keyframes */
  functionColumns: Map<string, FunctionKeyframe[]>;
  /** Element registry: elementId -> element info */
  elements: Map<number, TPLElement>;
  /** Root output node path */
  rootOutputId: string | null;
}

export interface SceneNode {
  id: string;          // Qualified path (e.g., "Top/Body_master/T-Shirt")
  name: string;        // Local name
  type: string;        // READ, PEG, COMPOSITE, CUTTER, FADE, VISIBILITY, group, etc.
  groupPath: string;   // Parent group path
  drawingCol?: string; // For READ: column name for exposure
  attrs: Map<string, AttrValue>; // All named attributes
  inverted?: boolean;  // For CUTTER
}

export interface AttrValue {
  value: number;
  col?: string; // Column name if column-driven
}

export interface SceneEdge {
  sourceId: string;
  sourcePort: number;
  targetId: string;
  targetPort: number;
}

export interface DrawingColumnEntry {
  frameStart: number;
  frameEnd: number;
  drawingName: string;
  elementId: number;
}

export interface FunctionKeyframe {
  frame: number;
  value: number;
  constSeg: boolean;
}

// ── Scene Graph Parser ──

/**
 * Parse the scene graph from scene.xstage XML.
 */
export function parseSceneGraph(xmlDoc: Document, elements: TPLElement[]): SceneGraph {
  const graph: SceneGraph = {
    nodes: new Map(),
    inEdges: new Map(),
    drawingColumns: new Map(),
    functionColumns: new Map(),
    elements: new Map(elements.map(e => [e.id, e])),
    rootOutputId: null,
  };

  // Parse columns
  parseColumns(xmlDoc, graph);

  // Parse node graph from rootgroup
  const rootGroup = xmlDoc.querySelector('scenes > scene > rootgroup');
  if (rootGroup) {
    const groupName = rootGroup.getAttribute('name') || 'Top';
    parseGroup(rootGroup, groupName, '', graph);
  }

  return graph;
}

function parseColumns(xmlDoc: Document, graph: SceneGraph): void {
  const columns = xmlDoc.querySelectorAll('scenes > scene > columns > column');
  columns.forEach(col => {
    const colType = col.getAttribute('type');
    const colName = col.getAttribute('name') || '';

    if (colType === '0') {
      // Drawing exposure column
      const entries: DrawingColumnEntry[] = [];
      const seqs = col.querySelectorAll('elementSeq');
      seqs.forEach(seq => {
        const elementId = parseInt(seq.getAttribute('id') || '0', 10);
        const drawingName = seq.getAttribute('val') || '';
        const exposuresStr = seq.getAttribute('exposures') || '';
        if (!exposuresStr) return;

        for (const part of exposuresStr.split(',')) {
          const trimmed = part.trim();
          if (!trimmed) continue;
          const rangeParts = trimmed.split('-');
          if (rangeParts.length === 2) {
            entries.push({
              frameStart: parseInt(rangeParts[0], 10),
              frameEnd: parseInt(rangeParts[1], 10),
              drawingName,
              elementId,
            });
          } else {
            const f = parseInt(rangeParts[0], 10);
            entries.push({ frameStart: f, frameEnd: f, drawingName, elementId });
          }
        }
      });
      if (entries.length > 0) {
        graph.drawingColumns.set(colName, entries);
      }
    } else if (colType === '3') {
      // Function/bezier column
      const keyframes: FunctionKeyframe[] = [];
      const points = col.querySelectorAll('points > pt');
      points.forEach(pt => {
        const constSeg = pt.getAttribute('constSeg') === 'true';
        const yLocal = parseFloat(pt.getAttribute('yLocal') || '0');
        const xStr = pt.getAttribute('x') || '';

        // Parse frame numbers from x: "1,10,60" or "40-41"
        for (const part of xStr.split(',')) {
          const trimmed = part.trim();
          if (!trimmed) continue;
          const rangeParts = trimmed.split('-');
          const frame = parseInt(rangeParts[0], 10);
          if (!isNaN(frame)) {
            keyframes.push({ frame, value: yLocal, constSeg });
          }
        }
      });
      if (keyframes.length > 0) {
        // Sort by frame
        keyframes.sort((a, b) => a.frame - b.frame);
        graph.functionColumns.set(colName, keyframes);
      }
    }
  });
}

function parseGroup(groupEl: Element, groupName: string, parentPath: string, graph: SceneGraph): void {
  const groupPath = parentPath ? `${parentPath}/${groupName}` : groupName;

  // Register group as a node
  const groupNode: SceneNode = {
    id: groupPath,
    name: groupName,
    type: 'group',
    groupPath: parentPath,
    attrs: new Map(),
  };
  graph.nodes.set(groupPath, groupNode);

  // Parse child nodes
  const nodesList = groupEl.querySelector(':scope > nodeslist');
  if (nodesList) {
    for (let i = 0; i < nodesList.children.length; i++) {
      const child = nodesList.children[i];
      if (child.tagName === 'module') {
        parseModule(child, groupPath, graph);
      } else if (child.tagName === 'group') {
        const childName = child.getAttribute('name') || '';
        parseGroup(child, childName, groupPath, graph);
      }
    }
  }

  // Parse links within this group
  const linkedList = groupEl.querySelector(':scope > linkedlist');
  if (linkedList) {
    const links = linkedList.querySelectorAll('link');
    links.forEach(link => {
      const outName = link.getAttribute('out') || '';
      const inName = link.getAttribute('in') || '';
      const outPort = parseInt(link.getAttribute('outport') || '0', 10);
      const inPort = parseInt(link.getAttribute('inport') || '0', 10);

      const sourceId = `${groupPath}/${outName}`;
      const targetId = `${groupPath}/${inName}`;

      const edge: SceneEdge = { sourceId, sourcePort: outPort, targetId, targetPort: inPort };
      if (!graph.inEdges.has(targetId)) graph.inEdges.set(targetId, []);
      graph.inEdges.get(targetId)!.push(edge);
    });
  }
}

function parseModule(moduleEl: Element, groupPath: string, graph: SceneGraph): void {
  const moduleType = moduleEl.getAttribute('type') || '';
  const name = moduleEl.getAttribute('name') || '';
  const nodeId = `${groupPath}/${name}`;

  const node: SceneNode = {
    id: nodeId,
    name,
    type: moduleType,
    groupPath,
    attrs: new Map(),
  };

  // Extract drawing column for READ nodes
  if (moduleType === 'READ') {
    const elementEl = moduleEl.querySelector('element');
    if (elementEl) {
      node.drawingCol = elementEl.getAttribute('col') || undefined;
    }
  }

  // Extract attributes with column references
  const attrEls = moduleEl.querySelectorAll(':scope > attrs > *');
  attrEls.forEach(attr => {
    const attrName = attr.tagName;
    const val = parseFloat(attr.getAttribute('val') || '0');
    const col = attr.getAttribute('col') || undefined;
    node.attrs.set(attrName, { value: isNaN(val) ? 0 : val, col });
  });

  // CUTTER inverted
  if (moduleType === 'CUTTER') {
    const invEl = moduleEl.querySelector('attrs > inverted');
    node.inverted = invEl?.getAttribute('val') === 'true';
  }

  graph.nodes.set(nodeId, node);

  // Track MULTIPORT_OUT as potential root output
  if (moduleType === 'MULTIPORT_OUT' && groupPath.split('/').length <= 2) {
    graph.rootOutputId = nodeId;
  }
}

// ── Column Evaluation ──

function evaluateColumn(graph: SceneGraph, colName: string | undefined, frame: number, defaultValue: number): number {
  if (!colName) return defaultValue;
  const keyframes = graph.functionColumns.get(colName);
  if (!keyframes || keyframes.length === 0) return defaultValue;

  // Find exact frame match
  for (const kf of keyframes) {
    if (kf.frame === frame) return kf.value;
  }

  // Find surrounding keyframes
  let before: FunctionKeyframe | null = null;
  let after: FunctionKeyframe | null = null;
  for (const kf of keyframes) {
    if (kf.frame <= frame) before = kf;
    if (kf.frame > frame && !after) after = kf;
  }

  if (before && !after) return before.value;
  if (!before && after) return after.value;
  if (before && after) {
    if (before.constSeg) return before.value; // Step/hold
    // Linear interpolation (simplified - full impl would use bezier)
    const t = (frame - before.frame) / (after.frame - before.frame);
    return before.value + (after.value - before.value) * t;
  }
  return defaultValue;
}

function resolveDrawing(graph: SceneGraph, colName: string, frame: number): { elementId: number; drawingName: string } | null {
  const entries = graph.drawingColumns.get(colName);
  if (!entries) return null;

  for (const entry of entries) {
    if (frame >= entry.frameStart && frame <= entry.frameEnd) {
      return { elementId: entry.elementId, drawingName: entry.drawingName };
    }
  }
  return null;
}

// ── Transform Builder ──

function buildTransformMatrix(node: SceneNode, graph: SceneGraph, frame: number): DOMMatrix {
  const getAttr = (name: string, def: number) => {
    const attr = node.attrs.get(name);
    if (!attr) return def;
    return evaluateColumn(graph, attr.col, frame, attr.value);
  };

  const px = getAttr('offset.x', 0) || getAttr('position.x', 0);
  const py = getAttr('offset.y', 0) || getAttr('position.y', 0);
  const sx = getAttr('scale.x', 1);
  const sy = getAttr('scale.y', 1);
  const rot = getAttr('rotation.anglez', 0) || getAttr('angle', 0);
  const pivotX = getAttr('pivot.x', 0);
  const pivotY = getAttr('pivot.y', 0);

  const m = new DOMMatrix();
  m.translateSelf(pivotX, pivotY);
  m.scaleSelf(sx, sy);
  m.rotateSelf(rot);
  m.translateSelf(px, py);
  m.translateSelf(-pivotX, -pivotY);

  return m;
}

// ── Graph Evaluator ──

interface CompositeResult {
  canvas: HTMLCanvasElement;
  opacity: number;
}

/**
 * Render a composited frame by evaluating the scene graph.
 */
export async function renderCompositeFrame(
  graph: SceneGraph,
  frame: number,
  zip: JSZip,
  externalColors: ExternalPaletteColor[],
  canvasWidth: number,
  canvasHeight: number,
  onProgress?: (msg: string) => void,
): Promise<HTMLCanvasElement | null> {
  if (!graph.rootOutputId) return null;

  const progress = onProgress || (() => {});
  progress('Evaluating scene graph...');

  // Cache for loaded TVG drawings
  const tvgCache = new Map<string, HTMLCanvasElement | null>();
  const tvgFiles: string[] = [];
  zip.forEach((p: string) => { if (p.endsWith('.tvg')) tvgFiles.push(p); });

  // Find the prefix (top-level folder in ZIP)
  const prefix = tvgFiles.length > 0
    ? tvgFiles[0].substring(0, tvgFiles[0].indexOf('elements/'))
    : '';

  let loadCount = 0;

  async function loadTVG(elementId: number, drawingName: string): Promise<HTMLCanvasElement | null> {
    const element = graph.elements.get(elementId);
    if (!element) return null;

    const cacheKey = `${element.folder}/${drawingName}`;
    if (tvgCache.has(cacheKey)) return tvgCache.get(cacheKey)!;

    // Find TVG file
    const tvgPath = tvgFiles.find(p =>
      p.includes(`/${element.folder}/`) && p.includes(`${element.folder}-${drawingName}.tvg`)
    );
    if (!tvgPath) {
      tvgCache.set(cacheKey, null);
      return null;
    }

    try {
      const buffer = await zip.file(tvgPath)!.async('arraybuffer');
      const drawing = parseTVG(buffer);
      if (externalColors.length > 0) {
        resolveExternalPalette(drawing, externalColors);
      }

      const viewportSize = element.fieldChart * TVG_UNITS_PER_FIELD;
      const thumbSize = 200; // Element render size
      const canvas = renderTVGToCanvas(drawing, thumbSize, thumbSize, viewportSize);

      if (canvas && (canvas as any).__bitmapTiles) {
        await loadBitmapTiles(canvas);
      }

      tvgCache.set(cacheKey, canvas);
      loadCount++;
      if (loadCount % 10 === 0) progress(`Loaded ${loadCount} drawings...`);
      return canvas;
    } catch (_e) {
      tvgCache.set(cacheKey, null);
      return null;
    }
  }

  // Evaluate node recursively
  const evalCache = new Map<string, CompositeResult | null>();

  async function evaluateNode(nodeId: string): Promise<CompositeResult | null> {
    if (evalCache.has(nodeId)) return evalCache.get(nodeId)!;

    const node = graph.nodes.get(nodeId);
    if (!node) { evalCache.set(nodeId, null); return null; }

    let result: CompositeResult | null = null;

    switch (node.type) {
      case 'READ': {
        if (!node.drawingCol) break;
        const drawing = resolveDrawing(graph, node.drawingCol, frame);
        if (!drawing) break;
        const canvas = await loadTVG(drawing.elementId, drawing.drawingName);
        if (!canvas) break;
        result = { canvas, opacity: 1 };
        break;
      }

      case 'PEG': {
        // PEG passes through its single input with a transform applied
        const inputs = graph.inEdges.get(nodeId) || [];
        if (inputs.length === 0) break;
        result = await evaluateNode(inputs[0].sourceId);
        break;
      }

      case 'COMPOSITE':
      case 'MULTIPORT_OUT': {
        // Collect inputs by port number, composite in order
        const inputs = (graph.inEdges.get(nodeId) || []).slice();
        inputs.sort((a, b) => a.targetPort - b.targetPort);

        const layers: CompositeResult[] = [];
        for (const edge of inputs) {
          const layer = await evaluateNode(edge.sourceId);
          if (layer) layers.push(layer);
        }

        if (layers.length === 0) break;
        if (layers.length === 1) { result = layers[0]; break; }

        // Composite all layers
        const outCanvas = document.createElement('canvas');
        outCanvas.width = canvasWidth;
        outCanvas.height = canvasHeight;
        const outCtx = outCanvas.getContext('2d')!;

        for (const layer of layers) {
          outCtx.globalAlpha = layer.opacity;
          // Center the element canvas on the output canvas
          const dx = (canvasWidth - layer.canvas.width) / 2;
          const dy = (canvasHeight - layer.canvas.height) / 2;
          outCtx.drawImage(layer.canvas, dx, dy);
        }
        outCtx.globalAlpha = 1;
        result = { canvas: outCanvas, opacity: 1 };
        break;
      }

      case 'CUTTER': {
        // Port 0 = matte, Port 1 = subject
        const inputs = graph.inEdges.get(nodeId) || [];
        const matteEdge = inputs.find(e => e.targetPort === 0);
        const subjectEdge = inputs.find(e => e.targetPort === 1);

        if (!subjectEdge) break;
        const subject = await evaluateNode(subjectEdge.sourceId);
        if (!subject) break;

        if (!matteEdge) { result = subject; break; }
        const matte = await evaluateNode(matteEdge.sourceId);
        if (!matte) { result = subject; break; }

        // Apply matte as clip
        const outCanvas = document.createElement('canvas');
        outCanvas.width = subject.canvas.width;
        outCanvas.height = subject.canvas.height;
        const outCtx = outCanvas.getContext('2d')!;

        // Draw subject
        outCtx.drawImage(subject.canvas, 0, 0);
        // Apply matte
        outCtx.globalCompositeOperation = node.inverted ? 'destination-out' : 'destination-in';
        const dx = (outCanvas.width - matte.canvas.width) / 2;
        const dy = (outCanvas.height - matte.canvas.height) / 2;
        outCtx.drawImage(matte.canvas, dx, dy);
        outCtx.globalCompositeOperation = 'source-over';

        result = { canvas: outCanvas, opacity: subject.opacity };
        break;
      }

      case 'FADE': {
        const inputs = graph.inEdges.get(nodeId) || [];
        if (inputs.length === 0) break;
        result = await evaluateNode(inputs[0].sourceId);
        if (result) {
          const transparency = evaluateColumn(graph, node.attrs.get('transparency')?.col, frame,
            node.attrs.get('transparency')?.value ?? 100);
          result = { ...result, opacity: result.opacity * (transparency / 100) };
        }
        break;
      }

      case 'VISIBILITY': {
        const inputs = graph.inEdges.get(nodeId) || [];
        if (inputs.length === 0) break;
        // Check if visible
        const softRender = node.attrs.get('softrender');
        if (softRender && softRender.value === 0) break; // hidden
        result = await evaluateNode(inputs[0].sourceId);
        break;
      }

      case 'group': {
        // Find MULTIPORT_OUT inside this group
        const mpoId = `${nodeId}/Multi-Port-Out`;
        if (graph.nodes.has(mpoId)) {
          result = await evaluateNode(mpoId);
        }
        break;
      }

      default: {
        // Pass-through for unknown types (COLOR_ART, LINE_ART, etc.)
        const inputs = graph.inEdges.get(nodeId) || [];
        if (inputs.length > 0) {
          result = await evaluateNode(inputs[0].sourceId);
        }
        break;
      }
    }

    evalCache.set(nodeId, result);
    return result;
  }

  const finalResult = await evaluateNode(graph.rootOutputId);
  if (!finalResult) return null;

  progress(`Composited ${loadCount} drawings`);
  return finalResult.canvas;
}
