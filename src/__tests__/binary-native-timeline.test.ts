import { describe, expect, it } from 'vitest';
import {
  decodeNativeStreamTimeline,
  decodeNativeTimelineTreeDetailed,
} from '../binary-native-timeline';
import { decodeStreamTimeline } from '../binary-timeline-decoder';
import { parseBinaryFLA } from '../binary-fla-parser';
import type { Frame, Shape } from '../types';
import { buildCFB } from './binary-cfb-builder';

// Synthetic streams laid out like the CS4 files the object walker was ported
// for: page/layer/frame bases at schema 5, layer schema 13 (the older walker
// only accepts 11) and frame schema 29 with a format-1 timeline sub-object.

const u8 = (...v: number[]): number[] => v.map((n) => n & 0xff);
const u16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
const s16 = (v: number): number[] => u16(v < 0 ? v + 0x10000 : v);
const u32 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
const s32 = (v: number): number[] => u32(v < 0 ? v + 0x100000000 : v);
const utf16 = (s: string): number[] => [...s].flatMap((c) => u16(c.charCodeAt(0)));
const flashStr = (s: string): number[] => [0xff, 0xfe, 0xff, s.length, ...utf16(s)];

const NULL_TAG = [0x00, 0x00];
const INT_MIN = s32(-0x80000000);
/** End of a schema-5 CPicObj children list: NULL tag, origin point, 2 extras. */
const OBJ_END = [...NULL_TAG, ...INT_MIN, ...INT_MIN, ...u8(0, 0)];
const IDENTITY = [...u32(0x10000), ...u32(0), ...u32(0), ...u32(0x10000), ...u32(0), ...u32(0)];
/** shape_data_schema 5 with no styles, no edges and no cubic edges. */
const EMPTY_SHAPE_DATA = [...u8(5), ...u32(0), ...u16(0), ...u16(0), ...u8(0), ...s32(0)];
/** shape_data_schema 5 with one line edge and an implausible cubic count. */
const BAD_CUBICS_SHAPE_DATA = [
  ...u8(5), ...u32(0), ...u16(0), ...u16(0),
  ...u8(0x22), ...s32(0), ...s32(0), ...s32(2560), ...s32(0), ...u8(0),
  ...s32(0x7fffffff),
];

/** A green square in the legacy (schema 2) shape-data layout: 4 edges. */
function squareShapeData(sizePx: number): number[] {
  const sz = sizePx * 2560;
  const d = (dx: number, dy: number) => [...s32(dx), ...s32(dy)];
  const out = [...u8(2), ...u32(0), ...u16(1), ...u32(0xff00ff00), ...u16(0), ...u16(0)];
  out.push(...u8(0x62), ...u16(0), ...u16(1), ...u16(0), ...d(0, 0), ...d(sz, 0));
  for (const [dx, dy] of [[0, sz], [-sz, 0], [0, -sz]]) out.push(...u8(0x22), ...d(0, 0), ...d(dx, dy));
  out.push(...u8(0));
  return out;
}

/** A CPicShape child body (base schema 5) at (x, 100). */
const squareShape = (x: number): number[] => [
  ...u8(5, 0),
  ...OBJ_END,
  ...u8(2),
  ...u32(0x10000), ...u32(0), ...u32(0), ...u32(0x10000), ...s32(x * 20), ...s32(100 * 20),
  ...squareShapeData(40),
];

interface FrameSpec {
  span: number;
  /** x of a square placed in this keyframe. */
  x?: number;
  keyMode?: number;
  acceleration?: number;
  soundRef?: number;
  /** Give the frame's canvas shape an edge and an implausible cubic count. */
  badCubics?: boolean;
}
interface LayerSpec {
  name: string;
  frames: FrameSpec[];
}

function frameTail(f: FrameSpec): number[] {
  return [
    ...u8(29), ...u16(f.span), ...u16(f.keyMode ?? 0x2200), ...s16(f.acceleration ?? 0),
    ...u16(f.soundRef ?? 0), ...u16(0), // sound ref, entry count
    ...u16(1), ...u8(0), ...u32(0), ...s32(0x3fffffff), ...u16(2),
    ...flashStr(''), // pre-timeline label (schema >= 23)
    ...u32(5), ...u32(1), // timeline sub-object: type id, format 1
    ...u32(0x2beb), ...u32(0), ...u32(0), ...flashStr(''),
    ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...flashStr(''),
    ...u32(1), ...u32(0), ...u32(0), ...u32(1), ...u32(0),
  ];
}

function layerTail(name: string): number[] {
  return [
    ...u8(13), ...flashStr(name),
    ...u8(1, 0, 0), // current, locked, hidden
    ...u32(0xff4f80ff), ...u32(0), ...u32(0), ...u32(0), ...u8(0),
    ...NULL_TAG, // parent layer
    ...u8(0, 0, 0),
  ];
}

