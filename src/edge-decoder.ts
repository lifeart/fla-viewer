import type { PathCommand, Edge } from './types';

/**
 * Decodes XFL edge data format into path commands.
 *
 * XFL edge format uses a specialized encoding:
 * - ! = moveTo (absolute)
 * - | = lineTo (absolute)
 * - [ = quadratic curve (control point + end point)
 * - / = close path
 * - Coordinates can be decimal or hex-encoded (prefixed with #)
 * - Hex format: #XX.YY where XX is signed integer (variable width), YY is fractional
 * - All coordinates are in TWIPS (1/20 of a pixel)
 */

// Scale factor - XFL uses TWIPS (1/20 of a pixel)
const COORD_SCALE = 20;

// Decode a potentially hex-encoded coordinate value
function decodeCoord(value: string): number {
  if (value.startsWith('#')) {
    // Hex encoded format: #XXXX.YY or #XX.YY
    // Hex values are in a fixed-point format (not twips), scale differently
    const hex = value.substring(1);
    const dotIndex = hex.indexOf('.');

    let intHex: string;
    let fracHex: string | null = null;

    if (dotIndex !== -1) {
      intHex = hex.substring(0, dotIndex);
      fracHex = hex.substring(dotIndex + 1);
    } else {
      intHex = hex;
    }

    // Parse integer part
    let intPart = parseInt(intHex, 16);
    const numChars = intHex.length;

    // Apply two's complement for signed values
    // Only apply sign conversion for values with 4+ hex chars (16+ bits)
    // Small values (2 chars / 8 bits) are typically unsigned
    if (numChars >= 4) {
      const bitWidth = numChars * 4;
      const signBit = 1 << (bitWidth - 1);
      if (intPart >= signBit) {
        intPart = intPart - (1 << bitWidth);
      }
    }

    // Parse fractional part (always positive)
    let fracPart = 0;
    if (fracHex) {
      const fracBits = fracHex.length * 4;
      const fracValue = parseInt(fracHex, 16);
      fracPart = fracValue / (1 << fracBits);
    }

    // Combine, preserving sign for the fractional part
    const result = intPart >= 0 ? intPart + fracPart : intPart - fracPart;
    // Hex coordinates are in fixed-point format (1/256 of twips typically)
    // Divide by 256 to get twips, then by 20 to get pixels = divide by 5120
    // But some implementations use divide by 20 only, let's try that
    return result / COORD_SCALE;
  } else {
    // Decimal values are in twips (1/20 of a pixel)
    return parseFloat(value) / COORD_SCALE;
  }
}

// Parse edge string into tokens
function tokenize(edgeStr: string): string[] {
  const tokens: string[] = [];
  let current = '';

  for (let i = 0; i < edgeStr.length; i++) {
    const char = edgeStr[i];

    if (char === '!' || char === '|' || char === '[' || char === '/' || char === 'S') {
      if (current.trim()) {
        tokens.push(current.trim());
      }
      tokens.push(char);
      current = '';
    } else if (char === ' ' || char === '\n' || char === '\r' || char === '\t') {
      if (current.trim()) {
        tokens.push(current.trim());
      }
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    tokens.push(current.trim());
  }

  return tokens;
}

export function decodeEdges(edgeStr: string): PathCommand[] {
  const commands: PathCommand[] = [];
  const tokens = tokenize(edgeStr);

  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];

    switch (token) {
      case '!': {
        // MoveTo: ! x y (absolute coordinates)
        if (i + 2 < tokens.length) {
          const x = decodeCoord(tokens[i + 1]);
          const y = decodeCoord(tokens[i + 2]);
          commands.push({ type: 'M', x, y });
          i += 3;
        } else {
          i++;
        }
        break;
      }

      case '|': {
        // LineTo: | x y (absolute coordinates)
        if (i + 2 < tokens.length) {
          const x = decodeCoord(tokens[i + 1]);
          const y = decodeCoord(tokens[i + 2]);
          commands.push({ type: 'L', x, y });
          i += 3;
        } else {
          i++;
        }
        break;
      }

      case '[': {
        // QuadraticCurveTo: [ cx cy x y (absolute coordinates)
        if (i + 4 < tokens.length) {
          const cx = decodeCoord(tokens[i + 1]);
          const cy = decodeCoord(tokens[i + 2]);
          const x = decodeCoord(tokens[i + 3]);
          const y = decodeCoord(tokens[i + 4]);
          commands.push({ type: 'Q', cx, cy, x, y });
          i += 5;
        } else {
          i++;
        }
        break;
      }

      case 'S': {
        // Style indicator - skip the number following it
        i += 2;
        break;
      }

      case '/': {
        // Close path
        i++;
        break;
      }

      default: {
        // Unknown token, skip
        i++;
        break;
      }
    }
  }

  return commands;
}

// Parse a complete edge element from XML
export function parseEdge(edgeElement: globalThis.Element): Edge {
  const fillStyle0 = edgeElement.getAttribute('fillStyle0');
  const fillStyle1 = edgeElement.getAttribute('fillStyle1');
  const strokeStyle = edgeElement.getAttribute('strokeStyle');
  const edgesAttr = edgeElement.getAttribute('edges') || '';

  return {
    fillStyle0: fillStyle0 ? parseInt(fillStyle0) : undefined,
    fillStyle1: fillStyle1 ? parseInt(fillStyle1) : undefined,
    strokeStyle: strokeStyle ? parseInt(strokeStyle) : undefined,
    commands: decodeEdges(edgesAttr)
  };
}
