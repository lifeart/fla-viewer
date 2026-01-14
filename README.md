# FLA Viewer

[![Deploy to GitHub Pages](https://github.com/lifeart/fla-viewer/actions/workflows/deploy.yml/badge.svg)](https://github.com/lifeart/fla-viewer/actions/workflows/deploy.yml)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-6.x-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![Zero Dependencies](https://img.shields.io/badge/Runtime%20Deps-0-success)](package.json)

> **Bring your Flash animations back to life — no plugins, no installs, just the browser.**

A modern, lightweight web viewer for Adobe Animate/Flash Professional `.fla` files. Drop in your FLA and watch it play instantly in any modern browser.

<p align="center">
  <strong><a href="https://lifeart.github.io/fla-viewer/">Try the Live Demo</a></strong>
</p>

---

## Why FLA Viewer?

- **Flash is dead. Your animations aren't.** — Revive legacy FLA files without Adobe software
- **Zero plugins** — Pure JavaScript, runs in any modern browser
- **Privacy first** — Files never leave your device, everything runs client-side
- **Export to MP4** — Convert your animations to shareable video files with audio
- **Lightweight** — Under 100KB gzipped, loads instantly

---

## Features

| Feature | Description |
|---------|-------------|
| **FLA/XFL Parsing** | Reads native Adobe Animate format (ZIP archives with XML) |
| **Timeline Playback** | Play, pause, scrub, frame-by-frame navigation |
| **Vector Shapes** | Solid fills, linear/radial gradients, bitmap fills, strokes with caps/joins |
| **Symbols** | Graphic, MovieClip, and Button symbols with unlimited nesting |
| **Motion Tweens** | Smooth interpolated animations with easing functions |
| **Shape Tweens** | Morph shape interpolation between keyframes |
| **Filters** | Blur, glow, and drop shadow effects |
| **Masks** | Layer masking with clip paths |
| **Color Effects** | Alpha, brightness, tint, and color transforms |
| **Blend Modes** | Multiply, screen, overlay, add, difference, and more |
| **Bitmaps** | Full image rendering from embedded PNGs, JPGs, GIFs, and Adobe `.dat` format with corruption recovery |
| **Text Rendering** | Static/dynamic text with word wrap, alignment, Google Fonts |
| **Audio Playback** | Stream sounds synced to timeline with volume control |
| **Camera Support** | Auto-detected camera layers with follow mode |
| **Video Export** | Export to MP4 with WebCodecs (H.264 + AAC audio) |
| **Debug Mode** | Inspect layers, elements, nested symbols with hide/show controls |

---

## Quick Start

### Online (Recommended)

**[Open FLA Viewer](https://lifeart.github.io/fla-viewer/)** and drop any `.fla` file onto the page.

### Local Development

```bash
git clone https://github.com/lifeart/fla-viewer.git
cd fla-viewer
npm install
npm run dev
```

Open `http://localhost:3000` — that's it!

### Production Build

```bash
npm run build    # Output in dist/
npm run preview  # Preview production build
```

---

## Keyboard Shortcuts

| Key | Action |
|:---:|--------|
| `Space` | Play / Pause |
| `←` `→` | Previous / Next frame |
| `Home` | Jump to first frame |
| `End` | Jump to last frame |
| `D` | Toggle debug panel |
| `M` | Mute / Unmute audio |
| `F` | Toggle fullscreen |

---

## Video Export

FLA Viewer can export your animations as MP4 video files with full audio support:

1. Open your FLA file
2. Click the **Download** button
3. Wait for encoding to complete
4. Your MP4 is ready to share!

**Technical details:**
- Video: H.264 (AVC) @ 5 Mbps
- Audio: AAC-LC @ 128 kbps
- Uses modern WebCodecs API for fast, efficient encoding
- Works in Chrome, Edge, and other Chromium browsers

---

## Debug Mode

Press `D` or click the bug icon to open the debug panel. Features include:

| Feature | Description |
|---------|-------------|
| **Layer List** | View all layers with visibility toggles |
| **Element Inspector** | See elements in each layer with type badges (symbol, shape, bitmap, text, video) |
| **Nested Symbols** | Expand symbols to view their internal layers and elements (up to 3 levels deep) |
| **Hide/Show Elements** | Toggle visibility of individual elements for debugging |
| **Frame Sync** | Panel updates automatically when scrubbing the timeline |
| **Click Inspection** | Click on canvas to inspect element details in console |
| **Render Order** | Configure layer, nested layer, and element render order |
| **Camera Follow** | Enable camera layer tracking for viewport animations |

**Element Types:**
- **Symbol** (green) — Nested graphic, movieclip, or button instances
- **Shape** (blue) — Vector shapes with fills and strokes
- **Bitmap** (orange) — Embedded images
- **Text** (purple) — Static or dynamic text fields
- **Video** (red) — Video placeholders

---

## Browser Support

| Browser | Support | Notes |
|---------|:-------:|-------|
| Chrome 94+ | Full | All features including video export |
| Edge 94+ | Full | All features including video export |
| Firefox | Partial | Playback only (no video export) |
| Safari 16.4+ | Partial | Playback only (limited WebCodecs) |

---

## Embedding

Embed FLA Viewer in your website. Add `?embed=true` for a cleaner interface.

### Basic Embed

```html
<iframe
  src="https://lifeart.github.io/fla-viewer/?embed=true"
  width="800"
  height="600"
  frameborder="0"
  allowfullscreen>
</iframe>
```

### Responsive Embed

```html
<div style="position: relative; width: 100%; padding-bottom: 56.25%; overflow: hidden;">
  <iframe
    src="https://lifeart.github.io/fla-viewer/?embed=true"
    style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: 0;"
    allowfullscreen>
  </iframe>
</div>
```

### Self-Hosted

```bash
npm run build
# Deploy dist/ folder to your server
```

```html
<iframe src="https://your-domain.com/fla-viewer/?embed=true" ...></iframe>
```

---

## Supported Elements

| Element | Status | Notes |
|---------|:------:|-------|
| DOMSymbolInstance | :white_check_mark: | Graphic, MovieClip, Button |
| DOMShape | :white_check_mark: | Fills, strokes, transforms |
| DOMGroup | :white_check_mark: | Nested groups |
| DOMBitmapInstance | :white_check_mark: | PNG, JPG, GIF |
| DOMStaticText | :white_check_mark: | Word wrap, alignment |
| DOMDynamicText | :white_check_mark: | Same as static |
| DOMSoundItem | :white_check_mark: | Stream sync |
| Motion Tweens | :white_check_mark: | Linear + eased |
| Shape Tweens | :white_check_mark: | MorphShape interpolation |
| Filters | :white_check_mark: | Blur, glow, drop shadow |
| Masks | :white_check_mark: | Layer clip paths |
| Color Effects | :white_check_mark: | Alpha, tint, brightness |
| Blend Modes | :white_check_mark: | Multiply, screen, overlay, etc. |
| Camera Layer | :white_check_mark: | Auto-detect + follow |
| DOMVideoInstance | :white_check_mark: | Placeholder with metadata (name, resolution, fps, duration) |
| Bitmap Fills | :white_check_mark: | Shape fills with bitmap patterns |
| ActionScript | :x: | Not supported |

---

## Architecture

```
src/
├── main.ts            # Application entry & UI controls
├── fla-parser.ts      # ZIP extraction & XML parsing
├── edge-decoder.ts    # XFL edge path decoder
├── renderer.ts        # Canvas 2D rendering engine
├── player.ts          # Timeline playback controller
├── video-exporter.ts  # WebCodecs MP4 export
└── types.ts           # TypeScript interfaces
```

### How It Works

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   FLA File  │───>│  FLAParser  │───>│ FLADocument │
│   (ZIP)     │    │  (Extract)  │    │   (Data)    │
└─────────────┘    └─────────────┘    └──────┬──────┘
                                             │
                   ┌─────────────┐    ┌──────▼──────┐
                   │   Canvas    │<───│ FLARenderer │
                   │  (Display)  │    │   (Draw)    │
                   └─────────────┘    └──────┬──────┘
                                             │
                   ┌─────────────┐    ┌──────▼──────┐
                   │   Audio     │<───│  FLAPlayer  │
                   │  (WebAudio) │    │  (Control)  │
                   └─────────────┘    └─────────────┘
```

1. **FLAParser** extracts the ZIP and parses XML into a document structure
2. **FLARenderer** draws each frame to an HTML5 Canvas using the 2D API
3. **FLAPlayer** orchestrates playback timing and audio sync

---

## FLA/XFL Format

FLA files are ZIP archives containing:

```
document.fla (ZIP)
├── DOMDocument.xml      # Main document (stage, timelines)
├── LIBRARY/             # Symbol definitions (.xml)
│   ├── Symbol_1.xml
│   └── ...
└── bin/                 # Binary assets
    ├── image.png        # Standard image formats
    ├── M 1 123456.dat   # Adobe bitmap format (deflate-compressed ARGB)
    └── audio.mp3
```

See [AGENTS.md](./AGENTS.md) for detailed format documentation.

---

## Bitmap Recovery

FLA Viewer includes advanced recovery capabilities for corrupted or partially damaged bitmap data, which is common in older or recovered FLA files.

### Adobe `.dat` Bitmap Format

Adobe Animate stores bitmaps in a proprietary `.dat` format in the `bin/` folder:
- 28-32 byte header with dimensions and format flags
- Deflate-compressed ARGB pixel data
- Some files reference preset dictionaries or have mid-stream corruption

### Recovery Strategies

The parser attempts multiple decompression methods in order:

| Strategy | Description | Typical Recovery |
|----------|-------------|------------------|
| Raw Deflate | Standard decompression | 100% (well-formed files) |
| Dictionary | Zero-filled 32KB preset dictionary | 100% (dictionary-dependent files) |
| Streaming | Captures partial data via chunk callbacks | 60-90% |
| Streaming+Dict | Dictionary with streaming for mid-stream errors | 60-90% |
| Multi-Segment | Extracts stored blocks + scans for valid segments | 20-50% (severely corrupted) |

### Multi-Segment Recovery

For severely corrupted files (<50% recovery), the parser:
1. Extracts uncompressed "stored blocks" directly from the deflate stream
2. Scans for valid deflate block starts after corruption points
3. Combines all recovered segments to maximize data recovery

This allows partial image display even when source files are damaged.

---

## Performance

- **Instant parsing** — Streams ZIP extraction for fast load times
- **60fps rendering** — Optimized Canvas 2D with minimal allocations
- **Lazy loading** — Video export library loaded only when needed
- **Memory efficient** — Bitmap caching and resource cleanup

---

## Known Limitations

- Video elements show placeholder only (no FLV/H.263 playback)
- No ActionScript execution
- Fonts fall back to system fonts if not available in Google Fonts
- Filter `knockout` and `inner` options are not fully supported

---

## Tech Stack

- **TypeScript** — Type-safe development
- **Vite** — Lightning-fast builds
- **Canvas 2D** — Hardware-accelerated rendering
- **WebCodecs** — Native video encoding
- **Web Audio API** — Low-latency audio playback
- **Zero runtime dependencies** — Just the browser APIs

---

## Contributing

Contributions welcome! Whether it's bug fixes, new features, or documentation improvements.

```bash
git clone https://github.com/lifeart/fla-viewer.git
cd fla-viewer
npm install
npm run dev
```

---

## License

[ISC](LICENSE) © lifeart

---

<p align="center">
  <sub>Built with TypeScript and modern web APIs. No Flash Player harmed.</sub>
</p>
