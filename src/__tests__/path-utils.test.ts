import { describe, it, expect } from 'vitest';
import {
  normalizePath,
  getPathVariants,
  getWithNormalizedPath,
  setWithNormalizedPath,
  hasWithNormalizedPath,
  getFilename
} from '../path-utils';

describe('path-utils', () => {
  describe('normalizePath', () => {
    it('should replace backslashes with forward slashes', () => {
      expect(normalizePath('LIBRARY\\symbols\\icon.xml')).toBe('LIBRARY/symbols/icon.xml');
    });

    it('should handle multiple consecutive backslashes', () => {
      expect(normalizePath('path\\\\to\\\\file')).toBe('path//to//file');
    });

    it('should leave forward slashes unchanged', () => {
      expect(normalizePath('LIBRARY/symbols/icon.xml')).toBe('LIBRARY/symbols/icon.xml');
    });

    it('should handle mixed separators', () => {
      expect(normalizePath('path\\to/file\\name')).toBe('path/to/file/name');
    });

    it('should handle empty string', () => {
      expect(normalizePath('')).toBe('');
    });

    it('should handle string with no separators', () => {
      expect(normalizePath('filename.xml')).toBe('filename.xml');
    });
  });

  describe('getPathVariants', () => {
    it('should return both variants when path contains backslashes', () => {
      const variants = getPathVariants('path\\to\\file');
      expect(variants).toHaveLength(2);
      expect(variants).toContain('path\\to\\file');
      expect(variants).toContain('path/to/file');
    });

    it('should return single variant when path has no backslashes', () => {
      const variants = getPathVariants('path/to/file');
      expect(variants).toHaveLength(1);
      expect(variants).toContain('path/to/file');
    });

    it('should return single variant for simple filename', () => {
      const variants = getPathVariants('file.xml');
      expect(variants).toHaveLength(1);
      expect(variants).toContain('file.xml');
    });
  });

  describe('getWithNormalizedPath', () => {
    it('should find value with original key', () => {
      const map = new Map<string, string>();
      map.set('path/to/file', 'value');
      expect(getWithNormalizedPath(map, 'path/to/file')).toBe('value');
    });

    it('should find value when key needs normalization', () => {
      const map = new Map<string, string>();
      map.set('path/to/file', 'value');
      expect(getWithNormalizedPath(map, 'path\\to\\file')).toBe('value');
    });

    it('should return undefined when key not found', () => {
      const map = new Map<string, string>();
      map.set('path/to/file', 'value');
      expect(getWithNormalizedPath(map, 'other/path')).toBeUndefined();
    });

    it('should prefer original key over normalized', () => {
      const map = new Map<string, string>();
      map.set('path\\to\\file', 'backslash-value');
      map.set('path/to/file', 'forward-value');
      // When searching with original backslash key, should find it first
      expect(getWithNormalizedPath(map, 'path\\to\\file')).toBe('backslash-value');
    });

    it('should return value for simple key', () => {
      const map = new Map<string, number>();
      map.set('key', 42);
      expect(getWithNormalizedPath(map, 'key')).toBe(42);
    });
  });

  describe('setWithNormalizedPath', () => {
    it('should set value with normalized key', () => {
      const map = new Map<string, string>();
      setWithNormalizedPath(map, 'path\\to\\file', 'value');
      expect(map.get('path/to/file')).toBe('value');
    });

    it('should set both normalized and original keys when different', () => {
      const map = new Map<string, string>();
      setWithNormalizedPath(map, 'path\\to\\file', 'value');
      expect(map.get('path/to/file')).toBe('value');
      expect(map.get('path\\to\\file')).toBe('value');
    });

    it('should only set one key when path has no backslashes', () => {
      const map = new Map<string, string>();
      setWithNormalizedPath(map, 'path/to/file', 'value');
      expect(map.size).toBe(1);
      expect(map.get('path/to/file')).toBe('value');
    });
  });

  describe('hasWithNormalizedPath', () => {
    it('should return true for exact match', () => {
      const map = new Map<string, string>();
      map.set('path/to/file', 'value');
      expect(hasWithNormalizedPath(map, 'path/to/file')).toBe(true);
    });

    it('should return true when normalized key exists', () => {
      const map = new Map<string, string>();
      map.set('path/to/file', 'value');
      expect(hasWithNormalizedPath(map, 'path\\to\\file')).toBe(true);
    });

    it('should return false when key not found', () => {
      const map = new Map<string, string>();
      map.set('path/to/file', 'value');
      expect(hasWithNormalizedPath(map, 'other/path')).toBe(false);
    });

    it('should work with empty map', () => {
      const map = new Map<string, string>();
      expect(hasWithNormalizedPath(map, 'any/path')).toBe(false);
    });
  });

  describe('getFilename', () => {
    it('should extract filename from forward slash path', () => {
      expect(getFilename('path/to/file.xml')).toBe('file.xml');
    });

    it('should extract filename from backslash path', () => {
      expect(getFilename('path\\to\\file.xml')).toBe('file.xml');
    });

    it('should handle mixed separators', () => {
      expect(getFilename('path/to\\file.xml')).toBe('file.xml');
    });

    it('should return filename when no path separator', () => {
      expect(getFilename('file.xml')).toBe('file.xml');
    });

    it('should handle empty string', () => {
      expect(getFilename('')).toBe('');
    });

    it('should handle path ending with separator', () => {
      expect(getFilename('path/to/')).toBe('');
    });

    it('should handle deeply nested path', () => {
      expect(getFilename('a/b/c/d/e/f/g.txt')).toBe('g.txt');
    });
  });
});
