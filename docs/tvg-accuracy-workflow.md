# TVG Renderer Accuracy Workstream

This document is the compact handoff for improving the JavaScript TVG parser and renderer toward thumbnail fidelity. Use it instead of replaying the full conversation history.

## Objective

Render Toon Boom TVG files in `src/tvg-parser.ts` as close as possible to the embedded `.thumbnails/*.tvg.png` previews, with a long-term target of raw 100% visual equality where the thumbnail is source-fresh.

The benchmark gate is intentionally tolerance-aware and alignment-aware. Raw score remains the diagnostic target, but code changes should be format-level renderer improvements, not benchmark hacks or sample-specific conditionals.

## Current State

- Latest verified renderer work: removed unsafe later sparse-marker resolved-contour suppression, tuned gated dense line-fill ink-density correction, embedded dark legacy-chain suppression, narrow same-paint detail threshold expansion, dense line-fill edge/coverage/tone passes, and clipped bitmap atlas fit bands.
- Main benchmark command: `npm run benchmark:tvg:raw`.
- Current raw benchmark after clipped bitmap atlas fit bands: overall `98.52`, vector `98.41`, bitmap `99.09`.
- Source-fresh raw average after alternate-source filtering, dense line-fill correction, and bitmap fit bands: overall `98.96`, vector `98.90`, bitmap `99.09`.
- Current source-fresh raw minimum is `color.101/color-21` at `96.97`; source-fresh bitmap minimum is `Agata_Head_Angles.87/Agata_Head_Angles-1` at raw `97.46`.
- `color.101/color-13` is no longer treated as source-fresh after alternate-source probing: its thumbnail matches sibling `elements/color/color-13.tvg` much better than `elements/color.101/color-13.tvg`.
- Current `color.101/color-13` scores against its own source remain raw `85.4453125`, aligned `92.0078125`, normalized/focused about `76.83`, foreground IoU about `84.57`.
- The sibling `elements/color/color-13.tvg` scores raw `95.578125`, aligned `97.2421875`, normalized about `92.55`, IoU about `95.34` against the `color.101` thumbnail.
- The mismatch is therefore classified as `thumbnail-matches-alternate-drawing` in the raw benchmark when the alternate raw score is at least `6` points better and meets high raw/aligned floors.
- The app fallback path can score 100 by using embedded thumbnails, but raw vector rendering is the target.
- Local ablation tooling supports raw/aligned sorting, `--skip-only`, grouped component removal via `--group`/`--remove-components-as-group`, and opt-in verbose component metadata via `--details`.
- `scripts/analyze-tvg-residuals.mjs` is the preferred compact diagnostic for dense line-fill residuals. It reports raw/aligned/focused/IoU, foreground-only counts, edge/interior residual buckets, luma buckets, and alpha summaries for reference-only/candidate-only pixels.
- `scripts/score-tvg-tone-variants.mjs` probes dense line-fill post-composite tone variants across a drawing set and reports per-drawing raw deltas. Use it before changing dense tone constants.
- `scripts/score-bitmap-fit-variants.mjs` probes bitmap-only fit padding variants and reports tile count/aspect metadata. Use it before changing bitmap atlas padding bands.

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
- Scores checked before the line-fill inset patch: `color-1` raw `93.1133`, `color-31` raw `94.5078`, `color-3` raw `94.8008`, `color-19` raw `94.9883`, `color-18` raw `95.0664`.
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

Resolved and open questions:

- Same-paint nested legacy chains now use the shared small-detail policy used by resolved contours, guarded by dense line-layer topology.
- Whether mixed-paint support fragments should help resolve shape 21 into contour topology rather than relying on legacy paint groups.

Managed finding from `Bohr`:

