import { describe, it, expect } from 'vitest';
import {
  parseAnimationCore,
  evaluateMotionProperty,
  evaluateMotionObject,
  applyTimeMap,
  type MotionObjectTween,
} from '../motion-object';
import type { Filter } from '../types';

// CS4+ object motion tweens (<motionObjectXML><AnimationCore>). Sample XML follows
// what Flash CS5 writes (e.g. TimeScale 24000 at 24fps, 1000 ticks per frame).

const key = (t: number, v: number, next = `0,${v}`, previous = `0,${v}`) =>
  `<Keyframe anchor="0,${v}" next="${next}" previous="${previous}" roving="0" timevalue="${t}"/>`;
const prop = (id: string, keys: string, attrs = '') =>
  `<Property enabled="1" id="${id}" ignoreTimeMap="0" readonly="0" visible="1"${attrs}>${keys}</Property>`;

function core(basic: string, transformation = '', colors = '', timeMap = '<TimeMap strength="0" type="Quadratic"/>', filters = ''): Element {
  const xml = `<AnimationCore TimeScale="24000" Version="1" duration="30000">${timeMap}
    <metadata><Settings orientToPath="0" xformPtXOffsetPct="0.5" xformPtYOffsetPct="0.5" xformPtZOffsetPixels="0"/></metadata>
    <PropertyContainer id="headContainer">
      <PropertyContainer id="Basic_Motion">${basic}</PropertyContainer>
      <PropertyContainer id="Transformation">${transformation}</PropertyContainer>
      <PropertyContainer id="Colors">${colors}</PropertyContainer>
      <PropertyContainer id="Filters">${filters}</PropertyContainer>
    </PropertyContainer>
  </AnimationCore>`;
  return new DOMParser().parseFromString(xml, 'text/xml').documentElement;
}

const identity = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

// Filter containers copied from real saves. DROP_SHADOW_FILTER is from a file
// whose instance has <DropShadowFilter alpha="0.898039215686275" blurX="60"
// blurY="60" distance="15" quality="3" strength="0.6"/> (lsumedia/lsutv-graphics,
// CountDown_FS); BLUR_FILTER is from a CS5 sample that animates <BlurFilter
// blurX="10" blurY="10" quality="3"/> to 0 over 48 frames (Apress, Foundation
// Flash CS5 for Designers, "Garden").
const DROP_SHADOW_FILTER = `<PropertyContainer id="DropShadow_Filter"><Property enabled="1" id="DropShadow_BlurX" ignoreTimeMap="0" readonly="0" visible="1"><Keyframe anchor="0,60" next="0,60" previous="0,60" roving="0" timevalue="0"/></Property><Property enabled="1" id="DropShadow_BlurY" ignoreTimeMap="0" readonly="0" visible="1"><Keyframe anchor="0,60" next="0,60" previous="0,60" roving="0" timevalue="0"/></Property><Property enabled="1" id="DropShadow_Strength" ignoreTimeMap="0" readonly="0" visible="1"><Keyframe anchor="0,60" next="0,60" previous="0,60" roving="0" timevalue="0"/></Property><Property enabled="1" id="DropShadow_Quality" readonly="0" value="3" visible="1"/><Property enabled="1" id="DropShadow_Angle" ignoreTimeMap="0" readonly="0" visible="1"><Keyframe anchor="0,45" next="0,45" previous="0,45" roving="0" timevalue="0"/></Property><Property enabled="1" id="DropShadow_Distance" ignoreTimeMap="0" readonly="0" visible="1"><Keyframe anchor="0,15" next="0,15" previous="0,15" roving="0" timevalue="0"/></Property><Property enabled="1" id="DropShadow_Knockout" readonly="0" value="0" visible="1"/><Property enabled="1" id="DropShadow_InnerShadow" readonly="0" value="0" visible="1"/><Property enabled="1" id="DropShadow_HideObject" readonly="0" value="0" visible="1"/><Property enabled="1" id="DropShadow_Color" ignoreTimeMap="0" readonly="0" visible="1"><Keyframe roving="0" timevalue="0" value="0x000000e5"/></Property></PropertyContainer>`;
const BLUR_FILTER = `<PropertyContainer id="Blur_Filter"><Property enabled="1" id="Blur_BlurX" ignoreTimeMap="0" readonly="0" visible="1"><Keyframe anchor="0,10" next="0,10" previous="0,10" roving="0" timevalue="0"/><Keyframe anchor="0,0" next="0,0" previous="0,0" roving="0" timevalue="48000"/></Property><Property enabled="1" id="Blur_BlurY" ignoreTimeMap="0" readonly="0" visible="1"><Keyframe anchor="0,10" next="0,10" previous="0,10" roving="0" timevalue="0"/><Keyframe anchor="0,0" next="0,0" previous="0,0" roving="0" timevalue="48000"/></Property><Property enabled="1" id="Blur_Quality" readonly="0" value="3" visible="1"/></PropertyContainer>`;
// A glow as Animate saves it for an instance with <GlowFilter quality="3"/>
// (FlashNightModReborn/CrazyFlashNight, 静止动作.xml), with a second color key added.
const GLOW_FILTER = `<PropertyContainer id="Glow_Filter"><Property enabled="1" id="Glow_BlurX" ignoreTimeMap="0" readonly="0" visible="1"><Keyframe anchor="0,5" next="0,5" previous="0,5" roving="0" timevalue="0"/></Property><Property enabled="1" id="Glow_BlurY" ignoreTimeMap="0" readonly="0" visible="1"><Keyframe anchor="0,5" next="0,5" previous="0,5" roving="0" timevalue="0"/></Property><Property enabled="1" id="Glow_Strength" ignoreTimeMap="0" readonly="0" visible="1"><Keyframe anchor="0,100" next="0,100" previous="0,100" roving="0" timevalue="0"/></Property><Property enabled="1" id="Glow_Quality" readonly="0" value="3" visible="1"/><Property enabled="1" id="Glow_Color" ignoreTimeMap="0" readonly="0" visible="1"><Keyframe roving="0" timevalue="0" value="0xff0000ff"/><Keyframe roving="0" timevalue="10000" value="0x0000ff00"/></Property><Property enabled="1" id="Glow_Knockout" readonly="0" value="0" visible="1"/><Property enabled="1" id="Glow_InnerGlow" readonly="0" value="0" visible="1"/></PropertyContainer>`;

