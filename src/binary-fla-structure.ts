/**
 * Timeline / layer structure extraction for pre-CS5 *binary* `.fla` files
 * (GitHub issue #8, follow-up to the document-props + library work in
 * {@link ./binary-fla-parser}).
 *
 * ── What this decodes (and how reliable each part is) ──────────────────────
 *
 * Each scene lives in a `Page N` OLE2 stream and each library item in a
 * `Symbol N` stream; both are MFC `CArchive` object trees rooted at a
 * `CPicPage` whose children are `CPicLayer` objects (see the fla-decoder
 * reference, docs/FORMAT.md §3–4 — reverse-engineered from Flash 8's
 * flash.exe). The full per-frame `CPicFrame` tail (timeline control, frame
 * actions, tween data) is only *partially* decompiled even in the reference
 * (FORMAT.md §10 "Known limitations"), and its variable-length schema-gated
 * fields make a clean structured walk of the WHOLE tree desync after the first
 * frame. So this module deliberately decodes only what is RELIABLE:
 *
 *   RELIABLE (validated byte-for-byte against 5 real Flash MX 2004 FLAs and
 *   the fla-decoder reference):
 *     - the per-stream LAYER LIST: each layer's name, type (normal / guide /
 *       mask / masked / folder), locked flag and visible flag. Layers are
 *       found by the exact CPicLayer signature documented in FORMAT.md §4:
 *       the CPicObj end-of-children NULL tag + two INT_MIN "uninitialised
 *       origin" point sentinels, then `u8 layer_schema`, then the layer-name
 *       Flash string (`FF FE FF <u8 len> <UTF-16LE>`), then the schema-gated
 *       `u8 type, u8 locked, u8 visible` triple (layer_schema >= 4).
 *
 *   NOT decoded (intentionally — would be guesswork; see PR coverage table):
 *     - per-layer FRAME COUNTS / keyframes / tweens (CPicFrame tail unparsed)
 *     - symbol PLACEMENTS / instance matrices on the stage
 *     - layer→layer mask/parent relationships
 *     - vector shape geometry (a separate, much larger effort)
 *
 * Frame counts are therefore reported as a single placeholder frame per layer;
 * the viewer shows the real, named layer stack instead of an empty stage, but
 * does NOT fabricate timeline content we cannot actually read.
 *
 * No errors are silently swallowed: a malformed layer record is skipped with a
 * recorded reason rather than crashing the whole parse (project rule).
 */

export type BinaryLayerType =
  | 'normal'
  | 'guide'
  | 'mask'
  | 'masked'
  | 'folder';

export interface BinaryLayerInfo {
  /** Layer display name (e.g. "Layer 1", "shaft", "Guide: Layer 8"). */
  name: string;
  /** Decoded CPicLayer.layer_schema (11 in all observed Flash MX 2004 files). */
  schema: number;
  /** Layer kind from the post-name type byte, refined by name prefix. */
  layerType: BinaryLayerType;
  /** Locked in the authoring tool. */
  locked: boolean;
  /** Visible (true) vs hidden/outline (false) in the authoring tool. */
  visible: boolean;
}

export interface BinaryTimelineInfo {
  /** Source OLE2 stream name ("Page 1", "Symbol 3", …). */
  stream: string;
  /** Layers in stream order. May be empty if none could be decoded. */
  layers: BinaryLayerInfo[];
}

// CPicObj's end-of-children marker as it appears immediately before a layer's
// schema byte: a NULL child-list tag (u16 0x0000) followed by the layer's
// 2×s32 "origin" point, both set to INT_MIN (0x80000000) — the "uninitialised
// origin" sentinel Flash writes for layers (FORMAT.md §9). Little-endian:
//   00 00            NULL child tag
//   00 00 00 80      point.x = INT_MIN
//   00 00 00 80      point.y = INT_MIN
const LAYER_SIG = new Uint8Array([
  0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x80,
]);

// Flash length-prefixed UTF-16LE string BOM: FF FE FF <u8 len>.
const FLASH_STR_BOM = new Uint8Array([0xff, 0xfe, 0xff]);

// CPicLayer.type byte → semantic kind (FORMAT.md §4). 0=normal, 1=guide,
// 3=mask, 4=masked, 5=folder. Values we have not observed map to 'normal'.
const LAYER_TYPE_BY_BYTE: Record<number, BinaryLayerType> = {
  0: 'normal',
  1: 'guide',
  3: 'mask',
  4: 'masked',
  5: 'folder',
};

