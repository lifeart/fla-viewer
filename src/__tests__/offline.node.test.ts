// End-to-end offline check: build the app as it is deployed (GitHub Pages base
// path), load it once online, shut the server down, and use it again.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const base = '/fla-viewer/';

describe('offline support (production build)', () => {
  let outDir: string;
  let server: PreviewServer;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let appUrl: string;
  const offsiteRequests: string[] = [];

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'fla-viewer-offline-'));
    // Vitest runs with NODE_ENV=test; build as production, as deploy.yml does
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await build({ root, base, mode: 'production', logLevel: 'error', build: { outDir, emptyOutDir: true } });
    } finally {
      process.env.NODE_ENV = nodeEnv;
    }
    server = await preview({ root, base, logLevel: 'error', build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
    appUrl = server.resolvedUrls!.local[0];

    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    context = await browser.newContext();
    const origin = new URL(appUrl).origin;
    context.on('request', request => {
      const url = new URL(request.url());
      if (url.protocol.startsWith('http') && url.origin !== origin) offsiteRequests.push(request.url());
    });
    page = await context.newPage();

    // First visit, online: the service worker installs and precaches the app
    await page.goto(appUrl);
    await page.evaluate(async () => {
      const registration = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no service worker became active')), 30_000)),
      ]);
      if (!registration.active) throw new Error('no active service worker');
    });

    // Go offline for real: nothing serves the app any more
    await new Promise<void>((resolve, reject) => server.httpServer.close(error => (error ? reject(error) : resolve())));
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    if (server?.httpServer.listening) await server.close();
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it('reloads with the server gone', async () => {
    const response = await page.reload();
    expect(response?.ok()).toBe(true);
    expect(await page.title()).toContain('FLA Viewer');
    await expect(page.locator('#drop-zone').isVisible()).resolves.toBe(true);
  });

  it('opens a URL with a query string (embed mode) offline', async () => {
    const embed = await context.newPage();
    const response = await embed.goto(`${appUrl}?embed=true`);
    expect(response?.ok()).toBe(true);
    await expect(embed.evaluate(() => document.body.classList.contains('embed-mode'))).resolves.toBe(true);
    await embed.close();
  });

  it('opens the built-in sample and plays it offline', async () => {
    await page.locator('#load-sample-btn').click();
    await page.waitForFunction(() => document.getElementById('viewer')?.classList.contains('active'), undefined, { timeout: 30_000 });
    // The stage has drawn something (any pixel that is not fully transparent)
    const drewSomething = await page.waitForFunction(() => {
      const canvas = document.getElementById('stage') as HTMLCanvasElement;
      if (!canvas.width || !canvas.height) return false;
      const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true;
      return false;
    }, undefined, { timeout: 10_000 }).then(() => true);
    expect(drewSomething).toBe(true);
  });

  it('serves every built file from the cache, including lazily loaded export chunks and fonts', async () => {
    const files = readdirSync(join(outDir, 'assets'))
      .filter(name => /\.(js|css|woff2)$/.test(name))
      .map(name => `${base}assets/${name}`);
    expect(files.some(name => name.includes('mp4-muxer'))).toBe(true);
    expect(files.some(name => name.endsWith('.woff2'))).toBe(true);

    const failed = await page.evaluate(async urls => {
      const results = await Promise.all(urls.map(async url => {
        try {
          return (await fetch(url)).ok ? null : url;
        } catch {
          return url;
        }
      }));
      return results.filter(Boolean);
    }, files);
    expect(failed).toEqual([]);
  });

  it('loads the export libraries offline', async () => {
    const muxer = readdirSync(join(outDir, 'assets')).find(name => name.startsWith('mp4-muxer') && name.endsWith('.js'))!;
    // A string, so Vitest doesn't rewrite the import() for Node
    const exported = await page.evaluate(`import(${JSON.stringify(`${base}assets/${muxer}`)}).then(m => Object.keys(m).length)`);
    expect(exported).toBeGreaterThan(0);
  });

  it('draws text in the bundled font offline', async () => {
    const loaded = await page.evaluate(async () => {
      await document.fonts.load('16px "Press Start 2P"', 'Hello Привет');
      return document.fonts.check('16px "Press Start 2P"', 'Hello Привет');
    });
    expect(loaded).toBe(true);
  });

  it('is installable: the manifest and its icons are cached', async () => {
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(manifestHref).toBe(`${base}manifest.webmanifest`);
    const manifest = await page.evaluate(async href => (await fetch(href)).json(), manifestHref!);
    expect(manifest.display).toBe('standalone');
    const sizes = manifest.icons.map((icon: { sizes: string }) => icon.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    const iconsOk = await page.evaluate(async ({ icons, href }) => Promise.all(
      icons.map(async (icon: { src: string }) => (await fetch(new URL(icon.src, new URL(href, location.href)))).ok),
    ), { icons: manifest.icons, href: manifestHref! });
    expect(iconsOk.every(Boolean)).toBe(true);
  });

  it('never contacts another origin (no font CDN or other network dependency)', () => {
    expect(offsiteRequests).toEqual([]);
  });

  it('precaches the app but not the large social preview image', () => {
    const sw = readFileSync(join(outDir, 'sw.js'), 'utf8');
    expect(sw).toContain('index.html');
    expect(sw).not.toContain('og-image.png');
  });
});