describe('parseAnimationCore', () => {
  it('reads properties, keys, handles and the time map', () => {
    const tween = parseAnimationCore(core(
      prop('Motion_X', key(0, 0, '1000,30') + key(29000, 410, '0,410', '-1000,380')),
      prop('Scale_X', key(0, 100)),
      '',
      '<TimeMap strength="50" type="Cubic"/>'
    ));
    expect(tween.timeScale).toBe(24000);
    expect(tween.properties.Motion_X).toEqual({
      keyframes: [
        { time: 0, value: 0, next: { dt: 1000, value: 30 }, previous: { dt: 0, value: 0 } },
        { time: 29000, value: 410, next: { dt: 0, value: 410 }, previous: { dt: -1000, value: 380 } },
      ],
      timeMap: { type: 'Cubic', strength: 50 },
    });
    expect(tween.properties.Scale_X.keyframes).toHaveLength(1);
  });

  it('drops the time map from properties with ignoreTimeMap="1"', () => {
    const tween = parseAnimationCore(core(
      prop('Rotation_Z', key(0, 0) + key(1000, 5), ' ignoreTimeMap="1"').replace('ignoreTimeMap="0" ', ''),
      '', '', '<TimeMap strength="100" type="Quadratic"/>'
    ));
    expect(tween.properties.Rotation_Z.timeMap).toBeUndefined();
  });

  it('splits 0xRRGGBBAA color keys into channel curves', () => {
    const tween = parseAnimationCore(core('', '', `<PropertyContainer id="Tint_ColorXform">
      ${prop('Tint_Color', '<Keyframe roving="0" timevalue="0" value="0xffffffff"/><Keyframe roving="0" timevalue="9000" value="0x660099ff"/>')}
    </PropertyContainer>`));
    expect(tween.properties['Tint_Color.r'].keyframes.map((k) => k.value)).toEqual([255, 0x66]);
    expect(tween.properties['Tint_Color.g'].keyframes.map((k) => k.value)).toEqual([255, 0]);
    expect(tween.properties['Tint_Color.b'].keyframes.map((k) => k.value)).toEqual([255, 0x99]);
  });

  it('skips disabled properties', () => {
    const tween = parseAnimationCore(core(prop('Motion_X', key(0, 0)).replace('enabled="1"', 'enabled="0"')));
    expect(tween.properties.Motion_X).toBeUndefined();
  });

  it('picks each property\'s time map by TimeMapIndex', () => {
    // As in Animate's ball-bounce motion preset: only Motion_Y bounces.
    const tween = parseAnimationCore(core(
      prop('Motion_X', key(0, 0) + key(74000, 500)) + prop('Motion_Y', key(0, 0) + key(74000, 367.3), ' TimeMapIndex="1"'),
      '', '', '<TimeMap strength="0" type="Quadratic"/><TimeMap strength="4" type="BounceIn"/>'
    ));
    expect(tween.properties.Motion_X.timeMap).toEqual({ type: 'Quadratic', strength: 0 });
    expect(tween.properties.Motion_Y.timeMap).toEqual({ type: 'BounceIn', strength: 4 });
  });

  it('reads the Filters container as one curve set per filter, in order', () => {
    const tween = parseAnimationCore(core('', '', '', undefined, DROP_SHADOW_FILTER + BLUR_FILTER));
    expect(tween.filters?.map((f) => f.kind)).toEqual(['DropShadow', 'Blur']);
    const shadow = tween.filters![0].properties;
    expect(Object.keys(shadow).sort()).toEqual([
      'Angle', 'BlurX', 'BlurY', 'Color.a', 'Color.b', 'Color.g', 'Color.r', 'Distance',
      'HideObject', 'InnerShadow', 'Knockout', 'Quality', 'Strength',
    ]);
    // Keyless properties with their own value are constants.
    expect(shadow.Quality.keyframes).toEqual([{ time: 0, value: 3 }]);
    expect(shadow['Color.a'].keyframes).toEqual([{ time: 0, value: 0xe5 }]);
    expect(tween.filters![1].properties.BlurX.keyframes.map((k) => [k.time, k.value])).toEqual([[0, 10], [48000, 0]]);
    // Filter curves stay out of the flat property map.
    expect(Object.keys(tween.properties).some((id) => id.startsWith('DropShadow') || id.startsWith('Blur'))).toBe(false);
    expect(parseAnimationCore(core(prop('Motion_X', key(0, 0)))).filters).toBeUndefined();
  });
});

