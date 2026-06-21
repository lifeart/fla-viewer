import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { FLAParser } from '../fla-parser';

// A Component Inspector / SWC component (SkyUI's CategoryList, TabularList, …)
// lives in the XFL library as a COMPILED CLIP — a <DOMCompiledClipItem>, not a
// <DOMSymbolItem>. It still carries the registerClass'd linkageClassName, so a
// stage instance referencing it must be typeable. These were silently dropped by
// loadSymbols (which only accepted DOMSymbolItem), so the instance's
// libraryItemName had no entry in doc.symbols and couldn't resolve its class.

async function zipToFile(files: Record<string, string>): Promise<File> {
  const zip = new JSZip();
  for (const [p, c] of Object.entries(files)) zip.file(p, c);
  const blob = await zip.generateAsync({ type: 'blob' });
  return new File([blob], 'test.fla', { type: 'application/octet-stream' });
}

const LIB_NAME = 'MovieClip/ CategoryList/CategoryList';

const DOMDOC = `<?xml version="1.0" encoding="UTF-8"?>
<DOMDocument width="550" height="400" frameRate="24" backgroundColor="#FFFFFF">
  <symbols><Include href="MovieClip/ CategoryList/CategoryList.xml"/></symbols>
  <timelines><DOMTimeline name="Scene 1"><layers><DOMLayer name="Layer 1"><frames>
    <DOMFrame index="0"><elements>
      <DOMComponentInstance libraryItemName="MovieClip/ CategoryList/CategoryList" name="categoryList">
        <matrix><Matrix/></matrix>
      </DOMComponentInstance>
    </elements></DOMFrame>
  </frames></DOMLayer></layers></DOMTimeline></timelines>
</DOMDocument>`;

const COMPILED_CLIP = `<?xml version="1.0" encoding="UTF-8"?>
<DOMCompiledClipItem name="MovieClip/ CategoryList/CategoryList" itemID="comp-1"
  linkageExportForAS="true" linkageClassName="CategoryList" linkageBaseClass="mx.core.UIComponent">
  <timeline><DOMTimeline name="CategoryList"><layers><DOMLayer name="Layer 1"><frames>
    <DOMFrame index="0"><elements></elements></DOMFrame>
  </frames></DOMLayer></layers></DOMTimeline></timeline>
</DOMCompiledClipItem>`;

describe('FLAParser: compiled-clip (component) library items', () => {
  it('loads a DOMCompiledClipItem into doc.symbols with its linkageClassName', async () => {
    const file = await zipToFile({
      'DOMDocument.xml': DOMDOC,
      'LIBRARY/MovieClip/ CategoryList/CategoryList.xml': COMPILED_CLIP,
    });
    const doc = await new FLAParser().parse(file);

    const sym = doc.symbols.get(LIB_NAME);
    expect(sym).toBeDefined();
    expect(sym?.linkageClassName).toBe('CategoryList');
    expect(sym?.linkageIdentifier ?? sym?.linkageClassName).toBeTruthy();
    expect(sym?.symbolType).toBe('movieclip'); // compiled clips default to movieclip

    // The stage instance resolves: its libraryItemName is now a key in doc.symbols.
    const inst = doc.timelines[0].layers
      .flatMap((l) => l.frames.flatMap((f) => f.elements))
      .find((e) => e.type === 'symbol');
    expect(inst && inst.type === 'symbol' && inst.libraryItemName).toBe(LIB_NAME);
    expect(doc.symbols.has((inst as { libraryItemName: string }).libraryItemName)).toBe(true);
  });
});
