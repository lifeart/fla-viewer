# TVG Renderer Accuracy Workstream

This document is the compact handoff for improving the JavaScript TVG parser and renderer toward thumbnail fidelity. Use it instead of replaying the full conversation history.

## Objective

Render Toon Boom TVG files in `src/tvg-parser.ts` as close as possible to the embedded `.thumbnails/*.tvg.png` previews, with a long-term target of raw 100% visual equality where the thumbnail is source-fresh.

The benchmark gate is intentionally tolerance-aware and alignment-aware. Raw score remains the diagnostic target, but code changes should be format-level renderer improvements, not benchmark hacks or sample-specific conditionals.

## Current State

- Latest committed renderer work: `5593485 Handle dense TVG same-paint contour details`.
- Main benchmark command: `npm run benchmark:tvg:raw`.
- Current raw benchmark: overall about `98.36`, vector about `98.28`, bitmap about `98.79`.
- Source-fresh raw averages: overall about `98.54`, vector about `98.43`, bitmap about `98.79`.
- Worst source-fresh vector case: `color.101/color-13`.
- Worst case scores after shared legacy nested-fill predicate: raw `83.9140625`, aligned `91.54296875`, normalized/focused about `75.03`, foreground IoU about `83.02`.
- Worst case bounds: reference `{minX:8,minY:17,maxX:149,maxY:142}`, candidate `{minX:9,minY:9,maxX:150,maxY:143}`.
- The app fallback path can score 100 by using embedded thumbnails, but raw vector rendering is the target.

## Known Findings

- `benchmark-tvg.html` should not return to exact pixel equality as the gate. The current scoring path uses `scoreCanvasSources` from `src/tvg-benchmark.ts`, including tolerance, bounded alignment, crop/focus/perceptual/structural/mask/macro signals. Raw equality is diagnostic.
- Metadata/layer parsing is probably not the remaining issue for `color.101/color-13`. Only the `line` layer has non-empty parsed content, with 137 shapes.
- Shape order is probably not the issue. Reordering shape 19/20/21 variants produced effectively zero useful delta.
- Viewport argument is not the controlling factor for `color.101/color-13`; several viewport values produced identical rendered bounds because the renderer expands to content extent plus source padding.
- Post-render scale/shift can improve raw by about 1 point at most, so remaining error is mostly silhouette/topology, not framing.
- Shape 19 causes the top-bound overfill in fixed-transform probes.
- Shape 21 is unresolved legacy topology and affects the lower/face region, but does not cause the top overfill.
- Shape 20 is mostly suppressed by existing seed-carrier logic; enabling/removing it has not explained the mismatch.
- The `.tvg~` backup for `color-13` exists and differs, but renders similarly and does not explain the thumbnail.

## Shape 19 Details

`__debugBuildContoursForShape(line.shapes[19], 'line', 19)` reports:

- 59 fragments.
- 10 resolved contours.
- 0 unresolved chains.
- One large parent contour using components `0..40`.
- Several same-paint child contours using components `41..58`.
- Parent paint: near-black `solid:15,46,48,255`.
- Parent bbox roughly `{minX:-2656,minY:353,maxX:1379,maxY:3266}`.
- Current code treats tiny same-paint children inside dense line carriers as filled details rather than even-odd holes:
  `shouldSubtractNestedContour()` in `src/tvg-parser.ts`.

Rejected experiment:

- Tightening the same-paint detail threshold from child area ratio `<= 0.035` to `<= 0.01` reduced raw score for `color.101/color-13` from `83.6953125` to `83.45703125`.
- That means a blunt smaller area cutoff is not the right improvement.

Managed finding from `Mill`:

- Shape19 child-hole probes confirm nested child classification affects interior topology but does not explain the top-bound overfill; candidate bounds stayed `{minX:9,minY:9,maxX:150,maxY:143}` for all tested child-hole variants.
- Current/all-detail policy after the legacy consistency patch scored raw `83.9141`, aligned `91.5430`, normalized `75.0328`.
- Forcing all shape19 children to holes scored raw `83.4688`, aligned `91.7148`, normalized `75.3938`; this is not a raw-match improvement.
- Child `47` is the only meaningful child-hole candidate: `8` fragments, area ratio about `0.02082`, upper-band bbox, same signed-area direction as parent. Making only child `47` a hole improved aligned/normalized but lowered raw to `83.6758` and did not change bounds.
- Manager decision: do not implement a shape19 child-hole policy now. The next high-leverage target is shape19 parent geometry/component contribution, not nested children.

Managed finding from `Schrodinger`:

