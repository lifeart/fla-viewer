# FLA Viewer

[![Deploy to GitHub Pages](https://github.com/lifeart/fla-viewer/actions/workflows/deploy.yml/badge.svg)](https://github.com/lifeart/fla-viewer/actions/workflows/deploy.yml)
[![Tests](https://github.com/lifeart/fla-viewer/actions/workflows/test.yml/badge.svg)](https://github.com/lifeart/fla-viewer/actions/workflows/test.yml)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

Open Adobe Animate / Flash `.fla` files in the browser. Parsing, playback and export all run locally; the file never leaves your machine.

**[Live demo](https://lifeart.github.io/fla-viewer/)**: drop a `.fla` file or click **Sample**.

## Why

`.fla` is the editable source format of Flash Professional and Adobe Animate. Unlike a compiled `.swf`, it keeps the vector shapes, timelines, symbols, bitmaps and sounds. Without Animate there is no easy way to look at one. This viewer reads the file directly and draws it with Canvas 2D, so old projects can be previewed, inspected and exported to video without Adobe software or Flash Player.

## Supported files

| Format | Versions | Support |
|--------|----------|---------|
| XFL (ZIP + XML) | Flash CS5 and later, Animate | Full viewer (see below) |
| Binary (OLE2 compound file) | Flash 5 to CS4 | Partial: stage size, frame rate, background, library, shapes, symbol instances and keyframes. No tweens, frame labels or sounds. Streams the decoder can't walk cleanly are shown as one frame. |

## Features

**Timeline**
- Multiple scenes, frame labels, play / pause / scrub / step
- Motion tweens with CreateJS-compatible easing (named eases, intensity eases, custom bezier eases), rotation (CW/CCW), orient to path
- Shape tweens, color transform tweens
- Graphic symbols (loop, play once, single frame) and movie clips with their own playheads
- Layer parenting (Animate rig), evaluated between child keyframes
- Hidden layers and folders, guide layers, auto-detected camera layer with optional follow mode

**Drawing**
- Shapes from quadratic `edges` and cubic `cubics` data, solid / dashed strokes, caps, joints, miter limit
- Linear and radial gradients (spread modes, focal point), gradient and bitmap strokes
- Bitmap fills (repeating, clipped, non-smoothed)
- Masks, including masks built from symbols, tweens and text
- Filters: blur, glow, drop shadow, bevel, color matrix / adjust color, convolution, gradient glow, gradient bevel
- Blend modes, color effects (alpha, tint, brightness, advanced)
- 9-slice scaling, 3D transforms (simplified perspective), cache as bitmap
- Static and dynamic text with runs, word wrap, alignment, line spacing, kerning, rotation

**Media**
- Bitmaps: PNG, JPEG, GIF and Adobe `.dat` lossless bitmaps (32-bit and 8-bit palette), with recovery for damaged data
- Sound: MP3, ADPCM, PCM (8/16/24/32-bit), stream and event sync, in/out points, loops, volume
- Embedded video: native MP4 / WebM plays (muted) on the timeline; FLV shows a placeholder with its metadata

**Export** (Download button)

| Format | Output |
|--------|--------|
| MP4 | H.264, 5 Mbps. Audio is AAC, or Opus where the browser has no AAC encoder (Firefox). Without either, it exports video only and warns. |
| WebM | VP9, 5 Mbps, Opus audio |
| Animated GIF | `.gif`, no audio |
| PNG sequence | `.zip` of numbered frames |
| Current frame | `.png` or `.svg` |
| Sprite sheet | `.png` atlas + `.json` |

The Download button only appears when the browser supports WebCodecs (`VideoEncoder` and `AudioEncoder`) and the document has more than one frame.

## Offline

After the first visit the viewer works without a network: a service worker caches the whole app, including the export libraries and fonts, and the browser can install it as an app. When a new version is deployed, a notice offers to reload; until then open tabs keep the version they started with. Bookmark the address with its trailing slash (`/fla-viewer/`): without it the URL is outside the cached app and only works online. Fonts used by FLA text are shipped with the app (Press Start 2P, from `@fontsource`), never loaded from a font CDN.

## Controls

| Input | Action |
|-------|--------|
| `Space` | Play / pause |
| `←` `→` | Previous / next frame |
| `Home` `End` | First / last frame |
| `PgUp` `PgDn` | Previous / next scene |
| `+` `-` `0` | Zoom in / zoom out / reset view |
| `Shift` + arrows, or drag the canvas | Pan |
| `D` | Debug panel |
| `M` | Mute |
| `F` | Fullscreen |

The upload widget can be dragged aside or closed once a file is open.

### Debug panel

Press `D`. It lists layers with visibility toggles, inspects elements (click on the canvas to pick one), expands nested symbols, changes render order, toggles camera follow, and has edge-decoder options (debug logging, implicit MoveTo after close, splitting on style changes).

### Embedding

Add `?embed=true` to hide the header:

```html
<iframe src="https://lifeart.github.io/fla-viewer/?embed=true"
  width="800" height="600" frameborder="0" allowfullscreen></iframe>
```

## Limitations

- ActionScript is not executed. Buttons don't respond to the mouse (their hit areas show in the debug panel).
- Embedded video isn't drawn into exports, and seeking it is best-effort. FLV video is not decoded.
- Fonts are not embedded. Fonts that exist on Google Fonts are fetched from there (a network request); others fall back to system fonts.
- Some filter options are approximated with Canvas and SVG filters.
- Parsing runs on the main thread, so large files block the UI while loading.

## Development

Requires Node.js 20 or later.

```bash
git clone https://github.com/lifeart/fla-viewer.git
cd fla-viewer
npm install
npm run dev            # dev server on http://localhost:3000
npm run build          # type-check and build to dist/
npm run preview        # serve the build
```

### Tests

Tests use Vitest in browser mode with Playwright Chromium, because the renderer needs a real Canvas. Files named `*.node.test.ts` run in Node instead: `offline.node.test.ts` builds the app, serves it, loads it in Chromium, stops the server and checks the app still loads, plays the sample and loads every chunk from the service worker cache.

```bash
npx playwright install chromium   # once
npm test                          # run all tests
npm run test:watch
npm run test:coverage             # report in coverage/
```

Tests live in `src/__tests__/`, with sample FLAs in `src/__tests__/fixtures/`. Some fixtures are generated by scripts in `scripts/` (`gen-*.mjs`, `make-timeline-fixture.mjs`).

CI runs the tests on every pull request (`.github/workflows/test.yml`). Pushes to `master` deploy the build to GitHub Pages (`.github/workflows/deploy.yml`).

### Project layout

```
src/
├── main.ts                  UI, controls, file loading
├── fla-parser.ts            XFL parsing (ZIP + XML), bitmaps, sounds, video
├── edge-decoder.ts          XFL edge / cubic path decoder
├── shape-utils.ts           Shape repair and path helpers
├── path-utils.ts            Library path normalization
├── layer-utils.ts           Layer visibility, mask membership, rig parents
├── renderer.ts              Canvas 2D renderer
├── player.ts                Playback, scenes, audio sync, zoom and pan
├── video-exporter.ts        MP4 / WebM / GIF / PNG / SVG / sprite sheet export
├── adpcm-decoder.ts         ADPCM audio decoder
├── flv-parser.ts            FLV metadata parser
├── ole2-reader.ts           OLE2 compound file reader (binary FLA)
├── binary-fla-parser.ts     Binary FLA entry point
├── binary-fla-structure.ts  Binary FLA layer structure
├── binary-shape-decoder.ts  Binary FLA shape geometry
├── binary-instance-decoder.ts  Binary FLA symbol instances
├── binary-timeline-decoder.ts  Binary FLA layers and keyframes
├── sample-generator.ts      Built-in sample file
├── types.ts                 Document types
└── __tests__/               Tests and fixtures
```

```
.fla ──► fla-parser (XFL) ─┐
     └─► binary-fla-parser ┴─► FLADocument ──► Renderer ──► Canvas
                                    │
                                    ├──► Player ──► Web Audio
                                    └──► Exporter ──► MP4 / WebM / GIF / PNG / SVG
```

[AGENTS.md](AGENTS.md) documents the XFL format details and decoding gotchas (easing, `.dat` bitmaps, sound codecs, masks, layer parenting). [TODO.md](TODO.md) tracks feature coverage against the JPEXS decompiler.

## License

ISC (see `package.json`).
