import { describe, it, expect } from 'vitest';
import { BUNDLED_FONTS, loadBundledFont } from '../bundled-fonts';

function facesOf(family: string): FontFace[] {
  const faces: FontFace[] = [];
  document.fonts.forEach(face => {
    if (face.family.replace(/^["']|["']$/g, '') === family) faces.push(face);
  });
  return faces;
}

describe('bundled fonts', () => {
  it('registers Press Start 2P from the app bundle, one face per unicode subset', () => {
    expect(BUNDLED_FONTS.has('Press Start 2P')).toBe(true);
    // latin, latin-ext, cyrillic, cyrillic-ext, greek
    expect(facesOf('Press Start 2P').length).toBe(5);
  });

  it('serves the font files from the app origin, not a font CDN', () => {
    const urls = [...document.styleSheets].flatMap(sheet => {
      try {
        return [...sheet.cssRules]
          .filter((rule): rule is CSSFontFaceRule => rule instanceof CSSFontFaceRule)
          .filter(rule => rule.style.getPropertyValue('font-family').includes('Press Start 2P'))
          .flatMap(rule => [...rule.style.getPropertyValue('src').matchAll(/url\("?([^")]+)"?\)/g)].map(m => m[1]));
      } catch {
        return [];
      }
    });
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(new URL(url, location.href).origin).toBe(location.origin);
    }
  });

  it('loads every subset, so non-latin text draws in the font on the first frame', async () => {
    await expect(loadBundledFont('Press Start 2P')).resolves.toBe(true);
    for (const face of facesOf('Press Start 2P')) {
      expect(face.status).toBe('loaded');
    }
    expect(document.fonts.check('16px "Press Start 2P"', 'Hello')).toBe(true);
    expect(document.fonts.check('16px "Press Start 2P"', 'Привет')).toBe(true);
    expect(document.fonts.check('16px "Press Start 2P"', 'Γειά')).toBe(true);
  });

  it('declines fonts the app does not ship', async () => {
    await expect(loadBundledFont('Comic Sans MS')).resolves.toBe(false);
  });
});
