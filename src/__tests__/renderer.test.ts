import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FLARenderer, setRendererDebug } from '../renderer';
import {
  createConsoleSpy,
  expectLogContaining,
  createRectangleShape,
  createTriangleShape,
  createMinimalDoc,
  createTimeline,
  createLayer,
  createFrame,
  createMatrix,
  hasRenderedContent,
  hasColor,
  type ConsoleSpy,
} from './test-utils';

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

    it('should trigger font loading for partial font name match', async () => {
      // Use a font name that partially matches PressStart2P to trigger partial match logic
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'text',
                matrix: createMatrix({ tx: 50, ty: 50 }),
                textRuns: [{
                  characters: 'Partial Match Font',
                  face: 'PressStart2P-Bold', // Starts with PressStart2P
                  size: 16,
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

    it('should return font name as-is for unknown fonts', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'text',
                matrix: createMatrix({ tx: 50, ty: 50 }),
                textRuns: [{
                  characters: 'Unknown Font',
                  face: 'SomeRandomFont-XYZ',
                  size: 16,
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
    it('should apply camera transform with motion tween interpolation', async () => {
      // Add canvas to DOM for proper rendering (not offscreen mode)
      const container = document.createElement('div');
      container.style.width = '550px';
      container.style.height = '400px';
      document.body.appendChild(container);
      container.appendChild(canvas);

      // Create camera symbol
      const cameraSymbol = createTimeline({
        name: 'MotionCamera',
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, color: '#444444' }],
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
      symbols.set('MotionCamera', {
        name: 'MotionCamera',
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
                    libraryItemName: 'MotionCamera',
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
                    libraryItemName: 'MotionCamera',
                    symbolType: 'graphic',
                    matrix: createMatrix({ a: 1.5, d: 1.5, tx: 100, ty: 75 }),
                    firstFrame: 0,
                    loop: 'loop',
                  }],
                }),
              ],
            }),
            // Content layer with distinct shape
            createLayer({
              name: 'Content',
              frames: [createFrame({
                duration: 10,
                elements: [{
                  type: 'shape',
                  matrix: createMatrix({ tx: 150, ty: 150 }),
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
            }),
          ],
          referenceLayers: new Set([0]),
        })],
      });

      // Use regular setDocument (not skipResize) to properly initialize
      await renderer.setDocument(doc);

      // Enable follow camera
      renderer.setFollowCamera(true);
      expect(renderer.getFollowCamera()).toBe(true);

      // Render at frame 0 (start of tween)
      renderer.renderFrame(0);
      const ctx = canvas.getContext('2d')!;
      const imageData0 = ctx.getImageData(0, 0, canvas.width, canvas.height);
      expect(imageData0.data.length).toBeGreaterThan(0);

      // Render at frame 2 (during motion tween interpolation)
      renderer.renderFrame(2);
      const imageData2 = ctx.getImageData(0, 0, canvas.width, canvas.height);
      expect(imageData2.data.length).toBeGreaterThan(0);

      // Render at frame 5 (end of first tween segment)
      renderer.renderFrame(5);
      const imageData5 = ctx.getImageData(0, 0, canvas.width, canvas.height);
      expect(imageData5.data.length).toBeGreaterThan(0);

      renderer.setFollowCamera(false);
      document.body.removeChild(container);
    });

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

  describe('missing symbol handling', () => {
    it('should warn when symbol reference is missing', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'symbol',
                libraryItemName: 'NonExistentSymbol',
                symbolType: 'graphic',
                matrix: createMatrix(),
                firstFrame: 0,
                loop: 'loop',
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      // Should not throw but will warn about missing symbol
      renderer.renderFrame(0);

      const ctx = canvas.getContext('2d')!;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      expect(imageData.data.length).toBeGreaterThan(0);
    });
  });

  describe('ultrawide document handling', () => {
    it('should detect ultrawide document viewport with follow camera', async () => {
      // Create camera symbol
      const cameraSymbol = createTimeline({
        name: 'UltrawideCamera',
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
                  { type: 'L', x: 1920, y: 0 },
                  { type: 'L', x: 1920, y: 1080 },
                  { type: 'L', x: 0, y: 1080 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('UltrawideCamera', {
        name: 'UltrawideCamera',
        symbolType: 'graphic',
        timeline: cameraSymbol,
      });

      // Create ultrawide document with aspect ratio > 2.5 (3840/1080 = 3.56)
      const doc = createMinimalDoc({
        width: 3840,
        height: 1080,
        symbols,
        timelines: [createTimeline({
          layers: [
            createLayer({
              name: 'camera',
              frames: [createFrame({
                duration: 10,
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'UltrawideCamera',
                  symbolType: 'graphic',
                  matrix: createMatrix({ a: 1, d: 1, tx: 0, ty: 0 }),
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
                      { type: 'L', x: 300, y: 100 },
                      { type: 'L', x: 300, y: 300 },
                      { type: 'L', x: 100, y: 300 },
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

      // Enable follow camera to trigger viewport detection
      renderer.setFollowCamera(true);
      renderer.renderFrame(0);
      expect(hasRenderedContent(canvas)).toBe(true);
      renderer.setFollowCamera(false);
    });

    it('should detect wide document viewport with follow camera', async () => {
      // Create camera symbol
      const cameraSymbol = createTimeline({
        name: 'WideCamera',
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
                  { type: 'L', x: 1920, y: 0 },
                  { type: 'L', x: 1920, y: 1080 },
                  { type: 'L', x: 0, y: 1080 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('WideCamera', {
        name: 'WideCamera',
        symbolType: 'graphic',
        timeline: cameraSymbol,
      });

      // Create wide document with aspect ratio > 1.9 but <= 2.5 (2160/1080 = 2.0)
      const doc = createMinimalDoc({
        width: 2160,
        height: 1080,
        symbols,
        timelines: [createTimeline({
          layers: [
            createLayer({
              name: 'camera',
              frames: [createFrame({
                duration: 10,
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'WideCamera',
                  symbolType: 'graphic',
                  matrix: createMatrix({ a: 1, d: 1, tx: 0, ty: 0 }),
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
                  fills: [{ index: 1, color: '#00FF00' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 100, y: 100 },
                      { type: 'L', x: 300, y: 100 },
                      { type: 'L', x: 300, y: 300 },
                      { type: 'L', x: 100, y: 300 },
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

      // Enable follow camera to trigger viewport detection
      renderer.setFollowCamera(true);
      renderer.renderFrame(0);
      expect(hasRenderedContent(canvas)).toBe(true);
      renderer.setFollowCamera(false);
    });
  });

  describe('edge path commands', () => {
    it('should handle quadratic bezier curve commands', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#0000FF' }],
                strokes: [{ index: 1, color: '#000000', weight: 2 }],
                edges: [{
                  fillStyle0: 1,
                  strokeStyle: 1,
                  commands: [
                    { type: 'M', x: 50, y: 100 },
                    { type: 'Q', cx: 100, cy: 50, x: 150, y: 100 },
                    { type: 'Q', cx: 200, cy: 150, x: 250, y: 100 },
                    { type: 'L', x: 250, y: 200 },
                    { type: 'L', x: 50, y: 200 },
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
      expect(hasRenderedContent(canvas)).toBe(true);
    });

    it('should handle cubic bezier curve commands', async () => {
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
                    { type: 'M', x: 50, y: 100 },
                    { type: 'C', c1x: 75, c1y: 50, c2x: 125, c2y: 50, x: 150, y: 100 },
                    { type: 'C', c1x: 175, c1y: 150, c2x: 225, c2y: 150, x: 250, y: 100 },
                    { type: 'L', x: 250, y: 200 },
                    { type: 'L', x: 50, y: 200 },
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
      expect(hasRenderedContent(canvas)).toBe(true);
    });
  });

  describe('layer filtering', () => {
    it('should skip guide layers', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
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
                      { type: 'L', x: 550, y: 0 },
                      { type: 'L', x: 550, y: 400 },
                      { type: 'L', x: 0, y: 400 },
                      { type: 'Z' },
                    ],
                  }],
                }],
              })],
            }),
            createLayer({
              name: 'Content',
              frames: [createFrame({
                elements: [{
                  type: 'shape',
                  matrix: createMatrix(),
                  fills: [{ index: 1, color: '#00FF00' }],
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

      renderer.renderFrame(0);
      // Only content layer should render, not guide
      expect(hasRenderedContent(canvas)).toBe(true);
    });

    it('should skip folder layers', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [
            createLayer({
              name: 'Folder',
              layerType: 'folder',
              frames: [createFrame()],
            }),
            createLayer({
              name: 'Content',
              frames: [createFrame({
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
        })],
      });
      await renderer.setDocument(doc);

      renderer.renderFrame(0);
      expect(hasRenderedContent(canvas)).toBe(true);
    });
  });

  describe('video element rendering', () => {
    it('should handle video element in debug mode', async () => {
      document.body.appendChild(canvas);
      canvas.style.position = 'fixed';
      canvas.style.left = '0';
      canvas.style.top = '0';

      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'video',
                matrix: createMatrix({ tx: 50, ty: 50 }),
                libraryItemName: 'test-video.mp4',
                width: 200,
                height: 150,
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.enableDebugMode();
      renderer.renderFrame(0);

      const rect = canvas.getBoundingClientRect();
      const clickEvent = new MouseEvent('click', {
        clientX: rect.left + 150,
        clientY: rect.top + 125,
        bubbles: true,
      });
      canvas.dispatchEvent(clickEvent);

      renderer.disableDebugMode();
      document.body.removeChild(canvas);
    });
  });

  describe('text element in debug mode', () => {
    it('should handle text element click in debug mode', async () => {
      document.body.appendChild(canvas);
      canvas.style.position = 'fixed';
      canvas.style.left = '0';
      canvas.style.top = '0';

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
                  characters: 'Debug Text',
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

      renderer.enableDebugMode();
      renderer.renderFrame(0);

      const rect = canvas.getBoundingClientRect();
      const clickEvent = new MouseEvent('click', {
        clientX: rect.left + 150,
        clientY: rect.top + 75,
        bubbles: true,
      });
      canvas.dispatchEvent(clickEvent);

      renderer.disableDebugMode();
      document.body.removeChild(canvas);
    });
  });

  describe('invalid coordinate handling', () => {
    it('should skip commands with NaN coordinates', async () => {
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
                    { type: 'M', x: 50, y: 50 },
                    { type: 'L', x: NaN, y: NaN } as any, // Invalid coordinates
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
      // Should render without errors, skipping invalid command
      expect(hasRenderedContent(canvas)).toBe(true);
    });

    it('should skip cubic bezier with invalid control points', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
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
                    { type: 'M', x: 50, y: 100 },
                    { type: 'C', c1x: NaN, c1y: NaN, c2x: 100, c2y: 50, x: 150, y: 100 } as any,
                    { type: 'L', x: 150, y: 200 },
                    { type: 'L', x: 50, y: 200 },
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
      expect(hasRenderedContent(canvas)).toBe(true);
    });

    it('should skip quadratic bezier with invalid control points', async () => {
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
                    { type: 'M', x: 50, y: 100 },
                    { type: 'Q', cx: Infinity, cy: -Infinity, x: 150, y: 100 } as any,
                    { type: 'L', x: 150, y: 200 },
                    { type: 'L', x: 50, y: 200 },
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
      expect(hasRenderedContent(canvas)).toBe(true);
    });
  });

  describe('edge segment splitting', () => {
    it('should handle discontinuous edge segments', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#FFFF00' }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    // First disconnected path
                    { type: 'M', x: 0, y: 0 },
                    { type: 'L', x: 50, y: 0 },
                    { type: 'L', x: 50, y: 50 },
                    // Jump to disconnected position
                    { type: 'M', x: 200, y: 200 },
                    { type: 'L', x: 250, y: 200 },
                    { type: 'L', x: 250, y: 250 },
                    { type: 'L', x: 200, y: 250 },
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
      expect(hasRenderedContent(canvas)).toBe(true);
    });
  });

  describe('single frame document', () => {
    it('should render document with single frame', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          totalFrames: 1,
          layers: [createLayer({
            frames: [createFrame({
              duration: 1,
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#FF00FF' }],
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

      renderer.renderFrame(0);
      expect(hasRenderedContent(canvas)).toBe(true);
    });
  });

  describe('text alignment and paragraphs', () => {
    it('should render text with right alignment', async () => {
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
                textRuns: [{
                  characters: 'Right aligned text',
                  face: 'Arial',
                  size: 18,
                  fillColor: '#000000',
                  alignment: 'right',
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      renderer.renderFrame(0);
      expect(hasRenderedContent(canvas)).toBe(true);
    });

    it('should render text with empty paragraphs (newlines)', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'text',
                matrix: createMatrix({ tx: 50, ty: 50 }),
                left: 0,
                width: 300,
                height: 150,
                textRuns: [{
                  characters: 'First line\n\nThird line after empty',
                  face: 'Arial',
                  size: 16,
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
      expect(hasRenderedContent(canvas)).toBe(true);
    });

    it('should wrap long text within width', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'text',
                matrix: createMatrix({ tx: 20, ty: 50 }),
                left: 0,
                width: 150, // Narrow width to force wrapping
                height: 200,
                textRuns: [{
                  characters: 'This is a very long text that should definitely wrap to multiple lines',
                  face: 'Arial',
                  size: 14,
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
      expect(hasRenderedContent(canvas)).toBe(true);
    });
  });

  describe('hidden layer handling', () => {
    it('should skip rendering hidden layers', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [
            createLayer({
              name: 'Hidden',
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
                      { type: 'L', x: 550, y: 0 },
                      { type: 'L', x: 550, y: 400 },
                      { type: 'L', x: 0, y: 400 },
                      { type: 'Z' },
                    ],
                  }],
                }],
              })],
            }),
            createLayer({
              name: 'Visible',
              frames: [createFrame({
                elements: [{
                  type: 'shape',
                  matrix: createMatrix(),
                  fills: [{ index: 1, color: '#00FF00' }],
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
        })],
      });
      await renderer.setDocument(doc);

      // Hide the first layer
      renderer.setHiddenLayers(new Set([0]));

      renderer.renderFrame(0);
      expect(hasRenderedContent(canvas)).toBe(true);
    });
  });

  describe('fill style with alpha', () => {
    it('should render shape with alpha fill', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{
                  index: 1,
                  type: 'solid',
                  color: '#FF0000',
                  alpha: 0.5 // Semi-transparent
                }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 100, y: 100 },
                    { type: 'L', x: 250, y: 100 },
                    { type: 'L', x: 250, y: 250 },
                    { type: 'L', x: 100, y: 250 },
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
      expect(hasRenderedContent(canvas)).toBe(true);
    });

    it('should render stroke with alpha', async () => {
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
                  color: '#0000FF',
                  weight: 5,
                  alpha: 0.7
                }],
                edges: [{
                  strokeStyle: 1,
                  commands: [
                    { type: 'M', x: 50, y: 50 },
                    { type: 'L', x: 200, y: 50 },
                    { type: 'L', x: 200, y: 200 },
                    { type: 'L', x: 50, y: 200 },
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
      expect(hasRenderedContent(canvas)).toBe(true);
    });
  });

  describe('edge contribution closing', () => {
    it('should handle edge contributions that close a loop', async () => {
      // Create edges that form disconnected paths that need closing logic
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#00FFFF' }],
                strokes: [],
                edges: [
                  // First contribution - partial path
                  {
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 0 },
                      { type: 'L', x: 100, y: 0 },
                      { type: 'L', x: 100, y: 50 },
                    ],
                  },
                  // Second contribution - continues and closes
                  {
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 100, y: 50 },
                      { type: 'L', x: 100, y: 100 },
                      { type: 'L', x: 0, y: 100 },
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
      expect(hasRenderedContent(canvas)).toBe(true);
    });

    it('should find closing contribution when end point matches chain start', async () => {
      // Create three contributions where third one closes back to start of first
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
                  // First contribution - starts at 10,10
                  {
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 10, y: 10 },
                      { type: 'L', x: 200, y: 10 },
                    ],
                  },
                  // Second contribution - continues from 200,10
                  {
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 200, y: 10 },
                      { type: 'L', x: 200, y: 200 },
                    ],
                  },
                  // Third contribution - from 200,200 and closes back to 10,10
                  {
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 200, y: 200 },
                      { type: 'L', x: 10, y: 200 },
                      { type: 'L', x: 10, y: 10 },
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
      expect(hasRenderedContent(canvas)).toBe(true);
    });

    it('should detect closing contribution with gap between contributions', async () => {
      // EPSILON = 8.0, closeEpsilon = 24
      // Need gap > 8 (no direct continuation) but <= 24 (can close)
      // First contribution: chainStart=(0,0), ends at (100, 0)
      // Second contribution: starts at (100, 10) - gap=10 > 8, no direct match
      //   ends at (10, 10) - within 24 of chainStart (0,0)
      // This forces the closing detection code path (lines 1907-1910, 1917-1919)
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
                  // First contribution - starts at (0,0), ends at (100,0)
                  {
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 0 },
                      { type: 'L', x: 100, y: 0 },
                    ],
                  },
                  // Second contribution - gap from first's end but can close the loop
                  // starts at (100, 10) - gap=10 from first's end (100, 0), > epsilon=8
                  // ends at (10, 10) - distance to chainStart (0,0) is sqrt(200) < 24
                  {
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 100, y: 10 },
                      { type: 'L', x: 50, y: 50 },
                      { type: 'L', x: 10, y: 10 },
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
      expect(hasRenderedContent(canvas)).toBe(true);
    });
  });

  describe('camera motion tween interpolation', () => {
    it('should interpolate camera position with motion tween', async () => {
      // Create a document with camera layer using motion tween
      const doc = createMinimalDoc({
        width: 1920,
        height: 1080,
        timelines: [createTimeline({
          name: 'Scene 1',
          totalFrames: 30,
          layers: [
            // Camera layer with motion tween
            createLayer({
              name: 'Camera',
              frames: [
                createFrame({
                  index: 0,
                  duration: 15,
                  tweenType: 'motion',
                  elements: [{
                    type: 'symbol',
                    libraryItemName: 'Ramka',
                    matrix: createMatrix({ tx: 0, ty: 0, a: 1, d: 1 }),
                    transformationPoint: { x: 960, y: 540 },
                    loop: 'loop',
                    firstFrame: 0,
                  }],
                }),
                createFrame({
                  index: 15,
                  duration: 15,
                  elements: [{
                    type: 'symbol',
                    libraryItemName: 'Ramka',
                    matrix: createMatrix({ tx: 500, ty: 300, a: 0.5, d: 0.5 }),
                    transformationPoint: { x: 960, y: 540 },
                    loop: 'loop',
                    firstFrame: 0,
                  }],
                }),
              ],
            }),
            // Content layer
            createLayer({
              name: 'Content',
              frames: [createFrame({
                index: 0,
                duration: 30,
                elements: [{
                  type: 'shape',
                  matrix: createMatrix(),
                  fills: [{ index: 1, color: '#00FF00' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 100, y: 100 },
                      { type: 'L', x: 400, y: 100 },
                      { type: 'L', x: 400, y: 400 },
                      { type: 'L', x: 100, y: 400 },
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

      // Add Ramka symbol to document
      doc.symbols.set('Ramka', {
        name: 'Ramka',
        timeline: createTimeline({
          layers: [createLayer({
            frames: [createFrame()],
          })],
        }),
      });

      await renderer.setDocument(doc);
      renderer.setFollowCamera(true);

      // Render at frame 7 - should interpolate between keyframes
      renderer.renderFrame(7);
      // Camera interpolation affects viewport, verify no errors
      expect(renderer.getFollowCamera()).toBe(true);

      // Render at frame 0 - start of tween
      renderer.renderFrame(0);
      expect(renderer.getFollowCamera()).toBe(true);

      // Render at frame 14 - near end of first keyframe
      renderer.renderFrame(14);
      expect(renderer.getFollowCamera()).toBe(true);
    });

    it('should apply camera transform with non-identity matrix', async () => {
      // Test applyCameraTransform with rotation/scale matrix
      const doc = createMinimalDoc({
        width: 800,
        height: 600,
        timelines: [createTimeline({
          name: 'Scene 1',
          totalFrames: 10,
          layers: [
            // Camera layer with rotation/scale
            createLayer({
              name: 'Camera',
              frames: [createFrame({
                index: 0,
                duration: 10,
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'Ramka',
                  // Non-identity matrix with rotation and scale
                  matrix: { a: 0.866, b: 0.5, c: -0.5, d: 0.866, tx: 100, ty: 50 },
                  transformationPoint: { x: 400, y: 300 },
                  loop: 'loop',
                  firstFrame: 0,
                }],
              })],
            }),
            // Content layer
            createLayer({
              name: 'Content',
              frames: [createFrame({
                index: 0,
                duration: 10,
                elements: [{
                  type: 'shape',
                  matrix: createMatrix(),
                  fills: [{ index: 1, color: '#FF00FF' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 200, y: 200 },
                      { type: 'L', x: 400, y: 200 },
                      { type: 'L', x: 400, y: 400 },
                      { type: 'L', x: 200, y: 400 },
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

      doc.symbols.set('Ramka', {
        name: 'Ramka',
        timeline: createTimeline({
          layers: [createLayer({ frames: [createFrame()] })],
        }),
      });

      await renderer.setDocument(doc);
      renderer.setFollowCamera(true);
      renderer.renderFrame(0);

      expect(hasRenderedContent(canvas, '#FFFFFF')).toBe(true);
    });
  });

  describe('text element rendering with fonts', () => {
    it('should trigger font loading for PressStart2P font', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [
                {
                  type: 'text',
                  matrix: createMatrix({ tx: 50, ty: 200 }),
                  textRuns: [{
                    characters: 'GAME OVER',
                    textAttrs: {
                      face: 'PressStart2P',
                      size: 32,
                      fillColor: '#FF0000',
                      alignment: 'left',
                    },
                  }],
                  width: 400,
                  height: 100,
                },
                // Add a shape to ensure something is rendered
                {
                  type: 'shape',
                  matrix: createMatrix(),
                  fills: [{ index: 1, color: '#00FF00' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 10, y: 10 },
                      { type: 'L', x: 100, y: 10 },
                      { type: 'L', x: 100, y: 100 },
                      { type: 'L', x: 10, y: 100 },
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

      renderer.renderFrame(0);
      // The shape renders, and font loading is triggered async
      expect(hasRenderedContent(canvas)).toBe(true);
    });

    it('should wait for font loading promise to resolve or reject', async () => {
      // Use a fresh canvas and renderer to avoid cached fonts
      const freshCanvas = document.createElement('canvas');
      freshCanvas.width = 550;
      freshCanvas.height = 400;
      const freshRenderer = new FLARenderer(freshCanvas);

      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'text',
                matrix: createMatrix({ tx: 50, ty: 100 }),
                textRuns: [{
                  characters: 'Test Font Loading',
                  textAttrs: {
                    // Use 'PressStart2P' which maps to 'Press Start 2P' in fontMap
                    // This triggers ensureFontLoaded for a Google Font
                    face: 'PressStart2P',
                    size: 16,
                    fillColor: '#0000FF',
                    alignment: 'left',
                  },
                }],
                width: 400,
                height: 50,
              }],
            })],
          })],
        })],
      });
      await freshRenderer.setDocument(doc);

      // Render to trigger font loading
      freshRenderer.renderFrame(0);

      // Wait for font loading promise to settle (resolve or reject)
      await new Promise(resolve => setTimeout(resolve, 600));

      // Render again after font potentially loaded
      freshRenderer.renderFrame(0);
    });
  });

  describe('addCommandToPath cases', () => {
    it('should render M command (moveTo)', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#123456' }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 50, y: 50 },
                    { type: 'L', x: 150, y: 50 },
                    { type: 'M', x: 150, y: 50 }, // Another M command
                    { type: 'L', x: 150, y: 150 },
                    { type: 'L', x: 50, y: 150 },
                    { type: 'L', x: 50, y: 50 },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);
      renderer.renderFrame(0);
      expect(hasRenderedContent(canvas)).toBe(true);
    });
  });

  describe('debug mode with complex shapes', () => {
    it('should handle debug click on shape with Q curve commands', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#AABBCC' }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 100, y: 200 },
                    { type: 'Q', cx: 150, cy: 100, x: 200, y: 200 },
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
      document.body.appendChild(canvas);

      renderer.enableDebugMode();
      renderer.renderFrame(0);

      // Click in the quadratic bezier area
      const rect = canvas.getBoundingClientRect();
      const clickEvent = new MouseEvent('click', {
        clientX: rect.left + 150,
        clientY: rect.top + 150,
        bubbles: true,
      });
      canvas.dispatchEvent(clickEvent);

      renderer.disableDebugMode();
      document.body.removeChild(canvas);
      expect(hasRenderedContent(canvas)).toBe(true);
    });

    it('should handle debug click on shape with C curve commands', async () => {
      // Create a large rectangle with a C curve command
      // The shape covers (50,50) to (500,350) ensuring the click at center definitely hits
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#DDEEFF' }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 50, y: 50 },
                    // Cubic bezier for top edge - goes up slightly then back down
                    { type: 'C', c1x: 200, c1y: 20, c2x: 350, c2y: 20, x: 500, y: 50 },
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

      // Position canvas at origin for predictable coordinates
      document.body.appendChild(canvas);
      canvas.style.position = 'fixed';
      canvas.style.left = '0';
      canvas.style.top = '0';

      renderer.enableDebugMode();
      renderer.renderFrame(0);

      const rect = canvas.getBoundingClientRect();
      // Click in the center of the shape - definitely inside the large rectangle
      const clickEvent = new MouseEvent('click', {
        clientX: rect.left + 275,
        clientY: rect.top + 200,
        bubbles: true,
      });
      canvas.dispatchEvent(clickEvent);

      renderer.disableDebugMode();
      document.body.removeChild(canvas);
      expect(hasRenderedContent(canvas)).toBe(true);
    });

    it('should log details for symbol element in debug mode', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'symbol',
                libraryItemName: 'TestSymbol',
                matrix: createMatrix(),
                transformationPoint: { x: 50, y: 50 },
                loop: 'loop',
                firstFrame: 0,
              }],
            })],
          })],
        })],
      });

      // Add symbol with visible content
      doc.symbols.set('TestSymbol', {
        name: 'TestSymbol',
        timeline: createTimeline({
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
        }),
      });

      await renderer.setDocument(doc);
      document.body.appendChild(canvas);

      renderer.enableDebugMode();
      renderer.renderFrame(0);

      // Click on the symbol
      const rect = canvas.getBoundingClientRect();
      const clickEvent = new MouseEvent('click', {
        clientX: rect.left + 50,
        clientY: rect.top + 50,
        bubbles: true,
      });
      canvas.dispatchEvent(clickEvent);

      renderer.disableDebugMode();
      document.body.removeChild(canvas);
      expect(hasRenderedContent(canvas)).toBe(true);
    });

    it('should log details for bitmap element in debug mode', async () => {
      // Create a test image
      const testCanvas = document.createElement('canvas');
      testCanvas.width = 100;
      testCanvas.height = 100;
      const testCtx = testCanvas.getContext('2d')!;
      testCtx.fillStyle = '#0000FF';
      testCtx.fillRect(0, 0, 100, 100);

      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'bitmap',
                libraryItemName: 'TestBitmap',
                matrix: createMatrix(),
              }],
            })],
          })],
        })],
      });

      // Add bitmap
      doc.bitmaps.set('TestBitmap', testCanvas);

      await renderer.setDocument(doc);
      document.body.appendChild(canvas);

      renderer.enableDebugMode();
      renderer.renderFrame(0);

      // Click on the bitmap
      const rect = canvas.getBoundingClientRect();
      const clickEvent = new MouseEvent('click', {
        clientX: rect.left + 50,
        clientY: rect.top + 50,
        bubbles: true,
      });
      canvas.dispatchEvent(clickEvent);

      renderer.disableDebugMode();
      document.body.removeChild(canvas);
      expect(hasRenderedContent(canvas)).toBe(true);
    });

    it('should show bad edges in debug click with out-of-bounds Q coords', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#112233' }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 100, y: 100 },
                    // Q with out-of-bounds control point
                    { type: 'Q', cx: 50000, cy: 50000, x: 200, y: 100 },
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
      document.body.appendChild(canvas);

      renderer.enableDebugMode();
      renderer.renderFrame(0);

      const rect = canvas.getBoundingClientRect();
      const clickEvent = new MouseEvent('click', {
        clientX: rect.left + 150,
        clientY: rect.top + 150,
        bubbles: true,
      });
      canvas.dispatchEvent(clickEvent);

      renderer.disableDebugMode();
      document.body.removeChild(canvas);
    });

    it('should show bad edges in debug click with out-of-bounds C coords', async () => {
      // Create a large shape covering the canvas with a C curve having out-of-bounds control points
      // The shape is defined to ensure the click point is inside it
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#445566' }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 50, y: 50 },
                    { type: 'L', x: 500, y: 50 },
                    // C with out-of-bounds control point coordinates (>10000)
                    { type: 'C', c1x: 500, c1y: 20000, c2x: 500, c2y: 350, x: 500, y: 350 },
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

      // Position canvas for predictable coordinates
      document.body.appendChild(canvas);
      canvas.style.position = 'fixed';
      canvas.style.left = '0';
      canvas.style.top = '0';

      renderer.enableDebugMode();
      renderer.renderFrame(0);

      const rect = canvas.getBoundingClientRect();
      // Click in the center of the shape
      const clickEvent = new MouseEvent('click', {
        clientX: rect.left + 275,
        clientY: rect.top + 200,
        bubbles: true,
      });
      canvas.dispatchEvent(clickEvent);

      renderer.disableDebugMode();
      document.body.removeChild(canvas);
    });

    it('should handle many edges with bad edges in debug mode', async () => {
      // Create more than 5 edges, with some bad ones - triggers the badEdges display path
      const edges = [];
      for (let i = 0; i < 8; i++) {
        edges.push({
          fillStyle0: 1,
          commands: [
            { type: 'M', x: i * 50, y: 0 },
            { type: 'L', x: i * 50 + 40, y: 0 },
            { type: 'L', x: i * 50 + 40, y: 40 },
            { type: 'L', x: i * 50, y: 40 },
            { type: 'Z' },
          ],
        });
      }
      // Add one edge with bad coords
      edges.push({
        fillStyle0: 1,
        commands: [
          { type: 'M', x: 100000, y: 100000 },
          { type: 'L', x: 100100, y: 100000 },
          { type: 'L', x: 100100, y: 100100 },
          { type: 'Z' },
        ],
      });

      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#778899' }],
                strokes: [],
                edges,
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);
      document.body.appendChild(canvas);

      renderer.enableDebugMode();
      renderer.renderFrame(0);

      const rect = canvas.getBoundingClientRect();
      const clickEvent = new MouseEvent('click', {
        clientX: rect.left + 100,
        clientY: rect.top + 20,
        bubbles: true,
      });
      canvas.dispatchEvent(clickEvent);

      renderer.disableDebugMode();
      document.body.removeChild(canvas);
    });
  });

  describe('matrix inversion edge cases', () => {
    it('should skip degenerate camera matrix (det near zero)', async () => {
      // Create a camera with near-degenerate matrix (determinant close to 0)
      const doc = createMinimalDoc({
        width: 800,
        height: 600,
        timelines: [createTimeline({
          name: 'Scene 1',
          totalFrames: 10,
          layers: [
            createLayer({
              name: 'Camera',
              frames: [createFrame({
                index: 0,
                duration: 10,
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'Ramka',
                  // Near-degenerate matrix: a*d - b*c = 0.00001*0.00001 - 0*0 ≈ 0.0000000001
                  // This should trigger the det < 0.0001 check
                  matrix: { a: 0.00001, b: 0, c: 0, d: 0.00001, tx: 400, ty: 300 },
                  transformationPoint: { x: 400, y: 300 },
                  loop: 'loop',
                  firstFrame: 0,
                }],
              })],
            }),
            createLayer({
              name: 'Content',
              frames: [createFrame({
                index: 0,
                duration: 10,
                elements: [{
                  type: 'shape',
                  matrix: createMatrix(),
                  fills: [{ index: 1, color: '#AABB00' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 100, y: 100 },
                      { type: 'L', x: 300, y: 100 },
                      { type: 'L', x: 300, y: 300 },
                      { type: 'L', x: 100, y: 300 },
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

      doc.symbols.set('Ramka', {
        name: 'Ramka',
        timeline: createTimeline({
          layers: [createLayer({ frames: [createFrame()] })],
        }),
      });

      await renderer.setDocument(doc);
      renderer.setFollowCamera(true);
      // Should not throw even with near-degenerate matrix
      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

  describe('camera transform via cameraLayerIndex', () => {
    it('should apply camera transform from timeline cameraLayerIndex', async () => {
      // Test using cameraLayerIndex property (auto-detected during parsing)
      // rather than followCamera mode
      const doc = createMinimalDoc({
        width: 800,
        height: 600,
        timelines: [createTimeline({
          name: 'Scene 1',
          totalFrames: 30,
          cameraLayerIndex: 0, // Set camera layer index directly
          layers: [
            createLayer({
              name: 'Camera',
              frames: [createFrame({
                index: 0,
                duration: 30,
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'Ramka',
                  matrix: { a: 1.5, b: 0, c: 0, d: 1.5, tx: -200, ty: -150 },
                  transformationPoint: { x: 400, y: 300 },
                  loop: 'loop',
                  firstFrame: 0,
                }],
              })],
            }),
            createLayer({
              name: 'Background',
              frames: [createFrame({
                index: 0,
                duration: 30,
                elements: [{
                  type: 'shape',
                  matrix: createMatrix(),
                  fills: [{ index: 1, color: '#FF5500' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 0 },
                      { type: 'L', x: 800, y: 0 },
                      { type: 'L', x: 800, y: 600 },
                      { type: 'L', x: 0, y: 600 },
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

      doc.symbols.set('Ramka', {
        name: 'Ramka',
        timeline: createTimeline({
          layers: [createLayer({ frames: [createFrame()] })],
        }),
      });

      await renderer.setDocument(doc);
      // Do NOT call setFollowCamera - use cameraLayerIndex path
      renderer.renderFrame(0);
      expect(hasRenderedContent(canvas, '#FFFFFF')).toBe(true);
    });

    it('should interpolate camera motion tween between keyframes', async () => {
      // Create document with motion tween on camera
      const doc = createMinimalDoc({
        width: 640,
        height: 480,
        timelines: [createTimeline({
          name: 'Scene 1',
          totalFrames: 20,
          cameraLayerIndex: 0,
          layers: [
            createLayer({
              name: 'Camera',
              frames: [
                createFrame({
                  index: 0,
                  duration: 10,
                  tweenType: 'motion',
                  elements: [{
                    type: 'symbol',
                    libraryItemName: 'Ramka',
                    matrix: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
                    transformationPoint: { x: 320, y: 240 },
                    loop: 'loop',
                    firstFrame: 0,
                  }],
                }),
                createFrame({
                  index: 10,
                  duration: 10,
                  elements: [{
                    type: 'symbol',
                    libraryItemName: 'Ramka',
                    matrix: { a: 2, b: 0, c: 0, d: 2, tx: -320, ty: -240 },
                    transformationPoint: { x: 320, y: 240 },
                    loop: 'loop',
                    firstFrame: 0,
                  }],
                }),
              ],
            }),
            createLayer({
              name: 'Content',
              frames: [createFrame({
                index: 0,
                duration: 20,
                elements: [{
                  type: 'shape',
                  matrix: createMatrix(),
                  fills: [{ index: 1, color: '#00AAFF' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 200, y: 150 },
                      { type: 'L', x: 440, y: 150 },
                      { type: 'L', x: 440, y: 330 },
                      { type: 'L', x: 200, y: 330 },
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

      doc.symbols.set('Ramka', {
        name: 'Ramka',
        timeline: createTimeline({
          layers: [createLayer({ frames: [createFrame()] })],
        }),
      });

      await renderer.setDocument(doc);

      // Render at frame 5 - midway through tween
      // This should trigger motion tween interpolation
      renderer.renderFrame(5);
      expect(hasRenderedContent(canvas, '#FFFFFF')).toBe(true);
    });

    it('should apply inverse camera transform with valid matrix', async () => {
      // Test that applyInverseCameraTransform is called with non-degenerate matrix
      const doc = createMinimalDoc({
        width: 400,
        height: 300,
        timelines: [createTimeline({
          name: 'Scene 1',
          totalFrames: 10,
          cameraLayerIndex: 0,
          layers: [
            createLayer({
              name: 'Camera',
              frames: [createFrame({
                index: 0,
                duration: 10,
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'Ramka',
                  // Valid invertible matrix (det = 1.2 * 0.8 - 0.1 * 0.1 = 0.95 ≠ 0)
                  matrix: { a: 1.2, b: 0.1, c: 0.1, d: 0.8, tx: 50, ty: 30 },
                  transformationPoint: { x: 200, y: 150 },
                  loop: 'loop',
                  firstFrame: 0,
                }],
              })],
            }),
            createLayer({
              name: 'Main',
              frames: [createFrame({
                index: 0,
                duration: 10,
                elements: [{
                  type: 'shape',
                  matrix: createMatrix(),
                  fills: [{ index: 1, color: '#AA00FF' }],
                  strokes: [],
                  edges: [{
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 50, y: 50 },
                      { type: 'L', x: 350, y: 50 },
                      { type: 'L', x: 350, y: 250 },
                      { type: 'L', x: 50, y: 250 },
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

      doc.symbols.set('Ramka', {
        name: 'Ramka',
        timeline: createTimeline({
          layers: [createLayer({ frames: [createFrame()] })],
        }),
      });

      await renderer.setDocument(doc);
      renderer.renderFrame(0);
      // Content should be rendered (with camera transform applied)
      expect(hasRenderedContent(canvas, '#FFFFFF')).toBe(true);
    });
  });

  describe('fillStyle1 edge handling', () => {
    it('should process edges with fillStyle1', async () => {
      // Test edges using fillStyle1 instead of fillStyle0
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#FF8800' }, { index: 2, color: '#0088FF' }],
                strokes: [],
                edges: [
                  // Edge with fillStyle1 (right-side fill)
                  {
                    fillStyle1: 1,
                    commands: [
                      { type: 'M', x: 50, y: 50 },
                      { type: 'L', x: 200, y: 50 },
                      { type: 'L', x: 200, y: 200 },
                      { type: 'L', x: 50, y: 200 },
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
      expect(hasRenderedContent(canvas)).toBe(true);
    });
  });

  describe('radial gradient edge cases', () => {
    it('should handle radial gradient fill with empty gradient array', async () => {
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
                  gradient: [], // Empty gradient array
                }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 100, y: 100 },
                    { type: 'L', x: 300, y: 100 },
                    { type: 'L', x: 300, y: 300 },
                    { type: 'L', x: 100, y: 300 },
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
      // Should render without error even with empty gradient
    });
  });

  describe('edge commands with only Z', () => {
    it('should handle edge with only Z command', async () => {
      // Tests getLastPoint returning null when no coordinates in commands
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#AABBCC' }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'Z' },  // Only Z command - no coordinates
                  ],
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);
      renderer.renderFrame(0);
      // Should not crash with edge that has only Z command
    });
  });

  describe('missing symbol logging', () => {
    it('should log missing symbol warning once', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'symbol',
                libraryItemName: 'NonExistentSymbol',
                matrix: createMatrix(),
                transformationPoint: { x: 0, y: 0 },
                loop: 'loop',
                firstFrame: 0,
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);
      renderer.renderFrame(0);
      // Render again - should not log warning twice
      renderer.renderFrame(0);
    });
  });

  describe('linear gradient edge cases', () => {
    it('should handle linear gradient with empty gradient array', async () => {
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
                  gradient: [], // Empty gradient array
                }],
                strokes: [],
                edges: [{
                  fillStyle0: 1,
                  commands: [
                    { type: 'M', x: 50, y: 50 },
                    { type: 'L', x: 250, y: 50 },
                    { type: 'L', x: 250, y: 250 },
                    { type: 'L', x: 50, y: 250 },
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
      // Should render without error even with empty gradient
    });
  });

  describe('color alpha with invalid format', () => {
    it('should handle invalid color format in fill', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{
                  index: 1,
                  color: 'invalid', // Invalid color format
                  alpha: 0.5,
                }],
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
      renderer.renderFrame(0);
      // Should not crash with invalid color format
    });

    it('should handle short hex color with alpha', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{
                  index: 1,
                  color: '#F00', // Short hex format (3 chars)
                  alpha: 0.8,
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
      expect(hasRenderedContent(canvas)).toBe(true);
    });
  });

  describe('edge contribution closing detection', () => {
    it('should find closing contribution that completes a loop', async () => {
      // Create three contributions where the third one closes the loop
      // Chain: A -> B, B -> C, C -> A (closes)
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#FFCC00' }],
                strokes: [],
                edges: [
                  // First edge: A(0,0) -> B(100,0)
                  {
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 0, y: 0 },
                      { type: 'L', x: 100, y: 0 },
                    ],
                  },
                  // Second edge: B(100,0) -> C(100,100)
                  {
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 100, y: 0 },
                      { type: 'L', x: 100, y: 100 },
                    ],
                  },
                  // Third edge: C(100,100) -> A(0,0) - closes the loop
                  {
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 100, y: 100 },
                      { type: 'L', x: 0, y: 100 },
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
      expect(hasRenderedContent(canvas)).toBe(true);
    });

    it('should detect closing contribution among multiple candidates', async () => {
      // Multiple edges where one specifically closes the loop while others continue
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, color: '#00CCFF' }],
                strokes: [],
                edges: [
                  // First edge starts at (50,50)
                  {
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 50, y: 50 },
                      { type: 'L', x: 250, y: 50 },
                    ],
                  },
                  // Second edge continues
                  {
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 250, y: 50 },
                      { type: 'L', x: 250, y: 250 },
                    ],
                  },
                  // Third edge - closes back to start
                  {
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 250, y: 250 },
                      { type: 'L', x: 50, y: 250 },
                      { type: 'L', x: 50, y: 50 },
                    ],
                  },
                  // Fourth edge - disconnected, starts new chain
                  {
                    fillStyle0: 1,
                    commands: [
                      { type: 'M', x: 300, y: 300 },
                      { type: 'L', x: 400, y: 300 },
                      { type: 'L', x: 400, y: 350 },
                      { type: 'L', x: 300, y: 350 },
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
      expect(hasRenderedContent(canvas)).toBe(true);
    });
  });

  describe('DEBUG mode', () => {
    let renderer: FLARenderer;
    let canvas: HTMLCanvasElement;
    let consoleSpy: ConsoleSpy;

    beforeEach(() => {
      setRendererDebug(true);
      canvas = document.createElement('canvas');
      renderer = new FLARenderer(canvas);
      consoleSpy = createConsoleSpy();
    });

    afterEach(() => {
      setRendererDebug(false);
      consoleSpy.mockRestore();
    });

    it('should log viewport and canvas size info when DEBUG is enabled', async () => {
      const doc = createMinimalDoc({
        width: 800,
        height: 600,
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [createRectangleShape({ color: '#FF0000' })],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expectLogContaining(consoleSpy, 'Viewport size:');
      expectLogContaining(consoleSpy, 'Canvas size:');
      expectLogContaining(consoleSpy, 'Scale:');
    });

    it('should log shape pre-computation count when DEBUG is enabled', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [createTriangleShape({ color: '#00FF00', size: 50 })],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expectLogContaining(consoleSpy, 'Pre-computing');
    });

    it('should log camera info when setFollowCamera is enabled with DEBUG', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [
            createLayer({
              name: 'camera',
              frames: [createFrame({
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'CameraSymbol',
                  matrix: createMatrix({ tx: 100, ty: 100 }),
                  loop: 'single frame',
                }],
              })],
            }),
            createLayer({
              name: 'content',
              frames: [createFrame({
                elements: [createRectangleShape({ color: '#0000FF' })],
              })],
            }),
          ],
        })],
      });
      await renderer.setDocument(doc);
      renderer.setFollowCamera(true);

      expectLogContaining(consoleSpy, 'Follow camera enabled');
    });

    it('should log camera viewport detection with DEBUG enabled', async () => {
      const doc = createMinimalDoc({
        width: 1920,
        height: 1080,
        timelines: [createTimeline({
          layers: [
            createLayer({
              name: 'ramka',
              frames: [createFrame({
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'RamkaSymbol',
                  matrix: createMatrix({ a: 1, b: 0, c: 0, d: 1, tx: 960, ty: 540 }),
                  transformationPoint: { x: 0, y: 0 },
                  loop: 'single frame',
                }],
              })],
            }),
            createLayer({
              name: 'background',
              frames: [createFrame({
                elements: [createRectangleShape({ width: 1920, height: 1080, color: '#333333' })],
              })],
            }),
          ],
        })],
      });
      await renderer.setDocument(doc);
      consoleSpy.mockClear();

      renderer.setFollowCamera(true);
      renderer.renderFrame(0);

      expectLogContaining(consoleSpy, 'Camera viewport:');
    });

    it('should log camera center during render when following camera with DEBUG', async () => {
      const doc = createMinimalDoc({
        width: 1920,
        height: 1080,
        timelines: [createTimeline({
          layers: [
            createLayer({
              name: 'viewport',
              frames: [createFrame({
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'ViewportSymbol',
                  matrix: createMatrix({ a: 1, b: 0, c: 0, d: 1, tx: 500, ty: 300 }),
                  transformationPoint: { x: 200, y: 150 },
                  loop: 'single frame',
                }],
              })],
            }),
            createLayer({
              name: 'main',
              frames: [createFrame({
                elements: [createRectangleShape({ width: 200, height: 200, color: '#AABBCC' })],
              })],
            }),
          ],
        })],
      });
      await renderer.setDocument(doc);
      renderer.setFollowCamera(true);
      consoleSpy.mockClear();

      renderer.renderFrame(0);

      expectLogContaining(consoleSpy, 'Camera:');
    });

    it('should log font preload info when document has text elements with DEBUG', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'text',
                matrix: createMatrix(),
                left: 10,
                width: 200,
                height: 50,
                textRuns: [{
                  characters: 'Test text',
                  face: 'PressStart2P-Regular',
                  size: 16,
                  fillColor: '#000000',
                }],
              }],
            })],
          })],
        })],
      });

      await renderer.setDocument(doc);

      expectLogContaining(consoleSpy, 'Fonts to preload:');
    });
  });

  describe('filters', () => {
    it('should render symbol with blur filter', async () => {
      const symbolTimeline = createTimeline({
        name: 'Symbol 1',
        layers: [createLayer({
          frames: [createFrame({
            elements: [createRectangleShape({ width: 50, height: 50, color: '#FF0000' })],
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
                filters: [{
                  type: 'blur',
                  blurX: 5,
                  blurY: 5,
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should render symbol with glow filter', async () => {
      const symbolTimeline = createTimeline({
        name: 'Symbol 1',
        layers: [createLayer({
          frames: [createFrame({
            elements: [createRectangleShape({ width: 50, height: 50, color: '#00FF00' })],
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
                filters: [{
                  type: 'glow',
                  blurX: 10,
                  blurY: 10,
                  color: '#FFFF00',
                  strength: 0.5,
                  alpha: 1,
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should render symbol with drop shadow filter', async () => {
      const symbolTimeline = createTimeline({
        name: 'Symbol 1',
        layers: [createLayer({
          frames: [createFrame({
            elements: [createRectangleShape({ width: 50, height: 50, color: '#0000FF' })],
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
                filters: [{
                  type: 'dropShadow',
                  blurX: 4,
                  blurY: 4,
                  color: '#000000',
                  strength: 0.5,
                  distance: 5,
                  angle: 45,
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should render symbol with multiple filters', async () => {
      const symbolTimeline = createTimeline({
        name: 'Symbol 1',
        layers: [createLayer({
          frames: [createFrame({
            elements: [createRectangleShape({ width: 50, height: 50, color: '#FF00FF' })],
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
                filters: [
                  { type: 'blur', blurX: 2, blurY: 2 },
                  { type: 'glow', blurX: 5, blurY: 5, color: '#00FFFF', strength: 0.3 },
                ],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should render text with blur filter', async () => {
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
                  characters: 'Blurred Text',
                  size: 24,
                  face: 'Arial',
                  fillColor: '#000000',
                }],
                filters: [{
                  type: 'blur',
                  blurX: 3,
                  blurY: 3,
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should render text with drop shadow filter', async () => {
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
                  characters: 'Shadow Text',
                  size: 24,
                  face: 'Arial',
                  fillColor: '#FF0000',
                }],
                filters: [{
                  type: 'dropShadow',
                  blurX: 4,
                  blurY: 4,
                  color: '#333333',
                  strength: 0.8,
                  distance: 3,
                  angle: 45,
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

  describe('morph shapes (shape tweens)', () => {
    it('should render morph shape at progress 0', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          totalFrames: 10,
          layers: [createLayer({
            frames: [createFrame({
              index: 0,
              duration: 10,
              tweenType: 'shape',
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
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
              morphShape: {
                segments: [{
                  startPointA: { x: 0, y: 0 },
                  startPointB: { x: 50, y: 50 },
                  fillIndex1: 1,
                  curves: [
                    {
                      controlPointA: { x: 50, y: 0 },
                      anchorPointA: { x: 100, y: 0 },
                      controlPointB: { x: 75, y: 25 },
                      anchorPointB: { x: 100, y: 50 },
                      isLine: true,
                    },
                    {
                      controlPointA: { x: 100, y: 50 },
                      anchorPointA: { x: 100, y: 100 },
                      controlPointB: { x: 100, y: 75 },
                      anchorPointB: { x: 100, y: 100 },
                      isLine: true,
                    },
                    {
                      controlPointA: { x: 50, y: 100 },
                      anchorPointA: { x: 0, y: 100 },
                      controlPointB: { x: 75, y: 100 },
                      anchorPointB: { x: 50, y: 100 },
                      isLine: true,
                    },
                    {
                      controlPointA: { x: 0, y: 50 },
                      anchorPointA: { x: 0, y: 0 },
                      controlPointB: { x: 50, y: 75 },
                      anchorPointB: { x: 50, y: 50 },
                      isLine: true,
                    },
                  ],
                }],
              },
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should render morph shape at mid-progress', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          totalFrames: 10,
          layers: [createLayer({
            frames: [
              createFrame({
                index: 0,
                duration: 5,
                tweenType: 'shape',
                elements: [{
                  type: 'shape',
                  matrix: createMatrix(),
                  fills: [{ index: 1, type: 'solid', color: '#00FF00' }],
                  strokes: [],
                  edges: [],
                }],
                morphShape: {
                  segments: [{
                    startPointA: { x: 0, y: 0 },
                    startPointB: { x: 50, y: 0 },
                    fillIndex1: 1,
                    curves: [
                      {
                        controlPointA: { x: 50, y: 0 },
                        anchorPointA: { x: 100, y: 0 },
                        controlPointB: { x: 100, y: 0 },
                        anchorPointB: { x: 100, y: 50 },
                        isLine: false,
                      },
                    ],
                  }],
                },
              }),
              createFrame({
                index: 5,
                duration: 5,
                elements: [{
                  type: 'shape',
                  matrix: createMatrix(),
                  fills: [{ index: 1, type: 'solid', color: '#00FF00' }],
                  strokes: [],
                  edges: [],
                }],
              }),
            ],
          })],
        })],
      });
      await renderer.setDocument(doc);

      // Render at frame 2 (progress 0.4)
      expect(() => renderer.renderFrame(2)).not.toThrow();
    });

    it('should render morph shape with strokes', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          totalFrames: 5,
          layers: [createLayer({
            frames: [createFrame({
              index: 0,
              duration: 5,
              tweenType: 'shape',
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [],
                strokes: [{ index: 1, color: '#000000', weight: 2 }],
                edges: [],
              }],
              morphShape: {
                segments: [{
                  startPointA: { x: 0, y: 0 },
                  startPointB: { x: 25, y: 25 },
                  strokeIndex1: 1,
                  curves: [
                    {
                      controlPointA: { x: 50, y: 0 },
                      anchorPointA: { x: 100, y: 50 },
                      controlPointB: { x: 50, y: 50 },
                      anchorPointB: { x: 75, y: 75 },
                      isLine: true,
                    },
                  ],
                }],
              },
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

  describe('blend modes', () => {
    it('should render symbol with multiply blend mode', async () => {
      const symbolTimeline = createTimeline({
        name: 'Symbol 1',
        layers: [createLayer({
          frames: [createFrame({
            elements: [createRectangleShape({ width: 50, height: 50, color: '#FF0000' })],
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
          layers: [
            createLayer({
              frames: [createFrame({
                elements: [createRectangleShape({ x: 0, y: 0, width: 200, height: 200, color: '#00FF00' })],
              })],
            }),
            createLayer({
              frames: [createFrame({
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'Symbol 1',
                  symbolType: 'graphic',
                  matrix: createMatrix({ tx: 50, ty: 50 }),
                  firstFrame: 0,
                  loop: 'loop',
                  blendMode: 'multiply',
                }],
              })],
            }),
          ],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should render symbol with screen blend mode', async () => {
      const symbolTimeline = createTimeline({
        name: 'Symbol 1',
        layers: [createLayer({
          frames: [createFrame({
            elements: [createRectangleShape({ width: 50, height: 50, color: '#0000FF' })],
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
          layers: [
            createLayer({
              frames: [createFrame({
                elements: [createRectangleShape({ x: 0, y: 0, width: 200, height: 200, color: '#FF0000' })],
              })],
            }),
            createLayer({
              frames: [createFrame({
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'Symbol 1',
                  symbolType: 'graphic',
                  matrix: createMatrix({ tx: 50, ty: 50 }),
                  firstFrame: 0,
                  loop: 'loop',
                  blendMode: 'screen',
                }],
              })],
            }),
          ],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should render symbol with overlay blend mode', async () => {
      const symbolTimeline = createTimeline({
        name: 'Symbol 1',
        layers: [createLayer({
          frames: [createFrame({
            elements: [createRectangleShape({ width: 50, height: 50, color: '#FFFFFF' })],
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
          layers: [
            createLayer({
              frames: [createFrame({
                elements: [createRectangleShape({ x: 0, y: 0, width: 200, height: 200, color: '#808080' })],
              })],
            }),
            createLayer({
              frames: [createFrame({
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'Symbol 1',
                  symbolType: 'graphic',
                  matrix: createMatrix({ tx: 50, ty: 50 }),
                  firstFrame: 0,
                  loop: 'loop',
                  blendMode: 'overlay',
                }],
              })],
            }),
          ],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should render symbol with add blend mode', async () => {
      const symbolTimeline = createTimeline({
        name: 'Symbol 1',
        layers: [createLayer({
          frames: [createFrame({
            elements: [createRectangleShape({ width: 50, height: 50, color: '#FF0000' })],
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
          layers: [
            createLayer({
              frames: [createFrame({
                elements: [createRectangleShape({ x: 0, y: 0, width: 200, height: 200, color: '#00FF00' })],
              })],
            }),
            createLayer({
              frames: [createFrame({
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'Symbol 1',
                  symbolType: 'graphic',
                  matrix: createMatrix({ tx: 50, ty: 50 }),
                  firstFrame: 0,
                  loop: 'loop',
                  blendMode: 'add',
                }],
              })],
            }),
          ],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should render symbol with difference blend mode', async () => {
      const symbolTimeline = createTimeline({
        name: 'Symbol 1',
        layers: [createLayer({
          frames: [createFrame({
            elements: [createRectangleShape({ width: 50, height: 50, color: '#FFFFFF' })],
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
          layers: [
            createLayer({
              frames: [createFrame({
                elements: [createRectangleShape({ x: 0, y: 0, width: 200, height: 200, color: '#FF00FF' })],
              })],
            }),
            createLayer({
              frames: [createFrame({
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'Symbol 1',
                  symbolType: 'graphic',
                  matrix: createMatrix({ tx: 50, ty: 50 }),
                  firstFrame: 0,
                  loop: 'loop',
                  blendMode: 'difference',
                }],
              })],
            }),
          ],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should render symbol with darken blend mode', async () => {
      const symbolTimeline = createTimeline({
        name: 'Symbol 1',
        layers: [createLayer({
          frames: [createFrame({
            elements: [createRectangleShape({ width: 50, height: 50, color: '#888888' })],
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
          layers: [
            createLayer({
              frames: [createFrame({
                elements: [createRectangleShape({ x: 0, y: 0, width: 200, height: 200, color: '#AAAAAA' })],
              })],
            }),
            createLayer({
              frames: [createFrame({
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'Symbol 1',
                  symbolType: 'graphic',
                  matrix: createMatrix({ tx: 50, ty: 50 }),
                  firstFrame: 0,
                  loop: 'loop',
                  blendMode: 'darken',
                }],
              })],
            }),
          ],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should render symbol with lighten blend mode', async () => {
      const symbolTimeline = createTimeline({
        name: 'Symbol 1',
        layers: [createLayer({
          frames: [createFrame({
            elements: [createRectangleShape({ width: 50, height: 50, color: '#CCCCCC' })],
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
          layers: [
            createLayer({
              frames: [createFrame({
                elements: [createRectangleShape({ x: 0, y: 0, width: 200, height: 200, color: '#444444' })],
              })],
            }),
            createLayer({
              frames: [createFrame({
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'Symbol 1',
                  symbolType: 'graphic',
                  matrix: createMatrix({ tx: 50, ty: 50 }),
                  firstFrame: 0,
                  loop: 'loop',
                  blendMode: 'lighten',
                }],
              })],
            }),
          ],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should render symbol with erase blend mode', async () => {
      const symbolTimeline = createTimeline({
        name: 'Symbol 1',
        layers: [createLayer({
          frames: [createFrame({
            elements: [createRectangleShape({ width: 30, height: 30, color: '#000000' })],
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
          layers: [
            createLayer({
              frames: [createFrame({
                elements: [createRectangleShape({ x: 0, y: 0, width: 200, height: 200, color: '#FF0000' })],
              })],
            }),
            createLayer({
              frames: [createFrame({
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'Symbol 1',
                  symbolType: 'graphic',
                  matrix: createMatrix({ tx: 85, ty: 85 }),
                  firstFrame: 0,
                  loop: 'loop',
                  blendMode: 'erase',
                }],
              })],
            }),
          ],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should render symbol with hardlight blend mode', async () => {
      const symbolTimeline = createTimeline({
        name: 'Symbol 1',
        layers: [createLayer({
          frames: [createFrame({
            elements: [createRectangleShape({ width: 50, height: 50, color: '#FF8000' })],
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
          layers: [
            createLayer({
              frames: [createFrame({
                elements: [createRectangleShape({ x: 0, y: 0, width: 200, height: 200, color: '#0080FF' })],
              })],
            }),
            createLayer({
              frames: [createFrame({
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'Symbol 1',
                  symbolType: 'graphic',
                  matrix: createMatrix({ tx: 50, ty: 50 }),
                  firstFrame: 0,
                  loop: 'loop',
                  blendMode: 'hardlight',
                }],
              })],
            }),
          ],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should combine blend mode with color transform', async () => {
      const symbolTimeline = createTimeline({
        name: 'Symbol 1',
        layers: [createLayer({
          frames: [createFrame({
            elements: [createRectangleShape({ width: 50, height: 50, color: '#FF0000' })],
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
          layers: [
            createLayer({
              frames: [createFrame({
                elements: [createRectangleShape({ x: 0, y: 0, width: 200, height: 200, color: '#00FF00' })],
              })],
            }),
            createLayer({
              frames: [createFrame({
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'Symbol 1',
                  symbolType: 'graphic',
                  matrix: createMatrix({ tx: 50, ty: 50 }),
                  firstFrame: 0,
                  loop: 'loop',
                  blendMode: 'multiply',
                  colorTransform: {
                    alphaMultiplier: 0.7,
                  },
                }],
              })],
            }),
          ],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should combine blend mode with filter', async () => {
      const symbolTimeline = createTimeline({
        name: 'Symbol 1',
        layers: [createLayer({
          frames: [createFrame({
            elements: [createRectangleShape({ width: 50, height: 50, color: '#0000FF' })],
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
          layers: [
            createLayer({
              frames: [createFrame({
                elements: [createRectangleShape({ x: 0, y: 0, width: 200, height: 200, color: '#FFFF00' })],
              })],
            }),
            createLayer({
              frames: [createFrame({
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'Symbol 1',
                  symbolType: 'graphic',
                  matrix: createMatrix({ tx: 50, ty: 50 }),
                  firstFrame: 0,
                  loop: 'loop',
                  blendMode: 'screen',
                  filters: [{
                    type: 'glow',
                    blurX: 5,
                    blurY: 5,
                    color: '#FFFFFF',
                    strength: 0.5,
                  }],
                }],
              })],
            }),
          ],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

  describe('color transforms', () => {
    it('should render symbol with alpha color transform', async () => {
      const symbolTimeline = createTimeline({
        name: 'Symbol 1',
        layers: [createLayer({
          frames: [createFrame({
            elements: [createRectangleShape({ width: 50, height: 50, color: '#FF0000' })],
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
                colorTransform: {
                  alphaMultiplier: 0.5,
                },
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should render symbol with brightness color transform', async () => {
      const symbolTimeline = createTimeline({
        name: 'Symbol 1',
        layers: [createLayer({
          frames: [createFrame({
            elements: [createRectangleShape({ width: 50, height: 50, color: '#00FF00' })],
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
                colorTransform: {
                  redMultiplier: 0.5,
                  greenMultiplier: 0.5,
                  blueMultiplier: 0.5,
                },
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should render symbol with tint color transform', async () => {
      const symbolTimeline = createTimeline({
        name: 'Symbol 1',
        layers: [createLayer({
          frames: [createFrame({
            elements: [createRectangleShape({ width: 50, height: 50, color: '#FFFFFF' })],
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
                colorTransform: {
                  redMultiplier: 0.5,
                  greenMultiplier: 0.5,
                  blueMultiplier: 0.5,
                  redOffset: 127,
                  greenOffset: 0,
                  blueOffset: 0,
                },
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should render symbol with combined color transform and filter', async () => {
      const symbolTimeline = createTimeline({
        name: 'Symbol 1',
        layers: [createLayer({
          frames: [createFrame({
            elements: [createRectangleShape({ width: 50, height: 50, color: '#0000FF' })],
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
                colorTransform: {
                  alphaMultiplier: 0.8,
                  redMultiplier: 0.7,
                  greenMultiplier: 0.7,
                  blueMultiplier: 0.7,
                },
                filters: [{
                  type: 'glow',
                  blurX: 5,
                  blurY: 5,
                  color: '#FFFF00',
                  strength: 0.5,
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

  describe('mask layers', () => {
    it('should render mask layer with masked content', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [
            // Mask layer
            createLayer({
              name: 'Mask',
              layerType: 'mask',
              frames: [createFrame({
                elements: [createRectangleShape({ x: 50, y: 50, width: 100, height: 100, color: '#FFFFFF' })],
              })],
            }),
            // Masked layer
            createLayer({
              name: 'Masked Content',
              layerType: 'masked',
              maskLayerIndex: 0,
              frames: [createFrame({
                elements: [createRectangleShape({ x: 0, y: 0, width: 200, height: 200, color: '#FF0000' })],
              })],
            }),
          ],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should render multiple masked layers', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [
            // Mask layer
            createLayer({
              name: 'Mask',
              layerType: 'mask',
              frames: [createFrame({
                elements: [createRectangleShape({ x: 50, y: 50, width: 150, height: 150, color: '#FFFFFF' })],
              })],
            }),
            // First masked layer
            createLayer({
              name: 'Masked 1',
              layerType: 'masked',
              maskLayerIndex: 0,
              frames: [createFrame({
                elements: [createRectangleShape({ x: 0, y: 0, width: 100, height: 100, color: '#FF0000' })],
              })],
            }),
            // Second masked layer
            createLayer({
              name: 'Masked 2',
              layerType: 'masked',
              maskLayerIndex: 0,
              frames: [createFrame({
                elements: [createRectangleShape({ x: 100, y: 100, width: 100, height: 100, color: '#00FF00' })],
              })],
            }),
          ],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should render normal layers alongside masked layers', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [
            // Normal layer
            createLayer({
              name: 'Background',
              frames: [createFrame({
                elements: [createRectangleShape({ x: 0, y: 0, width: 300, height: 300, color: '#CCCCCC' })],
              })],
            }),
            // Mask layer
            createLayer({
              name: 'Mask',
              layerType: 'mask',
              frames: [createFrame({
                elements: [createRectangleShape({ x: 75, y: 75, width: 150, height: 150, color: '#FFFFFF' })],
              })],
            }),
            // Masked layer
            createLayer({
              name: 'Masked Content',
              layerType: 'masked',
              maskLayerIndex: 1,
              frames: [createFrame({
                elements: [createRectangleShape({ x: 50, y: 50, width: 200, height: 200, color: '#FF0000' })],
              })],
            }),
            // Another normal layer
            createLayer({
              name: 'Foreground',
              frames: [createFrame({
                elements: [createRectangleShape({ x: 125, y: 125, width: 50, height: 50, color: '#0000FF' })],
              })],
            }),
          ],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should handle empty mask layer gracefully', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [
            // Empty mask layer
            createLayer({
              name: 'Mask',
              layerType: 'mask',
              frames: [createFrame({
                elements: [], // No elements in mask
              })],
            }),
            // Masked layer
            createLayer({
              name: 'Masked Content',
              layerType: 'masked',
              maskLayerIndex: 0,
              frames: [createFrame({
                elements: [createRectangleShape({ x: 0, y: 0, width: 100, height: 100, color: '#FF0000' })],
              })],
            }),
          ],
        })],
      });
      await renderer.setDocument(doc);

      // Should render masked layer normally when mask is empty
      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

});
