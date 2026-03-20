import puppeteer from 'puppeteer';

const DRAWINGS = [
  'F-Hand_OL_1_F-11', 'F-Hand_OL_1_F-12', 'F-Hand_OL_1_F-14',
  'F-Hand_OL_1_F-21', 'F-Hand_OL_1_F-23', 'F-Hand_OL_1_F-24',
  'F-Hand_OL_1_F-26',
  'Number_Body-1', 'F_3_symbol-1', 'F_3_symbol-2',
];

async function main() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 });
  await page.setCacheEnabled(false);

  await page.goto('http://localhost:5174/test-viewport.html?t=' + Date.now(), {
    waitUntil: 'networkidle0', timeout: 60000,
  });
  await page.waitForSelector('.pair canvas', { timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  // Inject comparison logic as a script, avoiding function name transforms
  const results: any[] = await page.evaluate(`
    (function() {
      var drawings = ${JSON.stringify(DRAWINGS)};
      var pairs = document.querySelectorAll('.pair');
      var results = [];
      var normSize = 200;
      var radius = 3;
      var colorTol = 50;

      pairs.forEach(function(pair) {
        var h3 = pair.querySelector('h3');
        var name = h3 ? h3.textContent : '';
        if (!drawings.some(function(d) { return name.indexOf(d) >= 0; })) return;

        var img = pair.querySelector('img');
        var canvas = pair.querySelector('canvas');
        if (!img || !canvas) return;

        var size = 320;
        // Render reference on white bg
        var refC = document.createElement('canvas');
        refC.width = size; refC.height = size;
        var rc = refC.getContext('2d');
        rc.fillStyle = '#fff';
        rc.fillRect(0, 0, size, size);
        rc.drawImage(img, 0, 0, size, size);
        var refData = rc.getImageData(0, 0, size, size);

        // Render ours on white bg
        var ourC = document.createElement('canvas');
        ourC.width = size; ourC.height = size;
        var oc = ourC.getContext('2d');
        oc.fillStyle = '#fff';
        oc.fillRect(0, 0, size, size);
        oc.drawImage(canvas, 0, 0, size, size);
        var ourData = oc.getImageData(0, 0, size, size);

        // Find bounding boxes of non-white content
        var refBBox = [size, size, 0, 0]; // minX, minY, maxX, maxY
        var ourBBox = [size, size, 0, 0];
        for (var y = 0; y < size; y++) {
          for (var x = 0; x < size; x++) {
            var i = (y * size + x) * 4;
            var rd = refData.data;
            if (rd[i+3] > 10 && !(rd[i] > 240 && rd[i+1] > 240 && rd[i+2] > 240)) {
              if (x < refBBox[0]) refBBox[0] = x;
              if (y < refBBox[1]) refBBox[1] = y;
              if (x > refBBox[2]) refBBox[2] = x;
              if (y > refBBox[3]) refBBox[3] = y;
            }
            var od = ourData.data;
            if (od[i+3] > 10 && !(od[i] > 240 && od[i+1] > 240 && od[i+2] > 240)) {
              if (x < ourBBox[0]) ourBBox[0] = x;
              if (y < ourBBox[1]) ourBBox[1] = y;
              if (x > ourBBox[2]) ourBBox[2] = x;
              if (y > ourBBox[3]) ourBBox[3] = y;
            }
          }
        }

        var rw = refBBox[2] - refBBox[0] + 1;
        var rh = refBBox[3] - refBBox[1] + 1;
        var ow = ourBBox[2] - ourBBox[0] + 1;
        var oh = ourBBox[3] - ourBBox[1] + 1;
        if (rw <= 0 || rh <= 0 || ow <= 0 || oh <= 0) return;

        // Normalize both to same bbox
        var nrc = document.createElement('canvas');
        nrc.width = normSize; nrc.height = normSize;
        var nrx = nrc.getContext('2d');
        nrx.fillStyle = '#fff'; nrx.fillRect(0, 0, normSize, normSize);
        nrx.drawImage(refC, refBBox[0], refBBox[1], rw, rh, 0, 0, normSize, normSize);
        var nrd = nrx.getImageData(0, 0, normSize, normSize);

        var noc = document.createElement('canvas');
        noc.width = normSize; noc.height = normSize;
        var nox = noc.getContext('2d');
        nox.fillStyle = '#fff'; nox.fillRect(0, 0, normSize, normSize);
        nox.drawImage(ourC, ourBBox[0], ourBBox[1], ow, oh, 0, 0, normSize, normSize);
        var nod = nox.getImageData(0, 0, normSize, normSize);

        // Coverage: for each content pixel in ref, is there content nearby in ours?
        var refContent = 0, covered = 0;
        for (var y = 0; y < normSize; y++) {
          for (var x = 0; x < normSize; x++) {
            var i = (y * normSize + x) * 4;
            var rd = nrd.data;
            if (rd[i+3] < 10 || (rd[i] > 240 && rd[i+1] > 240 && rd[i+2] > 240)) continue;
            refContent++;
            var found = false;
            for (var dy = -radius; dy <= radius && !found; dy++) {
              for (var dx = -radius; dx <= radius && !found; dx++) {
                var nx = x + dx, ny = y + dy;
                if (nx < 0 || nx >= normSize || ny < 0 || ny >= normSize) continue;
                var ni = (ny * normSize + nx) * 4;
                var od = nod.data;
                if (od[ni+3] > 10 && !(od[ni] > 240 && od[ni+1] > 240 && od[ni+2] > 240)) found = true;
              }
            }
            if (found) covered++;
          }
        }
        var coverageScore = refContent > 0 ? Math.round(covered / refContent * 100) : 0;

        // Color accuracy: for aligned content pixels
        var colorMatch = 0, colorTotal = 0;
        for (var i = 0; i < nrd.data.length; i += 4) {
          var rd = nrd.data, od = nod.data;
          var ri = rd[i+3] > 10 && !(rd[i] > 240 && rd[i+1] > 240 && rd[i+2] > 240);
          var oi = od[i+3] > 10 && !(od[i] > 240 && od[i+1] > 240 && od[i+2] > 240);
          if (!ri && !oi) continue;
          colorTotal++;
          if (!ri || !oi) continue;
          var dr = Math.abs(rd[i] - od[i]);
          var dg = Math.abs(rd[i+1] - od[i+1]);
          var db = Math.abs(rd[i+2] - od[i+2]);
          if (dr <= colorTol && dg <= colorTol && db <= colorTol) colorMatch++;
        }
        var colorScore = colorTotal > 0 ? Math.round(colorMatch / colorTotal * 100) : 0;

        // Shape: edge pixel overlap using Sobel-like gradient magnitude
        // Detects edges regardless of color (works for colored strokes too)
        function edgeMap(data, sz) {
          var edges = new Uint8Array(sz * sz);
          for (var ey = 1; ey < sz - 1; ey++) {
            for (var ex = 1; ex < sz - 1; ex++) {
              var maxGrad = 0;
              for (var ch = 0; ch < 3; ch++) {
                var tl = data[((ey-1)*sz+(ex-1))*4+ch], tc = data[((ey-1)*sz+ex)*4+ch], tr = data[((ey-1)*sz+(ex+1))*4+ch];
                var ml = data[(ey*sz+(ex-1))*4+ch], mr = data[(ey*sz+(ex+1))*4+ch];
                var bl = data[((ey+1)*sz+(ex-1))*4+ch], bc = data[((ey+1)*sz+ex)*4+ch], br = data[((ey+1)*sz+(ex+1))*4+ch];
                var gx = -tl - 2*ml - bl + tr + 2*mr + br;
                var gy = -tl - 2*tc - tr + bl + 2*bc + br;
                var g = Math.sqrt(gx*gx + gy*gy);
                if (g > maxGrad) maxGrad = g;
              }
              if (maxGrad > 30) edges[ey * sz + ex] = 1;
            }
          }
          return edges;
        }
        var refEdges = edgeMap(nrd.data, normSize);
        var ourEdges = edgeMap(nod.data, normSize);
        var refS = 0, bothS = 0;
        for (var y = 0; y < normSize; y++) {
          for (var x = 0; x < normSize; x++) {
            var idx = y * normSize + x;
            if (refEdges[idx]) {
              refS++;
              var found2 = false;
              for (var dy2 = -2; dy2 <= 2 && !found2; dy2++) {
                for (var dx2 = -2; dx2 <= 2 && !found2; dx2++) {
                  var nx2 = x+dx2, ny2 = y+dy2;
                  if (nx2 >= 0 && nx2 < normSize && ny2 >= 0 && ny2 < normSize && ourEdges[ny2*normSize+nx2]) found2 = true;
                }
              }
              if (found2) bothS++;
            }
          }
        }
        var shapeScore = refS > 0 ? Math.round(bothS / refS * 100) : 0;

        var overall = Math.round(coverageScore * 0.4 + colorScore * 0.3 + shapeScore * 0.3);
        results.push({ name: name, coverageScore: coverageScore, colorScore: colorScore, shapeScore: shapeScore, overallScore: overall });
      });

      return results;
    })()
  `);

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║              TVG Render Quality Report               ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║ Name                     Cover Color Shape  ALL ║');
  console.log('╠══════════════════════════════════════════════════════════╣');

  let totalOverall = 0;
  for (const r of results) {
    console.log(`║ ${r.name.padEnd(24)} ${String(r.coverageScore).padStart(4)}% ${String(r.colorScore).padStart(4)}% ${String(r.shapeScore).padStart(4)}% ${String(r.overallScore).padStart(4)}% ║`);
    totalOverall += r.overallScore;
  }
  const avgOverall = results.length > 0 ? Math.round(totalOverall / results.length) : 0;
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║ AVERAGE                                          ${String(avgOverall).padStart(4)}% ║`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  await browser.close();
}

main().catch(console.error);
