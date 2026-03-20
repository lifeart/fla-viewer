# TVG Rendering Improvements Plan

## Current State

| Metric | Value |
|--------|-------|
| **Average similarity** | 94.3% across 150 element thumbnails |
| **100% pixel-perfect** | 6 drawings |
| **≥98%** | 52 drawings (35%) |
| **≥95%** | 90 drawings (60%) |
| **≥90%** | 126 drawings (84%) |
| **<80%** | 5 drawings (3%) — all compositing-dependent |
| **Code** | tvg-parser.ts (2219 lines), tpl-parser.ts (928), tpl-compositor.ts (671) |

### What's implemented
- TVG binary parser: all chunk types, TGLY/TGVS/TGSD/TGBP/TGCO/tGTB geometry
- Fill rendering: multi-color grouping, greedy endpoint chaining (TOL=2.0), evenodd fill rule
- Stroke rendering: invisible boundary detection (ct=2), variable-width outlines from thickness profiles
- Three-pass compositing: fills → dilated flood-fill clipping → strokes on top
- Layer management: skip underlay (Mask colors), filter low-alpha controller fills
- External palette resolution: .plt overrides internal TPAL, colorId from paletteIndex
- Scene graph compositor: parses full DAG, evaluates READ/PEG/COMPOSITE/CUTTER/FADE/VISIBILITY

### Remaining quality gap breakdown (5.7%)

| Category | % of total diffs | Root cause | Fixable without compositor? |
|----------|-----------------|------------|---------------------------|
| **Fill overflow** | 43.5% | Fills extend beyond strokes; dilated flood-fill helps but leaks on complex drawings | Partially — better dilation or per-shape clipping |
| **Color mismatch** | 21.3% | CUTTER compositing substitutes colors (e.g., Skin→Shorts blue) | No — requires compositor |
| **Missing fill** | 21.4% | Viewport/scale diff with Toon Boom's internal renderer | Partially — viewport tuning |
| **Stroke diff** | 10.5% | Width, antialiasing, cap/join differences | Partially — no tGTB test data |
| **Antialiasing** | 3.2% | Renderer-specific pixel smoothing | No |

---

## Plan: TVG Rendering → 100%

**Final measured quality: 94.4% avg across 150 drawings (6 at 100%, 52 at ≥98%, 90 at ≥95%)**

### Priority 1 — Fix compositor coordinate mapping (HIGH IMPACT) ✅ DONE

**Commit:** `38363a1`

**Problem:** Compositor loads 58 drawings and composites them, but all elements pile up in the center because PEG transforms aren't converting TVG coordinate space to pixel space correctly.

**Root cause:** `buildTransformMatrix()` in `tpl-compositor.ts` computes a DOMMatrix from PEG attributes, but the translation values are in TVG field units. The conversion `pixelsPerField = canvasSize / 12` is approximate and doesn't account for the project's actual field chart, resolution, and aspect ratio.

**Fix:**
1. Parse `<metrics>` from scene.xstage for the project's field dimensions (e.g., `fieldX=24`, `fieldY=18`)
2. Compute `pixelsPerFieldX = canvasWidth / fieldX` and `pixelsPerFieldY = canvasHeight / fieldY`
3. Each PEG's `position.x/y` values are in field units — multiply by pixelsPerField
4. Each READ node inherits accumulated transforms from its parent PEG chain
5. Apply Y-flip (TVG Y-up → Canvas Y-down) at the coordinate conversion stage, not per-element

**Files:** `src/tpl-compositor.ts` (lines 316-341: `buildTransformMatrix`, lines 455-495: PEG case)

**Validation:** Load V003 or V004 sample (which have frame thumbnails). Compare compositor output for frame 1 against the pre-rendered `.thumbnails/t-0001.png`.

### Priority 2 — Improve flood-fill clipping robustness (MEDIUM IMPACT) ✅ DONE

