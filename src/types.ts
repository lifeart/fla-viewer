// Core FLA document types

export interface FLADocument {
  width: number;
  height: number;
  frameRate: number;
  backgroundColor: string;
  timelines: Timeline[];
  symbols: Map<string, Symbol>;
  bitmaps: Map<string, BitmapItem>;
  sounds: Map<string, SoundItem>;
  videos: Map<string, VideoItem>;
}

export interface BitmapItem {
  name: string;
  href: string; // Filename in archive
  bitmapDataHRef?: string; // Binary data filename in bin/ folder (e.g., "M 1 1731603320.dat")
  width: number; // In pixels
  height: number; // In pixels
  sourceExternalFilepath?: string;
  imageData?: HTMLImageElement; // Loaded image (if available)
}

export interface SoundItem {
  name: string;
  href: string; // Filename in archive
  format?: string; // e.g., "44kHz 16bit Stereo"
  sampleCount?: number;
  audioData?: AudioBuffer; // Loaded audio (if available)
}

export interface VideoItem {
  name: string;
  href: string; // Binary data filename in archive (videoDataHRef)
  width: number; // In pixels
  height: number; // In pixels
  fps?: number;
  duration?: number; // Length in seconds
  videoType?: string; // e.g., "h263 media"
  sourceExternalFilepath?: string;
}

export interface Timeline {
  name: string;
  layers: Layer[];
  totalFrames: number;
  cameraLayerIndex?: number; // Index of the camera layer for camera transforms
  referenceLayers: Set<number>; // Indices of layers that should not be rendered (guides, camera frames, etc.)
}

export interface Layer {
  name: string;
  color: string;
  visible: boolean;
  locked: boolean;
  outline: boolean; // Editor-only outline view (not rendered)
  transparent?: boolean; // Layer has transparency/onion-skin enabled
  alphaPercent?: number; // Layer alpha percentage (0-100)
  layerType?: 'normal' | 'guide' | 'folder' | 'camera' | 'mask' | 'masked';
  parentLayerIndex?: number;
  maskLayerIndex?: number; // For masked layers, index of the mask layer
  frames: Frame[];
}

export interface Frame {
  index: number;
  duration: number;
  keyMode: number;
  tweenType?: 'motion' | 'shape' | 'none';
  acceleration?: number;
  elements: DisplayElement[];
  tweens?: Tween[];
  sound?: FrameSound;
  morphShape?: MorphShape; // For shape tweens
}

export interface FrameSound {
  name: string; // Reference to SoundItem name
  sync: 'event' | 'start' | 'stop' | 'stream';
  inPoint44?: number; // Start point in samples at 44kHz
  outPoint44?: number; // End point in samples at 44kHz
  loopCount?: number;
}

export interface Tween {
  target: string;
  intensity?: number;
  customEase?: Point[];
}

export interface Point {
  x: number;
  y: number;
}

export type DisplayElement = SymbolInstance | Shape | VideoInstance | BitmapInstance | TextInstance;

// Flash/Animate blend modes
export type BlendMode =
  | 'normal'
  | 'layer'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'hardlight'
  | 'add'
  | 'subtract'
  | 'difference'
  | 'invert'
  | 'alpha'
  | 'erase';

export interface SymbolInstance {
  type: 'symbol';
  libraryItemName: string;
  symbolType: 'graphic' | 'movieclip' | 'button';
  matrix: Matrix;
  transformationPoint: Point;
  centerPoint3D?: Point; // 3D transformation center point
  loop: 'loop' | 'play once' | 'single frame';
  firstFrame?: number;
  colorTransform?: ColorTransform;
  filters?: Filter[];
  blendMode?: BlendMode;
}

export interface VideoInstance {
  type: 'video';
  libraryItemName: string;
  matrix: Matrix;
  width: number;
  height: number;
}

export interface BitmapInstance {
  type: 'bitmap';
  libraryItemName: string;
  matrix: Matrix;
}

export interface TextInstance {
  type: 'text';
  matrix: Matrix;
  left: number;
  width: number;
  height: number;
  textRuns: TextRun[];
  filters?: Filter[];
}

export interface TextRun {
  characters: string;
  alignment?: 'left' | 'center' | 'right' | 'justify';
  size: number;
  lineHeight?: number;
  face?: string;
  fillColor: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  letterSpacing?: number;
  indent?: number; // First-line paragraph indent in twips
  leftMargin?: number; // Left margin in twips
  rightMargin?: number; // Right margin in twips
  url?: string; // Hyperlink URL
  target?: string; // Link target (_blank, _self, etc.)
  characterPosition?: 'normal' | 'subscript' | 'superscript';
}

export interface Shape {
  type: 'shape';
  matrix: Matrix;
  fills: FillStyle[];
  strokes: StrokeStyle[];
  edges: Edge[];
}

export interface Matrix {
  a: number;  // scale x
  b: number;  // skew y
  c: number;  // skew x
  d: number;  // scale y
  tx: number; // translate x
  ty: number; // translate y
}

export interface ColorTransform {
  alphaMultiplier?: number;
  redMultiplier?: number;
  greenMultiplier?: number;
  blueMultiplier?: number;
  alphaOffset?: number;
  redOffset?: number;
  greenOffset?: number;
  blueOffset?: number;
}

