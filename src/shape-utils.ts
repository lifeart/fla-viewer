/**
 * Shape handling utilities for FLA Viewer
 *
 * Provides:
 * - Path area calculation for winding rule determination
 * - Fill side correction for inverted fill directions
 * - Shape fixer for auto-repairing broken shapes
 * - Duplicate edge removal
 */

import type { PathCommand, Edge, Shape, Point } from './types';

/**
 * Calculate the signed area of a path using the Shoelace formula.
 * Positive area = clockwise winding (in screen coordinates where Y points down)
 * Negative area = counter-clockwise winding
 *
 * This is used to determine fill direction and correct inverted shapes.
 */
export function calculatePathArea(commands: PathCommand[]): number {
  let area = 0;
  let startX = 0;
  let startY = 0;
  let currentX = 0;
  let currentY = 0;
  let subpathStartX = 0;
  let subpathStartY = 0;

  for (const cmd of commands) {
    switch (cmd.type) {
      case 'M':
        // Start new subpath
        subpathStartX = cmd.x;
        subpathStartY = cmd.y;
        currentX = cmd.x;
        currentY = cmd.y;
        if (startX === 0 && startY === 0) {
          startX = cmd.x;
          startY = cmd.y;
        }
        break;

      case 'L':
        // Line contribution: (x1 * y2 - x2 * y1) / 2
        area += (currentX * cmd.y - cmd.x * currentY);
        currentX = cmd.x;
        currentY = cmd.y;
        break;

      case 'Q':
        // Quadratic bezier: approximate with line segments for area calculation
        // Use parametric sampling with 4 segments
        for (let t = 0.25; t <= 1; t += 0.25) {
          const t2 = t * t;
          const mt = 1 - t;
          const mt2 = mt * mt;

          const x = mt2 * currentX + 2 * mt * t * cmd.cx + t2 * cmd.x;
          const y = mt2 * currentY + 2 * mt * t * cmd.cy + t2 * cmd.y;

          // Calculate previous point
          const prevT = t - 0.25;
          const prevT2 = prevT * prevT;
          const prevMt = 1 - prevT;
          const prevMt2 = prevMt * prevMt;
          const prevX = prevMt2 * currentX + 2 * prevMt * prevT * cmd.cx + prevT2 * cmd.x;
          const prevY = prevMt2 * currentY + 2 * prevMt * prevT * cmd.cy + prevT2 * cmd.y;

          area += (prevX * y - x * prevY);
        }
        currentX = cmd.x;
        currentY = cmd.y;
        break;

      case 'C':
        // Cubic bezier: approximate with line segments for area calculation
        // Use parametric sampling with 8 segments for better accuracy
        for (let t = 0.125; t <= 1; t += 0.125) {
          const t2 = t * t;
          const t3 = t2 * t;
          const mt = 1 - t;
          const mt2 = mt * mt;
          const mt3 = mt2 * mt;

          const x = mt3 * currentX + 3 * mt2 * t * cmd.c1x + 3 * mt * t2 * cmd.c2x + t3 * cmd.x;
          const y = mt3 * currentY + 3 * mt2 * t * cmd.c1y + 3 * mt * t2 * cmd.c2y + t3 * cmd.y;

          // Calculate previous point
          const prevT = t - 0.125;
          const prevT2 = prevT * prevT;
          const prevT3 = prevT2 * prevT;
          const prevMt = 1 - prevT;
          const prevMt2 = prevMt * prevMt;
          const prevMt3 = prevMt2 * prevMt;
          const prevX = prevMt3 * currentX + 3 * prevMt2 * prevT * cmd.c1x + 3 * prevMt * prevT2 * cmd.c2x + prevT3 * cmd.x;
          const prevY = prevMt3 * currentY + 3 * prevMt2 * prevT * cmd.c1y + 3 * prevMt * prevT2 * cmd.c2y + prevT3 * cmd.y;

          area += (prevX * y - x * prevY);
        }
        currentX = cmd.x;
        currentY = cmd.y;
        break;

      case 'Z':
        // Close path: add contribution from current point back to subpath start
        area += (currentX * subpathStartY - subpathStartX * currentY);
        currentX = subpathStartX;
        currentY = subpathStartY;
        break;
    }
  }

  // Divide by 2 to get actual area (Shoelace formula)
  return area / 2;
}