**Problem:** The dilated flood-fill clips fills to stroke boundaries for simple shapes (sealed outlines) but fails on complex drawings with many small stroke segments. The leak detection (>50% erased → skip) prevents over-erasing but also prevents clipping for the ~30% of drawings that need it most.

**Approach A — Adaptive dilation radius:**
- Compute stroke density: `totalStrokeLength / canvasArea`
- Low density (simple shapes): use radius 2
- High density (complex character art): use radius 3-4
- Very sparse strokes: skip clipping entirely

**Approach B — Per-shape clipping:**
Instead of one global flood-fill, process each shape independently:
1. For each shape with both fills and strokes, render fills and strokes to a small bounding-box canvas
2. Dilate + flood-fill within that small canvas
3. Composite the clipped shape back to the main canvas
- Pro: leaks in one shape don't affect others
- Con: slower (many small canvases), doesn't handle cross-shape boundaries

**Approach C — 2x resolution mask:**
Render the stroke mask at 2x the output resolution. At 2x, sub-pixel gaps become 1px gaps which are more reliably closed by dilation. Downsample after flood-fill.
- Pro: more accurate boundary detection
- Con: 4x memory for mask canvas

**Files:** `src/tvg-parser.ts` (lines 1473-1570: flood-fill section)

### Priority 3 — Art layer rendering for CUTTER elements (MEDIUM IMPACT) ✅ DONE

**Problem:** Elements with underlay Mask colors score 60-89% because the visible color comes from CUTTER compositing with parent elements. Skipping underlay helps (removes green/peach) but the element then renders its color-art fills which may not match the CUTTER'd result.

**Fix:** In the compositor, implement proper CUTTER evaluation:
1. The LA-AP-CA group pattern splits a READ node into COLOR_ART (port 0), AUTO_PATCH (port 1), LINE_ART (port 2)
2. COLOR_ART feeds into a COMPOSITE (`C-color`) with the parent's color (from MULTIPORT_IN)
3. The COMPOSITE result feeds into a CUTTER which clips to the COLOR_ART boundary
4. The CUTTER output shows the parent's color only where this element's color-art exists

Currently `COLOR_ART` and `LINE_ART` are pass-through. They should instead filter the drawing to only the specific art layer (tCAA for color-art, tLAA for line-art).

**Implementation:**
1. Add `artLayerFilter` field to `TVGRenderOptions`: `'all' | 'color' | 'line' | 'overlay'`
2. In `renderTVGToCanvas`, respect the filter to render only the specified layer
3. In compositor's `evaluateNode`, when hitting `COLOR_ART`/`LINE_ART` nodes, pass the appropriate filter to the READ node's TVG renderer
4. The CUTTER then clips the parent's color to the color-art alpha mask

**Files:** `src/tvg-parser.ts` (TVGRenderOptions), `src/tpl-compositor.ts` (COLOR_ART/LINE_ART cases)

### Priority 4 — Bezier thickness interpolation for variable-width strokes (LOW IMPACT) ✅ ALREADY IMPLEMENTED

**Problem:** The tGTB thickness profile has bezier control points for smooth width variation, but we skip them (`reader.skip(16)`) and use linear interpolation. The centerline sampling also flattens bezier curves to just endpoints.

**Note:** Research confirmed that NONE of the 841 TVG files in the 3 test ZIPs contain tGTB/tGTI data. This fix improves correctness for files from other sources but doesn't affect current test scores.

**Fix:**
1. Parse the 4 left + 4 right bezier control point floats per thickness point (currently skipped)
2. Store in `TVGThicknessProfile.points[].leftCtrlFwd`, `.leftCtrlBack`, `.rightCtrlFwd`, `.rightCtrlBack`
3. Parse the thickness domain `(f32, f32)` after point data — maps centerline parameter to thickness parameter
4. For type=0x00 references: reuse previous profile's points with new domain
5. In `renderVariableWidthStroke`:
   - Subdivide bezier curve segments for accurate arc-length computation (not just endpoints)
   - Use cubic bezier interpolation of thickness (not linear)
   - Apply domain mapping: `thicknessT = (centerlineT - domain[0]) / (domain[1] - domain[0])`
   - Render round end caps using 1.33x scale factor (from cpsdqs reference)

