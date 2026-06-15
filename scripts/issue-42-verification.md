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
structure as JSON, including:

- `symbols` — the library items (your candidate types).
- `timelines[].layers[].frames[].elements[]` — every Stage element with its
  `type` (`symbol` / `shape` / `text` / `bitmap` / `video`), and for symbols the
  `name` (instance name — the AS identifier), `symbolType`
  (`graphic` / `movieclip` / `button`), and `libraryItemName`.
- `namedInstances` — a flat index of every **named** Stage instance mapped to its
  type. This is the core of the use case: `instanceName → type`.

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

### Example output (named movieclip + button on a timeline)

```jsonc
{
  "stage": { "width": 640, "height": 480, "frameRate": 24, "backgroundColor": "#101820" },
  "symbols": [ /* library items: { name, itemID, symbolType } */ ],
  "namedInstances": [
    { "name": "playBtn", "symbolType": "button",    "libraryItemName": "PlayButton", "timeline": "Scene 1", "layer": "ui", "frame": 0 },
    { "name": "hero",    "symbolType": "movieclip", "libraryItemName": "HeroClip",   "timeline": "Scene 1", "layer": "ui", "frame": 0 }
  ]
}
```

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

- Do your AS2 `.fla` files produce the `namedInstances` you expect (instance
  name + `movieclip`/`button`/`graphic`)?
- Anything missing for completion? Known not-yet-captured: text-field instance
  names (`DOMDynamicText`/`DOMInputText` `name`), component/parameter metadata,
  per-symbol nested timelines. These are quick to add if you need them.

If this covers your needs, we'll extract the parser into a proper package
(`FLAParser` + types, with a `DOMParser` you inject) and publish it.
