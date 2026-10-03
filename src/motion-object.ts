import type { ColorTransform, Matrix, Point } from './types';

/**
 * CS4+ object-based ("new") motion tweens.
 *
 * Animate saves one `<DOMFrame tweenType="motion object">` per tween span. The
 * span's element holds the starting state; the animation itself is an
 * `<motionObjectXML><AnimationCore>` block of per-property curves:
 *
 *   <AnimationCore TimeScale="24000" duration="30000">
 *     <TimeMap strength="0" type="Quadratic"/>
 *     <PropertyContainer id="headContainer">
 *       <PropertyContainer id="Basic_Motion">
 *         <Property id="Motion_X"><Keyframe anchor="0,0" next="0,0" previous="0,0" timevalue="0"/>…
 *
 * - `timevalue` is in TimeScale ticks per second (TimeScale = frameRate × 1000).
 * - `anchor="0,v"` is the key's value; `next`/`previous` are its outgoing and
 *   incoming Bezier handles as "dt,v" (time offset from the key in ticks, absolute
 *   value). A segment is a cubic Bezier in (time, value); handles on the anchor
 *   make it linear.
 * - `<TimeMap type strength>` eases a property over its first..last key unless
 *   the property says `ignoreTimeMap="1"`.
 * - Motion_X/Y are offsets of the transformation point from where it starts;
 *   Rotation_Z, Skew_X/Y (degrees) and Scale_X/Y (percent) are absolute.
 *
 * Sources: real CS4..CC saves (jindrapetrik/flacomdoc test data and public XFL
 * projects), Sony PSM's UIMotion/AnimationUtility (a player for this exact
 * data) and fl.motion's Animator.as for how the values build the matrix.
 */

export interface MotionHandle {
  /** Time offset from the key, in ticks. */
  dt: number;
  value: number;
}

export interface MotionKeyframe {
  /** Ticks from the start of the tween span. */
  time: number;
  value: number;
  next?: MotionHandle;
  previous?: MotionHandle;
}

export interface MotionTimeMap {
  type: string;
  strength: number;
}

export interface MotionProperty {
  keyframes: MotionKeyframe[];
  /** Whole-curve ease (absent when the property ignores the time map). */
  timeMap?: MotionTimeMap;
}

export interface MotionObjectTween {
  /** Ticks per second (normally frameRate × 1000). */
  timeScale: number;
  /** Curves keyed by Property id (`Motion_X`, `Scale_Y`, `Alpha_Amount`, …). */
  properties: Record<string, MotionProperty>;
}

function parsePair(text: string | null): [number, number] | null {
  if (!text) return null;
  const [a, b] = text.split(',').map((s) => parseFloat(s));
  return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null;
}

/**
 * Parse `<AnimationCore>`. Non-numeric properties written as `value="0xRRGGBBAA"`
 * (Tint_Color, filter colors) become per-channel curves `<id>.r/.g/.b/.a`.
 */
export function parseAnimationCore(core: Element): MotionObjectTween {
  const timeScale = parseFloat(core.getAttribute('TimeScale') || '') || 24000;
  const timeMaps: MotionTimeMap[] = [];
  for (const tm of Array.from(core.children)) {
    if (tm.tagName !== 'TimeMap') continue;
    timeMaps.push({ type: tm.getAttribute('type') || 'Linear', strength: parseFloat(tm.getAttribute('strength') || '0') || 0 });
  }

  const properties: Record<string, MotionProperty> = {};
  for (const prop of Array.from(core.getElementsByTagName('Property'))) {
    const id = prop.getAttribute('id');
    if (!id || prop.getAttribute('enabled') === '0') continue;
    const ignoreTimeMap = prop.getAttribute('ignoreTimeMap') === '1';
    const timeMap = ignoreTimeMap ? undefined : timeMaps[parseInt(prop.getAttribute('TimeMapIndex') || '0', 10) || 0];

    const numeric: MotionKeyframe[] = [];
    const colors: { time: number; rgba: number[] }[] = [];
    for (const key of Array.from(prop.children)) {
      if (key.tagName !== 'Keyframe') continue;
      const time = parseFloat(key.getAttribute('timevalue') || '0') || 0;
      const anchor = parsePair(key.getAttribute('anchor'));
      if (anchor) {
        const next = parsePair(key.getAttribute('next'));
        const previous = parsePair(key.getAttribute('previous'));
        numeric.push({
          time,
          value: anchor[1],
          ...(next && { next: { dt: next[0], value: next[1] } }),
          ...(previous && { previous: { dt: previous[0], value: previous[1] } }),
        });
        continue;
      }
      const raw = key.getAttribute('value');
      if (raw && /^0x[0-9a-f]{8}$/i.test(raw)) {
        const n = parseInt(raw.slice(2), 16);
        colors.push({ time, rgba: [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255] });
      } else if (raw !== null && Number.isFinite(parseFloat(raw))) {
        numeric.push({ time, value: parseFloat(raw) });
      }
    }

    const byTime = (a: { time: number }, b: { time: number }) => a.time - b.time;
    if (numeric.length > 0) {
      properties[id] = { keyframes: numeric.sort(byTime), ...(timeMap && { timeMap }) };
    } else if (colors.length > 0) {
      colors.sort(byTime);
      ['r', 'g', 'b', 'a'].forEach((channel, i) => {
        properties[`${id}.${channel}`] = {
          keyframes: colors.map((c) => ({ time: c.time, value: c.rgba[i] })),
          ...(timeMap && { timeMap }),
        };
      });
    }
  }
  return { timeScale, properties };
}

