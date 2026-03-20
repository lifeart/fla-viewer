import * as fs from 'fs';
import JSZip from 'jszip';
import { parseTVG } from './src/tvg-parser.ts';

async function main() {
  const zipPath = './sample/toon/CH_Anna_rig_football_suit_V001_V07.zip';
  const zipData = fs.readFileSync(zipPath);
  const zip = await JSZip.loadAsync(zipData);

  // Find Drawing_2-1.tvg
  const tvgPath = 'CH_Anna_rig_football_suit_V001_V07/elements/Drawing_2/Drawing_2-1.tvg';
  const tvgEntry = zip.file(tvgPath);
  if (!tvgEntry) {
    console.error(`File not found: ${tvgPath}`);
    // List all Drawing_2 files
    zip.forEach((path) => {
      if (path.includes('Drawing_2')) console.log('  ', path);
    });
    return;
  }

  console.log(`=== Parsing: ${tvgPath} ===\n`);
  const tvgBuffer = await tvgEntry.async('arraybuffer');
  const drawing = parseTVG(tvgBuffer);

  // Print pointQuantum
  console.log(`pointQuantum: ${drawing.pointQuantum}\n`);

  // Print palette
  console.log(`=== PALETTE (${drawing.palette.length} entries) ===`);
  for (const p of drawing.palette) {
    console.log(`  id=${p.id.toString(16).padStart(16, '0')} name="${p.name}" palette="${p.paletteName}" rgba=(${p.r},${p.g},${p.b},${p.a})`);
  }
  console.log();

  // Print layers and shapes
  console.log(`=== LAYERS (${drawing.layers.length}) ===`);
  for (let li = 0; li < drawing.layers.length; li++) {
    const layer = drawing.layers[li];
    console.log(`\n--- Layer ${li}: type="${layer.type}" shapes=${layer.shapes.length} ---`);
    for (let si = 0; si < layer.shapes.length; si++) {
      const shape = layer.shapes[si];
      console.log(`  Shape ${si}: shapeType=${shape.shapeType} components=${shape.components.length}`);
      for (let ci = 0; ci < shape.components.length; ci++) {
        const c = shape.components[ci];
        const colorStr = c.color
          ? `rgba(${c.color.r},${c.color.g},${c.color.b},${c.color.a})`
          : 'null';
        const insideColorStr = c.insideColor
          ? `rgba(${c.insideColor.r},${c.insideColor.g},${c.insideColor.b},${c.insideColor.a})`
          : 'null';
        const colorIdStr = c.colorId !== null ? c.colorId.toString(16).padStart(16, '0') : 'null';
        const insideColorIdStr = c.insideColorId !== null ? c.insideColorId.toString(16).padStart(16, '0') : 'null';
        const segCount = c.path ? c.path.segments.length : 0;
        const closed = c.path ? c.path.closed : 'n/a';

        const compTypeNames: Record<number, string> = { 0: 'fill', 1: 'unknown', 2: 'stroke/boundary', 4: 'pencil' };
        const compTypeName = compTypeNames[c.componentType] ?? `unknown(${c.componentType})`;

        console.log(`    Component ${ci}: type=${c.componentType}(${compTypeName})`);
        console.log(`      colorId=${colorIdStr}  color=${colorStr}`);
        console.log(`      insideColorId=${insideColorIdStr}  insideColor=${insideColorStr}`);
        console.log(`      paletteIndex=${c.paletteIndex}  strokeWidth=${c.strokeWidth}`);
        console.log(`      path: ${segCount} segments, closed=${closed}`);
        console.log(`      fromTip=${c.fromTipType}  toTip=${c.toTipType}  join=${c.joinType}`);
        if (c.thicknessProfile) {
          console.log(`      thicknessProfile: ${c.thicknessProfile.points.length} points, domain=[${c.thicknessProfile.domain}], closed=${c.thicknessProfile.closed}`);
        }
        if (c.gradientType) {
          console.log(`      gradient: ${c.gradientType} with ${c.gradientStops?.length ?? 0} stops`);
        }
        if (c.tgtiThickness !== null) {
          console.log(`      tgti: thickness=${c.tgtiThickness}`);
        }

        // Check: is color resolved?
        if (c.colorId !== null && c.color === null) {
          console.log(`      *** WARNING: colorId set but color is NULL (unresolved!) ***`);
        }
        // Check: zero width stroke
        if ((c.componentType === 2 || c.componentType === 4) && c.strokeWidth === 0) {
          console.log(`      *** WARNING: stroke/pencil with zero width ***`);
        }
        // Check: degenerate path
        if (c.path && c.path.segments.length <= 1) {
          console.log(`      *** WARNING: degenerate path (<=1 segment) ***`);
        }
      }
    }
  }

  // Summary
  console.log('\n=== SUMMARY ===');
  let totalFills = 0, totalStrokes = 0, totalPencil = 0, totalUnresolved = 0;
  for (const layer of drawing.layers) {
    for (const shape of layer.shapes) {
      for (const c of shape.components) {
        if (c.componentType === 0) totalFills++;
        else if (c.componentType === 2) totalStrokes++;
        else if (c.componentType === 4) totalPencil++;
        if (c.colorId !== null && c.color === null) totalUnresolved++;
      }
    }
  }
  console.log(`  Fills: ${totalFills}, Strokes: ${totalStrokes}, Pencils: ${totalPencil}`);
  console.log(`  Unresolved colors: ${totalUnresolved}`);
  console.log(`  Bitmap tiles: ${drawing.bitmapTiles.length}`);
}

main().catch(console.error);
