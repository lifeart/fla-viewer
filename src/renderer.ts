import type {
  FLADocument,
  Timeline,
  Layer,
  Frame,
  DisplayElement,
  SymbolInstance,
  VideoInstance,
  BitmapInstance,
  Shape,
  Matrix,
  FillStyle,
  StrokeStyle,
  Edge,
  Tween,
  Point,
  PathCommand
} from './types';

interface DebugElement {
  type: 'shape' | 'symbol' | 'bitmap' | 'video';
  element: DisplayElement;
  path: Path2D;
  transform: DOMMatrix;
  depth: number;
  parentPath: string[];  // Symbol hierarchy path
  fillStyles?: Map<number, FillStyle>;
  strokeStyles?: Map<number, StrokeStyle>;
  edges?: Edge[];
}

export class FLARenderer {
  private ctx: CanvasRenderingContext2D;
  private doc: FLADocument | null = null;
  private canvas: HTMLCanvasElement;
  private scale: number = 1;
  private dpr: number = 1;
  private debugMode: boolean = false;
  private debugElements: DebugElement[] = [];
  private debugSymbolPath: string[] = [];  // Current symbol hierarchy for debug
  private clickHandler: ((e: MouseEvent) => void) | null = null;
  private hiddenLayers: Set<number> = new Set();
  private layerOrder: 'forward' | 'reverse' = 'reverse';
  private nestedLayerOrder: 'forward' | 'reverse' = 'reverse';
  private elementOrder: 'forward' | 'reverse' = 'forward';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get 2D context');
    }
    this.ctx = ctx;
    this.dpr = window.devicePixelRatio || 1;
  }

  enableDebugMode(): void {
    if (this.debugMode) return;
    this.debugMode = true;

    this.clickHandler = (e: MouseEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      // Convert click position from CSS pixels to canvas buffer coordinates
      // This properly handles any scaling between CSS display size and canvas buffer size
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;
      const canvasX = (e.clientX - rect.left) * scaleX;
      const canvasY = (e.clientY - rect.top) * scaleY;

      // Convert to document coordinates (remove the base scale applied during rendering)
      const combinedScale = this.scale * this.dpr;
      const docX = canvasX / combinedScale;
      const docY = canvasY / combinedScale;

      console.log(`Click at doc coords: (${docX.toFixed(1)}, ${docY.toFixed(1)}), canvas: (${canvasX.toFixed(1)}, ${canvasY.toFixed(1)}), tracking ${this.debugElements.length} elements`);

      // Find all elements under the click point (from top to bottom)
      const hitElements: DebugElement[] = [];

      // Save current transform and reset to identity for hit testing
      this.ctx.save();
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);

      for (const debugEl of this.debugElements) {
        // The stored transform includes the base combinedScale, so we use canvas coordinates
        // and transform them to local element coordinates
        const inverse = debugEl.transform.inverse();
        const localX = inverse.a * canvasX + inverse.c * canvasY + inverse.e;
        const localY = inverse.b * canvasX + inverse.d * canvasY + inverse.f;

        // Test if point is in path (path is in local coordinates)
        // Use 'evenodd' fill rule to match rendering
        if (this.ctx.isPointInPath(debugEl.path, localX, localY, 'evenodd')) {
          hitElements.push(debugEl);
        }
      }

      this.ctx.restore();

      if (hitElements.length > 0) {
        // Sort by depth (deepest first - top of visual stack) and get the topmost one
        hitElements.sort((a, b) => b.depth - a.depth);
        const el = hitElements[0];

        const pathStr = el.parentPath.length > 0 ? el.parentPath.join(' > ') : '(root)';
        console.group(`${el.type.toUpperCase()} in ${pathStr}`);
        console.log('Path:', el.parentPath.length > 0 ? el.parentPath : ['(root timeline)']);
        console.log('Element:', el.element);
        console.log('Transform:', {
          a: el.transform.a.toFixed(4),
          b: el.transform.b.toFixed(4),
          c: el.transform.c.toFixed(4),
          d: el.transform.d.toFixed(4),
          tx: el.transform.e.toFixed(2),
          ty: el.transform.f.toFixed(2)
        });

        if (el.type === 'shape') {
          const shape = el.element as Shape;
          console.log('Fill Styles:', el.fillStyles ? Object.fromEntries(el.fillStyles) : {});
          console.log('Stroke Styles:', el.strokeStyles ? Object.fromEntries(el.strokeStyles) : {});
          console.log('Shape Matrix:', shape.matrix);

          // Only show edges with out-of-bounds coordinates
          const BOUNDS = 10000; // Reasonable max coordinate
          const isOutOfBounds = (v: number) => !Number.isFinite(v) || Math.abs(v) > BOUNDS;

          const badEdges: { index: number; edge: Edge; badCommands: string[] }[] = [];
          el.edges?.forEach((edge, i) => {
            const badCommands: string[] = [];
            edge.commands.forEach((cmd, j) => {
              if (cmd.type === 'M' || cmd.type === 'L') {
                if (isOutOfBounds(cmd.x) || isOutOfBounds(cmd.y)) {
                  badCommands.push(`${j}: ${cmd.type} ${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)}`);
                }
              } else if (cmd.type === 'Q') {
                if (isOutOfBounds(cmd.x) || isOutOfBounds(cmd.y) || isOutOfBounds(cmd.cx) || isOutOfBounds(cmd.cy)) {
                  badCommands.push(`${j}: Q cx=${cmd.cx.toFixed(2)}, cy=${cmd.cy.toFixed(2)} -> ${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)}`);
                }
              } else if (cmd.type === 'C') {
                if (isOutOfBounds(cmd.x) || isOutOfBounds(cmd.y) ||
                    isOutOfBounds(cmd.c1x) || isOutOfBounds(cmd.c1y) ||
                    isOutOfBounds(cmd.c2x) || isOutOfBounds(cmd.c2y)) {
                  badCommands.push(`${j}: C c1=(${cmd.c1x.toFixed(2)}, ${cmd.c1y.toFixed(2)}) c2=(${cmd.c2x.toFixed(2)}, ${cmd.c2y.toFixed(2)}) -> ${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)}`);
                }
              }
            });
            if (badCommands.length > 0) {
              badEdges.push({ index: i, edge, badCommands });
            }
          });

          console.log(`Edges: ${el.edges?.length || 0} total, ${badEdges.length} with out-of-bounds coords (>${BOUNDS})`);

          // If few edges or has bad edges, show details
          if ((el.edges?.length || 0) <= 5 || badEdges.length > 0) {
            el.edges?.forEach((edge, i) => {
              console.log(`  Edge ${i}: fill0=${edge.fillStyle0}, fill1=${edge.fillStyle1}, stroke=${edge.strokeStyle}, commands=${edge.commands.length}`);
              edge.commands.forEach((cmd, j) => {
                if (cmd.type === 'M') {
                  console.log(`    ${j}: M ${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)}`);
                } else if (cmd.type === 'L') {
                  console.log(`    ${j}: L ${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)}`);
                } else if (cmd.type === 'Q') {
                  console.log(`    ${j}: Q cx=${cmd.cx.toFixed(2)}, cy=${cmd.cy.toFixed(2)} -> ${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)}`);
                } else if (cmd.type === 'C') {
                  console.log(`    ${j}: C c1=(${cmd.c1x.toFixed(2)}, ${cmd.c1y.toFixed(2)}) c2=(${cmd.c2x.toFixed(2)}, ${cmd.c2y.toFixed(2)}) -> ${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)}`);
                } else if (cmd.type === 'Z') {
                  console.log(`    ${j}: Z`);
                }
              });
            });
          } else {
            badEdges.forEach(({ index, edge, badCommands }) => {
              console.log(`  Edge ${index}: fill0=${edge.fillStyle0}, fill1=${edge.fillStyle1}, stroke=${edge.strokeStyle}`);
              badCommands.forEach(cmd => console.log(`    ${cmd}`));
            });
          }
        } else if (el.type === 'symbol') {
          const symbol = el.element as SymbolInstance;
          console.log('Library Item:', symbol.libraryItemName);
          console.log('Loop:', symbol.loop);
          console.log('First Frame:', symbol.firstFrame);
        } else if (el.type === 'bitmap') {
          const bitmap = el.element as BitmapInstance;
          console.log('Library Item:', bitmap.libraryItemName);
        }

        console.groupEnd();
      } else {
        console.log('No elements found at click position');
      }
    };

    this.canvas.addEventListener('click', this.clickHandler);
    this.canvas.style.cursor = 'crosshair';
    console.log('Debug mode enabled - click on canvas to inspect elements');
  }

  disableDebugMode(): void {
    if (!this.debugMode) return;
    this.debugMode = false;

    if (this.clickHandler) {
      this.canvas.removeEventListener('click', this.clickHandler);
      this.clickHandler = null;
    }
    this.canvas.style.cursor = 'default';
    console.log('Debug mode disabled');
  }

  setHiddenLayers(hiddenLayers: Set<number>): void {
    this.hiddenLayers = new Set(hiddenLayers);
  }

  setLayerOrder(order: 'forward' | 'reverse'): void {
    this.layerOrder = order;
  }

  setNestedLayerOrder(order: 'forward' | 'reverse'): void {
    this.nestedLayerOrder = order;
  }

  setElementOrder(order: 'forward' | 'reverse'): void {
    this.elementOrder = order;
  }

  setDocument(doc: FLADocument): void {
    this.doc = doc;
    this.dpr = window.devicePixelRatio || 1;

    // Clear state from previous document
    this.missingSymbols.clear();

    // Calculate scale to fit canvas while maintaining aspect ratio
    const maxWidth = Math.min(window.innerWidth - 100, 1920);
    const maxHeight = Math.min(window.innerHeight - 300, 1080);

    const scaleX = maxWidth / doc.width;
    const scaleY = maxHeight / doc.height;
    this.scale = Math.min(scaleX, scaleY, 1);

    // Calculate CSS display size
    const displayWidth = doc.width * this.scale;
    const displayHeight = doc.height * this.scale;

    // Set canvas buffer size (scaled by DPR for crisp rendering)
    this.canvas.width = displayWidth * this.dpr;
    this.canvas.height = displayHeight * this.dpr;

    // Set CSS display size
    this.canvas.style.width = `${displayWidth}px`;
    this.canvas.style.height = `${displayHeight}px`;

    console.log('Document size:', doc.width, 'x', doc.height);
    console.log('Canvas size:', this.canvas.width, 'x', this.canvas.height);
    console.log('Scale:', this.scale, 'DPR:', this.dpr);
  }

  renderFrame(frameIndex: number): void {
    if (!this.doc) return;

    const ctx = this.ctx;
    const doc = this.doc;

    // Clear debug elements for this frame
    if (this.debugMode) {
      this.debugElements = [];
      this.debugSymbolPath = [];
    }

    // Fully reset canvas state
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Apply DPR and content scale together
    const combinedScale = this.scale * this.dpr;
    ctx.setTransform(combinedScale, 0, 0, combinedScale, 0, 0);

    // Fill with background color
    ctx.fillStyle = doc.backgroundColor;
    ctx.fillRect(0, 0, doc.width, doc.height);

    // Render main timeline
    if (doc.timelines.length > 0) {
      this.renderTimeline(doc.timelines[0], frameIndex);
    }
  }

  private renderTimeline(timeline: Timeline, frameIndex: number, depth: number = 0): void {
    if (depth > 50) return; // Prevent infinite recursion

    const ctx = this.ctx;

    // Apply camera transform at root level only
    let hasCameraTransform = false;
    if (depth === 0 && timeline.cameraLayerIndex !== undefined) {
      const cameraLayer = timeline.layers[timeline.cameraLayerIndex];
      const cameraTransform = this.getCameraTransform(cameraLayer, frameIndex);
      if (cameraTransform) {
        ctx.save();
        // Apply inverse camera transform to simulate camera movement
        this.applyInverseCameraTransform(cameraTransform);
        hasCameraTransform = true;
      }
    }

    // Render layers based on layerOrder setting (main) or nestedLayerOrder (nested symbols)
    const order = depth === 0 ? this.layerOrder : this.nestedLayerOrder;
    const indices = order === 'reverse'
      ? [...Array(timeline.layers.length).keys()].reverse()  // [len-1, len-2, ..., 0]
      : [...Array(timeline.layers.length).keys()];           // [0, 1, ..., len-1]

    for (const i of indices) {
      const layer = timeline.layers[i];

      // Skip camera layer (it's a reference, not rendered content)
      if (i === timeline.cameraLayerIndex) {
        continue;
      }

      // Skip hidden layers (only for main timeline, depth 0)
      if (depth === 0 && this.hiddenLayers.has(i)) {
        continue;
      }

      // Skip guide/folder layers
      // Note: layer.visible is an editor UI setting (eye icon), not runtime visibility
      // All non-guide/folder layers should render regardless of the visible attribute
      if (layer.layerType === 'guide' || layer.layerType === 'folder') {
        continue;
      }

      this.renderLayer(layer, frameIndex, depth);
    }

    if (hasCameraTransform) {
      ctx.restore();
    }
  }

  private getCameraTransform(cameraLayer: Layer, frameIndex: number): Matrix | null {
    const frame = this.findFrameAtIndex(cameraLayer.frames, frameIndex);
    if (!frame || frame.elements.length === 0) return null;

    // Get the first symbol instance (should be the Ramka/camera symbol)
    const element = frame.elements[0];
    if (element.type !== 'symbol') return null;

    // Check for motion tween interpolation
    if (frame.tweenType === 'motion') {
      const nextKeyframe = this.findNextKeyframe(cameraLayer.frames, frame);
      if (nextKeyframe && nextKeyframe.elements.length > 0) {
        const nextElement = nextKeyframe.elements[0];
        if (nextElement.type === 'symbol') {
          const progress = this.calculateTweenProgress(
            frameIndex,
            frame,
            nextKeyframe,
            frame.acceleration,
            frame.tweens
          );

          // Interpolate camera matrix
          return {
            a: this.lerp(element.matrix.a, nextElement.matrix.a, progress),
            b: this.lerp(element.matrix.b, nextElement.matrix.b, progress),
            c: this.lerp(element.matrix.c, nextElement.matrix.c, progress),
            d: this.lerp(element.matrix.d, nextElement.matrix.d, progress),
            tx: this.lerp(element.matrix.tx, nextElement.matrix.tx, progress),
            ty: this.lerp(element.matrix.ty, nextElement.matrix.ty, progress)
          };
        }
      }
    }

    return element.matrix;
  }

  private applyInverseCameraTransform(matrix: Matrix): void {
    // The camera matrix represents where the "camera frame" is positioned
    // To render content from the camera's perspective, we need the inverse transform
    //
    // For a 2D affine matrix [a c tx; b d ty; 0 0 1]:
    // The inverse is [d -c (c*ty - d*tx); -b a (b*tx - a*ty); 0 0 1] / determinant

    const det = matrix.a * matrix.d - matrix.b * matrix.c;
    if (Math.abs(det) < 0.0001) return; // Degenerate matrix

    const invDet = 1 / det;
    const invA = matrix.d * invDet;
    const invB = -matrix.b * invDet;
    const invC = -matrix.c * invDet;
    const invD = matrix.a * invDet;
    const invTx = (matrix.c * matrix.ty - matrix.d * matrix.tx) * invDet;
    const invTy = (matrix.b * matrix.tx - matrix.a * matrix.ty) * invDet;

    this.ctx.transform(invA, invB, invC, invD, invTx, invTy);
  }

  private renderLayer(layer: Layer, frameIndex: number, depth: number): void {
    // Find the frame at the current index
    const frame = this.findFrameAtIndex(layer.frames, frameIndex);
    if (!frame) return;

    // Track keyframe start for symbol loop calculations
    this.currentKeyframeStart = frame.index;

    // Check if we need to interpolate (tween)
    const nextKeyframe = this.findNextKeyframe(layer.frames, frame);

    // Render elements based on elementOrder setting
    const elementIndices = this.elementOrder === 'reverse'
      ? [...Array(frame.elements.length).keys()].reverse()
      : [...Array(frame.elements.length).keys()];

    for (const elementIndex of elementIndices) {
      const element = frame.elements[elementIndex];
      if (frame.tweenType === 'motion' && nextKeyframe && nextKeyframe.elements.length > 0) {
        // Calculate interpolation progress
        const progress = this.calculateTweenProgress(
          frameIndex,
          frame,
          nextKeyframe,
          frame.acceleration,
          frame.tweens
        );

        // Find matching element in next keyframe
        // For symbols, match by libraryItemName; otherwise use same index or first element
        let nextDisplayElement = nextKeyframe.elements[0];
        if (element.type === 'symbol') {
          const matchingElement = nextKeyframe.elements.find(
            (e) => e.type === 'symbol' && e.libraryItemName === element.libraryItemName
          );
          if (matchingElement) {
            nextDisplayElement = matchingElement;
          }
        } else if (elementIndex < nextKeyframe.elements.length) {
          nextDisplayElement = nextKeyframe.elements[elementIndex];
        }

        this.renderDisplayElementWithTween(element, nextDisplayElement, progress, depth, frameIndex);
      } else {
        this.renderDisplayElement(element, depth, frameIndex);
      }
    }
  }

  private findFrameAtIndex(frames: Frame[], index: number): Frame | null {
    for (const frame of frames) {
      if (index >= frame.index && index < frame.index + frame.duration) {
        return frame;
      }
    }
    return null;
  }

  private findNextKeyframe(frames: Frame[], currentFrame: Frame): Frame | null {
    const nextIndex = currentFrame.index + currentFrame.duration;
    for (const frame of frames) {
      if (frame.index === nextIndex) {
        return frame;
      }
    }
    return null;
  }

  private calculateTweenProgress(
    frameIndex: number,
    startFrame: Frame,
    _endFrame: Frame,
    acceleration?: number,
    tweens?: Tween[]
  ): number {
    const frameOffset = frameIndex - startFrame.index;
    // Guard against division by zero (duration should never be 0, but protect anyway)
    let progress = startFrame.duration > 0 ? frameOffset / startFrame.duration : 0;

    // Apply easing
    if (tweens && tweens.length > 0) {
      const tween = tweens[0];
      if (tween.customEase && tween.customEase.length >= 4) {
        progress = this.evaluateBezierEase(progress, tween.customEase);
      } else if (tween.intensity !== undefined) {
        progress = this.applyEaseIntensity(progress, tween.intensity);
      }
    } else if (acceleration !== undefined) {
      progress = this.applyEaseIntensity(progress, acceleration);
    }

    return Math.max(0, Math.min(1, progress));
  }

  private applyEaseIntensity(t: number, intensity: number): number {
    // Intensity: -100 to 100
    // Negative = ease in, Positive = ease out
    if (intensity === 0) return t;

    const strength = Math.abs(intensity) / 100;

    if (intensity < 0) {
      // Ease in (slow start)
      return Math.pow(t, 1 + strength * 2);
    } else {
      // Ease out (slow end)
      return 1 - Math.pow(1 - t, 1 + strength * 2);
    }
  }

  private evaluateBezierEase(t: number, points: Point[]): number {
    // Cubic bezier evaluation
    if (points.length < 4) return t;

    const p0 = points[0];
    const p1 = points[1];
    const p2 = points[2];
    const p3 = points[3];

    // Find t value on x axis using Newton-Raphson
    let x = t;
    for (let i = 0; i < 10; i++) {
      const bx = this.cubicBezier(x, p0.x, p1.x, p2.x, p3.x);
      const dx = this.cubicBezierDerivative(x, p0.x, p1.x, p2.x, p3.x);
      if (Math.abs(dx) < 0.0001) break;
      x = x - (bx - t) / dx;
    }

    return this.cubicBezier(x, p0.y, p1.y, p2.y, p3.y);
  }

  private cubicBezier(t: number, p0: number, p1: number, p2: number, p3: number): number {
    const t2 = t * t;
    const t3 = t2 * t;
    const mt = 1 - t;
    const mt2 = mt * mt;
    const mt3 = mt2 * mt;
    return mt3 * p0 + 3 * mt2 * t * p1 + 3 * mt * t2 * p2 + t3 * p3;
  }

  private cubicBezierDerivative(t: number, p0: number, p1: number, p2: number, p3: number): number {
    const t2 = t * t;
    const mt = 1 - t;
    const mt2 = mt * mt;
    return 3 * mt2 * (p1 - p0) + 6 * mt * t * (p2 - p1) + 3 * t2 * (p3 - p2);
  }

  private renderDisplayElementWithTween(element: DisplayElement, nextDisplayElement: DisplayElement, progress: number, depth: number, parentFrameIndex: number): void {
    if (element.type === 'symbol' && nextDisplayElement.type === 'symbol') {
      // Interpolate matrix transforms
      const startMatrix = element.matrix;
      const endMatrix = nextDisplayElement.matrix;

      const interpolatedMatrix: Matrix = {
        a: this.lerp(startMatrix.a, endMatrix.a, progress),
        b: this.lerp(startMatrix.b, endMatrix.b, progress),
        c: this.lerp(startMatrix.c, endMatrix.c, progress),
        d: this.lerp(startMatrix.d, endMatrix.d, progress),
        tx: this.lerp(startMatrix.tx, endMatrix.tx, progress),
        ty: this.lerp(startMatrix.ty, endMatrix.ty, progress)
      };

      // Interpolate firstFrame for smooth internal animation during tweens
      const startFirstFrame = element.firstFrame || 0;
      const endFirstFrame = nextDisplayElement.firstFrame || 0;
      const interpolatedFirstFrame = Math.round(this.lerp(startFirstFrame, endFirstFrame, progress));

      const tweenedDisplayElement: SymbolInstance = {
        ...element,
        matrix: interpolatedMatrix,
        firstFrame: interpolatedFirstFrame
      };

      this.renderDisplayElement(tweenedDisplayElement, depth, parentFrameIndex);
    } else {
      this.renderDisplayElement(element, depth, parentFrameIndex);
    }
  }

  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

  private renderDisplayElement(element: DisplayElement, depth: number, parentFrameIndex: number): void {
    if (element.type === 'symbol') {
      this.renderSymbolInstance(element, depth, parentFrameIndex);
    } else if (element.type === 'shape') {
      this.renderShape(element, depth);
    } else if (element.type === 'video') {
      this.renderVideoInstance(element, depth);
    } else if (element.type === 'bitmap') {
      this.renderBitmapInstance(element, depth);
    }
  }

  private missingSymbols = new Set<string>();
  private currentKeyframeStart: number = 0;  // Track keyframe start for loop calculation

  private renderSymbolInstance(instance: SymbolInstance, depth: number, parentFrameIndex: number): void {
    if (!this.doc) return;

    const symbol = this.doc.symbols.get(instance.libraryItemName);
    if (!symbol) {
      // Log missing symbols only once
      if (!this.missingSymbols.has(instance.libraryItemName)) {
        this.missingSymbols.add(instance.libraryItemName);
        console.warn('Missing symbol:', JSON.stringify(instance.libraryItemName),
          'Available:', Array.from(this.doc.symbols.keys()).slice(0, 5).map(k => JSON.stringify(k)));
      }
      return;
    }


    const ctx = this.ctx;
    ctx.save();

    // Track symbol path for debugging
    if (this.debugMode) {
      this.debugSymbolPath.push(instance.libraryItemName);
    }

    // Apply transformation matrix
    // Note: The matrix tx/ty already positions the symbol correctly
    // The transformationPoint is metadata about the pivot, but it's already
    // accounted for in how the matrix was calculated by Flash
    this.applyMatrix(instance.matrix);

    // Calculate which frame to render based on symbol type and loop mode
    // In Flash:
    // - 'single frame': Always shows the specified firstFrame
    // - 'graphic' with 'loop': Internal timeline advances with parent, loops when done
    // - 'graphic' with 'play once': Internal timeline advances, stops at last frame
    // - 'movieclip': Internal timeline plays independently (not fully supported)
    const firstFrame = instance.firstFrame || 0;
    const totalSymbolFrames = Math.max(1, symbol.timeline.totalFrames);
    let symbolFrame: number;

    if (instance.loop === 'single frame') {
      // Always show the specified firstFrame
      symbolFrame = firstFrame % totalSymbolFrames;
    } else if (instance.loop === 'loop') {
      // Sync with parent timeline: advance from firstFrame based on parent frame offset
      const frameOffset = parentFrameIndex - this.currentKeyframeStart;
      symbolFrame = (firstFrame + frameOffset) % totalSymbolFrames;
    } else {
      // 'play once' - advance but clamp at last frame
      const frameOffset = parentFrameIndex - this.currentKeyframeStart;
      symbolFrame = Math.min(firstFrame + frameOffset, totalSymbolFrames - 1);
    }

    // Render symbol's timeline
    this.renderTimeline(symbol.timeline, symbolFrame, depth + 1);

    // Pop symbol path
    if (this.debugMode) {
      this.debugSymbolPath.pop();
    }

    ctx.restore();
  }

  private renderVideoInstance(video: VideoInstance, depth: number = 0): void {
    const ctx = this.ctx;
    ctx.save();

    // Apply transformation
    this.applyMatrix(video.matrix);

    // Create path for hit testing
    if (this.debugMode) {
      const path = new Path2D();
      path.rect(0, 0, video.width, video.height);
      this.debugElements.push({
        type: 'video',
        element: video,
        path,
        transform: ctx.getTransform(),
        depth,
        parentPath: [...this.debugSymbolPath]
      });
    }

    // Render placeholder rectangle for video
    ctx.fillStyle = '#333333';
    ctx.fillRect(0, 0, video.width, video.height);

    // Draw video icon/indicator
    ctx.strokeStyle = '#666666';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, video.width, video.height);

    // Draw play button triangle
    const centerX = video.width / 2;
    const centerY = video.height / 2;
    const size = Math.min(video.width, video.height) * 0.2;

    ctx.fillStyle = '#888888';
    ctx.beginPath();
    ctx.moveTo(centerX - size / 2, centerY - size);
    ctx.lineTo(centerX - size / 2, centerY + size);
    ctx.lineTo(centerX + size, centerY);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  private renderBitmapInstance(bitmap: BitmapInstance, depth: number = 0): void {
    if (!this.doc) return;

    const ctx = this.ctx;
    ctx.save();

    // Apply transformation
    this.applyMatrix(bitmap.matrix);

    // Look up bitmap item from library
    const bitmapItem = this.doc.bitmaps.get(bitmap.libraryItemName);

    // Create path for hit testing
    if (this.debugMode) {
      const path = new Path2D();
      const width = bitmapItem?.width || 100;
      const height = bitmapItem?.height || 100;
      path.rect(0, 0, width, height);
      this.debugElements.push({
        type: 'bitmap',
        element: bitmap,
        path,
        transform: ctx.getTransform(),
        depth,
        parentPath: [...this.debugSymbolPath]
      });
    }

    if (bitmapItem && bitmapItem.imageData) {
      // If we have loaded image data, draw it
      ctx.drawImage(bitmapItem.imageData, 0, 0, bitmapItem.width, bitmapItem.height);
    } else if (bitmapItem) {
      // Draw placeholder with bitmap dimensions
      ctx.fillStyle = '#555555';
      ctx.fillRect(0, 0, bitmapItem.width, bitmapItem.height);
      ctx.strokeStyle = '#777777';
      ctx.lineWidth = 1;
      ctx.strokeRect(0, 0, bitmapItem.width, bitmapItem.height);
    } else {
      // No bitmap info, draw small placeholder
      ctx.fillStyle = '#555555';
      ctx.fillRect(0, 0, 100, 100);
    }

    ctx.restore();
  }

  private renderShape(shape: Shape, depth: number = 0): void {
    const ctx = this.ctx;
    ctx.save();

    // Apply shape's transformation matrix
    this.applyMatrix(shape.matrix);

    // Build fill style lookup
    const fillStyles = new Map<number, FillStyle>();
    for (const fill of shape.fills) {
      fillStyles.set(fill.index, fill);
    }

    // Build stroke style lookup
    const strokeStyles = new Map<number, StrokeStyle>();
    for (const stroke of shape.strokes) {
      strokeStyles.set(stroke.index, stroke);
    }

    // Group edges by fill style and build continuous paths
    // Track current position for each fill style to connect edges properly
    const fillPaths = new Map<number, Path2D>();
    const fillPositions = new Map<number, { x: number; y: number }>();
    // Group edges by stroke style
    const strokePaths = new Map<number, Path2D>();
    // Combined path for hit testing
    const combinedPath = new Path2D();

    const EPSILON = 0.5;

    for (const edge of shape.edges) {
      const path = this.edgeToPath(edge);
      combinedPath.addPath(path);

      // Handle fills - build continuous paths by connecting edges
      if (edge.fillStyle1 !== undefined) {
        if (!fillPaths.has(edge.fillStyle1)) {
          fillPaths.set(edge.fillStyle1, new Path2D());
        }
        const fillPath = fillPaths.get(edge.fillStyle1)!;
        const pos = fillPositions.get(edge.fillStyle1);
        this.appendEdgeToPath(fillPath, edge.commands, pos, EPSILON);
        // Update position to end of this edge
        const lastCmd = this.getLastPoint(edge.commands);
        if (lastCmd) fillPositions.set(edge.fillStyle1, lastCmd);
      }

      // Handle fillStyle0 (left side fill) - use reversed commands
      if (edge.fillStyle0 !== undefined && edge.fillStyle0 !== edge.fillStyle1) {
        if (!fillPaths.has(edge.fillStyle0)) {
          fillPaths.set(edge.fillStyle0, new Path2D());
        }
        const fillPath = fillPaths.get(edge.fillStyle0)!;
        const pos = fillPositions.get(edge.fillStyle0);
        const reversedCmds = this.reverseCommands(edge.commands);
        this.appendEdgeToPath(fillPath, reversedCmds, pos, EPSILON);
        const lastCmd = this.getLastPoint(reversedCmds);
        if (lastCmd) fillPositions.set(edge.fillStyle0, lastCmd);
      }

      // Handle strokes
      if (edge.strokeStyle !== undefined) {
        if (!strokePaths.has(edge.strokeStyle)) {
          strokePaths.set(edge.strokeStyle, new Path2D());
        }
        strokePaths.get(edge.strokeStyle)!.addPath(path);
      }
    }

    // Capture debug element before rendering
    if (this.debugMode) {
      this.debugElements.push({
        type: 'shape',
        element: shape,
        path: combinedPath,
        transform: ctx.getTransform(),
        depth,
        parentPath: [...this.debugSymbolPath],
        fillStyles,
        strokeStyles,
        edges: shape.edges
      });
    }

    // Render filled paths - sort by style index for consistent ordering
    const sortedFillStyles = Array.from(fillPaths.entries()).sort((a, b) => a[0] - b[0]);

    for (const [styleIndex, path] of sortedFillStyles) {
      const fill = fillStyles.get(styleIndex);
      if (fill) {
        ctx.fillStyle = this.getFillStyle(fill);
        ctx.fill(path, 'evenodd');
      }
    }

    // Render stroked paths
    const sortedStrokeStyles = Array.from(strokePaths.entries()).sort((a, b) => a[0] - b[0]);

    for (const [styleIndex, path] of sortedStrokeStyles) {
      const stroke = strokeStyles.get(styleIndex);
      if (stroke) {
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = stroke.weight;
        ctx.lineCap = stroke.caps === 'none' ? 'butt' : stroke.caps || 'round';
        ctx.lineJoin = stroke.joints || 'round';
        ctx.stroke(path);
      }
    }

    ctx.restore();
  }

  private edgeToPath(edge: Edge): Path2D {
    const path = new Path2D();
    let currentX = NaN;
    let currentY = NaN;
    const EPSILON = 0.5; // Tolerance for considering points as same

    for (const cmd of edge.commands) {
      // Skip commands with invalid coordinates
      if ('x' in cmd && (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y))) {
        continue;
      }

      switch (cmd.type) {
        case 'M':
          // Skip redundant moveTo to same position
          if (Number.isNaN(currentX) || Math.abs(cmd.x - currentX) > EPSILON || Math.abs(cmd.y - currentY) > EPSILON) {
            path.moveTo(cmd.x, cmd.y);
          }
          currentX = cmd.x;
          currentY = cmd.y;
          break;
        case 'L':
          // Only draw line if it's not to the same point
          if (Math.abs(cmd.x - currentX) > EPSILON || Math.abs(cmd.y - currentY) > EPSILON) {
            path.lineTo(cmd.x, cmd.y);
          }
          currentX = cmd.x;
          currentY = cmd.y;
          break;
        case 'Q':
          if (!Number.isFinite(cmd.cx) || !Number.isFinite(cmd.cy)) continue;
          path.quadraticCurveTo(cmd.cx, cmd.cy, cmd.x, cmd.y);
          currentX = cmd.x;
          currentY = cmd.y;
          break;
        case 'C':
          if (!Number.isFinite(cmd.c1x) || !Number.isFinite(cmd.c1y) ||
              !Number.isFinite(cmd.c2x) || !Number.isFinite(cmd.c2y)) continue;
          path.bezierCurveTo(cmd.c1x, cmd.c1y, cmd.c2x, cmd.c2y, cmd.x, cmd.y);
          currentX = cmd.x;
          currentY = cmd.y;
          break;
        case 'Z':
          path.closePath();
          break;
      }
    }

    return path;
  }

  // Reverse the path direction for fillStyle0 (left-side fill)
  private reverseEdgePath(edge: Edge): Path2D {
    const path = new Path2D();
    const commands = edge.commands;

    if (commands.length === 0) return path;

    // Build list of points and their types, then traverse in reverse
    const points: { x: number; y: number; type: string; cx?: number; cy?: number; c1x?: number; c1y?: number; c2x?: number; c2y?: number }[] = [];

    for (const cmd of commands) {
      if (cmd.type === 'M' || cmd.type === 'L') {
        points.push({ x: cmd.x, y: cmd.y, type: cmd.type });
      } else if (cmd.type === 'Q') {
        points.push({ x: cmd.x, y: cmd.y, type: 'Q', cx: cmd.cx, cy: cmd.cy });
      } else if (cmd.type === 'C') {
        points.push({ x: cmd.x, y: cmd.y, type: 'C', c1x: cmd.c1x, c1y: cmd.c1y, c2x: cmd.c2x, c2y: cmd.c2y });
      }
    }

    if (points.length === 0) return path;

    // Start from the last point
    const lastPoint = points[points.length - 1];
    path.moveTo(lastPoint.x, lastPoint.y);

    // Traverse backwards
    for (let i = points.length - 1; i > 0; i--) {
      const current = points[i];
      const prev = points[i - 1];

      if (current.type === 'L' || current.type === 'M') {
        path.lineTo(prev.x, prev.y);
      } else if (current.type === 'Q' && current.cx !== undefined && current.cy !== undefined) {
        // Quadratic curve - control point stays the same, just swap endpoints
        path.quadraticCurveTo(current.cx, current.cy, prev.x, prev.y);
      } else if (current.type === 'C' && current.c1x !== undefined) {
        // Cubic curve - swap control points order
        path.bezierCurveTo(current.c2x!, current.c2y!, current.c1x, current.c1y!, prev.x, prev.y);
      }
    }

    return path;
  }

  // Append edge commands to a path, connecting to previous position if possible
  private appendEdgeToPath(
    path: Path2D,
    commands: PathCommand[],
    currentPos: { x: number; y: number } | undefined,
    epsilon: number
  ): void {
    let isFirst = true;
    let lastX = currentPos?.x ?? NaN;
    let lastY = currentPos?.y ?? NaN;

    for (const cmd of commands) {
      if ('x' in cmd && (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y))) {
        continue;
      }

      switch (cmd.type) {
        case 'M':
          // Skip moveTo if we're already at this position (connecting edges)
          if (isFirst && currentPos &&
              Math.abs(cmd.x - currentPos.x) <= epsilon &&
              Math.abs(cmd.y - currentPos.y) <= epsilon) {
            // Already at position, skip moveTo to maintain continuity
          } else {
            path.moveTo(cmd.x, cmd.y);
          }
          lastX = cmd.x;
          lastY = cmd.y;
          isFirst = false;
          break;
        case 'L':
          path.lineTo(cmd.x, cmd.y);
          lastX = cmd.x;
          lastY = cmd.y;
          isFirst = false;
          break;
        case 'Q':
          if (Number.isFinite(cmd.cx) && Number.isFinite(cmd.cy)) {
            path.quadraticCurveTo(cmd.cx, cmd.cy, cmd.x, cmd.y);
          }
          lastX = cmd.x;
          lastY = cmd.y;
          isFirst = false;
          break;
        case 'C':
          if (Number.isFinite(cmd.c1x) && Number.isFinite(cmd.c1y) &&
              Number.isFinite(cmd.c2x) && Number.isFinite(cmd.c2y)) {
            path.bezierCurveTo(cmd.c1x, cmd.c1y, cmd.c2x, cmd.c2y, cmd.x, cmd.y);
          }
          lastX = cmd.x;
          lastY = cmd.y;
          isFirst = false;
          break;
        case 'Z':
          path.closePath();
          break;
      }
    }
  }

  // Get the last point from a command list
  private getLastPoint(commands: PathCommand[]): { x: number; y: number } | null {
    for (let i = commands.length - 1; i >= 0; i--) {
      const cmd = commands[i];
      if ('x' in cmd && Number.isFinite(cmd.x) && Number.isFinite(cmd.y)) {
        return { x: cmd.x, y: cmd.y };
      }
    }
    return null;
  }

  // Reverse commands for fillStyle0 (left-side fill)
  private reverseCommands(commands: PathCommand[]): PathCommand[] {
    const points: { x: number; y: number; type: string; cx?: number; cy?: number; c1x?: number; c1y?: number; c2x?: number; c2y?: number }[] = [];

    for (const cmd of commands) {
      if (cmd.type === 'M' || cmd.type === 'L') {
        points.push({ x: cmd.x, y: cmd.y, type: cmd.type });
      } else if (cmd.type === 'Q') {
        points.push({ x: cmd.x, y: cmd.y, type: 'Q', cx: cmd.cx, cy: cmd.cy });
      } else if (cmd.type === 'C') {
        points.push({ x: cmd.x, y: cmd.y, type: 'C', c1x: cmd.c1x, c1y: cmd.c1y, c2x: cmd.c2x, c2y: cmd.c2y });
      }
    }

    if (points.length === 0) return [];

    const result: PathCommand[] = [];
    const lastPoint = points[points.length - 1];
    result.push({ type: 'M', x: lastPoint.x, y: lastPoint.y });

    for (let i = points.length - 1; i > 0; i--) {
      const current = points[i];
      const prev = points[i - 1];

      if (current.type === 'L' || current.type === 'M') {
        result.push({ type: 'L', x: prev.x, y: prev.y });
      } else if (current.type === 'Q' && current.cx !== undefined && current.cy !== undefined) {
        result.push({ type: 'Q', cx: current.cx, cy: current.cy, x: prev.x, y: prev.y });
      } else if (current.type === 'C' && current.c1x !== undefined) {
        result.push({ type: 'C', c1x: current.c2x!, c1y: current.c2y!, c2x: current.c1x, c2y: current.c1y!, x: prev.x, y: prev.y });
      }
    }

    return result;
  }

  private getFillStyle(fill: FillStyle): string | CanvasGradient {
    if (fill.type === 'solid' && fill.color) {
      if (fill.alpha !== undefined && fill.alpha < 1) {
        return this.colorWithAlpha(fill.color, fill.alpha);
      }
      return fill.color;
    }

    // Handle gradient fills
    if (fill.type === 'linear' && fill.gradient && fill.gradient.length > 0) {
      return this.createLinearGradient(fill);
    }

    if (fill.type === 'radial' && fill.gradient && fill.gradient.length > 0) {
      return this.createRadialGradient(fill);
    }

    return '#000000';
  }

  private createLinearGradient(fill: FillStyle): CanvasGradient | string {
    if (!fill.gradient || fill.gradient.length === 0) {
      return fill.gradient?.[0]?.color || '#000000';
    }

    // Flash gradient coordinate system: gradients span from -819.2 to 819.2 in local space
    // (16384 twips / 20 = 819.2 pixels)
    const GRADIENT_SIZE = 819.2;

    let x0: number, y0: number, x1: number, y1: number;

    if (fill.matrix) {
      const m = fill.matrix;
      // The gradient matrix transforms from gradient space to shape-local space
      // Base gradient is horizontal from (-GRADIENT_SIZE, 0) to (GRADIENT_SIZE, 0)
      x0 = m.a * (-GRADIENT_SIZE) + m.tx;
      y0 = m.b * (-GRADIENT_SIZE) + m.ty;
      x1 = m.a * GRADIENT_SIZE + m.tx;
      y1 = m.b * GRADIENT_SIZE + m.ty;
    } else {
      // Default horizontal gradient
      x0 = -GRADIENT_SIZE;
      y0 = 0;
      x1 = GRADIENT_SIZE;
      y1 = 0;
    }

    const gradient = this.ctx.createLinearGradient(x0, y0, x1, y1);

    // Add color stops
    for (const entry of fill.gradient) {
      const color = entry.alpha < 1
        ? this.colorWithAlpha(entry.color, entry.alpha)
        : entry.color;
      gradient.addColorStop(Math.max(0, Math.min(1, entry.ratio)), color);
    }

    return gradient;
  }

  private createRadialGradient(fill: FillStyle): CanvasGradient | string {
    if (!fill.gradient || fill.gradient.length === 0) {
      return fill.gradient?.[0]?.color || '#000000';
    }

    // Flash radial gradient: circle centered at (0, 0) with radius 819.2
    const GRADIENT_SIZE = 819.2;

    let cx = 0;
    let cy = 0;
    let radius = GRADIENT_SIZE;

    if (fill.matrix) {
      const m = fill.matrix;
      // Gradient center from matrix translation
      cx = m.tx;
      cy = m.ty;

      // Calculate average scale for radius
      const scaleX = Math.sqrt(m.a * m.a + m.b * m.b);
      const scaleY = Math.sqrt(m.c * m.c + m.d * m.d);
      radius = GRADIENT_SIZE * ((scaleX + scaleY) / 2);
    }

    const gradient = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);

    // Add color stops
    for (const entry of fill.gradient) {
      const color = entry.alpha < 1
        ? this.colorWithAlpha(entry.color, entry.alpha)
        : entry.color;
      gradient.addColorStop(Math.max(0, Math.min(1, entry.ratio)), color);
    }

    return gradient;
  }

  private colorWithAlpha(color: string, alpha: number): string {
    // Convert hex color to rgba
    if (color.startsWith('#')) {
      const hex = color.substring(1);
      let r: number, g: number, b: number;

      if (hex.length === 3) {
        // #RGB format - expand to #RRGGBB
        r = parseInt(hex[0] + hex[0], 16);
        g = parseInt(hex[1] + hex[1], 16);
        b = parseInt(hex[2] + hex[2], 16);
      } else if (hex.length >= 6) {
        // #RRGGBB or #RRGGBBAA format
        r = parseInt(hex.substring(0, 2), 16);
        g = parseInt(hex.substring(2, 4), 16);
        b = parseInt(hex.substring(4, 6), 16);
      } else {
        // Invalid format, return as-is
        return color;
      }

      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    return color;
  }

  private applyMatrix(matrix: Matrix): void {
    this.ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty);
  }
}
