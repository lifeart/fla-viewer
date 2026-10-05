// End-to-end re-deploy check: serve one build the way GitHub Pages does
// (base path, Cache-Control: max-age=600), replace it with a newer build, and
// check that tabs which already cached the app pick up the new version.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { build, type Plugin } from 'vite';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const base = '/fla-viewer/';

const contentTypes: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.webmanifest': 'application/manifest+json',
};

/** Stamp a build so a page can tell which one it runs: in the HTML and in the app chunk. */
function buildStamp(id: string): Plugin {
  return {
    name: 'test-build-stamp',
    transformIndexHtml: html => html.replace('</head>', `<meta name="build-id" content="${id}"></head>`),
    transform(code, moduleId) {
      if (moduleId.endsWith('/src/main.ts')) return `${code}\nwindow.__buildId = ${JSON.stringify(id)};\n`;
    },
  };
}

async function buildApp(id: string): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), `fla-viewer-${id}-`));
  // Vitest runs with NODE_ENV=test; build as production, as deploy.yml does
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await build({ root, base, mode: 'production', logLevel: 'error', plugins: [buildStamp(id)], build: { outDir, emptyOutDir: true } });
  } finally {
    process.env.NODE_ENV = nodeEnv;
  }
  return outDir;
}

/** A static server like GitHub Pages: everything cacheable for 10 minutes, and the deployed directory can be swapped. */
function pagesServer() {
  let dir = '';
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (!path.startsWith(base)) { res.writeHead(404).end(); return; }
    let file = normalize(join(dir, decodeURIComponent(path.slice(base.length))));
    if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
    try {
      if (statSync(file).isDirectory()) file = join(file, 'index.html');
      const body = readFileSync(file);
      res.writeHead(200, { 'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'max-age=600' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return {
    deploy(outDir: string) { dir = outDir; },
    async listen(): Promise<string> {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address() as { port: number };
      return `http://127.0.0.1:${address.port}${base}`;
    },
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const buildIdOf = (page: Page) => page.evaluate(() => (window as unknown as { __buildId?: string }).__buildId);
const noticeOf = (page: Page) => page.locator('.pwa-notice');

async function waitForActiveWorker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no service worker became active')), 30_000)),
    ]);
    if (!registration.active) throw new Error('no active service worker');
  });
}

describe('re-deploy updates (production build)', () => {
  let v1: string;
  let v2: string;
  let server: ReturnType<typeof pagesServer>;
  let appUrl: string;
  let browser: Browser;

  beforeAll(async () => {
    v1 = await buildApp('v1');
    v2 = await buildApp('v2');
    server = pagesServer();
    server.deploy(v1);
    appUrl = await server.listen();
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    for (const dir of [v1, v2]) if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('offers the new version, switches the tab that accepts it, and leaves the other tabs alone', async () => {
    server.deploy(v1);
    const context: BrowserContext = await browser.newContext();
    const tabA = await context.newPage();
    await tabA.goto(appUrl);
    await waitForActiveWorker(tabA);
    expect(await buildIdOf(tabA)).toBe('v1');
    const tabB = await context.newPage();
    await tabB.goto(appUrl);
    expect(await buildIdOf(tabB)).toBe('v1');

    server.deploy(v2);

    // The next visit still opens the cached v1 instantly, then finds v2 and asks
    await tabA.reload();
    expect(await buildIdOf(tabA)).toBe('v1');
    await expect(noticeOf(tabA).textContent({ timeout: 30_000 })).resolves.toContain('new version');

    await tabA.locator('.pwa-notice button', { hasText: 'Reload' }).click();
    await tabA.waitForFunction(() => (window as unknown as { __buildId?: string }).__buildId === 'v2', undefined, { timeout: 30_000 });
    expect(await tabA.locator('meta[name="build-id"]').getAttribute('content')).toBe('v2');

    // The other tab keeps its file and its version, and is told about the update
    expect(await buildIdOf(tabB)).toBe('v1');
    await expect(noticeOf(tabB).textContent({ timeout: 30_000 })).resolves.toContain('updated in another tab');

    // v2 is what the cache now serves, with the server gone too
    await server.close();
    await tabA.reload();
    expect(await buildIdOf(tabA)).toBe('v2');
    await context.close();
    appUrl = await server.listen();
  }, 120_000);

  it('switches to the new version on the next visit after "Later" once every tab is closed', async () => {
    server.deploy(v1);
    const context = await browser.newContext();
    const tab = await context.newPage();
    await tab.goto(appUrl);
    await waitForActiveWorker(tab);

    server.deploy(v2);
    await tab.reload();
    await expect(noticeOf(tab).textContent({ timeout: 30_000 })).resolves.toContain('new version');
    await tab.locator('.pwa-notice button', { hasText: 'Later' }).click();
    expect(await buildIdOf(tab)).toBe('v1');
    await tab.close();

    // With no tab left on v1, the waiting worker activates; the next visit is v2
    let next = await context.newPage();
    for (let attempt = 0; attempt < 20; attempt++) {
      await next.goto(appUrl);
      if (await buildIdOf(next) === 'v2') break;
      await next.close();
      await new Promise(resolve => setTimeout(resolve, 250));
      next = await context.newPage();
    }
    expect(await buildIdOf(next)).toBe('v2');
    await context.close();
  }, 120_000);
});
