# Toon Boom Harmony Rendering Internals

Reverse-engineered from Harmony 24 Premium (build 23443) binary analysis.

## Fill System — NO Fill Rules

Harmony does **NOT** use evenodd or nonzero winding rules. Instead it uses a **topological contour-based** fill system:

- `GR_Contour` = a closed fill region
- Contours have parent-child relationships (`TopologicalComparison`, `FindContainingContourForOutline`)
- Each contour IS a fill zone with its own color (`SetContourColor`)
- Fill boundaries are defined by the contour structure, not by winding rules on overlapping paths

**Implication**: Our `evenodd` fill approach is an approximation. The TVG format encodes what is filled and what is not — each fill component defines a contour.

## Pencil Stroke Rendering — Filled Outlines

Pencil lines are rendered as **filled variable-width outline polygons**:

1. `GR_VectorStroke` = centerline bezier + `GR_ThicknessPath`
2. `GR_ThicknessPath` = per-point thickness with `ThicknessKey` (t, left, right)
3. `GR_ThicknessDiscretizer` discretizes into points
4. `GR_ThicknessOutline` generates the outline polygon:
   - `getOutline()` — full outline (both sides)
   - `addCenterlinePoint()` → `GR_TriangleStrip`
   - `getTipOutline(Direction)` — end caps
   - `computeIntermediatePoint()` — joints
   - `maxBeveledJoinRatio` for beveled joins
5. `GR_VectorBrushRenderer::drawPencilStroke()` renders result

**Pencil textures**: `SR_PencilAlphaTextureShader`, `SR_PencilOpacityShader`

## Contour Fill Rendering — Triangulation

Three methods:
1. **Delaunay triangulation** (`GR_Delaunay::compute`) — primary method
2. **Fast triangle** — simplified alternative
3. **SR_Polygon** — scanline fill for software renderer

## Antialiasing

**Software renderer (thumbnails/export):**
- Coverage-based scanline sampling via `SR_SamplingFiltered`
- 4 quality levels: low, medium-low, medium, high
- `exponent` parameter (0-3) controls AA filter curve
- `SR_SamplingMask` per-scanline for sub-pixel coverage
- Methods: `fillInteriorPixels`, `applyTransparency`

**OpenGL renderer (viewport):**
- **SMAA** (Subpixel Morphological AA) at `SMAA_PRESET_ULTRA`
- Hardware MSAA fallback via `MultiSampleRenderbuffer`

## Compositing

Operations (`BM_ComposeOperationGeneric`):
- `SrcOverDstWithAlphaBlendingPremultiplied` — primary compositing
- `SrcAlphaInverseNonPremultiplied` — inverse alpha (CUTTER matte)

Blend modes: Normal, Multiply, Screen, Overlay, Darken, Lighten, Hardlight, Softlight, Difference, Exclusion, Subtract, Invert

**CUTTER confirmed**: `matte_mode == 1` = multiply by `(1 - matte alpha)` = inverse matte

## Coordinate System

- 12-field grid = 2500×1875 units
- Horizontal field = 208.333 units
- Vertical field = 156.25 units
- 4:3 aspect ratio

## Pencil Texture Shader Modes
```
mode 0: solid color (no texture)
mode 1: radial texture (length-based UV)
mode 2: mirrored texture
mode 3: normal texture
mode > 3: flip Y
mode >= 8: enable alpha texture
Output: premultiplied alpha (rgb *= a)
```

## Architecture

- **libToonBoomGraphicCore** — core rendering (contours, strokes, fills, triangulation)
- **libToonBoomSceneCore** — scene graph, compositing modules
- **libToonBoomGraphito** — OpenGL/Vulkan rendering, SMAA
- TBB (Threading Building Blocks) for parallel tiled compositing

---

## Detailed Protocol Data

*Extracted 2026-03-20 from Harmony 24 Premium build 23443 binaries.*

### 1. TVG File Format (GIO_TvgStreamer)

**I/O Pipeline:**
- `GIO_TvgStreamer` — main TVG read/write class
  - `loadFromFile()` / `storeToFile()` — file I/O
  - `loadFromStream()` / `storeToStream()` — stream I/O via `DB_MemFile`
  - `loadTaggedFormat()` / `storeTaggedFormat()` — tagged binary format via `DB_PersistentStore`
  - `isNewFormat()` — detects old vs new TVG format
  - `convertToNewFormat()` — upgrades old TVG files
  - `setOverrideStorageFormat()` / `setOverrideStorageVersion()` — force specific format version
  - `getFileFormat()` — detect format type
  - `getServerIdentity()` — extract server identity from TVG
  - `setCertificate()` — set DRM certificate
- `GIO_TvgoDatabase` — SQLite-based TVG object database (`.tvgo` format)
  - `createTables()`, `add()`, `read()`, `update()`, `clear()`

**Known chunk tag:** `21BM_UncompressedBitmap` (bitmap data identifier)

**Tvg2xml XML output structure** (from Tvg2xml binary strings):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<TVG version="%1">
  <Art name="%1">
    <Layer>
      <Shape>
        <Strokes>
          <StrokeLineStyle>
          </StrokeLineStyle>
        </Strokes>
        <ColorMap>
        </ColorMap>
      </Shape>
      <ThicknessPath>
        <Thickness>
        </Thickness>
      </ThicknessPath>
    </Layer>
  </Art>
