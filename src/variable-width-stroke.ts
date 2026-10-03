import type { PathCommand, StrokeStyle, WidthMarker } from './types';

/**
 * Variable-width strokes (Animate CC Width tool and width profiles). XFL keeps the
 * profile on the stroke style (<SolidStroke><VariablePointWidth><WidthMarker>), and
 * Animate applies it to each stroked path of the shape:
 *  - a path is a run of edge records in one <Edge> whose records join end to start, in
 *    the order the `edges` string lists them; a moveTo elsewhere starts a new path;
 *  - `position` is the fraction of that path's length from its first record;
 *  - `left`/`right` are half-widths as fractions of the weight (0.5 + 0.5 = weight).
 * These were fitted against Animate's own rasterization of a real file (a closed brushed
 * loop published to a CreateJS sprite atlas): the whole run starting at the first record
 * beat each record or cubic span on its own, every other start point, and a parametric
 * position. Between markers the width follows a cubic Hermite curve with Catmull-Rom
 * slopes, one-sided at `type="corner"` markers and at the ends; that fit Animate's
 * rasterization as well as linear or smoothstep did, so the curve shape is inferred.
 *
 * The stroke is drawn as a filled outline: each side of the path offset by its
 * half-width, joined round the outside of bends and capped at the ends of open paths.
 * One polygon per path, not a union of small pieces, so anti-aliasing leaves no seams.
 */

// Endpoints closer than this (px) join into one path; the same tolerance the renderer
// uses to drop a redundant moveTo when it strokes an edge.
const JOIN_EPSILON = 0.5;
// Curves are flattened into chords about this long (px, in the shape's own space).
const FLATTEN_STEP = 1;
const MAX_CURVE_STEPS = 256;
// The width profile is sampled at least this many times along each path.
const PROFILE_SAMPLES = 256;

interface Side {
  left: number;
  right: number;
}

// Slope of one side's width at marker i, for the span leaving it (`out`) or arriving
// at it (`in`). Corner markers and the two ends use the span's own secant.
function markerSlope(markers: readonly WidthMarker[], i: number, side: keyof Side, dir: 'in' | 'out'): number {
  const m = markers[i];
  const prev = markers[i - 1];
  const next = markers[i + 1];
  if (m.corner || !prev || !next) {
    const other = dir === 'out' ? next : prev;
    if (!other || other.position === m.position) return 0;
    return (other[side] - m[side]) / (other.position - m.position);
  }
  const span = next.position - prev.position;
  return span > 0 ? (next[side] - prev[side]) / span : 0;
}

/**
 * Half-widths at `position` (0..1 along the path), as fractions of the stroke weight.
 * Before the first marker and after the last one the end marker's width holds.
 */
export function widthProfileAt(markers: readonly WidthMarker[], position: number): Side {
  const n = markers.length;
  if (n === 0) return { left: 0.5, right: 0.5 };
  const first = markers[0];
  const last = markers[n - 1];
  if (position <= first.position) return { left: first.left, right: first.right };
  if (position >= last.position) return { left: last.left, right: last.right };
  let i = 0;
  while (i < n - 2 && position >= markers[i + 1].position) i++;
  const a = markers[i];
  const b = markers[i + 1];
  const h = b.position - a.position;
  if (h <= 0) return { left: b.left, right: b.right };
  const t = (position - a.position) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const hermite = (side: keyof Side) =>
    Math.max(0,
      (2 * t3 - 3 * t2 + 1) * a[side] +
      (t3 - 2 * t2 + t) * h * markerSlope(markers, i, side, 'out') +
      (-2 * t3 + 3 * t2) * b[side] +
      (t3 - t2) * h * markerSlope(markers, i + 1, side, 'in'));
  return { left: hermite('left'), right: hermite('right') };
}

interface Run {
  points: number[]; // x0, y0, x1, y1, ...
  closed: boolean;
}

