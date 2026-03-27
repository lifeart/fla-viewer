import { describe, expect, it } from 'vitest';
import { computeForegroundBounds, scorePixelBuffers, type PixelBufferLike } from '../tvg-benchmark';

function createBuffer(width: number, height: number): PixelBufferLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i + 0] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

function fillRect(
  buffer: PixelBufferLike,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rgba: [number, number, number, number],
): void {
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      const index = (y * buffer.width + x) * 4;
      buffer.data[index + 0] = rgba[0];
      buffer.data[index + 1] = rgba[1];
      buffer.data[index + 2] = rgba[2];
      buffer.data[index + 3] = rgba[3];
    }
  }
}

describe('tvg-benchmark scoring', () => {
  it('finds foreground bounds against a white background', () => {
    const buffer = createBuffer(20, 20);
    fillRect(buffer, 4, 6, 10, 12, [0, 0, 0, 255]);
    expect(computeForegroundBounds(buffer)).toEqual({
      minX: 4,
      minY: 6,
      maxX: 9,
      maxY: 11,
    });
  });

  it('keeps identical buffers at 100%', () => {
    const reference = createBuffer(24, 24);
    fillRect(reference, 8, 8, 16, 16, [20, 180, 120, 255]);
    const candidate = {
      width: reference.width,
      height: reference.height,
      data: new Uint8ClampedArray(reference.data),
    };

    const result = scorePixelBuffers(reference, candidate);
    expect(result.score).toBe(100);
    expect(result.rawScore).toBe(100);
    expect(result.bestShift).toEqual({ x: 0, y: 0 });
  });

  it('tolerates a small translation within the alignment window', () => {
    const reference = createBuffer(24, 24);
    fillRect(reference, 8, 8, 16, 16, [30, 30, 30, 255]);

    const candidate = createBuffer(24, 24);
    fillRect(candidate, 10, 9, 18, 17, [30, 30, 30, 255]);

    const result = scorePixelBuffers(reference, candidate, { maxShift: 4 });
    expect(result.rawScore).toBeLessThan(result.score);
    expect(result.score).toBe(100);
    expect(Math.abs(result.bestShift.x)).toBe(2);
    expect(Math.abs(result.bestShift.y)).toBe(1);
  });

  it('does not normalize away large placement errors', () => {
    const reference = createBuffer(24, 24);
    fillRect(reference, 7, 7, 15, 15, [40, 40, 220, 255]);

    const candidate = createBuffer(24, 24);
    fillRect(candidate, 15, 7, 23, 15, [40, 40, 220, 255]);

    const result = scorePixelBuffers(reference, candidate, { maxShift: 2 });
    expect(result.score).toBeLessThan(100);
    expect(Math.abs(result.bestShift.x)).toBeLessThanOrEqual(2);
  });

  it('keeps focused score high for a tiny foreground translated within the search window', () => {
    const reference = createBuffer(64, 64);
    fillRect(reference, 28, 28, 32, 32, [10, 10, 10, 255]);

    const candidate = createBuffer(64, 64);
    fillRect(candidate, 33, 24, 37, 28, [10, 10, 10, 255]);

    const result = scorePixelBuffers(reference, candidate, { maxShift: 8, searchRadius: 2 });
    expect(result.alignedScore).toBeGreaterThan(95);
    expect(result.score).toBeGreaterThan(95);
    expect(result.normalizedScore).toBeGreaterThan(95);
  });

  it('penalizes a tiny foreground that lands in the wrong place despite white background agreement', () => {
    const reference = createBuffer(64, 64);
    fillRect(reference, 8, 8, 12, 12, [10, 10, 10, 255]);

    const candidate = createBuffer(64, 64);
    fillRect(candidate, 48, 48, 52, 52, [10, 10, 10, 255]);

    const result = scorePixelBuffers(reference, candidate, { maxShift: 4, searchRadius: 1 });
    expect(result.rawScore).toBeGreaterThan(90);
    expect(result.normalizedScore).toBeLessThan(10);
  });

  it('keeps rawScore stable when only the alignment search parameters change', () => {
    const reference = createBuffer(64, 64);
    fillRect(reference, 20, 24, 28, 32, [10, 10, 10, 255]);

    const candidate = createBuffer(64, 64);
    fillRect(candidate, 23, 27, 31, 35, [10, 10, 10, 255]);

    const tight = scorePixelBuffers(reference, candidate, { maxShift: 2, searchRadius: 0 });
    const loose = scorePixelBuffers(reference, candidate, { maxShift: 8, searchRadius: 3 });
    expect(tight.rawScore).toBe(loose.rawScore);
    expect(loose.score).toBeGreaterThanOrEqual(tight.score);
  });
});
