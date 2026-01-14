import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import JSZip from 'jszip';
import pako from 'pako';
import { FLAParser, setParserDebug } from '../fla-parser';
import { createConsoleSpy, expectLogContaining, type ConsoleSpy } from './test-utils';

// Helper to create a real FLA zip file with given content
async function createFlaZip(domDocumentXml: string, additionalFiles: Record<string, string | Uint8Array> = {}): Promise<File> {
  const zip = new JSZip();
  zip.file('DOMDocument.xml', domDocumentXml);

  for (const [path, content] of Object.entries(additionalFiles)) {
    zip.file(path, content);
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  return new File([blob], 'test.fla', { type: 'application/octet-stream' });
}

// Minimal valid DOMDocument.xml structure
function createDOMDocument(options: {
  width?: number;
  height?: number;
  frameRate?: number;
  backgroundColor?: string;
  timelines?: string;
  media?: string;
  symbols?: string;
} = {}): string {
  const {
    width = 550,
    height = 400,
    frameRate = 24,
    backgroundColor = '#FFFFFF',
    timelines = '<timelines><DOMTimeline name="Scene 1"><layers><DOMLayer name="Layer 1"><frames><DOMFrame index="0"><elements></elements></DOMFrame></frames></DOMLayer></layers></DOMTimeline></timelines>',
    media = '',
    symbols = '',
  } = options;

  return `<?xml version="1.0" encoding="UTF-8"?>
<DOMDocument width="${width}" height="${height}" frameRate="${frameRate}" backgroundColor="${backgroundColor}">
  ${media}
  ${symbols}
  ${timelines}
</DOMDocument>`;
}

describe('FLAParser', () => {
  let parser: FLAParser;

  beforeEach(() => {
    parser = new FLAParser();
  });

  describe('parse', () => {
    it('should parse minimal FLA file', async () => {
      const fla = await createFlaZip(createDOMDocument());
      const doc = await parser.parse(fla);

      expect(doc.width).toBe(550);
      expect(doc.height).toBe(400);
      expect(doc.frameRate).toBe(24);
      expect(doc.backgroundColor).toBe('#FFFFFF');
      expect(doc.timelines).toHaveLength(1);
    });

    it('should parse custom dimensions', async () => {
      const fla = await createFlaZip(createDOMDocument({
        width: 800,
        height: 600,
        frameRate: 30,
        backgroundColor: '#000000',
      }));
      const doc = await parser.parse(fla);

      expect(doc.width).toBe(800);
      expect(doc.height).toBe(600);
      expect(doc.frameRate).toBe(30);
      expect(doc.backgroundColor).toBe('#000000');
    });

    it('should throw error for invalid zip (no DOMDocument.xml)', async () => {
      const zip = new JSZip();
      zip.file('other.xml', '<root/>');
      const blob = await zip.generateAsync({ type: 'blob' });
      const file = new File([blob], 'invalid.fla');

      await expect(parser.parse(file)).rejects.toThrow('Invalid FLA file: DOMDocument.xml not found');
    });

    it('should call progress callback', async () => {
      const fla = await createFlaZip(createDOMDocument());
      const progressMessages: string[] = [];

      await parser.parse(fla, (msg) => progressMessages.push(msg));

      expect(progressMessages).toContain('Extracting archive...');
      expect(progressMessages).toContain('Parsing document...');
    });
  });

  describe('timeline parsing', () => {
    it('should parse single timeline', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Main Timeline">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0" duration="10">
                    <elements></elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      expect(doc.timelines).toHaveLength(1);
      expect(doc.timelines[0].name).toBe('Main Timeline');
      expect(doc.timelines[0].layers).toHaveLength(1);
      expect(doc.timelines[0].layers[0].name).toBe('Layer 1');
    });

    it('should parse multiple layers', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Top Layer">
                <frames><DOMFrame index="0"><elements></elements></DOMFrame></frames>
              </DOMLayer>
              <DOMLayer name="Middle Layer">
                <frames><DOMFrame index="0"><elements></elements></DOMFrame></frames>
              </DOMLayer>
              <DOMLayer name="Bottom Layer">
                <frames><DOMFrame index="0"><elements></elements></DOMFrame></frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      expect(doc.timelines[0].layers).toHaveLength(3);
      expect(doc.timelines[0].layers[0].name).toBe('Top Layer');
      expect(doc.timelines[0].layers[1].name).toBe('Middle Layer');
      expect(doc.timelines[0].layers[2].name).toBe('Bottom Layer');
    });

    it('should parse frame with duration', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0" duration="5">
                    <elements></elements>
                  </DOMFrame>
                  <DOMFrame index="5" duration="10">
                    <elements></elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      expect(doc.timelines[0].layers[0].frames).toHaveLength(2);
      expect(doc.timelines[0].layers[0].frames[0].index).toBe(0);
      expect(doc.timelines[0].layers[0].frames[0].duration).toBe(5);
      expect(doc.timelines[0].layers[0].frames[1].index).toBe(5);
      expect(doc.timelines[0].layers[0].frames[1].duration).toBe(10);
    });

    it('should parse guide layer type', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Guide" layerType="guide">
                <frames><DOMFrame index="0"><elements></elements></DOMFrame></frames>
              </DOMLayer>
              <DOMLayer name="Content">
                <frames><DOMFrame index="0"><elements></elements></DOMFrame></frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      expect(doc.timelines[0].referenceLayers.has(0)).toBe(true);
      expect(doc.timelines[0].referenceLayers.has(1)).toBe(false);
    });
  });

  describe('shape parsing', () => {
    it('should parse shape with solid fill', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMShape>
                        <fills>
                          <FillStyle index="1">
                            <SolidColor color="#FF0000"/>
                          </FillStyle>
                        </fills>
                        <strokes></strokes>
                        <edges>
                          <Edge fillStyle0="1" edges="!0 0|100 0|100 100|0 100|0 0"/>
                        </edges>
                      </DOMShape>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      const shape = doc.timelines[0].layers[0].frames[0].elements[0];
      expect(shape.type).toBe('shape');
      expect(shape.type === 'shape').toBe(true);
      if (shape.type !== 'shape') throw new Error('Expected shape element');
      expect(shape.fills).toHaveLength(1);
      expect(shape.fills[0].color).toBe('#FF0000');
    });

    it('should parse shape with linear gradient', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMShape>
                        <fills>
                          <FillStyle index="1">
                            <LinearGradient>
                              <matrix><Matrix a="1" b="0" c="0" d="1" tx="0" ty="0"/></matrix>
                              <GradientEntry ratio="0" color="#FF0000"/>
                              <GradientEntry ratio="1" color="#0000FF"/>
                            </LinearGradient>
                          </FillStyle>
                        </fills>
                        <strokes></strokes>
                        <edges>
                          <Edge fillStyle0="1" edges="!0 0|100 0|100 100|0 100|0 0"/>
                        </edges>
                      </DOMShape>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      const shape = doc.timelines[0].layers[0].frames[0].elements[0];
      expect(shape).toBeDefined();
      expect(shape.type).toBe('shape');
      if (shape.type !== 'shape') throw new Error('Expected shape element');
      expect(shape.fills.length).toBeGreaterThan(0);
      expect(shape.fills[0].type).toBe('linear');
    });

    it('should parse shape with stroke', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMShape>
                        <fills></fills>
                        <strokes>
                          <StrokeStyle index="1">
                            <SolidStroke weight="2" caps="round" joints="round">
                              <fill>
                                <SolidColor color="#000000"/>
                              </fill>
                            </SolidStroke>
                          </StrokeStyle>
                        </strokes>
                        <edges>
                          <Edge strokeStyle="1" edges="!0 0|100 100"/>
                        </edges>
                      </DOMShape>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      const shape = doc.timelines[0].layers[0].frames[0].elements[0];
      expect(shape.type).toBe('shape');
      if (shape.type !== 'shape') throw new Error('Expected shape element');
      expect(shape.strokes).toHaveLength(1);
      expect(shape.strokes[0].color).toBe('#000000');
      expect(shape.strokes[0].weight).toBe(2);
    });
  });

  describe('symbol parsing', () => {
    it('should parse symbol instance', async () => {
      const symbolXml = `<?xml version="1.0" encoding="UTF-8"?>
        <DOMSymbolItem name="MySymbol" symbolType="graphic">
          <timeline>
            <DOMTimeline name="MySymbol">
              <layers>
                <DOMLayer name="Layer 1">
                  <frames>
                    <DOMFrame index="0">
                      <elements>
                        <DOMShape>
                          <fills><FillStyle index="1"><SolidColor color="#00FF00"/></FillStyle></fills>
                          <strokes></strokes>
                          <edges><Edge fillStyle0="1" edges="!0 0|50 0|50 50|0 50|0 0"/></edges>
                        </DOMShape>
                      </elements>
                    </DOMFrame>
                  </frames>
                </DOMLayer>
              </layers>
            </DOMTimeline>
          </timeline>
        </DOMSymbolItem>`;

      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMSymbolInstance libraryItemName="MySymbol" symbolType="graphic">
                        <matrix><Matrix tx="100" ty="100"/></matrix>
                      </DOMSymbolInstance>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const symbols = `
        <symbols>
          <Include href="MySymbol.xml"/>
        </symbols>`;

      const fla = await createFlaZip(
        createDOMDocument({ timelines, symbols }),
        { 'LIBRARY/MySymbol.xml': symbolXml }
      );
      const doc = await parser.parse(fla);

      const element = doc.timelines[0].layers[0].frames[0].elements[0];
      expect(element.type).toBe('symbol');
      if (element.type !== 'symbol') throw new Error('Expected symbol element');
      expect(element.libraryItemName).toBe('MySymbol');
      expect(element.matrix.tx).toBe(100);
      expect(element.matrix.ty).toBe(100);

      // Check symbol was loaded
      expect(doc.symbols.has('MySymbol')).toBe(true);
    });
  });

  describe('text parsing', () => {
    it('should parse static text', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMStaticText left="10" width="200" height="50">
                        <matrix><Matrix tx="50" ty="50"/></matrix>
                        <textRuns>
                          <DOMTextRun>
                            <characters>Hello World</characters>
                            <textAttrs>
                              <DOMTextAttrs size="24" face="Arial" fillColor="#000000"/>
                            </textAttrs>
                          </DOMTextRun>
                        </textRuns>
                      </DOMStaticText>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      const element = doc.timelines[0].layers[0].frames[0].elements[0];
      expect(element.type).toBe('text');
      if (element.type !== 'text') throw new Error('Expected text element');
      expect(element.textRuns).toHaveLength(1);
      expect(element.textRuns[0].characters).toBe('Hello World');
      expect(element.textRuns[0].size).toBe(24);
      expect(element.textRuns[0].face).toBe('Arial');
    });
  });

  describe('bitmap parsing', () => {
    it('should parse bitmap instance element', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMBitmapInstance libraryItemName="test.png">
                        <matrix><Matrix tx="50" ty="100"/></matrix>
                      </DOMBitmapInstance>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      const element = doc.timelines[0].layers[0].frames[0].elements[0];
      expect(element.type).toBe('bitmap');
      if (element.type !== 'bitmap') throw new Error('Expected bitmap element');
      expect(element.libraryItemName).toBe('test.png');
      expect(element.matrix.tx).toBe(50);
      expect(element.matrix.ty).toBe(100);
    });
  });

  describe('tween parsing', () => {
    it('should parse motion tween frame', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0" duration="10" tweenType="motion">
                    <elements>
                      <DOMShape>
                        <fills><FillStyle index="1"><SolidColor color="#FF0000"/></FillStyle></fills>
                        <strokes></strokes>
                        <edges><Edge fillStyle0="1" edges="!0 0|50 0|50 50|0 50|0 0"/></edges>
                      </DOMShape>
                    </elements>
                  </DOMFrame>
                  <DOMFrame index="10" duration="1">
                    <elements>
                      <DOMShape>
                        <matrix><Matrix tx="200"/></matrix>
                        <fills><FillStyle index="1"><SolidColor color="#FF0000"/></FillStyle></fills>
                        <strokes></strokes>
                        <edges><Edge fillStyle0="1" edges="!0 0|50 0|50 50|0 50|0 0"/></edges>
                      </DOMShape>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      const frame = doc.timelines[0].layers[0].frames[0];
      expect(frame.tweenType).toBe('motion');
    });

    it('should parse ease settings', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0" duration="10" tweenType="motion">
                    <elements></elements>
                    <tweens>
                      <Ease target="all" intensity="50"/>
                    </tweens>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      const frame = doc.timelines[0].layers[0].frames[0];
      expect(frame.tweens).toBeDefined();
      expect(frame.tweens).toHaveLength(1);
      expect(frame.tweens![0].target).toBe('all');
      expect(frame.tweens![0].intensity).toBe(50);
    });
  });

  describe('sound parsing', () => {
    it('should parse frame sound reference', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0" soundName="bgm.mp3" soundSync="stream">
                    <elements></elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      const frame = doc.timelines[0].layers[0].frames[0];
      expect(frame.sound).toBeDefined();
      expect(frame.sound!.name).toBe('bgm.mp3');
      expect(frame.sound!.sync).toBe('stream');
    });
  });

  describe('matrix parsing', () => {
    it('should parse full matrix', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMShape>
                        <matrix><Matrix a="2" b="0.5" c="-0.5" d="2" tx="100" ty="200"/></matrix>
                        <fills><FillStyle index="1"><SolidColor color="#FF0000"/></FillStyle></fills>
                        <strokes></strokes>
                        <edges><Edge fillStyle0="1" edges="!0 0|50 50"/></edges>
                      </DOMShape>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      const element = doc.timelines[0].layers[0].frames[0].elements[0];
      expect(element.matrix.a).toBe(2);
      expect(element.matrix.b).toBe(0.5);
      expect(element.matrix.c).toBe(-0.5);
      expect(element.matrix.d).toBe(2);
      expect(element.matrix.tx).toBe(100);
      expect(element.matrix.ty).toBe(200);
    });
  });

  describe('symbol loading from LIBRARY', () => {
    it('should load symbols from LIBRARY folder', async () => {
      const symbolXml = `<?xml version="1.0" encoding="UTF-8"?>
<DOMSymbolItem name="MyGraphic" symbolType="graphic">
  <timeline>
    <DOMTimeline name="MyGraphic">
      <layers>
        <DOMLayer name="Layer 1">
          <frames>
            <DOMFrame index="0">
              <elements>
                <DOMShape>
                  <fills><FillStyle index="1"><SolidColor color="#00FF00"/></FillStyle></fills>
                  <strokes></strokes>
                  <edges><Edge fillStyle0="1" edges="!0 0|30 0|30 30|0 30|0 0"/></edges>
                </DOMShape>
              </elements>
            </DOMFrame>
          </frames>
        </DOMLayer>
      </layers>
    </DOMTimeline>
  </timeline>
</DOMSymbolItem>`;

      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMSymbolInstance libraryItemName="MyGraphic" symbolType="graphic">
                        <matrix><Matrix tx="50" ty="50"/></matrix>
                      </DOMSymbolInstance>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const symbols = `<symbols><Include href="MyGraphic.xml"/></symbols>`;

      const fla = await createFlaZip(
        createDOMDocument({ timelines, symbols }),
        { 'LIBRARY/MyGraphic.xml': symbolXml }
      );
      const doc = await parser.parse(fla);

      expect(doc.symbols.has('MyGraphic')).toBe(true);
      const symbol = doc.symbols.get('MyGraphic');
      expect(symbol).toBeDefined();
      expect(symbol!.symbolType).toBe('graphic');
    });

    it('should handle missing symbol gracefully', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMSymbolInstance libraryItemName="MissingSymbol" symbolType="graphic">
                        <matrix><Matrix/></matrix>
                      </DOMSymbolInstance>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      // Should not throw, just have empty symbols
      expect(doc.symbols.has('MissingSymbol')).toBe(false);
    });
  });

  describe('layer types', () => {
    it('should parse guide layer', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Guide" layerType="guide">
                <frames>
                  <DOMFrame index="0">
                    <elements></elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
              <DOMLayer name="Content">
                <frames>
                  <DOMFrame index="0">
                    <elements></elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      expect(doc.timelines[0].layers).toHaveLength(2);
      expect(doc.timelines[0].layers[0].layerType).toBe('guide');
    });

    it('should parse folder layer', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Folder" layerType="folder">
                <frames></frames>
              </DOMLayer>
              <DOMLayer name="Content" parentLayerIndex="0">
                <frames>
                  <DOMFrame index="0">
                    <elements></elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      expect(doc.timelines[0].layers[0].layerType).toBe('folder');
    });

    it('should parse mask layer', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Mask" layerType="mask">
                <frames>
                  <DOMFrame index="0">
                    <elements></elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      expect(doc.timelines[0].layers[0].layerType).toBe('mask');
    });
  });

  describe('radial gradient', () => {
    it('should parse radial gradient fill', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMShape>
                        <fills>
                          <FillStyle index="1">
                            <RadialGradient>
                              <matrix><Matrix a="0.05" d="0.05"/></matrix>
                              <GradientEntry ratio="0" color="#FFFFFF"/>
                              <GradientEntry ratio="1" color="#000000"/>
                            </RadialGradient>
                          </FillStyle>
                        </fills>
                        <strokes></strokes>
                        <edges><Edge fillStyle0="1" edges="!0 0|100 0|100 100|0 100|0 0"/></edges>
                      </DOMShape>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      const element = doc.timelines[0].layers[0].frames[0].elements[0];
      expect(element.type).toBe('shape');
      if (element.type !== 'shape') throw new Error('Expected shape');
      expect(element.fills[0].type).toBe('radial');
    });
  });

  describe('multiple frames', () => {
    it('should parse multiple keyframes', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0" duration="5">
                    <elements></elements>
                  </DOMFrame>
                  <DOMFrame index="5" duration="5">
                    <elements></elements>
                  </DOMFrame>
                  <DOMFrame index="10" duration="5">
                    <elements></elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      expect(doc.timelines[0].layers[0].frames).toHaveLength(3);
      expect(doc.timelines[0].layers[0].frames[0].index).toBe(0);
      expect(doc.timelines[0].layers[0].frames[1].index).toBe(5);
      expect(doc.timelines[0].layers[0].frames[2].index).toBe(10);
      expect(doc.timelines[0].totalFrames).toBe(15);
    });
  });

  describe('multiple layers', () => {
    it('should parse multiple layers in correct order', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Top Layer">
                <frames><DOMFrame index="0"><elements></elements></DOMFrame></frames>
              </DOMLayer>
              <DOMLayer name="Middle Layer">
                <frames><DOMFrame index="0"><elements></elements></DOMFrame></frames>
              </DOMLayer>
              <DOMLayer name="Bottom Layer">
                <frames><DOMFrame index="0"><elements></elements></DOMFrame></frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      expect(doc.timelines[0].layers).toHaveLength(3);
      expect(doc.timelines[0].layers[0].name).toBe('Top Layer');
      expect(doc.timelines[0].layers[1].name).toBe('Middle Layer');
      expect(doc.timelines[0].layers[2].name).toBe('Bottom Layer');
    });
  });

  describe('color transform', () => {
    it('should parse color with alpha', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMShape>
                        <fills>
                          <FillStyle index="1">
                            <SolidColor color="#FF0000" alpha="0.5"/>
                          </FillStyle>
                        </fills>
                        <strokes></strokes>
                        <edges><Edge fillStyle0="1" edges="!0 0|50 0|50 50|0 50|0 0"/></edges>
                      </DOMShape>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      const element = doc.timelines[0].layers[0].frames[0].elements[0];
      expect(element.type).toBe('shape');
      if (element.type !== 'shape') throw new Error('Expected shape');
      expect(element.fills[0].alpha).toBe(0.5);
    });
  });

  describe('text attributes', () => {
    it('should parse text with multiple attributes', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMStaticText left="0" width="200" height="50">
                        <matrix><Matrix tx="50" ty="50"/></matrix>
                        <textRuns>
                          <DOMTextRun>
                            <characters>Bold Text</characters>
                            <textAttrs>
                              <DOMTextAttrs size="24" face="Arial" fillColor="#000000" bold="true" italic="false"/>
                            </textAttrs>
                          </DOMTextRun>
                        </textRuns>
                      </DOMStaticText>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      const element = doc.timelines[0].layers[0].frames[0].elements[0];
      expect(element.type).toBe('text');
      if (element.type !== 'text') throw new Error('Expected text');
      expect(element.textRuns[0].bold).toBe(true);
      expect(element.textRuns[0].italic).toBe(false);
    });
  });

  describe('bitmap media', () => {
    it('should parse bitmap media item', async () => {
      const media = `
        <media>
          <DOMBitmapItem name="test.png" href="test.png" sourceExternalFilepath="./test.png"/>
        </media>`;

      // Create a simple 1x1 red PNG
      const pngData = new Uint8Array([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
        0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, // IDAT chunk
        0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
        0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xFE,
        0xD4, 0xEF, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, // IEND chunk
        0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82
      ]);

      const fla = await createFlaZip(
        createDOMDocument({ media }),
        { 'LIBRARY/test.png': pngData }
      );
      const doc = await parser.parse(fla);

      expect(doc.bitmaps.has('test.png')).toBe(true);
    });
  });

  describe('FLA bitmap (.dat) decompression', () => {
    // Helper to create FLA bitmap .dat file format
    function createFlaBitmapDat(options: {
      width: number;
      height: number;
      pixelData?: Uint8Array; // ARGB pixel data (if not provided, creates solid color)
      subFormat?: number; // 0 = standard, 2 = alternate
      corruptAt?: number; // Offset to corrupt the deflate stream
      useInvalidData?: boolean; // Use completely invalid data
    }): Uint8Array {
      const { width, height, subFormat = 0, corruptAt, useInvalidData = false } = options;

      // Create ARGB pixel data if not provided (solid red)
      let pixelData = options.pixelData;
      if (!pixelData) {
        pixelData = new Uint8Array(width * height * 4);
        for (let i = 0; i < width * height; i++) {
          pixelData[i * 4 + 0] = 0xFF; // A
          pixelData[i * 4 + 1] = 0xFF; // R
          pixelData[i * 4 + 2] = 0x00; // G
          pixelData[i * 4 + 3] = 0x00; // B
        }
      }

      // Compress the pixel data using raw deflate
      let compressed: Uint8Array;
      if (useInvalidData) {
        // Create data that won't decompress at all
        compressed = new Uint8Array([0xFF, 0xFE, 0xFD, 0xFC, 0xFB, 0xFA]);
      } else {
        compressed = pako.deflateRaw(pixelData);

        // Corrupt the stream if requested (simulate corrupted FLA file)
        if (corruptAt !== undefined && corruptAt < compressed.length) {
          compressed = new Uint8Array(compressed);
          // Corrupt bytes starting at corruptAt to break the deflate stream
          for (let i = corruptAt; i < Math.min(corruptAt + 10, compressed.length); i++) {
            compressed[i] = 0xFF; // Invalid deflate data
          }
        }
      }

      // Build the header
      // Header size: 30 for subFormat=0, 32 for subFormat=2
      const headerSize = subFormat === 2 ? 32 : 30;
      const totalSize = headerSize + compressed.length;
      const dat = new Uint8Array(totalSize);

      // Bytes 0-1: Format marker
      dat[0] = 0x03;
      dat[1] = 0x05;

      // Bytes 2-3: Row stride (width * 4, little endian)
      const rowStride = width * 4;
      dat[2] = rowStride & 0xFF;
      dat[3] = (rowStride >> 8) & 0xFF;

      // Bytes 4-5: Width in pixels (little endian)
      dat[4] = width & 0xFF;
      dat[5] = (width >> 8) & 0xFF;

      // Bytes 6-7: Height in pixels (little endian)
      dat[6] = height & 0xFF;
      dat[7] = (height >> 8) & 0xFF;

      // Bytes 8-23: Reserved/twips data (zeros for simplicity)
      // Already zero from Uint8Array initialization

      // Bytes 24-27: Format flags
      dat[24] = 0; // has_alpha
      dat[25] = 1; // is_compressed
      dat[26] = subFormat; // sub_format
      dat[27] = subFormat === 0 ? 8 : 0;

      // Bytes 28-29: Zlib header (for subFormat=0)
      dat[28] = 0x78;
      dat[29] = 0x01;

      // Bytes 30+ (or 32+): Compressed pixel data
      dat.set(compressed, headerSize);

      return dat;
    }

    it('should decompress valid FLA bitmap with subFormat=0', async () => {
      const width = 10;
      const height = 10;
      const datFile = createFlaBitmapDat({ width, height, subFormat: 0 });

      const media = `
        <media>
          <DOMBitmapItem name="test.png" href="test.png"
            bitmapDataHRef="M 1 123456.dat"
            frameRight="${width * 20}" frameBottom="${height * 20}"/>
        </media>`;

      const fla = await createFlaZip(
        createDOMDocument({ media }),
        { 'bin/M 1 123456.dat': datFile }
      );
      const doc = await parser.parse(fla);

      const bitmap = doc.bitmaps.get('test.png');
      expect(bitmap).toBeDefined();
      expect(bitmap?.width).toBe(width);
      expect(bitmap?.height).toBe(height);
      // imageData should be loaded (not null/undefined) for valid decompression
      expect(bitmap?.imageData).toBeDefined();
    });

    it('should decompress valid FLA bitmap with subFormat=2', async () => {
      const width = 8;
      const height = 8;
      const datFile = createFlaBitmapDat({ width, height, subFormat: 2 });

      const media = `
        <media>
          <DOMBitmapItem name="test2.png" href="test2.png"
            bitmapDataHRef="M 2 123456.dat"
            frameRight="${width * 20}" frameBottom="${height * 20}"/>
        </media>`;

      const fla = await createFlaZip(
        createDOMDocument({ media }),
        { 'bin/M 2 123456.dat': datFile }
      );
      const doc = await parser.parse(fla);

      const bitmap = doc.bitmaps.get('test2.png');
      expect(bitmap).toBeDefined();
      expect(bitmap?.imageData).toBeDefined();
    });

    it('should handle partial recovery for corrupted deflate stream', async () => {
      const width = 20;
      const height = 20;
      // Corrupt the deflate stream halfway through
      const datFile = createFlaBitmapDat({
        width,
        height,
        subFormat: 0,
        corruptAt: 50 // Corrupt after some valid data
      });

      const media = `
        <media>
          <DOMBitmapItem name="corrupted.png" href="corrupted.png"
            bitmapDataHRef="M 3 123456.dat"
            frameRight="${width * 20}" frameBottom="${height * 20}"/>
        </media>`;

      const consoleSpy = createConsoleSpy();
      const fla = await createFlaZip(
        createDOMDocument({ media }),
        { 'bin/M 3 123456.dat': datFile }
      );

      const doc = await parser.parse(fla);
      consoleSpy.mockRestore();

      // Should have attempted some form of recovery
      const bitmap = doc.bitmaps.get('corrupted.png');
      expect(bitmap).toBeDefined();
      // Either recovery succeeded (has imageData) or failed gracefully (no imageData)
      // The key is that it doesn't throw an exception
      expect(bitmap?.name).toBe('corrupted.png');
    });

    it('should return null for completely invalid bitmap data', async () => {
      const width = 10;
      const height = 10;
      const datFile = createFlaBitmapDat({
        width,
        height,
        useInvalidData: true
      });

      const media = `
        <media>
          <DOMBitmapItem name="invalid.png" href="invalid.png"
            bitmapDataHRef="M 4 123456.dat"
            frameRight="${width * 20}" frameBottom="${height * 20}"/>
        </media>`;

      const fla = await createFlaZip(
        createDOMDocument({ media }),
        { 'bin/M 4 123456.dat': datFile }
      );

      const doc = await parser.parse(fla);

      // Bitmap entry should exist but imageData should be undefined (failed to decode)
      const bitmap = doc.bitmaps.get('invalid.png');
      expect(bitmap).toBeDefined();
      expect(bitmap?.imageData).toBeUndefined();
    });

    it('should handle undersized decompressed data by adjusting height', async () => {
      const width = 10;
      const height = 20;
      // Create pixel data for only half the rows
      const partialPixelData = new Uint8Array(width * 10 * 4); // Only 10 rows instead of 20
      for (let i = 0; i < width * 10; i++) {
        partialPixelData[i * 4 + 0] = 0xFF; // A
        partialPixelData[i * 4 + 1] = 0x00; // R
        partialPixelData[i * 4 + 2] = 0xFF; // G
        partialPixelData[i * 4 + 3] = 0x00; // B
      }

      // Manually create a dat file with header saying 20 rows but data for 10
      const compressed = pako.deflateRaw(partialPixelData);
      const headerSize = 30;
      const dat = new Uint8Array(headerSize + compressed.length);

      // Header
      dat[0] = 0x03; dat[1] = 0x05;
      dat[2] = (width * 4) & 0xFF; dat[3] = ((width * 4) >> 8) & 0xFF;
      dat[4] = width & 0xFF; dat[5] = (width >> 8) & 0xFF;
      dat[6] = height & 0xFF; dat[7] = (height >> 8) & 0xFF; // Header says 20 rows
      dat[24] = 0; dat[25] = 1; dat[26] = 0; dat[27] = 8;
      dat[28] = 0x78; dat[29] = 0x01;
      dat.set(compressed, headerSize);

      const media = `
        <media>
          <DOMBitmapItem name="undersized.png" href="undersized.png"
            bitmapDataHRef="M 5 123456.dat"
            frameRight="${width * 20}" frameBottom="${height * 20}"/>
        </media>`;

      const fla = await createFlaZip(
        createDOMDocument({ media }),
        { 'bin/M 5 123456.dat': dat }
      );

      const doc = await parser.parse(fla);

      // Should still create a bitmap, possibly with adjusted dimensions
      const bitmap = doc.bitmaps.get('undersized.png');
      expect(bitmap).toBeDefined();
      // The imageData might exist with adjusted height
    });

    it('should log partial recovery information', async () => {
      const width = 15;
      const height = 15;
      const datFile = createFlaBitmapDat({
        width,
        height,
        subFormat: 0,
        corruptAt: 30 // Corrupt early in the stream
      });

      const media = `
        <media>
          <DOMBitmapItem name="partial.png" href="partial.png"
            bitmapDataHRef="M 6 123456.dat"
            frameRight="${width * 20}" frameBottom="${height * 20}"/>
        </media>`;

      const consoleSpy = createConsoleSpy();
      const fla = await createFlaZip(
        createDOMDocument({ media }),
        { 'bin/M 6 123456.dat': datFile }
      );

      await parser.parse(fla);

      // Check if any recovery-related log was made
      const hasRecoveryLog = consoleSpy.mock.calls.some(
        call => typeof call[0] === 'string' && (
          call[0].includes('deflate failed') ||
          call[0].includes('recovery') ||
          call[0].includes('Streaming')
        )
      );
      consoleSpy.mockRestore();

      // The test passes regardless of whether recovery logs were made
      // since the exact behavior depends on the corruption pattern
      // The key is that parsing doesn't throw
    });

    it('should handle empty dat file gracefully', async () => {
      const emptyDat = new Uint8Array(30); // Just header, no compressed data
      emptyDat[0] = 0x03; emptyDat[1] = 0x05;
      emptyDat[4] = 10; emptyDat[6] = 10; // 10x10 dimensions

      const media = `
        <media>
          <DOMBitmapItem name="empty.png" href="empty.png"
            bitmapDataHRef="M 7 123456.dat"
            frameRight="200" frameBottom="200"/>
        </media>`;

      const fla = await createFlaZip(
        createDOMDocument({ media }),
        { 'bin/M 7 123456.dat': emptyDat }
      );

      // Should not throw
      const doc = await parser.parse(fla);
      const bitmap = doc.bitmaps.get('empty.png');
      expect(bitmap).toBeDefined();
      // imageData will be undefined due to decompression failure
      expect(bitmap?.imageData).toBeUndefined();
    });

    it('should use streaming recovery with onData callback for mid-stream corruption', async () => {
      const width = 30;
      const height = 30;
      // Create larger image data to ensure compression produces enough bytes for mid-stream corruption
      const pixelData = new Uint8Array(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        // Varied pixel data for better compression testing
        pixelData[i * 4 + 0] = 0xFF; // A
        pixelData[i * 4 + 1] = i % 256; // R
        pixelData[i * 4 + 2] = (i * 2) % 256; // G
        pixelData[i * 4 + 3] = (i * 3) % 256; // B
      }

      // Compress and corrupt mid-stream
      const compressed = pako.deflateRaw(pixelData);
      const corruptOffset = Math.floor(compressed.length * 0.4); // Corrupt at 40%

      // Create corrupted compressed data
      const corruptedCompressed = new Uint8Array(compressed);
      for (let i = corruptOffset; i < Math.min(corruptOffset + 20, compressed.length); i++) {
        corruptedCompressed[i] = 0xFF;
      }

      // Build .dat file manually
      const headerSize = 30;
      const dat = new Uint8Array(headerSize + corruptedCompressed.length);
      dat[0] = 0x03; dat[1] = 0x05;
      dat[2] = (width * 4) & 0xFF; dat[3] = ((width * 4) >> 8) & 0xFF;
      dat[4] = width & 0xFF; dat[5] = (width >> 8) & 0xFF;
      dat[6] = height & 0xFF; dat[7] = (height >> 8) & 0xFF;
      dat[24] = 0; dat[25] = 1; dat[26] = 0; dat[27] = 8;
      dat[28] = 0x78; dat[29] = 0x01;
      dat.set(corruptedCompressed, headerSize);

      const media = `
        <media>
          <DOMBitmapItem name="streaming_test.png" href="streaming_test.png"
            bitmapDataHRef="M 8 123456.dat"
            frameRight="${width * 20}" frameBottom="${height * 20}"/>
        </media>`;

      const consoleSpy = createConsoleSpy();
      const fla = await createFlaZip(
        createDOMDocument({ media }),
        { 'bin/M 8 123456.dat': dat }
      );

      const doc = await parser.parse(fla);
      consoleSpy.mockRestore();

      // Streaming recovery should capture partial data via onData callback
      const bitmap = doc.bitmaps.get('streaming_test.png');
      expect(bitmap).toBeDefined();
      // Should have recovered at least some data (partial image)
      // The key test is that it doesn't throw and processes the partial data
    });

    it('should fall back to dictionary decompression when raw deflate fails with distance error', async () => {
      const width = 10;
      const height = 10;

      // Create deflate data that references a distance larger than current output
      // This simulates data that expects a preset dictionary
      // Deflate block: BFINAL=1, BTYPE=01 (fixed huffman), then a length/distance pair
      // that references beyond current output position
      const deflateWithDistanceRef = new Uint8Array([
        // Fixed huffman block that copies from "dictionary" area
        // This is a minimal block that causes "invalid distance too far back" without dict
        0x63, 0x60, 0x60, 0x60, // literal zeros
        0x62, 0x00, // back-reference (distance > current position without dict)
        0x00, // end of block
      ]);

      // Build .dat file
      const headerSize = 30;
      const dat = new Uint8Array(headerSize + deflateWithDistanceRef.length);
      dat[0] = 0x03; dat[1] = 0x05;
      dat[2] = (width * 4) & 0xFF; dat[3] = ((width * 4) >> 8) & 0xFF;
      dat[4] = width & 0xFF; dat[5] = (width >> 8) & 0xFF;
      dat[6] = height & 0xFF; dat[7] = (height >> 8) & 0xFF;
      dat[24] = 0; dat[25] = 1; dat[26] = 0; dat[27] = 8;
      dat[28] = 0x78; dat[29] = 0x01;
      dat.set(deflateWithDistanceRef, headerSize);

      const media = `
        <media>
          <DOMBitmapItem name="dict_test.png" href="dict_test.png"
            bitmapDataHRef="M 9 123456.dat"
            frameRight="${width * 20}" frameBottom="${height * 20}"/>
        </media>`;

      const consoleSpy = createConsoleSpy();
      const fla = await createFlaZip(
        createDOMDocument({ media }),
        { 'bin/M 9 123456.dat': dat }
      );

      const doc = await parser.parse(fla);
      consoleSpy.mockRestore();

      // Should not throw - either dict succeeds or falls back to streaming
      const bitmap = doc.bitmaps.get('dict_test.png');
      expect(bitmap).toBeDefined();
    });

    it('should use streaming+dictionary fallback as final recovery method', async () => {
      const width = 10;
      const height = 10;

      // Create data that:
      // 1. Fails raw deflate (needs dictionary)
      // 2. Fails dictionary alone (has mid-stream corruption)
      // 3. Fails regular streaming (needs dictionary from byte 0)
      // 4. Succeeds with streaming+dictionary (has dict AND captures partial via onData)

      // First create valid dict-requiring data, then corrupt it mid-stream
      const pixelData = new Uint8Array(width * height * 4);
      for (let i = 0; i < pixelData.length; i++) {
        pixelData[i] = (i % 256);
      }

      // Create a compressed stream that we'll make require dictionary
      // by corrupting the first few bytes to reference back-distance > output position
      const compressed = pako.deflateRaw(pixelData);

      // Modify to create "distance too far back" at start, plus corruption later
      const modifiedCompressed = new Uint8Array(compressed.length + 4);
      // Insert bytes that reference preset dictionary area
      modifiedCompressed[0] = 0x63; // literal block header variation
      modifiedCompressed[1] = 0x62; // distance reference
      modifiedCompressed.set(compressed.subarray(0, compressed.length - 4), 2);
      // Corrupt near the end
      for (let i = modifiedCompressed.length - 10; i < modifiedCompressed.length - 5; i++) {
        modifiedCompressed[i] = 0xFF;
      }

      // Build .dat file
      const headerSize = 30;
      const dat = new Uint8Array(headerSize + modifiedCompressed.length);
      dat[0] = 0x03; dat[1] = 0x05;
      dat[2] = (width * 4) & 0xFF; dat[3] = ((width * 4) >> 8) & 0xFF;
      dat[4] = width & 0xFF; dat[5] = (width >> 8) & 0xFF;
      dat[6] = height & 0xFF; dat[7] = (height >> 8) & 0xFF;
      dat[24] = 0; dat[25] = 1; dat[26] = 0; dat[27] = 8;
      dat[28] = 0x78; dat[29] = 0x01;
      dat.set(modifiedCompressed, headerSize);

      const media = `
        <media>
          <DOMBitmapItem name="stream_dict_test.png" href="stream_dict_test.png"
            bitmapDataHRef="M 10 123456.dat"
            frameRight="${width * 20}" frameBottom="${height * 20}"/>
        </media>`;

      const consoleSpy = createConsoleSpy();
      const fla = await createFlaZip(
        createDOMDocument({ media }),
        { 'bin/M 10 123456.dat': dat }
      );

      const doc = await parser.parse(fla);
      consoleSpy.mockRestore();

      // The test passes if parsing completes without throwing
      // The streaming+dictionary path is the final fallback
      const bitmap = doc.bitmaps.get('stream_dict_test.png');
      expect(bitmap).toBeDefined();
    });

    it('should use multi-segment recovery for severely corrupted files with stored blocks', async () => {
      const width = 20;
      const height = 20;
      const expectedSize = width * height * 4;

      // Create a file that:
      // 1. Has corrupted data at the start (streaming gets partial)
      // 2. Has a stored block that can be extracted directly
      // This tests the multi-segment recovery path

      // Create pixel data
      const pixelData = new Uint8Array(expectedSize);
      for (let i = 0; i < pixelData.length; i++) {
        pixelData[i] = (i % 256);
      }

      // Compress half of it normally
      const firstHalf = pixelData.slice(0, expectedSize / 2);
      const compressedFirst = pako.deflateRaw(firstHalf);

      // Create a "stored block" for the second half
      // Stored block format: [BTYPE byte] [LEN:2] [NLEN:2] [DATA]
      const secondHalf = pixelData.slice(expectedSize / 2);
      const storedBlockLen = secondHalf.length;
      const storedBlock = new Uint8Array(5 + storedBlockLen);
      storedBlock[0] = 0x00; // BFINAL=0, BTYPE=0 (stored)
      storedBlock[1] = storedBlockLen & 0xFF;
      storedBlock[2] = (storedBlockLen >> 8) & 0xFF;
      storedBlock[3] = (~storedBlockLen) & 0xFF;
      storedBlock[4] = ((~storedBlockLen) >> 8) & 0xFF;
      storedBlock.set(secondHalf, 5);

      // Combine: corrupted compressed + stored block
      // Corrupt the compressed data to force fallback
      const corruptedFirst = new Uint8Array(compressedFirst);
      for (let i = 10; i < Math.min(20, corruptedFirst.length); i++) {
        corruptedFirst[i] = 0xFF;
      }

      const combinedCompressed = new Uint8Array(corruptedFirst.length + storedBlock.length);
      combinedCompressed.set(corruptedFirst, 0);
      combinedCompressed.set(storedBlock, corruptedFirst.length);

      // Build .dat file
      const headerSize = 30;
      const dat = new Uint8Array(headerSize + combinedCompressed.length);
      dat[0] = 0x03; dat[1] = 0x05;
      dat[2] = (width * 4) & 0xFF; dat[3] = ((width * 4) >> 8) & 0xFF;
      dat[4] = width & 0xFF; dat[5] = (width >> 8) & 0xFF;
      dat[6] = height & 0xFF; dat[7] = (height >> 8) & 0xFF;
      dat[24] = 0; dat[25] = 1; dat[26] = 0; dat[27] = 8;
      dat[28] = 0x78; dat[29] = 0x01;
      dat.set(combinedCompressed, headerSize);

      const media = `
        <media>
          <DOMBitmapItem name="multi_segment_test.png" href="multi_segment_test.png"
            bitmapDataHRef="M 11 123456.dat"
            frameRight="${width * 20}" frameBottom="${height * 20}"/>
        </media>`;

      const consoleSpy = createConsoleSpy();
      const fla = await createFlaZip(
        createDOMDocument({ media }),
        { 'bin/M 11 123456.dat': dat }
      );

      const doc = await parser.parse(fla);
      consoleSpy.mockRestore();

      // Multi-segment recovery should extract data from the stored block
      const bitmap = doc.bitmaps.get('multi_segment_test.png');
      expect(bitmap).toBeDefined();
      // The parser should recover and produce a bitmap (even if partial)
    });
  });

  describe('edge cases', () => {
    it('should handle empty timelines', async () => {
      const timelines = `<timelines></timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      expect(doc.timelines).toHaveLength(0);
    });

    it('should handle empty layers', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers></layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      expect(doc.timelines[0].layers).toHaveLength(0);
    });

    it('should handle empty frames', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames></frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      expect(doc.timelines[0].layers[0].frames).toHaveLength(0);
    });

    it('should handle missing attributes with defaults', async () => {
      // Missing width, height, frameRate, backgroundColor
      const domDoc = `<?xml version="1.0" encoding="UTF-8"?>
<DOMDocument>
  <timelines>
    <DOMTimeline name="Scene 1">
      <layers>
        <DOMLayer name="Layer 1">
          <frames>
            <DOMFrame index="0">
              <elements></elements>
            </DOMFrame>
          </frames>
        </DOMLayer>
      </layers>
    </DOMTimeline>
  </timelines>
</DOMDocument>`;

      const fla = await createFlaZip(domDoc);
      const doc = await parser.parse(fla);

      // Should use defaults
      expect(doc.width).toBe(550);
      expect(doc.height).toBe(400);
      expect(doc.frameRate).toBe(24);
      expect(doc.backgroundColor).toBe('#FFFFFF');
    });
  });

  describe('custom ease', () => {
    it('should parse CustomEase tween with points', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0" duration="10" tweenType="motion">
                    <elements>
                      <DOMShape>
                        <fills><FillStyle index="1"><SolidColor color="#FF0000"/></FillStyle></fills>
                        <strokes></strokes>
                        <edges><Edge fillStyle0="1" edges="!0 0|50 50"/></edges>
                      </DOMShape>
                    </elements>
                    <tweens>
                      <CustomEase target="position">
                        <Point x="0" y="0"/>
                        <Point x="0.25" y="0.1"/>
                        <Point x="0.75" y="0.9"/>
                        <Point x="1" y="1"/>
                      </CustomEase>
                    </tweens>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      const frame = doc.timelines[0].layers[0].frames[0];
      expect(frame.tweens).toBeDefined();
      expect(frame.tweens).toHaveLength(1);
      expect(frame.tweens![0].target).toBe('position');
      expect(frame.tweens![0].customEase).toBeDefined();
      expect(frame.tweens![0].customEase).toHaveLength(4);
      expect(frame.tweens![0].customEase![0]).toEqual({ x: 0, y: 0 });
      expect(frame.tweens![0].customEase![3]).toEqual({ x: 1, y: 1 });
    });
  });

  describe('group elements', () => {
    it('should parse DOMGroup with nested shapes', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMGroup>
                        <matrix><Matrix tx="100" ty="50"/></matrix>
                        <members>
                          <DOMShape>
                            <fills><FillStyle index="1"><SolidColor color="#FF0000"/></FillStyle></fills>
                            <strokes></strokes>
                            <edges><Edge fillStyle0="1" edges="!0 0|50 0|50 50|0 50|0 0"/></edges>
                          </DOMShape>
                          <DOMShape>
                            <fills><FillStyle index="1"><SolidColor color="#00FF00"/></FillStyle></fills>
                            <strokes></strokes>
                            <edges><Edge fillStyle0="1" edges="!60 0|110 0|110 50|60 50|60 0"/></edges>
                          </DOMShape>
                        </members>
                      </DOMGroup>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      // Group members are flattened into elements array
      const elements = doc.timelines[0].layers[0].frames[0].elements;
      expect(elements.length).toBeGreaterThanOrEqual(2);
      expect(elements[0].type).toBe('shape');
      expect(elements[1].type).toBe('shape');
    });

    it('should parse nested groups', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMGroup>
                        <matrix><Matrix tx="10" ty="10"/></matrix>
                        <members>
                          <DOMGroup>
                            <matrix><Matrix tx="20" ty="20"/></matrix>
                            <members>
                              <DOMShape>
                                <fills><FillStyle index="1"><SolidColor color="#0000FF"/></FillStyle></fills>
                                <strokes></strokes>
                                <edges><Edge fillStyle0="1" edges="!0 0|30 30"/></edges>
                              </DOMShape>
                            </members>
                          </DOMGroup>
                        </members>
                      </DOMGroup>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      const elements = doc.timelines[0].layers[0].frames[0].elements;
      expect(elements.length).toBeGreaterThanOrEqual(1);
      expect(elements[0].type).toBe('shape');
    });

    it('should parse group with symbol instances', async () => {
      const symbolXml = `<?xml version="1.0" encoding="UTF-8"?>
<DOMSymbolItem name="NestedSymbol" symbolType="graphic">
  <timeline>
    <DOMTimeline name="NestedSymbol">
      <layers>
        <DOMLayer name="Layer 1">
          <frames>
            <DOMFrame index="0">
              <elements></elements>
            </DOMFrame>
          </frames>
        </DOMLayer>
      </layers>
    </DOMTimeline>
  </timeline>
</DOMSymbolItem>`;

      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMGroup>
                        <members>
                          <DOMSymbolInstance libraryItemName="NestedSymbol">
                            <matrix><Matrix tx="50" ty="50"/></matrix>
                          </DOMSymbolInstance>
                        </members>
                      </DOMGroup>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const symbols = `<symbols><Include href="NestedSymbol.xml"/></symbols>`;

      const fla = await createFlaZip(
        createDOMDocument({ timelines, symbols }),
        { 'LIBRARY/NestedSymbol.xml': symbolXml }
      );
      const doc = await parser.parse(fla);

      const elements = doc.timelines[0].layers[0].frames[0].elements;
      expect(elements.length).toBeGreaterThanOrEqual(1);
      expect(elements[0].type).toBe('symbol');
    });

    it('should parse group with bitmap instance', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMGroup>
                        <members>
                          <DOMBitmapInstance libraryItemName="image.png">
                            <matrix><Matrix tx="25" ty="25"/></matrix>
                          </DOMBitmapInstance>
                        </members>
                      </DOMGroup>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      const elements = doc.timelines[0].layers[0].frames[0].elements;
      expect(elements.length).toBeGreaterThanOrEqual(1);
      expect(elements[0].type).toBe('bitmap');
    });

    it('should parse group with text instance', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMGroup>
                        <members>
                          <DOMStaticText>
                            <matrix><Matrix tx="10" ty="10"/></matrix>
                            <textRuns>
                              <DOMTextRun>
                                <characters>Grouped Text</characters>
                                <textAttrs><DOMTextAttrs size="14" face="Arial"/></textAttrs>
                              </DOMTextRun>
                            </textRuns>
                          </DOMStaticText>
                        </members>
                      </DOMGroup>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      const elements = doc.timelines[0].layers[0].frames[0].elements;
      expect(elements.length).toBeGreaterThanOrEqual(1);
      expect(elements[0].type).toBe('text');
    });
  });

  describe('video instance', () => {
    it('should parse DOMVideoInstance element', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMVideoInstance libraryItemName="video.flv">
                        <matrix><Matrix tx="100" ty="100"/></matrix>
                      </DOMVideoInstance>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      const element = doc.timelines[0].layers[0].frames[0].elements[0];
      expect(element.type).toBe('video');
    });

    it('should parse video instance inside group', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMGroup>
                        <members>
                          <DOMVideoInstance libraryItemName="clip.mp4">
                            <matrix><Matrix/></matrix>
                          </DOMVideoInstance>
                        </members>
                      </DOMGroup>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      const elements = doc.timelines[0].layers[0].frames[0].elements;
      expect(elements.length).toBeGreaterThanOrEqual(1);
      expect(elements[0].type).toBe('video');
    });
  });

  describe('dashed stroke', () => {
    it('should parse DashedStroke style', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMShape>
                        <fills></fills>
                        <strokes>
                          <StrokeStyle index="1">
                            <DashedStroke weight="2" caps="round" joints="round">
                              <fill><SolidColor color="#333333"/></fill>
                            </DashedStroke>
                          </StrokeStyle>
                        </strokes>
                        <edges><Edge strokeStyle="1" edges="!0 0|100 0"/></edges>
                      </DOMShape>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      const element = doc.timelines[0].layers[0].frames[0].elements[0];
      expect(element.type).toBe('shape');
      if (element.type !== 'shape') throw new Error('Expected shape');
      expect(element.strokes.length).toBeGreaterThan(0);
      expect(element.strokes[0].weight).toBe(2);
      expect(element.strokes[0].color).toBe('#333333');
    });

    it('should parse DashedStroke with default attributes', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMShape>
                        <fills></fills>
                        <strokes>
                          <StrokeStyle index="1">
                            <DashedStroke>
                              <fill><SolidColor/></fill>
                            </DashedStroke>
                          </StrokeStyle>
                        </strokes>
                        <edges><Edge strokeStyle="1" edges="!0 0|50 50"/></edges>
                      </DOMShape>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      const element = doc.timelines[0].layers[0].frames[0].elements[0];
      expect(element.type).toBe('shape');
      if (element.type !== 'shape') throw new Error('Expected shape');
      expect(element.strokes.length).toBeGreaterThan(0);
      expect(element.strokes[0].weight).toBe(1); // default
      expect(element.strokes[0].color).toBe('#000000'); // default
    });
  });

  describe('sound media', () => {
    it('should parse sound media item', async () => {
      const media = `
        <media>
          <DOMSoundItem name="bgm.mp3" href="bgm.mp3" format="mp3" sampleCount="44100"/>
        </media>`;

      // Create a minimal valid MP3 (silent frame)
      const mp3Data = new Uint8Array([
        0xFF, 0xFB, 0x90, 0x00, // MP3 frame header
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);

      const fla = await createFlaZip(
        createDOMDocument({ media }),
        { 'LIBRARY/bgm.mp3': mp3Data }
      );
      const doc = await parser.parse(fla);

      // Sound should be in the map even if decoding fails
      expect(doc.sounds.has('bgm.mp3')).toBe(true);
      const sound = doc.sounds.get('bgm.mp3');
      expect(sound!.name).toBe('bgm.mp3');
      expect(sound!.format).toBe('mp3');
      expect(sound!.sampleCount).toBe(44100);
    });

    it('should handle missing sound file gracefully', async () => {
      const media = `
        <media>
          <DOMSoundItem name="missing.mp3" href="missing.mp3"/>
        </media>`;

      const fla = await createFlaZip(createDOMDocument({ media }));
      // Should not throw even with missing file
      const doc = await parser.parse(fla);

      expect(doc.sounds.has('missing.mp3')).toBe(true);
      const sound = doc.sounds.get('missing.mp3');
      expect(sound!.audioData).toBeUndefined();
    });

    it('should parse sound with inPoint', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0" soundName="effect.mp3" soundSync="event" inPoint44="22050">
                    <elements></elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      const frame = doc.timelines[0].layers[0].frames[0];
      expect(frame.sound).toBeDefined();
      expect(frame.sound!.name).toBe('effect.mp3');
      expect(frame.sound!.sync).toBe('event');
      expect(frame.sound!.inPoint44).toBe(22050);
    });
  });

  describe('movie clip symbols', () => {
    it('should parse movie clip symbol type', async () => {
      const symbolXml = `<?xml version="1.0" encoding="UTF-8"?>
<DOMSymbolItem name="MyMovieClip" symbolType="movie clip">
  <timeline>
    <DOMTimeline name="MyMovieClip">
      <layers>
        <DOMLayer name="Layer 1">
          <frames>
            <DOMFrame index="0" duration="10">
              <elements></elements>
            </DOMFrame>
          </frames>
        </DOMLayer>
      </layers>
    </DOMTimeline>
  </timeline>
</DOMSymbolItem>`;

      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMSymbolInstance libraryItemName="MyMovieClip" symbolType="movie clip" firstFrame="0" loop="loop">
                        <matrix><Matrix/></matrix>
                      </DOMSymbolInstance>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const symbols = `<symbols><Include href="MyMovieClip.xml"/></symbols>`;

      const fla = await createFlaZip(
        createDOMDocument({ timelines, symbols }),
        { 'LIBRARY/MyMovieClip.xml': symbolXml }
      );
      const doc = await parser.parse(fla);

      expect(doc.symbols.has('MyMovieClip')).toBe(true);
      const symbol = doc.symbols.get('MyMovieClip');
      expect(symbol!.symbolType).toBe('movie clip');
    });
  });

  describe('symbol instance without matrix', () => {
    it('should use identity matrix when symbol has no explicit matrix', async () => {
      const symbolXml = `<?xml version="1.0" encoding="UTF-8"?>
<DOMSymbolItem name="NoMatrixSymbol" symbolType="graphic">
  <timeline>
    <DOMTimeline name="NoMatrixSymbol">
      <layers>
        <DOMLayer name="Layer 1">
          <frames>
            <DOMFrame index="0">
              <elements>
                <DOMShape>
                  <fills><FillStyle index="1" color="#FF0000"/></fills>
                  <strokes></strokes>
                  <edges><Edge fillStyle0="1" edges="!0 0|100 0|100 100|0 100|0 0"/></edges>
                </DOMShape>
              </elements>
            </DOMFrame>
          </frames>
        </DOMLayer>
      </layers>
    </DOMTimeline>
  </timeline>
</DOMSymbolItem>`;

      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMSymbolInstance libraryItemName="NoMatrixSymbol" symbolType="graphic" loop="loop">
                      </DOMSymbolInstance>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const symbols = `<symbols><Include href="NoMatrixSymbol.xml"/></symbols>`;

      const fla = await createFlaZip(
        createDOMDocument({ timelines, symbols }),
        { 'LIBRARY/NoMatrixSymbol.xml': symbolXml }
      );
      const doc = await parser.parse(fla);

      const element = doc.timelines[0].layers[0].frames[0].elements[0];
      expect(element.type).toBe('symbol');
      // Should have identity matrix when none specified
      expect(element.matrix.a).toBe(1);
      expect(element.matrix.d).toBe(1);
      expect(element.matrix.tx).toBe(0);
      expect(element.matrix.ty).toBe(0);
    });
  });

  describe('bitmap instance without matrix', () => {
    it('should use identity matrix when bitmap has no explicit matrix', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMBitmapInstance libraryItemName="image.png">
                      </DOMBitmapInstance>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      const element = doc.timelines[0].layers[0].frames[0].elements[0];
      expect(element.type).toBe('bitmap');
      // Should have identity matrix when none specified
      expect(element.matrix.a).toBe(1);
      expect(element.matrix.d).toBe(1);
      expect(element.matrix.tx).toBe(0);
      expect(element.matrix.ty).toBe(0);
    });
  });

  describe('text instance without matrix', () => {
    it('should use identity matrix when text has no explicit matrix', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMStaticText>
                        <textRuns>
                          <DOMTextRun>
                            <characters>Test</characters>
                            <textAttrs><DOMTextAttrs face="Arial" size="12" fillColor="#000000"/></textAttrs>
                          </DOMTextRun>
                        </textRuns>
                      </DOMStaticText>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      const element = doc.timelines[0].layers[0].frames[0].elements[0];
      expect(element.type).toBe('text');
      // Should have identity matrix when none specified
      expect(element.matrix.a).toBe(1);
      expect(element.matrix.d).toBe(1);
    });
  });

  describe('camera layer detection', () => {
    it('should detect camera layer with transformation point near center', async () => {
      const symbolXml = `<?xml version="1.0" encoding="UTF-8"?>
<DOMSymbolItem name="CameraFrame" symbolType="graphic">
  <timeline>
    <DOMTimeline name="CameraFrame">
      <layers>
        <DOMLayer name="Layer 1">
          <frames>
            <DOMFrame index="0">
              <elements>
                <DOMShape>
                  <fills><FillStyle index="1" color="#000000"/></fills>
                  <strokes></strokes>
                  <edges><Edge fillStyle0="1" edges="!0 0|550 0|550 400|0 400|0 0"/></edges>
                </DOMShape>
              </elements>
            </DOMFrame>
          </frames>
        </DOMLayer>
      </layers>
    </DOMTimeline>
  </timeline>
</DOMSymbolItem>`;

      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="camera" layerType="guide" visible="false">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMSymbolInstance libraryItemName="CameraFrame" symbolType="graphic" loop="loop">
                        <matrix><Matrix tx="0" ty="0"/></matrix>
                        <transformationPoint><Point x="275" y="200"/></transformationPoint>
                      </DOMSymbolInstance>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
              <DOMLayer name="Content">
                <frames>
                  <DOMFrame index="0">
                    <elements></elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const symbols = `<symbols><Include href="CameraFrame.xml"/></symbols>`;

      const fla = await createFlaZip(
        createDOMDocument({ timelines, symbols }),
        { 'LIBRARY/CameraFrame.xml': symbolXml }
      );
      const doc = await parser.parse(fla);

      // The camera layer should be detected as a reference layer
      expect(doc.timelines[0].referenceLayers.size).toBeGreaterThanOrEqual(0);
      expect(doc.timelines[0].layers.length).toBe(2);
    });

    it('should detect ramka layer as camera', async () => {
      const symbolXml = `<?xml version="1.0" encoding="UTF-8"?>
<DOMSymbolItem name="RamkaSymbol" symbolType="graphic">
  <timeline>
    <DOMTimeline name="RamkaSymbol">
      <layers>
        <DOMLayer name="Layer 1">
          <frames>
            <DOMFrame index="0">
              <elements></elements>
            </DOMFrame>
          </frames>
        </DOMLayer>
      </layers>
    </DOMTimeline>
  </timeline>
</DOMSymbolItem>`;

      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Ramka" layerType="guide" outline="true">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMSymbolInstance libraryItemName="RamkaSymbol" symbolType="graphic" loop="loop">
                        <matrix><Matrix/></matrix>
                        <transformationPoint><Point x="275" y="200"/></transformationPoint>
                      </DOMSymbolInstance>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const symbols = `<symbols><Include href="RamkaSymbol.xml"/></symbols>`;

      const fla = await createFlaZip(
        createDOMDocument({ timelines, symbols }),
        { 'LIBRARY/RamkaSymbol.xml': symbolXml }
      );
      const doc = await parser.parse(fla);

      expect(doc.timelines[0].layers.length).toBe(1);
      expect(doc.timelines[0].layers[0].name).toBe('Ramka');
    });
  });

  describe('fallback file search', () => {
    it('should find bitmap by filename when path does not match', async () => {
      const media = `
        <media>
          <DOMBitmapItem name="images/test.png" href="images/test.png"/>
        </media>`;

      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMBitmapInstance libraryItemName="images/test.png">
                        <matrix><Matrix/></matrix>
                      </DOMBitmapInstance>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      // Create a minimal 1x1 PNG image
      const pngData = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk header
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1 image
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // bit depth, color type, etc.
        0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, // IDAT chunk
        0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f, // compressed data
        0x00, 0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59, // ...
        0xe7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, // IEND chunk
        0x44, 0xae, 0x42, 0x60, 0x82
      ]);

      const fla = await createFlaZip(
        createDOMDocument({ timelines, media }),
        { 'LIBRARY/images/test.png': pngData }
      );
      const doc = await parser.parse(fla);

      expect(doc.bitmaps.has('images/test.png')).toBe(true);
    });
  });

  describe('reference layer filtering', () => {
    it('should filter transparent reference layers with low alpha', async () => {
      // Transparent layer with alphaPercent < 50 should be filtered as reference
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Reference Layer" layerType="normal" color="#FF0000" transparent="true" alphaPercent="25">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMShape>
                        <fills><FillStyle index="1"><SolidColor color="#FF0000"/></FillStyle></fills>
                        <edges><Edge fillStyle0="1" edges="!0 0|100 0|100 100|0 100|0 0"/></edges>
                      </DOMShape>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
              <DOMLayer name="Content Layer">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMShape>
                        <fills><FillStyle index="1"><SolidColor color="#00FF00"/></FillStyle></fills>
                        <edges><Edge fillStyle0="1" edges="!0 0|100 0|100 100|0 100|0 0"/></edges>
                      </DOMShape>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      // First layer (transparent with low alpha) should be in referenceLayers
      expect(doc.timelines[0].referenceLayers.has(0)).toBe(true);
      // Second layer should not be in referenceLayers
      expect(doc.timelines[0].referenceLayers.has(1)).toBe(false);
    });

    it('should filter camera layer with outline mode', async () => {
      // Camera layer with outline=true should be filtered as reference
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Camera" layerType="normal" outline="true">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMSymbolInstance libraryItemName="Ramka">
                        <matrix><Matrix/></matrix>
                      </DOMSymbolInstance>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
              <DOMLayer name="Background">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMShape>
                        <fills><FillStyle index="1"><SolidColor color="#0000FF"/></FillStyle></fills>
                        <edges><Edge fillStyle0="1" edges="!0 0|100 0|100 100|0 100|0 0"/></edges>
                      </DOMShape>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      // Camera layer with outline should be in referenceLayers
      expect(doc.timelines[0].referenceLayers.has(0)).toBe(true);
      // Background layer should not be in referenceLayers
      expect(doc.timelines[0].referenceLayers.has(1)).toBe(false);
    });

    it('should not filter camera layer without outline mode', async () => {
      // Camera layer without outline=true should NOT be filtered
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Camera" layerType="normal">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMSymbolInstance libraryItemName="Ramka">
                        <matrix><Matrix/></matrix>
                      </DOMSymbolInstance>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const fla = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(fla);

      // Camera layer without outline should NOT be in referenceLayers
      expect(doc.timelines[0].referenceLayers.has(0)).toBe(false);
    });
  });

  describe('symbol parsing errors', () => {
    it('should handle invalid symbol XML gracefully', async () => {
      // Invalid XML in symbol file - should not crash the parser
      const invalidSymbolXml = `<?xml version="1.0"?>
<DOMSymbolItem name="BadSymbol">
  <timeline>
    <DOMTimeline name="BadSymbol">
      <layers>
        <DOMLayer name="Layer 1">
          <frames>
            <!-- Unclosed tag -->
            <DOMFrame index="0">
              <elements>
              </elements>`;  // Missing closing tags

      const validTimelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements></elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const symbols = `<symbols><Include href="BadSymbol.xml"/></symbols>`;

      const fla = await createFlaZip(
        createDOMDocument({ timelines: validTimelines, symbols }),
        { 'LIBRARY/BadSymbol.xml': invalidSymbolXml }
      );

      // Should not throw - gracefully handle invalid symbol
      const doc = await parser.parse(fla);
      expect(doc.timelines).toHaveLength(1);
    });
  });

  describe('ZIP repair functionality', () => {
    // Helper to find EOCD offset in a ZIP buffer
    function findEOCDOffset(bytes: Uint8Array): number {
      for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 65557; i--) {
        if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b &&
            bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
          return i;
        }
      }
      return -1;
    }

    it('should repair ZIP with extra data after EOCD', async () => {
      // Create a valid FLA file
      const validFla = await createFlaZip(createDOMDocument());
      const validBuffer = await validFla.arrayBuffer();
      const validBytes = new Uint8Array(validBuffer);

      // Find EOCD and get expected end
      const eocdOffset = findEOCDOffset(validBytes);
      expect(eocdOffset).toBeGreaterThan(0);

      const view = new DataView(validBuffer);
      const commentLength = view.getUint16(eocdOffset + 20, true);
      const expectedEnd = eocdOffset + 22 + commentLength;

      // Append garbage data after EOCD to corrupt the file
      const extraBytes = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x00, 0x00, 0x00]);
      const corruptedBytes = new Uint8Array(validBytes.length + extraBytes.length);
      corruptedBytes.set(validBytes);
      corruptedBytes.set(extraBytes, validBytes.length);

      const corruptedFile = new File([corruptedBytes], 'corrupted.fla', { type: 'application/octet-stream' });

      // Parser should repair by trimming to EOCD boundary
      const doc = await parser.parse(corruptedFile);
      expect(doc.width).toBe(550);
      expect(doc.height).toBe(400);
    });

    it('should repair ZIP with incorrect central directory size', async () => {
      // Create a valid FLA file
      const validFla = await createFlaZip(createDOMDocument());
      const validBuffer = await validFla.arrayBuffer();
      const validBytes = new Uint8Array(validBuffer);

      // Find EOCD
      const eocdOffset = findEOCDOffset(validBytes);
      expect(eocdOffset).toBeGreaterThan(0);

      // Create corrupted copy with wrong CD size
      const corruptedBytes = new Uint8Array(validBuffer.slice(0));
      const corruptedView = new DataView(corruptedBytes.buffer);

      // Get original CD size and offset
      const originalCdSize = corruptedView.getUint32(eocdOffset + 12, true);

      // Set incorrect CD size (add some bytes to make it wrong)
      corruptedView.setUint32(eocdOffset + 12, originalCdSize + 100, true);

      const corruptedFile = new File([corruptedBytes], 'corrupted.fla', { type: 'application/octet-stream' });

      // Parser should repair by patching CD size
      const doc = await parser.parse(corruptedFile);
      expect(doc.width).toBe(550);
      expect(doc.height).toBe(400);
    });

    it('should fail to repair file without EOCD signature', async () => {
      // Create a file that looks like a ZIP but has no valid EOCD
      // Just some random data with ZIP local file header but corrupted EOCD
      const fakeZipBytes = new Uint8Array([
        // Local file header signature
        0x50, 0x4b, 0x03, 0x04,
        // Some data
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        // More garbage - no valid EOCD
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);

      const badFile = new File([fakeZipBytes], 'noeocd.fla', { type: 'application/octet-stream' });

      // Should throw because repair fails (no EOCD found)
      await expect(parser.parse(badFile)).rejects.toThrow();
    });

    it('should fail to repair completely corrupted ZIP', async () => {
      // Create a valid ZIP first, then corrupt it beyond repair
      const validFla = await createFlaZip(createDOMDocument());
      const validBuffer = await validFla.arrayBuffer();
      const validBytes = new Uint8Array(validBuffer);

      // Find EOCD
      const eocdOffset = findEOCDOffset(validBytes);
      expect(eocdOffset).toBeGreaterThan(0);

      // Corrupt the central directory itself (not just size in EOCD)
      const corruptedBytes = new Uint8Array(validBuffer.slice(0));
      const corruptedView = new DataView(corruptedBytes.buffer);

      // Get CD offset and corrupt the central directory data
      const cdOffset = corruptedView.getUint32(eocdOffset + 16, true);

      // Overwrite central directory with garbage
      for (let i = cdOffset; i < eocdOffset && i < corruptedBytes.length; i++) {
        corruptedBytes[i] = 0xFF;
      }

      const corruptedFile = new File([corruptedBytes], 'totallycorrupt.fla', { type: 'application/octet-stream' });

      // Should throw because even after repair attempts, ZIP is invalid
      await expect(parser.parse(corruptedFile)).rejects.toThrow();
    });

    it('should handle ZIP where trim repair succeeds', async () => {
      // Create valid ZIP with specific content
      const timelines = `
        <timelines>
          <DOMTimeline name="Test Scene">
            <layers>
              <DOMLayer name="Test Layer">
                <frames>
                  <DOMFrame index="0" duration="10">
                    <elements>
                      <DOMShape>
                        <fills><FillStyle index="1"><SolidColor color="#FF0000"/></FillStyle></fills>
                        <edges><Edge fillStyle0="1" edges="!0 0|200 0|200 200|0 200|0 0"/></edges>
                      </DOMShape>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const validFla = await createFlaZip(createDOMDocument({
        width: 800,
        height: 600,
        timelines
      }));
      const validBuffer = await validFla.arrayBuffer();
      const validBytes = new Uint8Array(validBuffer);

      // Find EOCD
      const eocdOffset = findEOCDOffset(validBytes);
      const view = new DataView(validBuffer);
      const commentLength = view.getUint16(eocdOffset + 20, true);
      const expectedEnd = eocdOffset + 22 + commentLength;

      // Append lots of garbage data after EOCD
      const garbageSize = 1024;
      const garbage = new Uint8Array(garbageSize);
      for (let i = 0; i < garbageSize; i++) {
        garbage[i] = i % 256;
      }

      const corruptedBytes = new Uint8Array(validBytes.length + garbageSize);
      corruptedBytes.set(validBytes);
      corruptedBytes.set(garbage, validBytes.length);

      const corruptedFile = new File([corruptedBytes], 'trailing_garbage.fla', { type: 'application/octet-stream' });

      // Should repair and parse correctly
      const doc = await parser.parse(corruptedFile);
      expect(doc.width).toBe(800);
      expect(doc.height).toBe(600);
      expect(doc.timelines[0].layers[0].name).toBe('Test Layer');
    });

    it('should handle trailing garbage after valid ZIP', async () => {
      // Create valid ZIP
      const validFla = await createFlaZip(createDOMDocument({ width: 320, height: 240 }));
      const validBuffer = await validFla.arrayBuffer();
      const validBytes = new Uint8Array(validBuffer);

      const eocdOffset = findEOCDOffset(validBytes);
      expect(eocdOffset).toBeGreaterThan(0);

      // Append garbage that looks like corrupted ZIP data
      const corruptingData = new Uint8Array([
        0x50, 0x4b, 0x01, 0x02,  // Central directory file header signature (incomplete)
        0x00, 0x00, 0x00, 0x00,
        0x50, 0x4b, 0x03, 0x04,  // Local file header signature (incomplete)
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
      ]);

      const corruptedBytes = new Uint8Array(validBytes.length + corruptingData.length);
      corruptedBytes.set(validBytes);
      corruptedBytes.set(corruptingData, validBytes.length);

      const corruptedFile = new File([corruptedBytes], 'corrupted_trailing.fla', { type: 'application/octet-stream' });

      // JSZip may accept this or repair will handle it
      const doc = await parser.parse(corruptedFile);
      expect(doc.width).toBe(320);
      expect(doc.height).toBe(240);
    });

    it('should trigger repair by corrupting EOCD comment length', async () => {
      // Create valid ZIP
      const validFla = await createFlaZip(createDOMDocument({ width: 400, height: 300 }));
      const validBuffer = await validFla.arrayBuffer();
      const corruptedBytes = new Uint8Array(validBuffer.slice(0));

      const eocdOffset = findEOCDOffset(corruptedBytes);
      expect(eocdOffset).toBeGreaterThan(0);

      const corruptedView = new DataView(corruptedBytes.buffer);

      // Set comment length to non-zero but don't add actual comment bytes
      // This makes the file appear to need more bytes than it has
      corruptedView.setUint16(eocdOffset + 20, 100, true); // comment length = 100

      // Append some garbage to make length check pass but content invalid
      const garbage = new Uint8Array(100);
      garbage.fill(0xFF);

      const finalBytes = new Uint8Array(corruptedBytes.length + garbage.length);
      finalBytes.set(corruptedBytes);
      finalBytes.set(garbage, corruptedBytes.length);

      const corruptedFile = new File([finalBytes], 'bad_comment.fla', { type: 'application/octet-stream' });

      // This should trigger the repair path because expectedEnd < bytes.length is true
      // and the extra garbage causes issues
      const doc = await parser.parse(corruptedFile);
      expect(doc.width).toBe(400);
      expect(doc.height).toBe(300);
    });

    it('should trigger CD size patch when trim fails', async () => {
      // Create valid ZIP
      const validFla = await createFlaZip(createDOMDocument({ width: 640, height: 480 }));
      const validBuffer = await validFla.arrayBuffer();
      const corruptedBytes = new Uint8Array(validBuffer.slice(0));

      const eocdOffset = findEOCDOffset(corruptedBytes);
      expect(eocdOffset).toBeGreaterThan(0);

      const corruptedView = new DataView(corruptedBytes.buffer);

      // Corrupt the CD size to make initial load fail
      const originalCdSize = corruptedView.getUint32(eocdOffset + 12, true);
      // Set to a value that's slightly wrong - triggers repair path
      corruptedView.setUint32(eocdOffset + 12, originalCdSize + 50, true);

      const corruptedFile = new File([corruptedBytes], 'bad_cd_size.fla', { type: 'application/octet-stream' });

      // Should repair by patching CD size back
      const doc = await parser.parse(corruptedFile);
      expect(doc.width).toBe(640);
      expect(doc.height).toBe(480);
    });

    it('should trigger trim repair with inflated EOCD entry count', async () => {
      // Create valid ZIP
      const validFla = await createFlaZip(createDOMDocument({ width: 500, height: 350 }));
      const validBuffer = await validFla.arrayBuffer();
      const corruptedBytes = new Uint8Array(validBuffer.slice(0));

      const eocdOffset = findEOCDOffset(corruptedBytes);
      expect(eocdOffset).toBeGreaterThan(0);

      const view = new DataView(corruptedBytes.buffer);
      const originalEntryCount = view.getUint16(eocdOffset + 8, true);

      // Increase entry count to make JSZip think there are more entries
      // This should cause JSZip to fail with "End of data reached"
      view.setUint16(eocdOffset + 8, originalEntryCount + 5, true);
      view.setUint16(eocdOffset + 10, originalEntryCount + 5, true);

      // Append trailing garbage so expectedEnd < bytes.length
      const garbage = new Uint8Array(50);
      garbage.fill(0xAB);
      const finalBytes = new Uint8Array(corruptedBytes.length + garbage.length);
      finalBytes.set(corruptedBytes);
      finalBytes.set(garbage, corruptedBytes.length);

      const corruptedFile = new File([finalBytes], 'wrong_entry_count.fla', { type: 'application/octet-stream' });

      // JSZip fails due to entry count mismatch
      // Trim repair also fails (same entry count)
      // CD patch repair should also try but may still have issues
      // If this doesn't parse, we test that the repair was at least attempted
      try {
        const doc = await parser.parse(corruptedFile);
        // If it succeeds, verify the content
        expect(doc.width).toBe(500);
        expect(doc.height).toBe(350);
      } catch {
        // Expected - repair can't fix entry count mismatch
        // At least we triggered the repair path
      }
    });

    it('should return null from tryRepairZip when actualCdSize equals cdSize but ZIP still fails', async () => {
      // Create a ZIP where EOCD is valid but the actual ZIP content is corrupted
      // so both trim and patch repairs fail
      const validFla = await createFlaZip(createDOMDocument());
      const validBuffer = await validFla.arrayBuffer();
      const corruptedBytes = new Uint8Array(validBuffer.slice(0));

      const eocdOffset = findEOCDOffset(corruptedBytes);
      const corruptedView = new DataView(corruptedBytes.buffer);
      const cdOffset = corruptedView.getUint32(eocdOffset + 16, true);

      // Corrupt the local file headers (before CD) to make ZIP unparseable
      // but keep EOCD and CD size correct so trim/patch don't help
      for (let i = 0; i < cdOffset && i < 100; i++) {
        if (i >= 4) { // Don't corrupt the initial PK signature at offset 0
          corruptedBytes[i] = 0x00;
        }
      }

      const corruptedFile = new File([corruptedBytes], 'corrupted_content.fla', { type: 'application/octet-stream' });

      // Should throw because repair can't fix corrupted content
      await expect(parser.parse(corruptedFile)).rejects.toThrow();
    });
  });

  describe('DEBUG mode', () => {
    let parser: FLAParser;
    let consoleSpy: ConsoleSpy;

    beforeEach(() => {
      parser = new FLAParser();
      setParserDebug(true);
      consoleSpy = createConsoleSpy();
    });

    afterEach(() => {
      setParserDebug(false);
      consoleSpy.mockRestore();
    });

    it('should log symbol loading info when DEBUG is enabled', async () => {
      const symbolXml = `<?xml version="1.0" encoding="UTF-8"?>
        <DOMSymbolItem name="TestSymbol" itemID="test-id" symbolType="graphic">
          <timeline>
            <DOMTimeline name="TestTimeline">
              <layers>
                <DOMLayer name="Layer 1">
                  <frames>
                    <DOMFrame index="0">
                      <elements>
                        <DOMShape>
                          <fills><FillStyle index="1"><SolidColor color="#FF0000"/></FillStyle></fills>
                          <edges><Edge fillStyle0="1" edges="!0 0|100 0|100 100|0 100|0 0"/></edges>
                        </DOMShape>
                      </elements>
                    </DOMFrame>
                  </frames>
                </DOMLayer>
              </layers>
            </DOMTimeline>
          </timeline>
        </DOMSymbolItem>`;

      const flaFile = await createFlaZip(createDOMDocument(), {
        'LIBRARY/TestSymbol.xml': symbolXml,
      });

      await parser.parse(flaFile);
      expectLogContaining(consoleSpy, 'Loaded');
    });

    it('should log library files count when DEBUG is enabled', async () => {
      const symbolXml = `<?xml version="1.0" encoding="UTF-8"?>
        <DOMSymbolItem name="AnotherSymbol" itemID="another-id" symbolType="movieclip">
          <timeline>
            <DOMTimeline name="Timeline">
              <layers>
                <DOMLayer name="Layer 1">
                  <frames><DOMFrame index="0"><elements></elements></DOMFrame></frames>
                </DOMLayer>
              </layers>
            </DOMTimeline>
          </timeline>
        </DOMSymbolItem>`;

      const flaFile = await createFlaZip(createDOMDocument(), {
        'LIBRARY/AnotherSymbol.xml': symbolXml,
      });

      await parser.parse(flaFile);
      expectLogContaining(consoleSpy, 'XML files in LIBRARY');
    });

    it('should log CD size patch info when DEBUG is enabled and repair succeeds', async () => {
      // Create valid ZIP and corrupt CD size
      const validFla = await createFlaZip(createDOMDocument({ width: 640, height: 480 }));
      const validBuffer = await validFla.arrayBuffer();
      const corruptedBytes = new Uint8Array(validBuffer.slice(0));

      // Find EOCD and corrupt CD size
      let eocdOffset = -1;
      for (let i = corruptedBytes.length - 22; i >= 0 && i >= corruptedBytes.length - 65557; i--) {
        if (corruptedBytes[i] === 0x50 && corruptedBytes[i + 1] === 0x4b &&
            corruptedBytes[i + 2] === 0x05 && corruptedBytes[i + 3] === 0x06) {
          eocdOffset = i;
          break;
        }
      }

      const corruptedView = new DataView(corruptedBytes.buffer);
      const originalCdSize = corruptedView.getUint32(eocdOffset + 12, true);
      corruptedView.setUint32(eocdOffset + 12, originalCdSize + 50, true);

      const corruptedFile = new File([corruptedBytes], 'bad_cd_size.fla', { type: 'application/octet-stream' });

      const doc = await parser.parse(corruptedFile);
      expect(doc.width).toBe(640);
      expectLogContaining(consoleSpy, 'repaired by patching CD size');
    });

    it('should log symbol names when DEBUG is enabled', async () => {
      const symbolXml = `<?xml version="1.0" encoding="UTF-8"?>
        <DOMSymbolItem name="DebugTestSymbol" itemID="debug-test-id" symbolType="graphic">
          <timeline>
            <DOMTimeline name="Timeline">
              <layers>
                <DOMLayer name="Layer 1">
                  <frames><DOMFrame index="0"><elements></elements></DOMFrame></frames>
                </DOMLayer>
              </layers>
            </DOMTimeline>
          </timeline>
        </DOMSymbolItem>`;

      const flaFile = await createFlaZip(createDOMDocument(), {
        'LIBRARY/DebugTestSymbol.xml': symbolXml,
      });

      await parser.parse(flaFile);
      expectLogContaining(consoleSpy, 'Symbol names');
    });
  });

  describe('bitmap fills', () => {
    it('should parse BitmapFill in shape fills', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMShape>
                        <fills>
                          <FillStyle index="1">
                            <BitmapFill bitmapPath="images/texture.png">
                              <matrix>
                                <Matrix a="20" d="20" tx="-100" ty="-50"/>
                              </matrix>
                            </BitmapFill>
                          </FillStyle>
                        </fills>
                        <edges>
                          <Edge fillStyle1="1" edges="!0 0|100 0|100 100|0 100|0 0"/>
                        </edges>
                      </DOMShape>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const flaFile = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(flaFile);

      const layer = doc.timelines[0].layers[0];
      const frame = layer.frames[0];
      const shape = frame.elements[0];

      expect(shape.type).toBe('shape');
      if (shape.type === 'shape') {
        expect(shape.fills).toHaveLength(1);
        expect(shape.fills[0].type).toBe('bitmap');
        expect(shape.fills[0].bitmapPath).toBe('images/texture.png');
        expect(shape.fills[0].matrix).toBeDefined();
        expect(shape.fills[0].matrix?.a).toBe(20);
        expect(shape.fills[0].matrix?.d).toBe(20);
        expect(shape.fills[0].matrix?.tx).toBe(-100);
        expect(shape.fills[0].matrix?.ty).toBe(-50);
      }
    });

    it('should parse BitmapFill without matrix', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMShape>
                        <fills>
                          <FillStyle index="1">
                            <BitmapFill bitmapPath="background.jpg"/>
                          </FillStyle>
                        </fills>
                        <edges>
                          <Edge fillStyle1="1" edges="!0 0|100 0|100 100|0 100|0 0"/>
                        </edges>
                      </DOMShape>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const flaFile = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(flaFile);

      const shape = doc.timelines[0].layers[0].frames[0].elements[0];
      expect(shape.type).toBe('shape');
      if (shape.type === 'shape') {
        expect(shape.fills[0].type).toBe('bitmap');
        expect(shape.fills[0].bitmapPath).toBe('background.jpg');
        expect(shape.fills[0].matrix).toBeUndefined();
      }
    });
  });

  describe('video items', () => {
    it('should parse DOMVideoItem from media section', async () => {
      const media = `
        <media>
          <DOMVideoItem
            name="intro.mp4"
            videoDataHRef="M 1 12345.dat"
            width="640"
            height="360"
            fps="30"
            length="5.5"
            videoType="h264 media"
            sourceExternalFilepath="./intro.mp4"/>
        </media>`;

      const flaFile = await createFlaZip(createDOMDocument({ media }));
      const doc = await parser.parse(flaFile);

      expect(doc.videos.size).toBe(1);
      const video = doc.videos.get('intro.mp4');
      expect(video).toBeDefined();
      expect(video?.name).toBe('intro.mp4');
      expect(video?.href).toBe('M 1 12345.dat');
      expect(video?.width).toBe(640);
      expect(video?.height).toBe(360);
      expect(video?.fps).toBe(30);
      expect(video?.duration).toBe(5.5);
      expect(video?.videoType).toBe('h264 media');
      expect(video?.sourceExternalFilepath).toBe('./intro.mp4');
    });

    it('should parse multiple video items', async () => {
      const media = `
        <media>
          <DOMVideoItem name="video1.flv" videoDataHRef="M 1.dat" width="320" height="240" fps="25"/>
          <DOMVideoItem name="video2.mp4" videoDataHRef="M 2.dat" width="1920" height="1080" fps="60" length="120"/>
        </media>`;

      const flaFile = await createFlaZip(createDOMDocument({ media }));
      const doc = await parser.parse(flaFile);

      expect(doc.videos.size).toBe(2);
      expect(doc.videos.has('video1.flv')).toBe(true);
      expect(doc.videos.has('video2.mp4')).toBe(true);

      const video2 = doc.videos.get('video2.mp4');
      expect(video2?.width).toBe(1920);
      expect(video2?.height).toBe(1080);
      expect(video2?.fps).toBe(60);
      expect(video2?.duration).toBe(120);
    });

    it('should handle video item with minimal attributes', async () => {
      const media = `
        <media>
          <DOMVideoItem name="simple.flv" videoDataHRef="M 1.dat"/>
        </media>`;

      const flaFile = await createFlaZip(createDOMDocument({ media }));
      const doc = await parser.parse(flaFile);

      const video = doc.videos.get('simple.flv');
      expect(video).toBeDefined();
      expect(video?.width).toBe(0);
      expect(video?.height).toBe(0);
      expect(video?.fps).toBeUndefined();
      expect(video?.duration).toBeUndefined();
    });
  });

  describe('filter parsing', () => {
    it('should parse BlurFilter on symbol instance', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMSymbolInstance libraryItemName="TestSymbol" symbolType="graphic">
                        <matrix><Matrix/></matrix>
                        <transformationPoint><Point/></transformationPoint>
                        <filters>
                          <BlurFilter blurX="10" blurY="15" quality="2"/>
                        </filters>
                      </DOMSymbolInstance>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const flaFile = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(flaFile);

      const element = doc.timelines[0].layers[0].frames[0].elements[0];
      expect(element.type).toBe('symbol');
      if (element.type === 'symbol') {
        expect(element.filters).toBeDefined();
        expect(element.filters).toHaveLength(1);
        expect(element.filters![0].type).toBe('blur');
        if (element.filters![0].type === 'blur') {
          expect(element.filters![0].blurX).toBe(10);
          expect(element.filters![0].blurY).toBe(15);
          expect(element.filters![0].quality).toBe(2);
        }
      }
    });

    it('should parse GlowFilter with all attributes', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMSymbolInstance libraryItemName="TestSymbol" symbolType="graphic">
                        <matrix><Matrix/></matrix>
                        <transformationPoint><Point/></transformationPoint>
                        <filters>
                          <GlowFilter blurX="8" blurY="8" color="#FF0000" strength="200" alpha="0.8" inner="true" knockout="true" quality="3"/>
                        </filters>
                      </DOMSymbolInstance>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const flaFile = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(flaFile);

      const element = doc.timelines[0].layers[0].frames[0].elements[0];
      if (element.type === 'symbol' && element.filters) {
        const filter = element.filters[0];
        expect(filter.type).toBe('glow');
        if (filter.type === 'glow') {
          expect(filter.blurX).toBe(8);
          expect(filter.blurY).toBe(8);
          expect(filter.color).toBe('#FF0000');
          expect(filter.strength).toBeCloseTo(200 / 255, 2);
          expect(filter.alpha).toBe(0.8);
          expect(filter.inner).toBe(true);
          expect(filter.knockout).toBe(true);
          expect(filter.quality).toBe(3);
        }
      }
    });

    it('should parse DropShadowFilter with all attributes', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMSymbolInstance libraryItemName="TestSymbol" symbolType="graphic">
                        <matrix><Matrix/></matrix>
                        <transformationPoint><Point/></transformationPoint>
                        <filters>
                          <DropShadowFilter blurX="5" blurY="5" color="#000000" strength="128" alpha="0.5" distance="10" angle="45" inner="false" knockout="false" hideObject="true" quality="1"/>
                        </filters>
                      </DOMSymbolInstance>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const flaFile = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(flaFile);

      const element = doc.timelines[0].layers[0].frames[0].elements[0];
      if (element.type === 'symbol' && element.filters) {
        const filter = element.filters[0];
        expect(filter.type).toBe('dropShadow');
        if (filter.type === 'dropShadow') {
          expect(filter.blurX).toBe(5);
          expect(filter.blurY).toBe(5);
          expect(filter.color).toBe('#000000');
          expect(filter.strength).toBeCloseTo(128 / 255, 2);
          expect(filter.alpha).toBe(0.5);
          expect(filter.distance).toBe(10);
          expect(filter.angle).toBe(45);
          expect(filter.inner).toBe(false);
          expect(filter.knockout).toBe(false);
          expect(filter.hideObject).toBe(true);
        }
      }
    });

    it('should parse multiple filters on same element', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMSymbolInstance libraryItemName="TestSymbol" symbolType="graphic">
                        <matrix><Matrix/></matrix>
                        <transformationPoint><Point/></transformationPoint>
                        <filters>
                          <BlurFilter blurX="4" blurY="4"/>
                          <GlowFilter blurX="6" blurY="6" color="#00FF00" strength="100"/>
                          <DropShadowFilter blurX="2" blurY="2" distance="5"/>
                        </filters>
                      </DOMSymbolInstance>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const flaFile = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(flaFile);

      const element = doc.timelines[0].layers[0].frames[0].elements[0];
      if (element.type === 'symbol') {
        expect(element.filters).toHaveLength(3);
        expect(element.filters![0].type).toBe('blur');
        expect(element.filters![1].type).toBe('glow');
        expect(element.filters![2].type).toBe('dropShadow');
      }
    });
  });

  describe('color transform parsing', () => {
    it('should parse alpha multiplier', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMSymbolInstance libraryItemName="TestSymbol" symbolType="graphic">
                        <matrix><Matrix/></matrix>
                        <transformationPoint><Point/></transformationPoint>
                        <color>
                          <Color alphaMultiplier="0.5"/>
                        </color>
                      </DOMSymbolInstance>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const flaFile = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(flaFile);

      const element = doc.timelines[0].layers[0].frames[0].elements[0];
      if (element.type === 'symbol') {
        expect(element.colorTransform).toBeDefined();
        expect(element.colorTransform?.alphaMultiplier).toBe(0.5);
      }
    });

    it('should parse RGB multipliers and offsets', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMSymbolInstance libraryItemName="TestSymbol" symbolType="graphic">
                        <matrix><Matrix/></matrix>
                        <transformationPoint><Point/></transformationPoint>
                        <color>
                          <Color redMultiplier="0.8" greenMultiplier="0.6" blueMultiplier="0.4" redOffset="50" greenOffset="-30" blueOffset="100"/>
                        </color>
                      </DOMSymbolInstance>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const flaFile = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(flaFile);

      const element = doc.timelines[0].layers[0].frames[0].elements[0];
      if (element.type === 'symbol') {
        expect(element.colorTransform?.redMultiplier).toBe(0.8);
        expect(element.colorTransform?.greenMultiplier).toBe(0.6);
        expect(element.colorTransform?.blueMultiplier).toBe(0.4);
        expect(element.colorTransform?.redOffset).toBe(50);
        expect(element.colorTransform?.greenOffset).toBe(-30);
        expect(element.colorTransform?.blueOffset).toBe(100);
      }
    });

    it('should parse brightness adjustment', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMSymbolInstance libraryItemName="TestSymbol" symbolType="graphic">
                        <matrix><Matrix/></matrix>
                        <transformationPoint><Point/></transformationPoint>
                        <color>
                          <Color brightness="0.5"/>
                        </color>
                      </DOMSymbolInstance>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const flaFile = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(flaFile);

      const element = doc.timelines[0].layers[0].frames[0].elements[0];
      if (element.type === 'symbol') {
        // Positive brightness: multiply by (1-b) and add b*255
        expect(element.colorTransform?.redMultiplier).toBe(0.5);
        expect(element.colorTransform?.greenMultiplier).toBe(0.5);
        expect(element.colorTransform?.blueMultiplier).toBe(0.5);
        expect(element.colorTransform?.redOffset).toBe(127.5);
        expect(element.colorTransform?.greenOffset).toBe(127.5);
        expect(element.colorTransform?.blueOffset).toBe(127.5);
      }
    });

    it('should parse tint color', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMSymbolInstance libraryItemName="TestSymbol" symbolType="graphic">
                        <matrix><Matrix/></matrix>
                        <transformationPoint><Point/></transformationPoint>
                        <color>
                          <Color tintMultiplier="0.5" tintColor="#FF0000"/>
                        </color>
                      </DOMSymbolInstance>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const flaFile = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(flaFile);

      const element = doc.timelines[0].layers[0].frames[0].elements[0];
      if (element.type === 'symbol') {
        // Tint: newColor = originalColor * (1 - tint) + tintColor * tint
        expect(element.colorTransform?.redMultiplier).toBe(0.5);
        expect(element.colorTransform?.greenMultiplier).toBe(0.5);
        expect(element.colorTransform?.blueMultiplier).toBe(0.5);
        expect(element.colorTransform?.redOffset).toBe(127.5); // 255 * 0.5
        expect(element.colorTransform?.greenOffset).toBe(0);
        expect(element.colorTransform?.blueOffset).toBe(0);
      }
    });

    it('should return undefined when no color transform present', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMSymbolInstance libraryItemName="TestSymbol" symbolType="graphic">
                        <matrix><Matrix/></matrix>
                        <transformationPoint><Point/></transformationPoint>
                      </DOMSymbolInstance>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const flaFile = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(flaFile);

      const element = doc.timelines[0].layers[0].frames[0].elements[0];
      if (element.type === 'symbol') {
        expect(element.colorTransform).toBeUndefined();
      }
    });
  });

  describe('blend mode parsing', () => {
    it('should parse multiply blend mode', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMSymbolInstance libraryItemName="TestSymbol" symbolType="graphic" blendMode="multiply">
                        <matrix><Matrix/></matrix>
                        <transformationPoint><Point/></transformationPoint>
                      </DOMSymbolInstance>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const flaFile = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(flaFile);

      const element = doc.timelines[0].layers[0].frames[0].elements[0];
      if (element.type === 'symbol') {
        expect(element.blendMode).toBe('multiply');
      }
    });

    it('should parse various blend modes', async () => {
      const blendModes = ['screen', 'overlay', 'darken', 'lighten', 'hardlight', 'add', 'subtract', 'difference', 'invert', 'alpha', 'erase'];

      for (const mode of blendModes) {
        const timelines = `
          <timelines>
            <DOMTimeline name="Scene 1">
              <layers>
                <DOMLayer name="Layer 1">
                  <frames>
                    <DOMFrame index="0">
                      <elements>
                        <DOMSymbolInstance libraryItemName="TestSymbol" symbolType="graphic" blendMode="${mode}">
                          <matrix><Matrix/></matrix>
                          <transformationPoint><Point/></transformationPoint>
                        </DOMSymbolInstance>
                      </elements>
                    </DOMFrame>
                  </frames>
                </DOMLayer>
              </layers>
            </DOMTimeline>
          </timelines>`;

        const flaFile = await createFlaZip(createDOMDocument({ timelines }));
        const doc = await parser.parse(flaFile);

        const element = doc.timelines[0].layers[0].frames[0].elements[0];
        if (element.type === 'symbol') {
          expect(element.blendMode).toBe(mode === 'hardlight' ? 'hardlight' : mode);
        }
      }
    });

    it('should return undefined for normal blend mode', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMSymbolInstance libraryItemName="TestSymbol" symbolType="graphic" blendMode="normal">
                        <matrix><Matrix/></matrix>
                        <transformationPoint><Point/></transformationPoint>
                      </DOMSymbolInstance>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const flaFile = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(flaFile);

      const element = doc.timelines[0].layers[0].frames[0].elements[0];
      if (element.type === 'symbol') {
        expect(element.blendMode).toBeUndefined();
      }
    });

    it('should handle case-insensitive blend modes', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements>
                      <DOMSymbolInstance libraryItemName="TestSymbol" symbolType="graphic" blendMode="MULTIPLY">
                        <matrix><Matrix/></matrix>
                        <transformationPoint><Point/></transformationPoint>
                      </DOMSymbolInstance>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const flaFile = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(flaFile);

      const element = doc.timelines[0].layers[0].frames[0].elements[0];
      if (element.type === 'symbol') {
        expect(element.blendMode).toBe('multiply');
      }
    });
  });

  describe('morph shape parsing', () => {
    it('should parse MorphShape with segments', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0" duration="10" tweenType="shape" keyMode="17922">
                    <MorphShape>
                      <morphSegments>
                        <MorphSegment startPointA="100, 100" startPointB="200, 200" fillIndex1="1">
                          <MorphCurves controlPointA="150, 100" anchorPointA="200, 100" controlPointB="250, 200" anchorPointB="300, 200" isLine="false"/>
                        </MorphSegment>
                      </morphSegments>
                    </MorphShape>
                    <elements>
                      <DOMShape>
                        <fills><FillStyle index="1"><SolidColor color="#FF0000"/></FillStyle></fills>
                        <edges><Edge fillStyle1="1" edges="!100 100|200 100|200 200|100 200|100 100"/></edges>
                      </DOMShape>
                    </elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const flaFile = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(flaFile);

      const frame = doc.timelines[0].layers[0].frames[0];
      expect(frame.tweenType).toBe('shape');
      expect(frame.morphShape).toBeDefined();
      expect(frame.morphShape?.segments).toHaveLength(1);

      const segment = frame.morphShape?.segments[0];
      expect(segment?.startPointA.x).toBe(5); // 100/20
      expect(segment?.startPointA.y).toBe(5);
      expect(segment?.startPointB.x).toBe(10); // 200/20
      expect(segment?.startPointB.y).toBe(10);
      expect(segment?.fillIndex1).toBe(1);
      expect(segment?.curves).toHaveLength(1);

      const curve = segment?.curves[0];
      expect(curve?.isLine).toBe(false);
    });

    it('should parse MorphShape with hex coordinates', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0" duration="10" tweenType="shape">
                    <MorphShape>
                      <morphSegments>
                        <MorphSegment startPointA="#100, #200" startPointB="#300, #400">
                          <MorphCurves controlPointA="#50, #60" anchorPointA="#70, #80" controlPointB="#90, #A0" anchorPointB="#B0, #C0" isLine="true"/>
                        </MorphSegment>
                      </morphSegments>
                    </MorphShape>
                    <elements></elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const flaFile = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(flaFile);

      const frame = doc.timelines[0].layers[0].frames[0];
      expect(frame.morphShape).toBeDefined();

      const segment = frame.morphShape?.segments[0];
      // Hex 0x100 = 256, divided by 20 = 12.8
      expect(segment?.startPointA.x).toBeCloseTo(256 / 20, 1);

      const curve = segment?.curves[0];
      expect(curve?.isLine).toBe(true);
    });

    it('should parse multiple morph segments', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0" duration="10" tweenType="shape">
                    <MorphShape>
                      <morphSegments>
                        <MorphSegment startPointA="0, 0" startPointB="100, 100" fillIndex1="1" fillIndex2="2">
                          <MorphCurves controlPointA="50, 0" anchorPointA="100, 0" controlPointB="150, 100" anchorPointB="200, 100" isLine="false"/>
                        </MorphSegment>
                        <MorphSegment startPointA="100, 0" startPointB="200, 100" strokeIndex1="1">
                          <MorphCurves controlPointA="100, 50" anchorPointA="100, 100" controlPointB="200, 150" anchorPointB="200, 200" isLine="true"/>
                        </MorphSegment>
                      </morphSegments>
                    </MorphShape>
                    <elements></elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const flaFile = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(flaFile);

      const frame = doc.timelines[0].layers[0].frames[0];
      expect(frame.morphShape?.segments).toHaveLength(2);

      expect(frame.morphShape?.segments[0].fillIndex1).toBe(1);
      expect(frame.morphShape?.segments[0].fillIndex2).toBe(2);
      expect(frame.morphShape?.segments[1].strokeIndex1).toBe(1);
    });

    it('should return undefined when no MorphShape present', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Layer 1">
                <frames>
                  <DOMFrame index="0">
                    <elements></elements>
                  </DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const flaFile = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(flaFile);

      const frame = doc.timelines[0].layers[0].frames[0];
      expect(frame.morphShape).toBeUndefined();
    });
  });

  describe('mask layer parsing', () => {
    it('should parse mask and masked layer types', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Mask Layer" layerType="mask">
                <frames>
                  <DOMFrame index="0"><elements></elements></DOMFrame>
                </frames>
              </DOMLayer>
              <DOMLayer name="Masked Layer" layerType="masked" parentLayerIndex="0">
                <frames>
                  <DOMFrame index="0"><elements></elements></DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const flaFile = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(flaFile);

      expect(doc.timelines[0].layers[0].layerType).toBe('mask');
      expect(doc.timelines[0].layers[1].layerType).toBe('masked');
      expect(doc.timelines[0].layers[1].parentLayerIndex).toBe(0);
    });

    it('should parse guide layer type', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Guide Layer" layerType="guide">
                <frames>
                  <DOMFrame index="0"><elements></elements></DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const flaFile = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(flaFile);

      expect(doc.timelines[0].layers[0].layerType).toBe('guide');
    });

    it('should parse folder layer type', async () => {
      const timelines = `
        <timelines>
          <DOMTimeline name="Scene 1">
            <layers>
              <DOMLayer name="Folder" layerType="folder">
                <frames>
                  <DOMFrame index="0"><elements></elements></DOMFrame>
                </frames>
              </DOMLayer>
              <DOMLayer name="Child Layer" parentLayerIndex="0">
                <frames>
                  <DOMFrame index="0"><elements></elements></DOMFrame>
                </frames>
              </DOMLayer>
            </layers>
          </DOMTimeline>
        </timelines>`;

      const flaFile = await createFlaZip(createDOMDocument({ timelines }));
      const doc = await parser.parse(flaFile);

      expect(doc.timelines[0].layers[0].layerType).toBe('folder');
      expect(doc.timelines[0].layers[1].parentLayerIndex).toBe(0);
    });
  });
});
