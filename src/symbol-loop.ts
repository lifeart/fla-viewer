import type { SymbolInstance } from './types';

/**
 * Which frame of its own timeline a graphic symbol instance shows, `frameOffset`
 * frames after the parent keyframe that placed it.
 *
 * `loop` is the instance's XFL `loop` attribute. Animate 2021 added the reverse
 * modes `"loop reverse"` and `"play once reverse"` next to `"loop"`,
 * `"play once"` and `"single frame"`. Playback starts at `firstFrame` and steps
 * one frame per parent frame towards `lastFrame` (forward, or backward for the
 * reverse modes), wrapping around the symbol's timeline when `lastFrame` lies
 * on the other side of `firstFrame`. Without `lastFrame` the whole timeline is
 * the range: forward modes end at the last frame and reverse modes at frame 0.
 * Loop modes then start over from `firstFrame`; play-once modes hold the end.
 * (Semantics after Animate's own stepping, as replicated by the onion-skin
 * exporter JSFL in defold/extension-animate; the strings are CXFL's accepted
 * `loop` values.)
 */
export function graphicSymbolFrame(
  loop: SymbolInstance['loop'],
  firstFrame: number,
  lastFrame: number | undefined,
  totalFrames: number,
  frameOffset: number
): number {
  const n = Math.max(1, totalFrames);
  const mod = (v: number) => ((v % n) + n) % n;
  const first = mod(firstFrame);
  const offset = Math.max(0, frameOffset);
  if (loop === 'single frame') return first;

  const reverse = loop === 'loop reverse' || loop === 'play once reverse';
  const repeats = loop === 'loop' || loop === 'loop reverse';
  const step = reverse ? -1 : 1;

  // Number of frames from firstFrame to the end of the range, inclusive.
  let length: number;
  if (lastFrame !== undefined && lastFrame >= 0) {
    const last = Math.min(lastFrame, n - 1);
    length = (reverse ? mod(first - last) : mod(last - first)) + 1;
  } else if (repeats) {
    length = n; // wraps around the whole timeline
  } else {
    length = (reverse ? first : n - 1 - first) + 1; // stops at frame 0 / the last frame
  }

  const k = repeats ? offset % length : Math.min(offset, length - 1);
  return mod(first + step * k);
}
