// Test script to analyze edge parsing and path building
import { decodeEdges } from './edge-decoder';

// Full edge data from ten me .xml (lines 18-28)
const fullEdgeData = `!-3965 5484S2[-2922 5672 -1879 5878!-1879 5878[-1579 5935 -1279 6011!-1279 6011[-559 6186 0 6674!0 6674[-80 7380 -232 8085!-232 8085[-260 8212 -281 8340!-281 8340[-289 8387 -295 8438!-295 8438[-304 8518 -319 8596!-319 8596[-338 8690 -359 8786!-359 8786[-386 8913 -416 9037!-416 9037[-520 9461 -644 9876!-644 9876[-813 10443 -978 11013!-978 11013[-1008 11117 -1032 11225!-1032 11225[-1076 11424 -1124 11623!-1124 11623[-1151 11734 -1192 11841!-1192 11841[-1455 12539 -1658 13245!-1658 13245[-1724 13472 -1784 13701!-1784 13701[-2211 15337 -2646 16981!-2646 16981[-3017 18516 -3637 19970!-3637 19970[-3656 20014 -3678 20056!-3678 20056[-3760 20250 -3832 20449!-3832 20449[-3978 20852 -4119 21273!-4119 21273[-4152 21372 -4178 21475!-4178 21475[-4195 21544 -4214 21615!-4214 21615[-4227 21666 -4239 21713!-4239 21713[-4246 21741 -4252 21771!-4252 21771[-4318 22135 -4559 22428!-4559 22428[-5775 22353 -6967 22073!-6967 22073[-7426 21964 -7851 21869!-7851 21869[-8050 21822 -8251 21765!-8251 21765[-8408 21719 -8564 21675!-8564 21675[-8679 21642 -8800 21609!-8800 21609[-9126 21522 -9450 21458!-9450 21458[-9707 21404 -9958 21352!-9958 21352[-10572 21221 -11185 21074!-11185 21074[-12098 20858 -13010 20644!-13010 20644[-13629 20499 -14252 20356!-14252 20356[-14720 20247 -15186 20142!-15186 20142[-15496 20072 -15803 20004!-15803 20004[-16248 19903 -16671 19789!-16671 19789[-17547 19552 -18433 19413!-18433 19413[-19054 19318 -19665 19172!-19665 19172[-23275 18316 -26877 17432!-26877 17432[-27826 17197 -28749 16883!-28749 16883[-29897 16491 -31044 16124!-31044 16124[-31248 16061 -31372 15899!-31372 15899[-31128 14336 -30668 12811!-30668 12811[-30580 12521 -30501 12233!-30501 12233[-29905 10065 -29468 7864!-29468 7864[-29373 7388 -29233 6919!-29233 6919[-29173 6720 -29111 6518!-29111 6518[-29058 6342 -29003 6171!-29003 6171[-28956 6024 -28907 5881!-28907 5881[-28763 5455 -28633 5027!-28633 5027[-28276 3852 -28031 2650!-28031 2650[-27923 2119 -27777 1595!-27777 1595[-27676 1233 -27655 858!-27655 858[-27641 615 -27592 383!-27592 383[-27576 309 -27588 238!-27588 238|-27571 54!-27571 54[-27300 -55 -26981 55!-26981 55[-26528 210 -26057 299!-26057 299[-25652 378 -25250 480!-25250 480[-23201 1013 -21136 1491!-21136 1491[-19740 1814 -18357 2186!-18357 2186[-17229 2486 -16088 2742!-16088 2742[-14944 2995 -13792 3201!-13792 3201[-13229 3305 -12669 3422!-12669 3422[-12114 3541 -11558 3675!-11558 3675[-10450 3946 -9363 4282!-9363 4282[-7833 4755 -6260 5057!-6260 5057[-5114 5276 -3965 5484`;

// TWIPS scale factor
const SCALE = 20;