/** A `Page N` / `Symbol N` stream, numbering objects like MFC's load array. */
function cs4Stream(layers: LayerSpec[]): Uint8Array {
  const classSlot = new Map<string, number>();
  let loadArrayLength = 0;
  const newObject = (name: string): number[] => {
    const slot = classSlot.get(name);
    if (slot !== undefined) {
      loadArrayLength += 1;
      return u16(0x8000 | slot);
    }
    classSlot.set(name, loadArrayLength + 1);
    loadArrayLength += 2;
    return [0xff, 0xff, ...u16(1), ...u16(name.length), ...[...name].map((c) => c.charCodeAt(0))];
  };
  const out = [0x01, ...newObject('CPicPage'), ...u8(5, 1)];
  for (const layer of layers) {
    out.push(...newObject('CPicLayer'), ...u8(5, 1));
    for (const f of layer.frames) {
      out.push(...newObject('CPicFrame'), ...u8(5, 1));
      if (f.x !== undefined) out.push(...newObject('CPicShape'), ...squareShape(f.x));
      out.push(...OBJ_END, ...u8(6), ...IDENTITY, ...(f.badCubics ? BAD_CUBICS_SHAPE_DATA : EMPTY_SHAPE_DATA), ...frameTail(f));
    }
    out.push(...OBJ_END, ...layerTail(layer.name));
  }
  out.push(...OBJ_END, ...u8(7, 3, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0));
  return Uint8Array.from(out);
}

const ANIMATED: LayerSpec[] = [
  { name: 'Back', frames: [{ span: 3, x: 10 }, { span: 2, x: 60 }] },
  { name: 'Front', frames: [{ span: 1 }, { span: 4, x: 110, keyMode: 0x4601, acceleration: -50 }] },
];