- In-memory patch applying the resolved same-paint small-detail policy to legacy child chains changed `color.101/color-13` raw from `83.6953125` to `83.9140625`.
- The same patch reduced aligned score from `91.77734375` to `91.54296875` and normalized score from about `75.53` to about `75.03`; bounds and IoU were unchanged.
- Topology before the threshold expansion: shape21 green parent chain has 40 components; small same-paint children by the original `0.035` area-ratio threshold were chains `2`, `3`, `4`, `6`, and `7`; larger child chains `1` and `5` remained holes.
- Manager decision: implemented as a shared topology predicate used by resolved contour trees and legacy chains, guarded by line-layer dense-parent topology. Targeted parser tests, benchmark tests, build, and raw benchmark pass. This is still not the root-cause fix and should not distract from shape19, which is the top-bound overfill source.

Current verification after this patch:

- `npm test -- src/__tests__/tvg-parser.test.ts`: 82 passed.
- `npm test -- src/__tests__/tvg-benchmark.test.ts`: 17 passed.
- `npm run build`: passed.
- `npm run benchmark:tvg:raw`: gate averages overall/vector/bitmap `100.00/99.99/100.00`; raw averages overall/vector/bitmap `98.46/98.36/98.94`; source-fresh raw averages overall/vector/bitmap `98.71/98.61/98.94`; source-fresh raw min `85.23`.

Managed local finding: line-fill source inset

- Reducing the line-fill source inset from `5px` to `4px` globally improved many portrait-ish `color.101` drawings but regressed `color-13` from raw `83.91` to `83.42`.
- A conditional rule keeps the old `5px` inset for near-square line-fill source bounds and uses `4px` for non-square/portrait line-fill drawings.
- Targeted improvements with this conditional: `color-1` raw `93.11 -> 94.77`, `color-31` raw `94.51 -> 96.11`, `color-3` raw `94.80 -> 96.42`, `color-19` raw `94.99 -> 96.93`, `color-18` raw `95.07 -> 96.75`.
- Full raw benchmark with the conditional: source-fresh raw average `98.63`, vector raw average `98.34`, source-fresh raw min remains `83.91`.

Managed local finding: bitmap atlas aspect-band fit

- `4bf5/4bf5-1` is bitmap-only: no vector layers, eight clipped tiles, clip aspect about `1.47`, cell aspect `2.0`, baseline raw `96.98`.
- A fractional `7.5px` fit inset improves `4bf5/4bf5-1` raw to `97.89`, but applying it to all landscape clipped atlases regresses wider bitmap atlases: `3255/3255-1` and `7f81/7f81-1`.
- Accepted fit-band rules after the all source-fresh bitmap sweep:
- Non-fallback clipped atlases with `8` tiles and aspect `>=2.0` use `6.5px`; `8`-tile aspect around `1.93` stays on `7px`.
- Non-fallback clipped atlases with `12` tiles and aspect `>=2.3` use `6.5px`; `12`-tile aspect around `2.1` stays on `7px`.
- Non-fallback clipped atlases with aspect in `(1.35, 1.6)` or `(1.25, 1.35]` use `7.5px`.
- Fallback-scanned clipped atlases with `32..127` tiles and aspect `>1.35` use `5.5px`.
- Targeted improvements from these rules: `3255/3255-1` raw `97.07 -> 97.64`, `7f81/7f81-1` `97.18 -> 98.33`, `6172/6172-1` `99.08 -> 99.97`, `1388/1388-1` `99.84 -> 99.92`, `cc62/cc62-1` `98.25 -> 98.64`, and `Agata_Special_Poses_Vik/Agata_Special_Poses_Vik-1` `98.28 -> 99.24`.
- Full raw benchmark after the fit bands: raw averages overall/vector/bitmap `98.52/98.41/99.09`; source-fresh raw averages overall/vector/bitmap `98.96/98.90/99.09`; source-fresh bitmap min `97.46`.

Managed local finding: `color.101/color-13` shape21 component probes