// --- Time map (whole-curve ease), after PSM AnimationUtility -----------------

function powerEase(power: number, strength: number, r: number): number {
  const curve = strength > 0
    ? 1 - Math.pow(1 - r, power) // ease out
    : Math.pow(r, power); // ease in
  const a = Math.min(Math.abs(strength) / 100, 1);
  return a * curve + (1 - a) * r;
}

function dualPowerEase(power: number, strength: number, r: number): number {
  const p = (x: number) => Math.pow(Math.abs(x), power);
  // strength > 0: fast-slow-fast (slow in the middle); < 0: ease in and out.
  const curve = strength > 0
    ? (r < 0.5 ? 0.5 - p(2 * r - 1) / 2 : 0.5 + p(2 * r - 1) / 2)
    : (r < 0.5 ? p(2 * r) / 2 : 1 - p(2 * r - 2) / 2);
  const a = Math.min(Math.abs(strength) / 100, 1);
  return a * curve + (1 - a) * r;
}

const POWERS: Record<string, number> = { Quadratic: 2, Cubic: 3, Quartic: 4, Quintic: 5 };

/**
 * Apply a time map to a 0..1 ratio. Quadratic..Quintic and their Dual* forms
 * are implemented; Bounce, Spring, the wave types and Custom fall back to linear.
 */
export function applyTimeMap(timeMap: MotionTimeMap | undefined, r: number): number {
  if (!timeMap || timeMap.strength === 0) return r;
  const { type, strength } = timeMap;
  if (POWERS[type]) return powerEase(POWERS[type], strength, r);
  if (type.startsWith('Dual') && POWERS[type.slice(4)]) return dualPowerEase(POWERS[type.slice(4)], strength, r);
  return r;
}

// --- Curve evaluation --------------------------------------------------------

function cubic(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const v = 1 - u;
  return v * v * v * p0 + 3 * v * v * u * p1 + 3 * v * u * u * p2 + u * u * u * p3;
}

/** Value of one Bezier segment between two keys at time `t` (t0 <= t <= t1). */
function evaluateSegment(k0: MotionKeyframe, k1: MotionKeyframe, t: number): number {
  const t0 = k0.time, t1 = k1.time;
  if (t1 <= t0) return k1.value;
  // Keep the time handles inside the segment so time stays monotonic.
  const x1 = Math.min(Math.max(t0 + (k0.next?.dt ?? 0), t0), t1);
  const x2 = Math.min(Math.max(t1 + (k1.previous?.dt ?? 0), t0), t1);
  const y1 = k0.next?.value ?? k0.value;
  const y2 = k1.previous?.value ?? k1.value;
  // Solve x(u) = t by bisection (x is monotonic in u with the handles clamped).
  let lo = 0, hi = 1, u = (t - t0) / (t1 - t0);
  for (let i = 0; i < 40; i++) {
    const x = cubic(t0, x1, x2, t1, u);
    if (Math.abs(x - t) < 1e-6) break;
    if (x < t) lo = u; else hi = u;
    u = (lo + hi) / 2;
  }
  return cubic(k0.value, y1, y2, k1.value, u);
}

/** Value of a property at `t` ticks; holds the first/last key outside them. */
export function evaluateMotionProperty(prop: MotionProperty, t: number): number {
  const keys = prop.keyframes;
  if (keys.length === 1) return keys[0].value;
  const first = keys[0].time, last = keys[keys.length - 1].time;
  if (t <= first) return keys[0].value;
  if (t >= last) return keys[keys.length - 1].value;
  const eased = first + (last - first) * applyTimeMap(prop.timeMap, (t - first) / (last - first));
  for (let i = 0; i < keys.length - 1; i++) {
    if (eased <= keys[i + 1].time) return evaluateSegment(keys[i], keys[i + 1], eased);
  }
  return keys[keys.length - 1].value;
}

