# FLA Viewer

A web-based viewer and player for Adobe Animate/Flash Professional FLA files.

## Features

- **FLA File Parsing**: Reads FLA/XFL format files (ZIP archives containing XML)
- **Timeline Playback**: Play, pause, and scrub through animations
- **Shape Rendering**: Solid fills, gradients (basic), strokes, and vector shapes
- **Edge Path Processing**: Advanced edge connection with gap tolerance, segment splitting, and chain sorting
- **Symbol Support**: Graphic symbols with nested timelines
- **Motion Tweens**: Interpolated animations with easing
- **Group Support**: Nested shape groups (DOMGroup)
- **Video Placeholders**: DOMVideoInstance elements rendered as placeholders
- **Bitmap Support**: Full bitmap rendering with automatic image extraction from FLA
- **Text Rendering**: Static/dynamic text with word wrapping, alignment, and Google Fonts support
- **Audio Support**: Stream sound playback synced to timeline with seek support
- **Camera Support**: Simulated camera pan/zoom via viewport layer detection with follow mode
- **Reference Layer Detection**: Automatic detection and filtering of guide/folder/camera layers

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

Opens the development server at `http://localhost:5173`

### Build

```bash
npm run build
```

Outputs production files to `dist/`

## Usage

1. Open the application in a browser
2. Click "Choose File" or drag and drop a `.fla` file
3. Use the playback controls to navigate the timeline:
   - Play/Pause button
   - Frame slider
   - Frame counter display

## Supported FLA Elements

| Element | Status | Notes |
|---------|--------|-------|
| DOMSymbolInstance | Supported | Graphic, MovieClip, Button types |
| DOMShape | Supported | Fills, edges, transforms |
| DOMGroup | Supported | Nested groups and shapes |
| DOMBitmapInstance | Supported | Full image rendering from embedded PNGs/JPGs |
| DOMVideoInstance | Partial | Placeholder rendering |
| Camera Layer | Supported | Auto-detected + follow camera mode |
| Motion Tweens | Supported | Linear and eased interpolation |
| DOMStaticText | Supported | Word wrap, alignment, Google Fonts |
| DOMDynamicText | Supported | Same as static text |
| DOMSoundItem | Supported | Stream sync with timeline |
| Shape Tweens | Not supported | - |
| Masks | Not supported | - |
| Filters | Not supported | - |

## Architecture

```
src/
├── main.ts          # Application entry point and UI
├── fla-parser.ts    # ZIP extraction and XML parsing
├── edge-decoder.ts  # XFL edge path format decoder
├── renderer.ts      # Canvas 2D rendering engine
├── player.ts        # Timeline playback controller
└── types.ts         # TypeScript interfaces
```

### Key Components

- **FLAParser**: Extracts and parses FLA files, loads symbols from LIBRARY folder
- **FLARenderer**: Renders frames to HTML5 Canvas using 2D context
- **FLAPlayer**: Controls timeline playback with requestAnimationFrame

## FLA/XFL Format

FLA files are ZIP archives containing:
- `DOMDocument.xml` - Main document with timelines
- `LIBRARY/*.xml` - Symbol definitions
- `bin/` - Binary data (bitmaps, video)

See [AGENTS.md](./AGENTS.md) for detailed format documentation.

## Known Limitations

- Video elements show placeholder only (no FLV playback)
- Radial/linear gradients render with basic support
- No bitmap fills in shapes (solid bitmaps work)
- No mask layers
- No filters (drop shadow, blur, glow, etc.)
- No ActionScript support
- Font support limited to Google Fonts mappings (falls back to sans-serif)

## License

ISC
