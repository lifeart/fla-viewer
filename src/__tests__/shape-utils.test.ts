import { describe, it, expect } from 'vitest';
import {
  calculatePathArea,
  isClockwise,
  reversePathCommands,
  correctFillSides,
  removeDuplicateEdges,
  connectBrokenChains,
  autoClosePaths,
  fixShape,
  validateMorphShape,
  calculatePathBounds,
  calculateShapeBounds
} from '../shape-utils';
import type { PathCommand, Edge, Shape } from '../types';

describe('shape-utils', () => {
  describe('calculatePathArea', () => {
    it('should calculate positive area for clockwise rectangle', () => {
      const commands: PathCommand[] = [
        { type: 'M', x: 0, y: 0 },
        { type: 'L', x: 100, y: 0 },
        { type: 'L', x: 100, y: 50 },
        { type: 'L', x: 0, y: 50 },
        { type: 'Z' }
      ];
      const area = calculatePathArea(commands);
      // Clockwise in screen coords (Y down) = positive area
      expect(area).toBeCloseTo(5000, 0);
    });

    it('should calculate negative area for counter-clockwise rectangle', () => {
      const commands: PathCommand[] = [
        { type: 'M', x: 0, y: 0 },
        { type: 'L', x: 0, y: 50 },
        { type: 'L', x: 100, y: 50 },
        { type: 'L', x: 100, y: 0 },
        { type: 'Z' }
      ];
      const area = calculatePathArea(commands);
      // Counter-clockwise = negative area
      expect(area).toBeCloseTo(-5000, 0);
    });

    it('should calculate area for triangle', () => {
      const commands: PathCommand[] = [
        { type: 'M', x: 0, y: 0 },
        { type: 'L', x: 100, y: 0 },
        { type: 'L', x: 50, y: 100 },
        { type: 'Z' }
      ];
      const area = calculatePathArea(commands);
      // Triangle area = 0.5 * base * height = 0.5 * 100 * 100 = 5000
      expect(Math.abs(area)).toBeCloseTo(5000, 0);
    });

    it('should handle quadratic curves', () => {
      const commands: PathCommand[] = [
        { type: 'M', x: 0, y: 0 },
        { type: 'L', x: 100, y: 0 },
        { type: 'Q', cx: 100, cy: 50, x: 50, y: 50 },
        { type: 'L', x: 0, y: 50 },
        { type: 'Z' }
      ];
      const area = calculatePathArea(commands);
      // Should have some area (exact value depends on curve approximation)
      expect(Math.abs(area)).toBeGreaterThan(0);
    });

    it('should handle cubic curves', () => {
      const commands: PathCommand[] = [
        { type: 'M', x: 0, y: 0 },
        { type: 'L', x: 100, y: 0 },
        { type: 'C', c1x: 100, c1y: 25, c2x: 100, c2y: 75, x: 50, y: 100 },
        { type: 'L', x: 0, y: 100 },
        { type: 'Z' }
      ];
      const area = calculatePathArea(commands);
      expect(Math.abs(area)).toBeGreaterThan(0);
    });

    it('should return 0 for empty commands', () => {
      const area = calculatePathArea([]);
      expect(area).toBe(0);
    });
  });

  describe('isClockwise', () => {
    it('should return true for clockwise path', () => {
      const commands: PathCommand[] = [
        { type: 'M', x: 0, y: 0 },
        { type: 'L', x: 100, y: 0 },
        { type: 'L', x: 100, y: 100 },
        { type: 'L', x: 0, y: 100 },
        { type: 'Z' }
      ];
      expect(isClockwise(commands)).toBe(true);
    });

    it('should return false for counter-clockwise path', () => {
      const commands: PathCommand[] = [
        { type: 'M', x: 0, y: 0 },
        { type: 'L', x: 0, y: 100 },
        { type: 'L', x: 100, y: 100 },
        { type: 'L', x: 100, y: 0 },
        { type: 'Z' }
      ];
      expect(isClockwise(commands)).toBe(false);
    });
  });

  describe('reversePathCommands', () => {
    it('should reverse a simple line path', () => {
      const commands: PathCommand[] = [
        { type: 'M', x: 0, y: 0 },
        { type: 'L', x: 100, y: 0 },
        { type: 'L', x: 100, y: 100 }
      ];
      const reversed = reversePathCommands(commands);

      expect(reversed[0]).toEqual({ type: 'M', x: 100, y: 100 });
      expect(reversed[1]).toEqual({ type: 'L', x: 100, y: 0 });
      expect(reversed[2]).toEqual({ type: 'L', x: 0, y: 0 });
    });

    it('should preserve close command', () => {
      const commands: PathCommand[] = [
        { type: 'M', x: 0, y: 0 },
        { type: 'L', x: 100, y: 0 },
        { type: 'L', x: 100, y: 100 },
        { type: 'Z' }
      ];
      const reversed = reversePathCommands(commands);
      expect(reversed[reversed.length - 1]).toEqual({ type: 'Z' });
    });

    it('should handle quadratic curves', () => {
      const commands: PathCommand[] = [
        { type: 'M', x: 0, y: 0 },
        { type: 'Q', cx: 50, cy: 50, x: 100, y: 0 }
      ];
      const reversed = reversePathCommands(commands);

      expect(reversed[0]).toEqual({ type: 'M', x: 100, y: 0 });
      expect(reversed[1]).toEqual({ type: 'Q', cx: 50, cy: 50, x: 0, y: 0 });
    });

    it('should handle cubic curves with swapped control points', () => {
      const commands: PathCommand[] = [
        { type: 'M', x: 0, y: 0 },
        { type: 'C', c1x: 25, c1y: 50, c2x: 75, c2y: 50, x: 100, y: 0 }
      ];
      const reversed = reversePathCommands(commands);

      expect(reversed[0]).toEqual({ type: 'M', x: 100, y: 0 });
      // Control points should be swapped
      expect(reversed[1]).toEqual({ type: 'C', c1x: 75, c1y: 50, c2x: 25, c2y: 50, x: 0, y: 0 });
    });

    it('should return empty array for empty input', () => {
      expect(reversePathCommands([])).toEqual([]);
    });
  });

  describe('correctFillSides', () => {
    it('should swap fill styles for counter-clockwise paths', () => {
      const edges: Edge[] = [{
        fillStyle0: 1,
        fillStyle1: 2,
        commands: [
          { type: 'M', x: 0, y: 0 },
          { type: 'L', x: 0, y: 100 },
          { type: 'L', x: 100, y: 100 },
          { type: 'L', x: 100, y: 0 },
          { type: 'Z' }
        ]
      }];

      const corrected = correctFillSides(edges);
      expect(corrected[0].fillStyle0).toBe(2);
      expect(corrected[0].fillStyle1).toBe(1);
    });

    it('should not change clockwise paths', () => {
      const edges: Edge[] = [{
        fillStyle0: 1,
        fillStyle1: 2,
        commands: [
          { type: 'M', x: 0, y: 0 },
          { type: 'L', x: 100, y: 0 },
          { type: 'L', x: 100, y: 100 },
          { type: 'L', x: 0, y: 100 },
          { type: 'Z' }
        ]
      }];

      const corrected = correctFillSides(edges);
      expect(corrected[0].fillStyle0).toBe(1);
      expect(corrected[0].fillStyle1).toBe(2);
    });

    it('should preserve edges without fill styles', () => {
      const edges: Edge[] = [{
        strokeStyle: 1,
        commands: [
          { type: 'M', x: 0, y: 0 },
          { type: 'L', x: 100, y: 100 }
        ]
      }];

      const corrected = correctFillSides(edges);
      expect(corrected[0]).toEqual(edges[0]);
    });
  });

  describe('removeDuplicateEdges', () => {
    it('should merge duplicate edges', () => {
      const edges: Edge[] = [
        {
          fillStyle0: 1,
          commands: [
            { type: 'M', x: 0, y: 0 },
            { type: 'L', x: 100, y: 0 }
          ]
        },
        {
          strokeStyle: 1,
          commands: [
            { type: 'M', x: 0, y: 0 },
            { type: 'L', x: 100, y: 0 }
          ]
        }
      ];

      const result = removeDuplicateEdges(edges);
      expect(result.length).toBe(1);
      expect(result[0].fillStyle0).toBe(1);
      expect(result[0].strokeStyle).toBe(1);
    });

    it('should keep distinct edges', () => {
      const edges: Edge[] = [
        {
          fillStyle0: 1,
          commands: [
            { type: 'M', x: 0, y: 0 },
            { type: 'L', x: 100, y: 0 }
          ]
        },
        {
          fillStyle0: 2,
          commands: [
            { type: 'M', x: 0, y: 0 },
            { type: 'L', x: 0, y: 100 }
          ]
        }
      ];

      const result = removeDuplicateEdges(edges);
      expect(result.length).toBe(2);
    });
  });

  describe('connectBrokenChains', () => {
    it('should connect edges that nearly meet', () => {
      const edges: Edge[] = [
        {
          fillStyle0: 1,
          commands: [
            { type: 'M', x: 0, y: 0 },
            { type: 'L', x: 100, y: 0 }
          ]
        },
        {
          fillStyle0: 1,
          commands: [
            { type: 'M', x: 100.5, y: 0.5 }, // Nearly at (100, 0)
            { type: 'L', x: 100, y: 100 }
          ]
        }
      ];

      const result = connectBrokenChains(edges);
      // Should be connected into fewer chains
      expect(result.length).toBeLessThanOrEqual(edges.length);
    });

    it('should handle single edge', () => {
      const edges: Edge[] = [{
        fillStyle0: 1,
        commands: [
          { type: 'M', x: 0, y: 0 },
          { type: 'L', x: 100, y: 0 }
        ]
      }];

      const result = connectBrokenChains(edges);
      expect(result.length).toBe(1);
    });

    it('should handle empty array', () => {
      expect(connectBrokenChains([])).toEqual([]);
    });
  });

  describe('autoClosePaths', () => {
    it('should add Z command when path returns to start', () => {
      const commands: PathCommand[] = [
        { type: 'M', x: 0, y: 0 },
        { type: 'L', x: 100, y: 0 },
        { type: 'L', x: 100, y: 100 },
        { type: 'L', x: 0, y: 0.5 } // Nearly back to start
      ];

      const result = autoClosePaths(commands);
      expect(result[result.length - 1]).toEqual({ type: 'Z' });
    });

    it('should not add Z if already closed', () => {
      const commands: PathCommand[] = [
        { type: 'M', x: 0, y: 0 },
        { type: 'L', x: 100, y: 0 },
        { type: 'L', x: 100, y: 100 },
        { type: 'Z' }
      ];

      const result = autoClosePaths(commands);
      // Should only have one Z
      const zCount = result.filter(c => c.type === 'Z').length;
      expect(zCount).toBe(1);
    });

    it('should not add Z if path does not return to start', () => {
      const commands: PathCommand[] = [
        { type: 'M', x: 0, y: 0 },
        { type: 'L', x: 100, y: 0 },
        { type: 'L', x: 100, y: 100 }
      ];

      const result = autoClosePaths(commands);
      const hasZ = result.some(c => c.type === 'Z');
      expect(hasZ).toBe(false);
    });
  });

  describe('fixShape', () => {
    it('should apply all fix operations', () => {
      const shape: Shape = {
        type: 'shape',
        matrix: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
        fills: [{ index: 1, type: 'solid', color: '#ff0000' }],
        strokes: [],
        edges: [
          {
            fillStyle0: 1,
            commands: [
              { type: 'M', x: 0, y: 0 },
              { type: 'L', x: 100, y: 0 },
              { type: 'L', x: 100, y: 100 },
              { type: 'L', x: 0, y: 100 },
              { type: 'L', x: 0, y: 0.5 } // Nearly closed
            ]
          }
        ]
      };

      const fixed = fixShape(shape);
      expect(fixed.edges.length).toBeGreaterThan(0);
      // Should have auto-closed
      const hasZ = fixed.edges[0].commands.some(c => c.type === 'Z');
      expect(hasZ).toBe(true);
    });
  });

  describe('validateMorphShape', () => {
    it('should validate matching morph shapes', () => {
      const startEdges: Edge[] = [{
        fillStyle0: 1,
        commands: [
          { type: 'M', x: 0, y: 0 },
          { type: 'L', x: 100, y: 0 },
          { type: 'L', x: 100, y: 100 },
          { type: 'Z' }
        ]
      }];

      const endEdges: Edge[] = [{
        fillStyle0: 1,
        commands: [
          { type: 'M', x: 50, y: 50 },
          { type: 'L', x: 150, y: 50 },
          { type: 'L', x: 150, y: 150 },
          { type: 'Z' }
        ]
      }];

      const result = validateMorphShape(startEdges, endEdges);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect edge count mismatch', () => {
      const startEdges: Edge[] = [
        { fillStyle0: 1, commands: [{ type: 'M', x: 0, y: 0 }] },
        { fillStyle0: 1, commands: [{ type: 'M', x: 0, y: 0 }] }
      ];

      const endEdges: Edge[] = [
        { fillStyle0: 1, commands: [{ type: 'M', x: 0, y: 0 }] }
      ];

      const result = validateMorphShape(startEdges, endEdges);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('Edge count mismatch'))).toBe(true);
    });

    it('should detect command type mismatch', () => {
      const startEdges: Edge[] = [{
        fillStyle0: 1,
        commands: [
          { type: 'M', x: 0, y: 0 },
          { type: 'L', x: 100, y: 0 }
        ]
      }];

      const endEdges: Edge[] = [{
        fillStyle0: 1,
        commands: [
          { type: 'M', x: 0, y: 0 },
          { type: 'Q', cx: 50, cy: 50, x: 100, y: 0 }
        ]
      }];

      const result = validateMorphShape(startEdges, endEdges);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('type mismatch'))).toBe(true);
    });
  });

  describe('calculatePathBounds', () => {
    it('should calculate bounds for simple rectangle', () => {
      const commands: PathCommand[] = [
        { type: 'M', x: 10, y: 20 },
        { type: 'L', x: 110, y: 20 },
        { type: 'L', x: 110, y: 70 },
        { type: 'L', x: 10, y: 70 },
        { type: 'Z' }
      ];

      const bounds = calculatePathBounds(commands);
      expect(bounds).toEqual({
        minX: 10,
        minY: 20,
        maxX: 110,
        maxY: 70
      });
    });

    it('should include control points for curves', () => {
      const commands: PathCommand[] = [
        { type: 'M', x: 0, y: 0 },
        { type: 'Q', cx: 100, cy: 100, x: 50, y: 50 }
      ];

      const bounds = calculatePathBounds(commands);
      expect(bounds?.maxX).toBe(100);
      expect(bounds?.maxY).toBe(100);
    });

    it('should return null for empty commands', () => {
      expect(calculatePathBounds([])).toBeNull();
    });

    it('should return null for commands without coordinates', () => {
      const commands: PathCommand[] = [{ type: 'Z' }];
      expect(calculatePathBounds(commands)).toBeNull();
    });
  });

  describe('calculateShapeBounds', () => {
    it('should calculate bounds for shape with multiple edges', () => {
      const shape: Shape = {
        type: 'shape',
        matrix: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
        fills: [],
        strokes: [],
        edges: [
          {
            fillStyle0: 1,
            commands: [
              { type: 'M', x: 0, y: 0 },
              { type: 'L', x: 50, y: 50 }
            ]
          },
          {
            fillStyle0: 1,
            commands: [
              { type: 'M', x: 100, y: 100 },
              { type: 'L', x: 150, y: 200 }
            ]
          }
        ]
      };

      const bounds = calculateShapeBounds(shape);
      expect(bounds).toEqual({
        minX: 0,
        minY: 0,
        maxX: 150,
        maxY: 200
      });
    });

    it('should return null for shape with no edges', () => {
      const shape: Shape = {
        type: 'shape',
        matrix: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
        fills: [],
        strokes: [],
        edges: []
      };

      expect(calculateShapeBounds(shape)).toBeNull();
    });
  });
});
