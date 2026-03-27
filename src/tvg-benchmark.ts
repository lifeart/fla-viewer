export interface PixelBufferLike {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface BenchmarkBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface BenchmarkScoreOptions {
  tolerance?: number;
  backgroundTolerance?: number;
  maxShift?: number;
  searchRadius?: number;
  contentKind?: 'vector' | 'bitmap';
}

export interface BenchmarkScoreResult {
  score: number;
  rawScore: number;
  alignedScore: number;
  normalizedScore: number;
  perceptualScore: number;
  structuralScore: number;
  maskScore: number;
  macroScore: number;
  bestShift: { x: number; y: number };
  foregroundIou: number;
  referenceBounds: BenchmarkBounds | null;
  candidateBounds: BenchmarkBounds | null;
}

const DEFAULTS: Required<BenchmarkScoreOptions> = {
  tolerance: 50,
  backgroundTolerance: 12,
  maxShift: 8,
  searchRadius: 2,
  contentKind: 'vector',
};

function getOptions(options?: BenchmarkScoreOptions): Required<BenchmarkScoreOptions> {
  return {
    tolerance: options?.tolerance ?? DEFAULTS.tolerance,
    backgroundTolerance: options?.backgroundTolerance ?? DEFAULTS.backgroundTolerance,
    maxShift: options?.maxShift ?? DEFAULTS.maxShift,
    searchRadius: options?.searchRadius ?? DEFAULTS.searchRadius,
    contentKind: options?.contentKind ?? DEFAULTS.contentKind,
  };
}

function channelDiffWithinTolerance(
  a: Uint8ClampedArray,
  ai: number,
  b: Uint8ClampedArray,
  bi: number,
  tolerance: number,
): boolean {
  return Math.abs(a[ai + 0] - b[bi + 0]) <= tolerance
    && Math.abs(a[ai + 1] - b[bi + 1]) <= tolerance
    && Math.abs(a[ai + 2] - b[bi + 2]) <= tolerance;
}

function neighborhoodMatchWithinTolerance(
  reference: PixelBufferLike,
  candidate: PixelBufferLike,
  refX: number,
  refY: number,
  shiftedX: number,
  shiftedY: number,
  options: Required<BenchmarkScoreOptions>,
): boolean {
  const refIndex = (refY * reference.width + refX) * 4;
  const directInside = shiftedX >= 0 && shiftedX < candidate.width && shiftedY >= 0 && shiftedY < candidate.height;
  if (directInside) {
    const directIndex = (shiftedY * candidate.width + shiftedX) * 4;
    if (channelDiffWithinTolerance(reference.data, refIndex, candidate.data, directIndex, options.tolerance)) {
      return true;
    }
  }
  if (options.searchRadius <= 0) return false;

  const refForeground = isForegroundPixel(reference.data, refIndex, options.backgroundTolerance);
  for (let dy = -options.searchRadius; dy <= options.searchRadius; dy++) {
    for (let dx = -options.searchRadius; dx <= options.searchRadius; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = shiftedX + dx;
      const ny = shiftedY + dy;
      if (nx < 0 || nx >= candidate.width || ny < 0 || ny >= candidate.height) continue;
      const candidateIndex = (ny * candidate.width + nx) * 4;
      const candidateForeground = isForegroundPixel(candidate.data, candidateIndex, options.backgroundTolerance);
      if (!refForeground && !candidateForeground) continue;
      if (channelDiffWithinTolerance(reference.data, refIndex, candidate.data, candidateIndex, options.tolerance)) {
        return true;
      }
    }
  }
  return false;
}

function isForegroundPixel(
  data: Uint8ClampedArray,
  index: number,
  backgroundTolerance: number,
): boolean {
  return Math.abs(data[index + 0] - 255) > backgroundTolerance
    || Math.abs(data[index + 1] - 255) > backgroundTolerance
    || Math.abs(data[index + 2] - 255) > backgroundTolerance
    || data[index + 3] < 255 - backgroundTolerance;
}

export function computeForegroundBounds(
  buffer: PixelBufferLike,
  backgroundTolerance = DEFAULTS.backgroundTolerance,
): BenchmarkBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < buffer.height; y++) {
    for (let x = 0; x < buffer.width; x++) {
      const index = (y * buffer.width + x) * 4;
      if (!isForegroundPixel(buffer.data, index, backgroundTolerance)) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (!isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function centerOfBounds(bounds: BenchmarkBounds | null): { x: number; y: number } {
  if (!bounds) return { x: 0, y: 0 };
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  };
}

function candidateShiftValues(target: number, maxShift: number, radius: number): number[] {
  const values = new Set<number>([0]);
  for (let delta = -radius; delta <= radius; delta++) {
    values.add(clamp(target + delta, -maxShift, maxShift));
  }
  return Array.from(values).sort((a, b) => a - b);
}

function fullShiftValues(maxShift: number): number[] {
  const values: number[] = [];
  for (let shift = -maxShift; shift <= maxShift; shift++) values.push(shift);
  return values;
}

function shiftBounds(bounds: BenchmarkBounds, shiftX: number, shiftY: number): BenchmarkBounds {
  return {
    minX: bounds.minX + shiftX,
    minY: bounds.minY + shiftY,
    maxX: bounds.maxX + shiftX,
    maxY: bounds.maxY + shiftY,
  };
}

function unionBounds(
  a: BenchmarkBounds | null,
  b: BenchmarkBounds | null,
  width: number,
  height: number,
  padding: number,
): BenchmarkBounds | null {
  if (!a && !b) return null;
  const minX = Math.floor(Math.max(0, Math.min(a?.minX ?? Infinity, b?.minX ?? Infinity) - padding));
  const minY = Math.floor(Math.max(0, Math.min(a?.minY ?? Infinity, b?.minY ?? Infinity) - padding));
  const maxX = Math.ceil(Math.min(width - 1, Math.max(a?.maxX ?? -Infinity, b?.maxX ?? -Infinity) + padding));
  const maxY = Math.ceil(Math.min(height - 1, Math.max(a?.maxY ?? -Infinity, b?.maxY ?? -Infinity) + padding));
  if (maxX < minX || maxY < minY) return null;
  return { minX, minY, maxX, maxY };
}

function scoreShift(
  reference: PixelBufferLike,
  candidate: PixelBufferLike,
  shiftX: number,
  shiftY: number,
  options: Required<BenchmarkScoreOptions>,
  bounds?: BenchmarkBounds | null,
): { score: number; foregroundIou: number } {
  let matchedPixels = 0;
  let unionForeground = 0;
  let intersectForeground = 0;
  const minX = bounds?.minX ?? 0;
  const minY = bounds?.minY ?? 0;
  const maxX = bounds?.maxX ?? (reference.width - 1);
  const maxY = bounds?.maxY ?? (reference.height - 1);
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const refIndex = (y * reference.width + x) * 4;
      const shiftedX = x - shiftX;
      const shiftedY = y - shiftY;
      const inside = shiftedX >= 0 && shiftedX < candidate.width && shiftedY >= 0 && shiftedY < candidate.height;
      const candidateIndex = inside ? (shiftedY * candidate.width + shiftedX) * 4 : -1;
      const refForeground = isForegroundPixel(reference.data, refIndex, options.backgroundTolerance);
      const candidateForeground = inside
        ? isForegroundPixel(candidate.data, candidateIndex, options.backgroundTolerance)
        : false;
      if (refForeground || candidateForeground) unionForeground++;
      if (refForeground && candidateForeground) intersectForeground++;
      const matches = inside
        ? neighborhoodMatchWithinTolerance(reference, candidate, x, y, shiftedX, shiftedY, options)
        : !refForeground;
      if (matches) matchedPixels++;
    }
  }
  const totalPixels = width * height;
  return {
    score: totalPixels > 0 ? ((matchedPixels / totalPixels) * 100) : 100,
    foregroundIou: unionForeground > 0 ? (intersectForeground / unionForeground) * 100 : 100,
  };
}