describe('evaluateMotionProperty', () => {
  it('interpolates linearly when the handles sit on the keys', () => {
    const p = { keyframes: [{ time: 0, value: 0 }, { time: 29000, value: 410 }] };
    expect(evaluateMotionProperty(p, 14500)).toBeCloseTo(205, 6);
    expect(evaluateMotionProperty(p, 0)).toBe(0);
    expect(evaluateMotionProperty(p, 29000)).toBe(410);
  });

  it('holds the first and last values outside the keys', () => {
    const p = { keyframes: [{ time: 5000, value: 10 }, { time: 10000, value: 20 }] };
    expect(evaluateMotionProperty(p, 0)).toBe(10);
    expect(evaluateMotionProperty(p, 20000)).toBe(20);
    expect(evaluateMotionProperty({ keyframes: [{ time: 0, value: 7 }] }, 5000)).toBe(7);
  });

  it('follows the Bezier handles in (time, value)', () => {
    // Time handles at thirds keep time linear in u, so the value is the plain cubic
    // through 0, 300, 300, 300 at u = 0.5: an ease-out that is 262.5 halfway.
    const p = { keyframes: [
      { time: 0, value: 0, next: { dt: 1000, value: 300 } },
      { time: 3000, value: 300, previous: { dt: -1000, value: 300 } },
    ] };
    expect(evaluateMotionProperty(p, 1500)).toBeCloseTo(262.5, 3);
  });

  it('walks multiple segments', () => {
    const p = { keyframes: [{ time: 0, value: 0 }, { time: 10000, value: 100 }, { time: 20000, value: 50 }] };
    expect(evaluateMotionProperty(p, 5000)).toBeCloseTo(50, 6);
    expect(evaluateMotionProperty(p, 15000)).toBeCloseTo(75, 6);
  });

  it('eases the whole curve with the time map', () => {
    const keyframes = [{ time: 0, value: 0 }, { time: 10000, value: 100 }];
    expect(evaluateMotionProperty({ keyframes, timeMap: { type: 'Quadratic', strength: 100 } }, 5000)).toBeCloseTo(75, 3);
    expect(evaluateMotionProperty({ keyframes, timeMap: { type: 'Quadratic', strength: -100 } }, 5000)).toBeCloseTo(25, 3);
  });

  it('holds the eased value from the last key on when the ease does not end on 1', () => {
    // Sony's PSM sample spins Rotation_Z to 513 degrees with Spring 5 over 60
    // frames; the spring settles at 70% of the change, so it comes to rest at 360.
    const p = { keyframes: [{ time: 0, value: 0 }, { time: 59000, value: 513 }], timeMap: { type: 'Spring', strength: 5 } };
    expect(evaluateMotionProperty(p, 59000)).toBeCloseTo(360.137, 2);
    expect(evaluateMotionProperty(p, 70000)).toBeCloseTo(360.137, 2);
    expect(evaluateMotionProperty(p, 0.08 * 59000)).toBeCloseTo(513, 6); // top of the first swing
  });

  it('bounces on the end value with BounceIn', () => {
    // Animate's ball-bounce preset: Motion_Y 0 -> 367.3 over 74 frames, 4 bounces.
    // The first arc (48% of the time) is the fall; the next peaks e^-1 back up.
    const p = { keyframes: [{ time: 0, value: 0 }, { time: 74000, value: 367.3 }], timeMap: { type: 'BounceIn', strength: 4 } };
    expect(evaluateMotionProperty(p, 0.24 * 74000)).toBeCloseTo(367.3 / 4, 3);
    expect(evaluateMotionProperty(p, 0.48 * 74000)).toBeCloseTo(367.3, 3);
    expect(evaluateMotionProperty(p, 0.6 * 74000)).toBeCloseTo(367.3 * (1 - Math.exp(-1)), 3);
    expect(evaluateMotionProperty(p, 74000)).toBeCloseTo(367.3, 6);
  });

  it('holds the end keys where an ease leaves 0..1', () => {
    // DampedWave starts at -0.5 and swings around the start value.
    const p = { keyframes: [{ time: 0, value: 10 }, { time: 10000, value: 110 }], timeMap: { type: 'DampedWave', strength: 2 } };
    expect(evaluateMotionProperty(p, 1000)).toBe(10);
    expect(evaluateMotionProperty(p, 2500)).toBeCloseTo(10 + 100 * Math.exp(-0.5) / 2, 6);
    expect(evaluateMotionProperty(p, 5000)).toBe(10);
  });
});

