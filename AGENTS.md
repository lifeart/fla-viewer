# FLA Viewer - Agent Documentation

## FLA/XFL Format Specification

FLA files (Adobe Animate/Flash Professional) are ZIP archives containing XML files in the XFL (XML-based FLA) format.

### Archive Structure

```
.fla (ZIP archive)
├── DOMDocument.xml          # Main document definition
├── PublishSettings.xml      # Export/publish configuration
├── MobileSettings.xml       # Mobile platform settings
├── META-INF/
│   └── metadata.xml         # XMP metadata (creation date, tools, etc.)
├── LIBRARY/                  # Symbol definitions
│   ├── Symbol1.xml
│   ├── Symbol2.xml
│   └── ...
└── bin/
    └── SymDepend.cache      # Symbol dependency cache
```

### DOMDocument.xml Structure

```xml
<DOMDocument xmlns="http://ns.adobe.com/xfl/2008/"
    width="1920"
    height="1080"
    frameRate="25"
    backgroundColor="#BEEEFD"
    currentTimeline="1">

    <folders>...</folders>           <!-- Library folders -->
    <media>...</media>               <!-- External media (video, audio) -->
    <symbols>                        <!-- Symbol library references -->
        <Include href="Symbol.xml" itemID="xxx" lastModified="timestamp"/>
    </symbols>
    <timelines>                      <!-- Main stage timeline -->
        <DOMTimeline name="Scene 1">
            <layers>...</layers>
        </DOMTimeline>
    </timelines>
</DOMDocument>
```

### Layer Structure

```xml
<DOMLayer name="LayerName"
    color="#FF4F4F"           <!-- Layer color in timeline UI -->
    visible="true"            <!-- Layer visibility -->
    locked="false"            <!-- Layer lock state -->
    layerType="normal"        <!-- normal | guide | folder | mask | masked -->
    parentLayerIndex="2">     <!-- Parent folder index (if in folder) -->

    <frames>
        <DOMFrame index="0" duration="10" keyMode="9728">
            <elements>...</elements>
        </DOMFrame>
    </frames>
</DOMLayer>
```

### Frame Types

#### Static Frame
```xml
<DOMFrame index="0" duration="5" keyMode="9728">
    <elements>
        <DOMSymbolInstance libraryItemName="Symbol" symbolType="graphic">
            <matrix><Matrix tx="100" ty="200"/></matrix>
        </DOMSymbolInstance>
    </elements>
</DOMFrame>
```

#### Motion Tween Frame
```xml
<DOMFrame index="0" duration="10"
    tweenType="motion"
    keyMode="22017"
    acceleration="-50">        <!-- -100 to 100: negative=ease-in, positive=ease-out -->

    <tweens>
        <Ease target="all" intensity="-50"/>
        <!-- OR custom bezier easing -->
        <CustomEase target="all">
            <Point x="0" y="0"/>
            <Point x="0.333" y="0.396"/>
            <Point x="0.667" y="0.729"/>
            <Point x="1" y="1"/>
        </CustomEase>
    </tweens>
    <elements>...</elements>
</DOMFrame>
```

### Matrix Transform

2D affine transformation matrix: `[a c tx; b d ty; 0 0 1]`

```xml
<Matrix
    a="1.0"    <!-- scale X (default: 1) -->
    b="0.0"    <!-- skew Y (default: 0) -->
    c="0.0"    <!-- skew X (default: 0) -->
    d="1.0"    <!-- scale Y (default: 1) -->
    tx="100"   <!-- translate X (default: 0) -->
    ty="200"   <!-- translate Y (default: 0) -->
/>
```

### Symbol Instance

```xml
<DOMSymbolInstance
    libraryItemName="SymbolName"
    symbolType="graphic"           <!-- graphic | movieclip | button -->
    loop="loop"                    <!-- loop | play once | single frame -->
    firstFrame="0"                 <!-- Starting frame for nested timeline -->
    centerPoint3DX="100"           <!-- 3D center point for transforms -->
    centerPoint3DY="200">

    <matrix><Matrix .../></matrix>
    <transformationPoint><Point x="0" y="0"/></transformationPoint>
    <color>                        <!-- Optional color transform -->
        <Color alphaMultiplier="0.5"/>
    </color>
</DOMSymbolInstance>
```

