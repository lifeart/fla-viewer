import puppeteer from 'puppeteer';
import { writeFileSync } from 'fs';

async function main() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 2 });
  await page.setCacheEnabled(false);

  const testHtml = `<!DOCTYPE html><html><body style="background:white">
<canvas id="c" width="640" height="640" style="width:320px;height:320px;border:1px solid #ccc"></canvas>
<script type="module">
import JSZip from 'jszip';
import { parseTVG, resolveExternalPalette } from './src/tvg-parser.ts';
import { loadPalettes, flattenExternalPaletteColors } from './src/tpl-palette.ts';

const resp = await fetch('sample/toon/CH_Anna_rig_football_suit_V001_V07.zip');
const zip = await JSZip.loadAsync(await resp.arrayBuffer());
const externalColors = flattenExternalPaletteColors(await loadPalettes(zip));

let tvgPath = null;
zip.forEach(p => { if (p.includes('F-Hand_OL_1_F-11.tvg')) tvgPath = p; });
const buf = await zip.file(tvgPath).async('arraybuffer');
const drawing = parseTVG(buf);
if (externalColors.length > 0) resolveExternalPalette(drawing, externalColors);

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const dpr = 2;

// Compute bounds
let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
for (const layer of drawing.layers) {
  for (const shape of layer.shapes) {
    for (const comp of shape.components) {
      if (!comp.path) continue;
      for (const seg of comp.path.segments) {
        if (seg.x < minX) minX = seg.x;
        if (seg.y < minY) minY = seg.y;
        if (seg.x > maxX) maxX = seg.x;
        if (seg.y > maxY) maxY = seg.y;
        if (seg.type === 'C') {
          minX = Math.min(minX, seg.c1x, seg.c2x);
          minY = Math.min(minY, seg.c1y, seg.c2y);
          maxX = Math.max(maxX, seg.c1x, seg.c2x);
          maxY = Math.max(maxY, seg.c1y, seg.c2y);
        }
      }
    }
  }
}

const viewport = 336;
const centerX = (minX + maxX) / 2;
const centerY = (minY + maxY) / 2;
const scale = 320 / viewport;
const renderScale = scale * dpr;
const offsetX = (320 / 2 - centerX * scale) * dpr;
const offsetY = (320 / 2 + centerY * scale) * dpr;

ctx.setTransform(renderScale, 0, 0, -renderScale, offsetX, offsetY);

// Color each layer differently
const layerColors = {
  underlay: 'rgba(0,0,255,0.5)',
  color: 'rgba(0,200,0,0.5)',
  overlay: 'rgba(255,0,0,0.5)',
  line: 'rgba(255,255,0,0.5)',
};

const layerOrder = ['underlay', 'color', 'overlay', 'line'];
for (const type of layerOrder) {
  for (const layer of drawing.layers) {
    if (layer.type !== type) continue;
    const fillColor = layerColors[type] || 'rgba(128,128,128,0.5)';

    for (const shape of layer.shapes) {
      const fillComps = shape.components.filter(c => c.componentType === 0 && c.path && c.path.segments.length > 0);
      if (fillComps.length === 0) continue;

      // Build chain (same as renderLayerPass)
      const TOL = 0.5;
      const compInfos = fillComps.map((comp, idx) => {
        const segs = comp.path.segments;
        return { ci: idx, startX: segs[0].x, startY: segs[0].y, endX: segs[segs.length-1].x, endY: segs[segs.length-1].y };
      });

      const used = new Set();
      const chains = [];
      for (let i = 0; i < compInfos.length; i++) {
        if (used.has(i)) continue;
        used.add(i);
        const chain = [{ ...compInfos[i], reversed: false }];
        let changed = true;
        while (changed) {
          changed = false;
          const tail = chain[chain.length - 1];
          const head = chain[0];
          if (Math.abs(head.startX - tail.endX) < TOL && Math.abs(head.startY - tail.endY) < TOL) break;
          for (let j = 0; j < compInfos.length; j++) {
            if (used.has(j)) continue;
            const c = compInfos[j];
            if (Math.abs(c.startX - tail.endX) < TOL && Math.abs(c.startY - tail.endY) < TOL) { chain.push({...c, reversed: false}); used.add(j); changed = true; break; }
            if (Math.abs(c.endX - tail.endX) < TOL && Math.abs(c.endY - tail.endY) < TOL) { chain.push({ci:c.ci,startX:c.endX,startY:c.endY,endX:c.startX,endY:c.startY,reversed:true}); used.add(j); changed = true; break; }
          }
          if (changed) continue;
          for (let j = 0; j < compInfos.length; j++) {
            if (used.has(j)) continue;
            const c = compInfos[j];
            if (Math.abs(c.endX - head.startX) < TOL && Math.abs(c.endY - head.startY) < TOL) { chain.unshift({...c, reversed: false}); used.add(j); changed = true; break; }
            if (Math.abs(c.startX - head.startX) < TOL && Math.abs(c.startY - head.startY) < TOL) { chain.unshift({ci:c.ci,startX:c.endX,startY:c.endY,endX:c.startX,endY:c.startY,reversed:true}); used.add(j); changed = true; break; }
          }
        }
        chains.push(chain);
      }

      const path = new Path2D();
      for (const chain of chains) {
        let isFirst = true;
        for (const info of chain) {
          const comp = fillComps[info.ci];
          const segs = comp.path.segments;
          if (!info.reversed) {
            for (let si = 0; si < segs.length; si++) {
              const seg = segs[si];
              if (si === 0) { if (isFirst) { path.moveTo(seg.x, seg.y); isFirst = false; } else path.lineTo(seg.x, seg.y); }
              else if (seg.type === 'C') path.bezierCurveTo(seg.c1x, seg.c1y, seg.c2x, seg.c2y, seg.x, seg.y);
              else if (seg.type === 'Q') path.quadraticCurveTo(seg.cx, seg.cy, seg.x, seg.y);
              else path.lineTo(seg.x, seg.y);
            }
          } else {
            const lastSeg = segs[segs.length - 1];
            if (isFirst) { path.moveTo(lastSeg.x, lastSeg.y); isFirst = false; } else path.lineTo(lastSeg.x, lastSeg.y);
            for (let si = segs.length - 1; si >= 1; si--) {
              const seg = segs[si];
              const dest = segs[si - 1];
              if (seg.type === 'C') path.bezierCurveTo(seg.c2x, seg.c2y, seg.c1x, seg.c1y, dest.x, dest.y);
              else if (seg.type === 'Q') path.quadraticCurveTo(seg.cx, seg.cy, dest.x, dest.y);
              else path.lineTo(dest.x, dest.y);
            }
          }
        }
        const cH = chain[0], cT = chain[chain.length-1];
        if (Math.abs(cH.startX - cT.endX) + Math.abs(cH.startY - cT.endY) < TOL * 2) path.closePath();
      }

      ctx.fillStyle = fillColor;
      ctx.fill(path, 'evenodd');
      // Also stroke the outline thinly
      ctx.strokeStyle = fillColor.replace('0.5', '1');
      ctx.lineWidth = 0.5;
      ctx.stroke(path);
    }
  }
}

document.getElementById('c').setAttribute('data-done', '1');
</script></body></html>`;

  writeFileSync('/Users/lifeart/Repos/fla-viewer/test-fills-debug.html', testHtml);
  await page.goto('http://localhost:5174/test-fills-debug.html?t=' + Date.now(), { waitUntil: 'networkidle0', timeout: 60000 });
  await new Promise(r => setTimeout(r, 3000));
  await page.screenshot({ path: '/tmp/fills-debug.png' });
  console.log('Screenshot: /tmp/fills-debug.png');
  await browser.close();
}

main().catch(console.error);
