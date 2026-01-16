# FLA Viewer - Missing Features & Improvements

Based on analysis of [JPEXS Free Flash Decompiler](https://github.com/jindrapetrik/jpexs-decompiler) source code.

---

## Filters (High Priority)

Currently implemented: `blur`, `glow`, `dropShadow`

### Missing Filters

| Filter | JPEXS Reference | Description |
|--------|-----------------|-------------|
| **BevelFilter** | `types/filters/BEVELFILTER.java` | Embossed/beveled edge effect with highlight and shadow colors |
| **ColorMatrixFilter** | `types/filters/COLORMATRIXFILTER.java` | 4x5 matrix for color transformations (hue, saturation, brightness) |
| **ConvolutionFilter** | `types/filters/CONVOLUTIONFILTER.java` | Custom kernel matrix for sharpen, emboss, edge detection |
| **GradientGlowFilter** | `types/filters/GRADIENTGLOWFILTER.java` | Glow with gradient colors instead of solid |
| **GradientBevelFilter** | `types/filters/GRADIENTBEVELFILTER.java` | Bevel with gradient colors |

**Implementation notes:**
- `ColorMatrixFilter` can be approximated using Canvas `filter` property with SVG filters
- Bevel filters require multi-pass rendering (highlight + shadow)
- Gradient filters need gradient color stop support

---

## Gradient Fills (Medium Priority)

Currently implemented: Basic linear/radial gradients with color stops

### Missing Features

| Feature | JPEXS Reference | Description |
|---------|-----------------|-------------|
| **Spread Modes** | `types/GRADIENT.java` | `pad` (default), `reflect`, `repeat` - controls behavior beyond gradient bounds |
| **Interpolation Modes** | `types/GRADIENT.java` | `normal RGB` vs `linear RGB` - affects color blending quality |
| **Focal Point** | `types/FOCALGRADIENT.java` | Off-center focal point for radial gradients |

**JPEXS constants:**
```java
// Spread modes (2 bits)
SPREAD_PAD_MODE = 0
SPREAD_REFLECT_MODE = 1
SPREAD_REPEAT_MODE = 2

// Interpolation modes (2 bits)
INTERPOLATION_RGB_MODE = 0
INTERPOLATION_LINEAR_RGB_MODE = 1
```

**Implementation notes:**
- Canvas gradients don't natively support spread modes
- `reflect` and `repeat` require manual gradient extension or pattern-based approach
- Linear RGB interpolation produces more natural color transitions

---

## Bitmap Fills (Medium Priority)

Currently implemented: Repeating bitmap pattern with matrix transform

### Missing Features

| Feature | JPEXS Reference | Description |
|---------|-----------------|-------------|
| **Clipped Bitmap** | `types/FILLSTYLE.java` | `CLIPPED_BITMAP (0x41)` - bitmap doesn't repeat, clips at edges |
| **Non-Smoothed Repeating** | `types/FILLSTYLE.java` | `NON_SMOOTHED_REPEATING_BITMAP (0x42)` - pixel-perfect, no interpolation |
| **Non-Smoothed Clipped** | `types/FILLSTYLE.java` | `NON_SMOOTHED_CLIPPED_BITMAP (0x43)` - clipped + pixel-perfect |

**JPEXS fill style types:**
```java
REPEATING_BITMAP = 0x40
CLIPPED_BITMAP = 0x41
NON_SMOOTHED_REPEATING_BITMAP = 0x42
NON_SMOOTHED_CLIPPED_BITMAP = 0x43
```

**Implementation notes:**
- Clipped fills need clip path before pattern application
- Non-smoothed requires `ctx.imageSmoothingEnabled = false`

---

## Stroke Styles (Medium Priority)

Currently implemented: Basic solid strokes with weight, caps, joints

### Missing Features

| Feature | JPEXS Reference | Description |
|---------|-----------------|-------------|
| **Scale Modes** | `types/LINESTYLE2.java` | `noHScaleFlag`, `noVScaleFlag` - prevent stroke scaling in specific directions |
| **Pixel Hinting** | `types/LINESTYLE2.java` | `pixelHintingFlag` - snap strokes to pixel boundaries |
| **Miter Limit** | `types/LINESTYLE2.java` | `miterLimitFactor` - control miter join sharpness |
| **Gradient/Bitmap Strokes** | `types/LINESTYLE2.java` | `hasFillFlag` - strokes with gradient or bitmap fills |
| **No Cap Style** | `types/LINESTYLE2.java` | `NO_CAP (1)` - currently only `round` and `square` |

**JPEXS cap/join constants:**
```java
// Cap styles
ROUND_CAP = 0
NO_CAP = 1
SQUARE_CAP = 2

// Join styles
ROUND_JOIN = 0
BEVEL_JOIN = 1
MITER_JOIN = 2
```

**Implementation notes:**
- Scale mode handling requires tracking original stroke width and current transform
- Pixel hinting: round stroke coordinates to nearest pixel

---

## Audio Formats (Medium Priority)

Currently implemented: MP3 via Web Audio API

### Missing Formats

| Format | JPEXS Reference | Description |
|--------|-----------------|-------------|
| **ADPCM** | `types/sound/SoundFormat.java` | Adaptive PCM, common in older Flash files |
| **Uncompressed PCM** | `types/sound/SoundFormat.java` | Raw audio (native/little endian) |
| **NellyMoser** | `types/sound/SoundFormat.java` | Voice codec (8kHz, 16kHz, standard) |
| **Speex** | `types/sound/SoundFormat.java` | Voice codec (rare) |

**JPEXS format constants:**
```java
FORMAT_UNCOMPRESSED_NATIVE_ENDIAN = 0
FORMAT_ADPCM = 1
FORMAT_MP3 = 2
FORMAT_UNCOMPRESSED_LITTLE_ENDIAN = 3
FORMAT_NELLYMOSER16KHZ = 4
FORMAT_NELLYMOSER8KHZ = 5
FORMAT_NELLYMOSER = 6
FORMAT_SPEEX = 11
```

**Implementation notes:**
- ADPCM decoding requires custom decoder (no native browser support)
- PCM can be directly loaded into AudioBuffer
- NellyMoser/Speex may require WebAssembly decoders

---

## Video Playback (Low Priority)

Currently implemented: Placeholder rendering only

### Missing Features

| Feature | JPEXS Reference | Description |
|---------|-----------------|-------------|
| **FLV Parsing** | `xfl/MovieBinDataGenerator.java` | Parse FLV container format |
| **H.263 Codec** | FLV video tags | Sorenson Spark video decoding |
| **VP6 Codec** | FLV video tags | On2 VP6 video decoding |
| **Audio Sync** | FLV audio tags | Synchronize embedded audio with video |

**Implementation notes:**
- Full video playback requires codec support (possibly via WebAssembly FFmpeg)
- Consider linking to external video players as interim solution
- FLV format is well-documented and parseable

---

## Tweening & Animation (Low Priority)

Currently implemented: Motion tweens with linear/custom easing, shape tweens

### Missing Features

| Feature | JPEXS Reference | Description |
|---------|-----------------|-------------|
| **Classic Tween** | XFL `tweenType="motion"` | Legacy motion tween format (pre-CS4) |
| **Motion Path** | `motionTweenOrientToPath` | Orient objects along motion path |
| **Rotation Tweens** | `motionTweenRotate` | CW/CCW rotation with count |
| **Scale Tweens** | `motionTweenScale` | Explicit scale interpolation |
| **Tint Tweens** | Color transform keyframes | Interpolate between tint colors |

**JPEXS easing:**
```java
// Ease value: -100 to 100
// Negative = ease in
// Positive = ease out
// Calculated via Bezier curves
```

---

## Interactive Elements (Low Priority)

Currently implemented: Button symbols show first frame only

### Missing Features

| Feature | Description |
|---------|-------------|
| **Button States** | Up, Over, Down, Hit test frames |
| **Mouse Events** | Click, rollover, rollout detection |
| **Hit Area** | Use hit frame shape for interaction bounds |
| **MovieClip Independence** | Each instance maintains own playhead |
| **Frame Labels** | Named frames for navigation |
| **Scenes** | Multiple scene support |

---

## Path & Edge Parsing (Low Priority)

Currently implemented in `edge-decoder.ts`:
- MoveTo (`!`), LineTo (`|`), QuadraticCurveTo (`[`), ClosePath (`/`)
- Cubic bezier via `(;...);` and `(anchor;...);` formats
- Hex coordinate encoding (`#XX.YY` with two's complement for negatives)
- Style indicators (`S`)
- Auto-close paths when end matches start

### Missing/Incomplete Features

| Feature | JPEXS Reference | Description |
|---------|-----------------|-------------|
| **Mid-Path Style Changes** | `shaperecords/StyleChangeRecord.java` | Style can change mid-edge (fillStyle0/1, lineStyle) without moveTo |
| **Implicit MoveTo After Close** | XFL spec | After `/` (close), next edge should auto-moveTo to continue |
| **Delta Coordinates** | `shaperecords/CurvedEdgeRecord.java` | SWF uses delta coords; XFL uses absolute (verify both work) |
| **EndShapeRecord** | `shaperecords/EndShapeRecord.java` | Explicit shape termination marker |

### Shape Record Types (SWF Internal)

JPEXS handles these record types internally:
```
SHAPERECORD (base)
├── StraightEdgeRecord   → XFL: | x y
├── CurvedEdgeRecord     → XFL: [ cx cy x y
├── StyleChangeRecord    → XFL: ! x y (moveTo) + style changes
└── EndShapeRecord       → (implicit in XFL)
```

**XFL Edge Format Reference:**
```
!x y           MoveTo (absolute, in twips ÷20 for pixels)
|x y           LineTo
[cx cy x y     QuadraticCurveTo (control + end point)
/              ClosePath
Sn             Style change (n = style index)
(;...);        Cubic bezier segment
#XX.YY         Hex coordinate (signed int.fraction)
```

---

## Shape Handling (Low Priority)

Currently implemented: Edge paths, fill styles, stroke styles

### Missing Features

| Feature | JPEXS Reference | Description |
|---------|-----------------|-------------|
| **Shape Fixer** | `xfl/shapefixer/ShapeFixer.java` | Auto-repair broken shapes |
| **Fill Side Correction** | `xfl/shapefixer/SwitchedFillSidesFixer.java` | Fix inverted fill directions |
| **Morph Shape Fixer** | `xfl/shapefixer/MorphShapeFixer.java` | Repair broken morph shapes |
| **Path Area Calculation** | `xfl/shapefixer/PathArea.java` | Calculate signed area for winding determination |
| **Duplicate Edge Removal** | `XFLConverter.java` | Filter redundant stroke-only edges |

---

## 9-Slice Scaling (Low Priority)

| Feature | Description |
|---------|-------------|
| **scale9Grid** | Define non-scaling regions for UI elements |
| **9-slice Rendering** | Preserve corners, stretch edges/center |

---

## Performance Optimizations

| Feature | Description |
|---------|-------------|
| **Symbol Caching** | Pre-render static symbols to off-screen canvas |
| **Web Worker Parsing** | Move FLA parsing to background thread |
| **Dirty Rectangle** | Only redraw changed regions |
| **Level of Detail** | Simplify distant/small elements |

---

## Export Features

| Feature | Description |
|---------|-------------|
| **PNG Sequence** | Export frames as numbered PNGs |
| **GIF Export** | Animated GIF with proper timing |
| **WebM Export** | VP9/AV1 video export |
| **Sprite Sheet** | Atlas generation for game engines |
| **SVG Export** | Vector export of single frames |

---

## References

### JPEXS Source Files

| Component | Path |
|-----------|------|
| XFL Converter | `libsrc/ffdec_lib/src/com/jpexs/decompiler/flash/xfl/XFLConverter.java` |
| Fill Styles | `libsrc/ffdec_lib/src/com/jpexs/decompiler/flash/types/FILLSTYLE.java` |
| Line Styles | `libsrc/ffdec_lib/src/com/jpexs/decompiler/flash/types/LINESTYLE2.java` |
| Gradients | `libsrc/ffdec_lib/src/com/jpexs/decompiler/flash/types/GRADIENT.java` |
| Filters | `libsrc/ffdec_lib/src/com/jpexs/decompiler/flash/types/filters/` |
| Sound Formats | `libsrc/ffdec_lib/src/com/jpexs/decompiler/flash/types/sound/SoundFormat.java` |
| Video | `libsrc/ffdec_lib/src/com/jpexs/decompiler/flash/xfl/MovieBinDataGenerator.java` |
| Easing | `libsrc/ffdec_lib/src/com/jpexs/decompiler/flash/xfl/EasingDetector.java` |
| Image Binary | `libsrc/ffdec_lib/src/com/jpexs/decompiler/flash/xfl/LosslessImageBinDataReader.java` |
| Shape Fixer | `libsrc/ffdec_lib/src/com/jpexs/decompiler/flash/xfl/shapefixer/` |

### SWF Specification

- [SWF File Format Specification](https://www.adobe.com/content/dam/acom/en/devnet/pdf/swf-file-format-spec.pdf) (Adobe)
- [XFL Format Reference](https://help.adobe.com/en_US/flash/cs/extend/WS5b3ccc516d4fbf351e63e3d118a9024f3f-7ff7CS5.html) (Adobe)
