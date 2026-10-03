import type { Layer, Matrix } from './types';

/**
 * A layer is hidden in the FLA if it — or any ancestor it is linked under via
 * `parentLayerIndex` (its folder/group, or the layer it is parented to) — is
 * marked `visible: false`. This mirrors Adobe Animate's stage, where hiding a
 * folder or a parent layer hides everything linked beneath it (issue #12:
 * "group / parent child link layer" support).
 *
 * Layer-parenting *transforms* are handled separately (see `getRigParentIndex`
 * and the renderer's rig composition); this helper only cascades visibility.
 *
 * Shared by the canvas renderer and the SVG/video exporter so both agree.
 */
export function isLayerVisibleInFla(layers: Layer[], index: number): boolean {
  let i = index;
  const seen = new Set<number>();
  while (i >= 0 && i < layers.length && !seen.has(i)) {
    seen.add(i); // guard against malformed parent cycles
    const layer = layers[i];
    if (layer.visible === false) return false;
    if (layer.parentLayerIndex === undefined) break;
    i = layer.parentLayerIndex;
  }
  return true;
}

/**
 * Resolve the mask layer that clips layer `index`, or undefined if it is not
 * masked. Mirrors Animate's mask grouping:
 *
 * - An explicit `maskLayerIndex` (set by the XFL parser) wins if it names a
 *   mask layer.
 * - Otherwise the `parentLayerIndex` chain is walked up through folders: a
 *   layer parented to a mask — directly, or via a folder nested inside the mask
 *   group — is masked by it.
 * - A `layerType="masked"` layer with no usable parent link (e.g. the pre-CS5
 *   binary format, which only records the layer type) is masked by the nearest
 *   mask layer above it, across a contiguous run of masked layers.
 *
 * Guide and folder layers are never masked (they do not render).
 */
export function getMaskLayerIndex(layers: Layer[], index: number): number | undefined {
  const layer = layers[index];
  if (!layer) return undefined;
  const type = (layer.layerType as string | undefined)?.toLowerCase();
  if (type === 'guide' || type === 'folder' || type === 'mask') return undefined;
  // A malformed link to a layer that is not a mask is ignored: honoring it
  // would hide the layer (skipped as masked, but no mask group draws it).
  const explicit = layer.maskLayerIndex;
  if (explicit !== undefined && explicit !== index &&
      (layers[explicit]?.layerType as string | undefined)?.toLowerCase() === 'mask') {
    return explicit;
  }

  const seen = new Set<number>();
  let p = layer.parentLayerIndex;
  while (p !== undefined && p >= 0 && p < layers.length && !seen.has(p)) {
    seen.add(p);
    const parentType = (layers[p].layerType as string | undefined)?.toLowerCase();
    if (parentType === 'mask') return p;
    if (parentType !== 'folder') break;
    p = layers[p].parentLayerIndex;
  }

  if (type === 'masked' && layer.parentLayerIndex === undefined) {
    for (let i = index - 1; i >= 0; i--) {
      const aboveType = (layers[i].layerType as string | undefined)?.toLowerCase();
      if (aboveType === 'mask') return i;
      if (aboveType !== 'masked') break;
    }
  }
  return undefined;
}

/**
 * Index of the layer that `layers[index]` is RIG-parented to (Adobe Animate
 * "Layer Parenting"), or undefined.
 *
 * `parentLayerIndex` is overloaded in XFL: it also links a layer to its folder,
 * its mask, or its motion guide. Only a link from a normal layer to another
 * normal layer is a rig (transform) parent; folder / mask / guide links carry no
 * transform and are ignored here.
 */
export function getRigParentIndex(layers: Layer[], index: number): number | undefined {
  const pIdx = rigLink(layers, index);
  if (pIdx === undefined) return undefined;
  // A layer on a rig cycle (malformed data; Animate cannot author one) has no
  // rig parent, so every chain the renderer walks terminates.
  let i: number | undefined = pIdx;
  for (let steps = 0; i !== undefined && steps < layers.length; steps++) {
    if (i === index) return undefined;
    i = rigLink(layers, i);
  }
  return pIdx;
}

function rigLink(layers: Layer[], index: number): number | undefined {
  const layer = layers[index];
  if (!layer || layer.parentLayerIndex === undefined) return undefined;
  if (!isNormalLayerType(layer.layerType)) return undefined;
  if (layer.maskLayerIndex !== undefined) return undefined;
  const pIdx = layer.parentLayerIndex;
  if (pIdx === index) return undefined;
  const parent = layers[pIdx];
  if (!parent || !isNormalLayerType(parent.layerType)) return undefined;
  return pIdx;
}

function isNormalLayerType(t: Layer['layerType'] | undefined): boolean {
  return t === undefined || (t as string).toLowerCase() === 'normal';
}

