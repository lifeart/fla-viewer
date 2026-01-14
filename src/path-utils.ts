/**
 * Utility functions for handling path normalization in FLA files.
 * FLA files created on Windows may use backslash path separators,
 * while references might use forward slashes.
 */

/**
 * Normalize path separators to forward slashes
 */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Get all path variants (original + normalized) for lookup
 */
export function getPathVariants(path: string): string[] {
  const normalized = normalizePath(path);
  return normalized !== path ? [path, normalized] : [path];
}

/**
 * Look up a value in a Map trying both original and normalized path keys
 */
export function getWithNormalizedPath<T>(map: Map<string, T>, key: string): T | undefined {
  // Try original key first
  let value = map.get(key);
  if (value) return value;

  // Try normalized key
  const normalizedKey = normalizePath(key);
  if (normalizedKey !== key) {
    value = map.get(normalizedKey);
  }

  return value;
}

/**
 * Set a value in a Map with both original and normalized keys
 */
export function setWithNormalizedPath<T>(map: Map<string, T>, key: string, value: T): void {
  const normalizedKey = normalizePath(key);

  // Always store with normalized key
  map.set(normalizedKey, value);

  // Also store with original key if different
  if (normalizedKey !== key) {
    map.set(key, value);
  }
}

/**
 * Check if a Map has a key (trying both original and normalized)
 */
export function hasWithNormalizedPath<T>(map: Map<string, T>, key: string): boolean {
  if (map.has(key)) return true;

  const normalizedKey = normalizePath(key);
  return normalizedKey !== key && map.has(normalizedKey);
}

/**
 * Extract filename from a path (handles both forward and back slashes)
 */
export function getFilename(path: string): string {
  const normalized = normalizePath(path);
  const parts = normalized.split('/');
  const filename = parts.pop();
  // Return empty string if path ends with separator or pop returns undefined
  return filename !== undefined ? filename : '';
}
