// Deep debug of a specific shape to understand the triangle hole issue
import * as fs from 'fs';
import { decodeEdges } from './edge-decoder';
import type { PathCommand } from './types';

const EPSILON = 1.0;

interface EdgeData {
  index: number;
  fillStyle0?: number;
  fillStyle1?: number;
  commands: PathCommand[];
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  rawData: string;
}

function getPoint(commands: PathCommand[], first: boolean): { x: number; y: number } | null {
  const list = first ? commands : [...commands].reverse();
  for (const cmd of list) {
    if ('x' in cmd && Number.isFinite(cmd.x) && Number.isFinite(cmd.y)) {
      return { x: cmd.x, y: cmd.y };
    }
  }
  return null;
}

function parseShape(shapeXml: string): EdgeData[] {
  const edges: EdgeData[] = [];
  const edgeRegex = /<Edge\s+([^>]*)(?:\/>|>[^<]*<\/Edge>)/g;
  let match;
  let index = 0;

  while ((match = edgeRegex.exec(shapeXml)) !== null) {
    const attrs = match[1];
    const fillStyle0Match = attrs.match(/fillStyle0="(\d+)"/);
    const fillStyle1Match = attrs.match(/fillStyle1="(\d+)"/);
    const edgesMatch = attrs.match(/edges="([^"]*)"/);
    const cubicsMatch = attrs.match(/cubics="([^"]*)"/);

    const rawData = cubicsMatch?.[1] || edgesMatch?.[1] || '';
    if (!rawData) { index++; continue; }

    const commands = decodeEdges(rawData);
    const start = getPoint(commands, true);
    const end = getPoint(commands, false);
    if (!start || !end) { index++; continue; }

    edges.push({
      index,
      fillStyle0: fillStyle0Match ? parseInt(fillStyle0Match[1]) : undefined,
      fillStyle1: fillStyle1Match ? parseInt(fillStyle1Match[1]) : undefined,
      commands,
      startX: start.x,
      startY: start.y,
      endX: end.x,
      endY: end.y,
      rawData
    });
    index++;
  }
  return edges;
}

