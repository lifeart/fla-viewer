/**
 * Sorenson Spark (FLV1) video decoder — the "H.263" codec of Flash video
 * (`videoType="h263 media"`, FLV codec id 2). Browsers can't decode it, so an
 * embedded video in a FLA would otherwise only ever show a placeholder.
 *
 * Sorenson Spark is H.263 baseline with its own picture header, unrestricted
 * motion vectors (edge pixels are repeated past the picture border), no GOB
 * headers, a "disposable" P picture that is never used as a reference, and (in
 * bitstream version 1) a different escape code for long coefficients.
 * Not implemented: the optional deblocking filter (the flag is read and
 * ignored) and four-vector macroblocks, which Sorenson streams never carry.
 */

import { CBPY_CODES, MCBPC_I_CODES, MCBPC_P_CODES, MVD_CODES, TCOEF_CODES } from './h263-tables';

export type SorensonPictureType = 'I' | 'P' | 'D'; // D = disposable P

export interface SorensonPictureHeader {
  version: number;
  temporalReference: number;
  width: number;
  height: number;
  type: SorensonPictureType;
  deblocking: boolean;
  quantizer: number;
}

/** A decoded YUV 4:2:0 picture. Planes are padded to whole macroblocks. */
export interface SorensonPicture {
  header: SorensonPictureHeader;
  width: number;
  height: number;
  lumaStride: number;
  chromaStride: number;
  y: Uint8Array;
  cb: Uint8Array;
  cr: Uint8Array;
  /** Set when the bitstream broke off mid-picture and the rest was concealed. */
  damaged?: boolean;
}

// ---------------------------------------------------------------------------
// Bit reader and VLC trees

class BitReader {
  private pos = 0; // in bits
  constructor(private readonly data: Uint8Array) {}

  bit(): number {
    const byte = this.pos >> 3;
    if (byte >= this.data.length) throw new Error('H.263: unexpected end of picture data');
    const b = (this.data[byte] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return b;
  }

  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v;
  }

  signedBits(n: number): number {
    const v = this.bits(n);
    return v & (1 << (n - 1)) ? v - (1 << n) : v;
  }
}

/**
 * A binary decode tree over `codes`: `next[node * 2 + bit]` is a child node
 * (> 0), a leaf `-(valueIndex + 1)`, or 0 for an invalid code.
 */
interface VlcTree<T> {
  next: Int32Array;
  values: T[];
}

function buildTree<T>(rows: ReadonlyArray<readonly [string, ...unknown[]]>, value: (row: never) => T): VlcTree<T> {
  let nodeCount = 1;
  const next: number[] = [0, 0];
  const values: T[] = [];
  for (const row of rows) {
    const code = row[0];
    let node = 0;
    for (let i = 0; i < code.length; i++) {
      const slot = node * 2 + (code.charCodeAt(i) - 48);
      if (i === code.length - 1) {
        next[slot] = -(values.length + 1);
      } else {
        if (next[slot] <= 0) {
          next[slot] = nodeCount++;
          next.push(0, 0);
        }
        node = next[slot];
      }
    }
    values.push(value(row as never));
  }
  return { next: Int32Array.from(next), values };
}

function readVlc<T>(r: BitReader, tree: VlcTree<T>, what: string): T {
  let node = 0;
  for (;;) {
    const n = tree.next[node * 2 + r.bit()];
    if (n < 0) return tree.values[-n - 1];
    if (n === 0) throw new Error(`H.263: invalid ${what} code`);
    node = n;
  }
}

// MCBPC macroblock types (see h263-tables.ts).
const MB_INTRA = 0;
const MB_INTRA_Q = 1;
const MB_INTER_Q = 3; // (2 = plain INTER)
const MB_STUFFING = -1;

interface Mcbpc { type: number; cb: boolean; cr: boolean }
interface Tcoef { last: boolean; run: number; level: number; escape: boolean }

const mcbpcValue = (row: readonly [string, number, number, number]): Mcbpc =>
  ({ type: row[1], cb: row[2] === 1, cr: row[3] === 1 });