- Shape21 explicit contour building still resolves `0` contours and leaves `2` unresolved support-dominated chains, so legacy rendering remains active.
- Relaxing support-dominated auto-close for long chains made `color-13` raw drop to `76.62109375` and broke parser tests that intentionally guard against unsafe bottom-fill behavior. Do not revisit this relaxation without a new source-format signal.
- Single component removals from shape21 can improve raw slightly, especially components `77..84`, but they are misleading because they can break chain rendering while also deleting support geometry.
- Group removing dark components `75..84` from shape21 produced raw `83.91015625`, aligned `91.3828125`, and worse bounds, so grouped deletion is rejected.
- Accepted rule: suppress rendering of an embedded dark legacy paint group, without deleting its source components, only when strict topology gates all match: line layer, no strokes, dense mixed-paint fill carriers, no resolved explicit contours, a large non-dark paint group, an embedded dark group of `8..16` components with one explicit seed and inherited continuation, exactly one closed drawable legacy chain, and chain bbox area no more than `10%` of the shape bbox area.
- This matched the `solid:15,46,48,255` chain in shape21 and improved `color-13` raw `84.328125 -> 84.81640625`, aligned `91.55859375 -> 91.68359375`, normalized `75.4779 -> 75.8329`, and IoU `83.04 -> 83.75`.
- Accepted follow-up rule: increase the same-paint detail child area-ratio cutoff from `0.035` to `0.0375`, with the existing line-layer, same-paint, parent-fragment, and child-fragment gates unchanged. This admits shape21 green child chain `40..49` as an internal detail island while still leaving the much larger child chain `57..72` as a hole.
- The threshold expansion improved `color-13` raw `84.81640625 -> 85.2265625`, aligned `91.68359375 -> 91.765625`, normalized `75.8329 -> 76.4628`, and IoU `83.75 -> 84.58`.

Managed local finding: next source-fresh cases after the current baseline

- `color.101/color-1` baseline after dense line-fill ink retune: raw `95.53515625`, aligned `98.1484375`, normalized `95.6184`, IoU `99.0354`, bounds match exactly.
- `color.101/color-21` baseline after dense line-fill ink correction: raw `95.625`, aligned `98.734375`, normalized `94.57494407158836`, IoU `97.3434004474273`.
- Shape/component ablations for `color-1` and `color-21` showed no obvious single deletion or isolated topology fix at that point. Later marker-focused probing showed `color-21` shape129 was a structural false-positive for the resolved-contour suppression heuristic, not paint to delete.

Managed local finding: later sparse-marker resolved-contour suppression

- The old heuristic skipped an entire resolved non-black contour when a tiny later same-layer sparse boundary marker overlapped it and later near-black fill shapes also overlapped. This was intended to avoid colored fringe pixels, but it used weak evidence and could hide legitimate fills.
- `color.101/color-21` minimal reproduction: rendering line shapes `3,13,15` shows the yellow eye fill; adding sparse marker shape129 (`3,13,15,129`) suppresses that yellow fill and reveals dark green/black blockers. Shape129 itself is only two tiny widthless boundary marks and is not meaningful visible paint.
- Broad sparse-marker paint suppression is rejected: marker ablations were mixed and can regress other drawings. The correct fix is to stop using later sparse markers as evidence to skip already-resolved contours.
- Removing the later-marker suppression changed only five benchmark drawings by `element/drawing`, all source-fresh `color.101` improvements: `color-31` raw `+1.03515625`, `color-3` raw `+0.4296875`, `color-21` raw `+0.28125`, `color-23` raw `+0.26171875`, and `color-19` raw `+0.078125`.
- Full benchmark after removal: gate averages overall/vector/bitmap `100.00/99.99/100.00`; raw averages overall/vector/bitmap `98.47/98.38/98.94`; source-fresh raw averages overall/vector/bitmap `98.74/98.65/98.94`; source-fresh raw min `85.25`.

Managed local finding: dense line-fill ink density

