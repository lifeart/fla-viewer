# FLA Viewer - Missing Features & Improvements

Based on analysis of [JPEXS Free Flash Decompiler](https://github.com/jindrapetrik/jpexs-decompiler) source code.

---

## Filters (High Priority) ✅

Currently implemented: `blur`, `glow`, `dropShadow`, `bevel`, `colorMatrix` (AdjustColorFilter), `convolution`, `gradientGlow`, `gradientBevel`

All standard Flash filters are now supported with varying levels of fidelity:
- **BevelFilter**: Uses shadow offset to approximate bevel effect
- **ColorMatrixFilter**: Full 4x5 matrix support via inline SVG filters
- **AdjustColorFilter**: Brightness, contrast, saturation, hue adjustments
- **ConvolutionFilter**: Recognized sharpen/edge-detect kernels, others require pixel manipulation
- **GradientGlowFilter/GradientBevelFilter**: Uses middle gradient color for glow/shadow effect

---

## Gradient Fills (Medium Priority) ✅

Currently implemented: Linear/radial gradients with color stops, spread modes (pad, reflect, repeat), interpolation modes, focal point for radial gradients

### Implementation Details

| Feature | Status | Notes |
|---------|--------|-------|
| **Spread Modes** | ✅ | `pad` (default), `reflect` (simulated via mirrored stops), `repeat` |
| **Interpolation Modes** | ✅ | Parsed but Canvas uses native RGB interpolation |
| **Focal Point** | ✅ | Full support via Canvas `createRadialGradient(fx, fy, 0, cx, cy, r)` |

**Notes:**
- Canvas doesn't natively support spread modes; `reflect` is approximated by compressing and mirroring color stops
- Linear RGB interpolation is parsed but Canvas uses standard RGB blending

---

## Bitmap Fills (Medium Priority) ✅

Currently implemented: Repeating bitmap pattern with matrix transform, clipped bitmap, non-smoothed (pixel-perfect) modes

### Implementation Details

| Feature | Status | Notes |
|---------|--------|-------|
| **Repeating Bitmap** | ✅ | Default mode using `createPattern(image, 'repeat')` |
| **Clipped Bitmap** | ✅ | Uses `createPattern(image, 'no-repeat')` |
| **Non-Smoothed Repeating** | ✅ | Sets `imageSmoothingEnabled = false` |
| **Non-Smoothed Clipped** | ✅ | Combines clipped + non-smoothed |
| **ClippedBitmapFill element** | ✅ | Alternative XFL format supported |

---

## Stroke Styles (Medium Priority) ✅

Currently implemented: Solid strokes with weight, all cap styles (round, none/butt, square), all joint styles (miter, round, bevel), miter limit, scale mode, pixel hinting

### Implementation Details

| Feature | Status | Notes |
|---------|--------|-------|
| **All Cap Styles** | ✅ | `round`, `none` (mapped to `butt`), `square` |
| **All Joint Styles** | ✅ | `miter`, `round`, `bevel` |
| **Miter Limit** | ✅ | Parsed and applied via `ctx.miterLimit` |
| **Scale Modes** | ✅ | Parsed (`normal`, `horizontal`, `vertical`, `none`) |
| **Pixel Hinting** | ✅ | Parsed (rendering hint stored) |
| **Gradient/Bitmap Strokes** | ❌ | Not implemented - requires `hasFillFlag` support |

**Note:** Scale mode and pixel hinting are parsed but rendering implementation is basic. Full scale mode support would require tracking transform and adjusting stroke width dynamically.

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
| **Color Transform Tweening** | Motion tween with color | Interpolate colorTransform values between keyframes |

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
| **Frame Labels** | Named frames for navigation (`DOMFrame.labelType`, `DOMFrame.name`) |
| **Scenes** | Multiple scene support (`DOMDocument.scenes`) |
| **Frame Scripts** | ActionScript on frames (informational display only) |

### keyMode Values (Reference)

Frame keyMode indicates the type of keyframe:
```
9728  = Normal keyframe
17922 = Keyframe with motion tween
22017 = Keyframe with shape tween
8195  = Blank keyframe
```

**Note:** These values are parsed but not used functionally - the `tweenType` attribute determines actual behavior.

---

## Symbol Instance Features (Low Priority)

Currently implemented: Matrix, transformationPoint, loop mode, firstFrame, filters, colorTransform, blendMode

### Missing Features

| Feature | XFL Reference | Description |
|---------|---------------|-------------|
| **3D Transform** | `centerPoint3DX/Y/Z`, `rotationX/Y/Z` | 3D rotation and perspective |
| **Cache as Bitmap** | `cacheAsBitmap` | Render symbol to bitmap for performance |
| **Visible** | `isVisible` | Instance visibility flag |
| **Silent Sound Sync** | `silent` | Mute sound during playback |
| **Accessibility** | `accName`, `description` | Accessibility properties |
| **Tracking as Menu** | `trackAsMenu` | Button menu tracking mode |
| **Last Frame** | `lastFrame` | End frame for graphic symbols |

**Implementation notes:**
- 3D transforms require matrix3d decomposition or CSS 3D transforms
- `cacheAsBitmap` is handled as a performance hint, not strictly required

---

## Text Features (Low Priority)

Currently implemented: Characters, alignment, size, lineHeight, face, fillColor, bold, italic, letterSpacing

### Missing Features

| Feature | XFL Reference | Description |
|---------|---------------|-------------|
| **Underline** | `DOMTextAttrs.underline` | Underline text decoration |
| **URL/Hyperlinks** | `DOMTextAttrs.url` | Clickable links in text |
| **Auto Kerning** | `DOMTextAttrs.autoKern` | Automatic character spacing adjustment |
| **Indent** | `DOMTextAttrs.indent` | First-line paragraph indent |
| **Left Margin** | `DOMTextAttrs.leftMargin` | Text left margin in twips |
| **Right Margin** | `DOMTextAttrs.rightMargin` | Text right margin in twips |
| **Target** | `DOMTextAttrs.target` | Link target frame (for URLs) |
| **Character Position** | `DOMTextAttrs.characterPosition` | Subscript/superscript positioning |
| **Rotation** | `DOMTextAttrs.rotation` | Text rotation per character |

**Implementation notes:**
- Underline can be rendered with `ctx.strokeStyle` and a line below text baseline
- URLs require click detection and event handling
- Margins affect text wrapping boundaries
- Character position (subscript/superscript) requires vertical offset adjustments

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

## Layer Features (Low Priority)

Currently implemented: normal, guide, folder, camera, mask, masked layers with visibility, outline, transparency

### Missing Features

| Feature | XFL Reference | Description |
|---------|---------------|-------------|
| **Layer Height** | `DOMLayer.heightMode`, `DOMLayer.height` | Custom layer height in timeline |
| **Layer Color (Outline)** | `DOMLayer.outlineColor` | Custom outline color for editor |
| **Auto-Named Layers** | `DOMLayer.autoNamed` | System-generated layer names |
| **Current Frame** | `DOMLayer.current` | Current editing frame marker |
| **Animation Type** | `DOMLayer.animationType` | IK/armature animation mode |

**Note:** Most layer features are editor-only and don't affect playback rendering.

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