/**
 * Determine if a path has clockwise winding (in screen coordinates).
 * In screen coordinates (Y pointing down), clockwise = positive area.
 */
export function isClockwise(commands: PathCommand[]): boolean {
  return calculatePathArea(commands) > 0;
}

/**
 * Reverse the direction of path commands.
 * This is used to correct inverted fill directions.
 */
export function reversePathCommands(commands: PathCommand[]): PathCommand[] {
  if (commands.length === 0) return [];

  // Extract all points with their command types
  const points: { x: number; y: number; type: string; cx?: number; cy?: number; c1x?: number; c1y?: number; c2x?: number; c2y?: number }[] = [];

  for (const cmd of commands) {
    if (cmd.type === 'M' || cmd.type === 'L') {
      points.push({ x: cmd.x, y: cmd.y, type: cmd.type });
    } else if (cmd.type === 'Q') {
      points.push({ x: cmd.x, y: cmd.y, type: 'Q', cx: cmd.cx, cy: cmd.cy });
    } else if (cmd.type === 'C') {
      points.push({ x: cmd.x, y: cmd.y, type: 'C', c1x: cmd.c1x, c1y: cmd.c1y, c2x: cmd.c2x, c2y: cmd.c2y });
    }
    // Skip Z commands in point collection
  }

  if (points.length === 0) return [];

  const result: PathCommand[] = [];

  // Start with MoveTo at the last point
  const lastPoint = points[points.length - 1];
  result.push({ type: 'M', x: lastPoint.x, y: lastPoint.y });

  // Traverse points in reverse, creating appropriate commands
  for (let i = points.length - 1; i > 0; i--) {
    const current = points[i];
    const prev = points[i - 1];

    if (current.type === 'L' || current.type === 'M') {
      result.push({ type: 'L', x: prev.x, y: prev.y });
    } else if (current.type === 'Q' && current.cx !== undefined && current.cy !== undefined) {
      // For quadratic curves, the control point stays the same
      result.push({ type: 'Q', cx: current.cx, cy: current.cy, x: prev.x, y: prev.y });
    } else if (current.type === 'C' && current.c1x !== undefined) {
      // For cubic curves, swap control points
      result.push({
        type: 'C',
        c1x: current.c2x!,
        c1y: current.c2y!,
        c2x: current.c1x,
        c2y: current.c1y!,
        x: prev.x,
        y: prev.y
      });
    }
  }

  // Check if original path was closed
  const hadClose = commands.some(c => c.type === 'Z');
  if (hadClose) {
    result.push({ type: 'Z' });
  }

  return result;
}

/**
 * Fix inverted fill sides in edges.
 * When fillStyle0 and fillStyle1 are swapped, the fill appears on the wrong side.
 * This function detects and corrects such cases based on path area (winding).
 */
export function correctFillSides(edges: Edge[]): Edge[] {
  return edges.map(edge => {
    // Skip edges without fill styles or with only one fill
    if (edge.fillStyle0 === undefined && edge.fillStyle1 === undefined) {
      return edge;
    }

    // Calculate path area to determine winding
    const area = calculatePathArea(edge.commands);

    // If area is negative (counter-clockwise) and we have both fills,
    // they might need to be swapped
    if (area < 0 && edge.fillStyle0 !== undefined && edge.fillStyle1 !== undefined) {
      // Swap fill styles and reverse the path to maintain correct fill direction
      return {
        ...edge,
        fillStyle0: edge.fillStyle1,
        fillStyle1: edge.fillStyle0,
        commands: reversePathCommands(edge.commands)
      };
    }

    return edge;
  });
}

