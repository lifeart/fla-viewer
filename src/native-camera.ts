import type { Layer, Matrix } from './types';
import { invertMatrix, multiplyMatrices } from './layer-utils';

// Animate's native camera (CC 2017+), applied the way Animate's HTML5 Canvas
// runtime does it (`AdobeAn.VirtualCamera` and `_applyLayerZDepth` in the
// published JS):
//
// - The camera layer (`layerType="camera"`) holds one `__Camera__` instance. Its
//   symbol is a stage-sized rectangle centered on its origin, so the default
//   camera matrix is a translation to the stage center; zoom is 1/scale and
//   camera rotation is the negated instance rotation. A layer that is not
//   attached to the camera is drawn through
//   `translate(stageCenter) * inverse(cameraMatrix)`.

export interface StageCamera {
  /** The `__Camera__` instance's matrix at the frame. */
  matrix: Matrix;
}

export interface StageLayerViews {
  /** Per layer: maps its content to the stage, or null when it is not drawn. */
  matrices: (Matrix | null)[];
}

const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

/** The view a camera with this matrix gives: translate(stageCenter) * inverse(camera). */
export function cameraViewMatrix(camera: Matrix, stageWidth: number, stageHeight: number): Matrix | null {
  const inverse = invertMatrix(camera);
  if (!inverse) return null;
  return multiplyMatrices({ a: 1, b: 0, c: 0, d: 1, tx: stageWidth / 2, ty: stageHeight / 2 }, inverse);
}

/**
 * Per-layer stage transforms for a main timeline, or null without a camera
 * (layers then draw as they are).
 */
export function stageLayerViews(
  layers: Layer[],
  camera: StageCamera | null,
  stageWidth: number,
  stageHeight: number
): StageLayerViews | null {
  const view = camera ? cameraViewMatrix(camera.matrix, stageWidth, stageHeight) : null;
  if (!view) return null;
  return { matrices: layers.map((layer) => (layer.attachedToCamera === true ? IDENTITY : view)) };
}