// Split an edge's commands into stroked paths and flatten their curves.
function flattenRuns(commands: readonly PathCommand[]): Run[] {
  const runs: Run[] = [];
  let run: Run | null = null;
  let x = NaN;
  let y = NaN;
  let moved = false; // a moveTo started a path that has drawn nothing yet
  const finish = () => {
    if (run) runs.push(run); // one point: a stroke that went nowhere (a dot)
    run = null;
  };
  const push = (px: number, py: number) => {
    moved = false;
    if (!run) run = { points: [x, y], closed: false };
    const p = run.points;
    if (Math.abs(p[p.length - 2] - px) > 1e-9 || Math.abs(p[p.length - 1] - py) > 1e-9) p.push(px, py);
    x = px;
    y = py;
  };
  for (const cmd of commands) {
    if ('x' in cmd && (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y))) continue;
    switch (cmd.type) {
      case 'M': {
        const continues = run !== null && Math.abs(cmd.x - x) <= JOIN_EPSILON && Math.abs(cmd.y - y) <= JOIN_EPSILON;
        if (continues) {
          push(cmd.x, cmd.y);
        } else {
          finish();
          x = cmd.x;
          y = cmd.y;
          moved = true;
        }
        break;
      }
      case 'L':
        if (!Number.isNaN(x)) push(cmd.x, cmd.y);
        break;
      case 'Q': {
        if (Number.isNaN(x) || !Number.isFinite(cmd.cx) || !Number.isFinite(cmd.cy)) break;
        const x0 = x;
        const y0 = y;
        const len = Math.hypot(cmd.cx - x0, cmd.cy - y0) + Math.hypot(cmd.x - cmd.cx, cmd.y - cmd.cy);
        const steps = Math.min(MAX_CURVE_STEPS, Math.max(1, Math.ceil(len / FLATTEN_STEP)));
        for (let k = 1; k <= steps; k++) {
          const t = k / steps;
          const mt = 1 - t;
          push(mt * mt * x0 + 2 * mt * t * cmd.cx + t * t * cmd.x, mt * mt * y0 + 2 * mt * t * cmd.cy + t * t * cmd.y);
        }
        break;
      }
      case 'C': {
        if (Number.isNaN(x)) break;
        const x0 = x;
        const y0 = y;
        const len = Math.hypot(cmd.c1x - x0, cmd.c1y - y0) + Math.hypot(cmd.c2x - cmd.c1x, cmd.c2y - cmd.c1y) +
          Math.hypot(cmd.x - cmd.c2x, cmd.y - cmd.c2y);
        const steps = Math.min(MAX_CURVE_STEPS, Math.max(1, Math.ceil(len / FLATTEN_STEP)));
        for (let k = 1; k <= steps; k++) {
          const t = k / steps;
          const mt = 1 - t;
          const a = mt * mt * mt;
          const b = 3 * mt * mt * t;
          const c = 3 * mt * t * t;
          const d = t * t * t;
          push(a * x0 + b * cmd.c1x + c * cmd.c2x + d * cmd.x, a * y0 + b * cmd.c1y + c * cmd.c2y + d * cmd.y);
        }
        break;
      }
      case 'Z': {
        // The edge decoder writes a zero-length record as a moveTo and a close.
        if (moved) push(x, y);
        const current = run as Run | null;
        if (current) {
          const p = current.points;
          push(p[0], p[1]);
          current.closed = true;
          x = p[0];
          y = p[1];
        }
        finish();
        break;
      }
    }
  }
  finish();
  for (const r of runs) {
    const p = r.points;
    const n = p.length;
    // A path that ends where it started is a loop, unless it is a dab too short to
    // tell its ends apart: that keeps its caps, even when it was closed (the edge
    // decoder closes a path that ends within 0.5px of its start).
    let length = 0;
    for (let i = 2; i < n; i += 2) length += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
    if (length <= 4 * JOIN_EPSILON) {
      r.closed = false;
    } else if (!r.closed &&
        Math.abs(p[0] - p[n - 2]) <= JOIN_EPSILON && Math.abs(p[1] - p[n - 1]) <= JOIN_EPSILON) {
      r.closed = true;
      p[n - 2] = p[0];
      p[n - 1] = p[1];
    }
  }
  return runs;
}

// Points that round off (or miter) the outside of a bend at (px, py), from normal a to
// normal b with radii ra -> rb. The two edge points themselves are not included.
function joinPoints(
  out: number[], px: number, py: number,
  ax: number, ay: number, bx: number, by: number,
  ra: number, rb: number, forwardX: number, forwardY: number,
  joints: StrokeStyle['joints'], miterLimit: number,
): void {
  let angle = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
  // A U-turn bulges forward, the way the path was heading.
  if (Math.abs(Math.abs(angle) - Math.PI) < 1e-6) angle = Math.PI * Math.sign(ax * forwardY - ay * forwardX || 1);
  if (joints === 'miter') {
    const half = Math.cos(angle / 2);
    const mx = ax + bx;
    const my = ay + by;
    const ml = Math.hypot(mx, my);
    if (half > 1e-9 && 1 / half <= miterLimit && ml > 0) {
      const r = (ra + rb) / 2 / half;
      out.push(px + (mx / ml) * r, py + (my / ml) * r);
    }
  } else if (joints !== 'bevel') {
    const steps = Math.ceil(Math.abs(angle) / (Math.PI / 16));
    const a0 = Math.atan2(ay, ax);
    for (let k = 1; k < steps; k++) {
      const f = k / steps;
      const r = ra + (rb - ra) * f;
      out.push(px + Math.cos(a0 + angle * f) * r, py + Math.sin(a0 + angle * f) * r);
    }
  }
}

