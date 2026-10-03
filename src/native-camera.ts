import type { Layer, Matrix } from './types';
import { invertMatrix, multiplyMatrices } from './layer-utils';

// Animate's native camera (CC 2017+) and layer depth (Animate 2019+), applied the
// way Animate's HTML5 Canvas runtime does it (`AdobeAn.VirtualCamera` and
// `_applyLayerZDepth` / `_getProjectionMatrix` in the published JS):
//
// - The camera layer (`layerType="camera"`) holds one `__Camera__` instance. Its
//   symbol is a stage-sized rectangle centered on its origin, so the default
//   camera matrix is a translation to the stage center; zoom is 1/scale and
//   camera rotation is the negated instance rotation. A layer that is not
//   attached to the camera is drawn through
//   `translate(stageCenter) * inverse(cameraMatrix)`.
// - A layer's depth z (`frameZDepth` on its keyframes, minus the camera's own
//   depth unless the layer is attached to the camera) scales it about the stage
//   center by focalLength / (focalLength + z). Nearer layers (negative z) grow
//   and move faster when the camera pans: parallax. At z <= -focalLength the
//   layer is behind the camera and is not drawn.
// - Root layers are stacked by depth, furthest first; layers at equal depth
//   keep their timeline order.

/**
 * The runtime's fixed focal length. It is close to the 3D focal length of
 * Flash's default 55 degree field of view on a 550px-wide stage (528.27; see
 * src/transform-3d.ts), which Animate documents of other sizes usually keep.
 */
export const LAYER_DEPTH_FOCAL_LENGTH = 528.25;

export interface StageCamera {
  /** The `__Camera__` instance's matrix at the frame. */
  matrix: Matrix;
  /** The camera layer's own depth at the frame. */
  zDepth: number;
}

export interface StageLayerViews {
  /** Per layer: maps its content to the stage, or null when it is behind the camera. */
  matrices: (Matrix | null)[];
  /** Per layer: the runtime's stacking depth (larger is drawn further back). */
  sortDepths: number[];
}

/** The view a camera with this matrix gives: translate(stageCenter) * inverse(camera). */
export function cameraViewMatrix(camera: Matrix, stageWidth: number, stageHeight: number): Matrix | null {
  const inverse = invertMatrix(camera);
  if (!inverse) return null;
  return multiplyMatrices({ a: 1, b: 0, c: 0, d: 1, tx: stageWidth / 2, ty: stageHeight / 2 }, inverse);
}

/** Perspective scale of a layer at depth `zDepth` about the stage center; null behind the camera. */
export function layerDepthMatrix(zDepth: number, stageWidth: number, stageHeight: number): Matrix | null {
  if (zDepth <= -LAYER_DEPTH_FOCAL_LENGTH) return null;
  const s = LAYER_DEPTH_FOCAL_LENGTH / (LAYER_DEPTH_FOCAL_LENGTH + zDepth);
  const cx = stageWidth / 2;
  const cy = stageHeight / 2;
  return { a: s, b: 0, c: 0, d: s, tx: cx - s * cx, ty: cy - s * cy };
}

/**
 * A layer's depth at `frameIndex`: its keyframe's `frameZDepth`, interpolated
 * linearly to the next keyframe's across a classic motion tween (the published
 * runtime tweens the layer's `depth` the same way).
 */
export function layerZDepthAt(layer: Layer, frameIndex: number): number {
  const frame = layer.frames.find((f) => frameIndex >= f.index && frameIndex < f.index + f.duration);
  if (!frame) return 0;
  const z = frame.zDepth ?? 0;
  if (frame.tweenType !== 'motion') return z;
  const next = layer.frames.find((f) => f.index === frame.index + frame.duration);
  if (!next) return z;
  const nextZ = next.zDepth ?? 0;
  return z + (nextZ - z) * ((frameIndex - frame.index) / frame.duration);
}

/**
 * Per-layer stage transforms and stacking for a main timeline at a frame, or
 * null when there is no camera and every layer is at depth 0 (layers then draw
 * as they are, in timeline order).
 */
export function stageLayerViews(
  layers: Layer[],
  frameIndex: number,
  camera: StageCamera | null,
  stageWidth: number,
  stageHeight: number
): StageLayerViews | null {
  const depths = layers.map((layer) => layerZDepthAt(layer, frameIndex));
  if (!camera && depths.every((z) => z === 0)) return null;
  const view = camera ? cameraViewMatrix(camera.matrix, stageWidth, stageHeight) : null;
  const matrices: (Matrix | null)[] = [];
  const sortDepths: number[] = [];
  layers.forEach((layer, i) => {
    const followsCamera = !!camera && layer.attachedToCamera !== true;
    const projection = layerDepthMatrix(depths[i] - (followsCamera ? camera.zDepth : 0), stageWidth, stageHeight);
    matrices.push(projection && view && followsCamera ? multiplyMatrices(projection, view) : projection);
    // The runtime's ___GetDepth___: an attached layer counts twice its depth
    // plus the camera's when the camera has a depth.
    sortDepths.push(camera && camera.zDepth && layer.attachedToCamera
      ? depths[i] + depths[i] + camera.zDepth
      : depths[i]);
  });
  return { matrices, sortDepths };
}

/** `indices` (a paint order) re-sorted furthest first, keeping the order of equal depths. */
export function sortByStageDepth(indices: number[], views: StageLayerViews): number[] {
  return [...indices].sort((a, b) => views.sortDepths[b] - views.sortDepths[a]);
}
