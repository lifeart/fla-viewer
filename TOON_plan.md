# Toon Boom .tpl Format Support — Implementation Plan

## Format Research

### What is a .tpl file?

A `.tpl` (template) is a **directory** (zipped for distribution) that is structurally identical to a Toon Boom Harmony project (`.xstage`). Created with Harmony Premium (samples use v22.0.3, build 21960).

### Internal Structure

```
<project>.tpl/
  .thumbnails/           # Per-frame PNG thumbnails (t-0001.png .. t-NNNN.png)
  elements/              # Drawing data (TVG vector files)
  environments/          # Environment hierarchy (may contain "Digital" subfolder)
  frames/                # Rendered frames (usually empty)
  jobs/                  # Job hierarchy (usually empty)
  models/                # Model sheets (full rigs only, usually empty)
  palette-library/       # .plt palette files
  scripts/               # .js scripts + .tbState files for MasterControllers
  PALETTE_LIST           # Palette registry file
  scene.aux              # Drawing version/audit info (XML)
  scene.aux~             # Backup copy
  scene.elementTable     # Element registry (XML)
  scene.versionTable     # Version metadata (XML)
  scene.xstage           # MAIN FILE: full scene graph, timeline, columns, node connections (XML)
  scene.xstage~          # Backup copy
```

### Key Files

#### `scene.xstage` — Main Scene Definition (XML, ~9-12 MB)

```xml
<project source="Harmony Premium..." version="2203">
  <elements>          <!-- Element registry (mirrors scene.elementTable) -->
  <options>
    <metrics>         <!-- Canvas: e.g. 4096x3112, 4:3 aspect, 24x24 field -->
    <resolution>      <!-- e.g. film-4K, 4096x3112 -->
    <framerate val="24"/>
  </options>
  <scenes>
    <scene name="Top" nbframes="112" startFrame="1">
      <columns>       <!-- ALL animation columns -->
      <rootgroup name="Top">
        <nodeslist>   <!-- Recursive node graph hierarchy -->
        <linkedlist>  <!-- Connection graph between nodes -->
        <backdrops>   <!-- Visual organizer rectangles in node view -->
        <waypoints>   <!-- Connection routing waypoints -->
      </rootgroup>
    </scene>
  </scenes>
  <symbols>           <!-- Symbol folder references -->
  <timeline>          <!-- Timeline scene reference -->
</project>
```

#### Column Types

| Type | Purpose | Content |
|------|---------|---------|
| **0** | Drawing exposure | `<elementSeq exposures="1-99,100,101-107" val="1" id="3"/>` — maps frame ranges to drawing names |
| **2** | 3D Path | `<path3D>` with `<pt val="x,y,z" lockedInTime="N"/>` keyframes |
| **3** | Bezier/function curve | `<points>` with `<pt constSeg="true" x="frame" yLocal="value"/>` |
| **5** | Script/expression (JS) | `<JS><![CDATA[...]]></JS>` |
| **10** | MasterController data | References to `.js` and `.tbState` file paths |

#### Node/Module Types

Key types found in samples:

- **READ**: References a drawing element via `<element col="ATV-...">`, with full transform attrs (offset, scale, rotation, pivot, skew, IK settings)
- **PEG**: Transform peg (bone), attributes reference columns by `col="ATV-..."` IDs
- **COMPOSITE**: Compositing modes (passthrough, bitmap), z-ordering
- **CUTTER**: Masking/clipping
- **MasterController**: Rig controls with embedded `<specs>` XML defining slider UI
- **CurveModule/OffsetModule**: Deformation chain nodes
- **group**: Container node with nested `<nodeslist>` and `<linkedlist>`

Other types: `AutoPatchModule`, `BOOL`, `COLOR2BW`, `COLOR_ART`, `COLOR_OVERRIDE_TVG`, `COLOUR`, `DOUBLE`, `DeformTransformOut`, `DeformationCompositeModule`, `FADE`, `GAUSSIANBLUR-PLUGIN`, `GLOW`, `LAYER_SELECTOR`, `LINE_ART`, `MATTE_BLUR`, `MATTE_RESIZE`, `MULTIPORT_IN`, `MULTIPORT_OUT`, `NOTE`, `OVERLAY`, `STRING`, `StaticConstraint`, `TbdColorSelector`, `TransformationSwitch`, `UNDERLAY`, `VISIBILITY`, `WeightedDeform`

#### Connection Graph (`<linkedlist>`)

```xml
<link out="NodeName" in="TargetNode" inport="0"/>
<link out="NodeName" outport="1" in="TargetNode" inport="2"/>
```

### `scene.elementTable` — Element Registry

```xml
<elements source="Harmony Premium..." version="2203">
  <element id="1" elementName="Shadow_Neck" elementFolder="Shadow_Neck"
           pixmapFormat="2" scanType="2" fieldChart="12" vectorType="2" rootFolder="elements"/>
```

