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
    // Per XFL spec: hex values are ALWAYS signed two's complement
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

    // Handle empty integer part
    if (intHex.length === 0) {
      intHex = '0';
    }

    // Parse integer part
    let intPart = parseInt(intHex, 16);

    // Check for NaN (invalid hex)
    if (Number.isNaN(intPart)) {
      return NaN;
    }

    const numChars = intHex.length;

    // Apply two's complement ONLY for 6+ char hex values
    // These are used specifically for negative numbers with FF sign extension
    // 2-char and 4-char values are unsigned (positive values use fewer digits)
    // Example: #81B9 = 33209 (unsigned), #FFBA70 = -17808 (signed 24-bit)
    if (numChars >= 6) {
      const bitWidth = numChars * 4;
      const signBit = 1 << (bitWidth - 1);
      if (intPart >= signBit) {
        intPart = intPart - (1 << bitWidth);
      }
    }

    // Parse fractional part (always positive, added/subtracted based on int sign)
    let fracPart = 0;
    if (fracHex && fracHex.length > 0) {
      const fracValue = parseInt(fracHex, 16);
      if (!Number.isNaN(fracValue)) {
        const fracBits = fracHex.length * 4;
        fracPart = fracValue / (1 << fracBits);
      }
    }

    // Combine, preserving sign for the fractional part
    const result = intPart >= 0 ? intPart + fracPart : intPart - fracPart;

    // Hex coordinates are in twips (1/20 of a pixel), same as decimal
    return result / COORD_SCALE;
  } else {
    // Decimal values are in twips (1/20 of a pixel)
    const parsed = parseFloat(value);
    if (Number.isNaN(parsed)) {
      return NaN;
    }
    return parsed / COORD_SCALE;
  }
}

