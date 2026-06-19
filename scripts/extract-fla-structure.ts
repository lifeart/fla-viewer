/**
 * Issue #42 verification tool — extract the timeline structure + element types
 * from a `.fla` as plain JSON, headless under Node (the VS Code extension-host
 * environment). No rendering, no media decoding, no npm package: just a single
 * bundled file the reporter can run against their OWN ActionScript files to
 * confirm the parser surfaces what a language feature needs.
 *
 * What it exposes (matching the reporter's requests on issue #42):
 *   1. Per-symbol NESTED timelines — every library symbol's own layers/frames/
 *      instances, so nested completion paths (a.b.c) can be resolved by walking
 *      instance.libraryItemName -> symbol -> its timeline.
 *   2. AS class linkage on each symbol (linkageClassName / linkageIdentifier).
 *   3. Dynamic/input TextField instance names (+ which kind).
 *   4. Frame labels (labelType="name") for the main and nested timelines.
 *   5. Component (Component Inspector) parameters on instances [best-effort].
 *   + `namedInstances`: a flat index of every named instance across ALL
 *      timelines (document + symbols), each with its container and path.
 *
 * Usage (after bundling — see scripts/build-extractor.mjs):
 *   node fla-structure.mjs path/to/file.fla            # compact JSON to stdout
 *   node fla-structure.mjs path/to/file.fla --pretty   # indented
 *
 * Or import it:
 *   import { extractFlaStructure } from './fla-structure.mjs';
 *   const json = await extractFlaStructure(bytes);
 */
import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom';
import { FLAParser } from '../src/fla-parser';
import { isOLE2 } from '../src/ole2-reader';
import { augmentBinary, type BinaryAugment } from './binary-augment';
import type { DisplayElement, Matrix, Timeline } from '../src/types';

type SymbolKind = 'graphic' | 'movieclip' | 'button';
type TextKind = 'static' | 'dynamic' | 'input';

export interface ComponentParameterJSON {
  name: string;
  value: string;
  type?: string;
}

export interface InstanceJSON {
  type: DisplayElement['type'];
  name?: string;
  libraryItemName?: string;
  symbolType?: SymbolKind;
  textType?: TextKind;
  text?: string;
  componentParameters?: ComponentParameterJSON[];
  loop?: string;
  matrix?: Matrix;
}

export interface FrameJSON {
  index: number;
  duration: number;
  /** Only set for `labelType="name"` frame labels (gotoAndPlay targets). */
  label?: string;
  elements: InstanceJSON[];
}

export interface TimelineJSON {
  name: string;
  totalFrames: number;
  /** Frame labels (labelType="name") for `gotoAndPlay`/`gotoAndStop` validation. */
  labels: { name: string; frame: number }[];
  layers: { name: string; layerType: string; visible: boolean; frames: FrameJSON[] }[];
}

export interface SymbolJSON {
  name: string;
  itemID: string;
  symbolType: SymbolKind;
  linkageExportForAS?: boolean;
  linkageClassName?: string;
  linkageIdentifier?: string;
  linkageBaseClass?: string;
  /** The symbol's own (nested) timeline — walk this for nested completion paths. */
  timeline: TimelineJSON;
}

export interface NamedInstanceJSON {
  name: string;
  kind: 'symbol' | 'text';
  symbolType?: SymbolKind;
  textType?: TextKind;
  libraryItemName?: string;
  /** 'document' = a scene timeline; 'symbol' = inside a library symbol's timeline. */
  container: 'document' | 'symbol';
  /** Scene name or library symbol name whose timeline holds this instance. */
  containerName: string;
  layer: string;
  frame: number;
  /** Human path: "containerName > layer > instanceName". */
  path: string;
}

export interface StructureJSON {
  stage: { width: number; height: number; frameRate: number; backgroundColor: string };
  symbols: SymbolJSON[];
  media: { bitmaps: string[]; sounds: string[]; videos: string[] };
  timelines: TimelineJSON[];
  namedInstances: NamedInstanceJSON[];
  /**
   * Present only for binary (pre-CS5 / OLE2) FLAs: best-effort metadata pulled
   * directly from the OLE2 streams (linkage table + per-symbol Flash strings),
   * since the binary geometry decoder does not surface it. See scripts/binary-augment.ts.
   */
  binary?: BinaryAugment;
}

function elementToJSON(el: DisplayElement): InstanceJSON {
  switch (el.type) {
    case 'symbol':
      return {
        type: 'symbol',
        ...(el.name ? { name: el.name } : {}),
        libraryItemName: el.libraryItemName,
        symbolType: el.symbolType,
        loop: el.loop,
        ...(el.componentParameters ? { componentParameters: el.componentParameters } : {}),
        matrix: el.matrix,
      };
    case 'text':
      return {
        type: 'text',
        ...(el.name ? { name: el.name } : {}),
        textType: el.textType,
        text: el.textRuns.map((r) => r.characters).join(''),
        matrix: el.matrix,
      };
    case 'bitmap':
      return { type: 'bitmap', libraryItemName: el.libraryItemName, matrix: el.matrix };
    case 'video':
      return { type: 'video', libraryItemName: el.libraryItemName, matrix: el.matrix };
    case 'shape':
      return { type: 'shape', matrix: el.matrix };
  }
}