- Maps numeric element IDs to named folders in `elements/`
- Colliding names get suffixed: `Body.24`, `Collar.17`, `EXTRA.61`
- All samples use `pixmapFormat="2"`, `vectorType="2"` (Toon Boom Vector)

### `scene.aux` — Drawing Version Audit

```xml
<SceneVersion ID="1" Modified="2024-12-03 16:48:13" VersionName="scene">
  <Element ID="1" Name="Shadow_Neck" Folder="Shadow_Neck">
    <Drawing Name="1" Key="" Version="1"/>
  </Element>
```

### Drawing Storage (`elements/`)

Each element has its own subfolder:
```
elements/ElementName/
  ElementName-DrawingName.tvg     # Vector drawing files
  .thumbnails/                    # Optional PNG previews
  palette-library/                # Per-element palette overrides (usually empty)
```

Naming conventions:
- `.tpl` files: human-readable folder names (`F-Hand_OL_1_F`, `Body_Top`)
- Full rigs: mix of human-readable AND hex-ID folders (`00ad`, `04ae`, `1388`)
- Drawing files: `ElementFolder-DrawingName.tvg` where DrawingName is numbers (`1`, `2`), descriptive (`1_no_OL`), or special (`000_`)

Sample element counts: V003/V004 have 85 elements; V07 has 173 elements.

### TVG Binary Format (Toon Boom Vector Graphic)

**Header:**
```
Offset 0:  "OTVGfull" (8 bytes magic)
Offset 8:  Version (4 bytes LE uint32, e.g. 1009)
Offset 12: Flags/count (4 bytes)
Offset 16: More flags (4 bytes)
Offset 20: CERT chunk (DRM/license certificate, PEM X.509)
```

**Chunk-based format:**

| Chunk Tag | Purpose |
|-----------|---------|
| `CERT` | License certificate (PEM X.509, ~631 bytes) |
| `ENDT` | End-of-section marker |
| `UNCO` | Uncompressed container holding all drawing data |
| `TTOC` | Table of contents |
| `CREA` | Creator/signature metadata |
| `SIGN` | Digital signature |

Each chunk: `TAG(4 bytes) + LENGTH(4 bytes LE) + DATA(LENGTH bytes)`

**Inside `UNCO` block** — begins with `TVCI` (Toon Vector Compressed Info), then ZLIB-compressed sub-blocks:

ZLIB block format: `"ZLIB" + totalLen(4) + decompressedSize(4) + zlibStream`

Decompressed sub-tags:

| Sub-tag | Purpose |
|---------|---------|
| `TGLY` | Geometry Layer container |
| `TGVS` | Vertex Set |
| `TGSD` | Shape Data (vertex coordinates as doubles) |
| `TGCO` | Color reference (links to palette) |
| `TGBP` | Bezier Path data |
| `TGRV` | Reverse/winding info |
| `TCSC` | Color Swatch Color (4 bytes RGBA) |
| `TCID` | Color ID (UTF-16LE name string linking to palette entry) |

### Palette System

**`PALETTE_LIST`** — references palettes with original file paths:
```
ToonBoomAnimationInc PaletteList 1
palette-library/Anna LINK "C:/Users/.../Anna.plt"
palette-library/Controllers LINK "C:/Users/.../Controllers.plt"
```

**`.plt` files** — plain text, one color per line:
```
ToonBoomAnimationInc PaletteFile 2
Solid    Hair           0x0c52af9d81aa3618 179  34  66 255
Gradient Hair_grad      0x0bbf28a8b310d773 Linear
{        0.0 216  54 122  73,
       100.0 160  13  91 109 }
```

Format: `Type  Name  UniqueID  R G B A`
Types: `Solid`, `Gradient` (with stops).
The hex ID is the global unique color identifier referenced by TVG files via `TCID` tags.

### Scripts & MasterControllers

**`scripts/*.js`** — MasterController interpolation engine.

**`scripts/<name>/*.tbState`** — State preset files (INI-like):
```ini
[TB_StateManager]
State Count:7
  [TB_State]
  Name:"animatedState_120"
  Frame:120
  Node Count:196
    [TB_NodeState]
    Node:"~/Head_All/EXTRA_3-DFM/1_2/Curve_1"
    Attr Count:5
      AttrName:"Length0"=0.1395
```

---

## Architecture Comparison: FLA vs TPL

| Aspect | FLA (Adobe) | TPL (Toon Boom) |
|--------|-------------|-----------------|
| Container | ZIP with XML + binary | Directory (zipped) with XML + binary |
| Scene graph | Flat timeline with layers | **Node graph** (DAG) with compositing |
| Drawings | Shapes inline in XML (edge format) | Separate **TVG binary files** |
| Animation | Frame-based with tweens | Column-based with exposure sheets |
| Colors | Inline hex/gradients | **Palette indirection** (64-bit ID-based) |
| Compositing | Simple layer stacking | Full node-based (COMPOSITE, CUTTER, FADE) |
| Deformation | Shape tweens | Bone/mesh deformation chains |
| Transforms | Matrix per element | PEG nodes with column references |

