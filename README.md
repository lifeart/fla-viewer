# FLA Viewer

[![Deploy to GitHub Pages](https://github.com/lifeart/fla-viewer/actions/workflows/deploy.yml/badge.svg)](https://github.com/lifeart/fla-viewer/actions/workflows/deploy.yml)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-6.x-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![Zero Dependencies](https://img.shields.io/badge/Runtime%20Deps-0-success)](package.json)

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
│  ✓ Motion tweens  │  ✓ Filters         │  ✓ PNG sequence (ZIP) │
│  ✓ Shape tweens   │  ✓ Blend modes     │  ✓ Sprite sheet+JSON  │
│  ✓ Color tweens   │  ✓ Masks           │  ✓ Single frame PNG   │
│  ✓ Rotation tweens│  ✓ Text (Google)   │  ✓ SVG vector export  │
│  ✓ Audio (MP3)    │  ✓ 9-slice scaling │  ✓ WebCodecs API      │
│  ✓ Bitmap (.dat)  │  ✓ 3D transforms   │                       │
│  ✓ Orient to path │  ✓ Gradient strokes│                       │
└───────────────────┴────────────────────┴───────────────────────┘
```

### Core

| | Feature | Details |
|:-:|---------|---------|
| 📦 | **FLA Parsing** | Native Adobe XFL format (ZIP + XML) |
| 🎬 | **Timeline** | Play, pause, scrub, frame-by-frame |
| 🔷 | **Shapes** | Fills, strokes, gradients, bitmap patterns, gradient strokes |
| 🎭 | **Symbols** | Graphic, MovieClip, Button with nesting, 3D transforms |
| ✨ | **Tweens** | Motion (easing), shape morphing, orient to path |
| 🎨 | **Effects** | Blur, glow, drop shadow, blend modes, masks |
| 🖼️ | **Bitmaps** | PNG, JPG, GIF + Adobe `.dat` with recovery |
| 🔤 | **Text** | Static/dynamic, word wrap, Google Fonts, kerning |
| 🔊 | **Audio** | Stream sync with volume control |
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
├── video-exporter.ts  # MP4/PNG export (WebCodecs)
├── sample-generator.ts # Built-in sample FLA
├── shape-utils.ts     # Shape fixing & path utilities
└── types.ts           # TypeScript types
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
| ActionScript | ✗ |

---

## Limitations

- No ActionScript execution
- Video elements show placeholder only
- Fonts fall back to system/Google Fonts
- Some filter options not fully supported

---

## Tech Stack

- **TypeScript** — type safety
- **Vite** — fast builds
- **Canvas 2D** — rendering
- **WebCodecs** — video encoding
- **Web Audio** — audio playback
- **JSZip** — archive extraction
- **Pako** — deflate decompression

---

## Contributing

```bash
git clone https://github.com/lifeart/fla-viewer.git
cd fla-viewer
npm install
npm test        # run tests
npm run dev     # start dev server
```

---

## License

[ISC](LICENSE) © lifeart
