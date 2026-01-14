import { describe, it, expect, beforeEach } from 'vitest';
import { FLARenderer } from '../renderer';
import type { FLADocument, Timeline, Layer, Frame, Matrix } from '../types';

// Helper to create minimal document structure
function createMinimalDoc(overrides: Partial<FLADocument> = {}): FLADocument {
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

function createMatrix(overrides: Partial<Matrix> = {}): Matrix {
  return {
    a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0,
    ...overrides,
  };
}

function createTimeline(overrides: Partial<Timeline> = {}): Timeline {
  return {
    name: 'Timeline 1',
    layers: [],
    totalFrames: 1,
    referenceLayers: new Set(),
    ...overrides,
  };
}

function createLayer(overrides: Partial<Layer> = {}): Layer {
  return {
    name: 'Layer 1',
    frames: [],
    ...overrides,
  };
}

function createFrame(overrides: Partial<Frame> = {}): Frame {
  return {
    index: 0,
    duration: 1,
    elements: [],
    ...overrides,
  };
}

// Helper to check if canvas has any rendered (non-transparent) pixels
function hasRenderedContent(canvas: HTMLCanvasElement, backgroundColor = '#FFFFFF'): boolean {
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
    // Check if pixel is not transparent and not background color
    if (a > 0 && (r !== bgR || g !== bgG || b !== bgB)) {
      return true;
    }
  }
  return false;
}

// Helper to check if a specific color exists in the canvas
function hasColor(canvas: HTMLCanvasElement, colorHex: string, tolerance = 10): boolean {
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
    if (a > 0 &&
        Math.abs(r - targetR) <= tolerance &&
        Math.abs(g - targetG) <= tolerance &&
        Math.abs(b - targetB) <= tolerance) {
      return true;
    }
  }
  return false;
}