describe('applyTimeMap', () => {
  it.each([
    ['Quadratic', 0, 0.5, 0.5],
    ['Quadratic', 100, 0.5, 0.75], // ease out
    ['Quadratic', -100, 0.5, 0.25], // ease in
    ['Quadratic', 50, 0.5, 0.625], // half way between linear and the curve
    ['Cubic', 100, 0.5, 0.875],
    ['Quartic', -100, 0.5, 0.0625],
    ['Quintic', 100, 0.5, 1 - 1 / 32],
    ['DualQuadratic', -100, 0.25, 0.125], // ease in-out
    ['DualQuadratic', -100, 0.75, 0.875],
    ['DualQuadratic', 100, 0.25, 0.375], // slow in the middle
    ['DualQuadratic', 100, 0.5, 0.5],
  ])('%s strength %d at %d is %d', (type, strength, r, expected) => {
    expect(applyTimeMap({ type, strength }, r)).toBeCloseTo(expected, 6);
  });

  it('keeps the end points fixed', () => {
    for (const type of ['Quadratic', 'Cubic', 'DualQuartic', 'BounceIn']) {
      for (const strength of [-100, 40, 100]) {
        expect(applyTimeMap({ type, strength }, 0)).toBeCloseTo(0, 9);
        expect(applyTimeMap({ type, strength }, 1)).toBeCloseTo(1, 9);
      }
    }
  });

  // Motion Editor presets, per Sony PSM's AnimationUtility. With 4 bounces the
  // arcs take 12/25 of the time, then half, a third and a quarter of that.
  it.each([
    ['BounceIn', 4, 0.24, 0.25], // falling: (r / 0.48)^2
    ['BounceIn', 4, 0.48, 1], // lands
    ['BounceIn', 4, 0.6, 1 - Math.exp(-1)], // top of the first bounce
    ['BounceIn', 4, 0.8, 1 - Math.exp(-2)],
    ['BounceIn', -4, 0.76, 0.75], // mirrored in time: bounces at the start
    ['Bounce', 4, 0.24, 1], // arcs out and back to the start
    ['Bounce', 4, 0.48, 0],
    ['Bounce', 4, 0.6, Math.exp(-1)],
    ['Bounce', 4, 1, 0],
    ['Bounce', -4, 0.76, 1],
    ['Spring', 5, 0.04, Math.SQRT1_2], // quarter sine up to 1 at 0.4 / 5
    ['Spring', 5, 0.08, 1],
    ['Spring', 5, 0.172, 0.7 - 0.3 * Math.exp(-0.5)], // half a swing later
    ['Spring', 5, 1, 0.7 + 0.3 * Math.exp(-5)],
    ['Spring', -5, 0.3, 0.3], // linear
    ['SineWave', 3, 1 / 3, 1],
    ['SineWave', 3, 0.5, 0.5],
    ['SineWave', 3, 2 / 3, 0],
    ['SineWave', 3, 1, 1],
    ['SawtoothWave', 2, 0.25, 0.5],
    ['SawtoothWave', 2, 0.5, 1],
    ['SawtoothWave', 2, 0.75, 0.5],
    ['SawtoothWave', 2, 1, 0],
    ['SquareWave', 4, 0.1, 0],
    ['SquareWave', 4, 0.3, 1],
    ['SquareWave', 4, 0.6, 0],
    ['SquareWave', 4, 0.8, 1],
    ['SquareWave', 0, 0.75, 1], // at least 2 levels
    ['DampedWave', 2, 0, -0.5],
    ['DampedWave', 2, 0.25, Math.exp(-0.5) / 2],
    ['DampedWave', 2, 0.5, -Math.exp(-1) / 2],
    ['DampedWave', 0, 0.3, 0.3],
    ['RandomSquareWave', 3, 0.3, 0.3], // not reproducible: linear
    ['Custom', 0, 0.3, 0.3], // curve storage unknown: linear
  ])('%s strength %d at %d is %d', (type, strength, r, expected) => {
    expect(applyTimeMap({ type, strength }, r)).toBeCloseTo(expected, 6);
  });
});