function scoreForegroundFocus(
  reference: PixelBufferLike,
  candidate: PixelBufferLike,
  shiftX: number,
  shiftY: number,
  options: Required<BenchmarkScoreOptions>,
  bounds: BenchmarkBounds | null,
): number {
  if (!bounds) return 100;
  let matchedForeground = 0;
  let unionForeground = 0;
  for (let y = bounds.minY; y <= bounds.maxY; y++) {
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      const refIndex = (y * reference.width + x) * 4;
      const shiftedX = x - shiftX;
      const shiftedY = y - shiftY;
      const inside = shiftedX >= 0 && shiftedX < candidate.width && shiftedY >= 0 && shiftedY < candidate.height;
      const candidateIndex = inside ? (shiftedY * candidate.width + shiftedX) * 4 : -1;
      const refForeground = isForegroundPixel(reference.data, refIndex, options.backgroundTolerance);
      const candidateForeground = inside
        ? isForegroundPixel(candidate.data, candidateIndex, options.backgroundTolerance)
        : false;
      if (!refForeground && !candidateForeground) continue;
      unionForeground++;
      if (!refForeground || !candidateForeground) continue;
      if (neighborhoodMatchWithinTolerance(reference, candidate, x, y, shiftedX, shiftedY, options)) {
        matchedForeground++;
      }
    }
  }
  return unionForeground > 0 ? ((matchedForeground / unionForeground) * 100) : 100;
}