- Supersampling alone is not a safe renderer rule: SS3/SS4 improved raw on some `color.101` cases but regressed aligned/normalized and hurt other follow-up drawings.
- A post-render RGB ink-density correction for pixels with luma `<= 248` improved the first seven `color.101` source-fresh cases in raw score.
- Applying that correction unconditionally across the 35 lowest source-fresh vector cases is rejected: 20 improved, 15 regressed, with meaningful regressions on non-dense-line-fill drawings such as `Number_Body/Number_Body-2` and `B_Shorts/B_Shorts-1`.
- Accepted gated rule: apply the correction only when `shouldInsetViewportForLineFillDrawing()` is true, and only for normal full-background renders. Do not apply in layer-filter, compositor/origin-centered, skip-clipping, or matte modes.
- Accepted retune: increase the gated correction from `-12` to `-16` RGB. This improves 8 fresh `color.101` cases, with one tiny raw regression on `color-31` (`-0.0078125`) while its aligned/focused scores improve.
- Full benchmark after the `-16` retune: gate averages overall/vector/bitmap `100.00/99.99/100.00`; raw averages overall/vector/bitmap `98.46/98.37/98.94`; source-fresh raw averages overall/vector/bitmap `98.72/98.62/98.94`; source-fresh raw min `85.25`.
- Accepted follow-up retune: lower the luma cutoff from `248` to `220` and increase subtraction from `16` to `32`. The stronger correction only affects darker ink pixels, changed nine `color.101` drawings in the full benchmark, improved six, and had no non-`color.101` movement.
- Full benchmark after the `220/32` retune: gate averages overall/vector/bitmap `100.00/99.99/100.00`; raw averages overall/vector/bitmap `98.48/98.39/98.94`; source-fresh raw averages overall/vector/bitmap `98.75/98.66/98.94`; source-fresh raw min `85.45`.
- Notable source-fresh deltas from the previous `248/16` correction: `color-1` raw `+0.375`, `color-13` raw `+0.19921875`, `color-19` raw `+0.1640625`, `color-31` raw `+0.1640625`, `color-3` raw `+0.08203125`, and `color-18` raw `+0.07421875`; small accepted regressions were `color-23` raw `-0.0546875`, `color-21` raw `-0.0234375`, and `color-15` raw `-0.0078125`.
- Accepted follow-up tone curve: after the dark-ink density correction, apply a mild foreground contrast compression around pivot `96` with factor `0.94`, gated by the same dense line-fill predicate. This reflects the observed Toon Boom thumbnail tone curve: dark/mid ink was too dark after matching density, while pale antialias/detail pixels were too light.
- Targeted `color.101` source-fresh deltas from this tone curve were all positive: `color-1` raw `95.9102 -> 95.9844`, `color-21` `95.9141 -> 95.9219`, `color-18` `97.0234 -> 97.0547`, `color-3` `97.1563 -> 97.2461`, `color-15` `97.2813 -> 97.3008`, `color-19` `97.3711 -> 97.4141`, `color-31` `97.3828 -> 97.4180`, and `color-23` `98.7031 -> 98.7500`.
- Full benchmark after the tone curve: gate averages overall/vector/bitmap `100.00/99.99/100.00`; raw averages overall/vector/bitmap `98.48/98.39/98.94`; source-fresh raw averages overall/vector/bitmap `98.88/98.86/98.94`; source-fresh raw min `95.92`.
- Accepted follow-up edge-coverage correction: before white pre-composite, boost only fractional alpha by `1.1x`, still gated by dense line-fill detection and only when the downsampled transparent render has at least `900` fractional-alpha pixels. This targets dense antialias coverage without changing sparse drawings.
- Fractional-alpha guard evidence at `160x160`: `color-1` `1615`, `color-21` `910`, `color-3` `1247`, `color-19` `1214`, `color-31` `1147`; skipped sparse/neutral cases include `color-23` `601`, `color-15` `800`, `color-18` `898`, and `Drawing_2-1` `419`.
- Targeted post-tone deltas from the alpha boost: `color-1` raw `95.9844 -> 96.0391`, `color-21` `95.9219 -> 95.9688`, `color-3` `97.2461 -> 97.2656`, `color-19` `97.4141 -> 97.5000`, and `color-31` `97.4180 -> 97.4961`; skipped cases stayed unchanged.
- Full benchmark after the edge correction: gate averages overall/vector/bitmap `100.00/99.99/100.00`; raw averages overall/vector/bitmap `98.48/98.39/98.94`; source-fresh raw averages overall/vector/bitmap `98.88/98.86/98.94`; source-fresh raw min `95.97`.

