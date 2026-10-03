import type { PathCommand } from './types';

/**
 * Geometry for Flash CS3+ primitive shapes (Rectangle/Oval Primitive tools).
 * XFL stores them as <DOMRectangleObject>/<DOMOvalObject> with their parameters
 * and a singular <fill>/<stroke>, but no <edges>, so the outline is rebuilt here.
 * All coordinates are in the element's own space (before its <matrix>), in pixels.
 */

// Cubic Bezier handle length for a quarter circle of radius 1.
const KAPPA = 0.5522847498;

export interface RectanglePrimitive {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Corner radii; negative values cut the corner inwards (concave), as Flash allows. */
  topLeftRadius: number;
  topRightRadius: number;
  bottomRightRadius: number;
  bottomLeftRadius: number;
}

/** Closed outline of a (rounded) rectangle primitive, clockwise on screen, ending in Z. */
export function rectanglePrimitivePath(r: RectanglePrimitive): PathCommand[] {
  const { x, y } = r;
  const w = Math.max(0, r.width);
  const h = Math.max(0, r.height);
  const limit = Math.min(w, h) / 2;
  const clamp = (v: number) => Math.sign(v) * Math.min(Math.abs(v), limit);
  const tl = clamp(r.topLeftRadius);
  const tr = clamp(r.topRightRadius);
  const br = clamp(r.bottomRightRadius);
  const bl = clamp(r.bottomLeftRadius);

  const cmds: PathCommand[] = [{ type: 'M', x: x + Math.abs(tl), y }];
  // Each corner: (cx, cy) is the rectangle corner; (dx1, dy1)/(dx2, dy2) are the
  // unit directions from the corner to the arc's start and end points.
  const corner = (rad: number, cx: number, cy: number, dx1: number, dy1: number, dx2: number, dy2: number) => {
    const a = Math.abs(rad);
    const sx = cx + dx1 * a, sy = cy + dy1 * a; // arc start (already the current point)
    const ex = cx + dx2 * a, ey = cy + dy2 * a; // arc end
    if (a === 0) {
      cmds.push({ type: 'L', x: cx, y: cy });
    } else if (rad > 0) {
      // Convex: quarter ellipse centred inside the rectangle, handles toward the corner.
      cmds.push({
        type: 'C',
        c1x: sx - dx1 * a * KAPPA, c1y: sy - dy1 * a * KAPPA,
        c2x: ex - dx2 * a * KAPPA, c2y: ey - dy2 * a * KAPPA,
        x: ex, y: ey,
      });
    } else {
      // Concave: quarter circle centred on the corner itself.
      cmds.push({
        type: 'C',
        c1x: sx + dx2 * a * KAPPA, c1y: sy + dy2 * a * KAPPA,
        c2x: ex + dx1 * a * KAPPA, c2y: ey + dy1 * a * KAPPA,
        x: ex, y: ey,
      });
    }
  };

  cmds.push({ type: 'L', x: x + w - Math.abs(tr), y });
  corner(tr, x + w, y, -1, 0, 0, 1);
  cmds.push({ type: 'L', x: x + w, y: y + h - Math.abs(br) });
  corner(br, x + w, y + h, 0, -1, -1, 0);
  cmds.push({ type: 'L', x: x + Math.abs(bl), y: y + h });
  corner(bl, x, y + h, 1, 0, 0, -1);
  cmds.push({ type: 'L', x, y: y + Math.abs(tl) });
  corner(tl, x, y, 0, 1, 1, 0);
  // Close explicitly so a stroke joins at the start point instead of capping it.
  cmds.push({ type: 'Z' });
  return cmds;
}

export interface OvalPrimitive {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees. Equal start and end angles mean a full ellipse. */
  startAngle: number;
  endAngle: number;
  /** Inner (hole) radius as a percentage of the outer radius, 0..99. */
  innerRadius: number;
  /** For a partial arc: false leaves the arc open (stroke only, no fill). */
  closePath: boolean;
}

/**
 * Elliptical arc from angle a0 to a1 (radians, a1 > a0 or a1 < a0) as cubic
 * segments of at most 90 degrees, starting at the current point.
 */
function arc(cmds: PathCommand[], cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): void {
  const segments = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2) - 1e-9));
  const step = (a1 - a0) / segments;
  const k = (4 / 3) * Math.tan(step / 4);
  for (let i = 0; i < segments; i++) {
    const t0 = a0 + i * step;
    const t1 = t0 + step;
    const c0 = Math.cos(t0), s0 = Math.sin(t0);
    const c1 = Math.cos(t1), s1 = Math.sin(t1);
    cmds.push({
      type: 'C',
      c1x: cx + rx * (c0 - k * s0), c1y: cy + ry * (s0 + k * c0),
      c2x: cx + rx * (c1 + k * s1), c2y: cy + ry * (s1 - k * c1),
      x: cx + rx * c1, y: cy + ry * s1,
    });
  }
}

/**
 * Outline of an oval primitive. Angles are measured from 3 o'clock and grow
 * clockwise on screen (y points down), like the Oval Primitive tool's handles.
 * Returns one command list per contour (a full ring has two) and whether the
 * outline is a closed, fillable area. Closed contours end in Z, so strokes join
 * at the start point.
 */
export function ovalPrimitivePath(o: OvalPrimitive): { contours: PathCommand[][]; closed: boolean } {
  const rx = Math.max(0, o.width) / 2;
  const ry = Math.max(0, o.height) / 2;
  const cx = o.x + rx;
  const cy = o.y + ry;
  const inner = Math.min(Math.max(o.innerRadius, 0), 99) / 100;
  const irx = rx * inner;
  const iry = ry * inner;
  const toRad = Math.PI / 180;
  const at = (a: number, sx: number, sy: number) => ({ x: cx + sx * Math.cos(a), y: cy + sy * Math.sin(a) });

  let sweep = (((o.endAngle - o.startAngle) % 360) + 360) % 360;
  const full = sweep === 0;
  if (full) sweep = 360;
  const a0 = o.startAngle * toRad;
  const a1 = a0 + sweep * toRad;

  const start = at(a0, rx, ry);
  const outer: PathCommand[] = [{ type: 'M', x: start.x, y: start.y }];
  arc(outer, cx, cy, rx, ry, a0, a1);

  if (full) {
    outer.push({ type: 'Z' });
    if (inner === 0) return { contours: [outer], closed: true };
    // Hole: the inner ellipse wound the other way, so nonzero filling leaves it empty.
    const s = at(a0, irx, iry);
    const hole: PathCommand[] = [{ type: 'M', x: s.x, y: s.y }];
    arc(hole, cx, cy, irx, iry, a0, a0 - 2 * Math.PI);
    hole.push({ type: 'Z' });
    return { contours: [outer, hole], closed: true };
  }

  if (!o.closePath) {
    return { contours: [outer], closed: false };
  }
  if (inner > 0) {
    const e = at(a1, irx, iry);
    outer.push({ type: 'L', x: e.x, y: e.y });
    arc(outer, cx, cy, irx, iry, a1, a0);
  } else {
    outer.push({ type: 'L', x: cx, y: cy });
  }
  outer.push({ type: 'L', x: start.x, y: start.y }, { type: 'Z' });
  return { contours: [outer], closed: true };
}
