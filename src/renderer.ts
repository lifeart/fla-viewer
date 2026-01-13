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
  Point
} from './types';

export class FLARenderer {
  private ctx: CanvasRenderingContext2D;
  private doc: FLADocument | null = null;
  private canvas: HTMLCanvasElement;
  private scale: number = 1;
  private dpr: number = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get 2D context');
    }
    this.ctx = ctx;
    this.dpr = window.devicePixelRatio || 1;
  }

  setDocument(doc: FLADocument): void {
    this.doc = doc;
    this.dpr = window.devicePixelRatio || 1;

    // Clear state from previous document
    this.missingSymbols.clear();
    this.logCount = 0;

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

    // Fully reset canvas state
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Apply DPR and content scale together
    const combinedScale = this.scale * this.dpr;
    ctx.setTransform(combinedScale, 0, 0, combinedScale, 0, 0);

    // Fill with background color
    ctx.fillStyle = doc.backgroundColor;
    ctx.fillRect(0, 0, doc.width, doc.height);

    // Reset log count for debugging
    this.logCount = 0;

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

    // Render layers in reverse order (bottom to top in Flash = high index to low index)
    // In Flash, layer 0 is at the top of the layer list and renders ON TOP (last)
    for (let i = timeline.layers.length - 1; i >= 0; i--) {
      const layer = timeline.layers[i];

      // Skip camera layer (it's a reference, not rendered content)
      if (i === timeline.cameraLayerIndex) {
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

    // Check if we need to interpolate (tween)
    const nextKeyframe = this.findNextKeyframe(layer.frames, frame);

    for (let elementIndex = 0; elementIndex < frame.elements.length; elementIndex++) {
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
      this.renderShape(element);
    } else if (element.type === 'video') {
      this.renderVideoInstance(element);
    } else if (element.type === 'bitmap') {
      this.renderBitmapInstance(element);
    }
  }

  private logCount = 0;
  private missingSymbols = new Set<string>();
  private renderSymbolInstance(instance: SymbolInstance, depth: number, _parentFrameIndex: number): void {
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

    // Debug: log symbol rendering details
    if (instance.libraryItemName === 'aero' || (this.logCount < 5 && depth === 0)) {
      console.log(`Symbol: "${instance.libraryItemName}" at depth=${depth}, firstFrame=${instance.firstFrame || 0}, symbolFrame will be=${(instance.firstFrame || 0) % Math.max(1, symbol.timeline.totalFrames)}, totalSymbolFrames=${symbol.timeline.totalFrames}`);
      if (depth === 0) this.logCount++;
    }

    const ctx = this.ctx;
    ctx.save();

    // Apply transformation matrix
    // Note: The matrix tx/ty already positions the symbol correctly
    // The transformationPoint is metadata about the pivot, but it's already
    // accounted for in how the matrix was calculated by Flash
    this.applyMatrix(instance.matrix);

    // Calculate which frame to render based on symbol type and loop mode
    // In Flash:
    // - 'single frame': Always shows the specified firstFrame
    // - 'graphic' with 'loop'/'play once': Internal timeline syncs with parent timeline
    // - 'movieclip': Internal timeline plays independently (not fully supported)
    const firstFrame = instance.firstFrame || 0;
    const totalSymbolFrames = Math.max(1, symbol.timeline.totalFrames);
    let symbolFrame: number;

    if (instance.loop === 'single frame') {
      // Always show the specified firstFrame
      symbolFrame = firstFrame % totalSymbolFrames;
    } else {
      // For both 'loop' and 'play once', just use firstFrame
      // The animator typically sets firstFrame at each keyframe to control which frame shows
      // More advanced sync with parent timeline causes jumping artifacts
      symbolFrame = firstFrame % totalSymbolFrames;
    }

    // Render symbol's timeline
    this.renderTimeline(symbol.timeline, symbolFrame, depth + 1);

    ctx.restore();
  }

  private renderVideoInstance(video: VideoInstance): void {
    const ctx = this.ctx;
    ctx.save();

    // Apply transformation
    this.applyMatrix(video.matrix);

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

  private renderBitmapInstance(bitmap: BitmapInstance): void {
    if (!this.doc) return;

    const ctx = this.ctx;
    ctx.save();

    // Apply transformation
    this.applyMatrix(bitmap.matrix);

    // Look up bitmap item from library
    const bitmapItem = this.doc.bitmaps.get(bitmap.libraryItemName);

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

  private renderShape(shape: Shape): void {
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

    // Group edges by fill style and combine paths
    const fillPaths = new Map<number, Path2D>();
    // Group edges by stroke style
    const strokePaths = new Map<number, Path2D>();

    for (const edge of shape.edges) {
      const path = this.edgeToPath(edge);

      // Handle fills
      if (edge.fillStyle0 !== undefined || edge.fillStyle1 !== undefined) {
        // Handle fillStyle1 (right side fill)
        if (edge.fillStyle1 !== undefined) {
          if (!fillPaths.has(edge.fillStyle1)) {
            fillPaths.set(edge.fillStyle1, new Path2D());
          }
          fillPaths.get(edge.fillStyle1)!.addPath(path);
        }

        // Handle fillStyle0 (left side fill)
        if (edge.fillStyle0 !== undefined && edge.fillStyle0 !== edge.fillStyle1) {
          if (!fillPaths.has(edge.fillStyle0)) {
            fillPaths.set(edge.fillStyle0, new Path2D());
          }
          fillPaths.get(edge.fillStyle0)!.addPath(path);
        }
      }

      // Handle strokes
      if (edge.strokeStyle !== undefined) {
        if (!strokePaths.has(edge.strokeStyle)) {
          strokePaths.set(edge.strokeStyle, new Path2D());
        }
        strokePaths.get(edge.strokeStyle)!.addPath(path);
      }
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

  private getFillStyle(fill: FillStyle): string | CanvasGradient {
    if (fill.type === 'solid' && fill.color) {
      if (fill.alpha !== undefined && fill.alpha < 1) {
        return this.colorWithAlpha(fill.color, fill.alpha);
      }
      return fill.color;
    }

    // For gradients, create a simple approximation
    if ((fill.type === 'linear' || fill.type === 'radial') && fill.gradient) {
      const gradient = fill.gradient;
      if (gradient.length > 0) {
        // Use the first color as a fallback
        return gradient[0].color;
      }
    }

    return '#000000';
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