export interface FillStyle {
  index: number;
  type: 'solid' | 'linear' | 'radial' | 'bitmap';
  color?: string;
  alpha?: number;
  gradient?: GradientEntry[];
  matrix?: Matrix;
  bitmapPath?: string; // Reference to bitmap in library (for bitmap fills)
  spreadMethod?: 'pad' | 'reflect' | 'repeat'; // Gradient spread mode (default: pad)
  interpolationMethod?: 'rgb' | 'linearRGB'; // Color interpolation mode (default: rgb)
  focalPointRatio?: number; // Off-center focal point for radial gradients (-1 to 1)
  bitmapIsClipped?: boolean; // For bitmap fills: clip instead of repeat
  bitmapIsSmoothed?: boolean; // For bitmap fills: enable/disable smoothing (default: true)
}

export interface GradientEntry {
  color: string;
  alpha: number;
  ratio: number;
}

export interface StrokeStyle {
  index: number;
  color: string;
  weight: number;
  caps?: 'none' | 'round' | 'square';
  joints?: 'miter' | 'round' | 'bevel';
  miterLimit?: number; // Maximum miter length (default: 3 in Flash)
  scaleMode?: 'normal' | 'horizontal' | 'vertical' | 'none'; // Stroke scaling behavior
  pixelHinting?: boolean; // Snap stroke to pixel boundaries
}

export interface Edge {
  fillStyle0?: number;
  fillStyle1?: number;
  strokeStyle?: number;
  commands: PathCommand[];
}

export type PathCommand =
  | { type: 'M'; x: number; y: number }
  | { type: 'L'; x: number; y: number }
  | { type: 'Q'; cx: number; cy: number; x: number; y: number }
  | { type: 'C'; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number }
  | { type: 'Z' }; // Close path

export interface Symbol {
  name: string;
  itemID: string;
  symbolType: 'graphic' | 'movieclip' | 'button';
  timeline: Timeline;
}

// Player state
export interface PlayerState {
  playing: boolean;
  currentFrame: number;
  totalFrames: number;
  fps: number;
}

// Filters
export interface BlurFilter {
  type: 'blur';
  blurX: number;
  blurY: number;
  quality?: number; // 1-3, defaults to 1
}

export interface GlowFilter {
  type: 'glow';
  blurX: number;
  blurY: number;
  color: string;
  strength: number; // 0-1 (normalized from 0-255)
  alpha?: number;
  inner?: boolean;
  knockout?: boolean;
  quality?: number;
}

export interface DropShadowFilter {
  type: 'dropShadow';
  blurX: number;
  blurY: number;
  color: string;
  strength: number; // 0-1 (normalized from 0-255)
  alpha?: number;
  distance: number;
  angle: number; // in degrees
  inner?: boolean;
  knockout?: boolean;
  hideObject?: boolean;
  quality?: number;
}

export interface BevelFilter {
  type: 'bevel';
  blurX: number;
  blurY: number;
  strength: number; // 0-1 (normalized from 0-255)
  highlightColor: string;
  highlightAlpha?: number;
  shadowColor: string;
  shadowAlpha?: number;
  distance: number;
  angle: number; // in degrees
  inner?: boolean;
  knockout?: boolean;
  quality?: number;
  bevelType?: 'inner' | 'outer' | 'full'; // XFL: type attribute
}

export interface ColorMatrixFilter {
  type: 'colorMatrix';
  // 4x5 matrix stored as 20 values in row-major order
  // [r0, r1, r2, r3, r4, g0, g1, g2, g3, g4, b0, b1, b2, b3, b4, a0, a1, a2, a3, a4]
  // Each row: [R, G, B, A, offset] where output = input * matrix
  matrix: number[];
}

export interface ConvolutionFilter {
  type: 'convolution';
  matrixX: number; // Width of matrix
  matrixY: number; // Height of matrix
  matrix: number[]; // Kernel values (matrixX * matrixY elements)
  divisor: number; // Divide result by this value
  bias: number; // Add this to result after division
  preserveAlpha?: boolean; // Don't apply to alpha channel
  clamp?: boolean; // Clamp output to 0-255
  color?: string; // Default color for out-of-bounds pixels
  alpha?: number; // Default alpha for out-of-bounds pixels
}

export interface GradientGlowFilter {
  type: 'gradientGlow';
  blurX: number;
  blurY: number;
  strength: number;
  distance: number;
  angle: number;
  colors: GradientFilterEntry[];
  inner?: boolean;
  knockout?: boolean;
  quality?: number;
}

export interface GradientBevelFilter {
  type: 'gradientBevel';
  blurX: number;
  blurY: number;
  strength: number;
  distance: number;
  angle: number;
  colors: GradientFilterEntry[];
  inner?: boolean;
  knockout?: boolean;
  quality?: number;
}

export interface GradientFilterEntry {
  color: string;
  alpha: number;
  ratio: number; // 0-255 position in gradient
}

export type Filter = BlurFilter | GlowFilter | DropShadowFilter | BevelFilter | ColorMatrixFilter | ConvolutionFilter | GradientGlowFilter | GradientBevelFilter;

// Shape Tweens (MorphShape)
export interface MorphCurve {
  controlPointA: Point;
  anchorPointA: Point;
  controlPointB: Point;
  anchorPointB: Point;
  isLine: boolean;
}

export interface MorphSegment {
  startPointA: Point;
  startPointB: Point;
  fillIndex1?: number;
  fillIndex2?: number;
  strokeIndex1?: number;
  strokeIndex2?: number;
  curves: MorphCurve[];
}

export interface MorphShape {
  segments: MorphSegment[];
}
