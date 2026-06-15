/**
 * Issue #42 verification tool — extract the timeline structure + element types
 * from a `.fla` as plain JSON, headless under Node (the VS Code extension-host
 * environment). No rendering, no media decoding, no npm package: just a single
 * bundled file the reporter can run against their OWN ActionScript 2.0 files to
 * confirm the parser surfaces what a completion provider needs:
 *
 *   - the library symbols (the available types), and
 *   - every named Stage instance on the timeline mapped to its type.
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
import type { DisplayElement, Matrix } from '../src/types';

export interface InstanceJSON {
  type: DisplayElement['type'];
  /** Instance name (the AS2 identifier), when the instance is named. */
  name?: string;
  /** Library item this instance points at (symbols, bitmaps, videos). */
  libraryItemName?: string;
  /** symbol | movieclip | button — the "type" a completion provider reports. */
  symbolType?: 'graphic' | 'movieclip' | 'button';
  loop?: string;
  /** Concatenated text content, for text instances. */
  text?: string;
  /** Placement on stage; tx/ty are the x/y position. */
  matrix?: Matrix;
}

export interface NamedInstanceJSON {
  name: string;
  symbolType?: 'graphic' | 'movieclip' | 'button';
  libraryItemName?: string;
  timeline: string;
  layer: string;
  frame: number;
}

export interface StructureJSON {
  stage: { width: number; height: number; frameRate: number; backgroundColor: string };
  /** Library symbols = the candidate types a completion provider can offer. */
  symbols: { name: string; itemID: string; symbolType: 'graphic' | 'movieclip' | 'button' }[];
  media: { bitmaps: string[]; sounds: string[]; videos: string[] };
  timelines: {
    name: string;
    totalFrames: number;
    layers: {
      name: string;
      layerType: string;
      visible: boolean;
      frames: { index: number; duration: number; label?: string; elements: InstanceJSON[] }[];
    }[];
  }[];
  /** Flat index of every NAMED stage instance → its type. The core of the use case. */
  namedInstances: NamedInstanceJSON[];
}

function elementToJSON(el: DisplayElement): InstanceJSON {
  switch (el.type) {
    case 'symbol':
      return {
        type: 'symbol',
        name: el.name,
        libraryItemName: el.libraryItemName,
        symbolType: el.symbolType,
        loop: el.loop,
        matrix: el.matrix,
      };
    case 'text':
      return {
        type: 'text',
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

export async function extractFlaStructure(
  bytes: Uint8Array,
  domParser: typeof globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser
): Promise<StructureJSON> {
  const parser = new FLAParser({ DOMParser: domParser });
  const doc = await parser.parse(bytes, undefined, undefined, { structureOnly: true });

  const namedInstances: NamedInstanceJSON[] = [];

  const timelines = doc.timelines.map((tl) => ({
    name: tl.name,
    totalFrames: tl.totalFrames,
    layers: tl.layers.map((layer) => ({
      name: layer.name,
      layerType: layer.layerType ?? 'normal',
      visible: layer.visible,
      frames: layer.frames
        .filter((f) => f.elements.length > 0)
        .map((frame) => {
          const elements = frame.elements.map(elementToJSON);
          for (const el of elements) {
            if (el.name) {
              namedInstances.push({
                name: el.name,
                symbolType: el.symbolType,
                libraryItemName: el.libraryItemName,
                timeline: tl.name,
                layer: layer.name,
                frame: frame.index,
              });
            }
          }
          return {
            index: frame.index,
            duration: frame.duration,
            ...(frame.label ? { label: frame.label } : {}),
            elements,
          };
        }),
    })),
  }));

  return {
    stage: {
      width: doc.width,
      height: doc.height,
      frameRate: doc.frameRate,
      backgroundColor: doc.backgroundColor,
    },
    symbols: [...doc.symbols.values()].map((s) => ({
      name: s.name,
      itemID: s.itemID,
      symbolType: s.symbolType,
    })),
    media: {
      bitmaps: [...doc.bitmaps.values()].map((b) => b.name),
      sounds: [...doc.sounds.values()].map((s) => s.name),
      videos: [...doc.videos.values()].map((v) => v.name),
    },
    timelines,
    namedInstances,
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
