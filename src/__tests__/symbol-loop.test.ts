import { describe, it, expect } from 'vitest';
import { graphicSymbolFrame } from '../symbol-loop';
import type { SymbolInstance } from '../types';

// Frames shown on parent frames 0..count-1 of a keyframe, for a 10-frame symbol.
const run = (loop: SymbolInstance['loop'], first: number, last: number | undefined, count = 12) =>
  Array.from({ length: count }, (_, offset) => graphicSymbolFrame(loop, first, last, 10, offset));

describe('graphicSymbolFrame', () => {
  describe('forward modes (unchanged behavior)', () => {
    it('loops through the whole timeline from firstFrame', () => {
      expect(run('loop', 7, undefined)).toEqual([7, 8, 9, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('loops between firstFrame and lastFrame', () => {
      expect(run('loop', 2, 4, 7)).toEqual([2, 3, 4, 2, 3, 4, 2]);
    });

    it('plays once and holds the last frame', () => {
      expect(run('play once', 7, undefined, 5)).toEqual([7, 8, 9, 9, 9]);
      expect(run('play once', 2, 4, 5)).toEqual([2, 3, 4, 4, 4]);
    });

    it('shows firstFrame for single frame', () => {
      expect(run('single frame', 3, 6, 3)).toEqual([3, 3, 3]);
    });

    it('wraps through the end when lastFrame is before firstFrame', () => {
      expect(run('loop', 8, 1, 6)).toEqual([8, 9, 0, 1, 8, 9]);
      expect(run('play once', 8, 1, 6)).toEqual([8, 9, 0, 1, 1, 1]);
    });
  });

  describe('reverse modes (Animate 2021)', () => {
    it('plays backwards once and stops at frame 0 without lastFrame', () => {
      expect(run('play once reverse', 3, undefined, 6)).toEqual([3, 2, 1, 0, 0, 0]);
    });

    it('loops backwards around the whole timeline without lastFrame', () => {
      expect(run('loop reverse', 2, undefined)).toEqual([2, 1, 0, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    });

    it('plays backwards from firstFrame down to lastFrame', () => {
      expect(run('play once reverse', 6, 3, 6)).toEqual([6, 5, 4, 3, 3, 3]);
      expect(run('loop reverse', 6, 3, 9)).toEqual([6, 5, 4, 3, 6, 5, 4, 3, 6]);
    });

    it('wraps backwards through frame 0 when lastFrame is after firstFrame', () => {
      expect(run('loop reverse', 1, 8, 6)).toEqual([1, 0, 9, 8, 1, 0]);
      expect(run('play once reverse', 1, 8, 6)).toEqual([1, 0, 9, 8, 8, 8]);
    });

    it('stays on firstFrame when firstFrame equals lastFrame', () => {
      expect(run('loop reverse', 4, 4, 3)).toEqual([4, 4, 4]);
    });
  });

  it('clamps lastFrame to the timeline and ignores -1 (unset)', () => {
    expect(run('play once', 7, 50, 5)).toEqual([7, 8, 9, 9, 9]);
    expect(run('loop', 7, -1, 4)).toEqual([7, 8, 9, 0]);
  });
});
