import { vi, expect } from 'vitest';
import type {
  Shape,
  Matrix,
  PathCommand,
  FillStyle,
  Edge,
  FLADocument,
  Timeline,
  Layer,
  Frame,
  SymbolInstance,
  Symbol,
} from '../types';

/**
 * Console spy helper for DEBUG mode tests.
 * Finds a log call containing the specified substring and asserts it exists.
 */
export function expectLogContaining(
  spy: ReturnType<typeof vi.spyOn>,
  substring: string
): void {
  const logCall = spy.mock.calls.find(
    (call) => typeof call[0] === 'string' && call[0].includes(substring)
  );
  expect(logCall, `Expected console.log call containing "${substring}"`).toBeDefined();
}

/**
 * Console spy helper that returns whether a log call exists.
 * Useful for optional assertions.
 */
export function hasLogContaining(
  spy: ReturnType<typeof vi.spyOn>,
  substring: string
): boolean {
  return spy.mock.calls.some(
    (call) => typeof call[0] === 'string' && call[0].includes(substring)
  );
}

/**
 * Creates a console.log spy that can be used in tests.
 * Remember to call spy.mockRestore() after the test.
 */
export function createConsoleSpy(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, 'log');
}

/**
 * Creates a console.warn spy for testing warning messages.
 */
export function createConsoleWarnSpy(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, 'warn');
}

/**
 * Identity matrix helper
 */
export function createIdentityMatrix(overrides: Partial<Matrix> = {}): Matrix {
  return {
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    tx: 0,
    ty: 0,
    ...overrides,
  };
}

/**
 * Creates a simple rectangular shape for renderer tests.
 * Reduces boilerplate when testing shapes with fills.
 */
export function createRectangleShape(options: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  color?: string;
  fillIndex?: number;
  matrix?: Partial<Matrix>;
}): Shape {
  const {
    x = 0,
    y = 0,
    width = 100,
    height = 100,
    color = '#FF0000',
    fillIndex = 1,
    matrix = {},
  } = options;

  return {
    type: 'shape',
    matrix: createIdentityMatrix(matrix),
    fills: [{ index: fillIndex, type: 'solid', color }],
    strokes: [],
    edges: [
      {
        fillStyle1: fillIndex,
        commands: [
          { type: 'M', x, y },
          { type: 'L', x: x + width, y },
          { type: 'L', x: x + width, y: y + height },
          { type: 'L', x, y: y + height },
          { type: 'Z' },
        ],
      },
    ],
  };
}

/**
 * Creates a simple triangle shape for renderer tests.
 */
export function createTriangleShape(options: {
  x?: number;
  y?: number;
  size?: number;
  color?: string;
  fillIndex?: number;
  matrix?: Partial<Matrix>;
}): Shape {
  const {
    x = 0,
    y = 0,
    size = 100,
    color = '#00FF00',
    fillIndex = 1,
    matrix = {},
  } = options;

  return {
    type: 'shape',
    matrix: createIdentityMatrix(matrix),
    fills: [{ index: fillIndex, type: 'solid', color }],
    strokes: [],
    edges: [
      {
        fillStyle1: fillIndex,
        commands: [
          { type: 'M', x, y },
          { type: 'L', x: x + size, y },
          { type: 'L', x: x + size / 2, y: y + size },
          { type: 'Z' },
        ],
      },
    ],
  };
}

/**
 * Creates a shape with custom edges for more complex test scenarios.
 */
export function createCustomShape(options: {
  fills?: FillStyle[];
  edges?: Edge[];
  matrix?: Partial<Matrix>;
}): Shape {
  const { fills = [], edges = [], matrix = {} } = options;

  return {
    type: 'shape',
    matrix: createIdentityMatrix(matrix),
    fills,
    strokes: [],
    edges,
  };
}

/**
 * Type for console spy, exported for convenience
 */
export type ConsoleSpy = ReturnType<typeof vi.spyOn>;

// ============================================================================
// Document Factory Functions
// ============================================================================

/**
 * Creates a minimal FLADocument for testing.
 * Default dimensions: 550x400, 24fps, white background.
 */
export function createMinimalDoc(overrides: Partial<FLADocument> = {}): FLADocument {
  return {
    width: 550,
    height: 400,
    frameRate: 24,
    backgroundColor: '#FFFFFF',
    timelines: [],
    symbols: new Map(),
    bitmaps: new Map(),
    sounds: new Map(),
    ...overrides,
  };
}

