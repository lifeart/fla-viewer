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
  /** Field chart dimensions from <metrics> element */
  fieldX: number;
  fieldY: number;
  /** Unit aspect ratio from <metrics> (unitAspectRatioX / unitAspectRatioY) */
  unitAspectRatio: number;
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
  // Parse <metrics> for field chart dimensions and unit aspect ratio
  const metricsEl = xmlDoc.querySelector('metrics');
  const fieldX = parseFloat(metricsEl?.getAttribute('numberOfUnitsX') || '24') || 24;
  const fieldY = parseFloat(metricsEl?.getAttribute('numberOfUnitsY') || '24') || 24;
  const unitAspectRatioX = parseFloat(metricsEl?.getAttribute('unitAspectRatioX') || '4') || 4;
  const unitAspectRatioY = parseFloat(metricsEl?.getAttribute('unitAspectRatioY') || '3') || 3;
  const unitAspectRatio = unitAspectRatioX / unitAspectRatioY;

  const graph: SceneGraph = {
    nodes: new Map(),
    inEdges: new Map(),
    drawingColumns: new Map(),
    functionColumns: new Map(),
    elements: new Map(elements.map(e => [e.id, e])),
    rootOutputId: null,
    fieldX,
    fieldY,
    unitAspectRatio,
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

  // Extract transform attributes from nested XML structure
  const attrsEl = moduleEl.querySelector(':scope > attrs');
  if (attrsEl) {
    // Parse nested transform groups: offset/position, scale, rotation, pivot
    for (const groupName of ['offset', 'position', 'scale', 'rotation', 'pivot', 'splineOffset']) {
      const groupEl = attrsEl.querySelector(`:scope > ${groupName}`);
      if (groupEl) {
        for (const child of Array.from(groupEl.children)) {
          const childName = child.tagName;
          if (childName === 'separate' || childName === 'inFields') continue;
          const val = parseFloat(child.getAttribute('val') || '0');
          const col = child.getAttribute('col') || undefined;
          node.attrs.set(`${groupName}.${childName}`, { value: isNaN(val) ? 0 : val, col });
        }
      }
    }
    // Parse flat attributes: angle, skew, depth, transparency, etc.
    for (const flatName of ['angle', 'skew', 'depth', 'transparency', 'softrender', 'inverted']) {
      const el = attrsEl.querySelector(`:scope > ${flatName}`);
      if (el) {
        const val = parseFloat(el.getAttribute('val') || '0');
        const col = el.getAttribute('col') || undefined;
        node.attrs.set(flatName, { value: isNaN(val) ? 0 : val, col });
      }
    }
  }

  // CUTTER inverted
  if (moduleType === 'CUTTER') {
    const invAttr = node.attrs.get('inverted');
    node.inverted = invAttr ? invAttr.value !== 0 : false;
  }

  graph.nodes.set(nodeId, node);

  // Track MULTIPORT_OUT as potential root output (at top-level scope)
  if ((moduleType === 'MULTIPORT_OUT' || moduleType === 'WRITE' || moduleType === 'DISPLAY') &&
      groupPath.split('/').length <= 2) {
    // Prefer MULTIPORT_OUT at the shallowest level
    if (!graph.rootOutputId || groupPath.split('/').length < (graph.nodes.get(graph.rootOutputId)?.groupPath.split('/').length ?? 999)) {
      graph.rootOutputId = nodeId;
    }
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
    // Cubic ease interpolation (smooth bezier with control points at 1/3 and 2/3)
    // Uses Hermite-style cubic: 3t^2 - 2t^3 for smooth ease-in/ease-out
    const t = (frame - before.frame) / (after.frame - before.frame);
    const smoothT = 3 * t * t - 2 * t * t * t;
    return before.value + (after.value - before.value) * smoothT;
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

/**
 * Build a transform matrix from a PEG/READ node's attributes.
 * Position values are in FIELD UNITS and are converted to pixel space using
 * the project's field chart dimensions and canvas size.
 * Y is flipped (TVG Y-up → Canvas Y-down).
 */
function buildTransformMatrix(
  node: SceneNode, graph: SceneGraph, frame: number,
  canvasWidth: number, canvasHeight: number,
  fieldX: number, fieldY: number,
): DOMMatrix {
  const getAttr = (name: string, def: number) => {
    const attr = node.attrs.get(name);
    if (!attr) return def;
    return evaluateColumn(graph, attr.col, frame, attr.value);
  };

  // Position: try "position" first (PEG), then "offset" (READ)
  const px = getAttr('position.x', 0) || getAttr('offset.x', 0);
  const py = getAttr('position.y', 0) || getAttr('offset.y', 0);
  const sx = getAttr('scale.x', 1);
  const sy = getAttr('scale.y', 1);
  // Rotation: try "rotation.anglez" first (PEG/READ), then "angle" (legacy)
  const rot = getAttr('rotation.anglez', 0) || getAttr('angle', 0);
  const skew = getAttr('skew', 0);
  const pivotX = getAttr('pivot.x', 0);
  const pivotY = getAttr('pivot.y', 0);

  // Convert field units to pixels.
  // The TVG renderer uses scale = min(canvasW, canvasH) / viewportSize where
  // viewportSize = fieldY * TVG_UNITS_PER_FIELD. One field = TVG_UNITS_PER_FIELD TVG units.
  // So pixels per field = TVG_UNITS_PER_FIELD * min(canvasW, canvasH) / (fieldY * TVG_UNITS_PER_FIELD)
  //                     = min(canvasW, canvasH) / fieldY
  const pixelsPerField = Math.min(canvasWidth, canvasHeight) / fieldY;
  const pixelX = px * pixelsPerField;
  const pixelY = -py * pixelsPerField; // Y-flip: TVG Y-up → Canvas Y-down
  const pivotPxX = pivotX * pixelsPerField;
  const pivotPxY = -pivotY * pixelsPerField;

  // Build transform: translate to pivot → scale → rotate → skew → translate by pos → translate back from pivot
  const m = new DOMMatrix();
  m.translateSelf(pivotPxX, pivotPxY);
  if (sx !== 1 || sy !== 1) m.scaleSelf(sx, sy);
  if (rot !== 0) m.rotateSelf(-rot); // negate rotation for Y-flip
  if (skew !== 0) m.skewXSelf(skew);
  m.translateSelf(pixelX, pixelY);
  m.translateSelf(-pivotPxX, -pivotPxY);

  return m;
}

// ── Graph Evaluator ──

interface CompositeResult {
  canvas: HTMLCanvasElement;
  opacity: number;
  /** Accumulated transform from PEG chain (field units, not yet converted to pixels) */
  transform?: DOMMatrix;
  /** Art layer filter for selective rendering (used by COLOR_ART / LINE_ART) */
  artLayerFilter?: 'all' | 'color' | 'line' | 'overlay';
  /** Source READ node ID, for re-rendering with a different art layer filter */
  sourceReadNodeId?: string;
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
  if (!graph.rootOutputId) {
    console.warn('[Compositor] No root output node found');
    return null;
  }

  const progress = onProgress || (() => {});
  progress('Evaluating scene graph...');
  console.log(`[Compositor] Root: ${graph.rootOutputId}, Nodes: ${graph.nodes.size}, Drawing cols: ${graph.drawingColumns.size}, Field: ${graph.fieldX}x${graph.fieldY}, Canvas: ${canvasWidth}x${canvasHeight}`);

  // Element render size: proportional to output canvas based on the element's field chart
  // relative to the project's field chart. A 12-field element on a 24-field project should
  // occupy roughly half the canvas width, not the entire canvas.
  // We compute the render size per-element inside loadTVG.

  // Cache for loaded TVG drawings
  const tvgCache = new Map<string, HTMLCanvasElement | null>();
  const tvgFiles: string[] = [];
  zip.forEach((p: string) => { if (p.endsWith('.tvg')) tvgFiles.push(p); });

  let loadCount = 0;

  async function loadTVG(
    elementId: number, drawingName: string,
    artLayerFilter?: 'all' | 'color' | 'line' | 'overlay',
  ): Promise<HTMLCanvasElement | null> {
    const element = graph.elements.get(elementId);
    if (!element) return null;

    const filterSuffix = artLayerFilter && artLayerFilter !== 'all' ? `:${artLayerFilter}` : '';
    const cacheKey = `${element.folder}/${drawingName}${filterSuffix}`;
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

      // Use a large viewport to contain all character content.
      // Elements can be far from origin (e.g., Y=-1600 for feet), so the viewport
      // must cover the full character extent, not just the field chart.
      // Use 4x the field chart to ensure all body parts are visible.
      const viewportSize = graph.fieldY * TVG_UNITS_PER_FIELD * 4;
      const renderOpts: { artLayerFilter?: 'all' | 'color' | 'line' | 'overlay'; centerOnOrigin: boolean; includeUnderlay: boolean } = {
        centerOnOrigin: true,
        includeUnderlay: false, // Compositor uses underlay as CUTTER clip mask, not visible content
      };
      if (artLayerFilter) renderOpts.artLayerFilter = artLayerFilter;
      const canvas = renderTVGToCanvas(drawing, canvasWidth, canvasHeight, viewportSize, renderOpts);

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

  // Evaluate node recursively with cycle detection
  const evalCache = new Map<string, CompositeResult | null>();
  const inProgress = new Set<string>(); // cycle detection

  async function evaluateNode(nodeId: string, depth = 0): Promise<CompositeResult | null> {
    if (evalCache.has(nodeId)) return evalCache.get(nodeId)!;
    if (inProgress.has(nodeId) || depth > 50) {
      // Cycle or too deep
      evalCache.set(nodeId, null);
      return null;
    }
    inProgress.add(nodeId);

    const node = graph.nodes.get(nodeId);
    if (!node) {
      if (depth < 5) console.warn(`[Compositor] Node not found: ${nodeId}`);
      evalCache.set(nodeId, null); inProgress.delete(nodeId); return null;
    }

    let result: CompositeResult | null = null;

    switch (node.type) {
      case 'READ': {
        if (!node.drawingCol) { if (depth < 5) console.warn(`[Compositor] READ ${node.name}: no drawingCol`); break; }
        const drawing = resolveDrawing(graph, node.drawingCol, frame);
        if (!drawing) { if (depth < 5) console.warn(`[Compositor] READ ${node.name}: no exposure for frame ${frame}`); break; }
        const canvas = await loadTVG(drawing.elementId, drawing.drawingName);
        if (!canvas) { if (depth < 5) console.warn(`[Compositor] READ ${node.name}: TVG load failed for ${drawing.drawingName}`); break; }
        result = { canvas, opacity: 1, sourceReadNodeId: nodeId };
        break;
      }

      case 'PEG': {
        // PEG accumulates a transform on the CompositeResult.
        // The actual pixel-space rendering happens in COMPOSITE nodes.
        const inputs = graph.inEdges.get(nodeId) || [];
        if (inputs.length === 0) break;
        const child = await evaluateNode(inputs[0].sourceId, depth + 1);
        if (!child) break;

        // Build this PEG's transform (already in pixel space)
        const pegTransform = buildTransformMatrix(node, graph, frame,
          canvasWidth, canvasHeight, graph.fieldX, graph.fieldY);

        // Accumulate with child's existing transform
        const childTransform = child.transform || new DOMMatrix();
        const accumulated = pegTransform.multiply(childTransform);

        result = {
          ...child,
          transform: accumulated,
        };
        break;
      }

      case 'COMPOSITE':
      case 'MULTIPORT_OUT': {
        // Collect inputs by port number, composite in order
        const inputs = (graph.inEdges.get(nodeId) || []).slice();
        inputs.sort((a, b) => a.targetPort - b.targetPort);

        const layers: CompositeResult[] = [];
        for (const edge of inputs) {
          const layer = await evaluateNode(edge.sourceId, depth + 1);
          if (layer) layers.push(layer);
        }

        if (layers.length === 0) break;
        if (layers.length === 1) { result = layers[0]; break; }

        // Composite all layers, applying accumulated transforms
        const outCanvas = document.createElement('canvas');
        outCanvas.width = canvasWidth;
        outCanvas.height = canvasHeight;
        const outCtx = outCanvas.getContext('2d')!;

        for (const layer of layers) {
          outCtx.save();
          outCtx.globalAlpha = layer.opacity;

          // Center the element canvas on the output canvas
          const dx = (canvasWidth - layer.canvas.width) / 2;
          const dy = (canvasHeight - layer.canvas.height) / 2;

          if (layer.transform) {
            // Apply accumulated PEG transform around the canvas center
            outCtx.translate(canvasWidth / 2, canvasHeight / 2);
            const t = layer.transform;
            outCtx.transform(t.a, t.b, t.c, t.d, t.e, t.f);
            outCtx.translate(-canvasWidth / 2, -canvasHeight / 2);
            outCtx.drawImage(layer.canvas, dx, dy);
          } else {
            outCtx.drawImage(layer.canvas, dx, dy);
          }
          outCtx.restore();
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
        const subject = await evaluateNode(subjectEdge.sourceId, depth + 1);
        if (!subject) break;

        if (!matteEdge) { result = subject; break; }
        const matte = await evaluateNode(matteEdge.sourceId, depth + 1);
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
        result = await evaluateNode(inputs[0].sourceId, depth + 1);
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
        // In Toon Boom, VISIBILITY has oglrender (preview) and softrender (render).
        // We use oglrender for visibility. Both parsed from "true"/"false" strings where
        // "true" -> NaN -> 0, "false" -> NaN -> 0. We need the raw XML value.
        // Since parseFloat("true") and parseFloat("false") both give NaN -> 0,
        // and the column name is what really drives animated visibility,
        // we default to visible (pass through) unless a column explicitly says hidden.
        // For now, always pass through - animated visibility requires column evaluation.
        result = await evaluateNode(inputs[0].sourceId, depth + 1);
        break;
      }

      case 'group': {
        // Find MULTIPORT_OUT inside this group (can be named "Multi-Port-Out" or "GroupOUT")
        for (const mpoName of ['Multi-Port-Out', 'GroupOUT']) {
          const mpoId = `${nodeId}/${mpoName}`;
          if (graph.nodes.has(mpoId)) {
            result = await evaluateNode(mpoId, depth + 1);
            break;
          }
        }
        break;
      }

      case 'MULTIPORT_IN': {
        // MULTIPORT_IN receives inputs from OUTSIDE the group.
        // Look for edges pointing to the parent group from the parent's scope.
        const parentGroupId = node.groupPath;
        const parentInputs = graph.inEdges.get(parentGroupId) || [];
        if (parentInputs.length > 0) {
          // Sort by port and try to composite if multiple inputs
          const sorted = parentInputs.slice().sort((a, b) => a.targetPort - b.targetPort);
          if (sorted.length === 1) {
            result = await evaluateNode(sorted[0].sourceId, depth + 1);
          } else {
            // Multiple inputs to the group - composite them
            const layers: CompositeResult[] = [];
            for (const edge of sorted) {
              const layer = await evaluateNode(edge.sourceId, depth + 1);
              if (layer) layers.push(layer);
            }
            if (layers.length === 1) result = layers[0];
            else if (layers.length > 1) {
              const outCanvas = document.createElement('canvas');
              outCanvas.width = canvasWidth;
              outCanvas.height = canvasHeight;
              const outCtx = outCanvas.getContext('2d')!;
              for (const layer of layers) {
                outCtx.save();
                outCtx.globalAlpha = layer.opacity;
                const dx = (canvasWidth - layer.canvas.width) / 2;
                const dy = (canvasHeight - layer.canvas.height) / 2;
                if (layer.transform) {
                  outCtx.translate(canvasWidth / 2, canvasHeight / 2);
                  const t = layer.transform;
                  outCtx.transform(t.a, t.b, t.c, t.d, t.e, t.f);
                  outCtx.translate(-canvasWidth / 2, -canvasHeight / 2);
                  outCtx.drawImage(layer.canvas, dx, dy);
                } else {
                  outCtx.drawImage(layer.canvas, dx, dy);
                }
                outCtx.restore();
              }
              outCtx.globalAlpha = 1;
              result = { canvas: outCanvas, opacity: 1 };
            }
          }
        }
        break;
      }

      case 'COLOR_ART': {
        // COLOR_ART filters the input READ to only color art (tCAA).
        // Trace back to the source READ node and re-render with artLayerFilter='color'.
        const inputs = graph.inEdges.get(nodeId) || [];
        if (inputs.length === 0) break;
        const child = await evaluateNode(inputs[0].sourceId, depth + 1);
        if (!child) break;

        if (child.sourceReadNodeId) {
          // Re-render the source READ node's TVG with color-art-only filter
          const readNode = graph.nodes.get(child.sourceReadNodeId);
          if (readNode?.drawingCol) {
            const drawing = resolveDrawing(graph, readNode.drawingCol, frame);
            if (drawing) {
              const colorCanvas = await loadTVG(drawing.elementId, drawing.drawingName, 'color');
              if (colorCanvas) {
                result = { canvas: colorCanvas, opacity: child.opacity, artLayerFilter: 'color',
                  sourceReadNodeId: child.sourceReadNodeId, transform: child.transform };
                break;
              }
            }
          }
        }
        // Fallback: pass through
        result = child;
        break;
      }

      case 'LINE_ART': {
        // LINE_ART filters the input READ to only line art (tLAA).
        const inputs = graph.inEdges.get(nodeId) || [];
        if (inputs.length === 0) break;
        const child = await evaluateNode(inputs[0].sourceId, depth + 1);
        if (!child) break;

        if (child.sourceReadNodeId) {
          const readNode = graph.nodes.get(child.sourceReadNodeId);
          if (readNode?.drawingCol) {
            const drawing = resolveDrawing(graph, readNode.drawingCol, frame);
            if (drawing) {
              const lineCanvas = await loadTVG(drawing.elementId, drawing.drawingName, 'line');
              if (lineCanvas) {
                result = { canvas: lineCanvas, opacity: child.opacity, artLayerFilter: 'line',
                  sourceReadNodeId: child.sourceReadNodeId, transform: child.transform };
                break;
              }
            }
          }
        }
        // Fallback: pass through
        result = child;
        break;
      }

      case 'COLOR_CARD': {
        // Solid color background card - no inputs.
        // COLOR_CARD stores color as nested XML children which our parser doesn't capture.
        // Skip for now - the white background is the default canvas clear color anyway.
        break;
      }

      default: {
        // Pass-through for unknown types (AUTO_PATCH, OVERLAY_ART, etc.)
        const inputs = graph.inEdges.get(nodeId) || [];
        if (inputs.length > 0) {
          result = await evaluateNode(inputs[0].sourceId, depth + 1);
        }
        break;
      }
    }

    inProgress.delete(nodeId);
    evalCache.set(nodeId, result);
    return result;
  }

  const finalResult = await evaluateNode(graph.rootOutputId);
  if (!finalResult) {
    console.warn(`[Compositor] No result from root node ${graph.rootOutputId}`);
    return null;
  }

  // If the final result still has a pending transform (e.g., root node was a single-layer
  // pass-through), apply it now onto the output canvas.
  let outputCanvas = finalResult.canvas;
  if (finalResult.transform || outputCanvas.width !== canvasWidth || outputCanvas.height !== canvasHeight) {
    const outCanvas = document.createElement('canvas');
    outCanvas.width = canvasWidth;
    outCanvas.height = canvasHeight;
    const outCtx = outCanvas.getContext('2d')!;

    outCtx.save();
    outCtx.globalAlpha = finalResult.opacity;

    const dx = (canvasWidth - outputCanvas.width) / 2;
    const dy = (canvasHeight - outputCanvas.height) / 2;

    if (finalResult.transform) {
      outCtx.translate(canvasWidth / 2, canvasHeight / 2);
      const t = finalResult.transform;
      outCtx.transform(t.a, t.b, t.c, t.d, t.e, t.f);
      outCtx.translate(-canvasWidth / 2, -canvasHeight / 2);
    }
    outCtx.drawImage(outputCanvas, dx, dy);
    outCtx.restore();
    outputCanvas = outCanvas;
  }

  console.log(`[Compositor] Success: loaded ${loadCount} drawings, output ${outputCanvas.width}x${outputCanvas.height}`);
  progress(`Composited ${loadCount} drawings`);
  return outputCanvas;
}
