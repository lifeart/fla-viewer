// TEMP probe: report per-shape fill→edge assignment for binary FLA fixtures.
// Loads OLE2 streams, decodes shapes, and reports for each shape:
//   - edge count
//   - declared fill indices
//   - the set of fill indices referenced across edges (fillStyle0 / fillStyle1)
//   - any declared fill whose index is referenced by NO edge ("unreferenced fill")
// Usage: node scripts/probe-fills.mjs <in.fla>
import { readFileSync } from 'fs';
import { build } from 'esbuild';
import { pathToFileURL } from 'url';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const inPath = process.argv[2] ?? 'src/__tests__/fixtures/btnstrob.fla';

// Bundle the TS decoder to ESM so we can import it from Node.
const entry = `
export { OLE2File } from './src/ole2-reader';
export { decodeStreamShapes } from './src/binary-shape-decoder';
`;
const bundled = await build({
  stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  logLevel: 'error',
});
const tmp = join(tmpdir(), `probe-fills-${Date.now()}.mjs`);
writeFileSync(tmp, bundled.outputFiles[0].text);
const { OLE2File, decodeStreamShapes } = await import(pathToFileURL(tmp).href);

const bytes = new Uint8Array(readFileSync(inPath));
const ole = new OLE2File(bytes);
const streams = ole.listStreams().map((s) => s.name);
console.log(`# ${inPath}`);
console.log(`streams: ${streams.join(', ')}`);

function edgeRefs(edge) {
  const refs = new Set();
  if (edge.fillStyle0) refs.add(`f0:${edge.fillStyle0}`);
  if (edge.fillStyle1) refs.add(`f1:${edge.fillStyle1}`);
  if (edge.strokeStyle) refs.add(`s:${edge.strokeStyle}`);
  return refs;
}

for (const name of streams) {
  if (!/^(Symbol|Page|S |P )/.test(name)) continue;
  let res;
  try {
    res = decodeStreamShapes(ole.readStream(name));
  } catch (e) {
    console.log(`\n== ${name}: decode error: ${e.message}`);
    continue;
  }
  if (res.shapes.length === 0) continue;
  console.log(`\n== ${name} (root=${res.rootClass}) shapes=${res.shapes.length} totalEdges=${res.totalEdges}`);
  res.shapes.forEach((shape, si) => {
    const declaredFills = shape.fills.map((f) => f.index);
    const declaredFillDesc = shape.fills
      .map((f) => `${f.index}:${f.type}${f.color ? '/' + f.color : ''}`)
      .join(', ');
    const refFill0 = new Set();
    const refFill1 = new Set();
    const refStroke = new Set();
    for (const e of shape.edges) {
      if (e.fillStyle0) refFill0.add(e.fillStyle0);
      if (e.fillStyle1) refFill1.add(e.fillStyle1);
      if (e.strokeStyle) refStroke.add(e.strokeStyle);
    }
    const referenced = new Set([...refFill0, ...refFill1]);
    const unreferenced = declaredFills.filter((i) => !referenced.has(i));
    // Count internal M (moveto) commands beyond the first per edge — a sign of
    // grouping concatenation.
    let internalMoves = 0;
    let multiCmdEdges = 0;
    for (const e of shape.edges) {
      const moves = e.commands.filter((c) => c.type === 'M').length;
      if (moves > 1) internalMoves += moves - 1;
      if (e.commands.length > 2) multiCmdEdges++;
    }
    console.log(
      `  shape[${si}] edges=${shape.edges.length} multiCmdEdges=${multiCmdEdges} internalMoves=${internalMoves}`
    );
    console.log(`    declaredFills=[${declaredFillDesc}]`);
    console.log(`    strokes=[${shape.strokes.map((s) => `${s.index}:w${s.weight}`).join(', ')}]`);
    console.log(
      `    refFill0={${[...refFill0].sort((a, b) => a - b)}} refFill1={${[...refFill1].sort((a, b) => a - b)}} refStroke={${[...refStroke].sort((a, b) => a - b)}}`
    );
    if (unreferenced.length) {
      console.log(`    *** UNREFERENCED FILLS: [${unreferenced}] ***`);
    }
    if (process.env.DUMP_EDGES) {
      shape.edges.forEach((e, ei) => {
        const tag = `f0=${e.fillStyle0 ?? 0} f1=${e.fillStyle1 ?? 0} s=${e.strokeStyle ?? 0}`;
        const cmds = e.commands
          .map((c) =>
            c.type === 'M'
              ? `M(${c.x.toFixed(1)},${c.y.toFixed(1)})`
              : c.type === 'L'
                ? `L(${c.x.toFixed(1)},${c.y.toFixed(1)})`
                : c.type === 'Q'
                  ? `Q(${c.x.toFixed(1)},${c.y.toFixed(1)})`
                  : c.type
          )
          .join(' ');
        console.log(`      edge[${ei}] ${tag} :: ${cmds}`);
      });
    }
  });
}