**Files:** `src/tvg-parser.ts` (lines 940-976: `parseTGTB`, lines 1820-1860: `renderVariableWidthStroke`)

### Priority 5 — Column interpolation for animated compositing (LOW IMPACT) ✅ DONE

**Problem:** The compositor evaluates columns at frame 1 using exact-match or nearest-constSeg lookup. For animated playback (frames 2+), smooth bezier interpolation between keyframes is needed.

**Fix:**
1. Parse the full `x` field in type-3 column `<pt>` entries (can contain frame ranges like `"1,10,60"`)
2. For `constSeg=false` keyframes, implement cubic bezier interpolation between adjacent points
3. The bezier is defined by the `x` and `y` fields of adjacent `<pt>` entries (x=frame position, yLocal=value)

**Files:** `src/tpl-compositor.ts` (lines 260-280: `evaluateColumn`)

### Priority 6 — Effect nodes (FUTURE)

Not implemented, low priority for static rendering:
- `GAUSSIANBLUR-PLUGIN`: Canvas `ctx.filter = 'blur(Npx)'`
- `GLOW`: Duplicate + blur + additive blend
- `MATTE_BLUR` / `MATTE_RESIZE`: Blur/resize the matte shape
- `FADE`: Already implemented (opacity scaling)

### Priority 7 — Deformation chains (FUTURE)

For full character posing:
- `CurveModule`: Defines a deformation curve (bone)
- `OffsetModule`: Applies envelope deformation along the curve
- `WeightedDeform`: Blends multiple deformation regions
- `DeformationCompositeModule`: Composites deformed output
- `DeformTransformOut`: Extracts transform from deformation for child nodes

This is the most complex remaining feature. The sample rig has 255 OffsetModules and 1057 CurveModules. Implementation would require:
1. Parse curve control points from CurveModule column data
2. Build envelope deformation mesh
3. Apply mesh deformation to rendered TVG elements
4. Requires spatial subdivision for performance

---

## Validation Strategy

### Element-level comparison (current)
- Parse all TVG+thumbnail pairs from the ZIP (150-191 matches)
- Render each TVG at 320×320
- Pixel-diff against embedded thumbnail at tolerance 50/channel
- Track: average similarity, distribution buckets, per-category diff analysis

### Compositor-level comparison
- For samples with frame thumbnails (V003, V004): compare compositor output against `.thumbnails/t-0001.png`
- For rig samples (V07): compare against Puppeteer screenshot of Toon Boom's web player (if available)

### Regression prevention
- Keep `render-compare.ts` for the 5 core test drawings (F-Hand, Number_Body, F_3_symbol)
- Run broad comparison after each change to ensure no regressions
- Track the 6 pixel-perfect drawings — they must stay at 100%

---

## Research Findings Archive

### From 7 research agents:

1. **cpsdqs/tvg reference**: Uses SVG concatenation + evenodd, no fill clipping. Our chaining approach is better for Canvas 2D.
2. **Fill overflow**: Dilated flood-fill is the best Canvas 2D approach. Per-shape clip paths and path offsetting are impractical. 2x resolution mask is a viable enhancement.
3. **Node graph compositing**: Full DAG evaluation plan with column resolution, exposure mapping, transform accumulation, CUTTER semantics.
4. **Mask color resolution**: Mask is exclusively in underlay (tUAA), always palette index 0 from Controllers.plt. No color override tables exist — colors come from CUTTER compositing only.
5. **Stroke precision**: tGTB bezier control points and domain mapping are significant for quality but no test data contains them. tGTI parsing is unverifiable.
6. **Multi-Port-Out naming**: Standard name is "Multi-Port-Out", some groups use "GroupOUT".
7. **Overlay layer**: Present in 41.7% of files, ambiguous content (controllers vs visible art). Skipping overlay has minimal quality impact (±0.1%).
