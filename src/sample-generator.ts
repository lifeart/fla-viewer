import JSZip from 'jszip';

/**
 * Generates a sample FLA file with an animated smiling kitty.
 * The animation has 4 frames with a blinking effect.
 */
export async function generateSampleFLA(): Promise<File> {
  const zip = new JSZip();

  const width = 400;
  const height = 400;
  const frameRate = 4;

  // Create DOMDocument.xml with animated kitty
  const domDocument = createDOMDocument(width, height, frameRate);
  zip.file('DOMDocument.xml', domDocument);

  // Create the blob and convert to File
  const blob = await zip.generateAsync({ type: 'blob' });
  return new File([blob], 'sample-kitty.fla', { type: 'application/octet-stream' });
}

function createDOMDocument(width: number, height: number, frameRate: number): string {
  // Kitty face parameters (in pixels, will convert to twips for edges)
  const centerX = width / 2;
  const centerY = height / 2;
  const faceRadius = 120;

  // Generate frames with blinking animation
  const frames = [
    createKittyFrame(0, centerX, centerY, faceRadius, true),   // Eyes open
    createKittyFrame(1, centerX, centerY, faceRadius, true),   // Eyes open
    createKittyFrame(2, centerX, centerY, faceRadius, false),  // Eyes closed (blink)
    createKittyFrame(3, centerX, centerY, faceRadius, true),   // Eyes open
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<DOMDocument xmlns="http://ns.adobe.com/xfl/2008/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" width="${width}" height="${height}" frameRate="${frameRate}" backgroundColor="#FFE4B5">
  <timelines>
    <DOMTimeline name="Scene 1">
      <layers>
        <DOMLayer name="Kitty" color="#4FFF4F">
          <frames>
${frames.join('\n')}
          </frames>
        </DOMLayer>
      </layers>
    </DOMTimeline>
  </timelines>
</DOMDocument>`;
}

function createKittyFrame(index: number, cx: number, cy: number, radius: number, eyesOpen: boolean): string {
  const shapes: string[] = [];

  // Face (circle) - orange/peach color
  shapes.push(createCircleShape(cx, cy, radius, '#FFB347', '#000000', 2));

  // Left ear (triangle)
  shapes.push(createTriangleShape(
    cx - radius * 0.7, cy - radius * 0.5,
    cx - radius * 0.9, cy - radius * 1.1,
    cx - radius * 0.3, cy - radius * 0.9,
    '#FFB347', '#000000', 2
  ));

  // Right ear (triangle)
  shapes.push(createTriangleShape(
    cx + radius * 0.7, cy - radius * 0.5,
    cx + radius * 0.9, cy - radius * 1.1,
    cx + radius * 0.3, cy - radius * 0.9,
    '#FFB347', '#000000', 2
  ));

  // Inner left ear (pink)
  shapes.push(createTriangleShape(
    cx - radius * 0.65, cy - radius * 0.55,
    cx - radius * 0.8, cy - radius * 0.95,
    cx - radius * 0.4, cy - radius * 0.8,
    '#FFB6C1', null, 0
  ));

  // Inner right ear (pink)
  shapes.push(createTriangleShape(
    cx + radius * 0.65, cy - radius * 0.55,
    cx + radius * 0.8, cy - radius * 0.95,
    cx + radius * 0.4, cy - radius * 0.8,
    '#FFB6C1', null, 0
  ));

  // Eyes
  const eyeY = cy - radius * 0.15;
  const eyeOffsetX = radius * 0.35;

  if (eyesOpen) {
    // Open eyes (white circles with black pupils)
    shapes.push(createCircleShape(cx - eyeOffsetX, eyeY, radius * 0.18, '#FFFFFF', '#000000', 1.5));
    shapes.push(createCircleShape(cx + eyeOffsetX, eyeY, radius * 0.18, '#FFFFFF', '#000000', 1.5));
    // Pupils
    shapes.push(createCircleShape(cx - eyeOffsetX, eyeY, radius * 0.08, '#000000', null, 0));
    shapes.push(createCircleShape(cx + eyeOffsetX, eyeY, radius * 0.08, '#000000', null, 0));
    // Eye shine
    shapes.push(createCircleShape(cx - eyeOffsetX - radius * 0.04, eyeY - radius * 0.04, radius * 0.03, '#FFFFFF', null, 0));
    shapes.push(createCircleShape(cx + eyeOffsetX - radius * 0.04, eyeY - radius * 0.04, radius * 0.03, '#FFFFFF', null, 0));
  } else {
    // Closed eyes (curved lines)
    shapes.push(createClosedEyeShape(cx - eyeOffsetX, eyeY, radius * 0.15));
    shapes.push(createClosedEyeShape(cx + eyeOffsetX, eyeY, radius * 0.15));
  }

  // Nose (small pink triangle)
  const noseY = cy + radius * 0.1;
  shapes.push(createTriangleShape(
    cx, noseY + radius * 0.1,
    cx - radius * 0.08, noseY,
    cx + radius * 0.08, noseY,
    '#FF69B4', '#000000', 1
  ));

  // Smile (curved line)
  shapes.push(createSmileShape(cx, noseY + radius * 0.15, radius * 0.25));

  // Whiskers
  const whiskerY = cy + radius * 0.05;
  shapes.push(createWhiskerShape(cx - radius * 0.15, whiskerY, -radius * 0.5, -radius * 0.1));
  shapes.push(createWhiskerShape(cx - radius * 0.15, whiskerY, -radius * 0.5, 0));
  shapes.push(createWhiskerShape(cx - radius * 0.15, whiskerY, -radius * 0.5, radius * 0.1));
  shapes.push(createWhiskerShape(cx + radius * 0.15, whiskerY, radius * 0.5, -radius * 0.1));
  shapes.push(createWhiskerShape(cx + radius * 0.15, whiskerY, radius * 0.5, 0));
  shapes.push(createWhiskerShape(cx + radius * 0.15, whiskerY, radius * 0.5, radius * 0.1));

  return `            <DOMFrame index="${index}" duration="1" keyMode="9728">
              <elements>
${shapes.map(s => '                ' + s).join('\n')}
              </elements>
            </DOMFrame>`;
}

// Convert pixels to twips (1 pixel = 20 twips)
function toTwips(pixels: number): number {
  return Math.round(pixels * 20);
}

function createCircleShape(cx: number, cy: number, radius: number, fillColor: string, strokeColor: string | null, strokeWidth: number): string {
  // Approximate circle with 4 quadratic bezier curves
  const t = toTwips;
  const r = radius;

  // Start at top, go clockwise
  const x1 = cx, y1 = cy - r;           // Top
  const x2 = cx + r, y2 = cy;           // Right
  const x3 = cx, y3 = cy + r;           // Bottom
  const x4 = cx - r, y4 = cy;           // Left

  // Control points for quadratic bezier circle approximation
  // For quadratic beziers, we use the outer corner points as control points
  const c1x = cx + r, c1y = cy - r;     // Top-right corner (top to right)
  const c3x = cx + r, c3y = cy + r;     // Bottom-right corner (right to bottom)
  const c5x = cx - r, c5y = cy + r;     // Bottom-left corner (bottom to left)
  const c7x = cx - r, c7y = cy - r;     // Top-left corner (left to top)

  // Edge path using quadratic beziers (approximating circle)
  const edges = `!${t(x1)} ${t(y1)}[${t(c1x)} ${t(c1y)} ${t(x2)} ${t(y2)}[${t(c3x)} ${t(c3y)} ${t(x3)} ${t(y3)}[${t(c5x)} ${t(c5y)} ${t(x4)} ${t(y4)}[${t(c7x)} ${t(c7y)} ${t(x1)} ${t(y1)}`;

  const fills = `
          <fills>
            <FillStyle index="1">
              <SolidColor color="${fillColor}"/>
            </FillStyle>
          </fills>`;

  const strokes = strokeColor ? `
          <strokes>
            <StrokeStyle index="1">
              <SolidStroke weight="${strokeWidth}" scaleMode="normal" caps="round" joints="round">
                <fill>
                  <SolidColor color="${strokeColor}"/>
                </fill>
              </SolidStroke>
            </StrokeStyle>
          </strokes>` : '';

  const strokeAttr = strokeColor ? ' strokeStyle="1"' : '';

  return `<DOMShape>${fills}${strokes}
          <edges>
            <Edge fillStyle1="1"${strokeAttr} edges="${edges}"/>
          </edges>
        </DOMShape>`;
}

function createTriangleShape(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, fillColor: string, strokeColor: string | null, strokeWidth: number): string {
  const t = toTwips;
  const edges = `!${t(x1)} ${t(y1)}|${t(x2)} ${t(y2)}|${t(x3)} ${t(y3)}|${t(x1)} ${t(y1)}`;

  const fills = `
          <fills>
            <FillStyle index="1">
              <SolidColor color="${fillColor}"/>
            </FillStyle>
          </fills>`;

  const strokes = strokeColor ? `
          <strokes>
            <StrokeStyle index="1">
              <SolidStroke weight="${strokeWidth}" scaleMode="normal" caps="round" joints="round">
                <fill>
                  <SolidColor color="${strokeColor}"/>
                </fill>
              </SolidStroke>
            </StrokeStyle>
          </strokes>` : '';

  const strokeAttr = strokeColor ? ' strokeStyle="1"' : '';

  return `<DOMShape>${fills}${strokes}
          <edges>
            <Edge fillStyle1="1"${strokeAttr} edges="${edges}"/>
          </edges>
        </DOMShape>`;
}

function createClosedEyeShape(cx: number, cy: number, width: number): string {
  const t = toTwips;
  // Simple curved line for closed eye
  const x1 = cx - width;
  const x2 = cx + width;
  const ctrlY = cy + width * 0.5;

  const edges = `!${t(x1)} ${t(cy)}[${t(cx)} ${t(ctrlY)} ${t(x2)} ${t(cy)}`;

  return `<DOMShape>
          <strokes>
            <StrokeStyle index="1">
              <SolidStroke weight="3" scaleMode="normal" caps="round" joints="round">
                <fill>
                  <SolidColor color="#000000"/>
                </fill>
              </SolidStroke>
            </StrokeStyle>
          </strokes>
          <edges>
            <Edge strokeStyle="1" edges="${edges}"/>
          </edges>
        </DOMShape>`;
}

function createSmileShape(cx: number, cy: number, width: number): string {
  const t = toTwips;
  // Smile curve
  const x1 = cx - width;
  const x2 = cx + width;
  const ctrlY = cy + width * 0.6;

  const edges = `!${t(x1)} ${t(cy)}[${t(cx)} ${t(ctrlY)} ${t(x2)} ${t(cy)}`;

  return `<DOMShape>
          <strokes>
            <StrokeStyle index="1">
              <SolidStroke weight="2.5" scaleMode="normal" caps="round" joints="round">
                <fill>
                  <SolidColor color="#000000"/>
                </fill>
              </SolidStroke>
            </StrokeStyle>
          </strokes>
          <edges>
            <Edge strokeStyle="1" edges="${edges}"/>
          </edges>
        </DOMShape>`;
}

function createWhiskerShape(x1: number, y1: number, dx: number, dy: number): string {
  const t = toTwips;
  const x2 = x1 + dx;
  const y2 = y1 + dy;

  const edges = `!${t(x1)} ${t(y1)}|${t(x2)} ${t(y2)}`;

  return `<DOMShape>
          <strokes>
            <StrokeStyle index="1">
              <SolidStroke weight="1.5" scaleMode="normal" caps="round" joints="round">
                <fill>
                  <SolidColor color="#000000"/>
                </fill>
              </SolidStroke>
            </StrokeStyle>
          </strokes>
          <edges>
            <Edge strokeStyle="1" edges="${edges}"/>
          </edges>
        </DOMShape>`;
}
