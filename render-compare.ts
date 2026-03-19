// Render TVG drawings to PNG using node-canvas and compare with embedded thumbnails
import { readFileSync, writeFileSync } from 'fs';
import JSZip from 'jszip';
import { createCanvas, type Canvas as NodeCanvas } from 'canvas';
import { parseTVG, resolveExternalPalette } from '/Users/lifeart/Repos/fla-viewer/src/tvg-parser.ts';
import type { TVGDrawing, TVGArtLayer, TVGComponent, TVGPath, TVGThicknessProfile } from '/Users/lifeart/Repos/fla-viewer/src/tvg-parser.ts';

const ZIP_PATH = '/Users/lifeart/Repos/fla-viewer/sample/toon/CH_Anna_rig_football_suit_V001_V07.zip';
const UNITS_PER_FIELD = 28;
const FIELD_CHART = 12;
const VIEWPORT_SIZE = FIELD_CHART * UNITS_PER_FIELD; // 336
const THUMB_SIZE = 320;

// We need to replicate the renderTVGToCanvas logic for Node.js since it uses DOM APIs.
// Simplified version focusing on the viewport and rendering pipeline.

function computeBounds(drawing: TVGDrawing) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const layer of drawing.layers) {
    for (const shape of layer.shapes) {
      for (const comp of shape.components) {
        if (comp.path) {
          for (const seg of comp.path.segments) {
            minX = Math.min(minX, seg.x); minY = Math.min(minY, seg.y);
            maxX = Math.max(maxX, seg.x); maxY = Math.max(maxY, seg.y);
            if (seg.type === 'Q') {
              minX = Math.min(minX, seg.cx); minY = Math.min(minY, seg.cy);
              maxX = Math.max(maxX, seg.cx); maxY = Math.max(maxY, seg.cy);
            } else if (seg.type === 'C') {
              minX = Math.min(minX, seg.c1x, seg.c2x); minY = Math.min(minY, seg.c1y, seg.c2y);
              maxX = Math.max(maxX, seg.c1x, seg.c2x); maxY = Math.max(maxY, seg.c1y, seg.c2y);
            }
          }
        }
      }
    }
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function buildPath(ctx: any, tvgPath: TVGPath) {
  ctx.beginPath();
  for (const seg of tvgPath.segments) {
    switch (seg.type) {
      case 'M': ctx.moveTo(seg.x, seg.y); break;
      case 'L': ctx.lineTo(seg.x, seg.y); break;
      case 'Q': ctx.quadraticCurveTo(seg.cx, seg.cy, seg.x, seg.y); break;
      case 'C': ctx.bezierCurveTo(seg.c1x, seg.c1y, seg.c2x, seg.c2y, seg.x, seg.y); break;
    }
  }
  if (tvgPath.closed) ctx.closePath();
}

function getColor(comp: TVGComponent): string {
  if (comp.color) {
    return `rgba(${comp.color.r},${comp.color.g},${comp.color.b},${comp.color.a / 255})`;
  }
  return 'rgba(0,0,0,1)';
}

function sampleCurvePoint(path: TVGPath, t: number): { x: number; y: number; nx: number; ny: number } {
  // Simplified: sample path at parameter t (0..1) along total arc
  // For now, linear interpolation along segments
  const segs = path.segments;
  if (segs.length < 2) return { x: 0, y: 0, nx: 0, ny: -1 };

  // Count moveTo-separated sub-paths, use first sub-path
  const points: { x: number; y: number }[] = [];
  for (const seg of segs) {
    points.push({ x: seg.x, y: seg.y });
  }

  // Compute cumulative arc lengths
  const lengths: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i-1].x;
    const dy = points[i].y - points[i-1].y;
    lengths.push(lengths[i-1] + Math.sqrt(dx*dx + dy*dy));
  }
  const totalLen = lengths[lengths.length - 1];
  if (totalLen < 0.001) return { x: points[0].x, y: points[0].y, nx: 0, ny: -1 };

  const targetLen = t * totalLen;
  let segIdx = 1;
  while (segIdx < lengths.length - 1 && lengths[segIdx] < targetLen) segIdx++;

  const segStart = lengths[segIdx - 1];
  const segEnd = lengths[segIdx];
  const segT = segEnd > segStart ? (targetLen - segStart) / (segEnd - segStart) : 0;

  const x = points[segIdx-1].x + (points[segIdx].x - points[segIdx-1].x) * segT;
  const y = points[segIdx-1].y + (points[segIdx].y - points[segIdx-1].y) * segT;

  const dx = points[segIdx].x - points[segIdx-1].x;
  const dy = points[segIdx].y - points[segIdx-1].y;
  const len = Math.sqrt(dx*dx + dy*dy) || 1;
  // Normal perpendicular to tangent
  return { x, y, nx: -dy/len, ny: dx/len };
}

