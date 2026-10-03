import type { DisplayElement, Frame } from './types';
import { multiplyMatrices } from './layer-utils';
import { withInstanceMatrix } from './transform-3d';

/**
 * An element of an IK pose span (`tweenType="IK pose"`, a Bone tool armature)
 * as it stands at `frameIndex`. The span's keyframe stores the armature in its
 * first pose; Flash bakes the solved motion into `<betweenFrameMatrixList>`
 * (`Frame.ikPoseMatrices`), one transform per element per frame, applied in the
 * parent's space on top of the stored matrix. No IK is solved here. Elements of
 * other frames, and of spans whose list couldn't be read, pass through.
 *
 * A shape armature needs nothing extra: Flash moves the shape into an
 * `"ik container"` symbol with one baked keyframe per frame, placed as a
 * play-once graphic (its pose transforms were identities in the saves checked).
 */
export function applyIKPose<T extends DisplayElement>(
  frame: Frame,
  element: T,
  elementIndex: number,
  frameIndex: number
): T {
  const pose = frame.ikPoseMatrices?.[elementIndex]?.[frameIndex - frame.index];
  if (!pose) return element;
  return withInstanceMatrix(element, multiplyMatrices(pose, element.matrix));
}