/**
 * Remove duplicate edges that have the same path but only differ in stroke.
 * Flash sometimes creates redundant edges for stroke rendering.
 */
export function removeDuplicateEdges(edges: Edge[]): Edge[] {
  const seen = new Map<string, Edge>();
  const EPSILON = 0.5;

  for (const edge of edges) {
    // Create a key based on path commands
    const key = edge.commands.map(cmd => {
      switch (cmd.type) {
        case 'M':
        case 'L':
          return `${cmd.type}${Math.round(cmd.x / EPSILON)},${Math.round(cmd.y / EPSILON)}`;
        case 'Q':
          return `Q${Math.round(cmd.cx / EPSILON)},${Math.round(cmd.cy / EPSILON)},${Math.round(cmd.x / EPSILON)},${Math.round(cmd.y / EPSILON)}`;
        case 'C':
          return `C${Math.round(cmd.c1x / EPSILON)},${Math.round(cmd.c1y / EPSILON)},${Math.round(cmd.c2x / EPSILON)},${Math.round(cmd.c2y / EPSILON)},${Math.round(cmd.x / EPSILON)},${Math.round(cmd.y / EPSILON)}`;
        case 'Z':
          return 'Z';
      }
    }).join('|');

    const existing = seen.get(key);
    if (existing) {
      // Merge fill and stroke styles
      const merged: Edge = {
        fillStyle0: existing.fillStyle0 ?? edge.fillStyle0,
        fillStyle1: existing.fillStyle1 ?? edge.fillStyle1,
        strokeStyle: existing.strokeStyle ?? edge.strokeStyle,
        commands: existing.commands
      };
      seen.set(key, merged);
    } else {
      seen.set(key, edge);
    }
  }

  return Array.from(seen.values());
}

/**
 * Check if two points are approximately equal within epsilon tolerance.
 */
function pointsEqual(p1: Point, p2: Point, epsilon: number = 0.5): boolean {
  return Math.abs(p1.x - p2.x) <= epsilon && Math.abs(p1.y - p2.y) <= epsilon;
}

/**
 * Get the start point of a path.
 */
function getPathStart(commands: PathCommand[]): Point | null {
  for (const cmd of commands) {
    if ('x' in cmd && Number.isFinite(cmd.x) && Number.isFinite(cmd.y)) {
      return { x: cmd.x, y: cmd.y };
    }
  }
  return null;
}

/**
 * Get the end point of a path.
 */
function getPathEnd(commands: PathCommand[]): Point | null {
  for (let i = commands.length - 1; i >= 0; i--) {
    const cmd = commands[i];
    if ('x' in cmd && Number.isFinite(cmd.x) && Number.isFinite(cmd.y)) {
      return { x: cmd.x, y: cmd.y };
    }
  }
  return null;
}

/**
 * Attempt to connect broken edge chains.
 * This helps repair shapes where edges don't quite meet up.
 */
