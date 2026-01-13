// Analyze actual XML files to find edge issues
import * as fs from 'fs';
import * as path from 'path';
import { decodeEdges } from './edge-decoder';
import type { PathCommand } from './types';

const EPSILON = 1.0;

interface EdgeInfo {
  index: number;
  fillStyle0?: number;
  fillStyle1?: number;
  strokeStyle?: number;
  commands: PathCommand[];
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  rawDataPreview: string;
}

interface FillAnalysis {
  fillStyle: number;
  edges: EdgeInfo[];
  connectedChains: number;
  closedLoops: number;
  unclosedGaps: { from: {x: number, y: number}, to: {x: number, y: number}, distance: number }[];
}

function getFirstPoint(commands: PathCommand[]): { x: number; y: number } | null {
  for (const cmd of commands) {
    if ('x' in cmd && Number.isFinite(cmd.x) && Number.isFinite(cmd.y)) {
      return { x: cmd.x, y: cmd.y };
    }
  }
  return null;
}

function getLastPoint(commands: PathCommand[]): { x: number; y: number } | null {
  for (let i = commands.length - 1; i >= 0; i--) {
    const cmd = commands[i];
    if ('x' in cmd && Number.isFinite(cmd.x) && Number.isFinite(cmd.y)) {
      return { x: cmd.x, y: cmd.y };
    }
  }
  return null;
}

function parseEdgesFromXml(xmlContent: string): EdgeInfo[] {
  const edges: EdgeInfo[] = [];

  // Match Edge elements - handle both self-closing and content
  const edgeRegex = /<Edge\s+([^>]*)(?:\/>|>[^<]*<\/Edge>)/g;
  let match;
  let index = 0;

  while ((match = edgeRegex.exec(xmlContent)) !== null) {
    const attrs = match[1];

    const fillStyle0Match = attrs.match(/fillStyle0="(\d+)"/);
    const fillStyle1Match = attrs.match(/fillStyle1="(\d+)"/);
    const strokeStyleMatch = attrs.match(/strokeStyle="(\d+)"/);
    const edgesMatch = attrs.match(/edges="([^"]*)"/);
    const cubicsMatch = attrs.match(/cubics="([^"]*)"/);

    const rawData = cubicsMatch?.[1] || edgesMatch?.[1] || '';
    if (!rawData) {
      index++;
      continue;
    }

    const commands = decodeEdges(rawData);
    if (commands.length === 0) {
      index++;
      continue;
    }

    const startPoint = getFirstPoint(commands);
    const endPoint = getLastPoint(commands);

    if (!startPoint || !endPoint) {
      index++;
      continue;
    }

    edges.push({
      index,
      fillStyle0: fillStyle0Match ? parseInt(fillStyle0Match[1]) : undefined,
      fillStyle1: fillStyle1Match ? parseInt(fillStyle1Match[1]) : undefined,
      strokeStyle: strokeStyleMatch ? parseInt(strokeStyleMatch[1]) : undefined,
      commands,
      startX: startPoint.x,
      startY: startPoint.y,
      endX: endPoint.x,
      endY: endPoint.y,
      rawDataPreview: rawData.substring(0, 50) + (rawData.length > 50 ? '...' : '')
    });

    index++;
  }

  return edges;
}

