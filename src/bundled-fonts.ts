// Web fonts shipped with the app, so text renders the same offline.
// The @font-face rules (one per unicode subset) come from @fontsource; Vite
// bundles the font files next to the app, and the service worker precaches them.
import '@fontsource/press-start-2p/400.css';

/** Font families the app ships, by CSS family name. */
export const BUNDLED_FONTS: ReadonlySet<string> = new Set(['Press Start 2P']);

/**
 * Load every face (all unicode subsets) of a bundled font family, so canvas
 * text drawn in it is ready on the first frame. Resolves false for a family
 * the app doesn't ship, or when no face of it is registered.
 */
export async function loadBundledFont(family: string): Promise<boolean> {
  if (!BUNDLED_FONTS.has(family)) return false;
  const faces: FontFace[] = [];
  document.fonts.forEach(face => {
    if (face.family.replace(/^["']|["']$/g, '') === family) faces.push(face);
  });
  if (faces.length === 0) return false;
  await Promise.all(faces.map(face => face.load()));
  return true;
}