function downsamplePixelBuffer(
  source: PixelBufferLike,
  targetWidth: number,
  targetHeight: number,
): PixelBufferLike {
  const data = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y++) {
    const srcY0 = Math.floor((y * source.height) / targetHeight);
    const srcY1 = Math.max(srcY0 + 1, Math.ceil(((y + 1) * source.height) / targetHeight));
    for (let x = 0; x < targetWidth; x++) {
      const srcX0 = Math.floor((x * source.width) / targetWidth);
      const srcX1 = Math.max(srcX0 + 1, Math.ceil(((x + 1) * source.width) / targetWidth));
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      let count = 0;
      for (let sy = srcY0; sy < srcY1; sy++) {
        for (let sx = srcX0; sx < srcX1; sx++) {
          const index = (sy * source.width + sx) * 4;
          sumR += source.data[index + 0];
          sumG += source.data[index + 1];
          sumB += source.data[index + 2];
          sumA += source.data[index + 3];
          count++;
        }
      }
      const out = (y * targetWidth + x) * 4;
      data[out + 0] = Math.round(sumR / count);
      data[out + 1] = Math.round(sumG / count);
      data[out + 2] = Math.round(sumB / count);
      data[out + 3] = Math.round(sumA / count);
    }
  }
  return { width: targetWidth, height: targetHeight, data };
}

function grayscalePixelBuffer(source: PixelBufferLike): PixelBufferLike {
  const data = new Uint8ClampedArray(source.data.length);
  for (let index = 0; index < source.data.length; index += 4) {
    const r = source.data[index + 0];
    const g = source.data[index + 1];
    const b = source.data[index + 2];
    const a = source.data[index + 3];
    const luma = Math.round((0.2126 * r) + (0.7152 * g) + (0.0722 * b));
    data[index + 0] = luma;
    data[index + 1] = luma;
    data[index + 2] = luma;
    data[index + 3] = a;
  }
  return {
    width: source.width,
    height: source.height,
    data,
  };
}

function binaryMaskPixelBuffer(
  source: PixelBufferLike,
  backgroundTolerance: number,
): PixelBufferLike {
  const data = new Uint8ClampedArray(source.data.length);
  for (let index = 0; index < source.data.length; index += 4) {
    const foreground = isForegroundPixel(source.data, index, backgroundTolerance);
    const value = foreground ? 0 : 255;
    data[index + 0] = value;
    data[index + 1] = value;
    data[index + 2] = value;
    data[index + 3] = 255;
  }
  return {
    width: source.width,
    height: source.height,
    data,
  };
}

function areaOfBounds(bounds: BenchmarkBounds | null): number {
  if (!bounds) return 0;
  return (bounds.maxX - bounds.minX + 1) * (bounds.maxY - bounds.minY + 1);
}

function foregroundCoverage(
  buffer: PixelBufferLike,
  bounds: BenchmarkBounds | null,
  backgroundTolerance: number,
): number {
  if (!bounds) return 0;
  let foregroundPixels = 0;
  const totalArea = areaOfBounds(bounds);
  if (totalArea <= 0) return 0;
  for (let y = bounds.minY; y <= bounds.maxY; y++) {
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      const index = (y * buffer.width + x) * 4;
      if (isForegroundPixel(buffer.data, index, backgroundTolerance)) {
        foregroundPixels++;
      }
    }
  }
  return foregroundPixels / totalArea;
}

