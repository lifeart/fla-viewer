import JSZip from 'jszip';
import type { ExternalPaletteColor } from './tvg-parser';

export interface TPLGradientStop {
  pos: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface TPLPaletteColor {
  type: 'solid' | 'gradient';
  name: string;
  id: string;
  r: number;
  g: number;
  b: number;
  a: number;
  gradientType?: 'linear' | 'radial';
  stops?: TPLGradientStop[];
}

export interface TPLPalette {
  name: string;
  colors: TPLPaletteColor[];
}

function findPalettePaths(zip: JSZip): string[] {
  const pltFiles: string[] = [];
  zip.forEach((path) => {
    if (path.endsWith('.plt') && path.includes('palette-library/')) {
      pltFiles.push(path);
    }
  });
  return pltFiles.sort();
}

export async function loadPalettes(zip: JSZip): Promise<TPLPalette[]> {
  const palettes: TPLPalette[] = [];
  for (const path of findPalettePaths(zip)) {
    const file = zip.file(path);
    if (!file) continue;
    const text = await file.async('text');
    const palette = parsePLT(text, path);
    if (palette) palettes.push(palette);
  }
  return palettes;
}

export function parsePLT(text: string, path: string): TPLPalette | null {
  const lines = text.split('\n');
  if (lines.length < 1 || !lines[0].includes('PaletteFile')) return null;

  const name = path.split('/').pop()?.replace('.plt', '') || 'Unknown';
  const colors: TPLPaletteColor[] = [];
  const namedEntry = '(?:"([^"]+)"|(\\S+))';

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('{') || line.startsWith('}')) continue;

    const solidMatch = line.match(new RegExp(`^Solid\\s+${namedEntry}\\s+(0x\\w+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)`));
    if (solidMatch) {
      colors.push({
        type: 'solid',
        name: solidMatch[1] || solidMatch[2],
        id: solidMatch[3],
        r: parseInt(solidMatch[4], 10),
        g: parseInt(solidMatch[5], 10),
        b: parseInt(solidMatch[6], 10),
        a: parseInt(solidMatch[7], 10),
      });
      continue;
    }

    const gradMatch = line.match(new RegExp(`^Gradient\\s+${namedEntry}\\s+(0x\\w+)\\s+(Linear|Radial)`, 'i'));
    if (!gradMatch) continue;

    const gradientType = gradMatch[4].toLowerCase() === 'radial' ? 'radial' as const : 'linear' as const;
    const stops: TPLGradientStop[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const stopLine = lines[j].trim();
      if (stopLine.startsWith('{')) continue;
      if (stopLine.startsWith('}') || stopLine === '') break;

      const cleaned = stopLine.replace(/[{},]/g, '').trim();
      const stopMatch = cleaned.match(/^\s*([\d.]+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
      if (stopMatch) {
        stops.push({
          pos: parseFloat(stopMatch[1]),
          r: parseInt(stopMatch[2], 10),
          g: parseInt(stopMatch[3], 10),
          b: parseInt(stopMatch[4], 10),
          a: parseInt(stopMatch[5], 10),
        });
      }
      if (stopLine.includes('}')) break;
    }

    const firstStop = stops.length > 0 ? stops[0] : { r: 128, g: 128, b: 128, a: 255 };
    colors.push({
      type: 'gradient',
      name: gradMatch[1] || gradMatch[2],
      id: gradMatch[3],
      r: firstStop.r,
      g: firstStop.g,
      b: firstStop.b,
      a: firstStop.a,
      gradientType,
      stops,
    });
  }

  return { name, colors };
}

export function flattenExternalPaletteColors(palettes: TPLPalette[]): ExternalPaletteColor[] {
  const externalColors: ExternalPaletteColor[] = [];
  for (const palette of palettes) {
    for (const color of palette.colors) {
      if (color.type === 'solid') {
        externalColors.push({
          r: color.r,
          g: color.g,
          b: color.b,
          a: color.a,
          id: color.id,
          name: color.name,
          paletteName: palette.name,
        });
      } else if (color.stops && color.stops.length > 0) {
        externalColors.push({
          r: color.r,
          g: color.g,
          b: color.b,
          a: color.a,
          id: color.id,
          name: color.name,
          paletteName: palette.name,
          gradientType: color.gradientType,
          stops: color.stops,
        });
      }
    }
  }
  return externalColors;
}
