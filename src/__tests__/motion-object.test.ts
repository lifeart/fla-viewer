import { describe, it, expect } from 'vitest';
import {
  parseAnimationCore,
  evaluateMotionProperty,
  evaluateMotionObject,
  applyTimeMap,
  type MotionObjectTween,
} from '../motion-object';

// CS4+ object motion tweens (<motionObjectXML><AnimationCore>). Sample XML follows
// what Flash CS5 writes (e.g. TimeScale 24000 at 24fps, 1000 ticks per frame).

const key = (t: number, v: number, next = `0,${v}`, previous = `0,${v}`) =>
  `<Keyframe anchor="0,${v}" next="${next}" previous="${previous}" roving="0" timevalue="${t}"/>`;
const prop = (id: string, keys: string, attrs = '') =>
  `<Property enabled="1" id="${id}" ignoreTimeMap="0" readonly="0" visible="1"${attrs}>${keys}</Property>`;

function core(basic: string, transformation = '', colors = '', timeMap = '<TimeMap strength="0" type="Quadratic"/>'): Element {
  const xml = `<AnimationCore TimeScale="24000" Version="1" duration="30000">${timeMap}
    <metadata><Settings orientToPath="0" xformPtXOffsetPct="0.5" xformPtYOffsetPct="0.5" xformPtZOffsetPixels="0"/></metadata>
    <PropertyContainer id="headContainer">
      <PropertyContainer id="Basic_Motion">${basic}</PropertyContainer>
      <PropertyContainer id="Transformation">${transformation}</PropertyContainer>
      <PropertyContainer id="Colors">${colors}</PropertyContainer>
      <PropertyContainer id="Filters"/>
    </PropertyContainer>
  </AnimationCore>`;
  return new DOMParser().parseFromString(xml, 'text/xml').documentElement;
}

const identity = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

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
    ['Spring', 5, 0.3, 0.3], // not implemented: linear
  ])('%s strength %d at %d is %d', (type, strength, r, expected) => {
    expect(applyTimeMap({ type, strength }, r)).toBeCloseTo(expected, 6);
  });

  it('keeps the end points fixed', () => {
    for (const type of ['Quadratic', 'Cubic', 'DualQuartic']) {
      for (const strength of [-100, 40, 100]) {
        expect(applyTimeMap({ type, strength }, 0)).toBeCloseTo(0, 9);
        expect(applyTimeMap({ type, strength }, 1)).toBeCloseTo(1, 9);
      }
    }
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