describe('decodeNativeStreamTimeline', () => {
  it('walks a CS4-style stream the older walker rejects', () => {
    const data = cs4Stream(ANIMATED);
    expect(decodeStreamTimeline(data)).toBeNull();

    const tl = decodeNativeStreamTimeline(data);
    expect(tl).not.toBeNull();
    expect(tl!.totalFrames).toBe(5);
    // Stream order (bottom-first), like decodeStreamTimeline.
    expect(tl!.layers.map((l) => [l.name, l.schema])).toEqual([['Back', 13], ['Front', 13]]);
    expect(tl!.layers.map((l) => l.keyframes.map((k) => [k.startIndex, k.duration]))).toEqual([
      [[0, 3], [3, 2]],
      [[0, 1], [1, 4]],
    ]);
  });

  it('gives each keyframe the byte range of its own frame body', () => {
    const data = cs4Stream(ANIMATED);
    const kfs = decodeNativeStreamTimeline(data)!.layers.flatMap((l) => l.keyframes);
    for (let i = 1; i < kfs.length; i++) {
      expect(kfs[i].bodyStart).toBeGreaterThanOrEqual(kfs[i - 1].bodyEnd);
    }
    for (const kf of kfs) {
      // Each frame body starts with its CPicObj base (schema 5, flags 1).
      expect([data[kf.bodyStart], data[kf.bodyStart + 1]]).toEqual([5, 1]);
      expect(kf.bodyEnd).toBeGreaterThan(kf.bodyStart);
    }
  });

  it('reads the motion tween flag, ease and sound from the frame tail', () => {
    const tl = decodeNativeStreamTimeline(
      cs4Stream([
        {
          name: 'Layer 1',
          frames: [
            { span: 5, keyMode: 0x4601, acceleration: 30, soundRef: 2 },
            { span: 1, keyMode: 0x4601, acceleration: 500 },
            { span: 1 },
          ],
        },
      ])
    )!;
    const [tween, badEase, still] = tl.layers[0].keyframes;
    expect(tween).toMatchObject({ motionTween: true, acceleration: 30, soundRef: 2 });
    // Out-of-range ease is dropped, as in decodeStreamTimeline.
    expect(badEase).toMatchObject({ motionTween: true, acceleration: 0 });
    expect(still.motionTween).toBeUndefined();
    expect(still.soundRef).toBeUndefined();
  });

  it('reads the locked and hidden flags in that order', () => {
    // Layer tail after the name: u8 current, u8 locked, u8 hidden.
    const withFlags = (locked: number, hidden: number) => {
      const data = cs4Stream([{ name: 'L', frames: [{ span: 1 }, { span: 1 }] }]);
      const name = flashStr('L');
      const at = data.findIndex((_, i) => name.every((b, j) => data[i + j] === b)) + name.length;
      data[at] = 0; // not the current layer
      data[at + 1] = locked;
      data[at + 2] = hidden;
      return decodeNativeStreamTimeline(data)!.layers[0];
    };
    expect(withFlags(1, 0)).toMatchObject({ locked: true, visible: true });
    expect(withFlags(0, 1)).toMatchObject({ locked: false, visible: false });
  });

  it('returns null when no layer has more than one keyframe', () => {
    const data = cs4Stream([{ name: 'Still', frames: [{ span: 10, x: 10 }] }]);
    expect(decodeNativeTimelineTreeDetailed(data).ok).toBe(true);
    expect(decodeNativeStreamTimeline(data)).toBeNull();
  });

  it('returns null for an implausible layer name', () => {
    const data = cs4Stream([{ name: 'bad\u0001name', frames: [{ span: 1 }, { span: 1 }] }]);
    expect(decodeNativeTimelineTreeDetailed(data).ok).toBe(true);
    expect(decodeNativeStreamTimeline(data)).toBeNull();
  });

  it('returns null when the walk merges frames the flat scan still sees', () => {
    // An unreadable cubic count in a frame's canvas shape makes the walker
    // resync on the last frame tail before the layer end, so 'Merged' reads
    // as one frame. Every layer must match its CPicFrame object count.
    const layers: LayerSpec[] = [
      { name: 'Merged', frames: [{ span: 1, badCubics: true }, { span: 1 }, { span: 1 }] },
      { name: 'Fine', frames: [{ span: 1 }, { span: 2 }] },
    ];
    const walked = decodeNativeTimelineTreeDetailed(cs4Stream(layers)).page!;
    expect(walked.layers.map((l) => l.frames.length)).toEqual([1, 2]);
    expect(decodeNativeStreamTimeline(cs4Stream(layers))).toBeNull();
    // Same stream with a readable canvas shape passes.
    layers[0].frames[0].badCubics = false;
    expect(decodeNativeStreamTimeline(cs4Stream(layers))?.layers.map((l) => l.keyframes.length)).toEqual([3, 2]);
  });

  it('does not count class-bit noise on an object slot as a frame', () => {
    // 260 frames push the load array past 255 entries, so the bytes FF 80 in
    // each layer colour read as tag 0x80FF, a reference to object slot 255.
    const many = Array.from({ length: 260 }, () => ({ span: 1 }));
    const tl = decodeNativeStreamTimeline(
      cs4Stream([
        { name: 'Long', frames: many },
        { name: 'Short', frames: [{ span: 2 }, { span: 3 }] },
      ])
    );
    expect(tl?.layers.map((l) => l.keyframes.length)).toEqual([260, 2]);
    expect(tl?.totalFrames).toBe(260);
  });

  it('never throws on truncated or garbage input', () => {
    const data = cs4Stream(ANIMATED);
    for (const cut of [0, 1, 5, 20, 100, data.length >> 1, data.length - 30]) {
      expect(() => decodeNativeStreamTimeline(data.subarray(0, cut))).not.toThrow();
      expect(decodeNativeTimelineTreeDetailed(data.subarray(0, cut)).ok).toBe(false);
    }
    const noise = Uint8Array.from({ length: 2000 }, (_, i) => (i * 131 + 7) & 0xff);
    expect(decodeNativeStreamTimeline(noise)).toBeNull();
  });
});

describe('parseBinaryFLA with the object walker', () => {
  const contents = Uint8Array.from([...new Array(120).fill(0), 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0xff]);
  const squareXs = (frames: Frame[]): number[] =>
    frames.flatMap((f) => f.elements.filter((e): e is Shape => e.type === 'shape').map((s) => s.matrix?.tx ?? 0));

  it('puts each square on its own keyframe of a CS4-style scene', () => {
    const doc = parseBinaryFLA(
      buildCFB([
        { name: 'Contents', data: contents },
        { name: 'Page 1', data: cs4Stream(ANIMATED) },
      ])
    );
    const scene = doc.timelines[0];
    expect(scene.totalFrames).toBe(5);
    // Top-first for the viewer.
    expect(scene.layers.map((l) => l.name)).toEqual(['Front', 'Back']);
    const [front, back] = scene.layers;
    expect(back.frames.map((f) => [f.index, f.duration, squareXs([f])])).toEqual([
      [0, 3, [10]],
      [3, 2, [60]],
    ]);
    expect(front.frames.map((f) => [f.index, f.duration, squareXs([f])])).toEqual([
      [0, 1, []],
      [1, 4, [110]],
    ]);
    expect(front.frames[1]).toMatchObject({ tweenType: 'motion', acceleration: -50 });
  });
});
