import { describe, it, expect } from 'vitest';
import {
  graphicSymbolFrame, callsStop, instanceClock, movieClipClock, movieClipPlayhead, movieClipRun, movieClipStopFrames,
  movieClipTicks, rootClock
} from '../symbol-loop';
import type { Frame, Layer, SymbolInstance, Timeline } from '../types';

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

describe('movie clip stop() frames', () => {
  it.each([
    ['stop();', true],
    ['this.stop();', true],
    ['this . stop ( );', true],
    ['if (done) stop();', true],
    ['trace("x");\nstop();', true],
    ['mc.stop();', false],
    ['snd.stop();', false],
    ['gotoAndStop(3);', false],
    ['stopAllSounds();', false],
    ['// stop();', false],
    ['/* stop(); */ play();', false],
    ['trace("stop()");', false],
    ['function stop() {}', false],
    ['btn.addEventListener(MouseEvent.CLICK, function(e:MouseEvent):void { stop(); });', false],
    ['this.btn.on("click", () => { this.stop(); });', false],
    ['function onClick(e) {\n  stop();\n}', false],
    ['navigateToURL(new URLRequest("http://example.com")); stop();', true],
    ["var s = 'it\\'s'; stop();", true],
    ['if (done) { stop(); }', true],
    ['btn.onRelease = function() { play(); };\nstop();', true],
    ['this.btn.on("click", () => this.stop());', false],
    ['setTimeout(() => this.stop(), 100); play();', false],
    ['var f = () => 1; stop();', true],
    ['var r = /"/; stop();', true],
    ['var r = /[/]/g; stop();', true],
    ['var half = total / 2; stop();', true],
    ['var w = margin              / 2; stop();', true],
    ['var w = obj.return / 2; stop();', true],
    ['if (ok) return\n  /"/.test(s); stop();', true],
    ['function quote(s) { return /"/.test(s); }\nstop();', true],
    ['var x:XML = <a>b</a>; stop();', true],
  ])('callsStop(%j) is %s', (script, expected) => {
    expect(callsStop(script)).toBe(expected);
  });

  const layer = (frames: Partial<Frame>[], layerType?: Layer['layerType']): Layer =>
    ({ name: 'L', color: '#000000', visible: true, locked: false, layerType, frames: frames as Frame[] }) as Layer;

  it('collects the keyframes whose script stops the clip, ignoring guide layers', () => {
    const timeline = {
      name: 'Clip',
      totalFrames: 10,
      referenceLayers: new Set<number>(),
      layers: [
        layer([{ index: 0, duration: 4 }, { index: 4, duration: 6, actionScript: 'stop();' }]),
        layer([{ index: 2, duration: 1, actionScript: 'this.stop();' }, { index: 3, duration: 7, actionScript: 'play();' }]),
        layer([{ index: 7, duration: 1, actionScript: 'stop();' }], 'guide'),
      ],
    } as Timeline;
    expect([...movieClipStopFrames(timeline)].sort()).toEqual([2, 4]);
  });
});

describe('movieClipPlayhead', () => {
  const none = new Set<number>();
  it('loops one frame per tick without stops', () => {
    expect([0, 1, 2, 3, 7].map((t) => movieClipPlayhead(t, 3, none).frame)).toEqual([0, 1, 2, 0, 1]);
  });

  it('holds once it tries to leave a stop frame', () => {
    const stops = new Set([1]);
    expect([0, 1, 2, 50].map((t) => movieClipPlayhead(t, 3, stops))).toEqual([
      { frame: 0, stopped: false },
      { frame: 1, stopped: false },
      { frame: 1, stopped: true },
      { frame: 1, stopped: true },
    ]);
  });

  it('stays on frame 0 for a one-frame clip and ignores stops past the end', () => {
    expect(movieClipPlayhead(5, 1, new Set([0]))).toEqual({ frame: 0, stopped: false });
    expect(movieClipPlayhead(4, 3, new Set([7]))).toEqual({ frame: 1, stopped: false });
  });
});