function simulatePathBuilding(edges: EdgeData[], targetFill: number): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`SIMULATING PATH BUILDING FOR FILL STYLE ${targetFill}`);
  console.log('='.repeat(60));

  // Collect contributions
  type Contrib = { edge: EdgeData; startX: number; startY: number; endX: number; endY: number; reversed: boolean };
  const contributions: Contrib[] = [];

  for (const edge of edges) {
    if (edge.fillStyle1 === targetFill) {
      contributions.push({
        edge,
        startX: edge.startX,
        startY: edge.startY,
        endX: edge.endX,
        endY: edge.endY,
        reversed: false
      });
    }
    if (edge.fillStyle0 === targetFill && edge.fillStyle0 !== edge.fillStyle1) {
      contributions.push({
        edge,
        startX: edge.endX,
        startY: edge.endY,
        endX: edge.startX,
        endY: edge.startY,
        reversed: true
      });
    }
  }

  console.log(`\nContributions: ${contributions.length}`);
  for (let i = 0; i < contributions.length; i++) {
    const c = contributions[i];
    console.log(`  [${i}] Edge ${c.edge.index} ${c.reversed ? '(REV)' : '     '}: (${c.startX.toFixed(1)}, ${c.startY.toFixed(1)}) -> (${c.endX.toFixed(1)}, ${c.endY.toFixed(1)})`);
  }

  // Sort contributions (same algorithm as renderer)
  console.log(`\nSorting into chains...`);
  const sorted: Contrib[] = [];
  const used = new Set<number>();

  if (contributions.length > 0) {
    let current = contributions[0];
    sorted.push(current);
    used.add(0);

    while (used.size < contributions.length) {
      let bestIdx = -1;
      let bestDist = Infinity;

      for (let i = 0; i < contributions.length; i++) {
        if (used.has(i)) continue;
        const candidate = contributions[i];
        const dx = Math.abs(candidate.startX - current.endX);
        const dy = Math.abs(candidate.startY - current.endY);
        const dist = dx + dy;

        if (dx <= EPSILON && dy <= EPSILON && dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }

      if (bestIdx >= 0) {
        current = contributions[bestIdx];
        sorted.push(current);
        used.add(bestIdx);
      } else {
        // Start new chain
        for (let i = 0; i < contributions.length; i++) {
          if (!used.has(i)) {
            current = contributions[i];
            sorted.push(current);
            used.add(i);
            break;
          }
        }
      }
    }
  }

  // Simulate path operations
  console.log(`\nPath operations:`);
  let currentX = NaN;
  let currentY = NaN;
  let subpathStartX = NaN;
  let subpathStartY = NaN;
  let chainNum = 0;

  for (let i = 0; i < sorted.length; i++) {
    const contrib = sorted[i];
    const isNewSubpath = Number.isNaN(currentX) ||
        Math.abs(contrib.startX - currentX) > EPSILON ||
        Math.abs(contrib.startY - currentY) > EPSILON;

    if (isNewSubpath && !Number.isNaN(subpathStartX)) {
      const atStart = Math.abs(currentX - subpathStartX) <= EPSILON &&
                      Math.abs(currentY - subpathStartY) <= EPSILON;
      if (!atStart) {
        const gapDist = Math.sqrt(Math.pow(currentX - subpathStartX, 2) + Math.pow(currentY - subpathStartY, 2));
        console.log(`  lineTo(${subpathStartX.toFixed(1)}, ${subpathStartY.toFixed(1)}) // close gap of ${gapDist.toFixed(1)}px`);
      }
      console.log(`  closePath() // end chain ${chainNum}`);
      chainNum++;
    }

    if (isNewSubpath) {
      console.log(`  --- CHAIN ${chainNum} ---`);
      console.log(`  moveTo(${contrib.startX.toFixed(1)}, ${contrib.startY.toFixed(1)})`);
      subpathStartX = contrib.startX;
      subpathStartY = contrib.startY;
    }

    // Show what this contribution adds
    const cmdTypes = contrib.edge.commands.filter(c => c.type !== 'M').map(c => c.type).join(',');
    console.log(`  // Edge ${contrib.edge.index}${contrib.reversed ? ' REV' : ''}: ${cmdTypes} -> (${contrib.endX.toFixed(1)}, ${contrib.endY.toFixed(1)})`);

    currentX = contrib.endX;
    currentY = contrib.endY;
  }

  // Final close
  if (!Number.isNaN(subpathStartX)) {
    const atStart = Math.abs(currentX - subpathStartX) <= EPSILON &&
                    Math.abs(currentY - subpathStartY) <= EPSILON;
    if (!atStart) {
      const gapDist = Math.sqrt(Math.pow(currentX - subpathStartX, 2) + Math.pow(currentY - subpathStartY, 2));
      console.log(`  lineTo(${subpathStartX.toFixed(1)}, ${subpathStartY.toFixed(1)}) // close gap of ${gapDist.toFixed(1)}px`);
    }
    console.log(`  closePath() // end chain ${chainNum}`);
  }

  // Check for issues
  console.log(`\nAnalysis:`);

  // Find all unique start/end points
  const points = new Map<string, { x: number, y: number, asStart: number, asEnd: number }>();
  for (const c of contributions) {
    const startKey = `${c.startX.toFixed(1)},${c.startY.toFixed(1)}`;
    const endKey = `${c.endX.toFixed(1)},${c.endY.toFixed(1)}`;

    if (!points.has(startKey)) {
      points.set(startKey, { x: c.startX, y: c.startY, asStart: 0, asEnd: 0 });
    }
    points.get(startKey)!.asStart++;

    if (!points.has(endKey)) {
      points.set(endKey, { x: c.endX, y: c.endY, asStart: 0, asEnd: 0 });
    }
    points.get(endKey)!.asEnd++;
  }

  // Find unbalanced points (should have equal starts and ends for closed paths)
  const unbalanced: string[] = [];
  for (const [, point] of points) {
    if (point.asStart !== point.asEnd) {
      unbalanced.push(`  (${point.x.toFixed(1)}, ${point.y.toFixed(1)}): ${point.asStart} starts, ${point.asEnd} ends`);
    }
  }

  if (unbalanced.length > 0) {
    console.log(`UNBALANCED POINTS (indicates missing edges):`);
    for (const u of unbalanced) console.log(u);
  } else {
    console.log(`All points balanced - edges form complete loops`);
  }
}

// Load and analyze Symbol 25.xml Shape 0
const content = fs.readFileSync('./sample/extracted/LIBRARY/Symbol 25.xml', 'utf-8');

// Find first DOMShape
const shapeMatch = content.match(/<DOMShape[^>]*>([\s\S]*?)<\/DOMShape>/);
if (shapeMatch) {
  console.log('Analyzing Symbol 25.xml - First Shape');
  const edges = parseShape(shapeMatch[0]);

  console.log(`\nTotal edges: ${edges.length}`);
  console.log('\nAll edges:');
  for (const e of edges) {
    const cmdTypes = e.commands.map(c => c.type).join(',');
    console.log(`  Edge ${e.index}: fill0=${e.fillStyle0 ?? '-'} fill1=${e.fillStyle1 ?? '-'} | (${e.startX.toFixed(1)}, ${e.startY.toFixed(1)}) -> (${e.endX.toFixed(1)}, ${e.endY.toFixed(1)}) | ${cmdTypes}`);
  }

  // Find all fill styles
  const fills = new Set<number>();
  for (const e of edges) {
    if (e.fillStyle0 !== undefined) fills.add(e.fillStyle0);
    if (e.fillStyle1 !== undefined) fills.add(e.fillStyle1);
  }

  for (const fill of fills) {
    simulatePathBuilding(edges, fill);
  }
}