### Video Instance

```xml
<DOMVideoItem name="video.flv"
    itemID="xxx"
    sourceExternalFilepath="./video.flv"
    videoDataHRef="M 3 123456.dat"    <!-- Binary video data in bin folder -->
    videoType="h263 media"
    fps="25"
    width="320"
    height="240"
    length="4.08"/>                   <!-- Duration in seconds -->

<DOMVideoInstance
    libraryItemName="video.flv"
    frameRight="6400"                 <!-- Width in twips (÷20 for pixels) -->
    frameBottom="4800">               <!-- Height in twips (÷20 for pixels) -->
    <matrix><Matrix .../></matrix>
</DOMVideoInstance>
```

### Group Element

Groups contain multiple shapes or symbol instances as members:

```xml
<DOMGroup>
    <members>
        <DOMShape>...</DOMShape>
        <DOMShape>...</DOMShape>
        <DOMSymbolInstance>...</DOMSymbolInstance>
        <DOMGroup>                    <!-- Groups can be nested -->
            <members>...</members>
        </DOMGroup>
    </members>
</DOMGroup>
```

### Shape Definition

```xml
<DOMShape isFloating="true">
    <matrix><Matrix .../></matrix>

    <fills>
        <FillStyle index="1">
            <SolidColor color="#FF6C00" alpha="1"/>
        </FillStyle>
        <FillStyle index="2">
            <LinearGradient>
                <matrix><Matrix .../></matrix>
                <GradientEntry color="#FF0000" ratio="0"/>
                <GradientEntry color="#0000FF" ratio="1"/>
            </LinearGradient>
        </FillStyle>
    </fills>

    <strokes>
        <StrokeStyle index="1">
            <SolidStroke weight="2" caps="round" joints="round">
                <fill><SolidColor color="#000000"/></fill>
            </SolidStroke>
        </StrokeStyle>
    </strokes>

    <edges>
        <Edge fillStyle0="1" fillStyle1="2" strokeStyle="1"
              edges="!0 0|100 0[150 50 200 100!200 100"/>
    </edges>
</DOMShape>
```

### Edge Path Encoding

The `edges` attribute uses a specialized encoding:

| Command | Syntax | Description |
|---------|--------|-------------|
| `!` | `!x y` | MoveTo (start new subpath) |
| `\|` | `\|x y` | LineTo |
| `[` | `[cx cy x y` | QuadraticCurveTo (control point + end point) |
| `/` | `/` | ClosePath |
| `S` | `Sn` | Style change indicator (followed by style index) |

#### Coordinate Encoding

Coordinates can be:
- **Decimal**: `100.5`, `-200.25`
- **Hex-encoded**: `#XX.YY` where XX is hex integer, YY is hex fraction
  - Example: `#D0.3A` = 208 + (58/256) = 208.2265625
  - Signed values use two's complement for values > 0x7FFF

#### Example Edge String
```
!-226.5 229.5[-257.90625 #D0.3A -285 176!-285 176[-335 117 -341 40
```
Decodes to:
1. MoveTo(-226.5, 229.5)
2. QuadraticCurveTo(control: -257.90625, 208.23, end: -285, 176)
3. MoveTo(-285, 176)
4. QuadraticCurveTo(control: -335, 117, end: -341, 40)

### Fill Styles in Edges

- `fillStyle0`: Fill on the LEFT side of the edge direction
- `fillStyle1`: Fill on the RIGHT side of the edge direction
- Used for complex shapes with holes (winding rule)

---

## Remaining TODOs

### High Priority

- [ ] **Shape Tweening**: Implement shape morphing between keyframes
  - Parse `tweenType="shape"` frames
  - Interpolate edge paths between shapes
  - Handle fill color transitions

- [ ] **Stroke Rendering**: Add stroke/outline support
  - Parse `<strokes>` and `<StrokeStyle>` elements
  - Implement line caps and joins (round, square, bevel, miter)
  - Variable stroke width support

- [ ] **Gradient Fills**: Proper gradient rendering
  - Linear gradients with matrix transform
  - Radial gradients with focal point
  - Spread modes (pad, reflect, repeat)