/**
 * Serialize one timeline to JSON and push any NAMED symbol/text instances on it
 * into `collect`. Used for both the document (scene) timelines and each library
 * symbol's nested timeline — same shape, so nested traversal is uniform.
 */
function timelineToJSON(
  tl: Timeline,
  container: 'document' | 'symbol',
  containerName: string,
  collect: NamedInstanceJSON[]
): TimelineJSON {
  const labels: { name: string; frame: number }[] = [];

  const layers = tl.layers.map((layer) => ({
    name: layer.name,
    layerType: layer.layerType ?? 'normal',
    visible: layer.visible,
    frames: layer.frames
      // Keep frames that carry content OR a navigable label.
      .filter((f) => f.elements.length > 0 || (f.labelType === 'name' && !!f.label))
      .map((frame): FrameJSON => {
        if (frame.labelType === 'name' && frame.label) {
          labels.push({ name: frame.label, frame: frame.index });
        }
        const elements = frame.elements.map(elementToJSON);
        for (const el of elements) {
          if (el.name && (el.type === 'symbol' || el.type === 'text')) {
            collect.push({
              name: el.name,
              kind: el.type === 'symbol' ? 'symbol' : 'text',
              ...(el.symbolType ? { symbolType: el.symbolType } : {}),
              ...(el.textType ? { textType: el.textType } : {}),
              ...(el.libraryItemName ? { libraryItemName: el.libraryItemName } : {}),
              container,
              containerName,
              layer: layer.name,
              frame: frame.index,
              path: `${containerName} > ${layer.name} > ${el.name}`,
            });
          }
        }
        return {
          index: frame.index,
          duration: frame.duration,
          ...(frame.labelType === 'name' && frame.label ? { label: frame.label } : {}),
          elements,
        };
      }),
  }));

  return { name: tl.name, totalFrames: tl.totalFrames, labels, layers };
}

export async function extractFlaStructure(
  bytes: Uint8Array,
  domParser: typeof globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser
): Promise<StructureJSON> {
  const parser = new FLAParser({ DOMParser: domParser });
  const doc = await parser.parse(bytes, undefined, undefined, { structureOnly: true });

  const namedInstances: NamedInstanceJSON[] = [];

  const timelines = doc.timelines.map((tl) =>
    timelineToJSON(tl, 'document', tl.name, namedInstances)
  );

  // doc.symbols may store the same symbol object under several keys (normalized +
  // original name); dedupe by object identity so each library symbol appears once.
  const symbols: SymbolJSON[] = [...new Set(doc.symbols.values())].map((s) => ({
    name: s.name,
    itemID: s.itemID,
    symbolType: s.symbolType,
    ...(s.linkageExportForAS ? { linkageExportForAS: s.linkageExportForAS } : {}),
    ...(s.linkageClassName ? { linkageClassName: s.linkageClassName } : {}),
    ...(s.linkageIdentifier ? { linkageIdentifier: s.linkageIdentifier } : {}),
    ...(s.linkageBaseClass ? { linkageBaseClass: s.linkageBaseClass } : {}),
    timeline: timelineToJSON(s.timeline, 'symbol', s.name, namedInstances),
  }));

  return {
    stage: {
      width: doc.width,
      height: doc.height,
      frameRate: doc.frameRate,
      backgroundColor: doc.backgroundColor,
    },
    symbols,
    media: {
      bitmaps: [...doc.bitmaps.values()].map((b) => b.name),
      sounds: [...doc.sounds.values()].map((s) => s.name),
      videos: [...doc.videos.values()].map((v) => v.name),
    },
    timelines,
    namedInstances,
    // For binary FLAs, surface the linkage/instance metadata the geometry decoder
    // can't reach, so the reporter can validate it on real files.
    ...(isOLE2(bytes) ? { binary: augmentBinary(bytes) } : {}),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const pretty = args.includes('--pretty');
  const path = args.find((a) => !a.startsWith('--'));
  if (!path) {
    console.error('Usage: node fla-structure.mjs <file.fla> [--pretty]');
    process.exit(2);
  }
  const json = await extractFlaStructure(new Uint8Array(readFileSync(path)));
  process.stdout.write(JSON.stringify(json, null, pretty ? 2 : 0) + '\n');
}

// Run as CLI only when invoked directly (not when imported).
if (process.argv[1] && /extract-fla-structure|fla-structure/.test(process.argv[1])) {
  main().catch((err) => {
    console.error('extract-fla-structure failed:', err);
    process.exit(1);
  });
}