describe('movieClipRun', () => {
  const instance = (name: string, symbolType: SymbolInstance['symbolType'] = 'movieclip') =>
    ({ type: 'symbol', libraryItemName: name, symbolType }) as SymbolInstance;
  const key = (index: number, duration: number, elements: SymbolInstance[]) =>
    ({ index, duration, elements }) as unknown as Frame;

  it('spans back-to-back keyframes holding the same instance', () => {
    const frames = [key(0, 2, [instance('A')]), key(2, 1, [instance('A')]), key(3, 4, [instance('A')]), key(7, 1, [])];
    expect(movieClipRun(frames, frames[1], 0, 'A')).toEqual({ start: 0, end: 7 });
  });

  it('stops at a gap, another symbol, another slot or a graphic', () => {
    const gap = [key(0, 1, [instance('A')]), key(2, 1, [instance('A')])];
    expect(movieClipRun(gap, gap[1], 0, 'A')).toEqual({ start: 2, end: 3 });
    const other = [key(0, 1, [instance('B')]), key(1, 1, [instance('A')]), key(2, 1, [instance('B')])];
    expect(movieClipRun(other, other[1], 0, 'A')).toEqual({ start: 1, end: 2 });
    const slot = [key(0, 1, [instance('B'), instance('A')]), key(1, 1, [instance('A')])];
    expect(movieClipRun(slot, slot[1], 0, 'A')).toEqual({ start: 1, end: 2 });
    const graphic = [key(0, 1, [instance('A', 'graphic')]), key(1, 1, [instance('A')])];
    expect(movieClipRun(graphic, graphic[1], 0, 'A')).toEqual({ start: 1, end: 2 });
  });
});

describe('movieClipTicks', () => {
  const clip = (ticks: number, totalFrames: number, stops: number[] = []) => movieClipClock(ticks, totalFrames, new Set(stops));

  it('counts from the run start on the main timeline', () => {
    expect(movieClipTicks({ start: 5, end: 10 }, rootClock(7))).toBe(2);
    expect(movieClipTicks({ start: 0, end: 10 }, rootClock(0))).toBe(0);
  });

  it('counts the enclosing clip\'s whole life when its run covers its timeline', () => {
    expect(movieClipTicks({ start: 0, end: 4 }, clip(9, 4))).toBe(9);
  });

  it('restarts with every pass of a looping enclosing clip otherwise', () => {
    // Enclosing 4-frame clip, 9 ticks old: on its frame 1; the run [0, 2) began at tick 8.
    expect(movieClipTicks({ start: 0, end: 2 }, clip(9, 4))).toBe(1);
  });

  it('counts from the run start in an enclosing clip that held at a stop()', () => {
    expect(movieClipTicks({ start: 0, end: 1 }, clip(9, 4, [0]))).toBe(9);
    expect(movieClipTicks({ start: 1, end: 3 }, clip(9, 4, [2]))).toBe(8);
  });
});

