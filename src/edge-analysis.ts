// Comprehensive edge analysis tool to find artifacts
import { decodeEdges } from './edge-decoder';
import type { PathCommand } from './types';

interface EdgeContribution {
  commands: PathCommand[];
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  fillStyle0?: number;
  fillStyle1?: number;
  rawData: string;
}


// Analyze a single edge's commands
function analyzeEdgeCommands(commands: PathCommand[]): {
  hasGaps: boolean;
  gaps: { from: {x: number, y: number}, to: {x: number, y: number}, cmdIndex: number }[];
  startPoint: {x: number, y: number} | null;
  endPoint: {x: number, y: number} | null;
} {
  const gaps: { from: {x: number, y: number}, to: {x: number, y: number}, cmdIndex: number }[] = [];
  let currentX = NaN;
  let currentY = NaN;
  let startPoint: {x: number, y: number} | null = null;
  let endPoint: {x: number, y: number} | null = null;
  const EPSILON = 1.0;

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];

    if (cmd.type === 'M') {
      if (!startPoint) {
        startPoint = { x: cmd.x, y: cmd.y };
      }
      // Check for gap (moveTo after we already have a position)
      if (!Number.isNaN(currentX)) {
        const dx = Math.abs(cmd.x - currentX);
        const dy = Math.abs(cmd.y - currentY);
        if (dx > EPSILON || dy > EPSILON) {
          gaps.push({
            from: { x: currentX, y: currentY },
            to: { x: cmd.x, y: cmd.y },
            cmdIndex: i
          });
        }
      }
      currentX = cmd.x;
      currentY = cmd.y;
    } else if ('x' in cmd) {
      currentX = cmd.x;
      currentY = cmd.y;
      endPoint = { x: cmd.x, y: cmd.y };
    }
  }

  return {
    hasGaps: gaps.length > 0,
    gaps,
    startPoint,
    endPoint
  };
}

// Parse edge XML and analyze
function parseAndAnalyzeEdge(edgeXml: string): EdgeContribution | null {
  // Extract attributes using regex
  const fillStyle0Match = edgeXml.match(/fillStyle0="(\d+)"/);
  const fillStyle1Match = edgeXml.match(/fillStyle1="(\d+)"/);
  const edgesMatch = edgeXml.match(/edges="([^"]*)"/);
  const cubicsMatch = edgeXml.match(/cubics="([^"]*)"/);

  const rawData = cubicsMatch?.[1] || edgesMatch?.[1] || '';
  if (!rawData) return null;

  const commands = decodeEdges(rawData);
  if (commands.length === 0) return null;

  const firstPoint = commands.find(c => 'x' in c);
  const lastPoint = [...commands].reverse().find(c => 'x' in c);

  if (!firstPoint || !('x' in firstPoint) || !lastPoint || !('x' in lastPoint)) return null;

  return {
    commands,
    startX: firstPoint.x,
    startY: firstPoint.y,
    endX: lastPoint.x,
    endY: lastPoint.y,
    fillStyle0: fillStyle0Match ? parseInt(fillStyle0Match[1]) : undefined,
    fillStyle1: fillStyle1Match ? parseInt(fillStyle1Match[1]) : undefined,
    rawData
  };
}

// Analyze all edges for a fill style
function analyzeFillPath(contributions: EdgeContribution[], _fillStyle: number): {
  totalContributions: number;
  connectedChains: number;
  gaps: { from: {x: number, y: number}, to: {x: number, y: number}, distance: number }[];
  closedLoops: number;
  openEnds: { x: number, y: number }[];
} {
  const EPSILON = 1.0;
  const gaps: { from: {x: number, y: number}, to: {x: number, y: number}, distance: number }[] = [];
  const openEnds: { x: number, y: number }[] = [];
  let connectedChains = 0;
  let closedLoops = 0;

  if (contributions.length === 0) {
    return { totalContributions: 0, connectedChains: 0, gaps: [], closedLoops: 0, openEnds: [] };
  }

  // Sort contributions into chains
  const used = new Set<number>();
  let chainStart: {x: number, y: number} | null = null;
  let currentEnd: {x: number, y: number} | null = null;

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
    chainStart = { x: first.startX, y: first.startY };
    currentEnd = { x: first.endX, y: first.endY };
    used.add(startIdx);

    // Find connected edges
    let foundConnection = true;
    while (foundConnection) {
      foundConnection = false;
      for (let i = 0; i < contributions.length; i++) {
        if (used.has(i)) continue;
        const contrib = contributions[i];
        const dx = Math.abs(contrib.startX - currentEnd!.x);
        const dy = Math.abs(contrib.startY - currentEnd!.y);
        if (dx <= EPSILON && dy <= EPSILON) {
          used.add(i);
          currentEnd = { x: contrib.endX, y: contrib.endY };
          foundConnection = true;
          break;
        }
      }
    }

    // Check if chain closes
    if (chainStart && currentEnd) {
      const closeDx = Math.abs(currentEnd.x - chainStart.x);
      const closeDy = Math.abs(currentEnd.y - chainStart.y);
      if (closeDx <= EPSILON && closeDy <= EPSILON) {
        closedLoops++;
      } else {
        openEnds.push(chainStart);
        openEnds.push(currentEnd);
        gaps.push({
          from: currentEnd,
          to: chainStart,
          distance: Math.sqrt(closeDx * closeDx + closeDy * closeDy)
        });
      }
    }
  }

  return {
    totalContributions: contributions.length,
    connectedChains,
    gaps,
    closedLoops,
    openEnds
  };
}