- [ ] **Bitmap Fills**: Support bitmap/image fills
  - Parse bitmap references from media
  - Apply bitmap as fill pattern with transform

### Medium Priority

- [ ] **Mask Layers**: Implement layer masking
  - Parse `layerType="mask"` and `layerType="masked"`
  - Apply clipping paths from mask layer shapes
  - Support animated masks

- [ ] **Color Transforms**: Symbol instance color effects
  - Alpha multiplier/offset
  - RGB multipliers/offsets
  - Tint and brightness

- [ ] **Blend Modes**: Layer and symbol blend modes
  - Normal, multiply, screen, overlay, etc.
  - Parse `blendMode` attribute

- [ ] **Filters**: Drop shadow, blur, glow effects
  - Parse `<filters>` element
  - Implement using Canvas filters or manual rendering

- [ ] **9-Slice Scaling**: Support for scalable symbols
  - Parse scale9Grid attribute
  - Implement 9-slice rendering

### Lower Priority

- [ ] **Text Fields**: Static and dynamic text
  - Parse `<DOMStaticText>` and `<DOMDynamicText>`
  - Font rendering with proper styling
  - Text transforms and effects

- [ ] **Buttons**: Interactive button symbols
  - Up, Over, Down, Hit states
  - Mouse event handling

- [ ] **MovieClip Playback**: Independent nested timelines
  - Each MovieClip instance has its own playhead
  - Support `play()`, `stop()`, `gotoAndPlay()`

- [ ] **ActionScript Labels**: Frame labels and scenes
  - Parse frame labels for navigation
  - Scene support

- [ ] **Sound**: Audio playback
  - Parse audio references from media
  - Sync sound to timeline (event, stream, start, stop)

- [x] **Video**: Embedded video support (placeholder rendering)
  - Parse `<DOMVideoItem>` and `<DOMVideoInstance>` elements
  - Renders placeholder rectangle with play button icon
  - Full video playback requires FLV/H.263 decoder integration

### Performance & UX

- [ ] **Web Worker Parsing**: Move FLA parsing to web worker
  - Prevent UI blocking on large files
  - Progress reporting during load

- [ ] **Symbol Caching**: Pre-render static symbols to off-screen canvas
  - Cache symbols that don't animate
  - Invalidate cache on color transform changes

- [ ] **Layer Visibility Toggle**: UI to show/hide layers
  - Layer panel with checkboxes
  - Solo layer mode

- [ ] **Zoom & Pan**: Canvas navigation
  - Mouse wheel zoom
  - Drag to pan
  - Fit to window button

- [ ] **Export**: Export rendered frames
  - Export current frame as PNG
  - Export animation as GIF/WebM
  - Export sprite sheet

- [ ] **Timeline UI**: Visual timeline editor
  - Layer thumbnails
  - Keyframe markers
  - Onion skinning

### Code Quality

- [ ] **Error Handling**: Graceful degradation for unsupported features
  - Log warnings for unimplemented elements
  - Fallback rendering for complex features

- [ ] **Unit Tests**: Test coverage for parser and renderer
  - Edge decoder tests with known values
  - Matrix transform tests
  - Tween interpolation tests

- [ ] **Documentation**: API documentation
  - JSDoc comments for public methods
  - Usage examples
  - Browser compatibility notes

---

## File References

| File | Purpose |
|------|---------|
| `src/types.ts` | TypeScript interfaces for FLA data structures |
| `src/fla-parser.ts` | ZIP extraction and XML parsing |
| `src/edge-decoder.ts` | XFL edge path format decoder |
| `src/renderer.ts` | Canvas 2D rendering engine |
| `src/player.ts` | Timeline playback controller |
| `src/main.ts` | Application entry point and UI |

## External Resources

- [XFL Format Reference (Adobe)](https://help.adobe.com/en_US/flash/cs/extend/WS5b3ccc516d4fbf351e63e3d118a9024f3f-7ff7CS5.html)
- [SWF File Format Specification](https://www.adobe.com/content/dam/acom/en/devnet/pdf/swf-file-format-spec.pdf)
- [Canvas 2D API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D)
