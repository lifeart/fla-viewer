import type { DisplayElement, Matrix, Point } from './types';
import { invertMatrix, multiplyMatrices } from './layer-utils';

// 3D symbol instances (Flash CS4+): `rotationX/Y/Z` and `centerPoint3DX/Y` on
// a `<DOMSymbolInstance>`, seen through the document's perspective
// (`viewAngle3D`, `vanishingPoint3DX/Y` on `<DOMDocument>`). Flash publishes
// such an instance as a Matrix3D (fl.motion.AnimatorFactory3D) that the player
// projects, so the saved 2D matrix is not what Flash shows: in real files it is
// only the instance's position, with no foreshortening.
//
// - Rotation is R = Rz * Ry * Rx (X applied first), with the axis matrices of
//   fl.motion.MatrixTransformer3D, in the order fl.motion.Animator3D builds
//   them. A single-axis rotation matches the 3x3 part of the `matrix3D` Flash
//   saves beside it.
// - The instance turns about its 3D center point (parent coordinates; the
//   transformation point's position unless it was moved) and is then projected
//   toward the vanishing point, scaled by f / (f + z), where
//   f = (stageWidth / 2) / tan(viewAngle3D / 2) (AS3 PerspectiveProjection;
//   the default angle is 55 degrees).
// - Canvas 2D draws only affine transforms, so the projection is linearized at
//   the 3D center: exact there, first order across the instance (the far side
//   is drawn as large as the near side).

/** Flash's default perspective angle (AS3 `PerspectiveProjection.fieldOfView`). */
export const DEFAULT_VIEW_ANGLE_3D = 55;

export interface Perspective {
  focalLength: number;
  /** The vanishing point, in stage coordinates. */
  center: Point;
}

/** A 3x3 rotation, row-major: `r[row][column]`. */
export type Rotation3D = number[][];

export function documentPerspective(doc: {
  width: number;
  height: number;
  viewAngle3D?: number;
  vanishingPoint3D?: Point;
}): Perspective {
  const angle = doc.viewAngle3D !== undefined && doc.viewAngle3D > 0 && doc.viewAngle3D < 180
    ? doc.viewAngle3D
    : DEFAULT_VIEW_ANGLE_3D;
  return {
    focalLength: doc.width / 2 / Math.tan((angle * Math.PI) / 360),
    center: doc.vanishingPoint3D ?? { x: doc.width / 2, y: doc.height / 2 },
  };
}

function multiply3(m1: Rotation3D, m2: Rotation3D): Rotation3D {
  return m1.map((row) => [0, 1, 2].map((j) => row[0] * m2[0][j] + row[1] * m2[1][j] + row[2] * m2[2][j]));
}

/** R = Rz * Ry * Rx for rotations in degrees. */
export function rotation3D(rotationX = 0, rotationY = 0, rotationZ = 0): Rotation3D {
  const rad = Math.PI / 180;
  const [cx, sx] = [Math.cos(rotationX * rad), Math.sin(rotationX * rad)];
  const [cy, sy] = [Math.cos(rotationY * rad), Math.sin(rotationY * rad)];
  const [cz, sz] = [Math.cos(rotationZ * rad), Math.sin(rotationZ * rad)];
  const rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]];
  const ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];
  return multiply3(rz, multiply3(ry, rx));
}

/**
 * The 2D matrix that draws a 3D instance in its parent's space, replacing its
 * plain `matrix`: rotated by `rotation` about `pivot` (parent coordinates),
 * moved `z` away from the viewer, and projected with `perspective`, linearized
 * at the pivot. `toStage` maps the parent's space to the stage. Null when the
 * pivot is at or behind the viewer (nothing is drawn).
 */
export function projectedInstanceMatrix(
  matrix: Matrix,
  pivot: Point,
  rotation: Rotation3D,
  z: number,
  toStage: Matrix,
  perspective: Perspective
): Matrix | null {
  const f = perspective.focalLength;
  const depth = f + z;
  if (!(depth > 0)) return null;
  const fromStage = invertMatrix(toStage);
  if (!fromStage) return null;
  const k = f / depth;
  const g = toStage;
  const r = rotation;
  // The pivot on the stage, relative to the vanishing point.
  const vx = g.a * pivot.x + g.c * pivot.y + g.tx - perspective.center.x;
  const vy = g.b * pivot.x + g.d * pivot.y + g.ty - perspective.center.y;
  // The projection's derivative at the pivot, per parent-space offset u:
  // k * (G * R_xy - v * R_z / depth), where R_z * u is u's added depth.
  const a = k * (g.a * r[0][0] + g.c * r[1][0] - (vx * r[2][0]) / depth);
  const c = k * (g.a * r[0][1] + g.c * r[1][1] - (vx * r[2][1]) / depth);
  const b = k * (g.b * r[0][0] + g.d * r[1][0] - (vy * r[2][0]) / depth);
  const d = k * (g.b * r[0][1] + g.d * r[1][1] - (vy * r[2][1]) / depth);
  // The pivot's projected stage position.
  const sx = perspective.center.x + vx * k;
  const sy = perspective.center.y + vy * k;
  const stage: Matrix = { a, b, c, d, tx: sx - a * pivot.x - c * pivot.y, ty: sy - b * pivot.x - d * pivot.y };
  return multiplyMatrices(multiplyMatrices(fromStage, stage), matrix);
}

/**
 * `element` with its matrix replaced (by a tween, a layer-parenting correction
 * or an IK pose). A 3D instance's center point is in parent coordinates, so it
 * goes where the new matrix takes the point of the instance it was on (it turns
 * with the instance when it is off the transformation point). A center on the
 * transformation point (within 1px), or an old matrix scaled to nothing, moves
 * with the transformation point instead: mapping back through a tiny scale
 * would magnify the rounding between them.
 */
export function withInstanceMatrix<T extends DisplayElement>(element: T, matrix: Matrix): T {
  if (element.type !== 'symbol' || !element.centerPoint3D) return { ...element, matrix };
  const center = element.centerPoint3D;
  const { x, y } = element.transformationPoint ?? { x: 0, y: 0 };
  const from = element.matrix;
  const onPoint = Math.hypot(center.x - (from.a * x + from.c * y + from.tx), center.y - (from.b * x + from.d * y + from.ty)) <= 1;
  const inverse = onPoint ? null : invertMatrix(from);
  if (inverse) {
    const m = multiplyMatrices(matrix, inverse);
    return {
      ...element,
      matrix,
      centerPoint3D: { x: m.a * center.x + m.c * center.y + m.tx, y: m.b * center.x + m.d * center.y + m.ty },
    };
  }
  return {
    ...element,
    matrix,
    centerPoint3D: {
      x: center.x + (matrix.a * x + matrix.c * y + matrix.tx) - (from.a * x + from.c * y + from.tx),
      y: center.y + (matrix.b * x + matrix.d * y + matrix.ty) - (from.b * x + from.d * y + from.ty),
    },
  };
}