/** result = m1 * m2 (apply m2 first, then m1). */
export function multiplyMatrices(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    tx: m1.a * m2.tx + m1.c * m2.ty + m1.tx,
    ty: m1.b * m2.tx + m1.d * m2.ty + m1.ty,
  };
}

/** Inverse of a 2D affine matrix, or null when it is (near-)singular. */
export function invertMatrix(m: Matrix): Matrix | null {
  const det = m.a * m.d - m.b * m.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
  const inv = 1 / det;
  return {
    a: m.d * inv,
    b: -m.b * inv,
    c: -m.c * inv,
    d: m.a * inv,
    tx: (m.c * m.ty - m.d * m.tx) * inv,
    ty: (m.b * m.tx - m.a * m.ty) * inv,
  };
}

/** True when two matrices are equal within a small tolerance. */
export function matricesNearlyEqual(m1: Matrix, m2: Matrix, eps = 1e-6): boolean {
  return (
    Math.abs(m1.a - m2.a) < eps &&
    Math.abs(m1.b - m2.b) < eps &&
    Math.abs(m1.c - m2.c) < eps &&
    Math.abs(m1.d - m2.d) < eps &&
    Math.abs(m1.tx - m2.tx) < eps * 1000 &&
    Math.abs(m1.ty - m2.ty) < eps * 1000
  );
}

/**
 * Whether a matrix only turns, scales evenly and moves (no stretch, skew or
 * mirror). Interpolating a classic tween commutes with such a matrix.
 */
export function isSimilarity(m: Matrix, eps = 1e-6): boolean {
  return Math.abs(m.a - m.d) < eps && Math.abs(m.b + m.c) < eps;
}

/**
 * A classic tween's matrix at `t` (0..1) between two keyframes, interpolated
 * the way Flash and the CreateJS runtime tween an instance: scale, skew angles
 * and position each separately, so a turning instance keeps its size (lerping
 * a..d shrinks it, to nothing halfway through a half turn). The rotation (the
 * Y skew angle) turns the short way round, or `spin` whole extra turns in the
 * given direction (`motionTweenRotate`); the X skew angle keeps its offset from
 * it, so a half turn can't shear the instance flat. A tween that mirrors the
 * instance, or runs between a mirrored key and one scaled flat (the
 * determinant changes sign or goes from negative to 0), is interpolated entry
 * by entry, through zero width.
 */
export function interpolateDecomposed(
  start: Matrix,
  end: Matrix,
  t: number,
  spin?: { direction: 'cw' | 'ccw'; turns: number }
): Matrix {
  const lerp = (a: number, b: number) => a + (b - a) * t;
  const detStart = start.a * start.d - start.b * start.c;
  const detEnd = end.a * end.d - end.b * end.c;
  if ((detStart < 0) !== (detEnd < 0) || !Number.isFinite(detStart * detEnd)) {
    return {
      a: lerp(start.a, end.a), b: lerp(start.b, end.b), c: lerp(start.c, end.c), d: lerp(start.d, end.d),
      tx: lerp(start.tx, end.tx), ty: lerp(start.ty, end.ty),
    };
  }
  // A mirrored matrix gets a negative x scale, so its skew angles stay close.
  // (A key scaled to nothing has angle 0, as in CreateJS.)
  const sign = detStart < 0 ? -1 : 1;
  const parts = (m: Matrix) => ({
    scaleX: sign * Math.hypot(m.a, m.b),
    scaleY: Math.hypot(m.c, m.d),
    skewY: Math.atan2(sign * m.b, sign * m.a),
    skewX: Math.atan2(-m.c, m.d),
  });
  const from = parts(start);
  const to = parts(end);
  const TURN = 2 * Math.PI;
  const wrap = (d: number) => d - TURN * Math.round(d / TURN);
  // Keys at the same angle (up to rounding) don't spin a whole extra turn.
  let turnY = wrap(to.skewY - from.skewY);
  if (Math.abs(turnY) < 1e-6) turnY = 0;
  if (spin?.direction === 'cw') {
    if (turnY < 0) turnY += TURN;
    turnY += TURN * spin.turns;
  } else if (spin?.direction === 'ccw') {
    if (turnY > 0) turnY -= TURN;
    turnY -= TURN * spin.turns;
  }
  const turnX = turnY + wrap(to.skewX - from.skewX - turnY);
  const scaleX = lerp(from.scaleX, to.scaleX);
  const scaleY = lerp(from.scaleY, to.scaleY);
  const skewY = from.skewY + turnY * t;
  const skewX = from.skewX + turnX * t;
  return {
    a: scaleX * Math.cos(skewY),
    b: scaleX * Math.sin(skewY),
    c: -scaleY * Math.sin(skewX),
    d: scaleY * Math.cos(skewX),
    tx: lerp(start.tx, end.tx),
    ty: lerp(start.ty, end.ty),
  };
}