const MCBPC_I_TREE = buildTree(MCBPC_I_CODES, mcbpcValue);
const MCBPC_P_TREE = buildTree(MCBPC_P_CODES, mcbpcValue);
const CBPY_TREE = buildTree(CBPY_CODES, (row: readonly [string, number]) => row[1]);
const MVD_TREE = buildTree(MVD_CODES, (row: readonly [string, number]) => row[1]);
const TCOEF_TREE = buildTree(TCOEF_CODES, (row: readonly [string, number, number, number]): Tcoef =>
  ({ last: row[1] === 1, run: row[2], level: row[3], escape: row[1] === -1 }));

const DQUANT = [-1, -2, 1, 2];

// Zigzag scan: position k -> row-major index (y * 8 + x).
const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

// IDCT basis: BASIS[u * 8 + x] = c(u) * cos((2x + 1) u π / 16), c(0) = 1/√2.
const BASIS = new Float64Array(64);
for (let u = 0; u < 8; u++) {
  for (let x = 0; x < 8; x++) {
    BASIS[u * 8 + x] = (u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
}

/** In-place 8x8 inverse DCT of dequantized coefficients into a residual (rounded, clamped to ±256). */
const IDCT_TMP = new Float64Array(64);
function idct(block: Float64Array, out: Int16Array): void {
  const tmp = IDCT_TMP;
  // Rows: tmp[y][x] = Σu block[y][u] * BASIS[u][x]
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let u = 0; u < 8; u++) s += block[y * 8 + u] * BASIS[u * 8 + x];
      tmp[y * 8 + x] = s;
    }
  }
  // Columns, with the 1/4 normalisation of the 2-D transform.
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let s = 0;
      for (let v = 0; v < 8; v++) s += tmp[v * 8 + x] * BASIS[v * 8 + y];
      s /= 4;
      const r = Math.trunc(s + (s < 0 ? -0.5 : 0.5));
      out[y * 8 + x] = r < -256 ? -256 : r > 255 ? 255 : r;
    }
  }
}

// ---------------------------------------------------------------------------
// Picture header

const START_CODE = 1; // 17 bits: 0000 0000 0000 0000 1
const MAX_SIZE = 4096; // Flash video is far smaller; guards against garbage headers

function readHeader(r: BitReader): SorensonPictureHeader {
  if (r.bits(17) !== START_CODE) throw new Error('H.263: missing picture start code');
  const version = r.bits(5);
  if (version > 1) throw new Error(`H.263: unsupported Sorenson version ${version}`);
  const temporalReference = r.bits(8);
  let width: number;
  let height: number;
  switch (r.bits(3)) {
    case 0: width = r.bits(8); height = r.bits(8); break;
    case 1: width = r.bits(16); height = r.bits(16); break;
    case 2: width = 352; height = 288; break;
    case 3: width = 176; height = 144; break;
    case 4: width = 128; height = 96; break;
    case 5: width = 320; height = 240; break;
    case 6: width = 160; height = 120; break;
    default: throw new Error('H.263: reserved picture size');
  }
  if (width === 0 || height === 0) throw new Error('H.263: empty picture size');
  if (width > MAX_SIZE || height > MAX_SIZE) throw new Error(`H.263: picture too large (${width}x${height})`);
  const typeCode = r.bits(2);
  if (typeCode === 3) throw new Error('H.263: reserved picture type');
  const type: SorensonPictureType = typeCode === 0 ? 'I' : typeCode === 1 ? 'P' : 'D';
  const deblocking = r.bit() === 1;
  const quantizer = r.bits(5);
  if (quantizer === 0) throw new Error('H.263: zero quantizer');
  // PEI/PSUPP: extra insertion bytes, skipped.
  while (r.bit() === 1) r.bits(8);
  return { version, temporalReference, width, height, type, deblocking, quantizer };
}