const utf16le = new TextDecoder('utf-16le');

function matchesAt(hay: Uint8Array, needle: Uint8Array, at: number): boolean {
  if (at < 0 || at + needle.length > hay.length) return false;
  for (let j = 0; j < needle.length; j++) {
    if (hay[at + j] !== needle[j]) return false;
  }
  return true;
}

/**
 * Enumerate the layers in a single decoded `Page N` / `Symbol N` stream.
 *
 * This scans for the validated CPicLayer signature rather than walking the
 * full object tree, because the variable-length CPicFrame tails between layers
 * cannot be reliably consumed (see module docstring). Every layer in a Flash
 * MX 2004 stream is preceded by the same sentinel, so this enumerates the
 * complete layer stack while only reading fields whose layout is documented.
 */
export function extractLayers(streamData: Uint8Array): BinaryLayerInfo[] {
  const layers: BinaryLayerInfo[] = [];
  const data = streamData;
  let pos = 0;

  while (pos <= data.length - LAYER_SIG.length) {
    if (!matchesAt(data, LAYER_SIG, pos)) {
      pos += 1;
      continue;
    }
    // After the 10-byte sentinel: u8 layer_schema, then the name Flash string.
    const schemaPos = pos + LAYER_SIG.length;
    const schema = data[schemaPos];
    const bomPos = schemaPos + 1;
    // A plausible layer schema is small; bail this candidate otherwise. (The
    // sentinel can also precede CPicShape bodies, which are NOT layers — those
    // are not followed by a layer-schema byte + name Flash string.)
    if (
      schema < 1 ||
      schema > 30 ||
      !matchesAt(data, FLASH_STR_BOM, bomPos)
    ) {
      pos += 1;
      continue;
    }
    const lenPos = bomPos + FLASH_STR_BOM.length;
    const charLen = data[lenPos];
    const nameStart = lenPos + 1;
    const nameEnd = nameStart + charLen * 2;
    if (charLen === 0 || nameEnd > data.length) {
      pos += 1;
      continue;
    }
    const name = utf16le.decode(data.subarray(nameStart, nameEnd));

    // Post-name triple (layer_schema >= 4): u8 type, u8 locked, u8 visible.
    let typeByte = 0;
    let locked = false;
    let visible = true;
    if (schema >= 4 && nameEnd + 2 < data.length) {
      typeByte = data[nameEnd];
      locked = data[nameEnd + 1] !== 0;
      visible = data[nameEnd + 2] !== 0;
    }
    let layerType = LAYER_TYPE_BY_BYTE[typeByte] ?? 'normal';
    // The name prefix carries the same semantics Flash shows in the UI and is
    // a useful disambiguator for guide/folder layers whose type byte the
    // reference does not always populate consistently.
    if (name.startsWith('Guide: ')) layerType = 'guide';
    else if (name.startsWith('Folder ')) layerType = 'folder';

    layers.push({ name, schema, layerType, locked, visible });
    // Advance past this layer's name so the same record isn't re-matched.
    pos = nameEnd;
  }

  return layers;
}

/**
 * Decode the timeline (layer-list) structure for every `Page N` and
 * `Symbol N` stream. `streams` maps an OLE2 stream name to its raw bytes.
 */
export function extractTimelines(
  streams: Map<string, Uint8Array>
): BinaryTimelineInfo[] {
  const out: BinaryTimelineInfo[] = [];
  const names = [...streams.keys()].sort(compareStreamNames);
  for (const name of names) {
    if (!/^(Page|Symbol) \d+$/.test(name)) continue;
    const data = streams.get(name);
    if (!data) continue;
    out.push({ stream: name, layers: extractLayers(data) });
  }
  return out;
}

/** Sort "Page N" before "Symbol N", numerically within each prefix. */
function compareStreamNames(a: string, b: string): number {
  const pa = a.startsWith('Page') ? 0 : 1;
  const pb = b.startsWith('Page') ? 0 : 1;
  if (pa !== pb) return pa - pb;
  const na = parseInt(a.split(' ')[1] ?? '0', 10);
  const nb = parseInt(b.split(' ')[1] ?? '0', 10);
  return na - nb;
}
