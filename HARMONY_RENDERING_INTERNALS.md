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
