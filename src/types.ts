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
}

export interface BitmapItem {
  name: string;
  href: string; // Filename in archive
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
  letterSpacing?: number;
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

export type Filter = BlurFilter | GlowFilter | DropShadowFilter;

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
