// Debug Edge 1 from Symbol 25.xml to understand internal MoveTo
import * as fs from 'fs';
import { decodeEdges } from './edge-decoder';

const content = fs.readFileSync('./sample/extracted/LIBRARY/Symbol 25.xml', 'utf-8');

// Find Edge with fillStyle0="2" fillStyle1="3"
const edgeMatch = content.match(/<Edge\s+fillStyle0="2"\s+fillStyle1="3"\s+edges="([^"]*)"/);

if (edgeMatch) {
  const rawData = edgeMatch[1];
  console.log('Raw edge data:');
  console.log(rawData);
  console.log('\n' + '='.repeat(60));

  console.log('\nDecoded commands:');
  const commands = decodeEdges(rawData);

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    if (cmd.type === 'M') {
      console.log(`[${i}] M (${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)})`);
    } else if (cmd.type === 'L') {
      console.log(`[${i}] L (${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)})`);
    } else if (cmd.type === 'Q') {
      console.log(`[${i}] Q ctrl=(${cmd.cx.toFixed(2)}, ${cmd.cy.toFixed(2)}) end=(${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)})`);
    } else if (cmd.type === 'Z') {
      console.log(`[${i}] Z`);
    }
  }

  // Check for internal moveTo
  console.log('\n' + '='.repeat(60));
  console.log('Analysis:');

  let moveToCount = 0;
  let prevX: number | null = null;
  let prevY: number | null = null;

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    if (cmd.type === 'M') {
      moveToCount++;
      if (moveToCount > 1 && prevX !== null && prevY !== null) {
        const dx = Math.abs(cmd.x - prevX);
        const dy = Math.abs(cmd.y - prevY);
        console.log(`Internal MoveTo at [${i}]: from (${prevX.toFixed(2)}, ${prevY.toFixed(2)}) to (${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)}) - gap=${Math.sqrt(dx*dx + dy*dy).toFixed(2)}px`);
      }
      prevX = cmd.x;
      prevY = cmd.y;
    } else if ('x' in cmd) {
      prevX = cmd.x;
      prevY = cmd.y;
    }
  }

  console.log(`\nTotal MoveTo commands: ${moveToCount}`);
} else {
  console.log('Edge not found');
}