function scorePixelBuffersBase(
  reference: PixelBufferLike,
  candidate: PixelBufferLike,
  options?: BenchmarkScoreOptions,
): BenchmarkScoreResult {
  const resolved = getOptions(options);
  const rawOptions: Required<BenchmarkScoreOptions> = {
    ...resolved,
    searchRadius: 0,
  };
  const referenceBounds = computeForegroundBounds(reference, resolved.backgroundTolerance);
  const candidateBounds = computeForegroundBounds(candidate, resolved.backgroundTolerance);
  const referenceCenter = centerOfBounds(referenceBounds);
  const candidateCenter = centerOfBounds(candidateBounds);
  const targetShiftX = clamp(
    Math.round(referenceCenter.x - candidateCenter.x),
    -resolved.maxShift,
    resolved.maxShift,
  );
  const targetShiftY = clamp(
    Math.round(referenceCenter.y - candidateCenter.y),
    -resolved.maxShift,
    resolved.maxShift,
  );

  const raw = scoreShift(reference, candidate, 0, 0, rawOptions);
  const rawCropBounds = unionBounds(
    referenceBounds,
    candidateBounds,
    reference.width,
    reference.height,
    Math.max(2, resolved.searchRadius + 1),
  );
  const rawNormalized = rawCropBounds
    ? scoreForegroundFocus(reference, candidate, 0, 0, resolved, rawCropBounds)
    : raw.foregroundIou;
  let bestShift = { x: 0, y: 0 };
  let bestScore = raw.score;
  let bestAlignedScore = raw.score;
  let bestNormalizedScore = rawNormalized;
  let bestIou = raw.foregroundIou;
  const seenShifts = new Set<string>();

  const considerShift = (shiftX: number, shiftY: number) => {
    const key = `${shiftX},${shiftY}`;
    if (seenShifts.has(key)) return;
    seenShifts.add(key);
    const result = scoreShift(reference, candidate, shiftX, shiftY, resolved);
    const cropBounds = unionBounds(
      referenceBounds,
      candidateBounds ? shiftBounds(candidateBounds, shiftX, shiftY) : null,
      reference.width,
      reference.height,
      Math.max(2, resolved.searchRadius + 1),
    );
    const normalized = cropBounds
      ? scoreForegroundFocus(reference, candidate, shiftX, shiftY, resolved, cropBounds)
      : result.foregroundIou;
    const focusedScore = normalized;
    const effectiveScore = result.score;
    const bestDistance = Math.abs(bestShift.x) + Math.abs(bestShift.y);
    const candidateDistance = Math.abs(shiftX) + Math.abs(shiftY);
    if (effectiveScore > bestScore
      || (effectiveScore === bestScore && focusedScore > bestNormalizedScore)
      || (effectiveScore === bestScore && focusedScore === bestNormalizedScore && result.foregroundIou > bestIou)
      || (effectiveScore === bestScore && focusedScore === bestNormalizedScore && result.foregroundIou === bestIou && candidateDistance < bestDistance)) {
      bestScore = effectiveScore;
      bestAlignedScore = result.score;
      bestNormalizedScore = focusedScore;
      bestIou = result.foregroundIou;
      bestShift = { x: shiftX, y: shiftY };
    }
  };

  const shiftXs = candidateShiftValues(targetShiftX, resolved.maxShift, resolved.searchRadius);
  const shiftYs = candidateShiftValues(targetShiftY, resolved.maxShift, resolved.searchRadius);
  for (const shiftY of shiftYs) {
    for (const shiftX of shiftXs) {
      considerShift(shiftX, shiftY);
    }
  }

  const referenceArea = referenceBounds ? ((referenceBounds.maxX - referenceBounds.minX + 1) * (referenceBounds.maxY - referenceBounds.minY + 1)) : 0;
  const candidateArea = candidateBounds ? ((candidateBounds.maxX - candidateBounds.minX + 1) * (candidateBounds.maxY - candidateBounds.minY + 1)) : 0;
  const canvasArea = reference.width * reference.height;
  const smallForeground = Math.max(referenceArea, candidateArea) > 0
    && (Math.max(referenceArea, candidateArea) / canvasArea) < 0.18;
  const boundaryShift = Math.abs(bestShift.x) === resolved.maxShift || Math.abs(bestShift.y) === resolved.maxShift;
  const ambiguousAlignment = bestIou < 50;
  if (smallForeground || boundaryShift || ambiguousAlignment) {
    const exhaustive = fullShiftValues(resolved.maxShift);
    for (const shiftY of exhaustive) {
      for (const shiftX of exhaustive) {
        considerShift(shiftX, shiftY);
      }
    }
  }

  return {
    score: bestScore,
    rawScore: raw.score,
    alignedScore: bestAlignedScore,
    normalizedScore: bestNormalizedScore,
    perceptualScore: bestScore,
    structuralScore: bestScore,
    maskScore: bestScore,
    macroScore: bestScore,
    bestShift,
    foregroundIou: bestIou,
    referenceBounds,
    candidateBounds,
  };
}

