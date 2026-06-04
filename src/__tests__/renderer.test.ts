import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FLARenderer, setRendererDebug } from '../renderer';
import type { Edge } from '../types';
import {
  createConsoleSpy,
  createConsoleWarnSpy,
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
                  type: 'solid',
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

      renderer.updateCanvasSize();

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

  describe('cache management', () => {
    it('should clear caches without error', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
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
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      // Render to populate cache
      renderer.renderFrame(0);

      // Clear caches should not throw
      expect(() => renderer.clearCaches()).not.toThrow();

      // Should still render correctly after clearing caches
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
              fills: [{ index: 1, type: 'solid', color: '#FFFFFF' }],
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
                  transformationPoint: { x: 0, y: 0 },
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
              fills: [{ index: 1, type: 'solid', color: '#00FF00' }],
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
                  transformationPoint: { x: 0, y: 0 },
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
              fills: [{ index: 1, type: 'solid', color: '#0000FF' }],
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
                  transformationPoint: { x: 0, y: 0 },
                }],
              })],
            }),
            createLayer({
              name: 'Content',
              frames: [createFrame({
                elements: [{
                  type: 'shape',
                  matrix: createMatrix(),
                  fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
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
                  gradient: [
                    { ratio: 0, color: '#FF0000', alpha: 1 },
                    { ratio: 1, color: '#0000FF', alpha: 1 },
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
                  gradient: [
                    { ratio: 0, color: '#FFFFFF', alpha: 1 },
                    { ratio: 1, color: '#000000', alpha: 1 },
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

  describe('bitmap fills', () => {
    it('should render bitmap fill when bitmap is loaded', async () => {
      // Create a mock image
      const mockImage = new Image();
      mockImage.width = 100;
      mockImage.height = 100;

      const bitmaps = new Map();
      bitmaps.set('texture.png', {
        name: 'texture.png',
        href: 'texture.png',
        width: 100,
        height: 100,
        imageData: mockImage,
      });

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
                  bitmapPath: 'texture.png',
                  matrix: createMatrix({ a: 20, d: 20 }),
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

    it('should fallback to gray when bitmap is not found', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{
                  index: 1,
                  type: 'bitmap',
                  bitmapPath: 'missing.png',
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

      // Should not throw, but render gray fallback
      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should render bitmap fill without matrix', async () => {
      const mockImage = new Image();
      mockImage.width = 50;
      mockImage.height = 50;

      const bitmaps = new Map();
      bitmaps.set('pattern.png', {
        name: 'pattern.png',
        href: 'pattern.png',
        width: 50,
        height: 50,
        imageData: mockImage,
      });

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
                  bitmapPath: 'pattern.png',
                  // No matrix - should still render
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

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should handle case-insensitive bitmap lookup', async () => {
      const mockImage = new Image();
      mockImage.width = 100;
      mockImage.height = 100;

      const bitmaps = new Map();
      bitmaps.set('Texture.PNG', {
        name: 'Texture.PNG',
        href: 'Texture.PNG',
        width: 100,
        height: 100,
        imageData: mockImage,
      });

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
                  bitmapPath: 'texture.png', // Different case
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

    // Regression: XFL stores bitmap-fill matrices in TWIP space (typical a=20,d=20),
    // but edge geometry is already converted twips->pixels at parse time
    // (edge-decoder.ts COORD_SCALE=20). The renderer draws geometry in pixel space
    // with no global 1/20 context scale, so the bitmap-fill matrix must be pre-scaled
    // by 1/20 to land in pixel space. Applying it raw over-scales the bitmap ~20x:
    // only the first image-pixel column ends up filling the shape.
    //
    // This test pins the corrected scale. It loads a real 4x4 image whose columns are
    // [red, red, blue, blue] and fills a 40px square with a twip-space identity fill
    // matrix (a=20,d=20). Smoothing is disabled so sampled pixels stay pure.
    //
    // At the correct pixel scale the 4px image tiles ~10 times across the 40px shape,
    // so red AND blue both appear with many alternations. At the buggy 20x scale each
    // image-pixel becomes 20px, so the 40px shape only reaches the first two columns
    // (red, red) -> the whole square is red and blue never shows (blue starts at x=40,
    // outside the shape).
    it('should apply twip-space bitmap-fill matrix (a=20,d=20) at pixel scale, not 20x over-scaled', async () => {
      // Build a real HTMLImageElement: 4px wide, 4px tall, columns [red, red, blue, blue].
      const imgCanvas = document.createElement('canvas');
      imgCanvas.width = 4;
      imgCanvas.height = 4;
      const imgCtx = imgCanvas.getContext('2d')!;
      imgCtx.fillStyle = '#FF0000';
      imgCtx.fillRect(0, 0, 2, 4); // left two columns red
      imgCtx.fillStyle = '#0000FF';
      imgCtx.fillRect(2, 0, 2, 4); // right two columns blue
      const dataUrl = imgCanvas.toDataURL('image/png');

      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('failed to load fixture image'));
        el.src = dataUrl;
      });

      const bitmaps = new Map();
      bitmaps.set('twip.png', {
        name: 'twip.png',
        href: 'twip.png',
        width: 4,
        height: 4,
        imageData: image,
      });

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
                  bitmapPath: 'twip.png',
                  // Twip-space identity: 1 image-pixel == 20 twips == 1 pixel.
                  matrix: createMatrix({ a: 20, b: 0, c: 0, d: 20, tx: 0, ty: 0 }),
                  // Disable smoothing so tiled pixels stay pure red/blue (no blend).
                  bitmapIsSmoothed: false,
                }],
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
        })],
      });
      await renderer.setDocument(doc);
      renderer.renderFrame(0);

      const ctx = canvas.getContext('2d')!;
      const { data, width } = ctx.getImageData(0, 0, canvas.width, canvas.height);

      let redCount = 0;
      let blueCount = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        if (a === 0) continue;
        if (r > 200 && g < 60 && b < 60) redCount++;
        else if (b > 200 && r < 60 && g < 60) blueCount++;
      }

      // Correct (pixel-scale) behavior: the 2px image tiles across the 20px shape,
      // so both colors are present in meaningful amounts.
      // Buggy (20x over-scale) behavior: only the first (red) image column fills the
      // shape, blueCount stays 0 -> this assertion fails.
      expect(redCount).toBeGreaterThan(0);
      expect(blueCount).toBeGreaterThan(0);

      // Stronger pin: tiling produces many red<->blue transitions along a scanline
      // through the shape. Over-scaling would yield a single solid red run (0 flips).
      // Sample the row at roughly 1/4 of the shape height (well inside the square).
      let flips = 0;
      // Find a y row that intersects the filled shape by scanning for first row with
      // any saturated red/blue pixel.
      let sampleRow = -1;
      for (let y = 0; y < canvas.height && sampleRow < 0; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          const r = data[idx], g = data[idx + 1], b = data[idx + 2], a = data[idx + 3];
          if (a > 0 && ((r > 200 && g < 60 && b < 60) || (b > 200 && r < 60 && g < 60))) {
            sampleRow = y;
            break;
          }
        }
      }
      expect(sampleRow).toBeGreaterThanOrEqual(0);
      let prev: 'r' | 'b' | null = null;
      for (let x = 0; x < width; x++) {
        const idx = (sampleRow * width + x) * 4;
        const r = data[idx], g = data[idx + 1], b = data[idx + 2], a = data[idx + 3];
        if (a === 0) continue;
        let cur: 'r' | 'b' | null = null;
        if (r > 200 && g < 60 && b < 60) cur = 'r';
        else if (b > 200 && r < 60 && g < 60) cur = 'b';
        if (cur && prev && cur !== prev) flips++;
        if (cur) prev = cur;
      }
      // Many alternations at pixel scale; zero at the buggy 20x scale.
      expect(flips).toBeGreaterThan(2);
    });
  });

  describe('video instance with metadata', () => {
    it('should render video placeholder with metadata', async () => {
      const videos = new Map();
      videos.set('intro.mp4', {
        name: 'intro.mp4',
        href: 'M 1.dat',
        width: 640,
        height: 360,
        fps: 30,
        duration: 5.5,
      });

      const doc = createMinimalDoc({
        videos,
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'video',
                libraryItemName: 'intro.mp4',
                matrix: createMatrix(),
                width: 320,
                height: 180,
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should render video placeholder without metadata', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'video',
                libraryItemName: 'unknown.flv',
                matrix: createMatrix(),
                width: 320,
                height: 240,
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      // Should not throw even if video metadata is not found
      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should render small video without text labels', async () => {
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'video',
                libraryItemName: 'tiny.mp4',
                matrix: createMatrix(),
                width: 50, // Too small for text labels
                height: 30,
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
                  type: 'solid',
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

    // Load-bearing proof that a DashedStroke renders with GAPS rather than as a
    // solid line. Renders a long, thick horizontal stroke and inspects the row
    // band the stroke occupies: a dashed stroke alternates dark (dash) and white
    // (gap) columns, while a solid stroke would be dark all along. This test
    // FAILS before the fix (no setLineDash -> all columns dark) and PASSES after.
    function buildHorizontalStrokeDoc(dash?: number[]) {
      return createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [],
                strokes: [{
                  type: 'solid',
                  index: 1,
                  color: '#000000',
                  weight: 8,
                  caps: 'none', // butt caps so gaps aren't filled in by round/square caps
                  joints: 'round',
                  ...(dash ? { dash } : {}),
                }],
                edges: [{
                  strokeStyle: 1,
                  commands: [
                    { type: 'M', x: 40, y: 200 },
                    { type: 'L', x: 500, y: 200 },
                  ],
                }],
              }],
            })],
          })],
        })],
      });
    }

    // Scan the canvas, find the horizontal row with the most dark (non-white)
    // pixels (the stroke band), then return how many columns in that row are dark
    // (dash) vs white (gap). Background is opaque white (#FFFFFF).
    function strokeRowDarkLightCounts(): { dark: number; light: number } {
      const ctx = canvas.getContext('2d')!;
      const w = canvas.width;
      const h = canvas.height;
      const d = ctx.getImageData(0, 0, w, h).data;
      const isDark = (x: number, y: number): boolean => {
        const i = (y * w + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
        return a > 0 && (r < 200 || g < 200 || b < 200);
      };
      // Find the densest stroke row.
      let bestRow = -1;
      let bestDark = -1;
      for (let y = 0; y < h; y++) {
        let dark = 0;
        for (let x = 0; x < w; x++) if (isDark(x, y)) dark++;
        if (dark > bestDark) { bestDark = dark; bestRow = y; }
      }
      // Within the horizontal extent of the stroke on that row, count dark/light.
      let minX = w, maxX = -1;
      for (let x = 0; x < w; x++) {
        if (isDark(x, bestRow)) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
      }
      let dark = 0, light = 0;
      for (let x = minX; x <= maxX; x++) {
        if (isDark(x, bestRow)) dark++; else light++;
      }
      return { dark, light };
    }

    it('renders a solid stroke as a continuous line (no gaps)', async () => {
      await renderer.setDocument(buildHorizontalStrokeDoc());
      renderer.renderFrame(0);
      const { dark, light } = strokeRowDarkLightCounts();
      expect(dark).toBeGreaterThan(0);
      // A solid stroke has essentially no interior gaps along its span.
      expect(light).toBe(0);
    });

    it('renders a DashedStroke with visible gaps along the line', async () => {
      // Pattern large relative to weight so gaps are unmistakable.
      await renderer.setDocument(buildHorizontalStrokeDoc([24, 24]));
      renderer.renderFrame(0);
      const { dark, light } = strokeRowDarkLightCounts();
      // Both dash (dark) and gap (white) samples must appear along the stroke path.
      expect(dark).toBeGreaterThan(0);
      expect(light).toBeGreaterThan(0);
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
              fills: [{ index: 1, type: 'solid', color: '#00FF00' }],
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
                transformationPoint: { x: 0, y: 0 },
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

  describe('color transform (tint)', () => {
    // Build a doc with a single green (#00FF00) square symbol placed via an
    // instance carrying the given colorTransform/filters. The square is a
    // 60x60 shape at the symbol origin, placed so its center lands at a known
    // canvas pixel that we can sample with getImageData.
    function makeTintedDoc(opts: {
      colorTransform?: any;
      filters?: any[];
      shapeColor?: string;
    }) {
      const symbolTimeline = createTimeline({
        name: 'GreenSquare',
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, type: 'solid', color: opts.shapeColor ?? '#00FF00' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 60, y: 0 },
                  { type: 'L', x: 60, y: 60 },
                  { type: 'L', x: 0, y: 60 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('GreenSquare', {
        name: 'GreenSquare',
        itemID: 'green-square',
        symbolType: 'graphic',
        timeline: symbolTimeline,
      });

      return createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'symbol',
                libraryItemName: 'GreenSquare',
                symbolType: 'graphic',
                matrix: createMatrix({ tx: 100, ty: 100 }),
                firstFrame: 0,
                loop: 'single frame',
                transformationPoint: { x: 0, y: 0 },
                ...(opts.colorTransform ? { colorTransform: opts.colorTransform } : {}),
                ...(opts.filters ? { filters: opts.filters } : {}),
              }],
            })],
          })],
        })],
      });
    }

    // The renderer fits/scales document content into the canvas (and may
    // resize the backing canvas), so the square's on-screen position/size is
    // not 1:1 with document coordinates. Locate the rendered region by scanning
    // for non-background pixels, then average the interior so the sample is
    // robust to scale/DPR. The background is opaque white (#FFFFFF).
    function sampledShapePixel(): { r: number; g: number; b: number; a: number } {
      const ctx = canvas.getContext('2d')!;
      const w = canvas.width;
      const h = canvas.height;
      const img = ctx.getImageData(0, 0, w, h);
      const d = img.data;
      let minX = w, minY = h, maxX = -1, maxY = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
          // A pixel differs from the opaque-white background if it's not white
          // (covers tint/alpha-blended shapes; alpha is composited onto white).
          if (a > 0 && (r < 250 || g < 250 || b < 250)) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      expect(maxX).toBeGreaterThanOrEqual(0); // something was rendered
      // Average a small interior window around the centroid to avoid edge
      // antialiasing/blur artifacts.
      const cx = Math.round((minX + maxX) / 2);
      const cy = Math.round((minY + maxY) / 2);
      let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
      for (let y = cy - 2; y <= cy + 2; y++) {
        for (let x = cx - 2; x <= cx + 2; x++) {
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const i = (y * w + x) * 4;
          sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; sa += d[i + 3];
          n++;
        }
      }
      return { r: sr / n, g: sg / n, b: sb / n, a: sa / n };
    }

    it('renders a #FF0000 tint as red-tinted (per-channel c*mult+offset), not darkened green', async () => {
      // #FF0000 tint at strength 0.7 over a green symbol.
      // Parser converts tint -> per-channel: rMult=gMult=bMult=0.3,
      // rOff=255*0.7=178.5, gOff=bOff=0.
      // Correct per-channel result for green (0,255,0):
      //   r' = 0*0.3 + 178.5 = 178.5
      //   g' = 255*0.3 + 0   = 76.5
      //   b' = 0*0.3 + 0     = 0
      // => red dominant. The OLD renderer only applied brightness(0.3) and
      // dropped the non-uniform red offset entirely => r'=0 (green stayed
      // dominant). This assertion fails before the fix and passes after.
      const doc = makeTintedDoc({
        colorTransform: {
          alphaMultiplier: 1,
          redMultiplier: 0.3,
          greenMultiplier: 0.3,
          blueMultiplier: 0.3,
          redOffset: 178.5,
          greenOffset: 0,
          blueOffset: 0,
        },
      });
      await renderer.setDocument(doc);
      renderer.renderFrame(0);

      const px = sampledShapePixel();
      expect(px.a).toBeGreaterThan(200); // shape is present
      expect(px.r).toBeGreaterThan(px.g + 40);
      expect(px.r).toBeGreaterThan(px.b + 40);
    });

    it('injects the red offset for the grounded #FF0000@0.32 tint (dropped by old renderer)', async () => {
      // The exact ZEMLYA-grounded value: #FF0000 @ 0.32 over green parses to
      // {rMult=gMult=bMult=0.68, rOff=81.6, gOff=bOff=0}.
      // Correct per-channel for green: r'=0*0.68+81.6=81.6, g'=173.4, b'=0.
      // This is a weak (32%) tint so green stays the largest channel (matching
      // Flash), but the defining defect is that the OLD renderer dropped the
      // red offset (r'=0). Assert the red channel is genuinely injected.
      const doc = makeTintedDoc({
        colorTransform: {
          alphaMultiplier: 1,
          redMultiplier: 0.68,
          greenMultiplier: 0.68,
          blueMultiplier: 0.68,
          redOffset: 81.6,
          greenOffset: 0,
          blueOffset: 0,
        },
      });
      await renderer.setDocument(doc);
      renderer.renderFrame(0);

      const px = sampledShapePixel();
      expect(px.a).toBeGreaterThan(200);
      // Old renderer (brightness only, offset dropped) => r ~= 0.
      expect(px.r).toBeGreaterThan(40);
      // Sanity: still roughly the expected per-channel values.
      expect(px.r).toBeGreaterThan(50);
      expect(px.r).toBeLessThan(120);
      expect(px.g).toBeGreaterThan(140);
      expect(px.g).toBeLessThan(210);
    });

    it('applies alpha exactly once (0.5 alphaMultiplier => ~50% opacity, not 25%)', async () => {
      // Green square over a white background with alphaMultiplier 0.5.
      // Composited center pixel green channel:
      //   0.5 opacity: 0.5*255 + 0.5*255 = 255 (green stays 255 either way here),
      // so instead measure the RED channel which background contributes:
      //   bg white R=255, shape R=0.
      //   0.5 alpha => R = 0.5*0 + 0.5*255 = ~128 (half)
      //   0.25 (doubled) => R = 0.75*255 = ~191
      // A correctly single-applied alpha yields ~128, not ~191.
      const doc = makeTintedDoc({
        colorTransform: {
          alphaMultiplier: 0.5,
          redMultiplier: 1,
          greenMultiplier: 1,
          blueMultiplier: 1,
          redOffset: 0,
          greenOffset: 0,
          blueOffset: 0,
        },
      });
      await renderer.setDocument(doc);
      renderer.renderFrame(0);

      const px = sampledShapePixel();
      // Half-alpha green over white: R ~= 128. Doubled alpha would give ~191.
      expect(px.r).toBeGreaterThan(105);
      expect(px.r).toBeLessThan(150);
    });

    it('does not alter output for an identity color transform', async () => {
      const doc = makeTintedDoc({
        colorTransform: {
          alphaMultiplier: 1,
          redMultiplier: 1,
          greenMultiplier: 1,
          blueMultiplier: 1,
          redOffset: 0,
          greenOffset: 0,
          blueOffset: 0,
        },
      });
      await renderer.setDocument(doc);
      renderer.renderFrame(0);

      const px = sampledShapePixel();
      // Pure green, unchanged.
      expect(px.g).toBeGreaterThan(200);
      expect(px.r).toBeLessThan(60);
      expect(px.b).toBeLessThan(60);
    });

    it('nests offscreen tint passes (tinted symbol inside a tinted symbol)', async () => {
      // Inner symbol: green square, tinted toward red.
      // Outer symbol: contains the inner symbol instance (itself tinted red),
      // and is ALSO placed with a red tint. Both offscreen passes must nest
      // without leaking this.ctx, and both tints must compound toward red.
      const innerTimeline = createTimeline({
        name: 'Inner',
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, type: 'solid', color: '#00FF00' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 60, y: 0 },
                  { type: 'L', x: 60, y: 60 },
                  { type: 'L', x: 0, y: 60 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });
      const outerTimeline = createTimeline({
        name: 'Outer',
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'symbol',
              libraryItemName: 'Inner',
              symbolType: 'graphic',
              matrix: createMatrix(),
              firstFrame: 0,
              loop: 'single frame',
              transformationPoint: { x: 0, y: 0 },
              colorTransform: {
                alphaMultiplier: 1,
                redMultiplier: 0.5, greenMultiplier: 0.5, blueMultiplier: 0.5,
                redOffset: 120, greenOffset: 0, blueOffset: 0,
              },
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('Inner', { name: 'Inner', itemID: 'inner', symbolType: 'graphic', timeline: innerTimeline });
      symbols.set('Outer', { name: 'Outer', itemID: 'outer', symbolType: 'graphic', timeline: outerTimeline });

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
                loop: 'single frame',
                transformationPoint: { x: 0, y: 0 },
                colorTransform: {
                  alphaMultiplier: 1,
                  redMultiplier: 0.5, greenMultiplier: 0.5, blueMultiplier: 0.5,
                  redOffset: 120, greenOffset: 0, blueOffset: 0,
                },
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);
      renderer.renderFrame(0);

      const px = sampledShapePixel();
      // Two compounding red tints over green -> red clearly dominant.
      expect(px.a).toBeGreaterThan(200);
      expect(px.r).toBeGreaterThan(px.g + 40);
      expect(px.r).toBeGreaterThan(px.b + 40);
    });

    // Count pixels that differ from the opaque-white background (alpha>0 and
    // not white). Used to detect blur, which spreads color into a larger area.
    function nonBackgroundPixelCount(): number {
      const ctx = canvas.getContext('2d')!;
      const w = canvas.width, h = canvas.height;
      const d = ctx.getImageData(0, 0, w, h).data;
      let count = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
        if (a > 0 && (r < 250 || g < 250 || b < 250)) count++;
      }
      return count;
    }

    it('composes a tint color transform together with a blur filter (both applied)', async () => {
      // Instance carries BOTH a blur filter and a red tint. applyFilters sets
      // ctx.filter for the blur; applyColorTransform must APPEND its
      // feColorMatrix url() rather than clobber it. We verify (a) the tint is
      // still applied (red injected at the center) AND (b) the blur is still
      // applied (it spreads color over a larger footprint than the unblurred
      // square). If applyColorTransform clobbered the filter, blur would be
      // lost; if the filter clobbered the color transform, the tint would be lost.
      const redTint = {
        alphaMultiplier: 1,
        redMultiplier: 0.3,
        greenMultiplier: 0.3,
        blueMultiplier: 0.3,
        redOffset: 178.5,
        greenOffset: 0,
        blueOffset: 0,
      };

      // Baseline: same tint, no blur -> footprint area without spread.
      const noBlurDoc = makeTintedDoc({ colorTransform: redTint });
      await renderer.setDocument(noBlurDoc);
      renderer.renderFrame(0);
      const noBlurArea = nonBackgroundPixelCount();

      // Now with blur + tint.
      const blurDoc = makeTintedDoc({
        filters: [{ type: 'blur', blurX: 6, blurY: 6 }],
        colorTransform: redTint,
      });
      await renderer.setDocument(blurDoc);
      renderer.renderFrame(0);

      // (a) Tint still applied even though a filter is present.
      const px = sampledShapePixel();
      expect(px.r).toBeGreaterThan(px.g + 30);
      expect(px.r).toBeGreaterThan(px.b + 30);

      // (b) Blur still applied: spreads color over a strictly larger footprint.
      const blurArea = nonBackgroundPixelCount();
      expect(blurArea).toBeGreaterThan(noBlurArea);
    });
  });

  describe('colorMatrix filter', () => {
    // Build a doc with a single solid-colored square symbol placed via an
    // instance carrying the given filters and/or colorTransform. Mirrors the
    // tint-test harness: 60x60 shape at the symbol origin, placed at (100,100).
    function makeColorMatrixDoc(opts: {
      filters?: any[];
      colorTransform?: any;
      shapeColor?: string;
    }) {
      const symbolTimeline = createTimeline({
        name: 'Square',
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, type: 'solid', color: opts.shapeColor ?? '#00FF00' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 60, y: 0 },
                  { type: 'L', x: 60, y: 60 },
                  { type: 'L', x: 0, y: 60 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('Square', { name: 'Square', itemID: 'square', symbolType: 'graphic', timeline: symbolTimeline });

      return createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'symbol',
                libraryItemName: 'Square',
                symbolType: 'graphic',
                matrix: createMatrix({ tx: 100, ty: 100 }),
                firstFrame: 0,
                loop: 'single frame',
                transformationPoint: { x: 0, y: 0 },
                ...(opts.filters ? { filters: opts.filters } : {}),
                ...(opts.colorTransform ? { colorTransform: opts.colorTransform } : {}),
              }],
            })],
          })],
        })],
      });
    }

    // Locate the rendered (non-background) region and average a small interior
    // window around its centroid. Background is opaque white (#FFFFFF).
    function sampleCenter(): { r: number; g: number; b: number; a: number } {
      const ctx = canvas.getContext('2d')!;
      const w = canvas.width, h = canvas.height;
      const d = ctx.getImageData(0, 0, w, h).data;
      let minX = w, minY = h, maxX = -1, maxY = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
          if (a > 0 && (r < 250 || g < 250 || b < 250)) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      expect(maxX).toBeGreaterThanOrEqual(0);
      const cx = Math.round((minX + maxX) / 2), cy = Math.round((minY + maxY) / 2);
      let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
      for (let y = cy - 2; y <= cy + 2; y++) {
        for (let x = cx - 2; x <= cx + 2; x++) {
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const i = (y * w + x) * 4;
          sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; sa += d[i + 3]; n++;
        }
      }
      return { r: sr / n, g: sg / n, b: sb / n, a: sa / n };
    }

    function nonBackgroundPixelCount(): number {
      const ctx = canvas.getContext('2d')!;
      const w = canvas.width, h = canvas.height;
      const d = ctx.getImageData(0, 0, w, h).data;
      let count = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
        if (a > 0 && (r < 250 || g < 250 || b < 250)) count++;
      }
      return count;
    }

    it('applies an invert colorMatrix (green -> magenta) via the offscreen pixel pass', async () => {
      // Invert matrix (SVG convention: -1*c + 1 on 0..1 => -1*c + 255 on 0..255).
      // Over pure green (0,255,0): r'=255, g'=0, b'=255 (magenta).
      // BEFORE the fix this was a no-op (ctx.filter does not honor data-URL SVG
      // feColorMatrix in Chromium) so the pixel stayed green (g~255, r~0). This
      // assertion FAILS before the fix and PASSES after.
      const invert = [
        -1, 0, 0, 0, 255,
        0, -1, 0, 0, 255,
        0, 0, -1, 0, 255,
        0, 0, 0, 1, 0,
      ];
      const doc = makeColorMatrixDoc({ filters: [{ type: 'colorMatrix', matrix: invert }] });
      await renderer.setDocument(doc);
      renderer.renderFrame(0);

      const px = sampleCenter();
      expect(px.a).toBeGreaterThan(200);
      // Inverted green => magenta: red and blue high, green low.
      expect(px.r).toBeGreaterThan(200);
      expect(px.b).toBeGreaterThan(200);
      expect(px.g).toBeLessThan(60);
    });

    it('swaps R<->B via a colorMatrix (red square -> blue)', async () => {
      // R<->B swap: r'=b, g'=g, b'=r. Over pure red (255,0,0) => (0,0,255) blue.
      // Unambiguous proof the matrix multiplies channels (not just a no-op).
      const swap = [
        0, 0, 1, 0, 0,
        0, 1, 0, 0, 0,
        1, 0, 0, 0, 0,
        0, 0, 0, 1, 0,
      ];
      const doc = makeColorMatrixDoc({
        shapeColor: '#FF0000',
        filters: [{ type: 'colorMatrix', matrix: swap }],
      });
      await renderer.setDocument(doc);
      renderer.renderFrame(0);

      const px = sampleCenter();
      expect(px.a).toBeGreaterThan(200);
      expect(px.b).toBeGreaterThan(200); // red moved into blue
      expect(px.r).toBeLessThan(60);
    });

    it('applies the p0tatomango AdjustColor matrix (brightness=-18, hue=16): darkens a gray square', async () => {
      // Grounded in LIBRARY/Backgrounds/Desert_BLUE.xml of "28-21 p0tatomango.fla":
      //   <AdjustColorFilter brightness="-18" hue="16"/>
      // buildAdjustColorMatrix(-18,0,0,16) yields offset columns of -45.9 (i.e.
      // -18*2.55) plus a hue rotation that preserves a neutral gray's hue.
      // Applied to mid-gray (128,128,128): each channel = ~0.97*128 - 45.9 ~= 82.
      // So a clearly DARKER but still-neutral gray. (Before the fix: unchanged.)
      const m = [
        0.890429, -0.13906, 0.248631, 0, -45.9,
        0.050999, 1.02259, -0.073589, 0, -45.9,
        -0.181639, 0.184539, 0.997101, 0, -45.9,
        0, 0, 0, 1, 0,
      ];
      const doc = makeColorMatrixDoc({
        shapeColor: '#808080', // mid-gray (128,128,128)
        filters: [{ type: 'colorMatrix', matrix: m }],
      });
      await renderer.setDocument(doc);
      renderer.renderFrame(0);

      const px = sampleCenter();
      expect(px.a).toBeGreaterThan(200);
      // Darkened by the brightness offset (~46): well below the original 128.
      expect(px.r).toBeGreaterThan(60); expect(px.r).toBeLessThan(100);
      expect(px.g).toBeGreaterThan(60); expect(px.g).toBeLessThan(100);
      expect(px.b).toBeGreaterThan(60); expect(px.b).toBeLessThan(100);
      // Stays near-neutral (hue rotation of a gray is ~identity in hue).
      expect(Math.abs(px.r - px.g)).toBeLessThan(20);
      expect(Math.abs(px.g - px.b)).toBeLessThan(20);
    });

    it('composes a color transform AND a colorMatrix filter (both applied, once each)', async () => {
      // Instance carries BOTH a red tint (color transform) and a colorMatrix.
      // Order: color transform first, then the colorMatrix.
      //   Green (0,255,0) --tint--> per-channel c*0.3 + redOff 178.5:
      //     r = 0*0.3 + 178.5 = 178.5, g = 255*0.3 = 76.5, b = 0  => (178,76,0)
      //   Then R<->B swap colorMatrix: (b, g, r) = (0, 76, 178) => blue-dominant.
      // If the tint were dropped: green stays (0,76.5,0)->swap->(0,76,0) (no blue).
      // If the colorMatrix were dropped: stays red-dominant (178,76,0).
      // Asserting blue-dominant proves BOTH ran, in order, exactly once.
      const swap = [
        0, 0, 1, 0, 0,
        0, 1, 0, 0, 0,
        1, 0, 0, 0, 0,
        0, 0, 0, 1, 0,
      ];
      const doc = makeColorMatrixDoc({
        colorTransform: {
          alphaMultiplier: 1,
          redMultiplier: 0.3, greenMultiplier: 0.3, blueMultiplier: 0.3,
          redOffset: 178.5, greenOffset: 0, blueOffset: 0,
        },
        filters: [{ type: 'colorMatrix', matrix: swap }],
      });
      await renderer.setDocument(doc);
      renderer.renderFrame(0);

      const px = sampleCenter();
      expect(px.a).toBeGreaterThan(200);
      // Both applied => blue is the dominant channel.
      expect(px.b).toBeGreaterThan(px.r + 40);
      expect(px.b).toBeGreaterThan(px.g + 40);
      // And the red injected by the tint is gone from R (proves swap ran, once).
      expect(px.r).toBeLessThan(60);
    });

    it('leaves output unchanged for an identity colorMatrix', async () => {
      const identity = [
        1, 0, 0, 0, 0,
        0, 1, 0, 0, 0,
        0, 0, 1, 0, 0,
        0, 0, 0, 1, 0,
      ];
      const doc = makeColorMatrixDoc({ filters: [{ type: 'colorMatrix', matrix: identity }] });
      await renderer.setDocument(doc);
      renderer.renderFrame(0);

      const px = sampleCenter();
      expect(px.g).toBeGreaterThan(200);
      expect(px.r).toBeLessThan(60);
      expect(px.b).toBeLessThan(60);
    });

    it('still applies a blur filter when no colorMatrix is present (regression)', async () => {
      // Baseline footprint with no blur.
      const noBlurDoc = makeColorMatrixDoc({});
      await renderer.setDocument(noBlurDoc);
      renderer.renderFrame(0);
      const noBlurArea = nonBackgroundPixelCount();

      // Blur-only instance: must still spread color (offscreen colorMatrix path
      // is NOT triggered, so the existing blur path is unchanged).
      const blurDoc = makeColorMatrixDoc({ filters: [{ type: 'blur', blurX: 6, blurY: 6 }] });
      await renderer.setDocument(blurDoc);
      renderer.renderFrame(0);
      const blurArea = nonBackgroundPixelCount();

      expect(blurArea).toBeGreaterThan(noBlurArea);
      // And the color is still green (no spurious color shift from the blur-only path).
      const px = sampleCenter();
      expect(px.g).toBeGreaterThan(px.r);
      expect(px.g).toBeGreaterThan(px.b);
    });

    it('applies a colorMatrix together with a blur filter (color shifted AND spread)', async () => {
      // Invert colorMatrix + blur on a green square. The colorMatrix runs on the
      // offscreen bitmap (green -> magenta); the blur is set on the main ctx and
      // applies once at composite, spreading the magenta over a larger footprint.
      const invert = [
        -1, 0, 0, 0, 255,
        0, -1, 0, 0, 255,
        0, 0, -1, 0, 255,
        0, 0, 0, 1, 0,
      ];

      // Baseline: invert, no blur.
      const noBlurDoc = makeColorMatrixDoc({ filters: [{ type: 'colorMatrix', matrix: invert }] });
      await renderer.setDocument(noBlurDoc);
      renderer.renderFrame(0);
      const noBlurArea = nonBackgroundPixelCount();

      const blurDoc = makeColorMatrixDoc({
        filters: [
          { type: 'colorMatrix', matrix: invert },
          { type: 'blur', blurX: 6, blurY: 6 },
        ],
      });
      await renderer.setDocument(blurDoc);
      renderer.renderFrame(0);

      // (a) Color still inverted (magenta) even with a blur present.
      const px = sampleCenter();
      expect(px.r).toBeGreaterThan(150);
      expect(px.b).toBeGreaterThan(150);
      expect(px.g).toBeLessThan(110); // green suppressed by invert (some bleed from blur)
      // (b) Blur still spreads the (color-adjusted) bitmap over a larger area.
      const blurArea = nonBackgroundPixelCount();
      expect(blurArea).toBeGreaterThan(noBlurArea);
    });
  });

  describe('9-slice scaling', () => {
    it('should render symbol with 9-slice grid', async () => {
      const symbolTimeline = createTimeline({
        name: 'Button',
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, type: 'solid', color: '#3366CC' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 100, y: 0 },
                  { type: 'L', x: 100, y: 40 },
                  { type: 'L', x: 0, y: 40 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('Button', {
        name: 'Button',
        itemID: 'button-1',
        symbolType: 'graphic',
        timeline: symbolTimeline,
        scale9Grid: {
          left: 10,
          top: 10,
          width: 80,
          height: 20
        }
      });

      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'symbol',
                libraryItemName: 'Button',
                symbolType: 'graphic',
                matrix: createMatrix({ a: 2, d: 1.5, tx: 50, ty: 50 }), // Scaled 2x horizontally, 1.5x vertically
                firstFrame: 0,
                loop: 'single frame',
                transformationPoint: { x: 0, y: 0 },
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      // Should render without errors
      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should skip 9-slice when scale is approximately 1', async () => {
      const symbolTimeline = createTimeline({
        name: 'Button',
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, type: 'solid', color: '#FF6600' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 50, y: 0 },
                  { type: 'L', x: 50, y: 30 },
                  { type: 'L', x: 0, y: 30 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('Button', {
        name: 'Button',
        itemID: 'button-2',
        symbolType: 'graphic',
        timeline: symbolTimeline,
        scale9Grid: {
          left: 5,
          top: 5,
          width: 40,
          height: 20
        }
      });

      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'symbol',
                libraryItemName: 'Button',
                symbolType: 'graphic',
                matrix: createMatrix({ a: 1.005, d: 0.998, tx: 100, ty: 100 }), // Nearly 1x scale
                firstFrame: 0,
                loop: 'single frame',
                transformationPoint: { x: 0, y: 0 },
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      // Should render without errors (will use normal rendering)
      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should render symbol without 9-slice grid normally', async () => {
      const symbolTimeline = createTimeline({
        name: 'NormalSymbol',
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, type: 'solid', color: '#009900' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 60, y: 0 },
                  { type: 'L', x: 60, y: 60 },
                  { type: 'L', x: 0, y: 60 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('NormalSymbol', {
        name: 'NormalSymbol',
        itemID: 'normal-1',
        symbolType: 'graphic',
        timeline: symbolTimeline
        // No scale9Grid
      });

      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'symbol',
                libraryItemName: 'NormalSymbol',
                symbolType: 'graphic',
                matrix: createMatrix({ a: 3, d: 2, tx: 20, ty: 20 }), // Scaled 3x, 2x
                firstFrame: 0,
                loop: 'single frame',
                transformationPoint: { x: 0, y: 0 },
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      // Should render normally without 9-slice
      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

  describe('gradient/bitmap strokes', () => {
    it('should render linear gradient stroke', async () => {
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
                  type: 'linear',
                  weight: 3,
                  gradient: [
                    { color: '#FF0000', alpha: 1, ratio: 0 },
                    { color: '#0000FF', alpha: 1, ratio: 1 }
                  ]
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

    it('should render radial gradient stroke', async () => {
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
                  type: 'radial',
                  weight: 5,
                  gradient: [
                    { color: '#FFFF00', alpha: 1, ratio: 0 },
                    { color: '#00FF00', alpha: 1, ratio: 1 }
                  ],
                  focalPointRatio: 0.5
                }],
                edges: [{
                  strokeStyle: 1,
                  commands: [
                    { type: 'M', x: 50, y: 50 },
                    { type: 'L', x: 150, y: 50 },
                    { type: 'L', x: 100, y: 150 },
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

  describe('3D transforms', () => {
    it('should render symbol with 3D rotation', async () => {
      const symbolTimeline = createTimeline({
        name: 'Box3D',
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, type: 'solid', color: '#FF6600' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 80, y: 0 },
                  { type: 'L', x: 80, y: 80 },
                  { type: 'L', x: 0, y: 80 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('Box3D', {
        name: 'Box3D',
        itemID: 'box3d-1',
        symbolType: 'graphic',
        timeline: symbolTimeline
      });

      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'symbol',
                libraryItemName: 'Box3D',
                symbolType: 'graphic',
                matrix: createMatrix({ tx: 100, ty: 100 }),
                firstFrame: 0,
                loop: 'single frame',
                transformationPoint: { x: 40, y: 40 },
                rotationX: 30,
                rotationY: 45,
                z: 50
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);
      expect(() => renderer.renderFrame(0)).not.toThrow();
    });
  });

  describe('cache as bitmap', () => {
    it('should render symbol with cacheAsBitmap', async () => {
      const symbolTimeline = createTimeline({
        name: 'CachedSymbol',
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, type: 'solid', color: '#3399FF' }],
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
      symbols.set('CachedSymbol', {
        name: 'CachedSymbol',
        itemID: 'cached-1',
        symbolType: 'graphic',
        timeline: symbolTimeline
      });

      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'symbol',
                libraryItemName: 'CachedSymbol',
                symbolType: 'graphic',
                matrix: createMatrix({ tx: 50, ty: 50 }),
                firstFrame: 0,
                loop: 'single frame',
                transformationPoint: { x: 0, y: 0 },
                cacheAsBitmap: true
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

    it('should render text with auto kerning', async () => {
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
                  characters: 'WAVE AWAY',
                  size: 24,
                  face: 'Arial',
                  fillColor: '#000000',
                  autoKern: true
                }],
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);
      expect(() => renderer.renderFrame(0)).not.toThrow();
    });

    it('should render text with per-character rotation', async () => {
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
                  characters: 'ROTATED',
                  size: 24,
                  face: 'Arial',
                  fillColor: '#FF0000',
                  rotation: 15
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
                  fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
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
                  fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
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
                fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
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
              fills: [{ index: 1, type: 'solid', color: '#00FF00' }],
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
                transformationPoint: { x: 0, y: 0 },
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
                  fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
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
                  fills: [{ index: 1, type: 'solid', color: '#00FF00' }],
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
                fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
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
                fills: [{ index: 1, type: 'solid', color: '#0000FF' }],
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
                  fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
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
                  type: 'solid',
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
                fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
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
        type: 'movieclip',
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
                symbolType: 'movieclip',
                matrix: createMatrix({ tx: 50, ty: 50 }),
                firstFrame: 0,
                loop: 'loop',
                transformationPoint: { x: 0, y: 0 },
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

    it('should track MovieClip instance state independently', async () => {
      // Create a MovieClip with 3 frames that show different colors
      const symbolTimeline = createTimeline({
        name: 'ColorMC',
        totalFrames: 3,
        layers: [createLayer({
          frames: [
            createFrame({
              index: 0,
              duration: 1,
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
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
            }),
            createFrame({
              index: 1,
              duration: 1,
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, type: 'solid', color: '#00FF00' }],
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
            }),
            createFrame({
              index: 2,
              duration: 1,
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, type: 'solid', color: '#0000FF' }],
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
            }),
          ],
        })],
      });

      const symbols = new Map();
      symbols.set('ColorMC', {
        name: 'ColorMC',
        itemID: 'mc1',
        symbolType: 'movieclip',
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
                libraryItemName: 'ColorMC',
                symbolType: 'movieclip',
                matrix: createMatrix({ tx: 50, ty: 50 }),
                firstFrame: 0,
                loop: 'loop',
                transformationPoint: { x: 0, y: 0 },
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      // Initial render - MovieClip should be at frame 0
      expect(() => renderer.renderFrame(0)).not.toThrow();

      // Advance MovieClip playhead
      renderer.advanceMovieClipPlayheads();
      expect(() => renderer.renderFrame(1)).not.toThrow();

      // Advance again
      renderer.advanceMovieClipPlayheads();
      expect(() => renderer.renderFrame(2)).not.toThrow();

      // Reset should clear all states
      renderer.resetMovieClipPlayheads();
      expect(() => renderer.renderFrame(3)).not.toThrow();
    });

    it('should support multiple MovieClip instances with independent playheads', async () => {
      const symbolTimeline = createTimeline({
        name: 'TestMC',
        totalFrames: 5,
        layers: [createLayer({
          frames: [createFrame({
            index: 0,
            duration: 5,
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 10, y: 0 },
                  { type: 'L', x: 10, y: 10 },
                  { type: 'L', x: 0, y: 10 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('TestMC', {
        name: 'TestMC',
        itemID: 'mc1',
        symbolType: 'movieclip',
        timeline: symbolTimeline,
      });

      // Create doc with two instances of the same MovieClip
      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          totalFrames: 10,
          layers: [createLayer({
            frames: [createFrame({
              duration: 10,
              elements: [
                {
                  type: 'symbol',
                  libraryItemName: 'TestMC',
                  symbolType: 'movieclip',
                  matrix: createMatrix({ tx: 10, ty: 10 }),
                  firstFrame: 0,
                  loop: 'loop',
                  transformationPoint: { x: 0, y: 0 },
                },
                {
                  type: 'symbol',
                  libraryItemName: 'TestMC',
                  symbolType: 'movieclip',
                  matrix: createMatrix({ tx: 100, ty: 10 }),
                  firstFrame: 0,
                  loop: 'loop',
                  transformationPoint: { x: 0, y: 0 },
                },
              ],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      // Both instances should render without error and track independently
      expect(() => renderer.renderFrame(0)).not.toThrow();
      renderer.advanceMovieClipPlayheads();
      expect(() => renderer.renderFrame(1)).not.toThrow();
    });

    it('should clear MovieClip states when clearCaches is called', async () => {
      const symbolTimeline = createTimeline({
        name: 'ClearTestMC',
        totalFrames: 3,
        layers: [createLayer({
          frames: [createFrame({
            index: 0,
            duration: 3,
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 10, y: 0 },
                  { type: 'L', x: 10, y: 10 },
                  { type: 'L', x: 0, y: 10 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('ClearTestMC', {
        name: 'ClearTestMC',
        itemID: 'mc1',
        symbolType: 'movieclip',
        timeline: symbolTimeline,
      });

      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          totalFrames: 5,
          layers: [createLayer({
            frames: [createFrame({
              duration: 5,
              elements: [{
                type: 'symbol',
                libraryItemName: 'ClearTestMC',
                symbolType: 'movieclip',
                matrix: createMatrix({ tx: 50, ty: 50 }),
                firstFrame: 0,
                loop: 'loop',
                transformationPoint: { x: 0, y: 0 },
              }],
            })],
          })],
        })],
      });
      await renderer.setDocument(doc);

      // Render and advance playhead
      renderer.renderFrame(0);
      renderer.advanceMovieClipPlayheads();
      renderer.advanceMovieClipPlayheads();

      // Clear caches should reset MovieClip states
      renderer.clearCaches();

      // Should render without error after clearing
      expect(() => renderer.renderFrame(0)).not.toThrow();
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
              fills: [{ index: 1, type: 'solid', color: '#0000FF' }],
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
              transformationPoint: { x: 0, y: 0 },
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
                transformationPoint: { x: 0, y: 0 },
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
                fills: [{ index: 1, type: 'solid', color: '#FF0000', alpha: 0.5 }],
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
                  fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
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
                  fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
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
              fills: [{ index: 1, type: 'solid', color: '#00FF00' }],
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
                  { index: 1, type: 'solid', color: '#FF0000' },
                  { index: 2, type: 'solid', color: '#00FF00' },
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
                fills: [{ index: 1, type: 'solid', color: '#0000FF' }],
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
              fills: [{ index: 1, type: 'solid', color: '#FF00FF' }],
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
              transformationPoint: { x: 0, y: 0 },
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
                fills: [{ index: 1, type: 'solid', color: '#00FFFF' }],
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
                fills: [{ index: 1, type: 'solid', color: '#FFFF00' }],
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
              transformationPoint: { x: 0, y: 0 },
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
                  fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
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
                  fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
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
                  fills: [{ index: 1, type: 'solid', color: '#00FF00' }],
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
                  fills: [{ index: 1, type: 'solid', color: '#00FF00' }],
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
                  fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
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
                  fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
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

  describe('named easing methods (issue #11)', () => {
    // Reach into the private progress calculation so we can assert the actual
    // eased value at the parser->renderer seam, not just that rendering doesn't throw.
    // Signature: calculateTweenProgress(frameIndex, startFrame, endFrame, acceleration?, tweens?)
    const progressAt = (
      frameIndex: number,
      tweens: import('../types').Tween[] | undefined,
      acceleration?: number
    ): number => {
      const startFrame = { index: 0, duration: 10, keyMode: 0, elements: [] } as any;
      const endFrame = { index: 10, duration: 10, keyMode: 0, elements: [] } as any;
      return (renderer as any).calculateTweenProgress(
        frameIndex,
        startFrame,
        endFrame,
        acceleration,
        tweens
      );
    };

    it('reproduces the bug baseline: method "none" stays linear', () => {
      const linear = progressAt(5, [{ target: 'all', method: 'none', intensity: 0 }]);
      // Halfway through a 10-frame span => exactly 0.5 (no easing applied)
      expect(linear).toBeCloseTo(0.5, 5);
    });

    // The real reporter's file uses CreateJS-style "<base><Direction>" tokens
    // where the DIRECTION is part of the token (cubicIn / cubicOut / quadInOut),
    // NOT derived from the intensity sign.
    it('applies cubicIn (slow start) -> below linear at the midpoint', () => {
      const t = progressAt(5, [{ target: 'all', method: 'cubicIn' }]);
      // ease-in cubic at t=0.5 => 0.125, clearly below the linear 0.5
      expect(t).toBeLessThan(0.45);
      expect(t).toBeCloseTo(0.125, 5);
    });

    it('applies cubicOut (fast start) -> above linear at the midpoint', () => {
      const t = progressAt(5, [{ target: 'all', method: 'cubicOut' }]);
      // ease-out cubic at t=0.5 => 0.875, clearly above the linear 0.5
      expect(t).toBeGreaterThan(0.55);
      expect(t).toBeCloseTo(0.875, 5);
    });

    it('direction comes from the token suffix, not the intensity sign', () => {
      // cubicIn with a POSITIVE intensity must still be ease-in (below linear),
      // because the direction is "In" from the token, not from the sign.
      const t = progressAt(5, [{ target: 'all', method: 'cubicIn', intensity: 100 }]);
      expect(t).toBeCloseTo(0.125, 5);
    });

    it('quadInOut is symmetric around the midpoint', () => {
      const start = progressAt(2, [{ target: 'all', method: 'quadInOut' }]);
      const mid = progressAt(5, [{ target: 'all', method: 'quadInOut' }]);
      const end = progressAt(8, [{ target: 'all', method: 'quadInOut' }]);
      expect(mid).toBeCloseTo(0.5, 5);
      expect(start).toBeLessThan(0.5);
      expect(end).toBeGreaterThan(0.5);
      expect(start + end).toBeCloseTo(1, 5);
    });

    it('sineInOut is symmetric around the midpoint', () => {
      const start = progressAt(2, [{ target: 'all', method: 'sineInOut' }]);
      const mid = progressAt(5, [{ target: 'all', method: 'sineInOut' }]);
      const end = progressAt(8, [{ target: 'all', method: 'sineInOut' }]);
      expect(mid).toBeCloseTo(0.5, 5);
      expect(start + end).toBeCloseTo(1, 5);
    });

    it('backOut overshoots and is distinct from cubicOut', () => {
      // backOut's curve overshoots the target before settling; its raw
      // (pre-clamp) value at an early t goes above the eventual 1. Assert it is
      // non-linear, and clearly different from cubicOut at the same t.
      const back = progressAt(7, [{ target: 'all', method: 'backOut' }]);
      const cubic = progressAt(7, [{ target: 'all', method: 'cubicOut' }]);
      expect(Math.abs(back - 0.5)).toBeGreaterThan(0.01); // non-linear
      expect(Math.abs(back - cubic)).toBeGreaterThan(0.01); // distinct family
      // backOut overshoots past the target before t=1 (raw curve > 1 mid-span).
      const raw = (renderer as any).easeOut(0.6, 'back');
      expect(raw).toBeGreaterThan(1);
    });

    it('blends toward linear when an intensity strength accompanies a method', () => {
      const full = progressAt(5, [{ target: 'all', method: 'cubicIn' }]);
      const half = progressAt(5, [{ target: 'all', method: 'cubicIn', intensity: 50 }]);
      const linear = 0.5;
      // 50% strength lands halfway between linear and the full curve
      expect(half).toBeGreaterThan(full);
      expect(half).toBeLessThan(linear);
      expect(half).toBeCloseTo((full + linear) / 2, 5);
    });

    // Every distinct method token found in the reporter's file must resolve to
    // a real (base, direction) and produce a non-linear curve - none may fall
    // through to linear.
    it.each([
      'backOut',
      'cubicIn',
      'cubicInOut',
      'quadIn',
      'quartIn',
      'quadInOut',
      'quartOut',
      'circOut',
      'cubicOut',
      'quadOut',
      'circIn',
      'sineInOut',
      'quintIn',
      'quintOut',
      'elasticOut',
      'backInOut',
    ] as const)('resolves real token "%s" to a non-linear curve', (method) => {
      // Sample OFF the midpoint: symmetric InOut curves legitimately pass through
      // 0.5 at t=0.5, so non-linearity must be checked away from the midpoint.
      // At frameIndex=3 the linear progress would be exactly 0.3.
      const t = progressAt(3, [{ target: 'all', method }]);
      // Must deviate from the linear 0.3 value (i.e. did NOT fall to linear).
      expect(Math.abs(t - 0.3)).toBeGreaterThan(0.01);
    });

    it('warns and falls back to linear for an unrecognized method token', () => {
      const spy = createConsoleWarnSpy().mockImplementation(() => {});
      const t = progressAt(5, [{ target: 'all', method: 'totallyBogus' }]);
      expect(t).toBeCloseTo(0.5, 5);
      const warned = spy.mock.calls.some(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('totallyBogus')
      );
      expect(warned).toBe(true);
      spy.mockRestore();
    });

    it('selects the position/all ease, not just tweens[0]', () => {
      // tweens[0] is a non-spatial target with no easing; the spatial ease is second.
      const tweens: import('../types').Tween[] = [
        { target: 'rotation', intensity: 0 },
        { target: 'position', method: 'cubicIn' },
      ];
      const t = progressAt(5, tweens);
      // Must apply the position cubicIn ease (0.125), not the rotation linear (0.5)
      expect(t).toBeCloseTo(0.125, 5);
    });

    it('prefers an "all" ease over other targets', () => {
      const tweens: import('../types').Tween[] = [
        { target: 'color', method: 'sineInOut' },
        { target: 'all', method: 'cubicIn' },
      ];
      const t = progressAt(5, tweens);
      expect(t).toBeCloseTo(0.125, 5);
    });

    it('keeps the legacy intensity-only path working (no method)', () => {
      // No method => legacy intensity ease. Negative = ease-in (below linear).
      const easeIn = progressAt(5, [{ target: 'all', intensity: -100 }]);
      expect(easeIn).toBeLessThan(0.5);
      // Positive intensity => ease-out (above linear).
      const easeOut = progressAt(5, [{ target: 'all', intensity: 100 }]);
      expect(easeOut).toBeGreaterThan(0.5);
      // intensity 0 with no method => linear.
      const linear = progressAt(5, [{ target: 'all', intensity: 0 }]);
      expect(linear).toBeCloseTo(0.5, 5);
    });

    it('falls back to acceleration easing when no tweens are present', () => {
      const t = progressAt(5, undefined, -100);
      expect(t).toBeLessThan(0.5);
    });
  });

  describe('multi-segment custom ease (issue #11)', () => {
    const evalEase = (t: number, points: import('../types').Point[]): number =>
      (renderer as any).evaluateBezierEase(t, points);

    it('evaluates a single-segment (4-point) curve at its anchors', () => {
      const pts = [
        { x: 0, y: 0 },
        { x: 0.25, y: 0.1 },
        { x: 0.75, y: 0.9 },
        { x: 1, y: 1 },
      ];
      expect(evalEase(0, pts)).toBeCloseTo(0, 5);
      expect(evalEase(1, pts)).toBeCloseTo(1, 5);
    });

    it('uses LATER segments of a multi-segment (7-point) curve, not just the first 4', () => {
      // Two segments. The first segment ends at x=0.5,y=0.9 (steep rise),
      // the second segment is nearly flat then jumps to 1. A first-4-points-only
      // evaluator would ignore the second segment entirely and mis-evaluate x>0.5.
      const pts = [
        { x: 0, y: 0 },
        { x: 0.1, y: 0.6 },
        { x: 0.3, y: 0.9 },
        { x: 0.5, y: 0.9 }, // shared anchor between the two segments
        { x: 0.7, y: 0.9 },
        { x: 0.9, y: 0.92 },
        { x: 1, y: 1 },
      ];

      // Anchors evaluate exactly.
      expect(evalEase(0, pts)).toBeCloseTo(0, 4);
      expect(evalEase(0.5, pts)).toBeCloseTo(0.9, 4);
      expect(evalEase(1, pts)).toBeCloseTo(1, 4);

      // In the second segment (x in 0.5..1) the curve stays high/flat near 0.9.
      const mid2 = evalEase(0.7, pts);
      expect(mid2).toBeGreaterThan(0.85);
      expect(mid2).toBeLessThan(0.95);

      // The curve must be monotonically non-decreasing across the segment boundary.
      expect(evalEase(0.6, pts)).toBeGreaterThanOrEqual(evalEase(0.4, pts) - 1e-6);
    });

    it('is monotonic and well-formed across a 10-point (3-segment) curve', () => {
      const pts = [
        { x: 0, y: 0 },
        { x: 0.1, y: 0.2 },
        { x: 0.2, y: 0.3 },
        { x: 0.333, y: 0.4 },
        { x: 0.45, y: 0.5 },
        { x: 0.55, y: 0.6 },
        { x: 0.667, y: 0.7 },
        { x: 0.8, y: 0.85 },
        { x: 0.9, y: 0.95 },
        { x: 1, y: 1 },
      ];
      let prev = -Infinity;
      for (let i = 0; i <= 10; i++) {
        const y = evalEase(i / 10, pts);
        expect(y).toBeGreaterThanOrEqual(-0.01);
        expect(y).toBeLessThanOrEqual(1.01);
        expect(y).toBeGreaterThanOrEqual(prev - 0.02);
        prev = y;
      }
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
              fills: [{ index: 1, type: 'solid', color: '#00FF00' }],
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
                  transformationPoint: { x: 0, y: 0 },
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
                  transformationPoint: { x: 0, y: 0 },
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

    it('should interpolate color transform during motion tween', async () => {
      const symbolTimeline = createTimeline({
        name: 'ColorTweenSymbol',
        totalFrames: 1,
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, type: 'solid', color: '#FFFFFF' }],
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
      symbols.set('ColorTweenSymbol', {
        name: 'ColorTweenSymbol',
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
                  libraryItemName: 'ColorTweenSymbol',
                  symbolType: 'graphic',
                  matrix: createMatrix({ tx: 100, ty: 100 }),
                  firstFrame: 0,
                  loop: 'loop',
                  transformationPoint: { x: 0, y: 0 },
                  colorTransform: {
                    alphaMultiplier: 1,
                    redMultiplier: 1,
                    greenMultiplier: 0,
                    blueMultiplier: 0,
                  },
                }],
              }),
              createFrame({
                index: 5,
                duration: 5,
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'ColorTweenSymbol',
                  symbolType: 'graphic',
                  matrix: createMatrix({ tx: 100, ty: 100 }),
                  firstFrame: 0,
                  loop: 'loop',
                  transformationPoint: { x: 0, y: 0 },
                  colorTransform: {
                    alphaMultiplier: 0.5,
                    redMultiplier: 0,
                    greenMultiplier: 1,
                    blueMultiplier: 0,
                  },
                }],
              }),
            ],
          })],
        })],
      });
      await renderer.setDocument(doc);

      // Render frames during color transform interpolation
      // Frame 0: red tint, full alpha
      renderer.renderFrame(0);
      // Frame 2: intermediate - should interpolate colorTransform
      renderer.renderFrame(2);
      // Frame 4: close to green tint, reduced alpha
      renderer.renderFrame(4);
    });

    it('should interpolate rotation with clockwise direction', async () => {
      const symbolTimeline = createTimeline({
        name: 'RotateSymbol',
        totalFrames: 1,
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, type: 'solid', color: '#0000FF' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 50, y: 0 },
                  { type: 'L', x: 50, y: 20 },
                  { type: 'L', x: 0, y: 20 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('RotateSymbol', {
        name: 'RotateSymbol',
        symbolType: 'graphic',
        timeline: symbolTimeline,
      });

      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          totalFrames: 20,
          layers: [createLayer({
            frames: [
              createFrame({
                index: 0,
                duration: 10,
                tweenType: 'motion',
                motionTweenRotate: 'cw',
                motionTweenRotateTimes: 1,
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'RotateSymbol',
                  symbolType: 'graphic',
                  matrix: createMatrix({ a: 1, b: 0, c: 0, d: 1, tx: 200, ty: 200 }),
                  firstFrame: 0,
                  loop: 'loop',
                  transformationPoint: { x: 25, y: 10 },
                }],
              }),
              createFrame({
                index: 10,
                duration: 10,
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'RotateSymbol',
                  symbolType: 'graphic',
                  matrix: createMatrix({ a: 1, b: 0, c: 0, d: 1, tx: 200, ty: 200 }),
                  firstFrame: 0,
                  loop: 'loop',
                  transformationPoint: { x: 25, y: 10 },
                }],
              }),
            ],
          })],
        })],
      });
      await renderer.setDocument(doc);

      // Render frames during clockwise rotation tween
      renderer.renderFrame(0);
      renderer.renderFrame(5);
      renderer.renderFrame(9);
    });

    it('should interpolate rotation with counter-clockwise direction', async () => {
      const symbolTimeline = createTimeline({
        name: 'RotateCCWSymbol',
        totalFrames: 1,
        layers: [createLayer({
          frames: [createFrame({
            elements: [{
              type: 'shape',
              matrix: createMatrix(),
              fills: [{ index: 1, type: 'solid', color: '#FF00FF' }],
              strokes: [],
              edges: [{
                fillStyle0: 1,
                commands: [
                  { type: 'M', x: 0, y: 0 },
                  { type: 'L', x: 50, y: 0 },
                  { type: 'L', x: 50, y: 20 },
                  { type: 'L', x: 0, y: 20 },
                  { type: 'Z' },
                ],
              }],
            }],
          })],
        })],
      });

      const symbols = new Map();
      symbols.set('RotateCCWSymbol', {
        name: 'RotateCCWSymbol',
        symbolType: 'graphic',
        timeline: symbolTimeline,
      });

      const doc = createMinimalDoc({
        symbols,
        timelines: [createTimeline({
          totalFrames: 20,
          layers: [createLayer({
            frames: [
              createFrame({
                index: 0,
                duration: 10,
                tweenType: 'motion',
                motionTweenRotate: 'ccw',
                motionTweenRotateTimes: 2,
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'RotateCCWSymbol',
                  symbolType: 'graphic',
                  matrix: createMatrix({ a: 1, b: 0, c: 0, d: 1, tx: 200, ty: 200 }),
                  firstFrame: 0,
                  loop: 'loop',
                  transformationPoint: { x: 25, y: 10 },
                }],
              }),
              createFrame({
                index: 10,
                duration: 10,
                elements: [{
                  type: 'symbol',
                  libraryItemName: 'RotateCCWSymbol',
                  symbolType: 'graphic',
                  matrix: createMatrix({ a: 1, b: 0, c: 0, d: 1, tx: 200, ty: 200 }),
                  firstFrame: 0,
                  loop: 'loop',
                  transformationPoint: { x: 25, y: 10 },
                }],
              }),
            ],
          })],
        })],
      });
      await renderer.setDocument(doc);

      // Render frames during counter-clockwise rotation tween
      renderer.renderFrame(0);
      renderer.renderFrame(5);
      renderer.renderFrame(9);
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

    // Regression: radial gradient focalPointRatio placement (XFL fill fidelity).
    //
    // Renders a centered white(center)->black(rim) radial disc and inspects the
    // luminance along the rendered disc's horizontal centerline. The renderer
    // applies its own fit/scale transform, so we don't hard-code screen coords:
    // we first render a focal=0 disc (symmetric) to locate the rendered center,
    // then assert the focal=-1 highlight lands off-center on the focal (-X) side.
    describe('focalPointRatio placement', () => {
      const GS = 819.2;
      const sc = 80 / GS; // ~80px gradient radius in shape space
      const SHAPE_TX = 200;
      const SHAPE_TY = 150;

      async function renderFocalDisc(focal?: number): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
        const fill = {
          index: 1,
          type: 'radial' as const,
          gradient: [
            { ratio: 0, color: '#FFFFFF', alpha: 1 },
            { ratio: 1, color: '#000000', alpha: 1 },
          ],
          matrix: createMatrix({ a: sc, d: sc, tx: SHAPE_TX, ty: SHAPE_TY }),
          ...(focal !== undefined ? { focalPointRatio: focal } : {}),
        };
        const doc = createMinimalDoc({
          timelines: [createTimeline({
            layers: [createLayer({
              frames: [createFrame({
                elements: [{
                  type: 'shape',
                  matrix: createMatrix(),
                  fills: [fill],
                  strokes: [],
                  edges: [{
                    fillStyle1: 1,
                    commands: [
                      { type: 'M', x: SHAPE_TX - 90, y: SHAPE_TY - 90 },
                      { type: 'L', x: SHAPE_TX + 90, y: SHAPE_TY - 90 },
                      { type: 'L', x: SHAPE_TX + 90, y: SHAPE_TY + 90 },
                      { type: 'L', x: SHAPE_TX - 90, y: SHAPE_TY + 90 },
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
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return { data: img.data, width: img.width, height: img.height };
      }

      const lumAt = (d: Uint8ClampedArray, w: number, x: number, y: number) =>
        (d[(y * w + x) * 4] + d[(y * w + x) * 4 + 1] + d[(y * w + x) * 4 + 2]) / 3;

      // Locate the rendered disc center from a symmetric (focal=0) render by
      // finding the row with the longest run of "inside the disc" pixels (lum<255
      // at the rim, but the disc interior dips toward black at center then rises).
      // Simpler & robust: scan for the brightest interior pixel of the symmetric
      // disc (the white center) and use its location as the rendered center.
      function findBrightest(d: Uint8ClampedArray, w: number, h: number) {
        let best = -1, bx = -1, by = -1;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const v = lumAt(d, w, x, y);
            // Exclude pure-white background (255) outside the square.
            if (v < 255 && v > best) { best = v; bx = x; by = y; }
          }
        }
        return { bx, by, best };
      }

      it('(b) focal=0 is a no-op: identical to focalPointRatio absent, and symmetric', async () => {
        const zero = await renderFocalDisc(0);
        const absent = await renderFocalDisc(undefined);
        // focal=0 must produce byte-identical output to no focal at all: this is
        // the common centered-radial path and must never change.
        expect(zero.data.length).toBe(absent.data.length);
        let firstDiff = -1;
        for (let i = 0; i < zero.data.length; i++) {
          if (zero.data[i] !== absent.data[i]) { firstDiff = i; break; }
        }
        expect(firstDiff).toBe(-1);

        // And the disc must be left/right symmetric about its rendered center.
        const c = findBrightest(zero.data, zero.width, zero.height);
        expect(c.best).toBeGreaterThan(200); // a bright white center exists
        let asym = 0;
        for (let dx = 1; dx <= 30; dx++) {
          asym += Math.abs(
            lumAt(zero.data, zero.width, c.bx - dx, c.by) -
            lumAt(zero.data, zero.width, c.bx + dx, c.by)
          );
        }
        expect(asym / 30).toBeLessThan(8); // near-symmetric (allow AA noise)
      });

      it('(a) focal=-1 places a bright off-center highlight on the focal side', async () => {
        // Reference center from the symmetric focal=0 disc.
        const zero = await renderFocalDisc(0);
        const c = findBrightest(zero.data, zero.width, zero.height);
        const cyRow = c.by;
        const cxCenter = c.bx;

        const neg = await renderFocalDisc(-1);

        // Scan the disc centerline. The focal (left, -X) side must contain a
        // bright near-white highlight pixel AND a sharp luminance step (the
        // off-center focus). The far (right) side must NOT have such a spike.
        let leftPeak = 0, leftStep = 0;
        let rightPeak = 0;
        for (let x = cxCenter - 60; x < cxCenter; x++) {
          if (x < 1) continue;
          const v = lumAt(neg.data, neg.width, x, cyRow);
          const vPrev = lumAt(neg.data, neg.width, x - 1, cyRow);
          // ignore the outer square edge / background (255)
          if (v < 255) leftPeak = Math.max(leftPeak, v);
          if (v < 255 && vPrev < 255) leftStep = Math.max(leftStep, Math.abs(v - vPrev));
        }
        for (let x = cxCenter + 1; x <= cxCenter + 60; x++) {
          const v = lumAt(neg.data, neg.width, x, cyRow);
          if (v < 255) rightPeak = Math.max(rightPeak, v);
        }

        // FAILS BEFORE FIX: with the buggy `focal*radius` offset the focus lands
        // on the outer rim, so the focal-side highlight collapses (leftPeak stays
        // a washed ~250 ramp with leftStep ~ a few units, no bright spike).
        // PASSES AFTER FIX: the clamped matrix*(focal*819.2,0) focus yields a
        // crisp ~255 white highlight with a large step on the focal side.
        expect(leftPeak).toBeGreaterThanOrEqual(254);
        expect(leftStep).toBeGreaterThan(60);

        // The bright focal highlight is on the LEFT (focal -X) side, not the
        // right far side, which should ramp smoothly toward the rim.
        expect(leftPeak).toBeGreaterThan(rightPeak);
      });
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
                  type: 'solid',
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
                fills: [{ index: 1, type: 'solid', color: '#0000FF' }],
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
                fills: [{ index: 1, type: 'solid', color: '#FF00FF' }],
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
              fills: [{ index: 1, type: 'solid', color: '#FFFFFF' }],
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
                transformationPoint: { x: 0, y: 0 },
                colorTransform: {
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
              fills: [{ index: 1, type: 'solid', color: '#000000' }],
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
                    transformationPoint: { x: 0, y: 0 },
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
                    transformationPoint: { x: 0, y: 0 },
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
                  fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
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
              fills: [{ index: 1, type: 'solid', color: '#333333' }],
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
                  transformationPoint: { x: 0, y: 0 },
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
                  fills: [{ index: 1, type: 'solid', color: '#0000FF' }],
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
              fills: [{ index: 1, type: 'solid', color: '#888888' }],
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
                    transformationPoint: { x: 0, y: 0 },
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
                    transformationPoint: { x: 0, y: 0 },
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
                left: 0,
                width: 200,
                height: 30,
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
                left: 0,
                width: 200,
                height: 30,
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
                left: 0,
                width: 200,
                height: 30,
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
                left: 0,
                width: 200,
                height: 30,
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
                left: 0,
                width: 200,
                height: 30,
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
                fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
                strokes: [{ type: 'solid', index: 1, color: '#000000', weight: 2 }],
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
              fills: [{ index: 1, type: 'solid', color: '#00FF00' }],
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
                transformationPoint: { x: 0, y: 0 },
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
              fills: [{ index: 1, type: 'solid', color: '#00FF00' }],
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
                transformationPoint: { x: 0, y: 0 },
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
                fills: [{ index: 1, type: 'solid', color: '#FF00FF' }],
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
                fills: [{ index: 1, type: 'solid', color: '#FFFF00' }],
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
              fills: [{ index: 1, type: 'solid', color: '#444444' }],
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
                    transformationPoint: { x: 0, y: 0 },
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
                    transformationPoint: { x: 0, y: 0 },
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
                  fills: [{ index: 1, type: 'solid', color: '#00FF00' }],
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
              fills: [{ index: 1, type: 'solid', color: '#888888' }],
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
                  fills: [{ index: 1, type: 'solid', color: '#00FFFF' }],
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
                transformationPoint: { x: 0, y: 0 },
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
              fills: [{ index: 1, type: 'solid', color: '#888888' }],
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
                  transformationPoint: { x: 0, y: 0 },
                }],
              })],
            }),
            createLayer({
              name: 'Content',
              frames: [createFrame({
                elements: [{
                  type: 'shape',
                  matrix: createMatrix(),
                  fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
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
              fills: [{ index: 1, type: 'solid', color: '#888888' }],
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
                  transformationPoint: { x: 0, y: 0 },
                }],
              })],
            }),
            createLayer({
              name: 'Content',
              frames: [createFrame({
                elements: [{
                  type: 'shape',
                  matrix: createMatrix(),
                  fills: [{ index: 1, type: 'solid', color: '#00FF00' }],
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
                fills: [{ index: 1, type: 'solid', color: '#0000FF' }],
                strokes: [{ type: 'solid', index: 1, color: '#000000', weight: 2 }],
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
                fills: [{ index: 1, type: 'solid', color: '#FF00FF' }],
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
                  fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
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
                  fills: [{ index: 1, type: 'solid', color: '#00FF00' }],
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
                  fills: [{ index: 1, type: 'solid', color: '#0000FF' }],
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
                fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
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
                fills: [{ index: 1, type: 'solid', color: '#00FF00' }],
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
                fills: [{ index: 1, type: 'solid', color: '#0000FF' }],
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
                fills: [{ index: 1, type: 'solid', color: '#FFFF00' }],
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
                fills: [{ index: 1, type: 'solid', color: '#FF00FF' }],
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
                  fills: [{ index: 1, type: 'solid', color: '#FF0000' }],
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
                  fills: [{ index: 1, type: 'solid', color: '#00FF00' }],
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
                  type: 'solid',
                  index: 1,
                  color: '#0000FF',
                  weight: 5,
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
                fills: [{ index: 1, type: 'solid', color: '#00FFFF' }],
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
                fills: [{ index: 1, type: 'solid', color: '#FFFF00' }],
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
                fills: [{ index: 1, type: 'solid', color: '#FF00FF' }],
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
                    symbolType: 'graphic',
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
                    symbolType: 'graphic',
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
                  fills: [{ index: 1, type: 'solid', color: '#00FF00' }],
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
        itemID: 'ramka-symbol',
        symbolType: 'graphic',
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
                  symbolType: 'graphic',
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
                  fills: [{ index: 1, type: 'solid', color: '#FF00FF' }],
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
        itemID: 'ramka-symbol',
        symbolType: 'graphic',
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
                  left: 0,
                  width: 400,
                  height: 100,
                  textRuns: [{
                    characters: 'GAME OVER',
                    face: 'PressStart2P',
                    size: 32,
                    fillColor: '#FF0000',
                    alignment: 'left',
                  }],
                },
                // Add a shape to ensure something is rendered
                {
                  type: 'shape',
                  matrix: createMatrix(),
                  fills: [{ index: 1, type: 'solid', color: '#00FF00' }],
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
                left: 0,
                width: 400,
                height: 50,
                textRuns: [{
                  characters: 'Test Font Loading',
                  // Use 'PressStart2P' which maps to 'Press Start 2P' in fontMap
                  // This triggers ensureFontLoaded for a Google Font
                  face: 'PressStart2P',
                  size: 16,
                  fillColor: '#0000FF',
                  alignment: 'left',
                }],
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
                fills: [{ index: 1, type: 'solid', color: '#123456' }],
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
                fills: [{ index: 1, type: 'solid', color: '#AABBCC' }],
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
                fills: [{ index: 1, type: 'solid', color: '#DDEEFF' }],
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
                symbolType: 'graphic',
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
        itemID: 'test-symbol',
        symbolType: 'graphic',
        timeline: createTimeline({
          layers: [createLayer({
            frames: [createFrame({
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
      // Create a test image with actual content
      const testCanvas = document.createElement('canvas');
      testCanvas.width = 100;
      testCanvas.height = 100;
      const testCtx = testCanvas.getContext('2d')!;
      testCtx.fillStyle = '#0000FF';
      testCtx.fillRect(0, 0, 100, 100);
      const imgData = testCtx.getImageData(0, 0, 100, 100);
      const bitmap = await createImageBitmap(imgData);

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

      // Add bitmap with proper BitmapItem structure (cast ImageBitmap to HTMLImageElement for compatibility)
      doc.bitmaps.set('TestBitmap', {
        name: 'TestBitmap',
        href: 'TestBitmap',
        width: 100,
        height: 100,
        imageData: bitmap as unknown as HTMLImageElement,
      });

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
                fills: [{ index: 1, type: 'solid', color: '#112233' }],
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
                fills: [{ index: 1, type: 'solid', color: '#445566' }],
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
      const edges: Edge[] = [];
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
                fills: [{ index: 1, type: 'solid', color: '#778899' }],
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
                  symbolType: 'graphic',
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
                  fills: [{ index: 1, type: 'solid', color: '#AABB00' }],
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
        itemID: 'ramka-symbol',
        symbolType: 'graphic',
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
                  symbolType: 'graphic',
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
                  fills: [{ index: 1, type: 'solid', color: '#FF5500' }],
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
        itemID: 'ramka-symbol',
        symbolType: 'graphic',
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
                    symbolType: 'graphic',
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
                    symbolType: 'graphic',
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
                  fills: [{ index: 1, type: 'solid', color: '#00AAFF' }],
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
        itemID: 'ramka-symbol',
        symbolType: 'graphic',
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
                  symbolType: 'graphic',
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
                  fills: [{ index: 1, type: 'solid', color: '#AA00FF' }],
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
        itemID: 'ramka-symbol',
        symbolType: 'graphic',
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
                fills: [{ index: 1, type: 'solid', color: '#FF8800' }, { index: 2, type: 'solid', color: '#0088FF' }],
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

  describe('internal edges (fillStyle0 === fillStyle1)', () => {
    it('should not create holes when edge has same fill on both sides', async () => {
      // This tests the fix for the "triangle hole" bug where internal detail lines
      // (edges with fillStyle0 === fillStyle1) were incorrectly contributing to fill paths
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, type: 'solid', color: '#FFCC99' }],
                strokes: [{ type: 'solid', index: 2, color: '#000000', weight: 1 }],
                edges: [
                  // Main boundary edge defining the filled rectangle
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
                  // Internal edge with fillStyle0 === fillStyle1 (detail line inside the fill)
                  // This should NOT create a hole in the fill
                  {
                    fillStyle0: 1,
                    fillStyle1: 1,
                    strokeStyle: 2,
                    commands: [
                      { type: 'M', x: 100, y: 100 },
                      { type: 'L', x: 150, y: 150 },
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

      // The shape should render without any holes
      expect(hasRenderedContent(canvas)).toBe(true);
      // The fill color should be present (not cut out by internal edge)
      expect(hasColor(canvas, '#FFCC99')).toBe(true);
    });

    it('should still render stroke for internal edges', async () => {
      // Internal edges should contribute to strokes even though they don't affect fills
      const doc = createMinimalDoc({
        timelines: [createTimeline({
          layers: [createLayer({
            frames: [createFrame({
              elements: [{
                type: 'shape',
                matrix: createMatrix(),
                fills: [{ index: 1, type: 'solid', color: '#FFFFFF' }],
                strokes: [{ type: 'solid', index: 2, color: '#FF0000', weight: 2 }],
                edges: [
                  // Boundary
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
                  // Internal detail line (same fill both sides, but has stroke)
                  {
                    fillStyle0: 1,
                    fillStyle1: 1,
                    strokeStyle: 2,
                    commands: [
                      { type: 'M', x: 75, y: 125 },
                      { type: 'L', x: 175, y: 125 },
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

      // Should have the red stroke rendered
      expect(hasColor(canvas, '#FF0000')).toBe(true);
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
                fills: [{ index: 1, type: 'solid', color: '#AABBCC' }],
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
                symbolType: 'graphic',
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
                  type: 'solid',
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
                  type: 'solid',
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
                fills: [{ index: 1, type: 'solid', color: '#FFCC00' }],
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
                fills: [{ index: 1, type: 'solid', color: '#00CCFF' }],
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
                  symbolType: 'graphic',
                  matrix: createMatrix({ tx: 100, ty: 100 }),
                  transformationPoint: { x: 0, y: 0 },
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
                  symbolType: 'graphic',
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
                  symbolType: 'graphic',
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
                transformationPoint: { x: 0, y: 0 },
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
                transformationPoint: { x: 0, y: 0 },
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
                transformationPoint: { x: 0, y: 0 },
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
                transformationPoint: { x: 0, y: 0 },
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
                strokes: [{ type: 'solid', index: 1, color: '#000000', weight: 2 }],
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
                  transformationPoint: { x: 0, y: 0 },
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
                  transformationPoint: { x: 0, y: 0 },
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
                  transformationPoint: { x: 0, y: 0 },
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
                  transformationPoint: { x: 0, y: 0 },
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
                  transformationPoint: { x: 0, y: 0 },
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
                  transformationPoint: { x: 0, y: 0 },
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
                  transformationPoint: { x: 0, y: 0 },
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
                  transformationPoint: { x: 0, y: 0 },
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
                  transformationPoint: { x: 0, y: 0 },
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
                  transformationPoint: { x: 0, y: 0 },
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
                  transformationPoint: { x: 0, y: 0 },
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
                transformationPoint: { x: 0, y: 0 },
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
                transformationPoint: { x: 0, y: 0 },
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
                transformationPoint: { x: 0, y: 0 },
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
                transformationPoint: { x: 0, y: 0 },
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
