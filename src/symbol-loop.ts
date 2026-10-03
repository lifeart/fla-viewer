import type { Frame, SymbolInstance, Timeline } from './types';

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

/**
 * The part of a frame script that runs when the frame is entered: comments,
 * string and regex literals are dropped, and so are function bodies, block or
 * arrow-expression (event handlers and callbacks run later, if ever).
 */
// A `/` after one of these words starts a regex literal, not a division.
const REGEX_AFTER_WORD = /(?:^|[^\w$.])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)\s*$/;

function frameEntryCode(script: string): string {
  let code = '';
  const braces: boolean[] = []; // per open brace: is it (inside) a function body?
  let inFunction = 0;
  let arrowDepth = -1; // >= 0 while inside an arrow function's expression body
  let prev = ''; // last significant character, to tell a regex literal from division
  const skipping = () => inFunction > 0 || arrowDepth >= 0;
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    const next = script[i + 1];
    if (ch === '/' && (next === '/' || next === '*')) {
      const end = next === '/' ? script.indexOf('\n', i) : script.indexOf('*/', i + 2);
      i = end < 0 ? script.length : next === '/' ? end - 1 : end + 1;
      if (!skipping()) code += ' ';
      continue;
    }
    // (Not after `<`: that's an E4X closing tag, `</a>`.)
    const regexStart = ch === '/' && (prev === '' || /[(,=:[!&|?{};+\-*%>~^]/.test(prev) ||
      REGEX_AFTER_WORD.test(script.slice(Math.max(0, i - 16), i)));
    if (ch === '"' || ch === "'" || ch === '`' || regexStart) {
      // String or regex literal: skip to its closing delimiter.
      let j = i + 1;
      let inClass = false;
      for (; j < script.length; j++) {
        const c = script[j];
        if (c === '\\') { j++; continue; }
        if (ch !== '/') { if (c === ch) break; continue; }
        if (c === '\n') break;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
      }
      i = j;
      prev = '"';
      if (!skipping()) code += '""';
      continue;
    }
    if (arrowDepth >= 0) {
      // The expression ends at a `,` / `;` or an unmatched closer at its own level.
      if ('([{'.includes(ch)) {
        arrowDepth++;
      } else if (')]},;'.includes(ch)) {
        if (arrowDepth === 0) {
          arrowDepth = -1;
          i--; // handle the terminator as ordinary code
          continue;
        }
        if (')]}'.includes(ch)) arrowDepth--;
      }
    } else if (ch === '=' && next === '>' && !inFunction && script.slice(i + 2).trimStart()[0] !== '{') {
      arrowDepth = 0;
      i++;
    } else if (ch === '{') {
      const opensFunction = inFunction > 0 || /(?:\bfunction\b[^{};]*|=>\s*)$/.test(code);
      braces.push(opensFunction);
      if (opensFunction) inFunction++;
      else code += ch;
    } else if (ch === '}') {
      if (braces.pop()) inFunction--;
      else code += ch;
    } else if (!inFunction) {
      code += ch;
    }
    if (!/\s/.test(ch)) prev = ch;
  }
  return code;
}

// A call to the clip's own stop(): bare or through `this.` (ActionScript and
// Animate's HTML5 Canvas JavaScript), but not `mc.stop()`, `sound.stop()`,
// gotoAndStop() or a function named stop.
const OWN_STOP_CALL = /(?<![\w$.])(?<!\bfunction\s+)(?:this\s*\.\s*)?stop\s*\(\s*\)/;

/** True when a frame script calls the timeline's own `stop()` as the frame is entered. */
export function callsStop(script: string): boolean {
  return OWN_STOP_CALL.test(frameEntryCode(script));
}

/**
 * Frames of a movie clip's timeline where its playhead stops: keyframes whose
 * frame script calls `stop()`. Scripts are not run, but a clip that stops
 * itself (a state clip holding one pose per frame, a one-shot effect) would
 * otherwise cycle through all its frames. A conditional `if (…) stop();`
 * counts as a stop. Guide layers are not published, so their scripts never run.
 */
export function movieClipStopFrames(timeline: Timeline): Set<number> {
  const stops = new Set<number>();
  for (const layer of timeline.layers) {
    if (layer.layerType === 'guide') continue;
    for (const frame of layer.frames) {
      if (frame.actionScript && callsStop(frame.actionScript)) stops.add(frame.index);
    }
  }
  return stops;
}

/**
 * Where a movie clip's playhead is `ticks` frames after the clip appeared:
 * one frame per tick from frame 0, looping, and holding once it tries to leave
 * a stop() frame (the same stepping as the renderer's advanceMovieClipPlayheads).
 */
export function movieClipPlayhead(
  ticks: number,
  totalFrames: number,
  stopFrames: ReadonlySet<number>
): { frame: number; stopped: boolean } {
  const n = Math.max(1, totalFrames);
  const t = Math.max(0, Math.floor(ticks));
  if (n === 1) return { frame: 0, stopped: false };
  const stops = [...stopFrames].filter((f) => f >= 0 && f < n);
  if (stops.length === 0) return { frame: t % n, stopped: false };
  // Playing forward from frame 0, the clip holds at its first stop frame.
  const first = Math.min(...stops);
  return t <= first ? { frame: t, stopped: false } : { frame: first, stopped: true };
}

/**
 * The run of back-to-back keyframes on a layer that hold the same movie clip
 * instance as `keyframe` (the same library item at the same element index), as
 * [start, end) parent frames. Flash keeps one instance alive across such
 * keyframes, so its playhead has been running since `start`.
 */
export function movieClipRun(
  frames: readonly Frame[],
  keyframe: Frame,
  elementIndex: number,
  libraryItemName: string
): { start: number; end: number } {
  const holdsClip = (frame: Frame) => {
    const element = frame.elements[elementIndex];
    return !!element && element.type === 'symbol' && element.symbolType === 'movieclip' &&
      element.libraryItemName === libraryItemName;
  };
  let k = frames.indexOf(keyframe);
  if (k < 0) return { start: keyframe.index, end: keyframe.index + keyframe.duration };
  let first = k;
  while (first > 0 && frames[first - 1].index + frames[first - 1].duration === frames[first].index &&
         holdsClip(frames[first - 1])) first--;
  while (k + 1 < frames.length && frames[k].index + frames[k].duration === frames[k + 1].index &&
         holdsClip(frames[k + 1])) k++;
  return { start: frames[first].index, end: frames[k].index + frames[k].duration };
}

/**
 * The frame a timeline showed `ticksAgo` ticks before now (0 = now), or
 * undefined when the instance playing it wasn't on stage yet. A movie clip's
 * playhead is seeded by walking its parent's clock back.
 */
export type TimelineClock = (ticksAgo: number) => number | undefined;

/** The main timeline (a scene) at `frame`, played from frame 0. */
export function rootClock(frame: number): TimelineClock {
  return (k) => (k <= frame ? frame - k : undefined);
}

/** A movie clip that has been on stage for `ticks` ticks (see movieClipPlayhead). */
export function movieClipClock(ticks: number, totalFrames: number, stopFrames: ReadonlySet<number>): TimelineClock {
  return (k) => (k <= ticks ? movieClipPlayhead(ticks - k, totalFrames, stopFrames).frame : undefined);
}

/**
 * A graphic or button instance at `elementIndex` of a layer in the timeline
 * `parent` plays: the frame the graphic followed (a button shows frame 0),
 * for as long as the layer's keyframes held that symbol in that slot.
 */
export function instanceClock(
  parent: TimelineClock,
  frames: readonly Frame[],
  elementIndex: number,
  instance: SymbolInstance,
  totalFrames: number
): TimelineClock {
  let last: Frame | undefined; // walks step back one frame at a time
  return (k) => {
    const p = parent(k);
    if (p === undefined) return undefined;
    const inFrame = (f: Frame | undefined) => !!f && p >= f.index && p < f.index + f.duration;
    const keyframe = inFrame(last) ? last : frames.find(inFrame);
    if (!keyframe) return undefined;
    last = keyframe;
    const element = keyframe.elements[elementIndex];
    if (!element || element.type !== 'symbol' || element.symbolType !== instance.symbolType ||
        element.libraryItemName !== instance.libraryItemName) return undefined;
    if (element.symbolType === 'button') return 0;
    return graphicSymbolFrame(element.loop, element.firstFrame || 0, element.lastFrame, totalFrames,
      p - keyframe.index);
  };
}

/**
 * How many ticks a movie clip has been on stage: how long its parent timeline,
 * read back on `clock`, has stayed inside the clip's run of keyframes. That is
 * how long continuous playback keeps the instance (it starts over whenever its
 * parent enters the run anew), so a seek or a one-frame export shows the frame
 * playback would.
 */
export function movieClipTicks(run: { start: number; end: number }, clock: TimelineClock): number {
  let k = 0;
  for (;;) {
    const frame = clock(k + 1);
    if (frame === undefined || frame < run.start || frame >= run.end) return k;
    k++;
  }
}