/**
 * Creates a Timeline for testing.
 */
export function createTimeline(overrides: Partial<Timeline> = {}): Timeline {
  return {
    name: 'Timeline 1',
    layers: [],
    totalFrames: 1,
    referenceLayers: new Set(),
    ...overrides,
  };
}

/**
 * Creates a Layer for testing.
 */
export function createLayer(overrides: Partial<Layer> = {}): Layer {
  return {
    name: 'Layer 1',
    frames: [],
    ...overrides,
  };
}

/**
 * Creates a Frame for testing.
 */
export function createFrame(overrides: Partial<Frame> = {}): Frame {
  return {
    index: 0,
    duration: 1,
    elements: [],
    ...overrides,
  };
}

/**
 * Alias for createIdentityMatrix for consistency with other test files.
 */
export const createMatrix = createIdentityMatrix;

// ============================================================================
// Canvas Assertion Helpers
// ============================================================================

/**
 * Checks if canvas has any rendered (non-transparent) pixels
 * that differ from the background color.
 */
export function hasRenderedContent(
  canvas: HTMLCanvasElement,
  backgroundColor = '#FFFFFF'
): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const bgR = parseInt(backgroundColor.slice(1, 3), 16);
  const bgG = parseInt(backgroundColor.slice(3, 5), 16);
  const bgB = parseInt(backgroundColor.slice(5, 7), 16);

  for (let i = 0; i < imageData.data.length; i += 4) {
    const r = imageData.data[i];
    const g = imageData.data[i + 1];
    const b = imageData.data[i + 2];
    const a = imageData.data[i + 3];
    if (a > 0 && (r !== bgR || g !== bgG || b !== bgB)) {
      return true;
    }
  }
  return false;
}

/**
 * Checks if a specific color exists in the canvas.
 * @param tolerance - Color matching tolerance (default 10)
 */
export function hasColor(
  canvas: HTMLCanvasElement,
  colorHex: string,
  tolerance = 10
): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const targetR = parseInt(colorHex.slice(1, 3), 16);
  const targetG = parseInt(colorHex.slice(3, 5), 16);
  const targetB = parseInt(colorHex.slice(5, 7), 16);

  for (let i = 0; i < imageData.data.length; i += 4) {
    const r = imageData.data[i];
    const g = imageData.data[i + 1];
    const b = imageData.data[i + 2];
    const a = imageData.data[i + 3];
    if (
      a > 0 &&
      Math.abs(r - targetR) <= tolerance &&
      Math.abs(g - targetG) <= tolerance &&
      Math.abs(b - targetB) <= tolerance
    ) {
      return true;
    }
  }
  return false;
}

// ============================================================================
// Symbol Helpers
// ============================================================================

/**
 * Creates a SymbolInstance for testing.
 */
export function createSymbolInstance(
  libraryItemName: string,
  options: {
    matrix?: Partial<Matrix>;
    loop?: 'loop' | 'play once' | 'single frame';
    symbolType?: 'graphic' | 'movieclip' | 'button';
    firstFrame?: number;
    transformationPoint?: { x: number; y: number };
  } = {}
): SymbolInstance {
  const {
    matrix = {},
    loop = 'loop',
    symbolType = 'graphic',
    firstFrame = 0,
    transformationPoint,
  } = options;

  return {
    type: 'symbol',
    libraryItemName,
    matrix: createIdentityMatrix(matrix),
    loop,
    symbolType,
    firstFrame,
    ...(transformationPoint && { transformationPoint }),
  };
}

/**
 * Creates a Symbol definition for the library.
 */
export function createSymbol(
  name: string,
  options: {
    timeline?: Partial<Timeline>;
    symbolType?: 'graphic' | 'movieclip' | 'button';
  } = {}
): Symbol {
  const { timeline = {}, symbolType = 'graphic' } = options;

  return {
    name,
    symbolType,
    timeline: createTimeline({ name, ...timeline }),
  };
}

/**
 * Creates a document with symbols pre-populated in the library.
 * Convenience helper for tests that need symbol references.
 */
export function createDocWithSymbols(
  symbolDefs: Array<{ name: string; timeline?: Partial<Timeline> }>,
  docOverrides: Partial<FLADocument> = {}
): FLADocument {
  const symbols = new Map<string, Symbol>();
  for (const def of symbolDefs) {
    symbols.set(def.name, createSymbol(def.name, { timeline: def.timeline }));
  }

  return createMinimalDoc({
    symbols,
    ...docOverrides,
  });
}