// Parse edge string into tokens
function tokenize(edgeStr: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let i = 0;

  // Helper to check if a character is a command token
  const isCommandChar = (c: string) =>
    c === '!' || c === '|' || c === '[' || c === '/' || c === 'S' || c === 'q' || c === 'Q';

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

    // Handle '(' - start of cubic format or alternate cubic format
    if (char === '(') {
      if (current.trim()) {
        tokens.push(current.trim());
      }
      tokens.push('(');
      current = '';
      i++;
      continue;
    }

    // Handle ')' alone (not followed by ';')
    if (char === ')') {
      if (current.trim()) {
        tokens.push(current.trim());
      }
      tokens.push(')');
      current = '';
      i++;
      continue;
    }

    // Semicolon - separator in cubic format
    if (char === ';') {
      if (current.trim()) {
        tokens.push(current.trim());
      }
      tokens.push(';');
      current = '';
      i++;
      continue;
    }

    // Single-character command tokens - split even when attached to numbers
    if (isCommandChar(char)) {
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

// Debug flag - set to true to enable logging
const DEBUG_EDGES = false;

export function decodeEdges(edgeStr: string): PathCommand[] {
  const commands: PathCommand[] = [];
  const tokens = tokenize(edgeStr);

  let i = 0;
  let currentX = NaN;
  let currentY = NaN;
  let startX = NaN;  // Track path start for auto-close
  let startY = NaN;
  const EPSILON = 0.5; // Tolerance for coordinate comparison (in pixels)
  const MAX_COORD = 200000; // Maximum reasonable coordinate value (10000 pixels in twips)

  while (i < tokens.length) {
    const token = tokens[i];

    switch (token) {
      case '!': {
        // MoveTo: ! x y (absolute coordinates)
        if (i + 2 < tokens.length) {
          const x = decodeCoord(tokens[i + 1]);
          const y = decodeCoord(tokens[i + 2]);
          // Skip invalid coordinates
          if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) {
            i += 3;
            break;
          }
          // Skip redundant moveTo if we're already at this position
          if (Number.isNaN(currentX) || Math.abs(x - currentX) > EPSILON || Math.abs(y - currentY) > EPSILON) {
            commands.push({ type: 'M', x, y });
            // Track start of new subpath
            startX = x;
            startY = y;
          }
          currentX = x;
          currentY = y;
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
          // Skip invalid coordinates
          if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) {
            i += 3;
            break;
          }
          // Skip zero-length lines
          if (Math.abs(x - currentX) > EPSILON || Math.abs(y - currentY) > EPSILON) {
            commands.push({ type: 'L', x, y });
            currentX = x;
            currentY = y;
          }
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
          // Skip invalid coordinates
          if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(x) || !Number.isFinite(y) ||
              Math.abs(cx) > MAX_COORD || Math.abs(cy) > MAX_COORD || Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) {
            i += 5;
            break;
          }
          commands.push({ type: 'Q', cx, cy, x, y });
          currentX = x;
          currentY = y;
          i += 5;
        } else {
          i++;
        }
        break;
      }

      case '(;': {
        // Start of cubic bezier segment (standard format)
        // Format: (; c1x,c1y c2x,c2y ex,ey [more curves...] [q/Q quadratic approx...] );
        i++;

        // Parse cubic bezier curves until we hit q, Q, ); or )
        while (i < tokens.length && tokens[i] !== 'q' && tokens[i] !== 'Q' && tokens[i] !== ');' && tokens[i] !== ')') {
          // Need 6 coordinates for a cubic: c1x, c1y, c2x, c2y, x, y
          if (i + 5 < tokens.length) {
            const nextTokens = [tokens[i], tokens[i+1], tokens[i+2], tokens[i+3], tokens[i+4], tokens[i+5]];
            // Check if these look like coordinates (not commands)
            const allCoords = nextTokens.every(t =>
              !['!', '|', '[', '/', 'S', 'q', 'Q', '(;', ');', '(', ')', ';'].includes(t)
            );

            if (allCoords) {
              const c1x = decodeCoord(tokens[i]);
              const c1y = decodeCoord(tokens[i + 1]);
              const c2x = decodeCoord(tokens[i + 2]);
              const c2y = decodeCoord(tokens[i + 3]);
              const x = decodeCoord(tokens[i + 4]);
              const y = decodeCoord(tokens[i + 5]);
              // Skip invalid coordinates
              const coords = [c1x, c1y, c2x, c2y, x, y];
              if (coords.some(c => !Number.isFinite(c) || Math.abs(c) > MAX_COORD)) {
                i += 6;
                continue;
              }
              commands.push({ type: 'C', c1x, c1y, c2x, c2y, x, y });
              currentX = x;
              currentY = y;
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

      case '(': {
        // Alternate cubic format: (anchorX,anchorY; c1x,c1y c2x,c2y ex,ey...);
        // The '(' is followed by anchor coordinates, then ';', then cubic data
        i++;

        // Skip anchor coordinates until we hit ';'
        while (i < tokens.length && tokens[i] !== ';') {
          i++;
        }

        // Skip the ';' token
        if (i < tokens.length && tokens[i] === ';') {
          i++;
        }

        // Now parse cubic bezier curves (same as '(;' case)
        while (i < tokens.length && tokens[i] !== 'q' && tokens[i] !== 'Q' && tokens[i] !== ');' && tokens[i] !== ')') {
          if (i + 5 < tokens.length) {
            const nextTokens = [tokens[i], tokens[i+1], tokens[i+2], tokens[i+3], tokens[i+4], tokens[i+5]];
            const allCoords = nextTokens.every(t =>
              !['!', '|', '[', '/', 'S', 'q', 'Q', '(;', ');', '(', ')', ';'].includes(t)
            );

            if (allCoords) {
              const c1x = decodeCoord(tokens[i]);
              const c1y = decodeCoord(tokens[i + 1]);
              const c2x = decodeCoord(tokens[i + 2]);
              const c2y = decodeCoord(tokens[i + 3]);
              const x = decodeCoord(tokens[i + 4]);
              const y = decodeCoord(tokens[i + 5]);
              // Skip invalid coordinates
              const coords = [c1x, c1y, c2x, c2y, x, y];
              if (coords.some(c => !Number.isFinite(c) || Math.abs(c) > MAX_COORD)) {
                i += 6;
                continue;
              }
              commands.push({ type: 'C', c1x, c1y, c2x, c2y, x, y });
              currentX = x;
              currentY = y;
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

      case ';': {
        // Standalone semicolon - should have been handled in '(' case, skip
        i++;
        break;
      }

      case 'q':
      case 'Q': {
        // Quadratic approximation in cubics format - skip along with following coordinates
        // These come after the cubic data and before ); or )
        // Skip until we hit a terminator or new command
        i++;
        while (i < tokens.length &&
               tokens[i] !== ');' && tokens[i] !== ')' &&
               tokens[i] !== '!' && tokens[i] !== '|' && tokens[i] !== '[') {
          i++;
        }
        break;
      }

      case ');':
      case ')': {
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
        // Reset start tracking for next subpath
        startX = NaN;
        startY = NaN;
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

  // Auto-close path if we ended back at the start position
  if (!Number.isNaN(startX) && !Number.isNaN(currentX) &&
      Math.abs(currentX - startX) < EPSILON && Math.abs(currentY - startY) < EPSILON) {
    // Path returns to start but wasn't explicitly closed - add Z
    const lastCmd = commands[commands.length - 1];
    if (lastCmd && lastCmd.type !== 'Z') {
      commands.push({ type: 'Z' });
    }
  }

  if (DEBUG_EDGES && commands.length > 0) {
    const qCount = commands.filter(c => c.type === 'Q').length;
    const cCount = commands.filter(c => c.type === 'C').length;
    const lCount = commands.filter(c => c.type === 'L').length;
    const mCount = commands.filter(c => c.type === 'M').length;
    console.log(`Commands: M=${mCount} L=${lCount} Q=${qCount} C=${cCount}`);
  }

  return commands;
}

// Parse a complete edge element from XML
export function parseEdge(edgeElement: globalThis.Element): Edge {
  const fillStyle0 = edgeElement.getAttribute('fillStyle0');
  const fillStyle1 = edgeElement.getAttribute('fillStyle1');
  const strokeStyle = edgeElement.getAttribute('strokeStyle');
  // Edge data can be in either 'edges' or 'cubics' attribute
  const edgesAttr = edgeElement.getAttribute('edges') || '';
  const cubicsAttr = edgeElement.getAttribute('cubics') || '';

  // Use cubics if available (higher fidelity), otherwise use edges
  const dataAttr = cubicsAttr || edgesAttr;
  const commands = decodeEdges(dataAttr);

  return {
    fillStyle0: fillStyle0 ? parseInt(fillStyle0) : undefined,
    fillStyle1: fillStyle1 ? parseInt(fillStyle1) : undefined,
    strokeStyle: strokeStyle ? parseInt(strokeStyle) : undefined,
    commands
  };
}
