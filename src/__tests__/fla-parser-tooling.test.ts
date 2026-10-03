import { describe, it, expect, vi, afterEach } from 'vitest';
import JSZip from 'jszip';
import { FLAParser } from '../fla-parser';
import type { DisplayElement, SymbolInstance, TextInstance } from '../types';

// Headless/tooling additions to the XFL parser (split from PR #44, issue #42):
// byte input, injectable DOMParser, structureOnly, instance names, linkage,
// component instances, compiled clips and frame ActionScript.

async function zipBytes(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return zip.generateAsync({ type: 'uint8array' });
}

function domDocument(elements: string, extra: { media?: string; symbols?: string; frameExtra?: string } = {}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<DOMDocument width="550" height="400" frameRate="24" backgroundColor="#FFFFFF">
  ${extra.media ?? ''}
  ${extra.symbols ?? ''}
  <timelines><DOMTimeline name="Scene 1"><layers><DOMLayer name="Layer 1"><frames>
    <DOMFrame index="0">${extra.frameExtra ?? ''}<elements>${elements}</elements></DOMFrame>
  </frames></DOMLayer></layers></DOMTimeline></timelines>
</DOMDocument>`;
}

function stageElements(doc: Awaited<ReturnType<FLAParser['parse']>>): DisplayElement[] {
  return doc.timelines[0].layers.flatMap((l) => l.frames.flatMap((f) => f.elements));
}

const SYMBOL_INSTANCE = `<DOMSymbolInstance libraryItemName="Hero" symbolType="movieclip" name="hero">
  <matrix><Matrix tx="10" ty="20"/></matrix>
</DOMSymbolInstance>`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('FLAParser input types', () => {
  it.each([
    ['Uint8Array', (b: Uint8Array) => b],
    ['ArrayBuffer', (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer],
    ['Blob', (b: Uint8Array) => new Blob([b as BlobPart])],
    ['File', (b: Uint8Array) => new File([b as BlobPart], 'x.fla')],
  ])('parses a %s', async (_label, wrap) => {
    const bytes = await zipBytes({ 'DOMDocument.xml': domDocument(SYMBOL_INSTANCE) });
    const doc = await new FLAParser().parse(wrap(bytes));
    expect(doc.width).toBe(550);
    expect(stageElements(doc)).toHaveLength(1);
  });

  it('parses a Uint8Array view that is offset into a larger buffer', async () => {
    const bytes = await zipBytes({ 'DOMDocument.xml': domDocument(SYMBOL_INSTANCE) });
    const backing = new Uint8Array(bytes.length + 16);
    backing.set(bytes, 8);
    const view = backing.subarray(8, 8 + bytes.length);
    const doc = await new FLAParser().parse(view);
    expect(stageElements(doc)).toHaveLength(1);
  });
});

describe('FLAParser DOMParser injection', () => {
  it('uses the injected DOMParser instead of the global', async () => {
    const calls: string[] = [];
    class SpyDOMParser {
      private inner = new DOMParser();
      parseFromString(source: string, mime: string): Document {
        calls.push(mime);
        return this.inner.parseFromString(source, mime as DOMParserSupportedType);
      }
    }
    const bytes = await zipBytes({ 'DOMDocument.xml': domDocument(SYMBOL_INSTANCE) });
    const doc = await new FLAParser({ DOMParser: SpyDOMParser }).parse(bytes);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((m) => m === 'text/xml')).toBe(true);
    expect(stageElements(doc)).toHaveLength(1);
  });

  it('throws a clear error when no DOMParser is available', () => {
    vi.stubGlobal('DOMParser', undefined);
    expect(() => new FLAParser()).toThrow(/no DOMParser available/);
  });
});

describe('FLAParser structureOnly', () => {
  const media = `<media>
    <DOMBitmapItem name="pic.png" href="pic.png"/>
    <DOMSoundItem name="beep.mp3" href="beep.mp3" soundDataHRef="beep.dat" format="44kHz 16bit Stereo"/>
    <DOMVideoItem name="clip.flv" videoDataHRef="clip.dat" fps="25" width="320" height="240" length="1"/>
  </media>`;

  async function parseWithSpies(options?: { structureOnly?: boolean }) {
    const proto = FLAParser.prototype as unknown as Record<string, (...args: unknown[]) => Promise<void>>;
    const bitmap = vi.spyOn(proto, 'loadBitmapImage').mockResolvedValue(undefined);
    const sound = vi.spyOn(proto, 'loadSoundAudio').mockResolvedValue(undefined);
    const video = vi.spyOn(proto, 'loadVideoFLV').mockResolvedValue(undefined);
    const bytes = await zipBytes({ 'DOMDocument.xml': domDocument('', { media }) });
    const doc = await new FLAParser().parse(bytes, undefined, undefined, options);
    return { doc, bitmap, sound, video };
  }

  it('skips bitmap, audio and video decoding but keeps item metadata', async () => {
    const { doc, bitmap, sound, video } = await parseWithSpies({ structureOnly: true });
    expect(bitmap).not.toHaveBeenCalled();
    expect(sound).not.toHaveBeenCalled();
    expect(video).not.toHaveBeenCalled();
    expect(doc.bitmaps.has('pic.png')).toBe(true);
    expect(doc.sounds.has('beep.mp3')).toBe(true);
    expect(doc.videos.get('clip.flv')?.width).toBe(320);
  });

  it('still decodes media by default', async () => {
    const { bitmap, sound, video } = await parseWithSpies();
    expect(bitmap).toHaveBeenCalledTimes(1);
    expect(sound).toHaveBeenCalledTimes(1);
    expect(video).toHaveBeenCalledTimes(1);
  });
});

describe('FLAParser instance names and text kinds', () => {
  it('captures the instance name on symbol instances and omits it when unnamed', async () => {
    const bytes = await zipBytes({
      'DOMDocument.xml': domDocument(
        SYMBOL_INSTANCE + '<DOMSymbolInstance libraryItemName="Tree"><matrix><Matrix/></matrix></DOMSymbolInstance>'
      ),
    });
    const [named, unnamed] = stageElements(await new FLAParser().parse(bytes)) as SymbolInstance[];
    expect(named.name).toBe('hero');
    expect(named.matrix.tx).toBe(10);
    expect(unnamed.name).toBeUndefined();
    expect('name' in unnamed).toBe(false);
  });

  it('captures text field names and kinds', async () => {
    const run = '<textRuns><DOMTextRun><characters>x</characters></DOMTextRun></textRuns>';
    const bytes = await zipBytes({
      'DOMDocument.xml': domDocument(
        `<DOMStaticText width="50" height="20">${run}</DOMStaticText>` +
        `<DOMDynamicText name="score_tf" width="50" height="20">${run}</DOMDynamicText>` +
        `<DOMInputText name="name_tf" width="50" height="20">${run}</DOMInputText>`
      ),
    });
    const [stat, dyn, input] = stageElements(await new FLAParser().parse(bytes)) as TextInstance[];
    expect(stat).toMatchObject({ type: 'text', textType: 'static' });
    expect(stat.name).toBeUndefined();
    expect(dyn).toMatchObject({ type: 'text', textType: 'dynamic', name: 'score_tf' });
    expect(input).toMatchObject({ type: 'text', textType: 'input', name: 'name_tf' });
  });
});

describe('FLAParser components', () => {
  const COMPONENT = `<DOMComponentInstance libraryItemName="List" name="itemList">
    <matrix><Matrix tx="5"/></matrix>
    <persistentData>
      <PD n="rowCount" t="0" v="8"/>
      <PD n="enabled" v="true"/>
      <PD v="ignored-without-name"/>
    </persistentData>
  </DOMComponentInstance>`;

  it('parses DOMComponentInstance as a named movieclip with its parameters', async () => {
    const bytes = await zipBytes({ 'DOMDocument.xml': domDocument(COMPONENT) });
    const [inst] = stageElements(await new FLAParser().parse(bytes)) as SymbolInstance[];
    expect(inst).toMatchObject({ type: 'symbol', libraryItemName: 'List', name: 'itemList', symbolType: 'movieclip' });
    expect(inst.matrix.tx).toBe(5);
    expect(inst.componentParameters).toEqual([
      { name: 'rowCount', value: '8', type: '0' },
      { name: 'enabled', value: 'true' },
    ]);
  });

  it('parses DOMComponentInstance inside a group', async () => {
    const bytes = await zipBytes({
      'DOMDocument.xml': domDocument(`<DOMGroup><members>${COMPONENT}</members></DOMGroup>`),
    });
    const elements = stageElements(await new FLAParser().parse(bytes));
    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({ type: 'symbol', name: 'itemList', symbolType: 'movieclip' });
  });

  it('leaves componentParameters unset on plain symbol instances', async () => {
    const bytes = await zipBytes({ 'DOMDocument.xml': domDocument(SYMBOL_INSTANCE) });
    const [inst] = stageElements(await new FLAParser().parse(bytes)) as SymbolInstance[];
    expect(inst.componentParameters).toBeUndefined();
  });

  it('loads a DOMCompiledClipItem into doc.symbols as a movieclip with linkage', async () => {
    const libName = 'MovieClip/ CategoryList/CategoryList';
    const bytes = await zipBytes({
      'DOMDocument.xml': domDocument(
        `<DOMComponentInstance libraryItemName="${libName}" name="categoryList"><matrix><Matrix/></matrix></DOMComponentInstance>`,
        { symbols: `<symbols><Include href="${libName}.xml"/></symbols>` }
      ),
      [`LIBRARY/${libName}.xml`]: `<?xml version="1.0" encoding="UTF-8"?>
<DOMCompiledClipItem name="${libName}" itemID="comp-1" linkageExportForAS="true"
  linkageClassName="CategoryList" linkageBaseClass="mx.core.UIComponent">
  <timeline><DOMTimeline name="CategoryList"><layers><DOMLayer name="Layer 1"><frames>
    <DOMFrame index="0"><elements></elements></DOMFrame>
  </frames></DOMLayer></layers></DOMTimeline></timeline>
</DOMCompiledClipItem>`,
    });
    const doc = await new FLAParser().parse(bytes);
    const sym = doc.symbols.get(libName);
    expect(sym).toMatchObject({
      symbolType: 'movieclip',
      linkageExportForAS: true,
      linkageClassName: 'CategoryList',
      linkageBaseClass: 'mx.core.UIComponent',
    });
    const [inst] = stageElements(doc) as SymbolInstance[];
    expect(doc.symbols.has(inst.libraryItemName)).toBe(true);
  });
});

describe('FLAParser linkage and frame scripts', () => {
  it('reads linkage attributes from DOMSymbolItem and omits them when absent', async () => {
    const item = (name: string, attrs: string) => `<?xml version="1.0" encoding="UTF-8"?>
<DOMSymbolItem name="${name}" symbolType="movieclip" ${attrs}>
  <timeline><DOMTimeline name="${name}"><layers><DOMLayer name="L"><frames>
    <DOMFrame index="0"><elements></elements></DOMFrame>
  </frames></DOMLayer></layers></DOMTimeline></timeline>
</DOMSymbolItem>`;
    const bytes = await zipBytes({
      'DOMDocument.xml': domDocument('', {
        symbols: '<symbols><Include href="Card.xml"/><Include href="Plain.xml"/></symbols>',
      }),
      'LIBRARY/Card.xml': item('Card', 'linkageExportForAS="true" linkageClassName="ui.Card" linkageIdentifier="CardId"'),
      'LIBRARY/Plain.xml': item('Plain', ''),
    });
    const doc = await new FLAParser().parse(bytes);
    expect(doc.symbols.get('Card')).toMatchObject({
      linkageExportForAS: true,
      linkageClassName: 'ui.Card',
      linkageIdentifier: 'CardId',
    });
    const plain = doc.symbols.get('Plain')!;
    expect(plain.linkageExportForAS).toBeUndefined();
    expect(plain.linkageClassName).toBeUndefined();
    expect(plain.linkageIdentifier).toBeUndefined();
  });

  it('captures a keyframe ActionScript block, trimmed', async () => {
    const bytes = await zipBytes({
      'DOMDocument.xml': domDocument('', {
        frameExtra: '<Actionscript><script><![CDATA[\n  stop();\n  hero._x = 10;\n]]></script></Actionscript>',
      }),
    });
    const doc = await new FLAParser().parse(bytes);
    expect(doc.timelines[0].layers[0].frames[0].actionScript).toBe('stop();\n  hero._x = 10;');
  });

  it('leaves actionScript unset for frames without a script or with an empty one', async () => {
    const empty = await zipBytes({
      'DOMDocument.xml': domDocument('', { frameExtra: '<Actionscript><script><![CDATA[  ]]></script></Actionscript>' }),
    });
    const none = await zipBytes({ 'DOMDocument.xml': domDocument('') });
    for (const bytes of [empty, none]) {
      const doc = await new FLAParser().parse(bytes);
      expect(doc.timelines[0].layers[0].frames[0].actionScript).toBeUndefined();
    }
  });
});
