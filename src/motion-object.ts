import type {
  BevelFilter, BlurFilter, ColorTransform, DropShadowFilter, Filter, GlowFilter,
  GradientBevelFilter, GradientGlowFilter, Matrix, Point,
} from './types';

/**
 * CS4+ object-based ("new") motion tweens.
 *
 * Animate saves one `<DOMFrame tweenType="motion object">` per tween span. The
 * span's element holds the starting state; the animation itself is an
 * `<motionObjectXML><AnimationCore>` block of per-property curves:
 *
 *   <AnimationCore TimeScale="24000" duration="30000">
 *     <TimeMap strength="0" type="Quadratic"/>
 *     <TimeMap strength="4" type="BounceIn"/>
 *     <PropertyContainer id="headContainer">
 *       <PropertyContainer id="Basic_Motion">
 *         <Property id="Motion_X"><Keyframe anchor="0,0" next="0,0" previous="0,0" timevalue="0"/>…
 *         <Property TimeMapIndex="1" id="Motion_Y">…
 *
 * - `timevalue` is in TimeScale ticks per second (TimeScale = frameRate × 1000).
 * - `anchor="0,v"` is the key's value; `next`/`previous` are its outgoing and
 *   incoming Bezier handles as "dt,v" (time offset from the key in ticks, absolute
 *   value). A segment is a cubic Bezier in (time, value); handles on the anchor
 *   make it linear.
 * - `<TimeMap type strength>` eases a property over its first..last key unless
 *   the property says `ignoreTimeMap="1"`; `TimeMapIndex` picks the TimeMap
 *   (default 0). The types are the Motion Editor's ease presets; see applyTimeMap.
 * - Motion_X/Y are offsets of the transformation point from where it starts;
 *   Rotation_Z, Skew_X/Y (degrees) and Scale_X/Y (percent) are absolute.
 * - `<PropertyContainer id="Filters">` holds one container per filter
 *   (`DropShadow_Filter`, `Blur_Filter`, `Glow_Filter`, …) in the instance's
 *   filter order. Its properties are `<Kind>_<Name>`: BlurX/BlurY/Distance in
 *   pixels, Angle in degrees, Strength in percent, colors as 0xRRGGBBAA keys, and
 *   Quality/Knockout/Inner* as a constant `<Property value="…">` with no keys.
 *
 * Sources: real CS4..CC saves (jindrapetrik/flacomdoc test data and public XFL
 * projects), the Animate SDK's ApplicationFCMPublicIDs.h (the ease type and
 * property id strings), Sony PSM's UIMotion/AnimationUtility (a player for this
 * exact data, and the ease formulas) and fl.motion's Animator.as for how the
 * values build the matrix.
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

/** One filter's curves from the `Filters` container. */
export interface MotionFilterCurves {
  /** The property ids' prefix: `DropShadow`, `Blur`, `Glow`, `Bevel`, `GradientGlow`, … */
  kind: string;
  /** Curves keyed by the id after the prefix (`BlurX`, `Color.r`, `Quality`, …). */
  properties: Record<string, MotionProperty>;
}

export interface MotionObjectTween {
  /** Ticks per second (normally frameRate × 1000). */
  timeScale: number;
  /** Curves keyed by Property id (`Motion_X`, `Scale_Y`, `Alpha_Amount`, …). */
  properties: Record<string, MotionProperty>;
  /** Filter curves in filter order (absent when the `Filters` container is empty). */
  filters?: MotionFilterCurves[];
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

  const filtersEl = Array.from(core.getElementsByTagName('PropertyContainer')).find((c) => c.getAttribute('id') === 'Filters');
  const inFilters = (el: Element) => {
    for (let p = el.parentElement; p && p !== core; p = p.parentElement) {
      if (p === filtersEl) return true;
    }
    return false;
  };

  const properties: Record<string, MotionProperty> = {};
  for (const prop of Array.from(core.getElementsByTagName('Property'))) {
    if (!inFilters(prop)) parseProperty(prop, timeMaps, properties);
  }

  // One child container per filter; its kind is the property ids' prefix.
  const filters: MotionFilterCurves[] = [];
  for (const container of filtersEl ? Array.from(filtersEl.children) : []) {
    if (container.tagName !== 'PropertyContainer') continue;
    const curves: Record<string, MotionProperty> = {};
    for (const prop of Array.from(container.getElementsByTagName('Property'))) parseProperty(prop, timeMaps, curves);
    const ids = Object.keys(curves);
    const kind = ids.length > 0 ? ids[0].slice(0, Math.max(ids[0].indexOf('_'), 0)) : '';
    if (!kind) continue;
    const byName: Record<string, MotionProperty> = {};
    for (const id of ids) {
      if (id.startsWith(`${kind}_`)) byName[id.slice(kind.length + 1)] = curves[id];
    }
    filters.push({ kind, properties: byName });
  }
  return { timeScale, properties, ...(filters.length > 0 && { filters }) };
}