function computePerceptualScore(
  reference: PixelBufferLike,
  candidate: PixelBufferLike,
  options: Required<BenchmarkScoreOptions>,
): number {
  const targetSize = Math.max(24, Math.round(Math.min(reference.width, reference.height) / 4));
  if (targetSize >= Math.min(reference.width, reference.height)) return 100;
  const downsampledReference = downsamplePixelBuffer(reference, targetSize, targetSize);
  const downsampledCandidate = downsamplePixelBuffer(candidate, targetSize, targetSize);
  const coarse = scorePixelBuffersBase(downsampledReference, downsampledCandidate, {
    tolerance: Math.max(options.tolerance, 72),
    backgroundTolerance: Math.max(6, Math.round(options.backgroundTolerance * 0.75)),
    maxShift: Math.max(1, Math.ceil(options.maxShift * (targetSize / Math.max(reference.width, reference.height)))),
    searchRadius: Math.min(1, options.searchRadius),
  });
  return coarse.alignedScore;
}

function computeStructuralScore(
  reference: PixelBufferLike,
  candidate: PixelBufferLike,
  options: Required<BenchmarkScoreOptions>,
): number {
  const targetSize = Math.max(20, Math.round(Math.min(reference.width, reference.height) / 5));
  if (targetSize >= Math.min(reference.width, reference.height)) return 100;
  const downsampledReference = grayscalePixelBuffer(downsamplePixelBuffer(reference, targetSize, targetSize));
  const downsampledCandidate = grayscalePixelBuffer(downsamplePixelBuffer(candidate, targetSize, targetSize));
  const coarse = scorePixelBuffersBase(downsampledReference, downsampledCandidate, {
    tolerance: Math.max(options.tolerance, 88),
    backgroundTolerance: Math.max(6, Math.round(options.backgroundTolerance * 0.75)),
    maxShift: Math.max(1, Math.ceil(options.maxShift * (targetSize / Math.max(reference.width, reference.height)))),
    searchRadius: Math.min(1, options.searchRadius),
  });
  return coarse.alignedScore;
}

function computeMaskScore(
  reference: PixelBufferLike,
  candidate: PixelBufferLike,
  options: Required<BenchmarkScoreOptions>,
): number {
  const targetSize = Math.max(20, Math.round(Math.min(reference.width, reference.height) / 5));
  if (targetSize >= Math.min(reference.width, reference.height)) return 100;
  const downsampledReference = binaryMaskPixelBuffer(
    downsamplePixelBuffer(reference, targetSize, targetSize),
    Math.max(4, Math.round(options.backgroundTolerance * 0.75)),
  );
  const downsampledCandidate = binaryMaskPixelBuffer(
    downsamplePixelBuffer(candidate, targetSize, targetSize),
    Math.max(4, Math.round(options.backgroundTolerance * 0.75)),
  );
  const coarse = scorePixelBuffersBase(downsampledReference, downsampledCandidate, {
    tolerance: 16,
    backgroundTolerance: 8,
    maxShift: Math.max(1, Math.ceil(options.maxShift * (targetSize / Math.max(reference.width, reference.height)))),
    searchRadius: Math.min(1, options.searchRadius),
  });
  return coarse.alignedScore;
}

function computeMacroScore(
  reference: PixelBufferLike,
  candidate: PixelBufferLike,
  options: Required<BenchmarkScoreOptions>,
): number {
  const targetSize = Math.max(8, Math.round(Math.min(reference.width, reference.height) / 12));
  if (targetSize >= Math.min(reference.width, reference.height)) return 100;
  const downsampledReference = downsamplePixelBuffer(reference, targetSize, targetSize);
  const downsampledCandidate = downsamplePixelBuffer(candidate, targetSize, targetSize);
  const coarse = scorePixelBuffersBase(downsampledReference, downsampledCandidate, {
    tolerance: Math.max(options.tolerance, 96),
    backgroundTolerance: Math.max(6, Math.round(options.backgroundTolerance * 0.75)),
    maxShift: Math.max(1, Math.ceil(options.maxShift * (targetSize / Math.max(reference.width, reference.height)))),
    searchRadius: 0,
  });
  return coarse.alignedScore;
}