// Where segments a0-a1 and b0-b1 cross, or null when they don't.
function crossing(
  a0x: number, a0y: number, a1x: number, a1y: number,
  b0x: number, b0y: number, b1x: number, b1y: number,
): [number, number] | null {
  const rx = a1x - a0x, ry = a1y - a0y, sx = b1x - b0x, sy = b1y - b0y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const qx = b0x - a0x, qy = b0y - a0y;
  const t = (qx * sy - qy * sx) / denom;
  const u = (qx * ry - qy * rx) / denom;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return [a0x + rx * t, a0y + ry * t];
}

/**
 * One side of a sampled path, offset by `h` along `side` times the left normal
 * (dy, -dx). The outside of a bend gets the join; the inside meets where the two
 * offset edges cross, or, where a tight bend folds them past each other, goes in to
 * the centre point and back out so the nonzero fill keeps the fold covered.
 */
function offsetSide(
  p: readonly number[], dx: readonly number[], dy: readonly number[], h: readonly number[],
  side: 1 | -1, closed: boolean, joints: StrokeStyle['joints'], miterLimit: number,
): number[] {
  const n = p.length / 2;
  const out: number[] = [];
  const ox = (i: number, k: number) => p[2 * i] + side * dy[k] * h[i];
  const oy = (i: number, k: number) => p[2 * i + 1] - side * dx[k] * h[i];
  // Bend between segment k1 (ending at point i1) and segment k2 (starting at point i2,
  // the same position; they differ only where a closed path wraps around).
  const bend = (k1: number, i1: number, k2: number, i2: number) => {
    const a1x = ox(i1, k1), a1y = oy(i1, k1);
    const b0x = ox(i2, k2), b0y = oy(i2, k2);
    const cross = dx[k1] * dy[k2] - dy[k1] * dx[k2];
    const dot = dx[k1] * dx[k2] + dy[k1] * dy[k2];
    if (Math.abs(cross) < 1e-12 && dot > 0) {
      out.push(a1x, a1y);
      if (Math.hypot(b0x - a1x, b0y - a1y) > 1e-9) out.push(b0x, b0y);
      return;
    }
    const px = p[2 * i2], py = p[2 * i2 + 1];
    if (side * cross > 0 || (Math.abs(cross) < 1e-12 && side > 0)) {
      out.push(a1x, a1y);
      joinPoints(out, px, py, side * dy[k1], -side * dx[k1], side * dy[k2], -side * dx[k2],
        h[i1], h[i2], dx[k1], dy[k1], joints, miterLimit);
      out.push(b0x, b0y);
      return;
    }
    const meet = crossing(ox(k1, k1), oy(k1, k1), a1x, a1y, b0x, b0y, ox(k2 + 1, k2), oy(k2 + 1, k2));
    if (meet) out.push(meet[0], meet[1]);
    else out.push(a1x, a1y, px, py, b0x, b0y);
  };
  if (closed) {
    bend(n - 2, n - 1, 0, 0);
  } else {
    out.push(ox(0, 0), oy(0, 0));
  }
  for (let i = 1; i < n - 1; i++) bend(i - 1, i, i, i);
  if (!closed) out.push(ox(n - 1, n - 2), oy(n - 1, n - 2));
  return out;
}

// Cap points at an open end (px, py), from the edge `from` (half-width hf) round to the
// opposite edge (half-width ht). (nx, ny) points to the `from` side, (fx, fy) out of the
// path. The two edge points themselves are not included.
function capPoints(
  out: number[], px: number, py: number, nx: number, ny: number, fx: number, fy: number,
  hf: number, ht: number, caps: StrokeStyle['caps'],
): void {
  const back = (hf + ht) / 2;
  if (caps === 'square') {
    out.push(px + nx * hf + fx * back, py + ny * hf + fy * back, px - nx * ht + fx * back, py - ny * ht + fy * back);
  } else if (caps !== 'none') {
    // A quarter ellipse on each side (a half circle when both sides match).
    const steps = 16;
    for (let k = 1; k < steps; k++) {
      const phi = (Math.PI * k) / steps;
      const c = Math.cos(phi);
      const lateral = c * (c >= 0 ? hf : ht);
      const forward = Math.sin(phi) * back;
      out.push(px + nx * lateral + fx * forward, py + ny * lateral + fy * forward);
    }
  }
}

function reversePoints(points: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = points.length - 2; i >= 0; i -= 2) out.push(points[i], points[i + 1]);
  return out;
}

/**
 * Outline of a variable-width stroke along one edge's commands, as closed polygons
 * (flat x, y arrays) to fill together with the nonzero rule: one per open path, two
 * (outside and inside, wound opposite ways) per closed one. "Left" is the left of the
 * path's direction as drawn on screen (y down).
 */
