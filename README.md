# FLA Viewer

[![Deploy to GitHub Pages](https://github.com/lifeart/fla-viewer/actions/workflows/deploy.yml/badge.svg)](https://github.com/lifeart/fla-viewer/actions/workflows/deploy.yml)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

A modern web-based viewer and player for Adobe Animate/Flash Professional FLA files. No plugins required — runs entirely in the browser.

**[Live Demo](https://lifeart.github.io/fla-viewer/)**

---

## Features

| Feature | Description |
|---------|-------------|
| **FLA Parsing** | Reads FLA/XFL format (ZIP archives with XML) |
| **Timeline Playback** | Play, pause, scrub, and frame-by-frame navigation |
| **Vector Shapes** | Solid fills, linear/radial gradients, strokes |
| **Symbols** | Graphic, MovieClip, and Button symbols with nesting |
| **Motion Tweens** | Interpolated animations with easing support |
| **Bitmaps** | Full image rendering from embedded PNGs/JPGs |
| **Text** | Static/dynamic text with word wrap and Google Fonts |
| **Audio** | Stream sound synced to timeline with volume control |
| **Camera** | Auto-detected camera layers with follow mode |

---

## Quick Start

### Try Online

Visit the **[Live Demo](https://lifeart.github.io/fla-viewer/)** and drag & drop any `.fla` file.

### Run Locally

```bash
# Clone the repository
git clone https://github.com/lifeart/fla-viewer.git
cd fla-viewer

# Install dependencies
npm install

# Start development server
npm run dev
```

Open `http://localhost:3000` in your browser.

### Build for Production

```bash
npm run build
```

Output files will be in the `dist/` folder.

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `←` | Previous frame |
| `→` | Next frame |
| `Home` | Go to first frame |
| `End` | Go to last frame |
| `D` | Toggle debug panel |
| `M` | Mute / Unmute |
| `F` | Toggle fullscreen |

---

## Embedding

FLA Viewer can be embedded in your website using an iframe. Add `?embed=true` to enable embed mode, which hides the header for a cleaner look.

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
<div style="position: relative; width: 100%; padding-bottom: 56.25%; height: 0; overflow: hidden;">
  <iframe
    src="https://lifeart.github.io/fla-viewer/?embed=true"
    style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: 0;"
    allowfullscreen>
  </iframe>
</div>
```

### Self-Hosted Embed

To host your own instance:

1. Build the project: `npm run build`
2. Deploy the `dist/` folder to your server
3. Use your own URL in the iframe

```html
<iframe
  src="https://your-domain.com/fla-viewer/?embed=true"
  width="800"
  height="600"
  frameborder="0"
  allowfullscreen>
</iframe>
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
| Camera Layer | :white_check_mark: | Auto-detect + follow |
| DOMVideoInstance | :warning: | Placeholder only |
| Shape Tweens | :x: | Not supported |
| Masks | :x: | Not supported |
| Filters | :x: | Not supported |
| ActionScript | :x: | Not supported |

---

## Architecture

```
src/
├── main.ts          # Application entry & UI
├── fla-parser.ts    # ZIP extraction & XML parsing
├── edge-decoder.ts  # XFL edge path decoder
├── renderer.ts      # Canvas 2D rendering
├── player.ts        # Timeline playback
└── types.ts         # TypeScript interfaces
```

### How It Works

1. **FLAParser** extracts the ZIP archive and parses XML documents
2. **FLARenderer** draws frames to an HTML5 Canvas
3. **FLAPlayer** controls playback timing with `requestAnimationFrame`

---

## FLA/XFL Format

FLA files are ZIP archives containing:

```
├── DOMDocument.xml    # Main document structure
├── LIBRARY/           # Symbol definitions (.xml)
└── bin/               # Binary assets (images, audio)
```

See [AGENTS.md](./AGENTS.md) for detailed format documentation.

---

## Known Limitations

- Video elements show placeholder only (no FLV playback)
- Gradients have basic support
- No bitmap fills in shapes
- No mask layers
- No filters (drop shadow, blur, glow, etc.)
- No ActionScript execution
- Fonts fall back to system fonts if not in Google Fonts

---

## Contributing

Contributions are welcome! Feel free to open issues or submit pull requests.

---

## License

[ISC](LICENSE) © lifeart