// Generate SVG path for visualization
function commandsToSvgPath(commands: PathCommand[]): string {
  let d = '';
  for (const cmd of commands) {
    switch (cmd.type) {
      case 'M':
        d += `M ${cmd.x.toFixed(2)} ${cmd.y.toFixed(2)} `;
        break;
      case 'L':
        d += `L ${cmd.x.toFixed(2)} ${cmd.y.toFixed(2)} `;
        break;
      case 'Q':
        d += `Q ${cmd.cx.toFixed(2)} ${cmd.cy.toFixed(2)} ${cmd.x.toFixed(2)} ${cmd.y.toFixed(2)} `;
        break;
      case 'C':
        d += `C ${cmd.c1x.toFixed(2)} ${cmd.c1y.toFixed(2)} ${cmd.c2x.toFixed(2)} ${cmd.c2y.toFixed(2)} ${cmd.x.toFixed(2)} ${cmd.y.toFixed(2)} `;
        break;
      case 'Z':
        d += 'Z ';
        break;
    }
  }
  return d.trim();
}

// Main analysis function - analyzes edge data from XML content
export function analyzeShapeEdges(xmlContent: string): void {
  console.log('='.repeat(70));
  console.log('SHAPE EDGE ANALYSIS');
  console.log('='.repeat(70));

  // Find all Edge elements
  const edgeRegex = /<Edge[^>]*(?:\/>|>)/g;
  const edgeMatches = xmlContent.match(edgeRegex) || [];

  console.log(`\nFound ${edgeMatches.length} Edge elements\n`);

  const contributions: EdgeContribution[] = [];
  const fillContributions = new Map<number, EdgeContribution[]>();

  for (let i = 0; i < edgeMatches.length; i++) {
    const edgeXml = edgeMatches[i];
    const contrib = parseAndAnalyzeEdge(edgeXml);

    if (!contrib) {
      console.log(`Edge ${i}: EMPTY or unparseable`);
      continue;
    }

    contributions.push(contrib);

    // Analyze individual edge
    const analysis = analyzeEdgeCommands(contrib.commands);

    // Group by fill style
    if (contrib.fillStyle1 !== undefined) {
      if (!fillContributions.has(contrib.fillStyle1)) {
        fillContributions.set(contrib.fillStyle1, []);
      }
      fillContributions.get(contrib.fillStyle1)!.push(contrib);
    }
    if (contrib.fillStyle0 !== undefined && contrib.fillStyle0 !== contrib.fillStyle1) {
      if (!fillContributions.has(contrib.fillStyle0)) {
        fillContributions.set(contrib.fillStyle0, []);
      }
      // For fillStyle0, we'd use reversed direction
      fillContributions.get(contrib.fillStyle0)!.push({
        ...contrib,
        startX: contrib.endX,
        startY: contrib.endY,
        endX: contrib.startX,
        endY: contrib.startY
      });
    }

    // Report issues
    if (analysis.hasGaps) {
      console.log(`Edge ${i}: HAS INTERNAL GAPS`);
      for (const gap of analysis.gaps) {
        console.log(`  Gap at cmd ${gap.cmdIndex}: (${gap.from.x.toFixed(2)}, ${gap.from.y.toFixed(2)}) -> (${gap.to.x.toFixed(2)}, ${gap.to.y.toFixed(2)})`);
      }
    }
  }

  // Analyze fill paths
  console.log('\n' + '='.repeat(70));
  console.log('FILL PATH ANALYSIS');
  console.log('='.repeat(70));

  for (const [fillStyle, contribs] of fillContributions) {
    const analysis = analyzeFillPath(contribs, fillStyle);
    console.log(`\nFill Style ${fillStyle}:`);
    console.log(`  Contributions: ${analysis.totalContributions}`);
    console.log(`  Connected chains: ${analysis.connectedChains}`);
    console.log(`  Closed loops: ${analysis.closedLoops}`);
    console.log(`  Open ends: ${analysis.openEnds.length}`);

    if (analysis.gaps.length > 0) {
      console.log(`  GAPS FOUND: ${analysis.gaps.length}`);
      for (const gap of analysis.gaps) {
        console.log(`    Gap: (${gap.from.x.toFixed(2)}, ${gap.from.y.toFixed(2)}) -> (${gap.to.x.toFixed(2)}, ${gap.to.y.toFixed(2)}) distance=${gap.distance.toFixed(2)}px`);
      }
    }

    if (analysis.openEnds.length > 0) {
      console.log(`  OPEN ENDS:`);
      for (const end of analysis.openEnds) {
        console.log(`    (${end.x.toFixed(2)}, ${end.y.toFixed(2)})`);
      }
    }
  }
}

