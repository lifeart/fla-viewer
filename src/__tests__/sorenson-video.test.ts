import { describe, it, expect, vi, afterEach } from 'vitest';
import JSZip from 'jszip';
import { parseFLV } from '../flv-parser';
import { SorensonH263Decoder, readSorensonHeader, sorensonPictureToRGBA, type SorensonPicture } from '../sorenson-h263';
import { EmbeddedVideoDecoder, embeddedVideoFromFLV, parseEmbeddedVideoDat } from '../embedded-video';
import { FLAParser } from '../fla-parser';
import { FLARenderer } from '../renderer';
// Sorenson Spark clips encoded by ffmpeg (`-c:v flv`) with their ffmpeg-decoded
// YUV 4:2:0 frames as the reference.
// basic: 40x24 (not macroblock-aligned), I P P P I P P P, many skipped macroblocks.
import basicFlvUrl from './fixtures/sorenson-basic.flv?url';
import basicYuvUrl from './fixtures/sorenson-basic.yuv?url';
// motion: 48x32, I + 5 P with half-pel motion vectors, DQUANT and escaped coefficients.
import motionFlvUrl from './fixtures/sorenson-motion.flv?url';
import motionYuvUrl from './fixtures/sorenson-motion.yuv?url';

async function fetchBytes(url: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

async function loadClip(flvUrl: string) {
  const flv = await fetchBytes(flvUrl);
  const parsed = parseFLV(flv.buffer as ArrayBuffer);
  return parsed.videoTags.map((t) => t.videoData);
}

/** Max and mean absolute difference between a decoded picture and an I420 frame. */
function diffAgainstI420(pic: SorensonPicture, yuv: Uint8Array, offset: number) {
  const { width: w, height: h } = pic;
  const cw = Math.ceil(w / 2);
  const ch = Math.ceil(h / 2);
  let max = 0;
  let sum = 0;
  let n = 0;
  let o = offset;
  const cmp = (plane: Uint8Array, stride: number, pw: number, ph: number) => {
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const d = Math.abs(plane[y * stride + x] - yuv[o + y * pw + x]);
        max = Math.max(max, d);
        sum += d;
        n++;
      }
    }
    o += pw * ph;
  };
  cmp(pic.y, pic.lumaStride, w, h);
  cmp(pic.cb, pic.chromaStride, cw, ch);
  cmp(pic.cr, pic.chromaStride, cw, ch);
  return { max, mean: sum / n, next: o };
}

/** Build an Animate embedded-video .dat (header, frame index, frame data). */
function buildDat(frames: Uint8Array[], opts: { codecId?: number; width: number; height: number; extraHeader?: number }): Uint8Array {
  const header = new Uint8Array(75 + (opts.extraHeader ?? 0));
  const dv = new DataView(header.buffer);
  header[0] = 0x03;
  header[1] = opts.codecId ?? 2;
  header[11] = 0x28; header[12] = 0x40; // 12.0 fps double (bytes 5..12)
  dv.setUint32(29, opts.width, true);
  dv.setUint32(33, opts.height, true);
  dv.setFloat64(37, frames.length / 12, true);
  const parts: number[] = [];
  let offset = 0;
  frames.forEach((f, i) => {
    if (i === 0) parts.push(1);
    const e = new DataView(new ArrayBuffer(16));
    e.setUint32(0, offset, true);
    e.setUint32(4, f.length, true);
    e.setUint8(8, 1);
    e.setUint8(12, i === 0 ? 5 : 4);
    parts.push(...new Uint8Array(e.buffer));
    parts.push(i < frames.length - 1 ? 1 : 0);
    offset += f.length;
  });
  if (frames.length === 0) parts.push(0);
  const total = new DataView(new ArrayBuffer(4));
  total.setUint32(0, offset, true);
  parts.push(...new Uint8Array(total.buffer));
  const data = new Uint8Array(header.length + parts.length + offset + 12);
  data.set(header, 0);
  data.set(parts, header.length);
  let p = header.length + parts.length;
  for (const f of frames) { data.set(f, p); p += f.length; }
  return data; // trailing 12 zero bytes stand in for the (empty) audio section
}

/** MSB-first bit writer for hand-built Sorenson pictures. */
class BitWriter {
  private bits: number[] = [];
  put(value: number, n: number): this {
    for (let i = n - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
    return this;
  }
  code(s: string): this {
    for (const c of s) this.bits.push(c === '1' ? 1 : 0);
    return this;
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => { out[i >> 3] |= b << (7 - (i & 7)); });
    return out;
  }
}

/** Header of a 16x16 picture (one macroblock). type: 0 = I, 1 = P, 2 = disposable P. */
function header16(w: BitWriter, version: number, type: number, quant = 4): BitWriter {
  return w.put(1, 17).put(version, 5).put(0, 8).put(0, 3).put(16, 8).put(16, 8)
    .put(type, 2).put(0, 1).put(quant, 5).put(0, 1);
}

