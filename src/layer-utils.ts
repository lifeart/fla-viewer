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

/**
 * Resolve the mask layer that clips layer `index`, or undefined if it is not
 * masked. Mirrors Animate's mask grouping:
 *
 * - An explicit `maskLayerIndex` (set by the XFL parser) wins.
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
  if (layer.maskLayerIndex !== undefined) return layer.maskLayerIndex;

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