describe('evaluateMotionObject', () => {
  const tweenOf = (properties: MotionObjectTween['properties']): MotionObjectTween => ({ timeScale: 24000, properties });
  const linear = (v0: number, v1: number, t1 = 10000) => ({ keyframes: [{ time: 0, value: v0 }, { time: t1, value: v1 }] });

  it('moves the instance by Motion_X/Y in frames of the span', () => {
    const tween = tweenOf({ Motion_X: linear(0, 200), Motion_Y: linear(0, -100) });
    const base = { ...identity, tx: 40, ty: 225 };
    const m = evaluateMotionObject(tween, 5, 24, base).matrix;
    expect([m.a, m.b, m.c, m.d, m.tx, m.ty].map((v) => v + 0)).toEqual([1, 0, 0, 1, 140, 175]);
    // Animate writes TimeScale = frameRate x 1000, so a 30fps tween still has
    // 1000 ticks per frame.
    const tween30 = { ...tween, timeScale: 30000 };
    expect(evaluateMotionObject(tween30, 5, 30, base).matrix.tx).toBeCloseTo(140, 6);
  });

  it('rotates and scales around the transformation point', () => {
    // Base: registration at (40,225), transformation point (30,25) -> (70,250) on stage.
    const tween = tweenOf({
      Motion_X: linear(0, 100), Rotation_Z: linear(0, 90),
      Scale_X: linear(100, 100), Scale_Y: linear(100, 100),
      Skew_X: linear(0, 0), Skew_Y: linear(0, 0),
    });
    const m = evaluateMotionObject(tween, 10, 24, { ...identity, tx: 40, ty: 225 }, { x: 30, y: 25 }).matrix;
    expect(m.a).toBeCloseTo(0, 9);
    expect(m.b).toBeCloseTo(1, 9);
    expect(m.c).toBeCloseTo(-1, 9);
    expect(m.d).toBeCloseTo(0, 9);
    // The pivot ends 100px right of where it started: (170, 250).
    expect(m.a * 30 + m.c * 25 + m.tx).toBeCloseTo(170, 9);
    expect(m.b * 30 + m.d * 25 + m.ty).toBeCloseTo(250, 9);
  });

  it('builds scale and skew from Scale_* (percent) and Skew_* (degrees)', () => {
    const tween = tweenOf({ Scale_X: linear(100, 200), Scale_Y: linear(100, 50), Skew_X: linear(0, 0), Skew_Y: linear(0, 0), Rotation_Z: linear(0, 0) });
    expect(evaluateMotionObject(tween, 10, 24, identity).matrix).toMatchObject({ a: 2, d: 0.5 });
    const skew = tweenOf({ Skew_X: linear(0, 30), Skew_Y: linear(0, 0), Rotation_Z: linear(0, 0) });
    const m = evaluateMotionObject(skew, 10, 24, identity).matrix;
    expect(m.c).toBeCloseTo(-Math.sin(Math.PI / 6), 9);
    expect(m.d).toBeCloseTo(Math.cos(Math.PI / 6), 9);
    expect(m.b).toBeCloseTo(0, 9);
  });

  it('keeps the base scale, rotation and skew when the tween does not animate them', () => {
    const base = { a: 0, b: 2, c: -3, d: 0, tx: 10, ty: 20 }; // rotated 90deg, scaled 2 x 3
    const m = evaluateMotionObject(tweenOf({ Motion_X: linear(0, 50) }), 10, 24, base).matrix;
    expect(m.a).toBeCloseTo(0, 9);
    expect(m.b).toBeCloseTo(2, 9);
    expect(m.c).toBeCloseTo(-3, 9);
    expect(m.d).toBeCloseTo(0, 9);
    expect(m.tx).toBeCloseTo(60, 9);
    expect(m.ty).toBeCloseTo(20, 9);
  });

  it('reproduces the base matrix at the start of the span', () => {
    const base = { a: 0.8, b: 0.6, c: -0.6, d: 0.8, tx: 5, ty: 7 };
    const rot = (Math.atan2(0.6, 0.8) * 180) / Math.PI;
    const tween = tweenOf({ Motion_X: linear(0, 10), Rotation_Z: linear(rot, rot + 90), Scale_X: linear(100, 100), Scale_Y: linear(100, 100) });
    const m = evaluateMotionObject(tween, 0, 24, base, { x: 12, y: -4 }).matrix;
    for (const k of ['a', 'b', 'c', 'd', 'tx', 'ty'] as const) expect(m[k]).toBeCloseTo(base[k], 9);
  });

  it('animates alpha, tint, brightness and advanced color', () => {
    expect(evaluateMotionObject(tweenOf({ Alpha_Amount: linear(100, 0) }), 5, 24, identity).colorTransform)
      .toEqual({ alphaMultiplier: 0.5 });
    expect(evaluateMotionObject(tweenOf({ Brightness_Amount: linear(0, 100) }), 5, 24, identity).colorTransform)
      .toMatchObject({ redMultiplier: 0.5, redOffset: 127.5 });
    const tint = evaluateMotionObject(tweenOf({
      Tint_Amount: linear(0, 100), 'Tint_Color.r': linear(255, 255), 'Tint_Color.g': linear(0, 0), 'Tint_Color.b': linear(0, 0),
    }), 5, 24, identity).colorTransform;
    expect(tint).toMatchObject({ redMultiplier: 0.5, redOffset: 127.5, greenOffset: 0 });
    const adv = evaluateMotionObject(tweenOf({ AdvClr_G_Offset: linear(0, 128), AdvClr_R_Pct: linear(100, 100) }), 5, 24, identity).colorTransform;
    expect(adv).toMatchObject({ redMultiplier: 1, greenOffset: 64, alphaMultiplier: 1 });
    expect(evaluateMotionObject(tweenOf({ Motion_X: linear(0, 1) }), 5, 24, identity).colorTransform).toBeUndefined();
  });

  it('passes 3D rotations through', () => {
    const state = evaluateMotionObject(tweenOf({ Rotation_Y: linear(0, 60) }), 5, 24, identity);
    expect(state.rotationY).toBeCloseTo(30, 9);
    expect(state.rotationX).toBeUndefined();
  });
});