function renderVariableWidthStroke(ctx: any, comp: TVGComponent) {
  if (!comp.path || !comp.thicknessProfile || comp.thicknessProfile.points.length < 2) return;

  const profile = comp.thicknessProfile;
  const path = comp.path;
  const color = getColor(comp);

  // Sample points along path and build outline
  const numSamples = 40;
  const leftPoints: { x: number; y: number }[] = [];
  const rightPoints: { x: number; y: number }[] = [];

  for (let i = 0; i <= numSamples; i++) {
    const t = i / numSamples;
    const pt = sampleCurvePoint(path, t);

    // Interpolate thickness at t
    let leftW = profile.points[0].leftOffset;
    let rightW = profile.points[0].rightOffset;
    for (let j = 1; j < profile.points.length; j++) {
      if (profile.points[j].loc >= t) {
        const prev = profile.points[j-1];
        const next = profile.points[j];
        const lt = next.loc > prev.loc ? (t - prev.loc) / (next.loc - prev.loc) : 0;
        leftW = prev.leftOffset + (next.leftOffset - prev.leftOffset) * lt;
        rightW = prev.rightOffset + (next.rightOffset - prev.rightOffset) * lt;
        break;
      }
      leftW = profile.points[j].leftOffset;
      rightW = profile.points[j].rightOffset;
    }

    leftPoints.push({ x: pt.x + pt.nx * leftW, y: pt.y + pt.ny * leftW });
    rightPoints.push({ x: pt.x - pt.nx * rightW, y: pt.y - pt.ny * rightW });
  }

  // Draw filled shape
  ctx.beginPath();
  ctx.moveTo(leftPoints[0].x, leftPoints[0].y);
  for (let i = 1; i < leftPoints.length; i++) {
    ctx.lineTo(leftPoints[i].x, leftPoints[i].y);
  }
  for (let i = rightPoints.length - 1; i >= 0; i--) {
    ctx.lineTo(rightPoints[i].x, rightPoints[i].y);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function renderLayerPass(ctx: any, layer: TVGArtLayer, defaultStrokeWidth: number, pass: 'fill' | 'stroke', prevLayer?: TVGArtLayer) {
  for (const shape of layer.shapes) {
    // Separate fills and strokes
    const fillComps: TVGComponent[] = [];
    const strokeComps: TVGComponent[] = [];

    for (const comp of shape.components) {
      if (comp.componentType === 0) {
        fillComps.push(comp);
      } else if (comp.componentType === 2 || comp.componentType === 4) {
        strokeComps.push(comp);
      }
    }

    // Handle type-5 path borrowing
    if (strokeComps.length > 0 && strokeComps.every(c => !c.path || c.path.segments.length === 0)) {
      // Try to borrow paths from fills of THIS shape or previous layer's shapes
      if (fillComps.length > 0) {
        for (let i = 0; i < strokeComps.length && i < fillComps.length; i++) {
          if (fillComps[i].path && fillComps[i].path!.segments.length > 0) {
            strokeComps[i] = {
              ...strokeComps[i],
              path: fillComps[i].path,
              color: strokeComps[i].color ?? fillComps[i].color,
              strokeWidth: strokeComps[i].strokeWidth ?? defaultStrokeWidth,
              thicknessProfile: strokeComps[i].thicknessProfile ?? fillComps[i].thicknessProfile,
            };
          }
        }
      }
    }

    if (pass === 'fill') {
      // Chain fill components into connected paths using greedy endpoint matching, then fill
      const validFills = fillComps.filter(c => c.path && c.path.segments.length > 1);
      if (validFills.length > 0) {
        const TOL = 0.5;

        // Build component info for chaining
        const compInfos = validFills.map((comp, idx) => {
          const segs = comp.path!.segments;
          return {
            ci: idx,
            startX: segs[0].x, startY: segs[0].y,
            endX: segs[segs.length - 1].x, endY: segs[segs.length - 1].y,
          };
        });

        // Greedy chain building with endpoint matching
        const used = new Set<number>();
        const chains: { ci: number; reversed: boolean; startX: number; startY: number; endX: number; endY: number }[][] = [];
        for (let i = 0; i < compInfos.length; i++) {
          if (used.has(i)) continue;
          used.add(i);
          const chain: typeof chains[0] = [{ ...compInfos[i], reversed: false }];
          let changed = true;
          while (changed) {
            changed = false;
            const tail = chain[chain.length - 1];
            const head = chain[0];
            if (Math.abs(head.startX - tail.endX) < TOL && Math.abs(head.startY - tail.endY) < TOL) break;
            for (let j = 0; j < compInfos.length; j++) {
              if (used.has(j)) continue;
              const c = compInfos[j];
              if (Math.abs(c.startX - tail.endX) < TOL && Math.abs(c.startY - tail.endY) < TOL) {
                chain.push({ ...c, reversed: false }); used.add(j); changed = true; break;
              }
              if (Math.abs(c.endX - tail.endX) < TOL && Math.abs(c.endY - tail.endY) < TOL) {
                chain.push({ ci: c.ci, startX: c.endX, startY: c.endY, endX: c.startX, endY: c.startY, reversed: true });
                used.add(j); changed = true; break;
              }
            }
            if (changed) continue;
            for (let j = 0; j < compInfos.length; j++) {
              if (used.has(j)) continue;
              const c = compInfos[j];
              if (Math.abs(c.endX - head.startX) < TOL && Math.abs(c.endY - head.startY) < TOL) {
                chain.unshift({ ...c, reversed: false }); used.add(j); changed = true; break;
              }
              if (Math.abs(c.startX - head.startX) < TOL && Math.abs(c.startY - head.startY) < TOL) {
                chain.unshift({ ci: c.ci, startX: c.endX, startY: c.endY, endX: c.startX, endY: c.startY, reversed: true });
                used.add(j); changed = true; break;
              }
            }
          }
          chains.push(chain);
        }

        // Render each chain
        for (const chain of chains) {
          let fillColor: string | null = null;
          for (const info of chain) {
            const comp = validFills[info.ci];
            if (comp.color) { fillColor = getColor(comp); break; }
          }
          if (!fillColor) continue;

          const head = chain[0], tail = chain[chain.length - 1];
          const isClosed = Math.abs(head.startX - tail.endX) + Math.abs(head.startY - tail.endY) < TOL * 2;

          ctx.beginPath();
          let isFirst = true;
          for (const info of chain) {
            const comp = validFills[info.ci];
            const segs = comp.path!.segments;
            if (!info.reversed) {
              for (let si = 0; si < segs.length; si++) {
                const seg = segs[si];
                if (si === 0) {
                  if (isFirst) { ctx.moveTo(seg.x, seg.y); isFirst = false; }
                  else ctx.lineTo(seg.x, seg.y);
                } else if (seg.type === 'C') ctx.bezierCurveTo(seg.c1x, seg.c1y, seg.c2x, seg.c2y, seg.x, seg.y);
                else if (seg.type === 'Q') ctx.quadraticCurveTo(seg.cx, seg.cy, seg.x, seg.y);
                else ctx.lineTo(seg.x, seg.y);
              }
            } else {
              const lastSeg = segs[segs.length - 1];
              if (isFirst) { ctx.moveTo(lastSeg.x, lastSeg.y); isFirst = false; }
              else ctx.lineTo(lastSeg.x, lastSeg.y);
              for (let si = segs.length - 1; si >= 1; si--) {
                const seg = segs[si];
                const dest = segs[si - 1];
                if (seg.type === 'C') ctx.bezierCurveTo(seg.c2x, seg.c2y, seg.c1x, seg.c1y, dest.x, dest.y);
                else if (seg.type === 'Q') ctx.quadraticCurveTo(seg.cx, seg.cy, dest.x, dest.y);
                else ctx.lineTo(dest.x, dest.y);
              }
            }
          }
          if (isClosed) ctx.closePath();

          // Gap-bridging stroke
          if (isClosed) {
            ctx.strokeStyle = fillColor;
            ctx.lineWidth = 0.3;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.stroke();
          }
          ctx.fillStyle = fillColor;
          ctx.fill('evenodd');
        }
      }
    } else {
      for (const comp of strokeComps) {
        if (!comp.path || comp.path.segments.length === 0) continue;
        const color = getColor(comp);

        // ct=2 brush strokes without explicit width are invisible boundaries
        let sw: number;
        if (comp.strokeWidth !== null) {
          sw = comp.strokeWidth;
        } else if (comp.componentType === 4) {
          sw = defaultStrokeWidth;
        } else {
          continue; // invisible boundary stroke
        }
        if (sw < 0.1) continue;

        if (comp.thicknessProfile && comp.thicknessProfile.points.length >= 2) {
          renderVariableWidthStroke(ctx, comp);
        } else {
          buildPath(ctx, comp.path);
          ctx.strokeStyle = color;
          ctx.lineWidth = sw;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.stroke();
        }
      }
    }
  }
}

function renderTVGNode(drawing: TVGDrawing, width: number, height: number, viewportSize: number): NodeCanvas {
  const bounds = computeBounds(drawing);
  const contentExtent = Math.max(bounds.width, bounds.height);
  const autoFit = contentExtent * 1.25;
  const effectiveViewport = Math.max(viewportSize, autoFit);

  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const scale = Math.min(width / effectiveViewport, height / effectiveViewport);
  const offsetX = width / 2 - centerX * scale;
  const offsetY = height / 2 + centerY * scale;

  const defaultStrokeWidth = 1.0;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, width, height);
  ctx.setTransform(scale, 0, 0, -scale, offsetX, offsetY);

  // Two-pass rendering: fills first (all layers), then strokes on top
  const layerOrder: TVGArtLayer['type'][] = ['underlay', 'color', 'line', 'overlay'];
  for (const layerType of layerOrder) {
    for (const layer of drawing.layers) {
      if (layer.type !== layerType) continue;
      renderLayerPass(ctx, layer, defaultStrokeWidth, 'fill');
    }
  }
  for (const layerType of layerOrder) {
    for (const layer of drawing.layers) {
      if (layer.type !== layerType) continue;
      renderLayerPass(ctx, layer, defaultStrokeWidth, 'stroke');
    }
  }

  return canvas;
}

const DRAWINGS = [
  { tvgName: 'F-Hand_OL_1_F-11', thumbPath: 'elements/F-Hand_OL_1_F/.thumbnails/.F-Hand_OL_1_F-11.tvg.png' },
  { tvgName: 'F-Hand_OL_1_F-23', thumbPath: 'elements/F-Hand_OL_1_F/.thumbnails/.F-Hand_OL_1_F-23.tvg.png' },
  { tvgName: 'F-Hand_OL_1_F-26', thumbPath: 'elements/F-Hand_OL_1_F/.thumbnails/.F-Hand_OL_1_F-26.tvg.png' },
  { tvgName: 'Number_Body-1', thumbPath: 'elements/Number_Body/.thumbnails/.Number_Body-1.tvg.png' },
  { tvgName: 'F_3_symbol-1', thumbPath: 'elements/F_3_symbol/.thumbnails/.F_3_symbol-1.tvg.png' },
];

async function main() {
  const zipBuf = readFileSync(ZIP_PATH);
  const zip = await JSZip.loadAsync(zipBuf);

  // Load palettes
  const palettes: any[] = [];
  const pltPaths: string[] = [];
  zip.forEach((path: string) => { if (path.endsWith('.plt') && path.includes('palette-library/')) pltPaths.push(path); });
  for (const path of pltPaths) {
    const text = await zip.file(path)!.async('text');
    for (const line of text.split('\n')) {
      const m = line.match(/^Solid\s+(\S+)\s+(0x\w+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
      if (m) palettes.push({ r: +m[3], g: +m[4], b: +m[5], a: +m[6], id: m[2] });
    }
  }

  const tvgFiles: string[] = [];
  zip.forEach((p: string) => { if (p.endsWith('.tvg')) tvgFiles.push(p); });
  const prefix = tvgFiles[0].substring(0, tvgFiles[0].indexOf('elements/'));

  for (const d of DRAWINGS) {
    const tvgPath = tvgFiles.find(p => p.includes(d.tvgName + '.tvg'));
    if (!tvgPath) { console.log(d.tvgName + ': NOT FOUND'); continue; }

    const buf = await zip.file(tvgPath)!.async('arraybuffer');
    const drawing = parseTVG(buf);
    if (palettes.length > 0) resolveExternalPalette(drawing, palettes);

    const canvas = renderTVGNode(drawing, THUMB_SIZE, THUMB_SIZE, VIEWPORT_SIZE);
    const pngBuf = canvas.toBuffer('image/png');
    const outPath = `/tmp/render_${d.tvgName}.png`;
    writeFileSync(outPath, pngBuf);

    // Also extract embedded thumbnail
    const thumbFile = zip.file(prefix + d.thumbPath);
    if (thumbFile) {
      const thumbBuf = await thumbFile.async('nodebuffer');
      writeFileSync(`/tmp/ref_${d.tvgName}.png`, thumbBuf);
    }

    console.log(`${d.tvgName}: rendered to ${outPath}`);
  }

  console.log('\nDone! Compare /tmp/render_*.png with /tmp/ref_*.png');
}

main().catch(console.error);