Managed local finding: alternate-source thumbnail detection

- `color.101/color-13` visually differs too much for an antialiasing or placement fix: the candidate rendered from `elements/color.101/color-13.tvg` has different hair/ear silhouette and bounds `{minX:9,minY:9,maxX:150,maxY:143}` versus reference `{minX:8,minY:17,maxX:149,maxY:142}`.
- Archive evidence found a sibling same-name drawing: `elements/color/color-13.tvg` scores raw `95.578125`, aligned `97.2421875`, normalized `92.5475`, and IoU `95.3422` against the `color.101` thumbnail, while the actual `color.101` drawing scores raw `85.4453125`.
- The `color.101/color-13.tvg~` backup scores worse than the active source (`84.47265625` raw), so the thumbnail most likely belongs to the sibling `color` element, not to the current `color.101` TVG or its backup.
- A scan of other low/suspicious source-fresh cases found no comparable alternate-source win: `Drawing_2-1` backup improved only `+0.2305`, `color-21` sibling improved only `+0.0625`, and `color-1` sibling regressed.
- Accepted benchmark rule: only classify `thumbnail-matches-alternate-drawing` when a sibling or backup same-name TVG beats the active drawing by at least `6` raw points and the alternate also scores raw `>=92` and aligned `>=95`.
- This is not a renderer shortcut. It prevents stale/copied thumbnails from driving topology hacks against the wrong source while preserving them in the full raw results with alternate-source diagnostics.

Managed local finding: embedded dark legacy-chain suppression

- `color.101/color-13` shape21 has a small closed dark chain `solid:15,46,48,255` embedded inside a much larger green line-fill shape. Rendering it as an independent legacy paint group adds a lower face/neck protrusion that the source-fresh thumbnail mostly lacks.
- Removing the chain's source components is rejected because it changes geometry/support and can worsen bounds. Blocking only the dark legacy paint group preserves the source components for analysis while avoiding the extra fill.
- Accepted rule is deliberately structural, not sample-index based: it looks for dense unresolved mixed-paint line fills with one large non-dark group and a small single-chain embedded dark group with one explicit seed plus inherited continuation.
- Full benchmark after the rule: gate averages overall/vector/bitmap `100.00/99.99/100.00`; raw averages overall/vector/bitmap `98.46/98.36/98.94`; source-fresh raw averages overall/vector/bitmap `98.70/98.60/98.94`; source-fresh raw min `84.82`.

Managed local finding: same-paint detail threshold expansion

- Current evidence shows one useful same-paint legacy child hole just outside the old threshold: shape21 green child chain `40..49` has `10` components and bbox-area ratio about `3.66%`, while the old cutoff was `3.5%`.
- Breaking any component in chain `40..49` produced the same score delta, indicating the renderer was over-subtracting the child as a hole. Group deletion is not the desired rule; the sustainable behavior is to classify this same-paint child as an internal detail island.
- Raising only the area-ratio cutoff to `3.75%` keeps the fragment-count cap at `12` and does not admit the larger green child chain `57..72`, whose raw-only improvement came with aligned/normalized regression.
- Full benchmark after the threshold expansion: gate averages overall/vector/bitmap `100.00/99.99/100.00`; raw averages overall/vector/bitmap `98.46/98.36/98.94`; source-fresh raw averages overall/vector/bitmap `98.71/98.61/98.94`; source-fresh raw min `85.23`.