</TVG>
```

**Tvg2xml command-line options:**
- `-discretize [scale]` — discretize bezier paths (scale 0.025-4, default 0.1; higher = more resolution)
- `-flatten` — flatten all layers of each art to 1 layer
- `-no_bitmap_data` — skip bitmap data for smaller XML
- `-version` — print version

**Tvg2xml XML attributes/elements:**
- `<pointQuantum> 1.0/%1.0 </pointQuantum>` — point coordinate quantization factor
- `closed %1` — contour closed flag
- `color` — color element
- `colorID 0x%1` — hex color ID reference
- `strokeID %1` — stroke identifier
- `thickness %1` — thickness value
- `thicknessPathID %1` — shared thickness path ID
- `thicknessPathRange [ %1 %2 ]` — thickness path parameter range
- `from tip [ ` / `to tip [ ` — start/end tip definitions
- `fromTipTangent [ %1 %2 ]` / `toTipTangent [ %1 %2 ]` — tip tangent vectors
- `join %1` — join type
- `no_stroke_texture` — flag for strokes without texture

### 2. Drawing Object Hierarchy

**Top-level:** `GR_CompositeVectorDrawingObj`
- Contains 4 art layers:
  - `GetUnderlayArt()` — underlay art (bottom)
  - `GetColorArt()` — color art (fill regions)
  - `GetLineArt()` — line art (strokes/outlines)
  - `GetOverlayArt()` — overlay art (top)
- Art selection: `GR_ArtSelector` with `underlayArtEnabled()`, `colorArtEnabled()`, `lineArtEnabled()`, `overlayArtEnabled()`
- Rendering order: underlay -> color -> line -> overlay

**Per-art:** `GR_VectorDrawingObj`
- Load pipeline: `Load()` -> `LoadVectorAndTextLayers()` -> `LoadVectorAndTextGraph()` -> `LoadSharedBezierPath()` -> `LoadPalette()` -> `LoadBitmapLayers()` -> `LoadBitmapGraph()` -> `AfterLoadConsistencyCheck()`
- `LoadNodePosition()` / `StoreNodePosition()` — z-ordering of nodes
- `LoadSharedBezierPath()` — shared bezier path deduplication (strokes can reference same bezier data)
- `RenderDrawing()` — renders via `GR_LayerSoftRenderer`
- `GetWorldBBox()` / `GetVisibleWorldBBox()` — bounding box with ThicknessRenderParameters

### 3. Layer System

**`GR_Layer`:**
- `LayerType` enum — determines layer behavior
- Layers are organized in a tree via `GR_LayerNode` (doubly-linked: `GetNextLayerNode()`, `GetPreviousLayerNode()`)
- `GR_DrawingAccess::CreateLayerAbove()` / `CreateLayerUnder()` — layer ordering
- `SetLayerType()` — change layer type
- Each layer contains ordered list of `GR_VectorStroke` objects

**Layer types (from `GR_DrawingToolbox`):**
- Vector layers (standard stroke/fill layers)
- Bitmap layers (`GR_BitmapLayer`)
- Text layers (`GR_TextLayer`)

### 4. Stroke Architecture

**`GR_VectorStroke`** — the fundamental drawing element:
- `setBezierPath(GR_BezierPath2d)` — centerline geometry
- `setThicknessBinder(GR_ThicknessBinder)` — variable width profile (inline)
- `setSharedThicknessPath(GR_ThicknessPath)` — shared thickness (deduplicated)
- `setSharedOpacityPath(GR_FunctionPath)` — per-point opacity
- `setTipType(Direction, Tip)` — start/end tip shape
- `setTipTangent(Side, Direction, double)` — tip tangent control
- `ComputeTangents()` — auto-compute tangent vectors
- `GetBezierPath()` — retrieve the centerline
- `tipType(Direction)` / `tipTangent(Side, Direction)` — query tip
- `Load(DB_PersistentStore, GR_Layer*)` — deserialize from binary

**`GR_StrokeData`** — lightweight stroke data (no layer association):
- Constructed from `GR_BezierPath2d`
- `CreateThicknessBinder()` / `CreateThicknessBinder(double)` — create binder with optional default thickness
- `CopyThicknessBinder(const GR_ThicknessBinder*)` — copy from existing
- `Flip()` — reverse direction
- `Load(DB_PersistentStore, bool)` — deserialize

**Stroke sides:** `GR_DrawingAccess::StrokeSide` enum (inside/outside)
- `SetColor(VectorStroke, Color, StrokeSide)` — set inside or outside color
- `SetInsideColor()` / `SetOutsideColor()` — on `GR_StrokeAccess`
- `SetInsideContour()` — contour that stroke borders on inside

### 5. GR_LineStyle — Stroke Appearance

**Construction:** `GR_LineStyle(LineType, CM_ColorId_t, float thickness)`

**Properties:**
- `SetLineType(LineType)` — line rendering type
- `SetColorID(CM_ColorId_t)` — palette color reference
- `SetThickness(float)` — base stroke width
- `GetColorID()` / `GetThickness()` — query

**Texture system:**
- `addTextureInfo()` — enable texture on stroke
- `hasTextureInfo()` / `isTextured()` — check texture state
- `setTextureScaling(Vector2d)` — texture UV scaling
- `setTextureOffset(Vector2d)` — texture UV offset
- `setTextureTiling(bool)` — enable tiling
- `setWrapTextureAtTips(bool)` — wrap texture at stroke ends
- `transformTexture(Vector2d, Vector2d)` — transform texture coords

**Opacity texture (separate from main texture):**
- `setOpacityColorId(CM_ColorId_t)` — opacity map color
- `setOpacityTextureScaling(Vector2d)` — opacity UV scaling
- `setOpacityTextureOffset(Vector2d)` — opacity UV offset
- `setOpacityTiling(bool)` — opacity texture tiling
- `transformOpacityTexture(Vector2d, Vector2d)` — transform opacity coords

**Serialization:** `operator<<` / `operator>>` with `DB_PersistentStore`

### 6. Thickness System (Variable Width Strokes)

**`GR_ThicknessPath`** — defines variable width along a stroke:

**Inner structs:**
- `Thickness(double)` — a thickness value
  - `Thickness(double, ThicknessControl, ThicknessControl)` — with left/right bezier controls
  - `setThickness(double)`
- `ThicknessControl(double localT, double thickness)` — bezier control for smooth thickness interpolation
  - `setLocalT(double)` / `setThickness(double)`
- `ThicknessKey(double t, double thickness)` — keyframe at parameter t
  - `ThicknessKey(double t, Thickness left, Thickness right)` — with left/right thickness
  - `setThicknessT(double)`

**Key operations:**
- `insertThicknessKey(ThicknessKey)` / `insertThicknessKey(double t)` — add key at parameter
- `eraseThicknessKey(int)` / `eraseThicknessKeys(set<int>)` — remove keys
- `setThicknessT(int index, double)` — set key parameter
- `setThicknessPoint(int, Side, Point2d)` — set thickness control point
- `setControlPoint(int, Side, Direction, Point2d)` — set bezier control point
- `setControlThicknessT(int, Side, Direction, double)` — set control point parameter
- `evaluate(Side, double t)` — evaluate thickness at parameter t

**Tip system:**
- `setTipType(Direction, Tip)` — set tip shape (Direction = From/To)
- `setTipType(Direction, Tip, double)` — with size parameter
- `setBezierTip(Direction, GR_Bezier2d)` — custom bezier tip shape
- `getBezierTip(Direction)` / `computeBezierTip(Direction, Tip, double)`
- `setBezier(Side, int, GR_Bezier2d)` — set thickness bezier per segment
- `setBezierControls(Side, int, GR_Bezier2d)` — set control beziers
- `getBezierPath(Side)` — get full thickness profile as bezier path

**Operations:** `reverse()`, `mirror()`, `interpolate()`, `merge()`, `mergeAppend()`, `remapAppend()`, `removeNanOrInfinity()`
**Serialization:** `Load(DB_PersistentStore)`, `operator<<` / `operator>>`

**`GR_ThicknessEnum`** nested enums:
- `Side` — Left / Right sides of stroke
- `Direction` — From (start) / To (end) of stroke
- `Tip` — Tip shape type

**Tip types (from strings):**
- `FLAT_TIP` — flat/square end
- `ROUND_TIP` — rounded end cap
- `BEVEL_TIP` — beveled/angled end cap
- Custom bezier tips via `setBezierTip()`

**`GR_ThicknessBinder`** — binds thickness path to a bezier path:
- Contains `Parameters` sub-struct:
  - `setThicknessT(double)` — uniform thickness
  - `setTipTangent(Side, double)` — tip tangent values
  - `flipTangents()` — reverse tangent directions
  - `load(DB_PersistentStore)` — deserialize
- `setThicknessPath(GR_ThicknessPath)` / `setSharedThicknessPath(GR_ThicknessPath)` — bind thickness
- `setOpacityPath(GR_FunctionPath)` / `setSharedOpacityPath(GR_FunctionPath)` — per-point opacity
- `setFunctionPath(uint, GR_FunctionPath)` / `setSharedFunctionPath(uint, GR_FunctionPath)` — arbitrary function paths
- `setTipDistance(Side, Direction, double)` — tip inset distance
- `transformedTipDistance(Side, Direction, ThicknessRenderParameters)` — tip distance with render transform
- `copyTipTangents()` — copy tangent data from another binder
- `reverse()` / `reverseParameters()` / `flipTangents()` — direction operations
- `truncate(double, double)` — partial range
- `appendFrom()` / `appendTo()` — concatenation
- `interpolate(double, ThicknessBinder, ThicknessBinder)` — blend between two binders
- `shareThicknessPathAndFunctionPaths()` — deduplicate shared data
- `load(DB_PersistentStore)` — deserialize

**`GR_ThicknessMapping`** — maps multiple bezier segments to thickness:
- `append(GR_BezierPath2d, GR_ThicknessBinder*)` — add segment mapping
- Used by `GR_ShaderFactory::createPolylineSRShader()`

### 7. Thickness Outline Generation

**`GR_ThicknessOutline`** — generates renderable outline from thickness data:
- Construction: `GR_ThicknessOutline(double scale)` or with initial bezier+binder
- `append(GR_BezierPath2d, GR_ThicknessBinder*)` — add stroke segments
- `setDiscretizationScale(double)` — resolution control
- `setThicknessRenderParameters(GR_ThicknessRenderParameters)` — render settings
- `setWrapTextureAtTips(bool)` — texture wrapping at tips

**Output methods:**
- `getOutline(vector<Point2d>)` — full outline polygon (both sides combined)
- `getOutline(vector<Point2d>, Side, double start, double end)` — one side of outline
- `getOutline(vector<GR_ParametricPoint>, ..., int)` — parametric output
- `getTipOutline(vector<Point2d>, Direction)` — tip cap shape
- `getTriangleStrip(int, int, GR_TriangleStrip)` — triangle strip output
- `getTriangleStrip(int, int, GR_TexturedTriangleStrip)` — textured strip
- `unitTexture()` — compute texture coordinates
- `maxBeveledJoinRatio()` — maximum bevel ratio for joins

**Internal point generation:**
- `addOutlinePoint(Polyline2d, Side, ThicknessDiscretizer::Point, Vector2d)` — add point to outline
- `addOutlinePoint(TexturedPolyline2d, ...)` — with texture coordinates
- `addCenterlinePoint(Polyline2d, ...)` — centerline for triangle strips
- `addCenterlinePoint(TriangleStrip, ...)` — direct triangle strip output
- `addIntermediatePoint(...)` — joint/intermediate points
- `computeIntermediatePoint(Side, Node, Point, Vector2d)` — compute joint position

**`GR_ThicknessDiscretizer`** — discretizes bezier+thickness into points:
- `append(GR_BezierPath2d, GR_ThicknessBinder*)` — add segments
- `setDiscretizationScale(double)` — resolution
- `setThicknessRenderParameters(GR_ThicknessRenderParameters)` — settings
- Inner types: `Point`, `Node`

**`GR_ThicknessRenderParameters`:**
- Constructor: `(bool, bool, double, double, double, double)` — 2 bools + 4 doubles
- Used by `GR_VectorDrawingObj::GetWorldBBox()`, `GetVisibleWorldBBox()`
- Used by `GR_ThicknessBinder::transformedTipDistance()`

### 8. Join and Cap Types

**Join types (from strings):**
- `ROUND_JOIN` — rounded join
- `MITER_JOIN` — sharp mitered join
- `BEVEL_JOIN` — beveled/flat join

**Tip/Cap types (from strings):**
- `FLAT_TIP` — flat/butt cap
- `ROUND_TIP` — rounded cap
- `BEVEL_TIP` — beveled cap

Note: Harmony uses "Tip" terminology instead of "Cap" for stroke endpoints.

### 9. Bezier Path System

**`GR_Bezier2d`** — single 2D bezier curve segment:
- `Truncate(double start, double end)` / `TruncateFrom(double)` / `TruncateTo(double)`
- `Round(double)` — round to grid
- `Straighten()` — convert to straight line
- `Reverse()` — reverse direction
- `IncrementDegree(uint)` / `DecrementDegree(int)` — degree elevation/reduction
- `GetMinIntersection()` / `GetMaxIntersection()` — find intersections
- `GetMinGap()` / `GetMaxGap()` — find closest approach
- `IntersectionInfo` — intersection result struct

**`GR_BezierPath2d`** — composite bezier path (multiple segments):
- `Append(Bezier2d)` / `Append(BezierPath2d)` / `Append(Point2d)` / `Append(Segment2d)` — extend path
- `AppendFront()` / `AppendReverse()` / `AppendFrontReverse()` — prepend/reverse append
- `AppendFrom(path, index)` / `AppendTo(path, index)` — partial copy
- `ClosePath()` — close the path
- `IsClosed()` — check closure
- `Reverse()` — reverse direction
- `Erase(uint start, uint count)` — remove segments
- `Clear()` — remove all
- `Straighten()` — straighten all segments
- `RemoveClosedLoop()` — remove self-intersecting loops
- `insertPoint(double t)` / `insertPointAndRound(double t)` — subdivision
- `insertPoints(vector<double>)` — multiple subdivisions
- `ShiftPoints(uint, int)` / `ShiftIndices(uint, int)` — reindex
- `RecomputeIndices()` — recalculate parameter indices
- `GetClosestPoint(Point2d)` — nearest point on path
- `GetBezierIndex(double t)` — segment index for parameter
- `GetBezierParameter(double t)` — local parameter within segment
- `GetSubPolygonLength(uint)` — sub-path length
- `TruncateAndRound(double, double)` — truncate with rounding
- `OptimizeMemory()` — compact storage
- `trimNumPointsToSize(int)` — limit point count
- Serialization: `operator<<` / `operator>>` with `DB_PersistentStore`

**`GR_BezierPath2dFitter`:**
- `FitClosed(BezierPath2d src, BezierPath2d& dst)` — fit closed path

**`GR_FunctionPath`** — 1D function along path (used for opacity, etc.):
- `insertPoint(double)` — add control point
- `setBezierPath(GR_BezierPath2d)` — set from bezier
- `reverse()` / `truncate(double, double)` / `merge()` / `mergeAppend()` / `remapAppend()`
- `resetCache()` — invalidate cached values
- `removeNanOrInfinity()` — clean invalid data
- Serialization: `Load(DB_PersistentStore)`, `operator<<` / `operator>>`

### 10. Color System

**`GR_Color`** — runtime color reference:
- `CreateWith(CM_ColorId_t)` — create from palette color ID
- `CreateWith(CM_ColorId_t, Matrix2x3)` — with texture transform
- `CreateWith(CM_SharedPtr<CM_BaseColorObj>)` — from resolved color object
- `CopyMovedVersion(GR_Color, Matrix2x3)` — copy with texture transform
- `CopyWithTexture(GR_Color, CM_ColorId_t, Matrix2x3)` — copy with different texture
- `CopyWithoutTexture(GR_Color)` — remove texture
- `CopyWithDifferentColorID(GR_Color, CM_ColorId_t)` — recolor
- `GetDefaultMatrix(Box2d, CM_BaseColorObj)` — default texture matrix for bounding box
- `InitDefault()` — initialize default color

**`CM_ColorId_t`** — color identifier (links to palette):
- `CM_ColorId_t::null` — null color ID
- Used everywhere for palette-based color references

**`CM_BaseColorObj`** — base color object in palette:
- `Load(DB_PersistentStore)` — deserialize
- `initColorId()` — initialize ID
- `Rename(UT_String)` — rename color
- `SetSticky(bool)` — mark as non-removable
- `SetRecovered(bool)` — mark as recovered
- `ColorsLookIdentical(SharedPtr, SharedPtr)` — compare colors
- Subtype casting: `CM_CastToColor()` (solid), `CM_CastToTexture()` (texture)

**`CM_Palette`** — color palette:
- `InitializePalette(CM_ColorId_t)` — create with initial color
- `AddColor()` / `InsertColor()` / `RemoveColor()` — manage colors
- `AddDefaultColor()` / `LoadDefaultColor()` / `LoadDefaultPalette()` — defaults
- `SetName()` / `SetDescription()` / `SetType(PaletteType)` — metadata
- `Load()` / `Store()` — persistence
- `LoadColorList()` / `StoreColorList()` — bulk color I/O via `DB_MemFile`
- `StoreTextures()` / `storeTexture()` — texture persistence
- `Merge(CM_Palette)` — merge palettes
- `Copy(SharedPtr<CM_Palette>, bool)` — copy palette
- Color space: `isColorSpaceDirty()` / `setColorSpaceDirty()` / `globalColorSpaceKey()` / `changeGlobalColorSpaceKey()`
- Locking: `SetLockTicket(CM_Lock::Ticket*)`
- Recovery: `SetRecovered(bool)` / `SetIsDeleted(bool)`

**`CM_PaletteList`** — list of palettes:
- `GetPalette(CM_ColorId_t)` — find palette by color ID
- `WhereIsColor(CM_ColorId_t)` — locate color across all palettes
- `RemovePalette(CM_ColorId_t)` — remove palette
- `RecoverPalette()` — color recovery
- `SetCurrentPalette(PaletteType, CM_ColorId_t)` — set active palette

**Color resolution pipeline:**
- `GR_DrawingAccess::ResolveColors(GR_Layer*)` — resolve all colors in layer
- `GR_DrawingAccess::TopologicalResolveColors(GR_Layer*)` — resolve based on topology
- `GR_DrawingAccess::HeuristicResolveColors(GR_Layer*)` — heuristic resolution
- `GR_DrawingAccess::CleanUpColors(GR_Layer*)` — remove unused colors
- `GR_DrawingAccess::CleanUpComponentColors(GR_Contour*)` — clean contour colors

**Color dictionary:** `GR_ColorDict`
- `attachPaletteInfo(GR_PaletteInfo*)` — attach palette info
- `attachPaletteList(CM_SharedPtr<CM_PaletteList>)` — attach palette list
- `setColorTransform(GR_GraphicOpsColorTransform*)` — set color transform

**Color overrides (in libToonBoomSceneCore):**
- `MO_ElementModule::useLineArtColorOverride()` / `getLineArtColorOverride()` / `setLineArtColorOverrideEnabled(bool, uint&)`
- `MO_ElementModule::getMatteColorOverride()` / `setMatteColorOverride(uint&)`
- `AT_DrawingAttr::setUseColorOverride(bool)` / `setLineColorOverride(uint)` / `setMatteColorOverride(uint)`

### 11. Rendering Pipeline

**Layer rendering (`GR_LayerRenderer`):**
- `DrawVector(CGraphicOps, GR_Layer*)` — render vector layer
- `DrawBitmap(CGraphicOps, GR_BitmapLayer*)` — render bitmap layer
- `DrawString(CGraphicOps, GR_TextLayer*)` — render text layer
- `BuildVector()` / `BuildBitmap()` / `BuildString()` — build canvas objects
- `BuildCanvasObj()` — generic canvas object build
- `DrawCanvasObj()` — render canvas object with color ref data
- `UpdateColors()` — update color references
- `CreateColorRefDataForLayer()` / `ReleaseColorRefData()` — color reference lifecycle
- `Discretize()` / `DiscretizeWithScale(GR_Layer*, double)` — discretize for rendering
- `OverrideRender(CA_CelKey)` — override render for specific cel

**Drawing rendering (`GR_DrawingRenderer`):**
- `drawShader(CGraphicOps, GR_VectorDrawingObj*, VS_CanvasObj*)` — shader-based rendering
- `DrawingFunctor` — functor for rendering operations

**Contour rendering (`GR_Renderer`):**
- `drawContour()` — general contour rendering
- `drawContourUsingDelaunay()` — Delaunay triangulation path
- `drawContourUsingFastTriangle()` — fast triangle path
- `drawContourVolume()` — volume rendering
- `contourIsInteresting()` — skip trivial contours
- `feedContourPointsToCollection()` — point extraction
- `getContourRenderingParams()` — get rendering parameters
- `getStrokeRenderingParams()` — get stroke rendering parameters

**Variable stroke rendering:**
- `drawVariableStrokes(CGraphicOps, ThicknessOutline, double, VS_CanvasObjBuilder*, deque<StrokeInfo>, uint, VariableStrokeRenderMode)` — main entry
- `drawVariableStrokesDirect()` — direct rendering path
- `VariableStrokeRenderMode` enum — different rendering modes
- `DiscretizedVectorStrokeInfo` — pre-discretized stroke data
- `drawStroke()` — single stroke rendering
- `discretizeStroke()` / `discretizeBezierPath()` — bezier to polyline

**Renderer utilities (`GR_RendererUtil`):**
- `drawBezierPath(CGraphicOps, BezierPath2d, LineStyle, float)` — draw with line style
- `drawBezierPath(CGraphicOps, BezierPath2d, LineStyle, ThicknessPath, float)` — with variable thickness
- `drawBezierPath(CGraphicOps, BezierPath2d, LineStyle, ThicknessBinder, float)` — with binder
- `drawBezierPath(CGraphicOps, BezierPath2d, LineStyle, VectorBrushImage, float)` — with brush
- `drawBezierPath(CGraphicOps, BezierPath2d, VS_RGBA, ThicknessBinder, float)` — direct color
- `drawVectorStroke(CGraphicOps, GR_VectorStroke*, double, double)` — draw one stroke
- `drawVectorStrokeOutline(CGraphicOps, GR_VectorStroke*, VS_RGBA)` — stroke outline
- `drawVectorStrokeCenterLine(CGraphicOps, GR_VectorStroke*, VS_RGBA)` — center line debug
- `drawContourOutline()` / `drawSingleContourOutline()` — contour outlines
- `drawShapedStroke()` — shaped brush stroke

**Software renderer (`GR_LayerSoftRenderer`):**
- `DrawVector()` / `DrawBitmap()` / `DrawString()` — software render paths
- `drawPreservedThicknessStrokes(SR_Matrix, CGraphicOps, GR_Layer*, SR_DrawingLayer*, int, double, double)` — thickness-preserved rendering
- `StartNewImage(void*)` / `FinishImage(bool)` — image lifecycle
- `getCanvas()` — get software canvas
- `GR_LayerSoftRendererOptions` — configuration options
  - `eLineTextureMode` — line texture mode enum

**Shader factory (`GR_ShaderFactory`):**
- `createSRShader()` — create software renderer shader
- `createPolylineSRShader()` — create polyline shader with ThicknessBinder+ThicknessMapping

### 12. Contour Details

**`GR_Contour`:**
- Constructor from `GR_StrokeAccess` — built from stroke topology
- `SetContourColor(GR_Color)` / `SetContourAndChildrenColor(GR_Color)` — set fill color
- `TopologicalComparison(const Contour*, const Contour*)` — static comparison for nesting
- `ResetUniqueID()` — reset contour identifier
- `setTmpSelected()` / `clearTmpSelected()` — temporary selection flags

**Contour construction from strokes:**
- `GR_StrokeAccess` — provides stroke topology for contour construction
  - `SetInsideColor()` / `SetOutsideColor()` — per-side colors
  - `SetInsideContour()` — link stroke to its contour
- `GR_DrawingAccess::SetContourColorAndLineStyle()` — apply to both contour and line style

**Gap closing:**
- `GR_GapFinder` — finds gaps in contours
  - `setGapLength(double)` / `setMinGapLength(double)` — gap tolerance
  - `setCurrentDrawing(GR_VectorDrawingObj*, GR_ColorDict*)` — set context
  - `setAllowGapsInsidePaintedContours(bool)` — gap behavior
  - `gapEdges()` — get gap edge data
- `GR_DrawingToolbox::CloseGapsOnColorArt()` — auto-close gaps on color art
- `GR_DrawingToolbox::closeGapAtBezierPathEndPoints()` — close gap at path ends

### 13. Vector Brush System

**`GR_VectorBrushImage`** — defines brush tip shapes:
- Built-in shapes:
  - `CircleVectorBrushImage()` — circle brush
  - `SquareVectorBrushImage()` — square brush
  - `DiamondVectorBrushImage()` — diamond brush
  - `Star5BranchesVectorBrushImage()` — 5-pointed star
  - `Star6BranchesVectorBrushImage()` — 6-pointed star
  - `DotsVectorBrushImage()` — dot pattern brush
- Custom: constructed from `vector<GR_BezierPath2d>` or loaded from XML (`load(QDomElement)`)
- `CalculateRadius()` — compute brush radius
- `PolygonBegin()` / `PolygonEnd()` — polygon construction
- `Clear()` — reset

**`GR_VectorBrushRenderer`:**
- `setBrushSizeRange(GR_Range)` — min/max brush size
- `setStylusParameters(double, AngleFunctionType)` — stylus pressure/angle
- `setVectorBrushImage(SharedPtr<VectorBrushImage>)` — set brush tip
- `setBrushPath(GR_FreehandRecorder*)` — set brush path
- `Draw(CGraphicOps, Callback)` — render the brush stroke
- `drawPencilStroke(Callback, ThicknessOutline)` — pencil-style rendering
- `drawOnePressureSegment()` — render single pressure segment

**`GR_VectorBrushImageList`:**
- `FindByName(QString)` — find brush by name

### 14. Drawing Toolbox Operations

**`GR_DrawingToolbox`:**
- `FlattenDrawing()` — flatten all layers
- `OptimizeDrawing()` — optimize stroke data
- `TransformDrawing(Matrix2x3)` — apply transform
- `TransformDrawing(float, float, float, float)` — scale/translate
- `ExtractCenterLine()` — extract centerline from filled region
- `LineArtToColorArtInternal` — convert line art to color art
- `AnyArtToDrawing()` — convert any art type to drawing
- `GetUsedColorMap()` — get all used colors
- `BuildCroppedTextures()` — crop textures to bounds
- `changeColors()` — change colors in drawing
- `removeUnusedColors()` — clean up palette
- `reduceInternalTextures()` — reduce texture memory
- `getMaxDpiFromInternalTexture()` — max texture DPI
- `pasteDrawing()` — paste drawing data
- `optimizeDrawing()` — full optimization pass
- `ComputeShowStrokes()` — compute visible strokes per layer type
- `transformPencilLines()` — transform pencil line thickness
- `GetBezierPathFromContour()` — extract bezier path from contour boundary
- `CleanUpDuplicateStrokes()` / `CleanUpUnnecessaryStrokes()` / `CleanUpStrokeIndicesAndLayers()` — cleanup

### 15. Triangulation for Fill Rendering

**`GR_Delaunay`:**
- `compute(GR_Contour*, Triangulation&, Settings&, map<VectorStroke*, vector<Point2d>>*)` — single contour
- `compute(vector<GR_Contour*>, Triangulation&, Settings&, ...)` — multiple contours
- `compute(vector<Point2d>, Triangulation&, Settings&)` — from point cloud
- `compute(vector<Point2d>, vector<pair<int,int>>, Triangulation&, Settings&)` — with edges
- `Triangulation::add(Triangulation)` — merge triangulations
- `Triangulation::interpolate()` — barycentric interpolation
- `Triangulation::computeTextureCoords(Matrix2x3)` — compute UVs
- `Triangle` struct — triangle data
- `TriangulationHashTable::build()` — spatial hash for point location
- `pointInsideTriangle()` / `pointInsideTriangleOrOnEdge()` — containment tests
- `circumCenter()` / `middlePoint()` — geometric queries

**`SR_Triangulation`:**
- `addTriangleStrip(GR_TexturedTriangleStrip)` — add textured strip
- `addTriangleFan(TexturedPolyline2d)` — add fan
- `addTriangleMesh(Matrix2x3, TiledBox2di, double)` — add mesh
- `createForContour()` — create triangulation for contour (software renderer)
- `canCreateForContour()` — check if contour can be triangulated
- `finalise()` — finalize triangulation

### 16. Scene Module Types (libToonBoomSceneCore)

From exported symbols:
- `STRING_MODULE` — base module
- `STRING_PEG` — peg (transform)
- `STRING_COMPOSITE` — composite
- `STRING_CUTTER` — cutter (matte)
- `STRING_BLUR` — blur
- `STRING_BLUR_DIRECTIONAL` / `STRING_DIRECTIONAL_BLUR` — directional blur
- `STRING_BLUR_RADIAL` / `STRING_BLUR_RADIAL_LEGACY` — radial blur
- `STRING_GLOW` — glow
- `STRING_GAUSIANBLUR` — gaussian blur
- `STRING_MATTE_BLUR` — matte blur
- `STRING_MATTE_RESIZE` — matte resize
- `STRING_MOTION_BLUR` — motion blur

Plugin API functions (from `opusH_*`, `opusP_*` pattern):
- `opusH_getTVG()` / `opusH_setTVG()` — get/set TVG drawing
- `opusH_getPixmap()` / `opusH_setPixmap()` — get/set pixel map
- `opusH_getMatrix()` — get transformation matrix
- `opusH_inputIsTVG()` — check if input is vector
- `opusH_setEmpty()` — set empty output
- `opusP_composite()` — composite two pixmaps
- `opusP_fade()` / `opusP_fadeAlpha()` — fade operations

### 17. Serialization Types

Types serialized via `DB_PersistentStore` (`operator<<` / `operator>>`):
- `GR_BezierPath2d` — bezier path
- `GR_LineStyle` — line appearance
- `GR_ThicknessPath` — variable width
- `GR_ThicknessPath::ThicknessKey` — thickness keyframe
- `GR_ThicknessPath::ThicknessControl` — bezier control
- `GR_ThicknessPath::Thickness` — thickness value
- `GR_FunctionPath` — 1D function
- `Math::Point2d` — 2D point
- `Math::Vector2d` — 2D vector
- `UT_NodePosition` — node z-ordering
- `CM_Rgba` — RGBA color
- `CM_Hsl` — HSL color
- `CM_HueRange` — hue range
- `CM_GradientData` / `CM_GradientDataCol` — gradient data
- `CM_TextureData` / `CM_ShareTextureData` — texture data
- `CM_ColorRecoveryInfo` — color recovery info
- `GR_Listener::Event` — listener event

## Additional Binary Findings

Second-pass analysis of `libToonBoomGraphicCore.1.0.0.dylib` (Harmony 24 Premium build 23443), focusing on areas not covered above.

### 1. TGRV Tag — Path Reversal, Not Winding

No symbol named "TGRV" exists in the binary. The TGRV tag we see in TVG files is handled generically by the tagged-format reader, not by a dedicated class. What TGRV stores is a **path reversal flag**, not a winding rule. Key evidence:

- `GR_BezierPath2d::Reverse()` — reverses point order of an entire bezier path
- `GR_BezierPath2d::AppendReverse()` / `AppendFrontReverse()` — append a path in reversed direction
- `GR_BezierPath2d::isReverseEqual()` — compare paths ignoring direction
- `GR_ThicknessPath::reverse()` — reverses thickness path to match reversed centerline
- `GR_ThicknessBinder::reverse()` / `reverseParameters()` — reverses thickness binding
- `GR_FunctionPath::reverse()` — reverses opacity function path

The orientation tests in the binary (`Number of 2D orientation tests`, `subsegment %p with orientation %d`) relate to the **contour topology builder** (`BuildContoursAndComponents`), not to a fill rule. Contour children use orientation to determine inside vs. outside.

**Implication for our renderer**: The TGRV flag likely indicates whether the bezier path points are stored in reversed order. If we ignore it, paths should still render correctly since our `evenodd` fill doesn't depend on winding direction. However, if we ever implement proper contour-based fill, the reversal flag determines whether a sub-contour is a hole or a solid region.

### 2. TGSD Component Types — No Additional Values Found

No `ComponentType` enum was found in exported symbols or strings. The component type values (0, 1, 2, 4) are likely used only as integer constants in the TVG binary format, not as a named C++ enum. The binary confirms the rendering distinction through class hierarchy:
- `GR_Contour` — fill component (types 0, 4)
- `GR_VectorStroke` — stroke component (types 1, 2)

### 3. GR_Layer::LayerType — The Layer Type Enum

While "shape type" had no direct hits, the binary reveals `GR_Layer::LayerType`:
- `GR_Layer::GR_Layer(GR_VectorDrawingObj*, LayerType)` — constructor takes LayerType
- `GR_DrawingAccess::SetLayerType(GR_Layer*, LayerType)` — can change layer type
- `GR_DrawingAccess::CreateLayerAbove(LayerType, ...)` / `CreateLayerUnder(LayerType, ...)`

This is used for the art layers in the TVG (ColorArt, LineArt, etc.), not for individual shapes. The values 0,1,4,5,6,7 we see in TGSD likely encode component properties (fill vs stroke, closed vs open, visibility).

### 4. Bitmap Tile Compositing — Pixel Formats and Operations

The bitmap tile system is more sophisticated than previously documented:

**Pixel formats** (all 8-bit and beyond):
- `BM_Pixel1` — 1-bit monochrome
- `BM_Pixel2` — 2-bit
- `BM_Pixel4` — 4-bit
- `BM_PixelBgr8` — 24-bit BGR (no alpha)
- `BM_PixelRgb8` — 24-bit RGB (no alpha)
- `BM_PixelArgb8` — 32-bit ARGB (alpha first)
- `BM_PixelBgra8` — 32-bit BGRA
- `BM_PixelRgba8` — 32-bit RGBA
- `BM_PixelGray8` — 8-bit grayscale
- `BM_PixelHsv8` — 8-bit HSV
- `BM_PixelHsva8` — 8-bit HSVA
- `BM_PixelGray16` — 16-bit grayscale
- `BM_PixelRgba16` — 16-bit RGBA
- `BM_PixelRgbaUnsigned16` — unsigned 16-bit RGBA
- `BM_PixelRgbaFloat` — 32-bit float RGBA

**Compose operations** (from template instantiations):
1. `ComposeOperationSrcOverwriteDst` — direct copy
2. `ComposeOperationRepaintNonPremultiplied` — repaint (non-premultiplied)
3. `ComposeOperationSrcAlphaNonPremultiplied` — src alpha blend (non-premultiplied)
4. `ComposeOperationSrcAlphaInverseNonPremultiplied` — inverted src alpha blend
5. `ComposeOperationSrcOverDstWithAlphaBlendingPremultiplied` — standard src-over (premultiplied)
6. `ComposeOperationSrcOverDstWithAlphaBlendingNonPremultiplied` — src-over (non-premultiplied)
7. `ComposeOperationSrcUnderDstWithAlphaBlendingNonPremultiplied` — src-under (dst-over)

**Key insight**: Bitmap TVGs store tiles as `BM_PixelRgba8` (RGBA, 8-bit per channel). The compositing engine handles both premultiplied and non-premultiplied alpha. The default compositing uses **non-premultiplied** alpha for most operations, with premultiplied only for the standard src-over blend.

**Implication for our renderer**: We should ensure bitmap tile compositing uses non-premultiplied alpha. The Canvas 2D API uses premultiplied internally, so we need to be aware of potential rounding differences, especially for semi-transparent bitmap tiles.

### 5. Implicit Scale / Point Quantum — Not Found

No symbols or strings matching "implicitScale", "pointQuantum", or "quantiz" were found in GraphicCore. Coordinate quantization (if any) is likely handled at a higher level or not used in the modern tagged format.

### 6. DB_PersistentStore / Tagged Format

The tagged format uses a policy-based reader/writer:
- `GIO_TaggedTVGReadPolicy` — reads tagged TVG objects via `ParseObject(DB_PersistentStore, CPersistentObjBase*)`
- `GIO_TaggedTVGWritePolicy` — writes via `WriteObject(DB_PersistentStore, CPersistentObjBase*)`
- `GIO_TaggedPenstyleListPolicy` — separate policy for pen style lists
- Constructor: `GIO_TaggedTVGWritePolicy(DB_Certificate*, unsigned int version, int format)`
- Validation: `GIO_TaggedTVGReadPolicy::isValid(DB_PersistentStore, unsigned int)`
- Error message: `"TvgStreamer::LoadTaggedFormat: format not allowed"` and `"Not a valid Tagged file."`

**Format versioning**: `GIO_TvgStreamer` has:
- `setOverrideStorageFormat(int)` — override output format
- `setOverrideStorageVersion(unsigned int)` — override version
- `isNewFormat(DB_PersistentStore, bool)` — detect new vs old format
- `convertToNewFormat(PL_FileSpec, CM_ColorRecoveryContext)` — format migration
- `getFileFormat(PL_FileSpec)` — detect file format

**TVGO database**: `GIO_TvgoDatabase` is an SQLite-based storage:
- `add(QString, DB_SqlBlob)` / `read(QString, DB_SqlBlob)` / `update(QString, DB_SqlBlob)` / `clear()`
- Used for the `.tvgo` format (optimized TVG cache in a database)

**Load order** (from `GR_VectorDrawingObj::Load`):
1. `LoadNodePosition` — z-order positions
2. `LoadSharedBezierPath` — shared paths (referenced by multiple strokes)
3. `LoadVectorAndTextLayers` → `LoadVectorAndTextGraph` — vector strokes + text
4. `LoadBitmapLayers` → `LoadBitmapGraph` — bitmap layers
5. `LoadPalette` — embedded palette

### 7. Gap Closing Algorithm — GR_GapFinder

Full API of the gap-closing system (used in the Paint Bucket tool, not in rendering):

- `GR_GapFinder(CGraphicOps&, double)` — constructor with default gap length
- `setGapLength(double)` — maximum gap to close
- `setMinGapLength(double)` — minimum gap threshold
- `setCurrentDrawing(GR_VectorDrawingObj*, GR_ColorDict*)` — set drawing context
- `setAllowGapsInsidePaintedContours(bool)` — whether to close gaps inside already-painted areas
- `gapEdges()` — returns computed gap edges

Related paint methods:
- `GR_Paint::FilterGaps(PaintOutline&)` — filter gaps from paint outline
- `GR_Paint::CreateGapLayer(Math::Segment2d::Intersection&)` — create invisible layer that closes gap
- `GR_Paint::DeleteAllGapLayers()` — cleanup
- `GR_DrawingToolbox::CloseGapsOnColorArt(...)` — high-level gap closing
- `GR_DrawingToolbox::closeGapAtBezierPathEndPoints(double, GR_BezierPath2d&)`
- `GR_BezierPath2d::GetMinGap()` / `GetMaxGap()` — gap measurement between paths
- `GR_Bezier2d::GapTest` — enum/struct for gap testing

**Not relevant for rendering**: This is a tool-time feature for the Paint Bucket. TVG files store the final painted contours, not gap-closing instructions.

### 8. Color Space — Non-Premultiplied Default, Linear Color Transforms

- `SR_LinearColorTransform` — linear color space transform in software renderer
- `GR_LinearShaderColorTransform` — linear color transform for shaders
- No sRGB/gamma references found — Harmony works in **linear color space** internally

The compose operations overwhelmingly use `NonPremultiplied` variants, confirming:
- **Default pixel format**: Non-premultiplied RGBA
- **Premultiplied** only used for the standard src-over alpha blend operation

### 9. Software Renderer Sampling Architecture

The sampling system is more complex than previously documented:

**Three sampling modes**:
1. `SR_SamplingUnfiltered` — no AA filtering (fast preview)
   - `addOpaque(scanline, mask, color)` — opaque pixel
   - `AddNoAlpha(scanline, mask, color, shaderId)` — no alpha
   - `AddWithAlpha(scanline, mask, color, shaderId)` — with alpha
2. `SR_SamplingFiltered` (base) — 2D AA filtering
   - `SR_FilteredSubPixel` — sub-pixel coverage data
   - `fillInteriorPixels()` — fill fully covered pixels
   - `applyTransparency()` — apply transparency
3. `SR_SamplingFiltered2d` / `SR_SamplingFiltered3d` — specialized versions
   - 3d version: `compose2dOn3d()`, `computeTransparency()`, `computeTwoPixelIntersection()`, `computeThreePixelIntersection()` — Z-buffer compositing with sub-pixel accuracy

**SR_FilteredWeight**: Controls the AA filter kernel. Constructed with a single `double` parameter (likely the filter radius or exponent).

**Rendering pipeline**:
1. `SR_ShadedObject::Prepare(Viewport, RendererOptions)` — setup
2. `SR_Polygon::Add(float x, float y)` — add vertices
3. `SR_Polygon::OpenOutline()` / `CloseOutline()` — outline control
4. `SR_ShadedObject::Shade(SR_Sampling&)` — scanline shading
5. `SR_Sampling::PushMask()` / `PopMask()` — nested masking
6. `SR_Sampling::ActivateTransparencyList()` — transparency

### 10. Additional Rendering Details

**GR_StrokeData::Flip()** — flip a stroke (mirror). This is separate from `Reverse()`.

**Tip types** (from `GR_ThicknessEnum`):
- `GR_ThicknessEnum::Tip` — pen tip shape enum
- `GR_ThicknessEnum::Side` — left/right side of stroke
- `GR_ThicknessEnum::Direction` — start/end direction
- `GR_VectorStroke::setTipType(Direction, Tip)` — set tip shape per end
- `GR_VectorStroke::setTipTangent(Side, Direction, double)` — tangent control per side per end
- `GR_ThicknessPath::setBezierTip(Direction, GR_Bezier2d)` — bezier-shaped tip

**Opacity path** (per-stroke opacity variation):
- `GR_VectorStroke::setSharedOpacityPath(GR_FunctionPath)` — set opacity function
- `GR_ThicknessBinder::setOpacityPath(GR_FunctionPath)` — bind opacity to thickness
- `GR_LineStyle::opacityColorId()` — opacity can reference a palette color
- `GR_LineStyle::setOpacityTilingENS_` — opacity texture tiling
- `GR_LineStyle::setOpacityTextureOffset/Scaling` — opacity texture transform
- `CPenStyle::opacityRange()` — pen style opacity range

**Line texture system**:
- `GR_LineStyle::addTextureInfo()` — add texture to line
- `GR_LineStyle::loadTextureInfo(DB_PersistentStore)` — deserialize
- `GR_LineStyle::setTextureOffset/setTextureScaling/transformTexture` — texture placement
- `GR_LineStyle::setTextureTiling(bool)` — repeat texture along stroke
- `GR_LineStyle::setWrapTextureAtTips(bool)` — wrap texture at stroke ends

**Shared bezier paths**: `GR_VectorDrawingObj::LoadSharedBezierPath(DB_PersistentStore)` — TVG files can share bezier path data between strokes. This is an optimization where multiple strokes reference the same centerline path. Our parser should check for this to avoid duplicate path data.

**Contour rendering methods** (important for our fill rendering):
- `GR_Renderer::drawContourUsingDelaunay()` — Delaunay triangulation (primary)
- `GR_Renderer::drawContourUsingFastTriangle()` — fast triangle method
- `GR_Renderer::drawContourVolume()` — volume (3D extrusion)
- `GR_Renderer::contourIsInteresting(CGraphicOps, GR_Contour*, double)` — skip trivial contours
- `GR_Renderer::feedContourPointsToCollection(GR_Contour*, bool)` — extract points

**Stamp brush composite**: `GR_StampBrushComposite` renders brush stamps:
- `Prepare(CGraphicOps, w, h, CPenStyle, ...)` — prepare stamp
- `DrawLivePreview(CGraphicOps, CPenStyle, i, Point2d)` — live preview
- Loaded from pen style definitions

**Variable stroke render modes**: `GR_Renderer::VariableStrokeRenderMode` enum exists but values not exposed as strings. `drawVariableStrokes(CGraphicOps, ThicknessOutline, double, VS_CanvasObjBuilder*, deque<StrokeInfo>, uint, VariableStrokeRenderMode)` — the mode likely controls: filled outline, centerline only, or outline only.

**Thickness discretization scale**: `GR_ThicknessDiscretizer::setDiscretizationScale(double)` and `setThicknessRenderParameters(GR_ThicknessRenderParameters)` — the discretization quality can be adjusted, likely based on zoom level.

**GR_Delaunay triangulation details**:
- `GR_Delaunay::Triangulation::computeTextureCoords(Math::Matrix2x3)` — texture coordinates for triangulated fills
- `GR_Delaunay::TriangulationHashTable::build()` — spatial hash for triangle lookup
- `GR_Delaunay::Triangulation::interpolate(...)` — interpolate values within triangulation
- `GR_Delaunay::Settings` — configuration struct for triangulation quality

**SR_Triangulation extensions**:
- `addTriangleFan(Math::TexturedPolyline2d)` — fan from polyline
- `addTriangleStrip(GR_TexturedTriangleStrip)` — textured strip
- `addTriangleMesh(Math::Matrix2x3, Math::TiledBox2di, double)` — mesh for bitmap tiles

### 11. CelCore TVG Tags (from libToonBoomCelCore)

Additional 4-char tags found in CelCore:
- `TBHD` — bitmap header
- `TBMP` — bitmap data
- `TCCP` — (unknown, possibly color conversion profile)
- `TIFD` / `TIFF` — TIFF-related
- `TONE` — tone/shading
- `TRAK` — tracking data
- `TVGO` — optimized TVG object (database-cached format)
- `TXTL` — text layer