/**
 * Add one `<Property>`'s curve to `out` under its id (or `<id>.r/.g/.b/.a` for a
 * color). A property with no keys and its own `value` (filter Quality, Knockout,
 * …) is a constant.
 */
function parseProperty(prop: Element, timeMaps: MotionTimeMap[], out: Record<string, MotionProperty>): void {
  const id = prop.getAttribute('id');
  if (!id || prop.getAttribute('enabled') === '0') return;
  const ignoreTimeMap = prop.getAttribute('ignoreTimeMap') === '1';
  const timeMap = ignoreTimeMap ? undefined : timeMaps[parseInt(prop.getAttribute('TimeMapIndex') || '0', 10) || 0];

  const keys = Array.from(prop.children).filter((key) => key.tagName === 'Keyframe');
  if (keys.length === 0 && prop.hasAttribute('value')) keys.push(prop);

  const numeric: MotionKeyframe[] = [];
  const colors: { time: number; rgba: number[] }[] = [];
  for (const key of keys) {
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
    out[id] = { keyframes: numeric.sort(byTime), ...(timeMap && { timeMap }) };
  } else if (colors.length > 0) {
    colors.sort(byTime);
    ['r', 'g', 'b', 'a'].forEach((channel, i) => {
      out[`${id}.${channel}`] = {
        keyframes: colors.map((c) => ({ time: c.time, value: c.rgba[i] })),
        ...(timeMap && { timeMap }),
      };
    });
  }
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

/** The preset's integer parameter (PSM reads `strength` as an int), clamped. */
const count = (strength: number, min: number, max: number) => Math.min(Math.max(Math.trunc(strength), min), max);

/**
 * Where `r` falls among `n` bounces: the unit interval is split into arcs of
 * T0/(k+1) for k = 0..n-1, T0 = 1/H(n), so each arc is shorter than the last.
 * Returns the arc `k` and the 0..1 position `u` inside it.
 */
function bounceArc(n: number, r: number): { k: number; u: number } {
  let harmonic = 0;
  for (let i = 1; i <= n; i++) harmonic += 1 / i;
  const t0 = 1 / harmonic;
  let k = 0, start = 0, end = t0;
  while (end < r && k < n) {
    k++;
    start = end;
    end += t0 / (k + 1);
  }
  return { k, u: (r - start) / (t0 / (k + 1)) };
}

/** Bounce: arcs out and back to the start, e^-k high (strength = bounces). */
function bounceEase(n: number, r: number): number {
  const { k, u } = bounceArc(n, r);
  return 4 * Math.exp(-k) * u * (1 - u);
}

/** BounceIn: falls to the end value, then bounces e^-k back from it. */
function bounceInEase(n: number, r: number): number {
  const { k, u } = bounceArc(n, r);
  return k === 0 ? u * u : 1 - 4 * Math.exp(-k) * u * (1 - u);
}

/**
 * Spring: a quarter sine up to 1 over 0.4/n, then a damped oscillation that
 * settles at 0.7 (n = strength, the number of swings). It does not end on 1.
 */
function springEase(strength: number, r: number): number {
  const n = Math.min(100, Math.trunc(strength));
  const startup = 0.4 / n;
  const cycle = (1 - startup) / n;
  if (r < startup) return Math.sin(r * Math.PI / 2 / startup);
  const t = r - startup;
  return 0.7 + 0.3 * Math.exp(-t / cycle) * Math.cos(2 * Math.PI / cycle * t);
}

/**
 * Apply a time map to a 0..1 ratio. The `type` strings are the Animate SDK's
 * (`kEasing_*` in ApplicationFCMPublicIDs.h); the formulas are Sony PSM's
 * AnimationUtility, a player for this data:
 *
 * - Quadratic..Quintic ("Simple"), Dual* ("Stop and Start"): `strength` -100..100
 *   blends linear toward the curve; > 0 eases out (Dual*: slow in the middle).
 * - Bounce, BounceIn: `strength` bounces; < 0 mirrors the curve in time.
 *   Animate's Bounce preset saves `BounceIn`.
 * - Spring: `strength` swings (1..100); <= 0 is linear.
 * - SineWave, SawtoothWave, SquareWave: `strength` half-waves between the start
 *   (0) and end (1) values (SquareWave at least 2). DampedWave: `strength` full
 *   cycles around the start, decaying from half the change.
 *
 * Several presets leave 0..1 or do not end on 1; evaluateMotionProperty clamps
 * the eased time to the keys. RandomSquareWave (PSM draws unseeded random
 * levels) and Custom (curve storage unknown) fall back to linear.
 */
export function applyTimeMap(timeMap: MotionTimeMap | undefined, r: number): number {
  if (!timeMap) return r;
  const { type, strength } = timeMap;
  if (POWERS[type]) return powerEase(POWERS[type], strength, r);
  if (type.startsWith('Dual') && POWERS[type.slice(4)]) return dualPowerEase(POWERS[type.slice(4)], strength, r);
  const n = Math.abs(Math.trunc(strength));
  switch (type) {
    case 'Bounce':
      // PSM divides by H(0) for 0 bounces (a flat line); keep the motion instead.
      if (n === 0) return r;
      return strength > 0 ? bounceEase(n, r) : bounceEase(n, 1 - r);
    case 'BounceIn':
      if (n === 0) return r;
      return strength > 0 ? bounceInEase(n, r) : 1 - bounceInEase(n, 1 - r);
    case 'Spring':
      return strength >= 1 ? springEase(strength, r) : r;
    case 'SineWave': {
      const waves = count(strength, 0, 100);
      return waves === 0 ? r : (1 + Math.sin(r * Math.PI * waves - Math.PI / 2)) / 2;
    }
    case 'SawtoothWave': {
      const v = (r * count(strength, 1, 100)) % 2;
      return v > 1 ? 2 - v : v;
    }
    case 'SquareWave':
      return (r * count(strength, 2, 100)) % 2 <= 1 ? 0 : 1;
    case 'DampedWave': {
      const waves = count(strength, 0, 100);
      return waves === 0 ? r : -Math.cos(r * Math.PI * waves * 2) * Math.exp(-r * waves) / 2;
    }
  }
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

/**
 * Value of a property at `t` ticks. The time map eases the time between the
 * first and last key; an eased time outside them holds the end key (as PSM's
 * player does). From the last key on it holds the eased value at the last key,
 * which for Spring and the wave presets is not the last key's value.
 */
export function evaluateMotionProperty(prop: MotionProperty, t: number): number {
  const keys = prop.keyframes;
  if (keys.length === 1) return keys[0].value;
  const first = keys[0].time, last = keys[keys.length - 1].time;
  if (t <= first) return keys[0].value;
  if (last <= first) return keys[keys.length - 1].value;
  const ratio = applyTimeMap(prop.timeMap, Math.min((t - first) / (last - first), 1));
  if (ratio <= 0) return keys[0].value;
  if (ratio >= 1) return keys[keys.length - 1].value;
  const eased = first + (last - first) * ratio;
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
  /** Set only when the tween has filter curves; replaces the element's own. */
  filters?: Filter[];
}

const DEG = Math.PI / 180;

/**
 * The element's state `frameOffset` frames into the tween span. `base` is the
 * element's stored matrix (the state at the start of the span),
 * `transformationPoint` its pivot in its own coordinates and `baseFilters` its
 * own filters.
 */
export function evaluateMotionObject(
  tween: MotionObjectTween,
  frameOffset: number,
  frameRate: number,
  base: Matrix,
  transformationPoint: Point = { x: 0, y: 0 },
  baseFilters: Filter[] = []
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
  if (tween.filters) state.filters = evaluateFilters(tween.filters, t, baseFilters);
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

// --- Filters -----------------------------------------------------------------

type CurveFilter = BlurFilter | DropShadowFilter | GlowFilter | BevelFilter | GradientGlowFilter | GradientBevelFilter;

/** Filter kind (the property id prefix) to the filter type it animates. */
const FILTER_TYPES: Record<string, CurveFilter['type']> = {
  Blur: 'blur', DropShadow: 'dropShadow', Glow: 'glow', Bevel: 'bevel',
  GradientGlow: 'gradientGlow', GradientBevel: 'gradientBevel',
};

/**
 * The element's filters with each filter curve applied at `t` ticks. A curve
 * set replaces the element's next unused filter of its type (the containers
 * follow the instance's filter order, switched-off filters included) and is
 * appended when there is none; a switched-off filter stays off. Filters
 * without curves, and kinds not read here (AdjColor), stay as they are.
 */
function evaluateFilters(curves: MotionFilterCurves[], t: number, base: Filter[]): Filter[] {
  const filters = base.slice();
  const used = new Set<number>();
  for (const { kind, properties } of curves) {
    const type = FILTER_TYPES[kind];
    if (!type) continue;
    const index = filters.findIndex((f, i) => f.type === type && !used.has(i));
    const filter = evaluateFilter(type, properties, t, index >= 0 ? filters[index] as CurveFilter : undefined);
    if (index >= 0) {
      filters[index] = filters[index].enabled === false ? { ...filter, enabled: false } : filter;
      used.add(index);
    } else {
      used.add(filters.push(filter) - 1);
    }
  }
  return filters;
}

const hex = (v: number) => Math.round(Math.min(Math.max(v, 0), 255)).toString(16).padStart(2, '0').toUpperCase();

/**
 * One filter at `t`. Values the curves don't cover (gradient colors, bevel type)
 * come from the element's filter of that type, else Animate's defaults.
 */
function evaluateFilter(
  type: CurveFilter['type'],
  props: Record<string, MotionProperty>,
  t: number,
  base: CurveFilter | undefined
): CurveFilter {
  const num = (name: string, fallback: number) => (props[name] ? evaluateMotionProperty(props[name], t) : fallback);
  const flag = (name: string, fallback = false) => (props[name] ? evaluateMotionProperty(props[name], t) !== 0 : fallback);
  // A color curve is four channel curves (see parseProperty); alpha is 0..255.
  const color = (name: string, fallback: string, fallbackAlpha: number) => props[`${name}.r`]
    ? {
      color: `#${hex(num(`${name}.r`, 0))}${hex(num(`${name}.g`, 0))}${hex(num(`${name}.b`, 0))}`,
      alpha: Math.min(Math.max(num(`${name}.a`, 255) / 255, 0), 1),
    }
    : { color: fallback, alpha: fallbackAlpha };
  const b = base as Partial<Omit<DropShadowFilter, 'type'> & Omit<BevelFilter, 'type'>> | undefined;

  const blur = {
    blurX: num('BlurX', b?.blurX ?? 5),
    blurY: num('BlurY', b?.blurY ?? 5),
    quality: Math.round(num('Quality', b?.quality ?? 1)),
  };
  if (type === 'blur') return { type, ...blur };
  // Strength is a percentage in the curves and a ratio on the filter (1 = 100%).
  const shadow = {
    ...blur,
    strength: num('Strength', (b?.strength ?? 1) * 100) / 100,
    knockout: flag('Knockout', b?.knockout),
  };
  const offset = { angle: num('Angle', b?.angle ?? 45), distance: num('Distance', b?.distance ?? 5) };

  switch (type) {
    case 'dropShadow': {
      const c = color('Color', b?.color ?? '#000000', b?.alpha ?? 1);
      return {
        type, ...shadow, ...offset, color: c.color, alpha: c.alpha,
        inner: flag('InnerShadow', b?.inner), hideObject: flag('HideObject', b?.hideObject),
      };
    }
    case 'glow': {
      const c = color('Color', b?.color ?? '#FF0000', b?.alpha ?? 1);
      return { type, ...shadow, color: c.color, alpha: c.alpha, inner: flag('InnerGlow', b?.inner) };
    }
    case 'bevel': {
      const dark = color('ShadowColor', b?.shadowColor ?? '#000000', b?.shadowAlpha ?? 1);
      const light = color('HilightColor', b?.highlightColor ?? '#FFFFFF', b?.highlightAlpha ?? 1);
      return {
        type, ...shadow, ...offset,
        shadowColor: dark.color, shadowAlpha: dark.alpha, highlightColor: light.color, highlightAlpha: light.alpha,
        ...(b?.inner !== undefined && { inner: b.inner }),
        ...(b?.bevelType && { bevelType: b.bevelType }),
      };
    }
    case 'gradientGlow':
    case 'gradientBevel': {
      // The gradient and the inner/outer/full type are not read from the curves.
      const g = base as GradientGlowFilter | GradientBevelFilter | undefined;
      const colors = g?.colors ?? [{ color: '#FFFFFF', alpha: 1, ratio: 0 }, { color: '#000000', alpha: 1, ratio: 255 }];
      return { type, ...shadow, ...offset, colors, ...(g?.inner !== undefined && { inner: g.inner }) };
    }
  }
}