/** Parse just the picture header of a Sorenson Spark frame, or null if it isn't one. */
export function readSorensonHeader(data: Uint8Array): SorensonPictureHeader | null {
  try {
    return readHeader(new BitReader(data));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Decoder

function median(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

/** Wrap a half-pel MV component into the H.263 default range [-32, 31]. */
function wrapMv(v: number): number {
  return ((((v + 32) % 64) + 64) % 64) - 32;
}

/** Chroma half-pel vector from a luma half-pel vector (H.263 6.1.1). */
function chromaMv(v: number): number {
  const sum = v * 4; // the 4-vector formula with four equal vectors
  const whole = (sum >> 4) << 1;
  const frac = sum & 15;
  return frac <= 2 ? whole : frac >= 14 ? whole + 2 : whole + 1;
}

interface Plane {
  data: Uint8Array;
  stride: number;
  width: number; // motion-compensated reads are clamped to width x height
  height: number;
}

/** Motion-compensated prediction of an 8x8 block from `ref` at (x, y) + half-pel (mvx, mvy). */
function predictBlock(ref: Plane, x: number, y: number, mvx: number, mvy: number, dst: Plane): void {
  const sx = x + Math.floor(mvx / 2);
  const sy = y + Math.floor(mvy / 2);
  const hx = mvx & 1;
  const hy = mvy & 1;
  const maxX = ref.width - 1;
  const maxY = ref.height - 1;
  const src = ref.data;
  const stride = ref.stride;
  const out = dst.data;
  for (let j = 0; j < 8; j++) {
    const v0 = sy + j;
    const v1 = v0 + hy;
    const r0 = (v0 < 0 ? 0 : v0 > maxY ? maxY : v0) * stride;
    const r1 = (v1 < 0 ? 0 : v1 > maxY ? maxY : v1) * stride;
    const o = (y + j) * dst.stride + x;
    for (let i = 0; i < 8; i++) {
      const u0 = sx + i;
      const u1 = u0 + hx;
      const c0 = u0 < 0 ? 0 : u0 > maxX ? maxX : u0;
      const c1 = u1 < 0 ? 0 : u1 > maxX ? maxX : u1;
      let p: number;
      if (!hx && !hy) p = src[r0 + c0];
      else if (!hy) p = (src[r0 + c0] + src[r0 + c1] + 1) >> 1;
      else if (!hx) p = (src[r0 + c0] + src[r1 + c0] + 1) >> 1;
      else p = (src[r0 + c0] + src[r0 + c1] + src[r1 + c0] + src[r1 + c1] + 2) >> 2;
      out[o + i] = p;
    }
  }
}

function fillBlock(plane: Plane, x: number, y: number, size: number, value: number): void {
  for (let j = 0; j < size; j++) plane.data.fill(value, (y + j) * plane.stride + x, (y + j) * plane.stride + x + size);
}

function addResidual(plane: Plane, x: number, y: number, residual: Int16Array, intra: boolean): void {
  for (let j = 0; j < 8; j++) {
    const row = (y + j) * plane.stride + x;
    for (let i = 0; i < 8; i++) {
      const v = (intra ? 0 : plane.data[row + i]) + residual[j * 8 + i];
      plane.data[row + i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
}

export class SorensonH263Decoder {
  /** Last I or P picture; disposable pictures never replace it. */
  private reference: SorensonPicture | null = null;
  private warnedDamage = false;

  reset(): void {
    this.reference = null;
  }

  /**
   * Decode one frame (the payload of an FLV video tag, without the tag's codec
   * byte). Throws only if the picture header is unreadable; damage after it is
   * concealed (see `SorensonPicture.damaged`).
   */
  decode(data: Uint8Array): SorensonPicture {
    const r = new BitReader(data);
    const header = readHeader(r);
    const { width, height } = header;
    const mbw = Math.ceil(width / 16);
    const mbh = Math.ceil(height / 16);
    const lumaStride = mbw * 16;
    const chromaStride = mbw * 8;
    const pic: SorensonPicture = {
      header, width, height, lumaStride, chromaStride,
      y: new Uint8Array(lumaStride * mbh * 16),
      cb: new Uint8Array(chromaStride * mbh * 8),
      cr: new Uint8Array(chromaStride * mbh * 8),
    };
    const planes: Plane[] = [
      { data: pic.y, stride: lumaStride, width: lumaStride, height: mbh * 16 },
      { data: pic.cb, stride: chromaStride, width: chromaStride, height: mbh * 8 },
      { data: pic.cr, stride: chromaStride, width: chromaStride, height: mbh * 8 },
    ];

    let ref = this.reference;
    if (header.type !== 'I' && (!ref || ref.width !== width || ref.height !== height)) {
      // A P picture with no usable reference (stream cut before its I picture):
      // predict from mid-gray rather than failing.
      ref = {
        header, width, height, lumaStride, chromaStride,
        y: new Uint8Array(pic.y.length).fill(128),
        cb: new Uint8Array(pic.cb.length).fill(128),
        cr: new Uint8Array(pic.cr.length).fill(128),
      };
    }
    // Edge pixels repeat past the macroblock-padded picture, not the visible
    // size: that is what Flash's (and ffmpeg's) encoder predicts from.
    const refPlanes: Plane[] | null = ref && header.type !== 'I' ? [
      { data: ref.y, stride: lumaStride, width: lumaStride, height: mbh * 16 },
      { data: ref.cb, stride: chromaStride, width: chromaStride, height: mbh * 8 },
      { data: ref.cr, stride: chromaStride, width: chromaStride, height: mbh * 8 },
    ] : null;

    const mvx = new Int16Array(mbw * mbh);
    const mvy = new Int16Array(mbw * mbh);
    const coeffs = new Float64Array(64);
    const residual = new Int16Array(64);
    let quant = header.quantizer;
    const escape11 = header.version === 1;

    let mb = 0;
    try {
      for (; mb < mbw * mbh; mb++) {
        const col = mb % mbw;
        const row = (mb / mbw) | 0;
        const lx = col * 16;
        const ly = row * 16;

        let mcbpc: Mcbpc;
        if (header.type === 'I') {
          do mcbpc = readVlc(r, MCBPC_I_TREE, 'MCBPC'); while (mcbpc.type === MB_STUFFING);
        } else {
          let skipped = false;
          for (;;) {
            if (r.bit() === 1) { skipped = true; break; } // COD: not coded
            mcbpc = readVlc(r, MCBPC_P_TREE, 'MCBPC');
            if (mcbpc.type !== MB_STUFFING) break;
          }
          if (skipped) {
            // Copy from the reference at zero motion; the MV predictor sees (0, 0).
            for (let b = 0; b < 4; b++) predictBlock(refPlanes![0], lx + (b & 1) * 8, ly + (b >> 1) * 8, 0, 0, planes[0]);
            predictBlock(refPlanes![1], lx / 2, ly / 2, 0, 0, planes[1]);
            predictBlock(refPlanes![2], lx / 2, ly / 2, 0, 0, planes[2]);
            continue;
          }
        }
        mcbpc = mcbpc!;
        if (mcbpc.type > MB_INTER_Q) throw new Error('H.263: four-vector macroblocks are not supported');
        const intra = mcbpc.type === MB_INTRA || mcbpc.type === MB_INTRA_Q;
        let cbpy = readVlc(r, CBPY_TREE, 'CBPY');
        if (!intra) cbpy ^= 0b1111;
        if (mcbpc.type === MB_INTRA_Q || mcbpc.type === MB_INTER_Q) {
          quant = Math.min(31, Math.max(1, quant + DQUANT[r.bits(2)]));
        }

        if (!intra) {
          // Median prediction from left, above and above-right (H.263 6.1.1).
          const leftX = col > 0 ? mvx[mb - 1] : 0;
          const leftY = col > 0 ? mvy[mb - 1] : 0;
          let px = leftX;
          let py = leftY;
          if (row > 0) {
            const up = mb - mbw;
            const urX = col < mbw - 1 ? mvx[up + 1] : 0;
            const urY = col < mbw - 1 ? mvy[up + 1] : 0;
            px = median(leftX, mvx[up], urX);
            py = median(leftY, mvy[up], urY);
          }
          mvx[mb] = wrapMv(px + readVlc(r, MVD_TREE, 'MVD'));
          mvy[mb] = wrapMv(py + readVlc(r, MVD_TREE, 'MVD'));
          for (let b = 0; b < 4; b++) {
            predictBlock(refPlanes![0], lx + (b & 1) * 8, ly + (b >> 1) * 8, mvx[mb], mvy[mb], planes[0]);
          }
          const cx = chromaMv(mvx[mb]);
          const cy = chromaMv(mvy[mb]);
          predictBlock(refPlanes![1], lx / 2, ly / 2, cx, cy, planes[1]);
          predictBlock(refPlanes![2], lx / 2, ly / 2, cx, cy, planes[2]);
        }

        for (let b = 0; b < 6; b++) {
          const coded = b < 4 ? (cbpy & (8 >> b)) !== 0 : b === 4 ? mcbpc.cb : mcbpc.cr;
          if (!intra && !coded) continue;
          coeffs.fill(0);
          let k = 0;
          if (intra) {
            // 0 and 128 are forbidden; read them leniently like ffmpeg (128 = 255 = 1024).
            const dc = r.bits(8);
            coeffs[0] = dc === 255 ? 1024 : dc * 8;
            k = 1;
          }
          if (coded) {
            for (;;) {
              const t = readVlc(r, TCOEF_TREE, 'TCOEF');
              let last: boolean;
              let run: number;
              let level: number;
              if (t.escape) {
                const width = escape11 ? (r.bit() ? 11 : 7) : 8;
                last = r.bit() === 1;
                run = r.bits(6);
                level = r.signedBits(width);
                if (level === 0 || (!escape11 && level === -128)) throw new Error('H.263: invalid escaped coefficient');
              } else {
                last = t.last;
                run = t.run;
                level = r.bit() ? -t.level : t.level;
              }
              k += run;
              if (k > 63) throw new Error('H.263: coefficient index out of range');
              const mag = quant * (2 * Math.abs(level) + 1) - (quant % 2 === 0 ? 1 : 0);
              const v = level < 0 ? -mag : mag;
              coeffs[ZIGZAG[k]] = v < -2048 ? -2048 : v > 2047 ? 2047 : v;
              k++;
              if (last) break;
            }
          }
          idct(coeffs, residual);
          if (b < 4) addResidual(planes[0], lx + (b & 1) * 8, ly + (b >> 1) * 8, residual, intra);
          else addResidual(planes[b === 4 ? 1 : 2], lx / 2, ly / 2, residual, intra);
        }
      }
    } catch (e) {
      // Damaged or truncated picture: keep what decoded and fill the rest from
      // the reference (as skipped macroblocks), so the stream carries on instead
      // of failing every later picture that depends on this one.
      pic.damaged = true;
      if (!this.warnedDamage) {
        this.warnedDamage = true;
        console.warn('Sorenson H.263: damaged picture, concealing the rest of it:', e);
      }
      for (; mb < mbw * mbh; mb++) {
        const lx = (mb % mbw) * 16;
        const ly = ((mb / mbw) | 0) * 16;
        if (refPlanes) {
          for (let b = 0; b < 4; b++) predictBlock(refPlanes[0], lx + (b & 1) * 8, ly + (b >> 1) * 8, 0, 0, planes[0]);
          predictBlock(refPlanes[1], lx / 2, ly / 2, 0, 0, planes[1]);
          predictBlock(refPlanes[2], lx / 2, ly / 2, 0, 0, planes[2]);
        } else {
          fillBlock(planes[0], lx, ly, 16, 128);
          fillBlock(planes[1], lx / 2, ly / 2, 8, 128);
          fillBlock(planes[2], lx / 2, ly / 2, 8, 128);
        }
      }
    }

    if (header.type !== 'D') this.reference = pic;
    return pic;
  }
}

/** Convert a decoded picture to RGBA (BT.601, studio range). */
export function sorensonPictureToRGBA(pic: SorensonPicture, out?: Uint8ClampedArray): Uint8ClampedArray {
  const { width, height } = pic;
  const rgba = out ?? new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = (y >> 1) * pic.chromaStride + (x >> 1);
      const yy = 1.164 * (pic.y[y * pic.lumaStride + x] - 16);
      const u = pic.cb[c] - 128;
      const v = pic.cr[c] - 128;
      const o = (y * width + x) * 4;
      rgba[o] = yy + 1.596 * v;
      rgba[o + 1] = yy - 0.813 * v - 0.391 * u;
      rgba[o + 2] = yy + 2.018 * u;
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}
