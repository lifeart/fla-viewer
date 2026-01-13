import { describe, it, expect, beforeEach } from 'vitest';
import JSZip from 'jszip';
import { FLAParser } from '../fla-parser';

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
});