describe('Sorenson Spark H.263 decoder', () => {
  it.each([
    ['basic', basicFlvUrl, basicYuvUrl, 8],
    ['motion', motionFlvUrl, motionYuvUrl, 6],
  ])('matches ffmpeg on the %s clip', async (_name, flvUrl, yuvUrl, frameCount) => {
    const frames = await loadClip(flvUrl);
    const yuv = await fetchBytes(yuvUrl);
    expect(frames.length).toBe(frameCount);
    const decoder = new SorensonH263Decoder();
    let offset = 0;
    for (const frame of frames) {
      const pic = decoder.decode(frame);
      const { max, mean, next } = diffAgainstI420(pic, yuv, offset);
      offset = next;
      // Only IDCT rounding differs from ffmpeg's integer IDCT.
      expect(max).toBeLessThanOrEqual(2);
      expect(mean).toBeLessThan(0.1);
    }
    expect(offset).toBe(yuv.length);
  });

  it('reads the picture header (size, type, version)', async () => {
    const frames = await loadClip(basicFlvUrl);
    expect(readSorensonHeader(frames[0])).toMatchObject({ width: 40, height: 24, type: 'I', version: 1 });
    expect(readSorensonHeader(frames[1])).toMatchObject({ type: 'P' });
    expect(readSorensonHeader(new Uint8Array([0x46, 0x4c, 0x56, 0x01]))).toBeNull();
  });

  it('decodes version-0 8-bit escapes, and never predicts from a disposable picture', () => {
    // I picture: Y1 = DC 100 plus an escaped AC coefficient (u=1, level 20); the
    // other blocks are flat DC (luma 100, chroma 128).
    const iw = header16(new BitWriter(), 0, 0)
      .code('1')      // MCBPC: INTRA, no chroma coefficients
      .code('00010')  // CBPY: only Y1 has coefficients
      .put(100, 8)    // Y1 INTRADC
      .code('0000011').put(1, 1).put(0, 6).put(20, 8) // ESCAPE: last, run 0, level +20
      .put(100, 8).put(100, 8).put(100, 8)            // Y2..Y4 INTRADC
      .put(255, 8).put(255, 8);                       // Cb, Cr INTRADC (255 codes level 1024 = 128)
    // Disposable P picture: an intra macroblock of luma 50.
    const dw = header16(new BitWriter(), 0, 2)
      .put(0, 1).code('00011').code('0011')           // COD=0, MCBPC INTRA, CBPY none
      .put(50, 8).put(50, 8).put(50, 8).put(50, 8).put(255, 8).put(255, 8);
    // P picture: the macroblock is skipped, so it copies its reference.
    const pw = header16(new BitWriter(), 0, 1).put(1, 1);

    const decoder = new SorensonH263Decoder();
    const i = decoder.decode(iw.bytes());
    // A positive horizontal cosine term: Y1's left columns are brighter than its right.
    expect(i.y[0]).toBeGreaterThan(i.y[7]);
    expect(i.y[0]).toBeGreaterThan(105);
    expect(i.y[7]).toBeLessThan(95);
    expect(i.y[8]).toBe(100); // Y2 is flat
    expect(i.cb[0]).toBe(128);

    const d = decoder.decode(dw.bytes());
    expect(d.header.type).toBe('D');
    expect(d.y[8]).toBe(50);

    const p = decoder.decode(pw.bytes());
    expect(Array.from(p.y)).toEqual(Array.from(i.y)); // not the disposable picture's 50
  });

  it('rejects data that is not a Sorenson picture', () => {
    expect(() => new SorensonH263Decoder().decode(new Uint8Array([0x03, 0x02, 0x00, 0x00]))).toThrow();
  });
});

