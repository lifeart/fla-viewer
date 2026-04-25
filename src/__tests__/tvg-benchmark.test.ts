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
    expect(result.gateScore).toBe(result.alignedScore);
  });

  it('uses a crop-aware gate when overlap is strong but background drift hurts full-canvas alignment', () => {
    const reference = createBuffer(64, 64);
    fillRect(reference, 18, 18, 46, 46, [10, 10, 10, 255]);

    const candidate = createBuffer(64, 64);
    fillRect(candidate, 0, 0, 6, 64, [200, 200, 200, 255]);
    fillRect(candidate, 58, 0, 64, 64, [200, 200, 200, 255]);
    fillRect(candidate, 0, 0, 64, 6, [200, 200, 200, 255]);
    fillRect(candidate, 0, 58, 64, 64, [200, 200, 200, 255]);
    fillRect(candidate, 18, 18, 46, 46, [10, 10, 10, 255]);

    const result = scorePixelBuffers(reference, candidate, {
      tolerance: 30,
      backgroundTolerance: 80,
      maxShift: 4,
      searchRadius: 1,
    });

    expect(result.alignedScore).toBeLessThan(100);
    expect(result.croppedAlignedScore).toBeGreaterThan(result.alignedScore);
    expect(result.gateScore).toBeGreaterThan(result.alignedScore);
    expect(result.gateScore).toBeLessThanOrEqual(result.alignedScore + 4);
  });

  it('rescues matched large regions when only tiny interior marks differ', () => {
    const reference = createBuffer(64, 64);
    fillRect(reference, 10, 16, 54, 48, [236, 196, 240, 255]);
    fillRect(reference, 16, 22, 48, 42, [198, 205, 255, 255]);
    for (let x = 18; x < 48; x += 3) {
      fillRect(reference, x, 24, x + 1, 40, [126, 128, 184, 255]);
    }
    for (let x = 20; x < 44; x += 4) {
      fillRect(reference, x, 10, x + 2, 14, [140, 120, 186, 255]);
    }

    const candidate = createBuffer(64, 64);
    fillRect(candidate, 10, 16, 54, 48, [236, 196, 240, 255]);
    fillRect(candidate, 16, 22, 48, 42, [198, 205, 255, 255]);

    const result = scorePixelBuffers(reference, candidate, { maxShift: 4, searchRadius: 1 });
    expect(result.perceptualScore).toBeGreaterThan(result.alignedScore);
    expect(result.score).toBeGreaterThan(result.alignedScore);
    expect(result.score).toBeGreaterThan(94);
  });

  it('rescues tiny silhouettes when geometry matches but color differs', () => {
    const reference = createBuffer(64, 64);
    fillRect(reference, 24, 26, 40, 36, [118, 60, 140, 255]);

    const candidate = createBuffer(64, 64);
    fillRect(candidate, 24, 26, 40, 36, [99, 217, 188, 255]);

    const result = scorePixelBuffers(reference, candidate, { maxShift: 4, searchRadius: 1 });
    expect(result.structuralScore).toBeGreaterThan(result.alignedScore);
    expect(result.maskScore).toBeGreaterThan(result.alignedScore);
    expect(result.score).toBeGreaterThan(result.alignedScore);
  });

  it('does not structurally rescue large color mismatches', () => {
    const reference = createBuffer(64, 64);
    fillRect(reference, 8, 12, 56, 52, [118, 60, 140, 255]);

    const candidate = createBuffer(64, 64);
    fillRect(candidate, 8, 12, 56, 52, [99, 217, 188, 255]);

    const result = scorePixelBuffers(reference, candidate, { maxShift: 4, searchRadius: 1 });
    expect(result.structuralScore).toBeGreaterThan(result.alignedScore);
    expect(result.score).toBe(result.alignedScore);
    expect(result.gateScore).toBe(result.alignedScore);
  });

  it('rescues large sparse line drawings when structure matches', () => {
    const reference = createBuffer(64, 64);
    fillRect(reference, 12, 16, 52, 17, [255, 120, 80, 255]);
    fillRect(reference, 12, 46, 52, 47, [255, 120, 80, 255]);
    fillRect(reference, 12, 16, 13, 47, [255, 120, 80, 255]);
    fillRect(reference, 51, 16, 52, 47, [255, 120, 80, 255]);
    fillRect(reference, 31, 12, 32, 50, [255, 120, 80, 255]);

    const candidate = createBuffer(64, 64);
    fillRect(candidate, 12, 16, 52, 17, [255, 170, 150, 255]);
    fillRect(candidate, 12, 46, 52, 47, [255, 170, 150, 255]);
    fillRect(candidate, 12, 16, 13, 47, [255, 170, 150, 255]);
    fillRect(candidate, 51, 16, 52, 47, [255, 170, 150, 255]);
    fillRect(candidate, 31, 12, 32, 50, [255, 170, 150, 255]);

    const result = scorePixelBuffers(reference, candidate, { maxShift: 4, searchRadius: 1 });
    expect(result.structuralScore).toBeGreaterThan(result.alignedScore);
    expect(result.maskScore).toBeGreaterThan(result.alignedScore);
    expect(result.score).toBeGreaterThan(result.alignedScore);
  });

  it('raises the gate for high-overlap vector drawings with minor color drift', () => {
    const reference = createBuffer(64, 64);
    fillRect(reference, 12, 16, 52, 17, [255, 120, 80, 255]);
    fillRect(reference, 12, 46, 52, 47, [255, 120, 80, 255]);
    fillRect(reference, 12, 16, 13, 47, [255, 120, 80, 255]);
    fillRect(reference, 51, 16, 52, 47, [255, 120, 80, 255]);
    fillRect(reference, 31, 12, 32, 50, [255, 120, 80, 255]);

    const candidate = createBuffer(64, 64);
    fillRect(candidate, 12, 16, 52, 17, [255, 120, 80, 255]);
    fillRect(candidate, 12, 46, 52, 47, [255, 120, 80, 255]);
    fillRect(candidate, 12, 16, 13, 47, [255, 120, 80, 255]);
    fillRect(candidate, 51, 16, 52, 47, [255, 120, 80, 255]);
    fillRect(candidate, 31, 12, 32, 50, [255, 171, 131, 255]);

    const result = scorePixelBuffers(reference, candidate, { maxShift: 4, searchRadius: 1 });
    expect(result.alignedScore).toBeLessThan(100);
    expect(result.perceptualScore).toBeGreaterThanOrEqual(98);
    expect(result.structuralScore).toBeGreaterThanOrEqual(99);
    expect(result.gateScore).toBeGreaterThan(result.alignedScore);
    expect(result.gateScore).toBeLessThanOrEqual(result.alignedScore + 6.01);
  });

  it('raises the vector gate for high-structure contour fringe drift', () => {
    const reference = createBuffer(96, 96);
    fillRect(reference, 20, 16, 76, 80, [20, 20, 20, 255]);
    fillRect(reference, 24, 20, 72, 76, [110, 180, 230, 255]);

    const candidate = createBuffer(96, 96);
    fillRect(candidate, 19, 16, 77, 80, [20, 20, 20, 255]);
    fillRect(candidate, 24, 20, 72, 76, [110, 180, 230, 255]);

    const result = scorePixelBuffers(reference, candidate, {
      contentKind: 'vector',
      maxShift: 2,
      searchRadius: 1,
    });

    expect(result.alignedScore).toBeGreaterThanOrEqual(98);
    expect(result.perceptualScore).toBeGreaterThanOrEqual(98.5);
    expect(result.structuralScore).toBeGreaterThanOrEqual(99.5);
    expect(result.gateScore).toBeGreaterThan(result.alignedScore);
    expect(result.gateScore).toBeGreaterThanOrEqual(99);
  });

  it('raises the vector gate for small source-color mismatches when the mask matches', () => {
    const reference = createBuffer(96, 96);
    fillRect(reference, 28, 40, 68, 54, [20, 20, 20, 255]);
    fillRect(reference, 29, 41, 67, 53, [102, 44, 112, 255]);

    const candidate = createBuffer(96, 96);
    fillRect(candidate, 28, 40, 68, 54, [20, 20, 20, 255]);
    fillRect(candidate, 29, 41, 67, 53, [99, 217, 188, 255]);

    const result = scorePixelBuffers(reference, candidate, {
      contentKind: 'vector',
      maxShift: 2,
      searchRadius: 1,
    });

    expect(result.alignedScore).toBeGreaterThanOrEqual(95);
    expect(result.maskScore).toBe(100);
    expect(result.gateScore).toBeGreaterThan(result.alignedScore);
    expect(result.gateScore).toBe(100);
  });

  it('allows a bounded bitmap rescue when perceptual agreement is stronger than exact pixels', () => {
    const reference = createBuffer(64, 64);
    fillRect(reference, 12, 12, 52, 52, [80, 120, 220, 255]);
    fillRect(reference, 20, 20, 44, 44, [245, 245, 255, 255]);

    const candidate = createBuffer(64, 64);
    fillRect(candidate, 15, 13, 55, 53, [94, 136, 204, 255]);
    fillRect(candidate, 23, 21, 47, 45, [232, 232, 244, 255]);

    const vectorResult = scorePixelBuffers(reference, candidate, { maxShift: 2, searchRadius: 1, contentKind: 'vector' });
    const bitmapResult = scorePixelBuffers(reference, candidate, { maxShift: 2, searchRadius: 1, contentKind: 'bitmap' });

    expect(bitmapResult.score).toBeGreaterThanOrEqual(vectorResult.score);
    expect(bitmapResult.score).toBeGreaterThan(bitmapResult.alignedScore);
    expect(bitmapResult.score - bitmapResult.alignedScore).toBeLessThanOrEqual(6.01);
  });

  it('raises the bitmap gate for atlas-edge drift when structure still matches', () => {
    const reference = createBuffer(96, 96);
    fillRect(reference, 20, 12, 76, 84, [80, 120, 220, 255]);
    fillRect(reference, 30, 26, 66, 70, [240, 246, 255, 255]);

    const candidate = createBuffer(96, 96);
    fillRect(candidate, 19, 12, 77, 84, [80, 120, 220, 255]);
    fillRect(candidate, 30, 26, 66, 70, [240, 246, 255, 255]);

    const result = scorePixelBuffers(reference, candidate, {
      contentKind: 'bitmap',
      maxShift: 2,
      searchRadius: 1,
    });

    expect(result.alignedScore).toBeGreaterThanOrEqual(97);
    expect(result.perceptualScore).toBeGreaterThanOrEqual(99);
    expect(result.structuralScore).toBeGreaterThanOrEqual(99.5);
    expect(result.gateScore).toBeGreaterThan(result.alignedScore);
    expect(result.gateScore).toBeGreaterThanOrEqual(99);
    expect(result.gateScore - result.alignedScore).toBeLessThanOrEqual(4.01);
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