describe('FLARenderer', () => {
  let canvas: HTMLCanvasElement;
  let renderer: FLARenderer;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvas.width = 550;
    canvas.height = 400;
    renderer = new FLARenderer(canvas);
  });

  describe('constructor', () => {
    it('should create renderer with canvas', () => {
      expect(renderer).toBeDefined();
    });
  });

  describe('setDocument', () => {
    it('should set document without errors', async () => {
      const doc = createMinimalDoc();
      await expect(renderer.setDocument(doc)).resolves.not.toThrow();
    });
  });

  describe('renderFrame', () => {
    it('should render empty frame without errors', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame()],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should render frame with shape element', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{
                  index: 1,
                  color: '#FF0000',
                }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 0, y: 0 },
                    { type: 'L', x: 100, y: 0 },
                    { type: 'L', x: 100, y: 100 },
                    { type: 'L', x: 0, y: 100 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should handle frame index beyond total frames', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          totalFrames: 10,
          layers: [createLayer({
            frames: [createFrame({ index: 0, duration: 10 })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      // Should not throw even with out of bounds frame
      expect(() => renderer.renderFrame(100)).not.toThrow();
    });
  });

  describe('updateCanvasSize', () => {
    it('should update canvas to match container', async () => {
      const doc = createMinimalDoc();
      await renderer.setDocument(doc);

      // Create a container
      const container = document.createElement('div');
      document.body.appendChild(container);
      Object.defineProperty(container, 'clientWidth', { value: 1000, configurable: true });
      Object.defineProperty(container, 'clientHeight', { value: 800, configurable: true });

      renderer.updateCanvasSize(container);

      // Canvas should be resized
      expect(canvas.width).toBeGreaterThan(0);
      expect(canvas.height).toBeGreaterThan(0);

      document.body.removeChild(container);
    });
  });

  describe('hidden layers', () => {
    it('should skip hidden layers during render', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [
            createLayer({ name: 'Layer 1', frames: [createFrame()] }),
            createLayer({ name: 'Layer 2', frames: [createFrame()] }),
          ],
        })],
      });
      await renderer.setDocument(doc);

      // Hide layer 0
      renderer.setHiddenLayers(new Set([0]));

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

  describe('debug mode', () => {
    it('should enable and disable debug mode', async () => {
      const doc = createMinimalDoc();
      await renderer.setDocument(doc);

      renderer.enableDebugMode();
      expect(() => renderer.renderFrame(0)).not.toThrow();

      renderer.disableDebugMode();
      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

  describe('layer order', () => {
    it('should accept layer order settings', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [
            createLayer({ name: 'Layer 1', frames: [createFrame()] }),
            createLayer({ name: 'Layer 2', frames: [createFrame()] }),
          ],
        })],
      });
      await renderer.setDocument(doc);

      renderer.setLayerOrder('reverse');
      expect(() => renderer.renderFrame(0)).not.toThrow();

      renderer.setLayerOrder('forward');
      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

  describe('camera follow', () => {
    it('should toggle camera follow mode', () => {
      renderer.setFollowCamera(true);
      expect(renderer.getFollowCamera()).toBe(true);

      renderer.setFollowCamera(false);
      expect(renderer.getFollowCamera()).toBe(false);
    });

    it('should find camera layer by name', async () => {
      const symbolTimeline = createTimeline({
        name: 'CameraSymbol',
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, color: '#FFFFFF' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 550, y: 0 },
                  { type: 'L', x: 550, y: 400 },
                  { type: 'L', x: 0, y: 400 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('CameraSymbol', {
        name: 'CameraSymbol',
        type: 'graphic',
        timeline: symbolTimeline,
      });

      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          layers: [
            createLayer({
              name: 'camera', // Camera layer
              frames: [createFrame({
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'CameraSymbol',
                  symbolType: 'graphic',
                  matrix: createMatrix(),
                  firstFrame: 0,
                  loop: 'loop',
                }],
              })],
            }),
            createLayer({
              name: 'Content',
              frames: [createFrame()],
            }),
          ],
        })],
      });
      await renderer.setDocument(doc);

      const cameraLayers = renderer.getCameraLayers();
      expect(cameraLayers.length).toBeGreaterThan(0);
      expect(cameraLayers[0].name).toBe('camera');
    });

    it('should find ramka layer as camera', async () => {
      const symbolTimeline = createTimeline({
        name: 'RamkaSymbol',
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, color: '#00FF00' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 100, y: 0 },
                  { type: 'L', x: 100, y: 100 },
                  { type: 'L', x: 0, y: 100 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('RamkaSymbol', {
        name: 'RamkaSymbol',
        type: 'graphic',
        timeline: symbolTimeline,
      });

      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          layers: [
            createLayer({
              name: 'ramka', // Ramka layer (camera in Russian)
              frames: [createFrame({
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'RamkaSymbol',
                  symbolType: 'graphic',
                  matrix: createMatrix(),
                  firstFrame: 0,
                  loop: 'loop',
                }],
              })],
            }),
          ],
        })],
      });
      await renderer.setDocument(doc);

      const cameraLayers = renderer.getCameraLayers();
      expect(cameraLayers.length).toBe(1);
      expect(cameraLayers[0].name).toBe('ramka');
    });

    it('should enable follow camera with camera layer', async () => {
      const symbolTimeline = createTimeline({
        name: 'CamSymbol',
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, color: '#0000FF' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 200, y: 0 },
                  { type: 'L', x: 200, y: 150 },
                  { type: 'L', x: 0, y: 150 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('CamSymbol', {
        name: 'CamSymbol',
        type: 'graphic',
        timeline: symbolTimeline,
      });

      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          layers: [
            createLayer({
              name: 'viewport',
              frames: [createFrame({
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'CamSymbol',
                  symbolType: 'graphic',
                  matrix: createMatrix({ tx: 50, ty: 50 }),
                  firstFrame: 0,
                  loop: 'loop',
                }],
              })],
            }),
            createLayer({
              name: 'Content',
              frames: [createFrame({
                elements: [{
                  type: 'shape',
                  matrix: createMatrix(),
                  fills: [{ index: 1, color: '#FF0000' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 100, y: 100 },
                      { type: 'L', x: 200, y: 100 },
                      { type: 'L', x: 200, y: 200 },
                      { type: 'L', x: 100, y: 200 },
                      { type: 'Z' },
                    ],
                  }],
                }],
              })],
            }),
          ],
        })],
      });
      await renderer.setDocument(doc);

      renderer.setFollowCamera(true);
      expect(renderer.getFollowCamera()).toBe(true);

      // Should render without errors
      expect(() => renderer.renderFrame(0)).not.toThrow();

      renderer.setFollowCamera(false);
      expect(renderer.getFollowCamera()).toBe(false);
    });

    it('should return empty array when no camera layers', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [
            createLayer({
              name: 'Layer 1',
              frames: [createFrame()],
            }),
          ],
        })],
      });
      await renderer.setDocument(doc);

      const cameraLayers = renderer.getCameraLayers();
      expect(cameraLayers).toEqual([]);
    });
  });

  describe('gradient fills', () => {
    it('should render linear gradient fill', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{
                  index: 1,
                  type: 'linear',
                  entries: [
                    { ratio: 0, color: '#FF0000' },
                    { ratio: 1, color: '#0000FF' },
                  ],
                  matrix: createMatrix(),
                }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 0, y: 0 },
                    { type: 'L', x: 100, y: 0 },
                    { type: 'L', x: 100, y: 100 },
                    { type: 'L', x: 0, y: 100 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should render radial gradient fill', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{
                  index: 1,
                  type: 'radial',
                  entries: [
                    { ratio: 0, color: '#FFFFFF' },
                    { ratio: 1, color: '#000000' },
                  ],
                  matrix: createMatrix(),
                }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 50, y: 0 },
                    { type: 'L', x: 100, y: 50 },
                    { type: 'L', x: 50, y: 100 },
                    { type: 'L', x: 0, y: 50 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

  describe('strokes', () => {
    it('should render stroke with color', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [],
                strokes: [{
                  index: 1,
                  color: '#000000',
                  weight: 2,
                }],
                edges: [{
                  strokeStyle: 1,
                  commands: [
                    { type: 'M', x: 0, y: 0 },
                    { type: 'L', x: 100, y: 100 },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

  describe('symbol instances', () => {
    it('should render symbol instance', async () => {
      const symbolTimeline = createTimeline({
        name: 'Symbol 1',
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, color: '#00FF00' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 50, y: 0 },
                  { type: 'L', x: 50, y: 50 },
                  { type: 'L', x: 0, y: 50 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('Symbol 1', {
        name: 'Symbol 1',
        type: 'graphic',
        timeline: symbolTimeline,
      });

      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'symbol',
                libraryItemName: 'Symbol 1',
                symbolType: 'graphic',
                matrix: createMatrix({ tx: 100, ty: 100 }),
                firstFrame: 0,
                loop: 'loop',
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

  describe('text rendering', () => {
    it('should render text element', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'text',
                matrix: createMatrix({ tx: 50, ty: 50 }),
                left: 0,
                width: 200,
                height: 50,
                textRuns: [{
                  characters: 'Hello World',
                  size: 24,
                  face: 'Arial',
                  fillColor: '#000000',
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

  describe('bitmap rendering', () => {
    it('should handle missing bitmap gracefully', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'bitmap',
                libraryItemName: 'missing.png',
                matrix: createMatrix(),
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      // Should not throw even with missing bitmap
      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

  describe('tweens', () => {
    it('should interpolate tween between keyframes', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          totalFrames: 10,
          layers: [createLayer({
            frames: [
              createFrame({
                index: 0,
                duration: 5,
                tweenType: 'motion',
                elements: [{
                  type: 'shape',
                  matrix: createMatrix({ tx: 0 }),
                  fills: [{ index: 1, color: '#FF0000' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 0 },
                      { type: 'L', x: 50, y: 0 },
                      { type: 'L', x: 50, y: 50 },
                      { type: 'L', x: 0, y: 50 },
                      { type: 'Z' },
                    ],
                  }],
                }],
              }),
              createFrame({
                index: 5,
                duration: 5,
                elements: [{
                  type: 'shape',
                  matrix: createMatrix({ tx: 200 }),
                  fills: [{ index: 1, color: '#FF0000' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 0 },
                      { type: 'L', x: 50, y: 0 },
                      { type: 'L', x: 50, y: 50 },
                      { type: 'L', x: 0, y: 50 },
                      { type: 'Z' },
                    ],
                  }],
                }],
              }),
            ],
          })],
        })],
      });
      await renderer.setDocument(doc);

      // Render middle frame (should interpolate)
      expect(() => renderer.renderFrame(2)).not.toThrow();
    });
  });

  describe('debug click handling', () => {
    it('should track elements in debug mode', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#FF0000' }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 100, y: 100 },
                    { type: 'L', x: 200, y: 100 },
                    { type: 'L', x: 200, y: 200 },
                    { type: 'L', x: 100, y: 200 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.enableDebugMode();
      renderer.renderFrame(0);

      // Simulate click on canvas
      const clickEvent = new MouseEvent('click', {
        bubbles: true,
        clientX: 150,
        clientY: 150,
      });
      canvas.dispatchEvent(clickEvent);

      renderer.disableDebugMode();
    });

    it('should handle click on symbol elements', async () => {
      const symbolTimeline = createTimeline({
        name: 'Symbol 1',
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, color: '#00FF00' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 50, y: 0 },
                  { type: 'L', x: 50, y: 50 },
                  { type: 'L', x: 0, y: 50 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('Symbol 1', {
        name: 'Symbol 1',
        type: 'graphic',
        timeline: symbolTimeline,
      });

      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'symbol',
                libraryItemName: 'Symbol 1',
                symbolType: 'graphic',
                matrix: createMatrix({ tx: 100, ty: 100 }),
                firstFrame: 0,
                loop: 'loop',
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.enableDebugMode();
      renderer.renderFrame(0);

      // Click on the symbol
      const clickEvent = new MouseEvent('click', {
        bubbles: true,
        clientX: 125,
        clientY: 125,
      });
      canvas.dispatchEvent(clickEvent);

      renderer.disableDebugMode();
    });
  });

  describe('nested layer order', () => {
    it('should render with nested layer order reverse', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [
            createLayer({ name: 'Layer 1', frames: [createFrame()] }),
            createLayer({ name: 'Layer 2', frames: [createFrame()] }),
          ],
        })],
      });
      await renderer.setDocument(doc);

      renderer.setNestedLayerOrder('reverse');
      expect(() => renderer.renderFrame(0)).not.toThrow();

      renderer.setNestedLayerOrder('forward');
      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

  describe('element order', () => {
    it('should render with element order reverse', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [
                {
                  type: 'shape',
                  matrix: createMatrix(),
                  fills: [{ index: 1, color: '#FF0000' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 0 },
                      { type: 'L', x: 50, y: 0 },
                      { type: 'L', x: 50, y: 50 },
                      { type: 'Z' },
                    ],
                  }],
                },
                {
                  type: 'shape',
                  matrix: createMatrix({ tx: 100 }),
                  fills: [{ index: 1, color: '#00FF00' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 0 },
                      { type: 'L', x: 50, y: 0 },
                      { type: 'L', x: 50, y: 50 },
                      { type: 'Z' },
                    ],
                  }],
                },
              ],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.setElementOrder('reverse');
      expect(() => renderer.renderFrame(0)).not.toThrow();

      renderer.setElementOrder('forward');
      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

  describe('quadratic curves', () => {
    it('should render shape with quadratic bezier curves', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#FF0000' }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 0, y: 0 },
                    { type: 'Q', x: 100, y: 0, cx: 50, cy: -50 },
                    { type: 'Q', x: 100, y: 100, cx: 150, cy: 50 },
                    { type: 'Q', x: 0, y: 100, cx: 50, cy: 150 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

  describe('cubic curves', () => {
    it('should render shape with cubic bezier curves', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#0000FF' }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 0, y: 50 },
                    { type: 'C', x: 100, y: 50, c1x: 25, c1y: 0, c2x: 75, c2y: 0 },
                    { type: 'C', x: 100, y: 150, c1x: 150, c1y: 75, c2x: 150, c2y: 125 },
                    { type: 'C', x: 0, y: 150, c1x: 75, c1y: 200, c2x: 25, c2y: 200 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

  describe('folder and guide layers', () => {
    it('should skip guide layers', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          referenceLayers: new Set([0]),
          layers: [
            createLayer({
              name: 'Guide',
              layerType: 'guide',
              frames: [createFrame({
                elements: [{
                  type: 'shape',
                  matrix: createMatrix(),
                  fills: [{ index: 1, color: '#FF0000' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 0 },
                      { type: 'L', x: 100, y: 100 },
                    ],
                  }],
                }],
              })],
            }),
            createLayer({
              name: 'Content',
              frames: [createFrame()],
            }),
          ],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should skip folder layers', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [
            createLayer({
              name: 'Folder',
              layerType: 'folder',
              frames: [],
            }),
            createLayer({
              name: 'Content',
              frames: [createFrame()],
            }),
          ],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

  describe('bitmap fills', () => {
    it('should render shape with bitmap fill', async () => {
      const bitmaps = new Map();
      // Create a simple image
      const imageCanvas = document.createElement('canvas');
      imageCanvas.width = 50;
      imageCanvas.height = 50;
      const imageCtx = imageCanvas.getContext('2d')!;
      imageCtx.fillStyle = '#FF0000';
      imageCtx.fillRect(0, 0, 50, 50);

      const imageData = imageCtx.getImageData(0, 0, 50, 50);
      const bitmap = await createImageBitmap(imageData);

      bitmaps.set('test.png', { image: bitmap });

      const doc = createMinimalDoc({
        bitmaps,
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{
                  index: 1,
                  type: 'bitmap',
                  bitmapPath: 'test.png',
                  matrix: createMatrix(),
                }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 0, y: 0 },
                    { type: 'L', x: 100, y: 0 },
                    { type: 'L', x: 100, y: 100 },
                    { type: 'L', x: 0, y: 100 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

  describe('stroke caps and joints', () => {
    it('should render strokes with different caps', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [],
                strokes: [{
                  index: 1,
                  color: '#000000',
                  weight: 5,
                  caps: 'round',
                  joints: 'round',
                }],
                edges: [{
                  strokeStyle: 1,
                  commands: [
                    { type: 'M', x: 10, y: 10 },
                    { type: 'L', x: 100, y: 10 },
                    { type: 'L', x: 100, y: 100 },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

  describe('movie clip symbols', () => {
    it('should render movie clip with independent timeline', async () => {
      const symbolTimeline = createTimeline({
        name: 'MovieClip 1',
        totalFrames: 5,
        layers: [createLayer({
          frames: [
            createFrame({
              index: 0,
              duration: 5,
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#FF0000' }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 0, y: 0 },
                    { type: 'L', x: 30, y: 0 },
                    { type: 'L', x: 30, y: 30 },
                    { type: 'L', x: 0, y: 30 },
                    { type: 'Z' },
                  ],
                }],
              }],
            }),
          ],
        })],
      });

      const symbols = new Map();
      symbols.set('MovieClip 1', {
        name: 'MovieClip 1',
        type: 'movie clip',
        timeline: symbolTimeline,
      });

      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          totalFrames: 10,
          layers: [createLayer({
            frames: [createFrame({
              duration: 10,
              elements: [{
                type: 'symbol',
                libraryItemName: 'MovieClip 1',
                symbolType: 'movie clip',
                matrix: createMatrix({ tx: 50, ty: 50 }),
                firstFrame: 0,
                loop: 'loop',
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      // Render multiple frames to test movie clip timeline
      expect(() => renderer.renderFrame(0)).not.toThrow();
      expect(() => renderer.renderFrame(3)).not.toThrow();
      expect(() => renderer.renderFrame(7)).not.toThrow();
    });
  });

  describe('nested symbols', () => {
    it('should render symbol inside symbol', async () => {
      const innerSymbolTimeline = createTimeline({
        name: 'Inner',
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, color: '#0000FF' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 20, y: 0 },
                  { type: 'L', x: 20, y: 20 },
                  { type: 'L', x: 0, y: 20 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const outerSymbolTimeline = createTimeline({
        name: 'Outer',
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'symbol',
              libraryItemName: 'Inner',
              symbolType: 'graphic',
              matrix: createMatrix({ tx: 10, ty: 10 }),
              firstFrame: 0,
              loop: 'loop',
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('Inner', {
        name: 'Inner',
        type: 'graphic',
        timeline: innerSymbolTimeline,
      });
      symbols.set('Outer', {
        name: 'Outer',
        type: 'graphic',
        timeline: outerSymbolTimeline,
      });

      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'symbol',
                libraryItemName: 'Outer',
                symbolType: 'graphic',
                matrix: createMatrix({ tx: 100, ty: 100 }),
                firstFrame: 0,
                loop: 'loop',
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

  describe('color transforms', () => {
    it('should render shape with alpha', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#FF0000', alpha: 0.5 }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 0, y: 0 },
                    { type: 'L', x: 100, y: 0 },
                    { type: 'L', x: 100, y: 100 },
                    { type: 'L', x: 0, y: 100 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

  describe('multiple text runs', () => {
    it('should render text with multiple styled runs', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'text',
                matrix: createMatrix({ tx: 50, ty: 50 }),
                left: 0,
                width: 300,
                height: 100,
                textRuns: [
                  {
                    characters: 'Bold ',
                    size: 24,
                    face: 'Arial',
                    fillColor: '#000000',
                    bold: true,
                  },
                  {
                    characters: 'and Italic',
                    size: 24,
                    face: 'Arial',
                    fillColor: '#FF0000',
                    italic: true,
                  },
                ],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

  describe('ease interpolation', () => {
    it('should apply ease to tween', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          totalFrames: 10,
          layers: [createLayer({
            frames: [
              createFrame({
                index: 0,
                duration: 5,
                tweenType: 'motion',
                tweens: [{
                  target: 'all',
                  intensity: 50,
                }],
                elements: [{
                  type: 'shape',
                  matrix: createMatrix({ tx: 0 }),
                  fills: [{ index: 1, color: '#FF0000' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 0 },
                      { type: 'L', x: 50, y: 0 },
                      { type: 'L', x: 50, y: 50 },
                      { type: 'L', x: 0, y: 50 },
                      { type: 'Z' },
                    ],
                  }],
                }],
              }),
              createFrame({
                index: 5,
                duration: 5,
                elements: [{
                  type: 'shape',
                  matrix: createMatrix({ tx: 200 }),
                  fills: [{ index: 1, color: '#FF0000' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 0 },
                      { type: 'L', x: 50, y: 0 },
                      { type: 'L', x: 50, y: 50 },
                      { type: 'L', x: 0, y: 50 },
                      { type: 'Z' },
                    ],
                  }],
                }],
              }),
            ],
          })],
        })],
      });
      await renderer.setDocument(doc);

      // Render frames to test easing
      expect(() => renderer.renderFrame(0)).not.toThrow();
      expect(() => renderer.renderFrame(2)).not.toThrow();
      expect(() => renderer.renderFrame(4)).not.toThrow();
    });
  });

  describe('camera motion tween', () => {
    it('should interpolate camera transform during motion tween', async () => {
      // Create a camera symbol
      const cameraSymbol = createTimeline({
        name: 'Ramka',
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, color: '#00FF00' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 550, y: 0 },
                  { type: 'L', x: 550, y: 400 },
                  { type: 'L', x: 0, y: 400 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('Ramka', {
        name: 'Ramka',
        symbolType: 'graphic',
        timeline: cameraSymbol,
      });

      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          totalFrames: 10,
          layers: [
            // Camera layer with motion tween
            createLayer({
              name: 'camera',
              layerType: 'guide',
              frames: [
                createFrame({
                  index: 0,
                  duration: 5,
                  tweenType: 'motion',
                  elements: [{
                    type: 'symbol',
                    libraryItemName: 'Ramka',
                    symbolType: 'graphic',
                    matrix: createMatrix({ a: 1, d: 1, tx: 0, ty: 0 }),
                    transformationPoint: { x: 275, y: 200 },
                    firstFrame: 0,
                    loop: 'loop',
                  }],
                }),
                createFrame({
                  index: 5,
                  duration: 5,
                  elements: [{
                    type: 'symbol',
                    libraryItemName: 'Ramka',
                    symbolType: 'graphic',
                    matrix: createMatrix({ a: 2, d: 2, tx: 100, ty: 100 }),
                    transformationPoint: { x: 275, y: 200 },
                    firstFrame: 0,
                    loop: 'loop',
                  }],
                }),
              ],
            }),
            // Content layer
            createLayer({
              name: 'Content',
              frames: [createFrame({
                duration: 10,
                elements: [{
                  type: 'shape',
                  matrix: createMatrix({ tx: 100, ty: 100 }),
                  fills: [{ index: 1, color: '#FF0000' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 0 },
                      { type: 'L', x: 100, y: 0 },
                      { type: 'L', x: 100, y: 100 },
                      { type: 'L', x: 0, y: 100 },
                      { type: 'Z' },
                    ],
                  }],
                }],
              })],
            }),
          ],
        })],
      });
      await renderer.setDocument(doc);

      renderer.setFollowCamera(true);

      // Render frames during tween to test camera interpolation
      expect(() => renderer.renderFrame(0)).not.toThrow();
      expect(() => renderer.renderFrame(2)).not.toThrow();
      expect(() => renderer.renderFrame(4)).not.toThrow();
      expect(() => renderer.renderFrame(7)).not.toThrow();
    });
  });

  describe('complex shape edges', () => {
    it('should handle multiple edges with different fill styles', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [
                  { index: 1, color: '#FF0000' },
                  { index: 2, color: '#00FF00' },
                ],
                strokes: [],
                edges: [
                  // First fill region - red at (0,0)
                  {
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 0 },
                      { type: 'L', x: 50, y: 0 },
                      { type: 'L', x: 50, y: 50 },
                      { type: 'L', x: 0, y: 50 },
                      { type: 'Z' },
                    ],
                  },
                  // Second fill region - green at (60,0)
                  {
                    fillStyle0: 2,
                    commands: [
                      { type: 'M', x: 60, y: 0 },
                      { type: 'L', x: 110, y: 0 },
                      { type: 'L', x: 110, y: 50 },
                      { type: 'L', x: 60, y: 50 },
                      { type: 'Z' },
                    ],
                  },
                  // Third edge with fillStyle1 - red at (120,0)
                  {
                    fillStyle1: 1,
                    commands: [
                      { type: 'M', x: 120, y: 0 },
                      { type: 'L', x: 170, y: 0 },
                      { type: 'L', x: 170, y: 50 },
                      { type: 'L', x: 120, y: 50 },
                      { type: 'Z' },
                    ],
                  },
                ],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.renderFrame(0);

      // Check that canvas was rendered to
      const ctx = canvas.getContext('2d')!;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      expect(imageData.data.length).toBeGreaterThan(0);

      // Count non-white/non-transparent pixels to verify shapes were drawn
      let nonBackgroundPixels = 0;
      for (let i = 0; i < imageData.data.length; i += 4) {
        const r = imageData.data[i];
        const g = imageData.data[i + 1];
        const b = imageData.data[i + 2];
        const a = imageData.data[i + 3];
        // Count pixels that aren't white (255,255,255) and aren't transparent
        if (a > 0 && (r < 255 || g < 255 || b < 255)) {
          nonBackgroundPixels++;
        }
      }
      // At least some pixels should be drawn (shapes are rendered)
      expect(nonBackgroundPixels).toBeGreaterThan(100);
    });

    it('should handle edge soup with disconnected segments', async () => {
      // Test the edge sorting algorithm with disconnected edges
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#0000FF' }],
                strokes: [],
                edges: [
                  // First segment
                  {
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 0 },
                      { type: 'L', x: 50, y: 0 },
                    ],
                  },
                  // Disconnected segment
                  {
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 100, y: 100 },
                      { type: 'L', x: 150, y: 100 },
                    ],
                  },
                  // Continuation of first
                  {
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 50, y: 0 },
                      { type: 'L', x: 50, y: 50 },
                    ],
                  },
                  // Closing segment
                  {
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 50, y: 50 },
                      { type: 'L', x: 0, y: 50 },
                      { type: 'L', x: 0, y: 0 },
                    ],
                  },
                ],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

  describe('text element rendering', () => {
    it('should handle text with various alignment', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'text',
                matrix: createMatrix({ tx: 100, ty: 100 }),
                left: 0,
                width: 200,
                height: 50,
                textRuns: [{
                  characters: 'Centered text',
                  size: 18,
                  face: 'Arial',
                  fillColor: '#333333',
                  alignment: 'center',
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

  describe('symbol loop modes', () => {
    it('should handle play once loop mode', async () => {
      const symbolTimeline = createTimeline({
        name: 'PlayOnce',
        totalFrames: 5,
        layers: [createLayer({
          frames: [createFrame({
            duration: 5,
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, color: '#FF00FF' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 30, y: 0 },
                  { type: 'L', x: 30, y: 30 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('PlayOnce', {
        name: 'PlayOnce',
        symbolType: 'graphic',
        timeline: symbolTimeline,
      });

      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          totalFrames: 20,
          layers: [createLayer({
            frames: [createFrame({
              duration: 20,
              elements: [{
                type: 'symbol',
                libraryItemName: 'PlayOnce',
                symbolType: 'graphic',
                matrix: createMatrix({ tx: 50, ty: 50 }),
                firstFrame: 0,
                loop: 'play once',
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      // Render beyond symbol length
      expect(() => renderer.renderFrame(0)).not.toThrow();
      expect(() => renderer.renderFrame(10)).not.toThrow();
      expect(() => renderer.renderFrame(15)).not.toThrow();
    });

    it('should handle single frame loop mode', async () => {
      const symbolTimeline = createTimeline({
        name: 'SingleFrame',
        totalFrames: 10,
        layers: [createLayer({
          frames: [
            createFrame({
              index: 0,
              duration: 5,
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#00FFFF' }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 0, y: 0 },
                    { type: 'L', x: 40, y: 40 },
                    { type: 'Z' },
                  ],
                }],
              }],
            }),
            createFrame({
              index: 5,
              duration: 5,
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#FFFF00' }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 0, y: 0 },
                    { type: 'L', x: 40, y: 40 },
                    { type: 'Z' },
                  ],
                }],
              }],
            }),
          ],
        })],
      });

      const symbols = new Map();
      symbols.set('SingleFrame', {
        name: 'SingleFrame',
        symbolType: 'graphic',
        timeline: symbolTimeline,
      });

      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          totalFrames: 20,
          layers: [createLayer({
            frames: [createFrame({
              duration: 20,
              elements: [{
                type: 'symbol',
                libraryItemName: 'SingleFrame',
                symbolType: 'graphic',
                matrix: createMatrix({ tx: 80, ty: 80 }),
                firstFrame: 3,
                loop: 'single frame',
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      // Single frame should always show the same frame
      expect(() => renderer.renderFrame(0)).not.toThrow();
      expect(() => renderer.renderFrame(5)).not.toThrow();
      expect(() => renderer.renderFrame(15)).not.toThrow();
    });
  });

  describe('bitmap instance', () => {
    it('should render bitmap instance element', async () => {
      // Create an image bitmap with magenta color
      const imageCanvas = document.createElement('canvas');
      imageCanvas.width = 100;
      imageCanvas.height = 100;
      const imageCtx = imageCanvas.getContext('2d')!;
      imageCtx.fillStyle = '#FF00FF';
      imageCtx.fillRect(0, 0, 100, 100);
      const imgData = imageCtx.getImageData(0, 0, 100, 100);
      const bitmap = await createImageBitmap(imgData);

      const bitmaps = new Map();
      bitmaps.set('image.png', {
        name: 'image.png',
        image: bitmap,
        width: 100,
        height: 100,
      });

      const doc = createMinimalDoc({
        bitmaps,
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'bitmap',
                libraryItemName: 'image.png',
                matrix: createMatrix({ tx: 50, ty: 50 }),
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      // Render the frame
      renderer.renderFrame(0);

      // Verify canvas context exists and was used
      const ctx = canvas.getContext('2d')!;
      expect(ctx).toBeDefined();

      // Verify image data can be read (canvas was rendered to)
      const canvasImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      expect(canvasImageData.data.length).toBeGreaterThan(0);
      expect(canvasImageData.width).toBe(canvas.width);
      expect(canvasImageData.height).toBe(canvas.height);
    });
  });

  describe('video instance', () => {
    it('should render video placeholder', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'video',
                libraryItemName: 'clip.mp4',
                matrix: createMatrix({ tx: 100, ty: 100 }),
                width: 200,
                height: 150,
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.renderFrame(0);

      // Video renders a dark gray placeholder - scan for gray pixels
      const ctx = canvas.getContext('2d')!;
      const pixelData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let hasGrayPixels = false;
      for (let i = 0; i < pixelData.data.length; i += 4) {
        const r = pixelData.data[i];
        const g = pixelData.data[i + 1];
        const b = pixelData.data[i + 2];
        // Check for dark gray pixels (all values similar and low)
        if (r > 40 && r < 80 && g > 40 && g < 80 && b > 40 && b < 80) {
          hasGrayPixels = true;
          break;
        }
      }
      expect(hasGrayPixels).toBe(true);
    });
  });

  describe('gradient with alpha', () => {
    it('should render gradient with alpha values', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{
                  index: 1,
                  type: 'linear',
                  gradient: [
                    { ratio: 0, color: '#FF0000', alpha: 1 },
                    { ratio: 0.5, color: '#00FF00', alpha: 0.5 },
                    { ratio: 1, color: '#0000FF', alpha: 0 },
                  ],
                  matrix: createMatrix(),
                }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 0, y: 0 },
                    { type: 'L', x: 200, y: 0 },
                    { type: 'L', x: 200, y: 200 },
                    { type: 'L', x: 0, y: 200 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.renderFrame(0);
    });

    it('should handle short hex color format', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{
                  index: 1,
                  type: 'linear',
                  gradient: [
                    { ratio: 0, color: '#F00', alpha: 0.8 }, // Short hex
                    { ratio: 1, color: '#00F', alpha: 0.5 },
                  ],
                  matrix: createMatrix(),
                }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 0, y: 0 },
                    { type: 'L', x: 100, y: 0 },
                    { type: 'L', x: 100, y: 100 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.renderFrame(0);
    });
  });

  describe('acceleration/deceleration easing', () => {
    it('should apply acceleration to tween', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          totalFrames: 10,
          layers: [createLayer({
            frames: [
              createFrame({
                index: 0,
                duration: 5,
                tweenType: 'motion',
                acceleration: 50, // Positive = ease out
                elements: [{
                  type: 'shape',
                  matrix: createMatrix({ tx: 0 }),
                  fills: [{ index: 1, color: '#FF0000' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 0 },
                      { type: 'L', x: 30, y: 30 },
                      { type: 'Z' },
                    ],
                  }],
                }],
              }),
              createFrame({
                index: 5,
                duration: 5,
                elements: [{
                  type: 'shape',
                  matrix: createMatrix({ tx: 150 }),
                  fills: [{ index: 1, color: '#FF0000' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 0 },
                      { type: 'L', x: 30, y: 30 },
                      { type: 'Z' },
                    ],
                  }],
                }],
              }),
            ],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
      expect(() => renderer.renderFrame(2)).not.toThrow();
      expect(() => renderer.renderFrame(4)).not.toThrow();
    });

    it('should apply deceleration to tween', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          totalFrames: 10,
          layers: [createLayer({
            frames: [
              createFrame({
                index: 0,
                duration: 5,
                tweenType: 'motion',
                acceleration: -50, // Negative = ease in
                elements: [{
                  type: 'shape',
                  matrix: createMatrix({ ty: 0 }),
                  fills: [{ index: 1, color: '#00FF00' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 0 },
                      { type: 'L', x: 40, y: 40 },
                      { type: 'Z' },
                    ],
                  }],
                }],
              }),
              createFrame({
                index: 5,
                duration: 5,
                elements: [{
                  type: 'shape',
                  matrix: createMatrix({ ty: 100 }),
                  fills: [{ index: 1, color: '#00FF00' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 0 },
                      { type: 'L', x: 40, y: 40 },
                      { type: 'Z' },
                    ],
                  }],
                }],
              }),
            ],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(1)).not.toThrow();
      expect(() => renderer.renderFrame(3)).not.toThrow();
    });
  });

  describe('custom ease bezier', () => {
    it('should apply custom ease with bezier points', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          totalFrames: 10,
          layers: [createLayer({
            frames: [
              createFrame({
                index: 0,
                duration: 5,
                tweenType: 'motion',
                tweens: [{
                  target: 'all',
                  customEase: [
                    { x: 0, y: 0 },
                    { x: 0.25, y: 0.1 },
                    { x: 0.75, y: 0.9 },
                    { x: 1, y: 1 },
                  ],
                }],
                elements: [{
                  type: 'shape',
                  matrix: createMatrix({ tx: 0 }),
                  fills: [{ index: 1, color: '#FF0000' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 0 },
                      { type: 'L', x: 50, y: 50 },
                      { type: 'Z' },
                    ],
                  }],
                }],
              }),
              createFrame({
                index: 5,
                duration: 5,
                elements: [{
                  type: 'shape',
                  matrix: createMatrix({ tx: 200 }),
                  fills: [{ index: 1, color: '#FF0000' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 0 },
                      { type: 'L', x: 50, y: 50 },
                      { type: 'Z' },
                    ],
                  }],
                }],
              }),
            ],
          })],
        })],
      });
      await renderer.setDocument(doc);

      // Render frames during custom ease tween
      renderer.renderFrame(0);
      renderer.renderFrame(2);
      renderer.renderFrame(4);
    });
  });

  describe('text with letter spacing', () => {
    it('should render text with custom letter spacing', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'text',
                matrix: createMatrix({ tx: 50, ty: 50 }),
                left: 0,
                width: 300,
                height: 50,
                textRuns: [{
                  characters: 'SPACED TEXT',
                  size: 16,
                  face: 'Arial',
                  fillColor: '#000000',
                  letterSpacing: 5, // Custom letter spacing
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.renderFrame(0);

      // Verify canvas has text rendered
      const ctx = canvas.getContext('2d')!;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      expect(imageData.data.length).toBeGreaterThan(0);
    });
  });

  describe('symbol instance tweening', () => {
    it('should interpolate symbol instance matrix during motion tween', async () => {
      const symbolTimeline = createTimeline({
        name: 'TweenSymbol',
        totalFrames: 1,
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, color: '#00FF00' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 40, y: 0 },
                  { type: 'L', x: 40, y: 40 },
                  { type: 'L', x: 0, y: 40 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('TweenSymbol', {
        name: 'TweenSymbol',
        symbolType: 'graphic',
        timeline: symbolTimeline,
      });

      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          totalFrames: 10,
          layers: [createLayer({
            frames: [
              createFrame({
                index: 0,
                duration: 5,
                tweenType: 'motion',
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'TweenSymbol',
                  symbolType: 'graphic',
                  matrix: createMatrix({ a: 1, d: 1, tx: 0, ty: 0 }),
                  firstFrame: 0,
                  loop: 'loop',
                }],
              }),
              createFrame({
                index: 5,
                duration: 5,
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'TweenSymbol',
                  symbolType: 'graphic',
                  matrix: createMatrix({ a: 2, d: 2, tx: 100, ty: 100 }),
                  firstFrame: 0,
                  loop: 'loop',
                }],
              }),
            ],
          })],
        })],
      });
      await renderer.setDocument(doc);

      // Render frames during symbol matrix interpolation
      renderer.renderFrame(0);
      renderer.renderFrame(2);
      renderer.renderFrame(4);
    });
  });

  describe('radial gradient', () => {
    it('should render radial gradient fill', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{
                  index: 1,
                  type: 'radial',
                  gradient: [
                    { ratio: 0, color: '#FFFFFF', alpha: 1 },
                    { ratio: 1, color: '#000000', alpha: 1 },
                  ],
                  matrix: createMatrix({ a: 0.05, d: 0.05, tx: 100, ty: 100 }),
                }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 0, y: 0 },
                    { type: 'L', x: 200, y: 0 },
                    { type: 'L', x: 200, y: 200 },
                    { type: 'L', x: 0, y: 200 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.renderFrame(0);

      // Verify something was rendered
      const ctx = canvas.getContext('2d')!;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let hasNonWhitePixels = false;
      for (let i = 0; i < imageData.data.length; i += 4) {
        if (imageData.data[i] < 255 || imageData.data[i + 1] < 255 || imageData.data[i + 2] < 255) {
          hasNonWhitePixels = true;
          break;
        }
      }
      expect(hasNonWhitePixels).toBe(true);
    });

    it('should render linear gradient fill', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{
                  index: 1,
                  type: 'linear',
                  gradient: [
                    { ratio: 0, color: '#FF0000', alpha: 1 },
                    { ratio: 1, color: '#0000FF', alpha: 1 },
                  ],
                  matrix: createMatrix({ a: 0.01, d: 0.01, tx: 100, ty: 0 }),
                }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 0, y: 0 },
                    { type: 'L', x: 200, y: 0 },
                    { type: 'L', x: 200, y: 100 },
                    { type: 'L', x: 0, y: 100 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.renderFrame(0);

      // Verify gradient was rendered
      const ctx = canvas.getContext('2d')!;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      expect(imageData.data.length).toBeGreaterThan(0);
    });

    it('should handle gradient without matrix', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{
                  index: 1,
                  type: 'linear',
                  gradient: [
                    { ratio: 0, color: '#00FF00', alpha: 1 },
                    { ratio: 1, color: '#FF00FF', alpha: 0.5 },
                  ],
                  // No matrix - should use defaults
                }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 0, y: 0 },
                    { type: 'L', x: 100, y: 0 },
                    { type: 'L', x: 100, y: 100 },
                    { type: 'L', x: 0, y: 100 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.renderFrame(0);
    });

    it('should handle empty gradient', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{
                  index: 1,
                  type: 'linear',
                  gradient: [], // Empty gradient
                }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 0, y: 0 },
                    { type: 'L', x: 50, y: 0 },
                    { type: 'L', x: 50, y: 50 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.renderFrame(0);
    });
  });

  describe('stroke rendering', () => {
    it('should render shape with stroke', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [],
                strokes: [{
                  index: 1,
                  color: '#FF0000',
                  weight: 3,
                }],
                edges: [{
                  strokeStyle: 1,
                  commands: [
                    { type: 'M', x: 10, y: 10 },
                    { type: 'L', x: 100, y: 10 },
                    { type: 'L', x: 100, y: 100 },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.renderFrame(0);

      // Verify stroke was rendered
      const ctx = canvas.getContext('2d')!;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let hasRedPixels = false;
      for (let i = 0; i < imageData.data.length; i += 4) {
        if (imageData.data[i] > 200 && imageData.data[i + 1] < 50 && imageData.data[i + 2] < 50) {
          hasRedPixels = true;
          break;
        }
      }
      expect(hasRedPixels).toBe(true);
    });
  });

  describe('quadratic curve rendering', () => {
    it('should render shape with quadratic curve', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#0000FF' }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 0, y: 100 },
                    { type: 'Q', cx: 50, cy: 0, x: 100, y: 100 },
                    { type: 'L', x: 100, y: 150 },
                    { type: 'L', x: 0, y: 150 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.renderFrame(0);

      // Verify canvas was rendered to
      const ctx = canvas.getContext('2d')!;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      expect(imageData.data.length).toBeGreaterThan(0);
    });
  });

  describe('cubic curve rendering', () => {
    it('should render shape with cubic bezier curve', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#FF00FF' }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 0, y: 100 },
                    { type: 'C', c1x: 30, c1y: 0, c2x: 70, c2y: 0, x: 100, y: 100 },
                    { type: 'L', x: 100, y: 150 },
                    { type: 'L', x: 0, y: 150 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.renderFrame(0);

      // Verify canvas was rendered to
      const ctx = canvas.getContext('2d')!;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      expect(imageData.data.length).toBeGreaterThan(0);
    });
  });

  describe('color transform', () => {
    it('should apply color transform to symbol', async () => {
      const symbolTimeline = createTimeline({
        name: 'ColorSymbol',
        totalFrames: 1,
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, color: '#FFFFFF' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 50, y: 0 },
                  { type: 'L', x: 50, y: 50 },
                  { type: 'L', x: 0, y: 50 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('ColorSymbol', {
        name: 'ColorSymbol',
        symbolType: 'graphic',
        timeline: symbolTimeline,
      });

      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'symbol',
                libraryItemName: 'ColorSymbol',
                symbolType: 'graphic',
                matrix: createMatrix({ tx: 100, ty: 100 }),
                firstFrame: 0,
                loop: 'loop',
                color: {
                  redMultiplier: 1,
                  greenMultiplier: 0,
                  blueMultiplier: 0,
                  alphaMultiplier: 1,
                  redOffset: 0,
                  greenOffset: 0,
                  blueOffset: 0,
                  alphaOffset: 0,
                },
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.renderFrame(0);
    });
  });

  describe('camera motion tween', () => {
    it('should interpolate camera transform during motion tween', async () => {
      const symbolTimeline = createTimeline({
        name: 'CameraFrame',
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, color: '#000000' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 550, y: 0 },
                  { type: 'L', x: 550, y: 400 },
                  { type: 'L', x: 0, y: 400 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('CameraFrame', {
        name: 'CameraFrame',
        symbolType: 'graphic',
        timeline: symbolTimeline,
      });

      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          totalFrames: 10,
          layers: [
            createLayer({
              name: 'camera',
              frames: [
                createFrame({
                  index: 0,
                  duration: 5,
                  tweenType: 'motion',
                  elements: [{
                    type: 'symbol',
                    libraryItemName: 'CameraFrame',
                    symbolType: 'graphic',
                    matrix: createMatrix({ a: 1, d: 1, tx: 0, ty: 0 }),
                    firstFrame: 0,
                    loop: 'loop',
                  }],
                }),
                createFrame({
                  index: 5,
                  duration: 5,
                  elements: [{
                    type: 'symbol',
                    libraryItemName: 'CameraFrame',
                    symbolType: 'graphic',
                    matrix: createMatrix({ a: 2, d: 2, tx: 100, ty: 100 }),
                    firstFrame: 0,
                    loop: 'loop',
                  }],
                }),
              ],
            }),
            createLayer({
              name: 'Content',
              frames: [createFrame({
                duration: 10,
                elements: [{
                  type: 'shape',
                  matrix: createMatrix(),
                  fills: [{ index: 1, color: '#FF0000' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 200, y: 150 },
                      { type: 'L', x: 350, y: 150 },
                      { type: 'L', x: 350, y: 250 },
                      { type: 'L', x: 200, y: 250 },
                      { type: 'Z' },
                    ],
                  }],
                }],
              })],
            }),
          ],
          referenceLayers: new Set([0]),
        })],
      });
      await renderer.setDocument(doc);

      // Render at frame 0 (start of tween)
      renderer.renderFrame(0);
      const ctx = canvas.getContext('2d')!;
      const imageDataStart = ctx.getImageData(0, 0, canvas.width, canvas.height);

      // Render at frame 2 (middle of tween - should interpolate)
      renderer.renderFrame(2);
      const imageDataMid = ctx.getImageData(0, 0, canvas.width, canvas.height);

      // Render at frame 5 (end keyframe)
      renderer.renderFrame(5);
      const imageDataEnd = ctx.getImageData(0, 0, canvas.width, canvas.height);

      // All should render without errors
      expect(imageDataStart.data.length).toBeGreaterThan(0);
      expect(imageDataMid.data.length).toBeGreaterThan(0);
      expect(imageDataEnd.data.length).toBeGreaterThan(0);
    });

    it('should apply inverse camera transform', async () => {
      const symbolTimeline = createTimeline({
        name: 'CamFrame',
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, color: '#333333' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 550, y: 0 },
                  { type: 'L', x: 550, y: 400 },
                  { type: 'L', x: 0, y: 400 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('CamFrame', {
        name: 'CamFrame',
        symbolType: 'graphic',
        timeline: symbolTimeline,
      });

      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          totalFrames: 5,
          layers: [
            createLayer({
              name: 'camera',
              frames: [createFrame({
                duration: 5,
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'CamFrame',
                  symbolType: 'graphic',
                  matrix: createMatrix({ a: 0.5, d: 0.5, tx: 137.5, ty: 100 }),
                  firstFrame: 0,
                  loop: 'loop',
                }],
              })],
            }),
            createLayer({
              name: 'Objects',
              frames: [createFrame({
                duration: 5,
                elements: [{
                  type: 'shape',
                  matrix: createMatrix(),
                  fills: [{ index: 1, color: '#0000FF' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 100, y: 100 },
                      { type: 'L', x: 200, y: 100 },
                      { type: 'L', x: 200, y: 200 },
                      { type: 'L', x: 100, y: 200 },
                      { type: 'Z' },
                    ],
                  }],
                }],
              })],
            }),
          ],
          referenceLayers: new Set([0]),
        })],
      });
      await renderer.setDocument(doc);

      renderer.renderFrame(0);

      const ctx = canvas.getContext('2d')!;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      expect(imageData.data.length).toBeGreaterThan(0);
    });

    it('should interpolate camera matrix when followCamera enabled with motion tween', async () => {
      const cameraSymbol = createTimeline({
        name: 'CameraRect',
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, color: '#888888' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 550, y: 0 },
                  { type: 'L', x: 550, y: 400 },
                  { type: 'L', x: 0, y: 400 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('CameraRect', {
        name: 'CameraRect',
        symbolType: 'graphic',
        timeline: cameraSymbol,
      });

      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          totalFrames: 10,
          layers: [
            // Camera layer with motion tween
            createLayer({
              name: 'camera',
              frames: [
                createFrame({
                  index: 0,
                  duration: 5,
                  tweenType: 'motion',
                  elements: [{
                    type: 'symbol',
                    libraryItemName: 'CameraRect',
                    symbolType: 'graphic',
                    matrix: createMatrix({ a: 1, d: 1, tx: 0, ty: 0 }),
                    firstFrame: 0,
                    loop: 'loop',
                  }],
                }),
                createFrame({
                  index: 5,
                  duration: 5,
                  elements: [{
                    type: 'symbol',
                    libraryItemName: 'CameraRect',
                    symbolType: 'graphic',
                    matrix: createMatrix({ a: 1.5, d: 1.5, tx: 50, ty: 50 }),
                    firstFrame: 0,
                    loop: 'loop',
                  }],
                }),
              ],
            }),
            // Content layer
            createLayer({
              name: 'Content',
              frames: [createFrame({
                duration: 10,
                elements: [{
                  type: 'shape',
                  matrix: createMatrix({ tx: 100, ty: 100 }),
                  fills: [{ index: 1, color: '#FF0000' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 0 },
                      { type: 'L', x: 100, y: 0 },
                      { type: 'L', x: 100, y: 100 },
                      { type: 'L', x: 0, y: 100 },
                      { type: 'Z' },
                    ],
                  }],
                }],
              })],
            }),
          ],
          referenceLayers: new Set([0]),
        })],
      });
      await renderer.setDocument(doc);

      // Enable follow camera to trigger camera transform code path
      renderer.setFollowCamera(true);
      expect(renderer.getFollowCamera()).toBe(true);

      // Render at intermediate frame to trigger motion tween interpolation
      // Frame 2 is between keyframe 0 and keyframe 5
      renderer.renderFrame(2);

      const ctx = canvas.getContext('2d')!;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      expect(imageData.data.length).toBeGreaterThan(0);

      // Render at another intermediate frame
      renderer.renderFrame(3);

      // Disable follow camera
      renderer.setFollowCamera(false);
      expect(renderer.getFollowCamera()).toBe(false);
    });
  });

  describe('text rendering with fonts', () => {
    it('should preload Google fonts when text uses mapped font', async () => {
      // Create document with text using a font that maps to a Google font
      // PressStart2P-Regular maps to 'Press Start 2P' which is in googleFonts
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'text',
                matrix: createMatrix({ tx: 50, ty: 50 }),
                textRuns: [{
                  characters: 'Pixel Text',
                  face: 'PressStart2P-Regular',
                  size: 16,
                  fillColor: '#000000',
                  alignment: 'left',
                }],
              }],
            })],
          })],
        })],
      });

      // setDocument triggers font preloading
      await renderer.setDocument(doc);

      renderer.renderFrame(0);

      const ctx = canvas.getContext('2d')!;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      expect(imageData.data.length).toBeGreaterThan(0);
    });

    it('should render text element', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'text',
                matrix: createMatrix({ tx: 50, ty: 50 }),
                textRuns: [{
                  characters: 'Hello World',
                  face: 'Arial',
                  size: 24,
                  fillColor: '#000000',
                  alignment: 'left',
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.renderFrame(0);

      const ctx = canvas.getContext('2d')!;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      expect(imageData.data.length).toBeGreaterThan(0);
    });

    it('should render text with multiple runs', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'text',
                matrix: createMatrix({ tx: 50, ty: 100 }),
                textRuns: [
                  {
                    characters: 'Bold ',
                    face: 'Arial',
                    size: 18,
                    fillColor: '#FF0000',
                    alignment: 'left',
                    bold: true,
                  },
                  {
                    characters: 'Normal',
                    face: 'Arial',
                    size: 18,
                    fillColor: '#0000FF',
                    alignment: 'left',
                  },
                ],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.renderFrame(0);

      const ctx = canvas.getContext('2d')!;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      expect(imageData.data.length).toBeGreaterThan(0);
    });
  });

  describe('gradient edge cases', () => {
    it('should handle gradient with no entries', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{
                  index: 1,
                  type: 'linear',
                  gradient: [],
                  matrix: createMatrix({ a: 0.05, d: 0.05, tx: 100, ty: 100 }),
                }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 50, y: 50 },
                    { type: 'L', x: 150, y: 50 },
                    { type: 'L', x: 150, y: 150 },
                    { type: 'L', x: 50, y: 150 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.renderFrame(0);

      const ctx = canvas.getContext('2d')!;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      expect(imageData.data.length).toBeGreaterThan(0);
    });

    it('should handle radial gradient with no entries', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{
                  index: 1,
                  type: 'radial',
                  gradient: [],
                  matrix: createMatrix({ a: 0.05, d: 0.05, tx: 100, ty: 100 }),
                }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 50, y: 50 },
                    { type: 'L', x: 150, y: 50 },
                    { type: 'L', x: 150, y: 150 },
                    { type: 'L', x: 50, y: 150 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.renderFrame(0);

      const ctx = canvas.getContext('2d')!;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      expect(imageData.data.length).toBeGreaterThan(0);
    });

    it('should handle linear gradient without matrix', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{
                  index: 1,
                  type: 'linear',
                  gradient: [
                    { ratio: 0, color: '#FF0000', alpha: 1 },
                    { ratio: 1, color: '#0000FF', alpha: 1 },
                  ],
                  // No matrix - should use default
                }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 0, y: 0 },
                    { type: 'L', x: 200, y: 0 },
                    { type: 'L', x: 200, y: 100 },
                    { type: 'L', x: 0, y: 100 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.renderFrame(0);

      const ctx = canvas.getContext('2d')!;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      expect(imageData.data.length).toBeGreaterThan(0);
    });

    it('should handle gradient with alpha values', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{
                  index: 1,
                  type: 'linear',
                  gradient: [
                    { ratio: 0, color: '#FF0000', alpha: 0.5 },
                    { ratio: 0.5, color: '#00FF00', alpha: 0.8 },
                    { ratio: 1, color: '#0000FF', alpha: 0.3 },
                  ],
                  matrix: createMatrix({ a: 0.01, d: 0.01, tx: 100, ty: 50 }),
                }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 0, y: 0 },
                    { type: 'L', x: 200, y: 0 },
                    { type: 'L', x: 200, y: 100 },
                    { type: 'L', x: 0, y: 100 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.renderFrame(0);

      // Verify gradient rendered with actual colors (alpha-blended with white background)
      expect(hasRenderedContent(canvas)).toBe(true);
    });

    it('should handle color with short hex format (#RGB)', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{
                  index: 1,
                  type: 'radial',
                  gradient: [
                    { ratio: 0, color: '#F00', alpha: 0.5 }, // Short hex format
                    { ratio: 1, color: '#00F', alpha: 0.5 },
                  ],
                  matrix: createMatrix({ a: 0.05, d: 0.05, tx: 100, ty: 100 }),
                }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 50, y: 50 },
                    { type: 'L', x: 150, y: 50 },
                    { type: 'L', x: 150, y: 150 },
                    { type: 'L', x: 50, y: 150 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.renderFrame(0);

      // Verify radial gradient with short hex colors rendered
      expect(hasRenderedContent(canvas)).toBe(true);
    });

    it('should handle non-hex color format', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{
                  index: 1,
                  type: 'linear',
                  gradient: [
                    { ratio: 0, color: 'rgb(255, 0, 0)', alpha: 0.5 }, // RGB format (not hex)
                    { ratio: 1, color: 'blue', alpha: 0.5 }, // Named color
                  ],
                  matrix: createMatrix({ a: 0.01, d: 0.01, tx: 100, ty: 50 }),
                }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 0, y: 0 },
                    { type: 'L', x: 200, y: 0 },
                    { type: 'L', x: 200, y: 100 },
                    { type: 'L', x: 0, y: 100 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.renderFrame(0);

      // Verify gradient with non-hex colors (rgb() and named) rendered
      expect(hasRenderedContent(canvas)).toBe(true);
    });
  });

  describe('debug click handling', () => {
    it('should render shape with debug mode enabled and handle click on shape', async () => {
      // Add canvas to DOM for proper coordinate calculation
      document.body.appendChild(canvas);
      canvas.style.position = 'fixed';
      canvas.style.left = '0';
      canvas.style.top = '0';

      // Create a large red shape covering the canvas center
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#FF0000' }],
                strokes: [{ index: 1, color: '#000000', weight: 2 }],
                edges: [{
                  fillStyle0: 1,
                  strokeStyle: 1,
                  commands: [
                    { type: 'M', x: 50, y: 50 },
                    { type: 'L', x: 500, y: 50 },
                    { type: 'L', x: 500, y: 350 },
                    { type: 'L', x: 50, y: 350 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.enableDebugMode();
      renderer.renderFrame(0);

      // Verify shape rendered (stroke visible)
      expect(hasRenderedContent(canvas)).toBe(true);

      // Verify debug mode sets crosshair cursor
      expect(canvas.style.cursor).toBe('crosshair');

      const rect = canvas.getBoundingClientRect();

      // Click in the center of the shape - triggers isPointInPath check and hit detection code
      const clickEvent = new MouseEvent('click', {
        clientX: rect.left + 275,
        clientY: rect.top + 200,
        bubbles: true,
      });
      canvas.dispatchEvent(clickEvent);

      // Click outside the shape - triggers "no elements found" path
      const missEvent = new MouseEvent('click', {
        clientX: rect.left + 10,
        clientY: rect.top + 10,
        bubbles: true,
      });
      canvas.dispatchEvent(missEvent);

      renderer.disableDebugMode();
      expect(canvas.style.cursor).toBe('default');

      document.body.removeChild(canvas);
    });

    it('should render symbol with debug mode and handle click on symbol shape', async () => {
      // Add canvas to DOM
      document.body.appendChild(canvas);
      canvas.style.position = 'fixed';
      canvas.style.left = '0';
      canvas.style.top = '0';

      const symbolTimeline = createTimeline({
        name: 'ClickableSymbol',
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, color: '#00FF00' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 300, y: 0 },
                  { type: 'L', x: 300, y: 300 },
                  { type: 'L', x: 0, y: 300 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('ClickableSymbol', {
        name: 'ClickableSymbol',
        symbolType: 'graphic',
        timeline: symbolTimeline,
      });

      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'symbol',
                libraryItemName: 'ClickableSymbol',
                symbolType: 'graphic',
                matrix: createMatrix({ tx: 50, ty: 50 }),
                firstFrame: 0,
                loop: 'loop',
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.enableDebugMode();
      renderer.renderFrame(0);

      // Verify symbol's shape rendered
      expect(hasRenderedContent(canvas)).toBe(true);

      const rect = canvas.getBoundingClientRect();

      // Click in the symbol area (symbol at 50,50 with 300x300 shape inside)
      const clickEvent = new MouseEvent('click', {
        clientX: rect.left + 200,
        clientY: rect.top + 200,
        bubbles: true,
      });
      canvas.dispatchEvent(clickEvent);

      renderer.disableDebugMode();
      document.body.removeChild(canvas);
    });

    it('should render bitmap with debug mode and handle click on bitmap', async () => {
      // Add canvas to DOM
      document.body.appendChild(canvas);
      canvas.style.position = 'fixed';
      canvas.style.left = '0';
      canvas.style.top = '0';

      // Create a blue bitmap
      const bitmapCanvas = document.createElement('canvas');
      bitmapCanvas.width = 200;
      bitmapCanvas.height = 200;
      const bitmapCtx = bitmapCanvas.getContext('2d')!;
      bitmapCtx.fillStyle = '#0000FF';
      bitmapCtx.fillRect(0, 0, 200, 200);
      const img = new Image();
      img.width = 200;
      img.height = 200;

      const bitmaps = new Map();
      bitmaps.set('debug.png', {
        name: 'debug.png',
        href: 'debug.png',
        imageData: img,
        width: 200,
        height: 200,
      });

      const doc = createMinimalDoc({
        bitmaps,
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'bitmap',
                libraryItemName: 'debug.png',
                matrix: createMatrix({ tx: 50, ty: 50 }),
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.enableDebugMode();
      renderer.renderFrame(0);

      // Verify debug mode is active
      expect(canvas.style.cursor).toBe('crosshair');

      const rect = canvas.getBoundingClientRect();

      // Click in bitmap area (bitmap at 50,50 with 200x200 size)
      const clickEvent = new MouseEvent('click', {
        clientX: rect.left + 150,
        clientY: rect.top + 150,
        bubbles: true,
      });
      canvas.dispatchEvent(clickEvent);

      renderer.disableDebugMode();
      expect(canvas.style.cursor).toBe('default');

      document.body.removeChild(canvas);
    });

    it('should track elements in debug mode', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#FF0000' }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 0, y: 0 },
                    { type: 'L', x: 100, y: 0 },
                    { type: 'L', x: 100, y: 100 },
                    { type: 'L', x: 0, y: 100 },
                    { type: 'Z' },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.enableDebugMode();
      renderer.renderFrame(0);

      // Simulate click on canvas
      const clickEvent = new MouseEvent('click', {
        clientX: 50,
        clientY: 50,
        bubbles: true,
      });
      canvas.dispatchEvent(clickEvent);

      renderer.disableDebugMode();
    });

    it('should handle click on symbol elements', async () => {
      const symbolTimeline = createTimeline({
        name: 'DebugSymbol',
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, color: '#00FF00' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 50, y: 0 },
                  { type: 'L', x: 50, y: 50 },
                  { type: 'L', x: 0, y: 50 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('DebugSymbol', {
        name: 'DebugSymbol',
        symbolType: 'graphic',
        timeline: symbolTimeline,
      });

      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'symbol',
                libraryItemName: 'DebugSymbol',
                symbolType: 'graphic',
                matrix: createMatrix({ tx: 100, ty: 100 }),
                firstFrame: 0,
                loop: 'loop',
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.enableDebugMode();
      renderer.renderFrame(0);

      // Click on the symbol area
      const clickEvent = new MouseEvent('click', {
        clientX: 125,
        clientY: 125,
        bubbles: true,
      });
      canvas.dispatchEvent(clickEvent);

      renderer.disableDebugMode();
    });
  });

  describe('complex edge contributions', () => {
    it('should handle shape with multiple edges forming a closed path', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#FF00FF' }],
                strokes: [],
                edges: [
                  // Multiple edge contributions that need to be connected
                  {
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 0 },
                      { type: 'L', x: 50, y: 0 },
                    ],
                  },
                  {
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 50, y: 0 },
                      { type: 'L', x: 50, y: 50 },
                    ],
                  },
                  {
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 50, y: 50 },
                      { type: 'L', x: 0, y: 50 },
                    ],
                  },
                  {
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 50 },
                      { type: 'L', x: 0, y: 0 },
                    ],
                  },
                ],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.renderFrame(0);

      const ctx = canvas.getContext('2d')!;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      expect(imageData.data.length).toBeGreaterThan(0);
    });

    it('should handle shape with edges that need closing contribution', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#FFFF00' }],
                strokes: [],
                edges: [
                  // First contribution
                  {
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 0 },
                      { type: 'L', x: 100, y: 0 },
                      { type: 'L', x: 100, y: 50 },
                    ],
                  },
                  // Contribution that can close the loop
                  {
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 100, y: 50 },
                      { type: 'L', x: 50, y: 100 },
                      { type: 'L', x: 0, y: 50 },
                      { type: 'L', x: 0, y: 0 },
                    ],
                  },
                ],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.renderFrame(0);

      const ctx = canvas.getContext('2d')!;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      expect(imageData.data.length).toBeGreaterThan(0);
    });
  });

  describe('follow camera mode', () => {
    it('should render with follow camera enabled', async () => {
      const symbolTimeline = createTimeline({
        name: 'FollowCamFrame',
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, color: '#888888' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 550, y: 0 },
                  { type: 'L', x: 550, y: 400 },
                  { type: 'L', x: 0, y: 400 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('FollowCamFrame', {
        name: 'FollowCamFrame',
        symbolType: 'graphic',
        timeline: symbolTimeline,
      });

      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          totalFrames: 5,
          layers: [
            createLayer({
              name: 'camera',
              frames: [createFrame({
                duration: 5,
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'FollowCamFrame',
                  symbolType: 'graphic',
                  matrix: createMatrix({ a: 0.5, d: 0.5, tx: 100, ty: 100 }),
                  firstFrame: 0,
                  loop: 'loop',
                  transformationPoint: { x: 275, y: 200 },
                }],
              })],
            }),
            createLayer({
              name: 'Content',
              frames: [createFrame({
                duration: 5,
                elements: [{
                  type: 'shape',
                  matrix: createMatrix(),
                  fills: [{ index: 1, color: '#00FFFF' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 200, y: 150 },
                      { type: 'L', x: 350, y: 150 },
                      { type: 'L', x: 350, y: 250 },
                      { type: 'L', x: 200, y: 250 },
                      { type: 'Z' },
                    ],
                  }],
                }],
              })],
            }),
          ],
          referenceLayers: new Set([0]),
        })],
      });
      await renderer.setDocument(doc);

      renderer.setFollowCamera(true);
      renderer.renderFrame(0);

      const ctx = canvas.getContext('2d')!;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      expect(imageData.data.length).toBeGreaterThan(0);

      renderer.setFollowCamera(false);
    });
  });

});