// Test the edge decoder with full data
function testFullEdgeDecoding() {
  console.log('=== Testing Full Edge Decoding ===\n');

  const commands = decodeEdges(fullEdgeData);

  // Count command types
  const counts: Record<string, number> = {};
  for (const cmd of commands) {
    counts[cmd.type] = (counts[cmd.type] || 0) + 1;
  }

  console.log('Total commands:', commands.length);
  console.log('Command counts:', counts);

  // Analyze MoveTo commands
  const moveTos = commands.filter(c => c.type === 'M');
  console.log('\nMoveTo commands:', moveTos.length);

  // Check if path closes (first and last point match)
  const firstCmd = commands.find(c => c.type === 'M');
  const lastCmd = [...commands].reverse().find(c => 'x' in c);

  if (firstCmd && firstCmd.type === 'M' && lastCmd && 'x' in lastCmd) {
    const dx = Math.abs(firstCmd.x - lastCmd.x);
    const dy = Math.abs(firstCmd.y - lastCmd.y);
    console.log(`\nFirst point: (${firstCmd.x.toFixed(2)}, ${firstCmd.y.toFixed(2)})`);
    console.log(`Last point: (${lastCmd.x.toFixed(2)}, ${lastCmd.y.toFixed(2)})`);
    console.log(`Distance: dx=${dx.toFixed(2)}, dy=${dy.toFixed(2)}`);
    console.log(`Path closes: ${dx < 0.5 && dy < 0.5 ? 'YES' : 'NO'}`);
  }

  return commands;
}

// Analyze edge continuity and detect gaps
function analyzeEdgeContinuity() {
  console.log('\n=== Edge Continuity Analysis ===\n');

  const commands = decodeEdges(fullEdgeData);

  let prevX: number | undefined;
  let prevY: number | undefined;
  let gaps: { from: { x: number; y: number }; to: { x: number; y: number }; distance: number }[] = [];
  let subpathCount = 0;

  for (const cmd of commands) {
    if (cmd.type === 'M') {
      if (prevX !== undefined && prevY !== undefined) {
        const dx = Math.abs(cmd.x - prevX);
        const dy = Math.abs(cmd.y - prevY);
        const distance = Math.sqrt(dx * dx + dy * dy);

        // If there's a significant gap, record it
        if (distance > 0.5) {
          gaps.push({
            from: { x: prevX, y: prevY },
            to: { x: cmd.x, y: cmd.y },
            distance
          });
          subpathCount++;
        }
      } else {
        subpathCount++;
      }
      prevX = cmd.x;
      prevY = cmd.y;
    } else if ('x' in cmd) {
      prevX = cmd.x;
      prevY = cmd.y;
    }
  }

  console.log(`Subpath count: ${subpathCount}`);
  console.log(`Gaps detected: ${gaps.length}`);

  if (gaps.length > 0) {
    console.log('\nGap details (first 10):');
    for (const gap of gaps.slice(0, 10)) {
      console.log(`  From (${gap.from.x.toFixed(2)}, ${gap.from.y.toFixed(2)}) to (${gap.to.x.toFixed(2)}, ${gap.to.y.toFixed(2)}) - distance: ${gap.distance.toFixed(2)} pixels`);
    }
  }

  return { gaps, subpathCount };
}