export function connectBrokenChains(edges: Edge[], epsilon: number = 2.0): Edge[] {
  if (edges.length <= 1) return edges;

  const result: Edge[] = [];
  const used = new Set<number>();

  // Start with the first edge
  let currentChain: PathCommand[] = [...edges[0].commands];
  let currentEnd = getPathEnd(currentChain);
  let currentFillStyle0 = edges[0].fillStyle0;
  let currentFillStyle1 = edges[0].fillStyle1;
  let currentStrokeStyle = edges[0].strokeStyle;
  used.add(0);

  while (used.size < edges.length) {
    let found = false;

    // Look for an edge that starts where the current chain ends
    for (let i = 0; i < edges.length; i++) {
      if (used.has(i)) continue;

      const edge = edges[i];
      const start = getPathStart(edge.commands);
      const end = getPathEnd(edge.commands);

      if (!start || !end || !currentEnd) continue;

      // Check if this edge continues the chain
      if (pointsEqual(currentEnd, start, epsilon)) {
        // Append commands (skip initial MoveTo if it matches)
        const commandsToAdd = edge.commands.filter((cmd, idx) => {
          if (idx === 0 && cmd.type === 'M') {
            return false; // Skip redundant MoveTo
          }
          return true;
        });
        currentChain.push(...commandsToAdd);
        currentEnd = end;
        used.add(i);
        found = true;
        break;
      }

      // Check if this edge continues the chain in reverse
      if (pointsEqual(currentEnd, end, epsilon)) {
        const reversed = reversePathCommands(edge.commands);
        const commandsToAdd = reversed.filter((cmd, idx) => {
          if (idx === 0 && cmd.type === 'M') {
            return false;
          }
          return true;
        });
        currentChain.push(...commandsToAdd);
        currentEnd = start;
        used.add(i);
        found = true;
        break;
      }
    }

    if (!found) {
      // Save current chain and start a new one
      result.push({
        fillStyle0: currentFillStyle0,
        fillStyle1: currentFillStyle1,
        strokeStyle: currentStrokeStyle,
        commands: currentChain
      });

      // Find next unused edge to start new chain
      for (let i = 0; i < edges.length; i++) {
        if (!used.has(i)) {
          currentChain = [...edges[i].commands];
          currentEnd = getPathEnd(currentChain);
          currentFillStyle0 = edges[i].fillStyle0;
          currentFillStyle1 = edges[i].fillStyle1;
          currentStrokeStyle = edges[i].strokeStyle;
          used.add(i);
          break;
        }
      }
    }
  }

  // Don't forget the last chain
  if (currentChain.length > 0) {
    result.push({
      fillStyle0: currentFillStyle0,
      fillStyle1: currentFillStyle1,
      strokeStyle: currentStrokeStyle,
      commands: currentChain
    });
  }

  return result;
}

/**
 * Auto-close paths that nearly return to their start point.
 */
export function autoClosePaths(commands: PathCommand[], epsilon: number = 1.0): PathCommand[] {
  if (commands.length === 0) return commands;

  const result: PathCommand[] = [];
  let subpathStart: Point | null = null;
  let lastPoint: Point | null = null;

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    result.push(cmd);

    if (cmd.type === 'M') {
      // Close previous subpath if it nearly returns to start
      if (subpathStart && lastPoint && pointsEqual(lastPoint, subpathStart, epsilon)) {
        // Check if already closed
        const prevCmd = result[result.length - 2];
        if (prevCmd && prevCmd.type !== 'Z') {
          result.splice(result.length - 1, 0, { type: 'Z' });
        }
      }
      subpathStart = { x: cmd.x, y: cmd.y };
      lastPoint = { x: cmd.x, y: cmd.y };
    } else if ('x' in cmd && Number.isFinite(cmd.x)) {
      lastPoint = { x: cmd.x, y: cmd.y };
    } else if (cmd.type === 'Z') {
      subpathStart = null;
    }
  }

  // Check if final path should be closed
  if (subpathStart && lastPoint && pointsEqual(lastPoint, subpathStart, epsilon)) {
    const lastCmd = result[result.length - 1];
    if (lastCmd && lastCmd.type !== 'Z') {
      result.push({ type: 'Z' });
    }
  }

  return result;
}

/**
 * Comprehensive shape fixer that applies multiple repair strategies.
 */
export function fixShape(shape: Shape): Shape {
  let edges = [...shape.edges];

  // Step 1: Remove duplicate edges
  edges = removeDuplicateEdges(edges);

  // Step 2: Correct fill sides based on winding
  edges = correctFillSides(edges);

  // Step 3: Connect broken chains
  edges = connectBrokenChains(edges);

  // Step 4: Auto-close paths
  edges = edges.map(edge => ({
    ...edge,
    commands: autoClosePaths(edge.commands)
  }));

  return {
    ...shape,
    edges
  };
}