export function variableWidthStrokePolygons(
  commands: readonly PathCommand[],
  stroke: Pick<StrokeStyle, 'weight' | 'caps' | 'joints' | 'miterLimit' | 'widthMarkers'>,
): number[][] {
  const markers = stroke.widthMarkers ?? [];
  const caps = stroke.caps ?? 'round';
  const joints = stroke.joints ?? 'round';
  const miterLimit = stroke.miterLimit ?? 3;
  const polygons: number[][] = [];

  for (const run of flattenRuns(commands)) {
    const q = run.points;
    const m = q.length / 2;
    const cum = [0];
    for (let i = 1; i < m; i++) cum.push(cum[i - 1] + Math.hypot(q[2 * i] - q[2 * i - 2], q[2 * i + 1] - q[2 * i - 1]));
    const total = cum[m - 1];
    if (!(total > 1e-9)) {
      // A dot: both caps, back to back (nothing without caps).
      const w = widthProfileAt(markers, 0);
      const [x, y] = q;
      if (caps === 'none') continue;
      const dot = [x, y - w.left * stroke.weight];
      capPoints(dot, x, y, 0, -1, 1, 0, w.left * stroke.weight, w.right * stroke.weight, caps);
      dot.push(x, y + w.right * stroke.weight);
      capPoints(dot, x, y, 0, 1, -1, 0, w.right * stroke.weight, w.left * stroke.weight, caps);
      polygons.push(dot);
      continue;
    }

    // Resample so the width follows the profile between the path's own vertices: no
    // more than total / PROFILE_SAMPLES apart, plus a point exactly at each marker.
    const step = total / PROFILE_SAMPLES;
    const stops = markers.map((marker) => marker.position * total);
    const p: number[] = [];
    const dist: number[] = [];
    for (let k = 0; k < m - 1; k++) {
      const d0 = cum[k];
      const d1 = cum[k + 1];
      const at = [d0];
      for (let d = (Math.floor(d0 / step) + 1) * step; d < d1; d += step) at.push(d);
      for (const d of stops) if (d > d0 && d < d1) at.push(d);
      at.sort((a, b) => a - b);
      for (const d of at) {
        if (dist.length && d - dist[dist.length - 1] < 1e-9) continue;
        const f = (d - d0) / (d1 - d0);
        p.push(q[2 * k] + (q[2 * k + 2] - q[2 * k]) * f, q[2 * k + 1] + (q[2 * k + 3] - q[2 * k + 1]) * f);
        dist.push(d);
      }
    }
    if (total - dist[dist.length - 1] < 1e-9) {
      p.length -= 2;
      dist.pop();
    }
    p.push(q[2 * m - 2], q[2 * m - 1]);
    dist.push(total);
    const n = dist.length;

    const hl: number[] = [];
    const hr: number[] = [];
    for (let i = 0; i < n; i++) {
      const w = widthProfileAt(markers, dist[i] / total);
      hl.push(w.left * stroke.weight);
      hr.push(w.right * stroke.weight);
    }
    // Unit direction of each segment; its left normal is (dy, -dx).
    const dx: number[] = [];
    const dy: number[] = [];
    for (let k = 0; k < n - 1; k++) {
      const len = Math.hypot(p[2 * k + 2] - p[2 * k], p[2 * k + 3] - p[2 * k + 1]);
      dx.push((p[2 * k + 2] - p[2 * k]) / len);
      dy.push((p[2 * k + 3] - p[2 * k + 1]) / len);
    }

    const left = offsetSide(p, dx, dy, hl, 1, run.closed, joints, miterLimit);
    const right = offsetSide(p, dx, dy, hr, -1, run.closed, joints, miterLimit);
    if (run.closed) {
      polygons.push(left, reversePoints(right));
      continue;
    }
    // Left side forward, round the end, right side back, round the start.
    const k = n - 2;
    const outline = left;
    capPoints(outline, p[2 * n - 2], p[2 * n - 1], dy[k], -dx[k], dx[k], dy[k], hl[n - 1], hr[n - 1], caps);
    outline.push(...reversePoints(right));
    capPoints(outline, p[0], p[1], -dy[0], dx[0], -dx[0], -dy[0], hr[0], hl[0], caps);
    polygons.push(outline);
  }
  return polygons;
}

/** The polygons as SVG path data (nonzero fill). */
export function polygonsToSvgPathData(polygons: readonly number[][]): string {
  const r = (v: number) => Math.round(v * 100) / 100;
  return polygons.map((poly) => {
    let d = `M${r(poly[0])} ${r(poly[1])}`;
    for (let i = 2; i < poly.length; i += 2) d += `L${r(poly[i])} ${r(poly[i + 1])}`;
    return d + 'Z';
  }).join('');
}