function analyzeFillStyle(allEdges: EdgeInfo[], fillStyle: number): FillAnalysis {
  // Collect contributions for this fill style
  const contributions: { edge: EdgeInfo, startX: number, startY: number, endX: number, endY: number, reversed: boolean }[] = [];

  for (const edge of allEdges) {
    // fillStyle1 = forward direction
    if (edge.fillStyle1 === fillStyle) {
      contributions.push({
        edge,
        startX: edge.startX,
        startY: edge.startY,
        endX: edge.endX,
        endY: edge.endY,
        reversed: false
      });
    }
    // fillStyle0 = reversed direction
    if (edge.fillStyle0 === fillStyle && edge.fillStyle0 !== edge.fillStyle1) {
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

  // Build chains
  const used = new Set<number>();
  let connectedChains = 0;
  let closedLoops = 0;
  const unclosedGaps: { from: {x: number, y: number}, to: {x: number, y: number}, distance: number }[] = [];

  while (used.size < contributions.length) {
    // Start new chain
    let startIdx = -1;
    for (let i = 0; i < contributions.length; i++) {
      if (!used.has(i)) {
        startIdx = i;
        break;
      }
    }
    if (startIdx < 0) break;

    connectedChains++;
    const first = contributions[startIdx];
    const chainStart = { x: first.startX, y: first.startY };
    let currentEnd = { x: first.endX, y: first.endY };
    used.add(startIdx);

    // Find connected edges
    let foundConnection = true;
    while (foundConnection) {
      foundConnection = false;
      let bestIdx = -1;
      let bestDist = Infinity;

      for (let i = 0; i < contributions.length; i++) {
        if (used.has(i)) continue;
        const contrib = contributions[i];
        const dx = Math.abs(contrib.startX - currentEnd.x);
        const dy = Math.abs(contrib.startY - currentEnd.y);
        const dist = dx + dy;

        if (dx <= EPSILON && dy <= EPSILON && dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }

      if (bestIdx >= 0) {
        used.add(bestIdx);
        currentEnd = { x: contributions[bestIdx].endX, y: contributions[bestIdx].endY };
        foundConnection = true;
      }
    }

    // Check if chain closes
    const closeDx = Math.abs(currentEnd.x - chainStart.x);
    const closeDy = Math.abs(currentEnd.y - chainStart.y);
    if (closeDx <= EPSILON && closeDy <= EPSILON) {
      closedLoops++;
    } else {
      unclosedGaps.push({
        from: currentEnd,
        to: chainStart,
        distance: Math.sqrt(closeDx * closeDx + closeDy * closeDy)
      });
    }
  }

  return {
    fillStyle,
    edges: allEdges.filter(e => e.fillStyle0 === fillStyle || e.fillStyle1 === fillStyle),
    connectedChains,
    closedLoops,
    unclosedGaps
  };
}

function analyzeXmlFile(filePath: string): void {
  console.log('='.repeat(70));
  console.log(`ANALYZING: ${path.basename(filePath)}`);
  console.log('='.repeat(70));

  const content = fs.readFileSync(filePath, 'utf-8');

  // Find all DOMShape elements
  const shapeRegex = /<DOMShape[^>]*>([\s\S]*?)<\/DOMShape>/g;
  let shapeMatch;
  let shapeIndex = 0;

  while ((shapeMatch = shapeRegex.exec(content)) !== null) {
    const shapeContent = shapeMatch[0];
    const edges = parseEdgesFromXml(shapeContent);

    if (edges.length === 0) {
      shapeIndex++;
      continue;
    }

    // Find all fill styles used
    const fillStyles = new Set<number>();
    for (const edge of edges) {
      if (edge.fillStyle0 !== undefined) fillStyles.add(edge.fillStyle0);
      if (edge.fillStyle1 !== undefined) fillStyles.add(edge.fillStyle1);
    }

    // Analyze each fill style
    let hasIssues = false;
    const issues: string[] = [];

    for (const fillStyle of fillStyles) {
      const analysis = analyzeFillStyle(edges, fillStyle);

      if (analysis.unclosedGaps.length > 0) {
        hasIssues = true;
        for (const gap of analysis.unclosedGaps) {
          issues.push(`Fill ${fillStyle}: unclosed gap from (${gap.from.x.toFixed(1)}, ${gap.from.y.toFixed(1)}) to (${gap.to.x.toFixed(1)}, ${gap.to.y.toFixed(1)}) = ${gap.distance.toFixed(2)}px`);
        }
      }

      if (analysis.connectedChains > analysis.closedLoops) {
        hasIssues = true;
        issues.push(`Fill ${fillStyle}: ${analysis.connectedChains} chains but only ${analysis.closedLoops} closed loops`);
      }
    }

    if (hasIssues) {
      console.log(`\nShape ${shapeIndex}: ${edges.length} edges, ISSUES FOUND:`);
      for (const issue of issues) {
        console.log(`  - ${issue}`);
      }
    }

    shapeIndex++;
  }

  console.log(`\nAnalyzed ${shapeIndex} shapes`);
}

// Analyze all XML files in LIBRARY
const libraryPath = './sample/extracted/LIBRARY';
const files = fs.readdirSync(libraryPath).filter(f => f.endsWith('.xml'));

console.log(`Found ${files.length} XML files\n`);

// Analyze first few files or specific ones
const filesToAnalyze = files.slice(0, 10);

for (const file of filesToAnalyze) {
  try {
    analyzeXmlFile(path.join(libraryPath, file));
  } catch (e) {
    console.log(`Error analyzing ${file}:`, e);
  }
}