/**
 * Fix a morph shape by ensuring start and end shapes have matching structure.
 * This is used for shape tweens where the shapes must be compatible.
 */
export interface MorphShapeValidation {
  isValid: boolean;
  errors: string[];
}

export function validateMorphShape(startEdges: Edge[], endEdges: Edge[]): MorphShapeValidation {
  const errors: string[] = [];

  // Check edge count
  if (startEdges.length !== endEdges.length) {
    errors.push(`Edge count mismatch: start has ${startEdges.length}, end has ${endEdges.length}`);
  }

  // Check command counts for each edge pair
  const minLength = Math.min(startEdges.length, endEdges.length);
  for (let i = 0; i < minLength; i++) {
    const startCmds = startEdges[i].commands;
    const endCmds = endEdges[i].commands;

    if (startCmds.length !== endCmds.length) {
      errors.push(`Edge ${i} command count mismatch: start has ${startCmds.length}, end has ${endCmds.length}`);
    }

    // Check command types match
    const cmdMinLength = Math.min(startCmds.length, endCmds.length);
    for (let j = 0; j < cmdMinLength; j++) {
      if (startCmds[j].type !== endCmds[j].type) {
        errors.push(`Edge ${i} command ${j} type mismatch: start is ${startCmds[j].type}, end is ${endCmds[j].type}`);
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Attempt to make morph shapes compatible by adding intermediate points.
 */
export function normalizeMorphEdges(startEdges: Edge[], endEdges: Edge[]): { start: Edge[], end: Edge[] } {
  // For now, just return as-is. Full implementation would subdivide curves
  // to match command counts between start and end shapes.
  return { start: startEdges, end: endEdges };
}

/**
 * Calculate bounding box of path commands.
 */
export function calculatePathBounds(commands: PathCommand[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let hasPoints = false;

  let currentX = 0;
  let currentY = 0;

  for (const cmd of commands) {
    switch (cmd.type) {
      case 'M':
      case 'L':
        minX = Math.min(minX, cmd.x);
        minY = Math.min(minY, cmd.y);
        maxX = Math.max(maxX, cmd.x);
        maxY = Math.max(maxY, cmd.y);
        currentX = cmd.x;
        currentY = cmd.y;
        hasPoints = true;
        break;

      case 'Q':
        // Include control point in bounds
        minX = Math.min(minX, currentX, cmd.cx, cmd.x);
        minY = Math.min(minY, currentY, cmd.cy, cmd.y);
        maxX = Math.max(maxX, currentX, cmd.cx, cmd.x);
        maxY = Math.max(maxY, currentY, cmd.cy, cmd.y);
        currentX = cmd.x;
        currentY = cmd.y;
        hasPoints = true;
        break;

      case 'C':
        // Include all control points in bounds
        minX = Math.min(minX, currentX, cmd.c1x, cmd.c2x, cmd.x);
        minY = Math.min(minY, currentY, cmd.c1y, cmd.c2y, cmd.y);
        maxX = Math.max(maxX, currentX, cmd.c1x, cmd.c2x, cmd.x);
        maxY = Math.max(maxY, currentY, cmd.c1y, cmd.c2y, cmd.y);
        currentX = cmd.x;
        currentY = cmd.y;
        hasPoints = true;
        break;
    }
  }

  if (!hasPoints) return null;

  return { minX, minY, maxX, maxY };
}

/**
 * Calculate bounding box of an entire shape.
 */
export function calculateShapeBounds(shape: Shape): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let hasPoints = false;

  for (const edge of shape.edges) {
    const bounds = calculatePathBounds(edge.commands);
    if (bounds) {
      minX = Math.min(minX, bounds.minX);
      minY = Math.min(minY, bounds.minY);
      maxX = Math.max(maxX, bounds.maxX);
      maxY = Math.max(maxY, bounds.maxY);
      hasPoints = true;
    }
  }

  if (!hasPoints) return null;

  return { minX, minY, maxX, maxY };
}