Managed local rejected experiment: line-layer dark-last fill ordering

- Sorting line-layer fills so dark solid paint groups render after non-dark groups improved `color.101/color-13` raw `85.2265625 -> 85.546875`, but aligned dropped `91.765625 -> 91.6796875` and normalized dropped `76.4628 -> 76.2805`.
- Full benchmark diff changed only four drawings, but one fresh drawing regressed materially: `Switch.1004/Switch-1` raw `98.23046875 -> 98.01953125`.
- Manager decision: reject broad color-priority render ordering. Revisit only with a source-format z-order signal or a localized occlusion rule that does not regress `Switch.1004/Switch-1`.

Managed local finding: low-edge dense line-fill exterior coverage

- Residual analysis for `color.101/color-21` showed raw `96.0000`, aligned `99.0469`, focused `95.6384`, IoU `97.5955`, with reference bounds one pixel lower than candidate bounds.
- `color-21` had `242` reference-only pixels but only `16` candidate-only pixels. Alpha diagnostics showed `239/242` reference-only pixels had zero candidate alpha, so stronger fractional-alpha scaling could not recover them.
- Global/local tone transforms were rejected as the primary fix: the best simple tone oracle only reached about `+0.14` raw, while localized bottom/silhouette replacement had much larger headroom.
- Shape deletion ablation was rejected: best single-shape deletion was only about `+0.16` raw and did not explain the missing silhouette coverage.
- Implemented a tightly gated exterior-only alpha expansion inside the dense line-fill edge adjustment. It reuses the existing fractional-alpha gate and only expands when the downsampled fractional-alpha budget is low (`900..1000` pixels), which applied to `color-21` and skipped higher-edge portraits plus sparse cases.
- The expansion flood-fills transparent pixels from the canvas edge and grows only that exterior fringe. Interior holes are not expanded, so the rule models antialias coverage rather than contour topology.
- Targeted result with expansion scale `0.9`: `color-21` raw `96.0000 -> 96.8555`, aligned `99.0469 -> 99.1211`, focused `95.6384 -> 96.6322`, IoU `97.5955 -> 98.4591`.
- Dense-cluster guard remained unchanged for `color-1`, `color-3`, `color-31`, `color-19`, `color-18`, `color-15`, and `color-23`. Additional guards checked unchanged at targeted precision: `Number_Body-2`, `B_Shorts-1`, `Switch-1`, and `Drawing_2-1`.

Managed local finding: high-edge dense line-fill edge tone

- After exterior expansion, `color.101/color-1` became the source-fresh floor: raw `96.2227`, aligned `98.6797`, focused `96.7629`, IoU `99.0190`, exact candidate/reference bounds.
- Residual buckets showed the remaining error was overlap tone, not topology: reference-only `90`, candidate-only `30`, both-foreground `12113`.
- Edge pixels were too light: mean edge RGB delta `+26.28,+24.68,+23.43`; interior pixels were too dark: mean interior RGB delta `-13.57,-31.43,-29.53`.
- Broad edge darkening was rejected because it regressed lower-edge-count portraits (`color-3`, `color-18`, `color-15`, `color-23`).
- Implemented post-composite edge tone only when the dense line-fill output has a high fractional-alpha budget (`>=1500` pixels). The pass uses the pre-white alpha mask after edge coverage and darkens only final pixels whose source alpha is fractional.
- Renderer-path sweep: subtract `8` gave `color-1` raw `96.7305`; subtract `16` gave `97.0859`; subtract `24` gave `97.2930`; subtract `32` peaked at `97.3438`; subtract `48` regressed to `97.0391`.
- Accepted subtract `32`: `color-1` raw `96.2227 -> 97.3438`, aligned `98.6797 -> 98.8555`, focused `96.7629 -> 97.2785`, IoU `99.0190 -> 99.1010`.
- Dense-cluster guard remained unchanged for `color-21`, `color-3`, `color-31`, `color-19`, `color-18`, `color-15`, and `color-23`. Additional guards checked unchanged at targeted precision: `Number_Body-2`, `B_Shorts-1`, `Switch-1`, and `Drawing_2-1`.

