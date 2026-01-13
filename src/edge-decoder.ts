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
 *
 * Cubics format (alternative):
 * - ! = moveTo (same)
 * - (; c1x,c1y c2x,c2y ex,ey ... ); = cubic bezier curve
 * - q/Q followed by coords = quadratic approximation (ignored, we use cubic)
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
  let i = 0;

  while (i < edgeStr.length) {
    const char = edgeStr[i];

    // Check for two-character tokens first
    if (char === '(' && i + 1 < edgeStr.length && edgeStr[i + 1] === ';') {
      if (current.trim()) {
        tokens.push(current.trim());
      }
      tokens.push('(;');
      current = '';
      i += 2;
      continue;
    }

    if (char === ')' && i + 1 < edgeStr.length && edgeStr[i + 1] === ';') {
      if (current.trim()) {
        tokens.push(current.trim());
      }
      tokens.push(');');
      current = '';
      i += 2;
      continue;
    }

    // Single-character command tokens
    if (char === '!' || char === '|' || char === '[' || char === '/' || char === 'S' || char === 'q' || char === 'Q') {
      if (current.trim()) {
        tokens.push(current.trim());
      }
      tokens.push(char);
      current = '';
      i++;
      continue;
    }

    // Whitespace separates tokens
    if (char === ' ' || char === '\n' || char === '\r' || char === '\t') {
      if (current.trim()) {
        tokens.push(current.trim());
      }
      current = '';
      i++;
      continue;
    }

    // Comma separates coordinates within cubics format
    if (char === ',') {
      if (current.trim()) {
        tokens.push(current.trim());
      }
      current = '';
      i++;
      continue;
    }

    current += char;
    i++;
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

      case '(;': {
        // Start of cubic bezier segment
        // Format: (; c1x,c1y c2x,c2y ex,ey [more curves...] [q/Q quadratic approx...] );
        i++;

        // Parse cubic bezier curves until we hit q, Q, or );
        while (i < tokens.length && tokens[i] !== 'q' && tokens[i] !== 'Q' && tokens[i] !== ');') {
          // Need 6 coordinates for a cubic: c1x, c1y, c2x, c2y, x, y
          if (i + 5 < tokens.length) {
            const nextTokens = [tokens[i], tokens[i+1], tokens[i+2], tokens[i+3], tokens[i+4], tokens[i+5]];
            // Check if these look like coordinates (not commands)
            const allCoords = nextTokens.every(t =>
              !['!', '|', '[', '/', 'S', 'q', 'Q', '(;', ');'].includes(t)
            );

            if (allCoords) {
              const c1x = decodeCoord(tokens[i]);
              const c1y = decodeCoord(tokens[i + 1]);
              const c2x = decodeCoord(tokens[i + 2]);
              const c2y = decodeCoord(tokens[i + 3]);
              const x = decodeCoord(tokens[i + 4]);
              const y = decodeCoord(tokens[i + 5]);
              commands.push({ type: 'C', c1x, c1y, c2x, c2y, x, y });
              i += 6;
            } else {
              break;
            }
          } else {
            break;
          }
        }
        break;
      }

      case 'q':
      case 'Q': {
        // Quadratic approximation in cubics format - skip along with following coordinates
        // These come after the cubic data and before );
        // Skip until we hit );
        i++;
        while (i < tokens.length && tokens[i] !== ');' && tokens[i] !== '!') {
          i++;
        }
        break;
      }

      case ');': {
        // End of cubic bezier segment
        i++;
        break;
      }

      case 'S': {
        // Style indicator - skip the number following it
        i += 2;
        break;
      }

      case '/': {
        // Close path - emit Z command
        commands.push({ type: 'Z' });
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