// Test with sample data that has known issues
export function runDiagnostics(): void {
  console.log('='.repeat(70));
  console.log('EDGE DECODER DIAGNOSTICS');
  console.log('='.repeat(70));

  // Test 1: Simple quadratic curve
  console.log('\n--- Test 1: Simple quadratic ---');
  const test1 = '!0 0[10 20 30 0';
  const result1 = decodeEdges(test1);
  console.log('Input:', test1);
  console.log('Output:', JSON.stringify(result1, null, 2));

  // Test 2: Multiple segments
  console.log('\n--- Test 2: Multiple segments ---');
  const test2 = '!0 0[10 20 30 0!30 0[40 20 50 0';
  const result2 = decodeEdges(test2);
  console.log('Input:', test2);
  console.log('Commands:', result2.length);
  console.log('Types:', result2.map(c => c.type).join(', '));

  // Test 3: Hex coordinates
  console.log('\n--- Test 3: Hex coordinates ---');
  const test3 = '!#100 #200[#150 #250 #200 #300';
  const result3 = decodeEdges(test3);
  console.log('Input:', test3);
  console.log('Output:', JSON.stringify(result3, null, 2));

  // Test 4: Negative hex (two's complement)
  console.log('\n--- Test 4: Negative hex ---');
  const test4 = '!#FFFF00 #FFFE00|#FFFD00 #FFFC00';
  const result4 = decodeEdges(test4);
  console.log('Input:', test4);
  console.log('Output:', JSON.stringify(result4, null, 2));

  // Test 5: Cubic bezier
  console.log('\n--- Test 5: Cubic bezier ---');
  const test5 = '!0 0(;10,20 30,40 50,60q0 0Q25 30q50 60);';
  const result5 = decodeEdges(test5);
  console.log('Input:', test5);
  console.log('Output:', JSON.stringify(result5, null, 2));

  // Test 6: Mixed with style marker
  console.log('\n--- Test 6: With style marker ---');
  const test6 = '!0 0S2[10 20 30 0';
  const result6 = decodeEdges(test6);
  console.log('Input:', test6);
  console.log('Output:', JSON.stringify(result6, null, 2));

  // Test 7: LineTo
  console.log('\n--- Test 7: LineTo ---');
  const test7 = '!0 0|100 0|100 100|0 100|0 0';
  const result7 = decodeEdges(test7);
  console.log('Input:', test7);
  console.log('Output:', JSON.stringify(result7, null, 2));

  // Test 8: Close path
  console.log('\n--- Test 8: Close path ---');
  const test8 = '!0 0|100 0|100 100/';
  const result8 = decodeEdges(test8);
  console.log('Input:', test8);
  console.log('Output:', JSON.stringify(result8, null, 2));

  // Test 9: Fractional hex
  console.log('\n--- Test 9: Fractional hex ---');
  const test9 = '!#100.80 #200.40[#150.C0 #250.20 #200.00 #300.00';
  const result9 = decodeEdges(test9);
  console.log('Input:', test9);
  console.log('First point:', result9[0]);
}

// Run diagnostics
runDiagnostics();

export { analyzeEdgeCommands, analyzeFillPath, commandsToSvgPath, parseAndAnalyzeEdge };
