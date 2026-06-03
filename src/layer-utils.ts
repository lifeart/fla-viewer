import type { Layer } from './types';

/**
 * A layer is hidden in the FLA if it — or any ancestor it is linked under via
 * `parentLayerIndex` (its folder/group, or the layer it is parented to) — is
 * marked `visible: false`. This mirrors Adobe Animate's stage, where hiding a
 * folder or a parent layer hides everything linked beneath it (issue #12:
 * "group / parent child link layer" support).
 *
 * Note on layer-parenting *transforms*: this helper only cascades the visibility
 * flag. It does NOT compose a parent layer's transform onto its children. In a
 * source `.fla` each child stores a *local* matrix and Animate composes
 * parent→child live, so a tweening parent with a holding child would not move the
 * child here. Implementing parent-transform composition is a known gap / out of
 * scope; it is intentionally NOT handled (and is not "baked" into child
 * keyframes, contrary to an earlier claim).
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