describe('instanceClock', () => {
  const instance = (name: string, symbolType: SymbolInstance['symbolType'], extra: Partial<SymbolInstance> = {}) =>
    ({ type: 'symbol', libraryItemName: name, symbolType, ...extra }) as SymbolInstance;
  const key = (index: number, duration: number, elements: SymbolInstance[]) =>
    ({ index, duration, elements }) as unknown as Frame;
  const frames = (clock: (k: number) => number | undefined, count: number) =>
    Array.from({ length: count }, (_, k) => clock(k));

  it('reads back a looping graphic\'s frames while its layer holds it', () => {
    const G = instance('G', 'graphic', { loop: 'loop' });
    const layer = [key(0, 2, []), key(2, 8, [G])];
    // Parent frame 6: the 3-frame graphic shows (6 - 2) % 3 = 1, placed 4 ticks ago.
    const clock = instanceClock(rootClock(6), layer, 0, G, 3);
    expect(frames(clock, 6)).toEqual([1, 0, 2, 1, 0, undefined]);
  });

  it('follows each keyframe\'s own loop settings and stops at another symbol or slot', () => {
    const at = (firstFrame: number) => instance('G', 'graphic', { loop: 'single frame', firstFrame });
    const layer = [key(0, 1, [instance('H', 'graphic')]), key(1, 2, [at(3)]), key(3, 2, [at(1)])];
    expect(frames(instanceClock(rootClock(4), layer, 0, at(1), 5), 5)).toEqual([1, 1, 3, 3, undefined]);
    const moved = [key(0, 2, [instance('H', 'graphic'), at(0)]), key(2, 2, [at(0)])];
    expect(frames(instanceClock(rootClock(3), moved, 0, at(0), 5), 3)).toEqual([0, 0, undefined]);
  });

  it('reads overlapping keyframes the way the renderer does: the first one wins', () => {
    const at = (firstFrame: number) => instance('G', 'graphic', { loop: 'single frame', firstFrame });
    // Frames 2 and 3 lie in both keyframes; the renderer draws the first.
    const layer = [key(0, 4, [at(1)]), key(2, 3, [at(3)])];
    expect(frames(instanceClock(rootClock(4), layer, 0, at(1), 5), 5)).toEqual([3, 1, 1, 1, 1]);
  });

  it('shows a button\'s first frame', () => {
    const B = instance('B', 'button');
    expect(frames(instanceClock(rootClock(2), [key(0, 5, [B])], 0, B, 4), 4)).toEqual([0, 0, 0, undefined]);
  });

  it('seeds a clip inside a graphic from how long the graphic stayed in its run', () => {
    const G = instance('G', 'graphic', { loop: 'loop' });
    const layer = [key(0, 20, [G])];
    // A one-frame graphic holds the clip for all 12 parent frames.
    expect(movieClipTicks({ start: 0, end: 1 }, instanceClock(rootClock(12), layer, 0, G, 1))).toBe(12);
    // A 4-frame looping graphic re-enters a clip run of [0, 2) on every pass;
    // one covering its whole timeline keeps the clip.
    expect(movieClipTicks({ start: 0, end: 2 }, instanceClock(rootClock(9), layer, 0, G, 4))).toBe(1);
    expect(movieClipTicks({ start: 0, end: 4 }, instanceClock(rootClock(9), layer, 0, G, 4))).toBe(9);
  });

  it('starts a clip over when its graphic jumps into the run', () => {
    const at = (firstFrame: number) => instance('G', 'graphic', { loop: 'single frame', firstFrame });
    // Frame 3 lies outside the clip's run [0, 2); frame 1 inside it from parent frame 3.
    const layer = [key(0, 3, [at(3)]), key(3, 4, [at(1)])];
    expect(movieClipTicks({ start: 0, end: 2 }, instanceClock(rootClock(5), layer, 0, at(1), 5))).toBe(2);
  });

  it('walks a layer with a keyframe on every frame in linear time', () => {
    const G = instance('G', 'graphic', { loop: 'loop' });
    const count = 2000;
    const keys = Array.from({ length: count }, (_, i) => key(i, 1, [G]));
    let reads = 0;
    const layer = new Proxy(keys, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) reads++;
        return Reflect.get(target, prop, receiver);
      },
    });
    expect(movieClipTicks({ start: 0, end: 1 }, instanceClock(rootClock(count - 1), layer, 0, G, 1))).toBe(count - 1);
    // A scan from the first keyframe at every step read about count² / 2 = 2M.
    expect(reads).toBeLessThan(count * 20);
  });

  it('finds keyframes listed out of order and stops at a gap in the layer', () => {
    const G = instance('G', 'graphic', { loop: 'loop' });
    const unsorted = [key(4, 2, [G]), key(0, 2, [G]), key(2, 2, [G])];
    expect(frames(instanceClock(rootClock(5), unsorted, 0, G, 10), 7)).toEqual([1, 0, 1, 0, 1, 0, undefined]);
    const gap = [key(0, 2, [G]), key(4, 2, [G])];
    expect(frames(instanceClock(rootClock(5), gap, 0, G, 10), 3)).toEqual([1, 0, undefined]);
  });
});
