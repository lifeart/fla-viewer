# Issue #42 — verify the FLA parser before we package it

You asked whether the `.fla` parser could be a standalone library so your VS Code
ActionScript 2.0 extension can read the Stage instances on the timeline and their
types for code completion.

Rather than publish (and then maintain) an npm package up front, here's a
**single self-contained file** you can run against your **own** `.fla` files to
confirm the parser gives you what you need. If it does, packaging is a small next
step.

## What it does

Runs the parser headless under Node — the same environment as the VS Code
extension host — using [linkedom](https://github.com/WebReflection/linkedom) for
the DOM. No rendering, no bitmap/audio/video decoding. It emits the timeline
structure as JSON. Covering the features you asked for:

1. **Per-symbol nested timelines** — `symbols[].timeline` carries each library
   symbol's own layers/frames/instances. Resolve a nested path like
   `panelContainer.itemList.scrollBar` by walking
   `instance.libraryItemName → symbols[name] → its timeline → next instance`.
2. **ActionScript class linkage** — each symbol carries `linkageClassName`,
   `linkageIdentifier`, `linkageExportForAS` (read from `<DOMSymbolItem>`).
3. **TextField instance names** — dynamic/input fields expose `name` and
   `textType` (`static`/`dynamic`/`input`); named ones appear in `namedInstances`
   with `kind: "text"`.
4. **Frame labels** — every timeline (main and nested) has a `labels` array of
   `labelType="name"` labels, plus `label` on the frame itself — for validating
   `gotoAndPlay("…")` targets.
5. **Component parameters** — instances carry `componentParameters`
   (`{ name, value, type }`) read from `<persistentData><PD/></persistentData>`.
   ⚠️ **Best-effort / unverified** — none of our sample files use components, so
   please confirm this matches your component `.fla` files (and send one if not).

Plus `namedInstances`: a flat index of **every** named instance across **all**
timelines (document scenes + every library symbol), each tagged with its
`container` (`document`/`symbol`), `containerName`, `layer`, `frame`, and a
human `path`. This is the core map: `instanceName → type`, at any nesting depth.

## Run it

Build the bundle once (inlines linkedom + jszip + pako into a single file), then
run it on any `.fla`:

```sh
npm install
npm run build:extractor                                   # -> scripts/dist/fla-structure.mjs
node scripts/dist/fla-structure.mjs path/to/your.fla --pretty
```

The built `fla-structure.mjs` is fully self-contained: copy it anywhere and run
it with nothing but Node 18+ (no `node_modules` needed). If we send you the
prebuilt file directly, skip the first two steps.

### Example output (named instances across a nested symbol)

```jsonc
{
  "symbols": [
    {
      "name": "ItemCard", "itemID": "abc-…", "symbolType": "movieclip",
      "linkageExportForAS": true,
      "linkageClassName": "skyui.components.ItemCard",
      "linkageIdentifier": "ItemCard",
      "timeline": { "name": "ItemCard", "labels": [{ "name": "idle", "frame": 0 }],
        "layers": [ /* content layer: scrollBar (movieclip), label_tf (dynamic text) */ ] }
    }
  ],
  "namedInstances": [
    { "name": "panelContainer", "kind": "symbol", "symbolType": "movieclip", "libraryItemName": "ItemCard",
      "container": "document", "containerName": "Scene 1", "layer": "ui", "frame": 0, "path": "Scene 1 > ui > panelContainer" },
    { "name": "scrollBar", "kind": "symbol", "symbolType": "movieclip", "libraryItemName": "ScrollBar",
      "container": "symbol", "containerName": "ItemCard", "layer": "content", "frame": 0, "path": "ItemCard > content > scrollBar" },
    { "name": "label_tf", "kind": "text", "textType": "dynamic",
      "container": "symbol", "containerName": "ItemCard", "layer": "content", "frame": 0, "path": "ItemCard > content > label_tf" }
  ]
}
```

The `panelContainer` instance (a `movieclip` of `ItemCard`) carries
`componentParameters` when set in the Component Inspector, and its type resolves
to `linkageClassName: "skyui.components.ItemCard"` via the matching `symbols`
entry.

## Binary (pre-CS5 / OLE2) FLAs

For binary FLAs (magic `D0 CF 11 E0`, the `parseBinaryFLA` path), the geometry
decoder recovers symbols + placements but not the authoring metadata your
language feature needs. That metadata lives in the OLE2 streams as Flash strings
(`FF FE FF <len> <UTF-16LE>`), so the output adds a **`binary`** section pulled
directly from those streams (`scripts/binary-augment.ts`):

- **`binary.linkage`** — *reliable.* The Contents linkage table as
  `{ identifier, className, kind }`, e.g. `OptionsListEntry → OptionsListEntry`,
  `ModListEntry → skyui.components.list.ButtonListEntry`. `kind` is `"document"`
  when the record binds the root (the `Symbol 0` / character-0 edit-name = the
  main-timeline class, e.g. `bartermenu → BarterMenuObj → BarterMenu`) or
  `"library"` otherwise — so a stage-instance resolver won't mistake the document
  class for a library symbol. (Verified vs the compiled SWF `registerClass` set.)
- **`binary.symbols[]`** — per `Symbol N` stream:
  - `namedInstances` — `{ name, type, symbolType }` decoded from the placement
    records (e.g. `textField[text]`, `selectorLeft[movieclip]`). Higher precision
    than `candidateNames` (drops component-param keys, adds the **type**), but
    best-effort recall: the FP8 per-class field layout isn't fully decoded, so a
    few names can be missed and the odd frame label / class ref can leak.
  - `candidateNames` — identifier-like strings = likely child instance names
    (broader recall, no types), and `other` — layers / fonts / labels / param
    values, for transparency.

**Two honest gaps I need your read on** (these are why the binary path needs your
files to finish correctly):

1. **Linkage → symbol number.** I can extract the full linkage table, but the
   binary `Contents` doesn't obviously tie each linkage record to a specific
   `Symbol N`. The identifiers don't match the symbols' (mostly auto-named)
   display names. How does your tooling join a linkage record to its symbol
   stream — is there an object id in the MFC `Contents` record I should follow?
2. **Name vs param vs label.** `candidateNames` is a *superset* — it mixes real
   instance names with component-param keys and class refs (all are `FF FE FF`
   strings). Pinning each to a typed placement needs the per-placement record
   schema (which differs from our older fixtures: float32 matrices, `FF FE FF`
   names). If you can share how you split these, I'll decode them structurally.

## Use it as a library (instead of the CLI)

The same bundle exports the function, so your extension can call it directly:

```js
import { extractFlaStructure } from './fla-structure.mjs';
import { readFileSync } from 'node:fs';

const json = await extractFlaStructure(new Uint8Array(readFileSync('movie.fla')));
for (const inst of json.namedInstances) {
  // register completion: inst.name -> inst.symbolType / inst.libraryItemName
}
```

## What to check / tell us

- Do your AS2 `.fla` files produce the `namedInstances` and nested
  `symbols[].timeline` you expect, so the deep paths
  (`a.b.c`) resolve correctly?
- Do `linkageClassName` / `linkageIdentifier` come through on your scripted
  symbols, and the `name`/`textType` on your dynamic & input text fields?
- **Component parameters (#5)** are best-effort and untested on real data —
  please confirm they appear for your components, or attach a small `.fla` with a
  component so we can correct the mapping.

If this covers your needs, we'll extract the parser into a proper package
(`FLAParser` + types, with a `DOMParser` you inject) and publish it.