// Simulate the renderer's fill path building
function simulateFillPathBuilding() {
  console.log('\n=== Simulating Fill Path Building ===\n');

  const commands = decodeEdges(fullEdgeData);
  const EPSILON = 0.5;

  // Simulate appendEdgeToPath behavior
  let currentPos: { x: number; y: number } | undefined;
  let pathOperations: string[] = [];
  let moveToCount = 0;
  let lineToCount = 0;
  let quadToCount = 0;

  let isFirst = true;

  for (const cmd of commands) {
    switch (cmd.type) {
      case 'M':
        // Check if we should skip this moveTo (already at position)
        if (isFirst && currentPos &&
            Math.abs(cmd.x - currentPos.x) <= EPSILON &&
            Math.abs(cmd.y - currentPos.y) <= EPSILON) {
          pathOperations.push(`SKIP moveTo (already at ${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)})`);
        } else {
          pathOperations.push(`moveTo(${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)})`);
          moveToCount++;
        }
        currentPos = { x: cmd.x, y: cmd.y };
        isFirst = false;
        break;
      case 'L':
        pathOperations.push(`lineTo(${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)})`);
        lineToCount++;
        currentPos = { x: cmd.x, y: cmd.y };
        isFirst = false;
        break;
      case 'Q':
        pathOperations.push(`quadTo(${cmd.cx.toFixed(2)}, ${cmd.cy.toFixed(2)}, ${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)})`);
        quadToCount++;
        currentPos = { x: cmd.x, y: cmd.y };
        isFirst = false;
        break;
      case 'Z':
        pathOperations.push('closePath()');
        break;
    }
  }

  console.log(`Path operations: moveTo=${moveToCount}, lineTo=${lineToCount}, quadTo=${quadToCount}`);
  console.log(`\nFirst 20 operations:`);
  for (const op of pathOperations.slice(0, 20)) {
    console.log(`  ${op}`);
  }
  console.log(`\nLast 10 operations:`);
  for (const op of pathOperations.slice(-10)) {
    console.log(`  ${op}`);
  }
}

// Analyze raw tokens to understand the edge format
function analyzeRawTokens() {
  console.log('\n=== Raw Token Analysis ===\n');

  // Count raw ! (moveTo) occurrences in the original string
  const moveToMatches = fullEdgeData.match(/!/g);
  const quadMatches = fullEdgeData.match(/\[/g);
  const lineMatches = fullEdgeData.match(/\|/g);

  console.log(`Raw '!' (moveTo) count: ${moveToMatches?.length || 0}`);
  console.log(`Raw '[' (quadTo) count: ${quadMatches?.length || 0}`);
  console.log(`Raw '|' (lineTo) count: ${lineMatches?.length || 0}`);

  // Check for any obvious coordinate mismatches in the pattern
  // Pattern should be: ! x y [ cx cy x y ! x y [ cx cy x y ...
  // Where each ! after the first should be at the same position as the previous curve endpoint

  const regex = /!(-?\d+)\s+(-?\d+)(?:S\d+)?\[(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/g;
  let match;
  let prevEndX: number | undefined;
  let prevEndY: number | undefined;
  let mismatches = 0;

  while ((match = regex.exec(fullEdgeData)) !== null) {
    const moveX = parseInt(match[1]) / SCALE;
    const moveY = parseInt(match[2]) / SCALE;
    const endX = parseInt(match[5]) / SCALE;
    const endY = parseInt(match[6]) / SCALE;

    if (prevEndX !== undefined && prevEndY !== undefined) {
      const dx = Math.abs(moveX - prevEndX);
      const dy = Math.abs(moveY - prevEndY);
      if (dx > 0.5 || dy > 0.5) {
        console.log(`Mismatch: prev end (${prevEndX.toFixed(2)}, ${prevEndY.toFixed(2)}) != moveTo (${moveX.toFixed(2)}, ${moveY.toFixed(2)})`);
        mismatches++;
      }
    }

    prevEndX = endX;
    prevEndY = endY;
  }

  console.log(`\nTotal coordinate mismatches: ${mismatches}`);
}

// Run all tests
console.log('=' .repeat(60));
console.log('EDGE PARSING AND PATH BUILDING ANALYSIS');
console.log('='.repeat(60));

testFullEdgeDecoding();
analyzeEdgeContinuity();
simulateFillPathBuilding();
analyzeRawTokens();

export { testFullEdgeDecoding, analyzeEdgeContinuity, simulateFillPathBuilding, analyzeRawTokens };