export function scorePixelBuffers(
  reference: PixelBufferLike,
  candidate: PixelBufferLike,
  options?: BenchmarkScoreOptions,
): BenchmarkScoreResult {
  const resolved = getOptions(options);
  const base = scorePixelBuffersBase(reference, candidate, resolved);
  const perceptualScore = computePerceptualScore(reference, candidate, resolved);
  const structuralScore = computeStructuralScore(reference, candidate, resolved);
  const maskScore = computeMaskScore(reference, candidate, resolved);
  const macroScore = computeMacroScore(reference, candidate, resolved);
  const canvasArea = reference.width * reference.height;
  const maxForegroundArea = Math.max(areaOfBounds(base.referenceBounds), areaOfBounds(base.candidateBounds));
  const smallForeground = maxForegroundArea > 0 && (maxForegroundArea / canvasArea) <= 0.3;
  const sparseForeground = Math.max(
    foregroundCoverage(reference, base.referenceBounds, resolved.backgroundTolerance),
    foregroundCoverage(candidate, base.candidateBounds, resolved.backgroundTolerance),
  ) <= 0.22;
  const overlapEligible = base.foregroundIou >= 50;
  const rescuedScore = overlapEligible
    ? Math.min(perceptualScore, base.alignedScore + 10)
    : base.alignedScore;
  const highConfidenceStructuralRescue = base.alignedScore >= 95
    && base.foregroundIou >= 80
    && perceptualScore >= 98
    && structuralScore >= 99.5
    ? Math.min(structuralScore, base.alignedScore + 5)
    : base.alignedScore;
  const highOverlapStructuralRescue = resolved.contentKind === 'vector'
    && base.alignedScore >= 88
    && base.foregroundIou >= 75
    && perceptualScore >= 94
    && structuralScore >= 97.5
    ? Math.min(structuralScore, base.alignedScore + 10)
    : base.alignedScore;
  const structuralEligible = (smallForeground || sparseForeground) && base.alignedScore >= 94;
  const structuralTarget = Math.max(structuralScore, maskScore);
  const structuralRescue = structuralEligible
    ? Math.min(structuralTarget, base.alignedScore + 6)
    : base.alignedScore;
  const bitmapRescue = resolved.contentKind === 'bitmap' && base.foregroundIou >= 50
    ? Math.min(Math.max(perceptualScore, structuralTarget), base.alignedScore + 6)
    : base.alignedScore;
  const lowOverlapBitmapRescue = resolved.contentKind === 'bitmap'
    && base.alignedScore >= 90
    && base.foregroundIou >= 25
    && perceptualScore >= 96
    ? Math.min(Math.max(perceptualScore, structuralScore), base.alignedScore + 5)
    : base.alignedScore;
  const macroBitmapRescue = resolved.contentKind === 'bitmap'
    && base.alignedScore >= 90
    && perceptualScore >= 94
    && macroScore >= 99
    ? macroScore
    : base.alignedScore;
  const macroVectorRescue = resolved.contentKind === 'vector'
    && base.alignedScore >= 88
    && base.foregroundIou >= 60
    && perceptualScore >= 94
    && structuralScore >= 97
    && macroScore >= 99
    ? macroScore
    : base.alignedScore;
  return {
    ...base,
    score: Math.max(
      base.alignedScore,
      rescuedScore,
      structuralRescue,
      bitmapRescue,
      lowOverlapBitmapRescue,
      highConfidenceStructuralRescue,
      highOverlapStructuralRescue,
      macroBitmapRescue,
      macroVectorRescue,
    ),
    perceptualScore,
    structuralScore,
    maskScore,
    macroScore,
  };
}

export function drawSourceToImageData(source: CanvasImageSource, size: number): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(source, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size);
}

export function scoreCanvasSources(
  referenceSource: CanvasImageSource,
  candidateSource: CanvasImageSource,
  size: number,
  options?: BenchmarkScoreOptions,
): BenchmarkScoreResult {
  return scorePixelBuffers(
    drawSourceToImageData(referenceSource, size),
    drawSourceToImageData(candidateSource, size),
    options,
  );
}
