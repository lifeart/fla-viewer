declare module 'gifenc' {
  export interface GIFEncoderInstance {
    writeFrame(
      indexedPixels: Uint8Array,
      width: number,
      height: number,
      options?: {
        palette?: number[][];
        delay?: number;
        repeat?: number;
        transparent?: boolean;
        transparentIndex?: number;
        dispose?: number;
      }
    ): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
  }

  export function GIFEncoder(): GIFEncoderInstance;

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: {
      format?: 'rgb565' | 'rgb444' | 'rgba4444';
      oneBitAlpha?: boolean | number;
    }
  ): number[][];

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: 'rgb565' | 'rgb444' | 'rgba4444'
  ): Uint8Array;

  export function nearestColorIndex(
    palette: number[][],
    pixel: number[]
  ): number;

  export function nearestColorIndexWithDistance(
    palette: number[][],
    pixel: number[]
  ): [number, number];

  export function snapColorsToPalette(
    palette: number[][],
    knownColors: number[][],
    threshold?: number
  ): void;

  export function prequantize(
    rgba: Uint8Array | Uint8ClampedArray,
    options?: {
      roundRGB?: number;
      roundAlpha?: number;
      oneBitAlpha?: boolean | number;
    }
  ): void;
}
