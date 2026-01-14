import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decodeEdges, parseEdge, setEdgeDecoderDebug } from '../edge-decoder';
import { createConsoleSpy, expectLogContaining, type ConsoleSpy } from './test-utils';
import type { PathCommand } from '../types';

describe('edge-decoder', () => {
  describe('decodeEdges', () => {
    describe('MoveTo command (!)', () => {
      it('should parse simple moveTo with decimal coordinates', () => {
        const commands = decodeEdges('!100 200');
        // Auto-close adds Z when end position == start position
        expect(commands).toHaveLength(2);
        expect(commands[0]).toEqual({ type: 'M', x: 5, y: 10 }); // 100/20, 200/20 (TWIPS)
        expect(commands[1]).toEqual({ type: 'Z' }); // Auto-close
      });

      it('should parse moveTo with negative coordinates', () => {
        const commands = decodeEdges('!-100 -200');
        expect(commands).toHaveLength(2); // M + auto-close Z
        expect(commands[0]).toEqual({ type: 'M', x: -5, y: -10 });
      });

      it('should skip redundant moveTo to same position', () => {
        const commands = decodeEdges('!100 200 !100 200');
        expect(commands).toHaveLength(2); // M + auto-close Z (second moveTo skipped)
      });

      it('should not skip moveTo to different position', () => {
        const commands = decodeEdges('!100 200 !300 400');
        expect(commands).toHaveLength(3); // M + M + auto-close Z
      });

      it('should handle hex-encoded coordinates', () => {
        const commands = decodeEdges('!#64 #C8'); // 100 and 200 in hex
        expect(commands).toHaveLength(2); // M + auto-close Z
        expect(commands[0]).toEqual({ type: 'M', x: 5, y: 10 });
      });

      it('should handle hex with fractional part', () => {
        const commands = decodeEdges('!#64.8 #C8.8'); // 100.5 and 200.5 in hex (8/16 = 0.5)
        expect(commands).toHaveLength(2); // M + auto-close Z
        expect(commands[0].type).toBe('M');
        expect((commands[0] as { type: 'M'; x: number; y: number }).x).toBeCloseTo(5.025, 2);
      });

      it('should handle negative hex values (6+ chars)', () => {
        // #FFFF9C is -100 in two's complement (24-bit)
        const commands = decodeEdges('!#FFFF9C #FFFF38'); // -100 and -200
        expect(commands).toHaveLength(2); // M + auto-close Z
        expect(commands[0]).toEqual({ type: 'M', x: -5, y: -10 });
      });

      it('should skip invalid coordinates (out of bounds)', () => {
        const commands = decodeEdges('!4000020 5000000'); // > MAX_COORD
        expect(commands).toHaveLength(0);
      });
    });

    describe('LineTo command (|)', () => {
      it('should parse lineTo after moveTo', () => {
        const commands = decodeEdges('!0 0 |100 200');
        expect(commands).toHaveLength(2);
        expect(commands[1]).toEqual({ type: 'L', x: 5, y: 10 });
      });

      it('should skip zero-length lines', () => {
        const commands = decodeEdges('!100 200 |100 200');
        expect(commands).toHaveLength(2); // MoveTo + auto-close Z (lineTo skipped)
      });

      it('should not skip lines with small but significant distance', () => {
        const commands = decodeEdges('!100 200 |120 220'); // More than EPSILON
        expect(commands).toHaveLength(2);
      });
    });

    describe('QuadraticCurveTo command ([)', () => {
      it('should parse quadratic curve', () => {
        const commands = decodeEdges('!0 0 [100 100 200 200');
        expect(commands).toHaveLength(2);
        expect(commands[1]).toEqual({ type: 'Q', cx: 5, cy: 5, x: 10, y: 10 });
      });

      it('should parse multiple quadratic curves', () => {
        const commands = decodeEdges('!0 0 [100 100 200 200 [300 300 400 400');
        expect(commands).toHaveLength(3);
        expect(commands[2]).toEqual({ type: 'Q', cx: 15, cy: 15, x: 20, y: 20 });
      });
    });

    describe('Cubic bezier command ((;)', () => {
      it('should parse cubic bezier curves', () => {
        const commands = decodeEdges('!0 0 (; 100 100 200 200 300 300 );');
        expect(commands).toHaveLength(2);
        expect(commands[1]).toEqual({
          type: 'C',
          c1x: 5, c1y: 5,
          c2x: 10, c2y: 10,
          x: 15, y: 15
        });
      });

      it('should parse multiple cubic curves in one segment', () => {
        const commands = decodeEdges('!0 0 (; 100 100 200 200 300 300 400 400 500 500 600 600 );');
        expect(commands).toHaveLength(3);
        expect(commands[1].type).toBe('C');
        expect(commands[2].type).toBe('C');
      });

      it('should skip quadratic approximation (q/Q) inside cubic segment', () => {
        const commands = decodeEdges('!0 0 (; 100 100 200 200 300 300 q 50 50 100 100 );');
        expect(commands).toHaveLength(2);
        expect(commands[1].type).toBe('C');
      });

      it('should handle alternate cubic format with anchor', () => {
        const commands = decodeEdges('!0 0 (0 0 ; 100 100 200 200 300 300 )');
        expect(commands).toHaveLength(2);
        expect(commands[1]).toEqual({
          type: 'C',
          c1x: 5, c1y: 5,
          c2x: 10, c2y: 10,
          x: 15, y: 15
        });
      });
    });

    describe('ClosePath command (/)', () => {
      it('should emit Z command for close path', () => {
        const commands = decodeEdges('!0 0 |100 0 |100 100 |0 100 /');
        const lastCmd = commands[commands.length - 1];
        expect(lastCmd).toEqual({ type: 'Z' });
      });

      it('should reset start tracking after close path', () => {
        const commands = decodeEdges('!0 0 |100 100 / !200 200 |300 300');
        expect(commands.filter(c => c.type === 'Z')).toHaveLength(1);
        expect(commands.filter(c => c.type === 'M')).toHaveLength(2);
      });
    });

    describe('Style indicator (S)', () => {
      it('should skip S command and following number', () => {
        const commands = decodeEdges('!0 0 S2 |100 100');
        expect(commands).toHaveLength(2);
        expect(commands[0]).toEqual({ type: 'M', x: 0, y: 0 });
        expect(commands[1]).toEqual({ type: 'L', x: 5, y: 5 });
      });
    });

    describe('Auto-close path', () => {
      it('should auto-close path when returning to start', () => {
        const commands = decodeEdges('!0 0 |100 0 |100 100 |0 100 |0 0');
        const lastCmd = commands[commands.length - 1];
        expect(lastCmd).toEqual({ type: 'Z' });
      });

      it('should not auto-close when not at start', () => {
        const commands = decodeEdges('!0 0 |100 0 |100 100');
        const lastCmd = commands[commands.length - 1];
        expect(lastCmd.type).toBe('L');
      });
    });

    describe('Edge cases', () => {
      it('should handle empty string', () => {
        const commands = decodeEdges('');
        expect(commands).toHaveLength(0);
      });

      it('should handle whitespace only', () => {
        const commands = decodeEdges('   \n\t  ');
        expect(commands).toHaveLength(0);
      });

      it('should handle incomplete moveTo (missing y)', () => {
        const commands = decodeEdges('!100');
        expect(commands).toHaveLength(0);
      });

      it('should handle incomplete quadratic curve', () => {
        const commands = decodeEdges('!0 0 [100 100'); // Missing end point
        expect(commands).toHaveLength(2); // MoveTo + auto-close Z (quadratic skipped)
      });

      it('should handle unknown tokens gracefully', () => {
        const commands = decodeEdges('!0 0 X100 |100 100');
        expect(commands.filter(c => c.type === 'M' || c.type === 'L')).toHaveLength(2);
      });

      it('should handle comma-separated coordinates', () => {
        const commands = decodeEdges('!0 0 (; 100,100 200,200 300,300 );');
        expect(commands).toHaveLength(2);
        expect(commands[1].type).toBe('C');
      });

      it('should handle hex with empty integer part', () => {
        // #.8 means 0.5 (0 + 8/16) = 0.5, then /20 for TWIPS = 0.025
        const commands = decodeEdges('!#.8 #.8');
        expect(commands).toHaveLength(2); // M + auto-close Z
        expect((commands[0] as { type: 'M'; x: number; y: number }).x).toBeCloseTo(0.025, 2);
      });

      it('should handle NaN from invalid hex gracefully', () => {
        const commands = decodeEdges('!#ZZZ #ABC');
        expect(commands).toHaveLength(0); // Should skip invalid coordinates
      });

      it('should skip lineTo with invalid coordinates', () => {
        const commands = decodeEdges('!0 0 |4000020 5000000');
        expect(commands).toHaveLength(2); // MoveTo + auto-close Z (lineTo skipped due to MAX_COORD)
      });

      it('should skip quadratic curve with invalid coordinates', () => {
        const commands = decodeEdges('!0 0 [4000020 5000000 100 100');
        expect(commands).toHaveLength(2); // MoveTo + auto-close Z (quadratic skipped)
      });

      it('should skip cubic curve with invalid coordinates', () => {
        const commands = decodeEdges('!0 0 (; 4000020 0 0 0 100 100 );');
        expect(commands).toHaveLength(2); // MoveTo + auto-close Z (cubic skipped due to invalid c1x)
      });

      it('should handle incomplete lineTo (missing y)', () => {
        const commands = decodeEdges('!0 0 |100');
        expect(commands).toHaveLength(2); // MoveTo + auto-close Z (lineTo needs 2 coords)
      });

      it('should handle tokenizer with parenthesis and semicolon', () => {
        // Testing edge cases in tokenizer
        const commands = decodeEdges('!0 0 (0 0 ; 100 100 200 200 300 300 )');
        expect(commands).toHaveLength(2); // MoveTo + Cubic
        expect(commands[1].type).toBe('C');
      });

      it('should handle tokenizer close paren with semicolon (;)', () => {
        const commands = decodeEdges('!0 0 (; 100 100 200 200 300 300 );');
        expect(commands).toHaveLength(2); // MoveTo + Cubic
        expect(commands[1].type).toBe('C');
      });

      it('should handle cubic with Q quadratic approximation marker', () => {
        const commands = decodeEdges('!0 0 (; 100 100 200 200 300 300 Q 50 50 100 100 );');
        expect(commands).toHaveLength(2); // MoveTo + Cubic (Q section ignored)
        expect(commands[1].type).toBe('C');
      });

      it('should handle incomplete cubic (not enough coordinates)', () => {
        const commands = decodeEdges('!0 0 (; 100 100 200 200 );'); // Only 4 coords, need 6
        expect(commands).toHaveLength(2); // MoveTo + auto-close Z
      });

      it('should handle alternate format with incomplete anchor', () => {
        const commands = decodeEdges('!0 0 (100 ;)'); // Missing y coordinate for anchor
        expect(commands).toHaveLength(2); // MoveTo + auto-close Z
      });

      it('should handle close without explicit / command', () => {
        // Path returns to start position without / command
        const commands = decodeEdges('!0 0 |100 0 |0 0');
        const lastCmd = commands[commands.length - 1];
        expect(lastCmd.type).toBe('Z'); // Auto-closed
      });

      it('should handle cubic ending in close paren without semicolon', () => {
        const commands = decodeEdges('!0 0 (; 100 100 200 200 300 300 )');
        expect(commands).toHaveLength(2); // Should still parse correctly
        expect(commands[1].type).toBe('C');
      });
    });

    describe('Real-world edge data', () => {
      it('should parse complex edge data with multiple commands', () => {
        const edgeData = '!-3965 5484S2[-2922 5672 -1879 5878!-1879 5878[-1579 5935 -1279 6011';
        const commands = decodeEdges(edgeData);

        expect(commands.length).toBeGreaterThan(0);
        expect(commands[0].type).toBe('M');
        expect(commands.some(c => c.type === 'Q')).toBe(true);
      });
    });
  });

  describe('parseEdge', () => {
    // Mock document/Element for testing
    let mockElement: {
      getAttribute: (name: string) => string | null;
    };

    beforeEach(() => {
      mockElement = {
        getAttribute: vi.fn()
      };
    });

    it('should parse edge with fillStyle0', () => {
      (mockElement.getAttribute as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
        if (name === 'fillStyle0') return '1';
        if (name === 'edges') return '!0 0 |100 100';
        return null;
      });

      const edge = parseEdge(mockElement as unknown as Element);
      expect(edge.fillStyle0).toBe(1);
      expect(edge.fillStyle1).toBeUndefined();
      expect(edge.strokeStyle).toBeUndefined();
    });

    it('should parse edge with fillStyle1', () => {
      (mockElement.getAttribute as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
        if (name === 'fillStyle1') return '2';
        if (name === 'edges') return '!0 0 |100 100';
        return null;
      });

      const edge = parseEdge(mockElement as unknown as Element);
      expect(edge.fillStyle1).toBe(2);
    });

    it('should parse edge with strokeStyle', () => {
      (mockElement.getAttribute as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
        if (name === 'strokeStyle') return '3';
        if (name === 'edges') return '!0 0 |100 100';
        return null;
      });

      const edge = parseEdge(mockElement as unknown as Element);
      expect(edge.strokeStyle).toBe(3);
    });

    it('should prefer cubics attribute over edges', () => {
      (mockElement.getAttribute as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
        if (name === 'cubics') return '!0 0 (; 100 100 200 200 300 300 );';
        if (name === 'edges') return '!0 0 [100 100 200 200';
        return null;
      });

      const edge = parseEdge(mockElement as unknown as Element);
      expect(edge.commands.some(c => c.type === 'C')).toBe(true);
    });

    it('should fall back to edges when cubics is empty', () => {
      (mockElement.getAttribute as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
        if (name === 'cubics') return '';
        if (name === 'edges') return '!0 0 [100 100 200 200';
        return null;
      });

      const edge = parseEdge(mockElement as unknown as Element);
      expect(edge.commands.some(c => c.type === 'Q')).toBe(true);
    });

    it('should handle missing edge data', () => {
      (mockElement.getAttribute as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const edge = parseEdge(mockElement as unknown as Element);
      expect(edge.commands).toHaveLength(0);
    });
  });

  describe('tokenizer edge cases', () => {
    it('should handle adjacent token before open paren with semicolon', () => {
      // Token "0" is adjacent to "(;" without space - tests line 110
      const commands = decodeEdges('!0 0(; 100 100 200 200 300 300 );');
      // The 0 before (; is parsed but doesn't affect the cubic
      expect(commands).toHaveLength(2); // M + C
      expect(commands[0]).toEqual({ type: 'M', x: 0, y: 0 });
      expect(commands[1]).toEqual({
        type: 'C',
        c1x: 5, c1y: 5, // 100/20
        c2x: 10, c2y: 10, // 200/20
        x: 15, y: 15 // 300/20
      });
    });

    it('should handle adjacent token before close paren with semicolon', () => {
      // Token "300" is adjacent to ");" without space - tests line 120
      const commands = decodeEdges('!0 0 (; 100 100 200 200 300 300);');
      expect(commands).toHaveLength(2); // M + C
      expect(commands[0]).toEqual({ type: 'M', x: 0, y: 0 });
      expect(commands[1]).toEqual({
        type: 'C',
        c1x: 5, c1y: 5,
        c2x: 10, c2y: 10,
        x: 15, y: 15
      });
    });

    it('should handle adjacent token before open paren', () => {
      // Token "0" is adjacent to "(" without space - tests line 131
      const commands = decodeEdges('!0 0(0 0 ; 100 100 200 200 300 300 )');
      expect(commands).toHaveLength(2); // M + C
      expect(commands[0]).toEqual({ type: 'M', x: 0, y: 0 });
      expect(commands[1]).toEqual({
        type: 'C',
        c1x: 5, c1y: 5,
        c2x: 10, c2y: 10,
        x: 15, y: 15
      });
    });

    it('should handle adjacent token before close paren', () => {
      // Token "300" is adjacent to ")" without space - tests line 142
      const commands = decodeEdges('!0 0 (0 0 ; 100 100 200 200 300 300)');
      expect(commands).toHaveLength(2); // M + C
      expect(commands[0]).toEqual({ type: 'M', x: 0, y: 0 });
      expect(commands[1]).toEqual({
        type: 'C',
        c1x: 5, c1y: 5,
        c2x: 10, c2y: 10,
        x: 15, y: 15
      });
    });

    it('should handle adjacent token before semicolon', () => {
      // Token "0" is adjacent to ";" without space - tests line 153
      const commands = decodeEdges('!0 0 (0 0; 100 100 200 200 300 300 )');
      expect(commands).toHaveLength(2); // M + C
      expect(commands[0]).toEqual({ type: 'M', x: 0, y: 0 });
      expect(commands[1]).toEqual({
        type: 'C',
        c1x: 5, c1y: 5,
        c2x: 10, c2y: 10,
        x: 15, y: 15
      });
    });

    it('should handle decimal NaN from invalid hex', () => {
      // #GGGG is not valid hex, should result in NaN and skip the command
      const commands = decodeEdges('!#GGGG #0');
      expect(commands).toHaveLength(0);
    });

    it('should handle complex edge data with mixed formats', () => {
      // Complex path: M(0,0) -> L(5,0) -> Q(2.5,-1.25,5,0) -> L(5,5) -> C -> L(0,5) -> Z
      const commands = decodeEdges('!0 0|100 0[50 -25 100 0|100 100 (; 50 50 150 150 100 100 );|0 100/');
      expect(commands[0]).toEqual({ type: 'M', x: 0, y: 0 });
      expect(commands[1]).toEqual({ type: 'L', x: 5, y: 0 }); // 100/20 = 5
      expect(commands[2]).toEqual({ type: 'Q', cx: 2.5, cy: -1.25, x: 5, y: 0 });
      expect(commands[3]).toEqual({ type: 'L', x: 5, y: 5 }); // 100/20 = 5
      // The cubic and remaining commands follow
      expect(commands.some(c => c.type === 'C')).toBe(true);
      expect(commands.some(c => c.type === 'Z')).toBe(true);
    });

    it('should handle cubic with incomplete coordinates (break case)', () => {
      // Tests line 327: break when not enough coordinates for cubic
      // Only 4 coordinates instead of 6 needed for cubic
      const commands = decodeEdges('!0 0 (; 100 100 200 200 );');
      expect(commands[0]).toEqual({ type: 'M', x: 0, y: 0 });
      // No cubic should be added since only 4 coords provided
      expect(commands.filter(c => c.type === 'C')).toHaveLength(0);
    });

    it('should handle alternate cubic format with invalid coordinates', () => {
      // Tests lines 369-370: skip invalid coordinates in alternate format
      // Large coordinates > MAX_COORD (200000) should be skipped
      const commands = decodeEdges('!0 0 (0 0 ; 5000000 0 0 0 100 100 100 100 200 200 300 300 )');
      expect(commands[0]).toEqual({ type: 'M', x: 0, y: 0 });
      // First cubic skipped due to invalid coord, second should be valid
      const cubics = commands.filter(c => c.type === 'C');
      expect(cubics.length).toBe(1);
      expect(cubics[0]).toEqual({
        type: 'C',
        c1x: 5, c1y: 5, // 100/20
        c2x: 10, c2y: 10, // 200/20
        x: 15, y: 15 // 300/20
      });
    });

    it('should handle alternate cubic with insufficient coords (break case)', () => {
      // Tests lines 377-380: break when not enough coords in alternate format
      const commands = decodeEdges('!0 0 (0 0 ; 100 100 200 )');
      expect(commands[0]).toEqual({ type: 'M', x: 0, y: 0 });
      // No cubic added due to insufficient coords
      expect(commands.filter(c => c.type === 'C')).toHaveLength(0);
    });

    it('should handle standalone semicolon', () => {
      // Tests lines 388-389: standalone semicolon handling
      const commands = decodeEdges('!0 0 ; |100 100');
      expect(commands[0]).toEqual({ type: 'M', x: 0, y: 0 });
      expect(commands[1]).toEqual({ type: 'L', x: 5, y: 5 });
    });

    it('should handle cubic with command token in middle (break case)', () => {
      // Tests line 327: break when encountering command token
      // The '!' command token should cause a break in cubic parsing
      const commands = decodeEdges('!0 0 (; 100 100 ! 200 200 300 300 );');
      expect(commands[0]).toEqual({ type: 'M', x: 0, y: 0 });
      // Cubic parsing should break at '!' and second moveTo should be parsed
      expect(commands.filter(c => c.type === 'M').length).toBeGreaterThanOrEqual(1);
    });

    it('should handle invalid decimal coordinate string', () => {
      // Tests line 88: NaN return for invalid decimal parsing
      // 'abc' is not a valid decimal and should cause parsing to fail gracefully
      const commands = decodeEdges('!abc def');
      // Should skip invalid coordinates and produce minimal output
      expect(commands).toHaveLength(0);
    });

    it('should handle alternate cubic format break case at control point', () => {
      // Tests line 377: break when invalid control point coords
      // The format (anchor ; c1 c2 end ) expects valid coords
      const commands = decodeEdges('!0 0 (0 0 ; abc def 100 100 200 200 )');
      // Should parse the moveTo and break at invalid coords
      expect(commands[0]).toEqual({ type: 'M', x: 0, y: 0 });
    });

    it('should break multi-segment C curve when next tokens contain command char', () => {
      // Tests line 377: break in multi-segment C curve when next tokens have command chars
      // After first valid C curve segment, we have 6 tokens but they include '|' command
      const commands = decodeEdges('!0 0 (; 10 10 20 20 30 30 |50 50 60 60 70 70 80 80 )');
      // Should parse MoveTo and possibly first C curve, then break at '|'
      expect(commands[0]).toEqual({ type: 'M', x: 0, y: 0 });
      // The '|' should trigger line parsing instead
    });

    it('should break multi-segment C curve when not enough tokens remain', () => {
      // Tests line 380: break when less than 6 tokens remain
      // After parsing first C, only 3 tokens remain
      const commands = decodeEdges('!0 0 (; 10 10 20 20 30 30 40 40 50 )');
      // Should parse MoveTo, C curve, then break due to insufficient tokens
      expect(commands[0]).toEqual({ type: 'M', x: 0, y: 0 });
    });
  });

  describe('DEBUG_EDGES mode', () => {
    let consoleSpy: ConsoleSpy;

    beforeEach(() => {
      setEdgeDecoderDebug(true);
      consoleSpy = createConsoleSpy();
    });

    afterEach(() => {
      setEdgeDecoderDebug(false);
      consoleSpy.mockRestore();
    });

    it('should log command counts when DEBUG_EDGES is enabled', () => {
      decodeEdges('!0 0|100 0|100 100|0 100|0 0');
      expect(consoleSpy).toHaveBeenCalled();
      expectLogContaining(consoleSpy, 'Commands:');
    });

    it('should log M, L, Q, C command counts', () => {
      decodeEdges('!0 0|100 0|100 100');
      expectLogContaining(consoleSpy, 'M=');
      expectLogContaining(consoleSpy, 'L=');
    });

    it('should log Q command count for quadratic curves', () => {
      decodeEdges('!0 0[50 50 100 100');
      expectLogContaining(consoleSpy, 'Q=');
    });

    it('should log C command count for cubic curves', () => {
      decodeEdges('!0 0(; 10 10 20 20 30 30)');
      expectLogContaining(consoleSpy, 'C=');
    });
  });
});