---

## Reference Projects

- **[cpsdqs/tvg](https://github.com/cpsdqs/tvg)** — Rust TVG decoder + xstage parser (best reverse engineering reference)
- **[cfourney/OpenHarmony](https://github.com/cfourney/OpenHarmony)** — JS DOM library for Harmony scripting API
- **[diegogarciahuerta/tk-harmony](https://github.com/diegogarciahuerta/tk-harmony)** — Shotgun Toolkit engine for pipeline integration
- **[ynput/ayon-harmony](https://github.com/ynput/ayon-harmony)** — AYON/OpenPype integration

---

## Sample Files

Located in `sample/toon/`:
- `CH_Anna_football_V003.tpl.zip` — 85 elements, 112 frames
- `CH_Anna_football_V004.tpl.zip` — 85 elements, 112 frames (with versionTable)
- `CH_Anna_rig_football_suit_V001_V07.zip` — 173 elements, full rig with hex-ID folders

---

## Implementation Plan

### Phase 1 — Thumbnail Viewer (Low Effort)

**Goal:** Unzip `.tpl.zip`, parse metadata, display pre-rendered thumbnails as a slideshow.

**Tasks:**
- [ ] Detect `.tpl.zip` files on upload (check for `scene.xstage` inside ZIP)
- [ ] Parse `scene.xstage` XML for metadata: canvas dimensions (`<metrics>`), framerate (`<framerate>`), frame count (`nbframes`)
- [ ] Load `.thumbnails/t-NNNN.png` files as frame images
- [ ] Display thumbnails in existing player (slideshow mode at correct framerate)
- [ ] Show basic info: element count, palette names, Harmony version
- [ ] Parse `PALETTE_LIST` and `.plt` files to display color palette

**Reusable from FLA Viewer:**
- ZIP extraction (JSZip)
- XML parsing (DOMParser)
- Player timeline/scrubbing
- Canvas rendering for PNG frames
- UI chrome (file picker, controls, info panel)

### Phase 2 — Structure Explorer (Medium Effort)

**Goal:** Parse and display the node graph, element tree, timeline/exposure sheet.

**Tasks:**
- [ ] Parse `scene.elementTable` to build element registry
- [ ] Parse `<columns>` section — extract drawing exposure (type 0) and keyframe data (type 3)
- [ ] Parse `<nodeslist>` to build node hierarchy tree
- [ ] Parse `<linkedlist>` to build connection graph
- [ ] Display node tree in sidebar (expandable groups)
- [ ] Display exposure sheet (which drawing is shown on each frame per element)
- [ ] Show palette colors with names and IDs

### Phase 3 — TVG Rendering (High Effort)

**Goal:** Decode TVG binary files and render vector drawings to Canvas 2D.

**Tasks:**
- [ ] Implement TVG chunk reader (magic, version, CERT, UNCO, TTOC, CREA, SIGN, ENDT)
- [ ] Implement ZLIB sub-block decompression inside UNCO
- [ ] Parse geometry sub-tags: TGLY, TGVS, TGSD, TGBP, TGCO, TGRV, TCSC, TCID
- [ ] Map TCID color IDs to palette entries from `.plt` files
- [ ] Convert TGSD vertex data + TGBP bezier paths to Canvas 2D path operations
- [ ] Handle color art vs line art separation (COLOR_ART / LINE_ART nodes)
- [ ] Render individual drawings to canvas at correct position
- [ ] Reference: [cpsdqs/tvg](https://github.com/cpsdqs/tvg) Rust decoder

### Phase 4 — Full Compositing (Very High Effort)

**Goal:** Evaluate the full node graph to produce composited frames.

**Tasks:**
- [ ] Implement node graph evaluator (topological sort of DAG)
- [ ] Implement READ node: resolve drawing exposure per frame, apply transforms
- [ ] Implement PEG node: evaluate column-driven transforms (position, rotation, scale, skew)
- [ ] Implement COMPOSITE node: layer blending with z-order
- [ ] Implement CUTTER node: masking/clipping
- [ ] Implement effect nodes: FADE, GAUSSIANBLUR, GLOW, MATTE_BLUR, MATTE_RESIZE
- [ ] Implement COLOR_OVERRIDE_TVG: runtime palette color swapping
- [ ] Implement deformation chains: OffsetModule, CurveModule, WeightedDeform
- [ ] Implement group evaluation (recursive)
- [ ] Implement column interpolation for type 3 (bezier keyframe) columns
- [ ] Audio support (if `audio/` folder present)
- [ ] Video export reuse from FLA viewer