- Shape19 parent top overfill comes from the valid closed parent contour as a whole, not a removable child or obvious stale fragment.
- Parent contour uses components `0..40`, has `41` styled fragments, `0` support fragments, `0` unresolved chains, and exact zero endpoint gaps including `40 -> 0`.
- Candidate overfill above the reference top is `277` pixels.
- Removing major connector components eliminates top overfill but destroys the parent fill: raw drops to about `65.8633`, aligned to about `72.8711`, bounds become `{minX:26,minY:25,maxX:150,maxY:143}`.
- Making top components support-only/null-paint/boundary-like keeps bounds and overfill unchanged while dropping raw to about `83.4688`.
- Manager decision: do not implement component pruning, stale-fragment suppression, support-only conversion, or auto-close changes for shape19 parent geometry. This hypothesis does not provide a safe deterministic renderer rule.

Managed finding from `Euclid`:

- No actionable hidden TVG or scene-context field was found for `color.101/color-13`.
- `color-13.tvg`, thumbnail, palettes, and `color-13.tvg~` share the same ZIP timestamp; `scene.xstage` is newer but its targeted `color.101` element block did not expose preview clipping/substitution metadata.
- Current and backup files have substantial data only in `tLAA`; line-layer-only rendering remains the correct assumption.
- Shape19 and shape21 component streams around the target shapes showed parser-visible `TGSD`/`TGBP` records with embedded `TGCO` as expected; no standalone `TGRV`, `TGCO`, `tGTB`, or `tGTI` side field explained hidden state or clipping.
- `.tvg~` differs materially, but not in a way that proves the thumbnail came from the backup.
- Manager decision: do not add source-context rendering behavior or stale-thumbnail classification for this case yet. If revisited, add diagnostics for raw tag inventory and backup/source freshness before changing rendering.

Managed finding from `Peirce`:

- The next source-fresh failures after `color-13` are a different class: `color-1`, `color-31`, `color-3`, `color-19`, and `color-18` have high aligned scores and good masks, with candidate line art too light/thin at edges.
- Scores checked: `color-1` raw `93.1133`, `color-31` raw `94.5078`, `color-3` raw `94.8008`, `color-19` raw `94.9883`, `color-18` raw `95.0664`.
- For exported `color-1`, `color-31`, and `color-3`, reference-only foreground pixels outnumber candidate-only pixels by hundreds, while candidate overlap RGB is about `+48..+56` brighter than reference.
- Supersample `3` or `4` improves raw by roughly `+0.4..+0.85` on these cases, but can hurt aligned/normalized, so globally raising supersample is not a sufficient rule.
- Manager decision: investigate a gated near-black line-layer coverage/downsample correction. Do not apply a global antialias or thickening change.

## Shape 21 Details

`__debugBuildLegacyChainsForShape(line.shapes[21])` reports:

- 85 fill components.
- Mixed green `solid:22,198,133,255` and near-black `solid:15,46,48,255`.
- Explicit contour builder produces no resolved contours, so legacy rendering is active.
- Green group: several closed drawable child chains inside one large parent.
- Near-black group: one closed chain.

Open question:

- Whether same-paint nested legacy chains should use the same hole/detail policy as resolved contours.
- Whether mixed-paint support fragments should help resolve shape 21 into contour topology rather than relying on legacy paint groups.

Managed finding from `Bohr`:

- In-memory patch applying the resolved same-paint small-detail policy to legacy child chains changed `color.101/color-13` raw from `83.6953125` to `83.9140625`.
- The same patch reduced aligned score from `91.77734375` to `91.54296875` and normalized score from about `75.53` to about `75.03`; bounds and IoU were unchanged.
- Topology: shape21 green parent chain has 40 components; small same-paint children by current threshold are chains `2`, `3`, `4`, `6`, and `7`; larger child chains `1` and `5` remain holes.
- Manager decision: implemented as a shared topology predicate used by resolved contour trees and legacy chains, guarded by line-layer dense-parent topology. Targeted parser tests, benchmark tests, build, and raw benchmark pass. This is still not the root-cause fix and should not distract from shape19, which is the top-bound overfill source.

Current verification after this patch:

- `npm test -- src/__tests__/tvg-parser.test.ts`: 81 passed.
- `npm test -- src/__tests__/tvg-benchmark.test.ts`: 17 passed.
- `npm run build`: passed.
- `npm run benchmark:tvg:raw`: gate averages overall/vector/bitmap `100.00/99.99/100.00`; raw averages overall/vector/bitmap `98.44/98.34/98.94`; source-fresh raw average `98.68`; source-fresh raw min `83.91`.

Managed local finding: line-fill source inset

- Reducing the line-fill source inset from `5px` to `4px` globally improved many portrait-ish `color.101` drawings but regressed `color-13` from raw `83.91` to `83.42`.
- A conditional rule keeps the old `5px` inset for near-square line-fill source bounds and uses `4px` for non-square/portrait line-fill drawings.
- Targeted improvements with this conditional: `color-1` raw `93.11 -> 94.77`, `color-31` raw `94.51 -> 96.11`, `color-3` raw `94.80 -> 96.42`, `color-19` raw `94.99 -> 96.93`, `color-18` raw `95.07 -> 96.75`.
- Full raw benchmark with the conditional: source-fresh raw average `98.63`, vector raw average `98.34`, source-fresh raw min remains `83.91`.