describe('evaluateMotionObject filters', () => {
  const filtersAt = (xml: string, frame: number, base: Filter[] = []) =>
    evaluateMotionObject(parseAnimationCore(core('', '', '', undefined, xml)), frame, 24, identity, undefined, base).filters;

  it('rebuilds the instance\'s own filter from the curves', () => {
    // The real file's <DropShadowFilter alpha="0.898..." blurX="60" blurY="60"
    // distance="15" quality="3" strength="0.6"/>, with the defaults it omits.
    expect(filtersAt(DROP_SHADOW_FILTER, 0)).toEqual([{
      type: 'dropShadow', blurX: 60, blurY: 60, strength: 0.6, quality: 3, angle: 45, distance: 15,
      color: '#000000', alpha: 0xe5 / 255, knockout: false, inner: false, hideObject: false,
    }]);
    expect(filtersAt(GLOW_FILTER, 0)).toEqual([{
      type: 'glow', blurX: 5, blurY: 5, strength: 1, quality: 3, color: '#FF0000', alpha: 1, knockout: false, inner: false,
    }]);
  });

  it('animates filter values over the span', () => {
    // Blur 10 -> 0 over 48 frames.
    expect(filtersAt(BLUR_FILTER, 0)).toEqual([{ type: 'blur', blurX: 10, blurY: 10, quality: 3 }]);
    expect(filtersAt(BLUR_FILTER, 24)).toEqual([{ type: 'blur', blurX: 5, blurY: 5, quality: 3 }]);
    expect(filtersAt(BLUR_FILTER, 48)).toEqual([{ type: 'blur', blurX: 0, blurY: 0, quality: 3 }]);
    // Glow color red -> transparent blue, per channel.
    expect(filtersAt(GLOW_FILTER, 5)![0]).toMatchObject({ color: '#800080', alpha: 0.5 });
  });

  it('replaces the matching base filter and keeps the others', () => {
    const adjust: Filter = { type: 'colorMatrix', matrix: Array(20).fill(0) };
    const blur: Filter = { type: 'blur', blurX: 10, blurY: 10, quality: 3 };
    const shadow: Filter = { type: 'dropShadow', blurX: 1, blurY: 1, color: '#00FF00', strength: 1, distance: 1, angle: 0 };
    const out = filtersAt(DROP_SHADOW_FILTER + BLUR_FILTER, 24, [adjust, shadow, blur])!;
    expect(out.map((f) => f.type)).toEqual(['colorMatrix', 'dropShadow', 'blur']);
    expect(out[0]).toBe(adjust);
    expect(out[1]).toMatchObject({ blurX: 60, color: '#000000', distance: 15 });
    expect(out[2]).toMatchObject({ blurX: 5 });
    // A curve set with no filter of its type in the base is appended.
    expect(filtersAt(BLUR_FILTER, 0, [adjust])!.map((f) => f.type)).toEqual(['colorMatrix', 'blur']);
  });

  it('reads bevel colors and keeps what the curves do not cover', () => {
    const bevel = `<PropertyContainer id="Bevel_Filter">
      ${prop('Bevel_Distance', key(0, 4) + key(10000, 14))}
      ${prop('Bevel_ShadowColor', '<Keyframe roving="0" timevalue="0" value="0x112233ff"/>')}
      ${prop('Bevel_HilightColor', '<Keyframe roving="0" timevalue="0" value="0xffeeddcc"/>')}
    </PropertyContainer>`;
    const base: Filter = {
      type: 'bevel', blurX: 3, blurY: 4, strength: 2, highlightColor: '#FFFFFF', shadowColor: '#000000',
      distance: 4, angle: 30, bevelType: 'full',
    };
    expect(filtersAt(bevel, 5, [base])).toEqual([{
      type: 'bevel', blurX: 3, blurY: 4, strength: 2, quality: 1, knockout: false, angle: 30, distance: 9,
      shadowColor: '#112233', shadowAlpha: 1, highlightColor: '#FFEEDD', highlightAlpha: 0xcc / 255, bevelType: 'full',
    }]);
  });

  it('falls back to Animate\'s defaults for values neither the curves nor the instance give', () => {
    const angleOnly = `<PropertyContainer id="DropShadow_Filter">${prop('DropShadow_Angle', key(0, 90))}</PropertyContainer>`;
    expect(filtersAt(angleOnly, 0)![0]).toMatchObject({ blurX: 5, blurY: 5, distance: 5, angle: 90, strength: 1, quality: 1 });
  });

  it('leaves the filters alone without filter curves', () => {
    expect(evaluateMotionObject(parseAnimationCore(core('')), 5, 24, identity).filters).toBeUndefined();
  });
});
