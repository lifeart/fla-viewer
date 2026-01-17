# FLA Viewer - Code Review TODO

**Review Date:** January 2026
**Commit:** 7cf5e3e (master)
**Rating:** 8/10

---

## Summary

Professional-level codebase with clean architecture, comprehensive type safety, and excellent Flash rendering implementation. Minor improvements needed for user feedback and privacy options.

---

## TODO List

### Medium Priority

- [ ] **Error Collection & UI Feedback**
  - Location: `fla-parser.ts:381-383`
  - Problem: Parsing errors only logged to console, users see blank symbols without explanation
  - Task: Collect errors during parsing and expose via `FLADocument.errors` or callback
  - Display non-intrusive notification when symbols/bitmaps fail to load

- [ ] **Optional Font Bundling (Privacy)**
  - Location: `renderer.ts` (font loading)
  - Problem: Google Fonts loaded externally, privacy concern for some users
  - Task: Add option to bundle common fonts or disable external loading
  - Consider: Subset fonts to reduce bundle size

### Low Priority

- [ ] **Debug Mode Depth Warning**
  - Location: `renderer.ts:939`
  - Current: `if (depth > 50) return;` silently stops rendering
  - Task: Add `console.warn()` in debug mode when depth limit reached
  - Helps troubleshoot deeply nested symbols

- [ ] **Export Quality Presets**
  - Location: `video-exporter.ts:103-108`
  - Current: Hard-coded 5Mbps H.264
  - Task: Add UI presets (High/Medium/Low) for bitrate selection
  - Optional: Custom bitrate input

- [ ] **Enhanced Loading Progress**
  - Location: `main.ts` (loading UI)
  - Current: Shows stage name only
  - Task: Show specific asset names being loaded (e.g., "Loading symbol: character_walk")

### Future Enhancements (Backlog)

- [ ] **WebGL Renderer**
  - For performance-critical animations with thousands of shapes
  - Would require significant rewrite of rendering pipeline

- [ ] **Web Worker Parsing**
  - Move FLA parsing to background thread
  - Benefit: UI remains responsive during large file parsing

- [ ] **Offline Font Pack**
  - Bundle subset of common fonts for offline/privacy use
  - Trade-off: Increased bundle size

- [ ] **Configurable 3D Perspective**
  - Location: `renderer.ts:3186`
  - Current: Fixed `perspectiveDistance = 1000`
  - Task: Make configurable for edge cases

---

## Completed / Not Needed

### Issues Validated as Non-Issues

- [x] ~~Animation Timing Drift~~ - Code correctly implements drift correction
- [x] ~~Memory Pressure in Export~~ - `VideoFrame.close()` properly called
- [x] ~~XML Parsing Security~~ - Browser DOMParser is safe by default
- [x] ~~Complex Tokenizer~~ - Working, tested code; complexity inherent to XFL format
- [x] ~~Magic Numbers~~ - EPSILON=0.5 and MAX_COORD=200000 are well-chosen
- [x] ~~UI State Management~~ - Current approach appropriate for app size
- [x] ~~Hard-coded Codec~~ - 5Mbps H.264 is excellent default

### Already Well Implemented

- [x] Shape rendering pipeline (edge-fill model)
- [x] Edge contribution sorting
- [x] Gradient support (linear, radial, focal point, spread modes)
- [x] Efficient caching (WeakMap, symbol bitmap cache)
- [x] ZIP repair for corrupted FLA files
- [x] Bitmap recovery strategies
- [x] Async yielding for UI responsiveness
- [x] Frame timing with drift correction
- [x] Lazy module loading for export
- [x] Progressive encoding with cancellation
- [x] Proper VideoFrame memory management
- [x] Keyboard shortcuts
- [x] Debounced resize handler
- [x] Progressive loading UI
- [x] Input validation and security

---

## Code Quality Metrics

| Metric | Status |
|--------|--------|
| TypeScript Strict Mode | :white_check_mark: |
| Test Coverage | :white_check_mark: 10 test files |
| Documentation | :white_check_mark: Good |
| Error Handling | :warning: Needs UI feedback |
| Code Duplication | :white_check_mark: Low |
| Security | :white_check_mark: Well implemented |

---

## Architecture Reference

```
src/
├── main.ts            # UI & controls
├── fla-parser.ts      # ZIP/XML parsing + bitmap recovery
├── renderer.ts        # Canvas 2D rendering
├── player.ts          # Timeline & audio sync
├── video-exporter.ts  # Export (MP4/WebM/GIF/PNG)
├── edge-decoder.ts    # XFL edge path decoder
├── adpcm-decoder.ts   # ADPCM audio decoder
├── flv-parser.ts      # FLV video parsing
├── shape-utils.ts     # Path utilities
├── path-utils.ts      # File path normalization
└── types.ts           # TypeScript types
```

---

*Review by CGI & Coding Expert, validated by Product Context Expert*