Managed local finding: bitmap atlas aspect-band fit

- `4bf5/4bf5-1` is bitmap-only: no vector layers, eight clipped tiles, clip aspect about `1.47`, cell aspect `2.0`, baseline raw `96.98`.
- A fractional `7.5px` fit inset improves `4bf5/4bf5-1` raw to `97.89`, but applying it to all landscape clipped atlases regresses wider bitmap atlases: `3255/3255-1` and `7f81/7f81-1`.
- Accepted narrow rule: use `7.5px` only for non-fallback clipped atlases with at least eight tiles and aspect in `(1.35, 1.6)`. Keep wider clipped atlases on `7px`.
- Recheck cases after the conditional rule: `3255/3255-1` raw `97.07`, `7f81/7f81-1` raw `97.18`, `Drawing_2/Drawing_2-1` raw `97.28`, `color.101/color-13` raw `83.91`, `color.101/color-21` raw `95.39`.

## Scientific Loop

Use this loop for every change:

1. State one hypothesis in measurable terms.
2. Capture the current score for `color.101/color-13`.
3. Run the smallest possible experiment against that case.
4. Compare raw, aligned, bounds, IoU, and visual diff.
5. Keep the change only if it is a format-level rule and does not regress tests.
6. Then run at least targeted unit tests and the raw benchmark before committing.

Do not commit:

- Sample-name hacks.
- Shape-index hacks.
- Pure benchmark metric changes to hide renderer mismatch.
- Global framing/padding changes justified only by `color.101/color-13`.
- Rules that improve raw but clearly damage aligned/normalized topology without explanation.

## Targeted Commands

Use a local preview server if one is already running. Otherwise start one separately and reuse it.

```sh
node scripts/score-render-modes.mjs color.101 color-13
node scripts/export-tvg-case-images.mjs color.101 color-13 /tmp/tvg-color13-current
node scripts/rank-tvg-shapes-by-diff.mjs color.101 color-13 line 20
node scripts/rank-tvg-shapes-by-recovery.mjs color.101 color-13 line 20
node scripts/inspect-tvg-case.mjs color.101 color-13 --summary
node scripts/scan-tvg-shapes.mjs color.101 color-13 line
npm test -- src/__tests__/tvg-parser.test.ts
npm test -- src/__tests__/tvg-benchmark.test.ts
npm run build
npm run benchmark:tvg:raw
```

Image exports to compare manually:

```sh
/tmp/tvg-color13-current/color.101__color-13__reference.png
/tmp/tvg-color13-current/color.101__color-13__candidate.png
/tmp/tvg-color13-current/color.101__color-13__diff.png
```

## Token And Process Budget

- Use this file as the subagent context. Do not fork the whole conversation unless a task truly needs it.
- Delegate one narrow hypothesis per subagent.
- Ask subagents for compact output: hypothesis, commands, result table, recommendation, and files touched. Explorers should not edit files.
- Keep only one or two live subagents at a time.
- Avoid long benchmark sweeps inside subagents; reserve `npm run benchmark:tvg:raw` for local verification after a candidate patch.
- Do not paste large image data or long JSON into chat. Save images under `/tmp` and report paths plus score deltas.
- Prefer existing scripts over ad hoc browser probes. If an ad hoc probe becomes useful twice, convert it into a small script.
- Reuse or close terminal sessions. Kill stuck Vitest/Puppeteer processes before launching more probes.
- Keep the working tree clean between experiments. Revert failed experiments immediately with `apply_patch`.

## Next Hypotheses

1. Same-paint nested contour classification needs a topology rule richer than child area ratio. Candidate signals: signed area direction, child depth, bbox vertical position inside parent, child fragment count, and whether child is a long closed loop versus a tiny island.
2. Shape 21 legacy same-paint children may need the same hole/detail policy used by resolved contour trees.
3. Shape19 parent contour/component pruning is rejected for now: the contour is explicit, closed, zero-gap, and non-support. Revisit only if a new source-format field explains hidden/alternate contour state.
4. Hidden/source-context state for `color-13` is rejected for now: no actionable metadata or unparsed shape-side field was found.
5. Fixed-transform per-shape probes should be used before changing global viewport/padding.
6. If visual evidence suggests the thumbnail was produced from a stale source, classify it as stale only with file timestamp and alternate-source evidence.
7. The next broad improvement candidate is Toon Boom-compatible coverage for opaque near-black line-layer edges. Test with post-processing probes before changing renderer code.

## Subagent Template

Use this prompt shape for fresh subagents:

```text
Read docs/tvg-accuracy-workflow.md first. Do not read the full conversation.
Investigate exactly one hypothesis: <hypothesis>.
Do not edit files unless explicitly assigned as a worker.
Use targeted commands only; avoid full benchmark sweeps.
Return:
- hypothesis
- commands run
- numeric before/after results
- visual or topology observation
- recommended code-level rule
- risks/regressions to test
Keep output under 80 lines.
```
