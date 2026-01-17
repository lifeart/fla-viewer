# FLA Viewer

[![Deploy to GitHub Pages](https://github.com/lifeart/fla-viewer/actions/workflows/deploy.yml/badge.svg)](https://github.com/lifeart/fla-viewer/actions/workflows/deploy.yml)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-7.x-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![Vitest](https://img.shields.io/badge/Tested%20with-Vitest-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev/)

A browser-based viewer for Adobe Animate/Flash `.fla` files. No plugins, no installs — just drag and drop.

<p align="center">
  <strong><a href="https://lifeart.github.io/fla-viewer/">▶ Live Demo</a></strong>
</p>

---

## What is this?

**FLA files** are the source/project files created by Adobe Flash Professional (now Adobe Animate). Unlike compiled `.swf` files, FLA contains the raw assets: vector shapes, timelines, symbols, bitmaps, and audio — everything needed to edit an animation.

**The problem:** Flash Player is dead (EOL 2020), and Adobe Animate costs $23/month. If you have old FLA files from the 2000s-2010s, you can't easily view them anymore.

**This tool** parses FLA files directly in the browser and renders them using HTML5 Canvas. No Flash Player, no Adobe subscription, no uploads to servers — everything runs locally in your browser.

### Use cases

- **Archivists** — Preview legacy Flash animations without Adobe software
- **Developers** — Inspect FLA structure, extract assets, debug timeline issues
- **Designers** — Quick preview without launching Animate
- **Studios** — Convert old animations to MP4 for modern platforms
- **Educators** — Demonstrate Flash-era animation techniques

---

## Features

```
┌─────────────────────────────────────────────────────────────────┐
│  PARSING          │  RENDERING         │  EXPORT               │
├───────────────────┼────────────────────┼───────────────────────┤
│  ✓ FLA/XFL files  │  ✓ Vector shapes   │  ✓ MP4 video (H.264)  │
│  ✓ Symbols        │  ✓ Gradients       │  ✓ WebM video (VP9)   │
│  ✓ Timelines      │  ✓ Bitmap fills    │  ✓ Animated GIF       │
│  ✓ Multiple scenes│  ✓ Filters         │  ✓ PNG sequence (ZIP) │
│  ✓ Motion tweens  │  ✓ Blend modes     │  ✓ Sprite sheet+JSON  │
│  ✓ Shape tweens   │  ✓ Masks           │  ✓ Single frame PNG   │
│  ✓ Color tweens   │  ✓ Text (Google)   │  ✓ SVG vector export  │
│  ✓ Rotation tweens│  ✓ 9-slice scaling │  ✓ WebCodecs API      │
│  ✓ Audio (MP3)    │  ✓ 3D transforms   │                       │
│  ✓ Audio (ADPCM)  │                    │                       │
│  ✓ Bitmap (.dat)  │  ✓ Gradient strokes│                       │
│  ✓ Orient to path │                    │                       │
└───────────────────┴────────────────────┴───────────────────────┘
```

### Core

| | Feature | Details |
|:-:|---------|---------|
| 📦 | **FLA Parsing** | Native Adobe XFL format (ZIP + XML) |
| 🎬 | **Timeline** | Play, pause, scrub, frame-by-frame, multi-scene |
| 🔷 | **Shapes** | Fills, strokes, gradients, bitmap patterns, gradient strokes |
| 🎭 | **Symbols** | Graphic, MovieClip, Button with nesting, 3D transforms |
| ✨ | **Tweens** | Motion (easing), shape morphing, orient to path |
| 🎨 | **Effects** | Blur, glow, drop shadow, blend modes, masks |
| 🖼️ | **Bitmaps** | PNG, JPG, GIF + Adobe `.dat` with recovery |
| 🔤 | **Text** | Static/dynamic, word wrap, Google Fonts, kerning |
| 🔊 | **Audio** | MP3, ADPCM, PCM (8/16/24/32-bit), stream sync with volume control |
| 📹 | **Export** | MP4, PNG sequence, sprite sheet, single frame |
| 🎥 | **Camera** | Auto-detected camera layers with follow mode |

### UX

| | Feature | Details |
|:-:|---------|---------|
| 📊 | **Progress Stages** | Visual progress bar: Extract → Symbols → Images → Audio → Timeline |
| ⏭️ | **Skip Recovery** | Skip slow image recovery with one click |
| 🔍 | **Algorithm Display** | Shows current recovery method: `deflate` → `dictionary` → `streaming` → `multi-segment` |
| 🐱 | **Sample File** | Built-in animated sample to test without uploading |
| 🔧 | **Debug Panel** | Inspect layers, elements, toggle visibility |
| ⌨️ | **Keyboard Controls** | Space, arrows, D, M, F shortcuts |

---

## Quick Start

### Online

**[lifeart.github.io/fla-viewer](https://lifeart.github.io/fla-viewer/)** — drop a file or click **Sample**

### Local

```bash
git clone https://github.com/lifeart/fla-viewer.git
cd fla-viewer
npm install
npm run dev     # → localhost:3000
```

---

## Keyboard Shortcuts

| Key | Action |
|:---:|--------|
| `Space` | Play / Pause |
| `←` `→` | Previous / Next frame |
| `Home` `End` | First / Last frame |
| `PgUp` `PgDn` | Previous / Next scene |
| `D` | Debug panel |
| `M` | Mute |
| `F` | Fullscreen |

---

## Export Options

Click the **Download** button to open export options:

| Format | Output | Description |
|--------|--------|-------------|
| **MP4 Video** | `.mp4` | H.264 video with AAC audio |
| **WebM Video** | `.webm` | VP9 video with Opus audio |
| **Animated GIF** | `.gif` | Animated image (no audio) |
| **PNG Sequence** | `.zip` | All frames as numbered PNGs |
| **Current Frame (PNG)** | `.png` | Single frame raster snapshot |
| **Current Frame (SVG)** | `.svg` | Single frame vector format |
| **Sprite Sheet** | `.png` + `.json` | Texture atlas for game engines |

### Video Export Specs
- **Video:** H.264 @ 5 Mbps
- **Audio:** AAC @ 128 kbps
- **Requires:** Chrome/Edge 94+ (WebCodecs API)

---

## Bitmap Recovery

Adobe `.dat` files use chunked deflate-compressed ABGR pixel data. Some files are corrupted or use preset dictionaries.

| Strategy | Recovery | Speed |
|----------|:--------:|:-----:|
| Raw Deflate | 100% | ⚡ |
| Dictionary | 100% | ⚡ |
| Streaming | 60-90% | 🐢 |
| Stream+Dict | 60-90% | 🐢 |
| Multi-Segment | 20-50% | 🐌 |

Progress shows current algorithm: `Fixing images 3/10 [streaming]`

Click **Skip images fix** to bypass slow recovery.

---

## Debug Mode

Press `D` to open. Features:

- Layer list with visibility toggles
- Element inspector (symbol, shape, bitmap, text, video)
- Nested symbol expansion (3 levels)
- Click-to-inspect on canvas
- Render order controls
- Camera follow toggle
- Edge debug logging (console output)
- Experimental edge parsing options:
  - Implicit MoveTo after close path
  - Edge splitting on style changes

---

## Browser Support

| Browser | Playback | Export |
|---------|:--------:|:------:|
| Chrome 94+ | ✓ | ✓ |
| Edge 94+ | ✓ | ✓ |
| Firefox | ✓ | ✗ |
| Safari 16.4+ | ✓ | ✗ |

---

## Embedding

```html
<iframe
  src="https://lifeart.github.io/fla-viewer/?embed=true"
  width="800" height="600"
  frameborder="0" allowfullscreen>
</iframe>
```

---

## Architecture

```
src/
├── main.ts            # UI & controls
├── fla-parser.ts      # ZIP/XML parsing + bitmap recovery
├── edge-decoder.ts    # XFL edge path decoder
├── renderer.ts        # Canvas 2D rendering + 9-slice scaling
├── player.ts          # Timeline & audio sync
├── video-exporter.ts  # MP4/WebM/GIF/PNG export (WebCodecs)
├── adpcm-decoder.ts   # SWF ADPCM audio decoder
├── flv-parser.ts      # FLV video container parsing
├── sample-generator.ts # Built-in sample FLA
├── shape-utils.ts     # Shape fixing & path utilities
├── path-utils.ts      # File path normalization
├── types.ts           # TypeScript types
└── __tests__/         # Test suite (10 test files)
```

```
FLA (ZIP) → Parser → Document → Renderer → Canvas
                         ↓
                      Player → Audio (WebAudio)
                         ↓
                      Exporter → MP4 / PNG / ZIP
```

---

## Supported Elements

| Element | Status |
|---------|:------:|
| DOMSymbolInstance | ✓ |
| DOMShape | ✓ |
| DOMGroup | ✓ |
| DOMBitmapInstance | ✓ |
| DOMStaticText | ✓ |
| DOMDynamicText | ✓ |
| DOMSoundItem | ✓ |
| Motion Tweens | ✓ |
| Shape Tweens | ✓ |
| Color Transform Tweens | ✓ |
| Rotation Tweens (CW/CCW) | ✓ |
| Orient to Path | ✓ |
| Filters | ✓ |
| Masks | ✓ |
| Color Effects | ✓ |
| Blend Modes | ✓ |
| Camera Layer | ✓ |
| Bitmap Fills | ✓ |
| Gradient/Bitmap Strokes | ✓ |
| 9-Slice Scaling | ✓ |
| 3D Transforms | ✓ |
| Cache as Bitmap | ✓ |
| Text Kerning | ✓ |
| Text Rotation | ✓ |
| Frame Labels | ✓ |
| Multiple Scenes | ✓ |
| FLV Video Parsing | ✓ |
| Video Playback | ✗ |
| ActionScript | ✗ |

---

## Limitations

- No ActionScript execution (no interactivity)
- Embedded video shows metadata only (FLV parsing supported, playback not implemented)
- Fonts fall back to Google Fonts (external request) or system fonts
- Some advanced filter options not fully supported
- 3D transforms use simplified perspective projection

---

## Tech Stack

| Category | Technology |
|----------|------------|
| **Language** | TypeScript 5.x (strict mode) |
| **Build** | Vite 7.x |
| **Testing** | Vitest + Playwright |
| **Rendering** | Canvas 2D API |
| **Video Export** | WebCodecs API, mp4-muxer, webm-muxer, gifenc |
| **Audio** | Web Audio API |
| **Parsing** | JSZip, Pako (deflate) |

---

## Development

```bash
git clone https://github.com/lifeart/fla-viewer.git
cd fla-viewer
npm install
npm run dev           # start dev server → localhost:3000
npm test              # run tests
npm run test:watch    # run tests in watch mode
npm run test:coverage # run tests with coverage report
npm run build         # production build
```

### Testing

The project includes comprehensive tests using Vitest with Playwright browser testing:

| Test File | Coverage |
|-----------|----------|
| `fla-parser.test.ts` | ZIP parsing, bitmap recovery, symbol loading |
| `renderer.test.ts` | Shape rendering, tweens, filters, 9-slice |
| `player.test.ts` | Timeline, scenes, audio sync |
| `edge-decoder.test.ts` | XFL edge format parsing |
| `video-exporter.test.ts` | MP4/WebM/GIF export |
| `shape-utils.test.ts` | Path winding, shape repair |
| `adpcm-decoder.test.ts` | ADPCM audio decoding |
| `flv-parser.test.ts` | FLV container parsing |
| `path-utils.test.ts` | Path normalization |
| `main.test.ts` | UI integration |

---

## License

[ISC](LICENSE) © lifeart