// --- Applying the tween to an element ---------------------------------------

export interface MotionObjectState {
  matrix: Matrix;
  /** Set only when the tween animates color; replaces the element's own. */
  colorTransform?: ColorTransform;
  rotationX?: number;
  rotationY?: number;
}

const DEG = Math.PI / 180;

/**
 * The element's state `frameOffset` frames into the tween span. `base` is the
 * element's stored matrix (the state at the start of the span) and
 * `transformationPoint` its pivot in its own coordinates.
 */
export function evaluateMotionObject(
  tween: MotionObjectTween,
  frameOffset: number,
  frameRate: number,
  base: Matrix,
  transformationPoint: Point = { x: 0, y: 0 }
): MotionObjectState {
  const t = frameOffset * tween.timeScale / frameRate;
  const props = tween.properties;
  const value = (id: string, fallback: number) => (props[id] ? evaluateMotionProperty(props[id], t) : fallback);

  // Missing properties keep the base matrix's own decomposition, so a tween
  // that only moves an instance never disturbs its scale or rotation.
  const baseRotation = Math.atan2(base.b, base.a) / DEG;
  const baseSkewX = Math.atan2(-base.c, base.d) / DEG - baseRotation;
  const rotation = value('Rotation_Z', baseRotation);
  const skewX = value('Skew_X', baseSkewX);
  const skewY = value('Skew_Y', 0);
  const scaleX = value('Scale_X', Math.hypot(base.a, base.b) * 100) / 100;
  const scaleY = value('Scale_Y', Math.hypot(base.c, base.d) * 100) / 100;

  const kx = (rotation + skewX) * DEG;
  const ky = (rotation + skewY) * DEG;
  const a = scaleX * Math.cos(ky);
  const b = scaleX * Math.sin(ky);
  const c = -scaleY * Math.sin(kx);
  const d = scaleY * Math.cos(kx);

  // The transformation point starts where the base matrix puts it and moves by
  // (Motion_X, Motion_Y); rotation and scale pivot around it.
  const tp = transformationPoint;
  const px = base.a * tp.x + base.c * tp.y + base.tx + value('Motion_X', 0);
  const py = base.b * tp.x + base.d * tp.y + base.ty + value('Motion_Y', 0);
  const state: MotionObjectState = {
    matrix: { a, b, c, d, tx: px - (a * tp.x + c * tp.y), ty: py - (b * tp.x + d * tp.y) },
  };

  if (props.Rotation_X) state.rotationX = value('Rotation_X', 0);
  if (props.Rotation_Y) state.rotationY = value('Rotation_Y', 0);

  const colorTransform = evaluateColors(props, (id, fallback) => value(id, fallback));
  if (colorTransform) state.colorTransform = colorTransform;
  return state;
}

function evaluateColors(
  props: Record<string, MotionProperty>,
  value: (id: string, fallback: number) => number
): ColorTransform | undefined {
  if (props.AdvClr_R_Pct || props.AdvClr_A_Pct || props.AdvClr_R_Offset) {
    return {
      redMultiplier: value('AdvClr_R_Pct', 100) / 100,
      greenMultiplier: value('AdvClr_G_Pct', 100) / 100,
      blueMultiplier: value('AdvClr_B_Pct', 100) / 100,
      alphaMultiplier: value('AdvClr_A_Pct', 100) / 100,
      redOffset: value('AdvClr_R_Offset', 0),
      greenOffset: value('AdvClr_G_Offset', 0),
      blueOffset: value('AdvClr_B_Offset', 0),
      alphaOffset: value('AdvClr_A_Offset', 0),
    };
  }
  if (props.Alpha_Amount) {
    return { alphaMultiplier: value('Alpha_Amount', 100) / 100 };
  }
  if (props.Brightness_Amount) {
    const v = Math.max(-1, Math.min(1, value('Brightness_Amount', 0) / 100));
    const m = 1 - Math.abs(v);
    const o = v > 0 ? 255 * v : 0;
    return { redMultiplier: m, greenMultiplier: m, blueMultiplier: m, redOffset: o, greenOffset: o, blueOffset: o };
  }
  if (props.Tint_Amount || props['Tint_Color.r']) {
    const amount = Math.max(0, Math.min(1, value('Tint_Amount', 0) / 100));
    const m = 1 - amount;
    return {
      redMultiplier: m, greenMultiplier: m, blueMultiplier: m,
      redOffset: value('Tint_Color.r', 0) * amount,
      greenOffset: value('Tint_Color.g', 0) * amount,
      blueOffset: value('Tint_Color.b', 0) * amount,
    };
  }
  return undefined;
}