describe('embedded video .dat', () => {
  it('reads the frame index of an Animate embedded-video .dat', async () => {
    const frames = await loadClip(basicFlvUrl);
    const stream = parseEmbeddedVideoDat(buildDat(frames, { width: 40, height: 24 }));
    expect(stream).not.toBeNull();
    expect(stream!.codecId).toBe(2);
    expect([stream!.width, stream!.height]).toEqual([40, 24]);
    expect(stream!.frames.map((f) => Array.from(f))).toEqual(frames.map((f) => Array.from(f)));
  });

  it('finds the frame index when the header is longer than expected', async () => {
    const frames = await loadClip(basicFlvUrl);
    const stream = parseEmbeddedVideoDat(buildDat(frames, { width: 40, height: 24, extraHeader: 9 }));
    expect(stream!.frames.length).toBe(frames.length);
    expect(Array.from(stream!.frames[3])).toEqual(Array.from(frames[3]));
  });

  it('falls back to picture start codes when the index is unreadable', async () => {
    const frames = await loadClip(basicFlvUrl);
    const dat = buildDat(frames, { width: 40, height: 24 });
    dat[75] = 0xee; // break the index
    const stream = parseEmbeddedVideoDat(dat);
    expect(stream!.frames.length).toBe(frames.length);
    // Each frame is located; trailing bytes after the last frame are harmless.
    const decoder = new SorensonH263Decoder();
    for (const f of stream!.frames) expect(() => decoder.decode(f)).not.toThrow();
  });

  it('is not fooled by non-video data', () => {
    expect(parseEmbeddedVideoDat(new Uint8Array(100))).toBeNull();
    const bitmapLike = new Uint8Array(100);
    bitmapLike[0] = 0x03; bitmapLike[1] = 0x08; // 03 08 = native MP4 wrapper, not FLV video
    expect(parseEmbeddedVideoDat(bitmapLike)).toBeNull();
  });

  it('takes the Sorenson frames from a real FLV', async () => {
    const flv = await fetchBytes(basicFlvUrl);
    const stream = embeddedVideoFromFLV(parseFLV(flv.buffer as ArrayBuffer));
    expect(stream).toMatchObject({ codecId: 2, width: 40, height: 24 });
    expect(stream!.frames.length).toBe(8);
  });

  it('seeks to any frame with the same result as decoding in order', async () => {
    const frames = await loadClip(basicFlvUrl);
    const sequential = new SorensonH263Decoder();
    const expected = frames.map((f) => Array.from(sequential.decode(f).y));
    const random = new EmbeddedVideoDecoder({ codecId: 2, width: 40, height: 24, frames });
    for (const index of [5, 2, 3, 7, 0, 6, 6, 1]) {
      expect(Array.from(random.getFrame(index)!.y)).toEqual(expected[index]);
    }
    // Past the end holds the last frame.
    expect(Array.from(random.getFrame(99)!.y)).toEqual(expected[7]);
  });
});

describe('embedded FLV video in a FLA (issue #57)', () => {
  afterEach(() => vi.restoreAllMocks());

  // Two keyframes on one layer hold the same video, so it plays on through
  // the second keyframe: timeline frame n shows video frame n.
  const timelines = `
    <timelines><DOMTimeline name="Scene 1"><layers><DOMLayer name="Video"><frames>
      <DOMFrame index="0" duration="3"><elements>
        <DOMVideoInstance libraryItemName="clip.flv" frameRight="800" frameBottom="480"><matrix><Matrix/></matrix></DOMVideoInstance>
      </elements></DOMFrame>
      <DOMFrame index="3" duration="5"><elements>
        <DOMVideoInstance libraryItemName="clip.flv" frameRight="800" frameBottom="480"><matrix><Matrix/></matrix></DOMVideoInstance>
      </elements></DOMFrame>
    </frames></DOMLayer></layers></DOMTimeline></timelines>`;

  async function buildFla(dat: Uint8Array): Promise<File> {
    const zip = new JSZip();
    zip.file('DOMDocument.xml', `<?xml version="1.0" encoding="UTF-8"?>
<DOMDocument width="40" height="24" frameRate="12" backgroundColor="#FFFFFF">
  <media>
    <DOMVideoItem name="clip.flv" videoDataHRef="M 7 1788496524.dat" videoType="h263 media" fps="12" width="40" height="24" length="0.667"/>
  </media>
  ${timelines}
</DOMDocument>`);
    zip.file('bin/M 7 1788496524.dat', dat);
    return new File([await zip.generateAsync({ type: 'blob' })], 'video.fla');
  }

  it('plays the video instead of the placeholder', async () => {
    const frames = await loadClip(basicFlvUrl);
    const warn = vi.spyOn(console, 'warn');
    const doc = await new FLAParser().parse(await buildFla(buildDat(frames, { width: 40, height: 24 })));
    expect(warn.mock.calls.some((c) => String(c[0]).includes('Unrecognized embedded video'))).toBe(false);
    expect(doc.videos.get('clip.flv')?.embeddedVideo?.frames.length).toBe(8);

    const canvas = document.createElement('canvas');
    canvas.width = 40;
    canvas.height = 24;
    const renderer = new FLARenderer(canvas);
    await renderer.setDocument(doc, true);

    const decoder = new SorensonH263Decoder();
    const expected = frames.map((f) => sorensonPictureToRGBA(decoder.decode(f)));
    const ctx = canvas.getContext('2d')!;
    for (const frameIndex of [0, 4, 7, 2]) {
      renderer.renderFrame(frameIndex);
      const actual = ctx.getImageData(0, 0, 40, 24).data;
      let max = 0;
      for (let i = 0; i < actual.length; i++) max = Math.max(max, Math.abs(actual[i] - expected[frameIndex][i]));
      expect(max, `timeline frame ${frameIndex}`).toBeLessThanOrEqual(2);
    }
  });

  it('keeps the placeholder, with a clear warning, for VP6 video', async () => {
    const frames = await loadClip(basicFlvUrl);
    const warn = vi.spyOn(console, 'warn');
    const doc = await new FLAParser().parse(await buildFla(buildDat(frames, { codecId: 4, width: 40, height: 24 })));
    expect(doc.videos.get('clip.flv')?.embeddedVideo).toBeUndefined();
    expect(warn.mock.calls.some((c) => /VP6/.test(String(c[0])))).toBe(true);
  });
});
