import { describe, it, expect } from 'vitest';
import { graphicSymbolFrame, callsStop, movieClipAppearance, movieClipPlayhead, movieClipStopFrames } from '../symbol-loop';
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

describe('movieClipAppearance', () => {
  const instance = (name: string, symbolType: SymbolInstance['symbolType'] = 'movieclip') =>
    ({ type: 'symbol', libraryItemName: name, symbolType }) as SymbolInstance;
  const key = (index: number, duration: number, elements: SymbolInstance[]) =>
    ({ index, duration, elements }) as unknown as Frame;

  it('goes back over back-to-back keyframes holding the same instance', () => {
    const frames = [key(0, 2, [instance('A')]), key(2, 1, [instance('A')]), key(3, 4, [instance('A')])];
    expect(movieClipAppearance(frames, frames[2], 0, 'A')).toBe(0);
  });

  it('stops at a gap, another symbol, another slot or a graphic', () => {
    const gap = [key(0, 1, [instance('A')]), key(2, 1, [instance('A')])];
    expect(movieClipAppearance(gap, gap[1], 0, 'A')).toBe(2);
    const other = [key(0, 1, [instance('B')]), key(1, 1, [instance('A')])];
    expect(movieClipAppearance(other, other[1], 0, 'A')).toBe(1);
    const slot = [key(0, 1, [instance('B'), instance('A')]), key(1, 1, [instance('A')])];
    expect(movieClipAppearance(slot, slot[1], 0, 'A')).toBe(1);
    const graphic = [key(0, 1, [instance('A', 'graphic')]), key(1, 1, [instance('A')])];
    expect(movieClipAppearance(graphic, graphic[1], 0, 'A')).toBe(1);
  });
});