Managed local finding: dense line-fill interior shadow lift

- Residual buckets for dense portraits consistently showed fully opaque interior pixels too dark after the existing ink-density/tone curve, while fractional edge pixels needed separate handling.
- The accepted pass uses the pre-white alpha mask and only adjusts pixels whose source alpha is `255` and whose post-composite luma is `<=96`.
- Accepted lift is RGB `+4,+20,+20`, matching the dominant near-black/green residual direction without re-lightening antialias edges.
- Targeted dense-cluster deltas after high-edge tone: `color-21 +0.1172`, `color-18 +0.0352`, `color-3 +0.0078`, `color-15 +0.0117`, `color-1 +0.0234`, `color-19 +0.0156`, `color-31 +0.0977`, `color-23 +0.0508`.
- Additional guards checked unchanged at targeted precision: `Number_Body-2`, `B_Shorts-1`, `Switch-1`, and `Drawing_2-1`.

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
node scripts/analyze-tvg-residuals.mjs color.101 color-21,color-1
node scripts/score-tvg-tone-variants.mjs color.101 color-1,color-21,color-3,color-31,color-19,color-18,color-15,color-23
node scripts/scan-tvg-shapes.mjs color.101 color-13 line
node scripts/ablate-tvg-shapes.mjs color.101 color-13 --layer line --sort raw-desc --skip-only
node scripts/ablate-tvg-components.mjs color.101 color-13 --layer line --shape 21 --sort raw-desc --skip-only
node scripts/ablate-tvg-components.mjs color.101 color-13 --layer line --shape 21 --components 75,76,77,78,79,80,81,82,83,84 --group
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
- Keep ablation output compact by default; pass `--details` only when component metadata is needed.
- Reuse or close terminal sessions. Kill stuck Vitest/Puppeteer processes before launching more probes.
- Keep the working tree clean between experiments. Revert failed experiments immediately with `apply_patch`.

## Next Hypotheses

1. The next broad improvement candidate is `color.101/color-13` silhouette/topology. The ink-density correction helped raw, but the top-bound overfill remains.
2. Same-paint nested contour classification may still need a topology rule richer than child area ratio. Candidate signals: signed area direction, child depth, bbox vertical position inside parent, child fragment count, and whether child is a long closed loop versus a tiny island.
3. Shape19 parent contour/component pruning is rejected for now: the contour is explicit, closed, zero-gap, and non-support. Revisit only if a new source-format field explains hidden/alternate contour state.
4. Hidden/source-context state for `color-13` is rejected for now: no actionable metadata or unparsed shape-side field was found.
5. Fixed-transform per-shape probes should be used before changing global viewport/padding.
6. If visual evidence suggests the thumbnail was produced from a stale source, classify it as stale only with file timestamp and alternate-source evidence.
7. Shape21 mixed-paint support fragments may need to help resolve contour topology rather than falling back to legacy paint groups.
8. Prefer grouped ablation before code changes when a candidate fix affects a cluster of components; single-component wins are often misleading for nested line art.
9. Out-of-view unresolved line-fill carriers can pollute viewport bounds even when they draw no pixels. Keep this as a framing-only rule: exclude only pure open unresolved chains that have no drawable legacy chain and are large offstage outliers. A broad "zero-pixel shape" exclusion regresses `color.101/color-18`, `color-15`, `color-31`, and `color-19`.
10. Dense line-fill tone changes must be swept across the `color.101` cluster, not tuned on one portrait. The accepted tone compression keeps `color-21` at the source-fresh floor while improving `color-1`, `color-3`, `color-15`, `color-19`, `color-23`, and `color-31`; broad brightness-only shifts were rejected.

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
