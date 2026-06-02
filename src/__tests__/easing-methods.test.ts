import { describe, it, expect, beforeEach } from 'vitest';
import { FLARenderer } from '../renderer';
import type { Tween } from '../types';

// Every distinct <Ease method="..."> token found in a real Adobe Animate file
// (the reporter's 28-21 p0tatomango.fla from issue #11), mapped to the
// (base, direction) the renderer must decompose it into. These tests prove
// each token has a LOGICALLY CORRECT Penner implementation — not merely that
// it renders non-linearly.
const REAL_TOKENS: Record<string, { base: string; direction: string }> = {
  quadIn: { base: 'quad', direction: 'in' },
  quadOut: { base: 'quad', direction: 'out' },
  quadInOut: { base: 'quad', direction: 'inOut' },
  cubicIn: { base: 'cubic', direction: 'in' },
  cubicOut: { base: 'cubic', direction: 'out' },
  cubicInOut: { base: 'cubic', direction: 'inOut' },
  quartIn: { base: 'quart', direction: 'in' },
  quartOut: { base: 'quart', direction: 'out' },
  quintIn: { base: 'quint', direction: 'in' },
  quintOut: { base: 'quint', direction: 'out' },
  sineInOut: { base: 'sine', direction: 'inOut' },
  circIn: { base: 'circ', direction: 'in' },
  circOut: { base: 'circ', direction: 'out' },
  backOut: { base: 'back', direction: 'out' },
  backInOut: { base: 'back', direction: 'inOut' },
  elasticOut: { base: 'elastic', direction: 'out' },
};

describe('Ease method tokens (issue #11 real-file coverage)', () => {
  let renderer: FLARenderer;
  beforeEach(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 550;
    canvas.height = 400;
    renderer = new FLARenderer(canvas);
  });

  // Raw eased value at parameter t, full strength (no intensity blend).
  const ease = (t: number, token: string): number =>
    (renderer as any).applyEaseMethod(t, token);

  it('decomposes every real token into the correct (base, direction)', () => {
    for (const [token, expected] of Object.entries(REAL_TOKENS)) {
      expect((renderer as any).parseEaseMethod(token)).toEqual(expected);
    }
  });

  it('pins all curves to the [0,1] endpoints', () => {
    for (const token of Object.keys(REAL_TOKENS)) {
      expect(ease(0, token)).toBeCloseTo(0, 6);
      expect(ease(1, token)).toBeCloseTo(1, 6);
    }
  });

  it('matches exact Penner midpoint values for each base/direction', () => {
    // ease-in: slow start (below linear); ease-out: fast start (above linear).
    expect(ease(0.5, 'quadIn')).toBeCloseTo(0.25, 6); //  t^2
    expect(ease(0.5, 'quadOut')).toBeCloseTo(0.75, 6); //  1-(1-t)^2
    expect(ease(0.5, 'cubicIn')).toBeCloseTo(0.125, 6); //  t^3
    expect(ease(0.5, 'cubicOut')).toBeCloseTo(0.875, 6);
    expect(ease(0.5, 'quartIn')).toBeCloseTo(0.0625, 6); //  t^4
    expect(ease(0.5, 'quartOut')).toBeCloseTo(0.9375, 6);
    expect(ease(0.5, 'quintIn')).toBeCloseTo(0.03125, 6); // t^5
    expect(ease(0.5, 'quintOut')).toBeCloseTo(0.96875, 6);
    expect(ease(0.5, 'circIn')).toBeCloseTo(1 - Math.sqrt(0.75), 6);
    expect(ease(0.5, 'circOut')).toBeCloseTo(Math.sqrt(0.75), 6);
  });

  it('orders the polynomial families by power (no base mix-up)', () => {
    // Higher power => slower start => smaller value at the midpoint.
    const inAt = (b: string) => ease(0.5, `${b}In`);
    expect(inAt('quint')).toBeLessThan(inAt('quart'));
    expect(inAt('quart')).toBeLessThan(inAt('cubic'));
    expect(inAt('cubic')).toBeLessThan(inAt('quad'));
    expect(inAt('quad')).toBeLessThan(0.5);
    // The Out mirror is reversed and all above linear.
    const outAt = (b: string) => ease(0.5, `${b}Out`);
    expect(outAt('quad')).toBeGreaterThan(0.5);
    expect(outAt('quad')).toBeLessThan(outAt('cubic'));
    expect(outAt('cubic')).toBeLessThan(outAt('quart'));
    expect(outAt('quart')).toBeLessThan(outAt('quint'));
  });

  it('keeps In/Out a mirror pair: out(t) == 1 - in(1-t)', () => {
    for (const base of ['quad', 'cubic', 'quart', 'quint', 'sine', 'circ']) {
      for (const t of [0.1, 0.3, 0.7, 0.9]) {
        expect(ease(t, `${base}Out`)).toBeCloseTo(1 - ease(1 - t, `${base}In`), 6);
      }
    }
  });

  it('keeps symmetric InOut curves symmetric about (0.5, 0.5)', () => {
    for (const token of ['quadInOut', 'cubicInOut', 'sineInOut']) {
      expect(ease(0.5, token)).toBeCloseTo(0.5, 6);
      for (const t of [0.2, 0.4]) {
        expect(ease(t, token) + ease(1 - t, token)).toBeCloseTo(1, 6);
      }
    }
  });

  it('makes back overshoot/undershoot beyond [0,1]', () => {
    expect(ease(0.6, 'backOut')).toBeGreaterThan(1); //  overshoots target
    expect(ease(0.1, 'backInOut')).toBeLessThan(0); //  anticipation dip
    expect(ease(0.9, 'backInOut')).toBeGreaterThan(1); //  overshoot
    expect(ease(0.5, 'backInOut')).toBeCloseTo(0.5, 6); //  still symmetric
  });

  it('makes elasticOut oscillate around the target', () => {
    const samples = [0.1, 0.2, 0.3, 0.4, 0.5].map((t) => ease(t, 'elasticOut'));
    expect(Math.max(...samples)).toBeGreaterThan(1); // springs past target
    expect(Math.min(...samples)).toBeLessThan(1); //  and back under it
  });

  it('drives non-linear progress through the real calculateTweenProgress seam', () => {
    const progressAt = (frameIndex: number, tweens: Tween[]): number => {
      const startFrame = { index: 0, duration: 10, keyMode: 0, elements: [] } as any;
      const endFrame = { index: 10, duration: 10, keyMode: 0, elements: [] } as any;
      return (renderer as any).calculateTweenProgress(frameIndex, startFrame, endFrame, undefined, tweens);
    };
    // cubicIn at the span midpoint => 0.125, clamped into [0,1].
    expect(progressAt(5, [{ target: 'all', method: 'cubicIn' }])).toBeCloseTo(0.125, 6);
    // backOut's overshoot is clamped to 1 by calculateTweenProgress.
    expect(progressAt(9, [{ target: 'all', method: 'backOut' }])).toBeLessThanOrEqual(1);
  });
});
