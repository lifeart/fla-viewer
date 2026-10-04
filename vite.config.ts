import { defineConfig } from 'vite';
import { playwright } from '@vitest/browser-playwright';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/fla-viewer/' : '/',
  server: {
    port: 3000,
  },
  plugins: [
    // Offline support: a service worker precaches the whole built app (every
    // code-split chunk, fonts, icons), and a web app manifest makes it installable.
    // 'prompt' keeps the running version (and the chunks it may still lazy-load)
    // until the user accepts an update; see src/pwa.ts.
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      manifest: {
        name: 'FLA Viewer',
        short_name: 'FLA Viewer',
        description: 'View, play and export Adobe Animate and Flash FLA files in the browser, offline.',
        theme_color: '#1a1a1a',
        background_color: '#1a1a1a',
        display: 'standalone',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        // woff2 only: every browser that runs a service worker reads it, so the
        // woff fallbacks @fontsource also emits are never fetched
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,webmanifest}'],
        // The 2400px social preview image is only for link unfurls
        globIgnores: ['og-image.png'],
        cleanupOutdatedCaches: true,
        navigateFallback: 'index.html',
      },
    }),
  ],
  optimizeDeps: {
    include: ['mp4-muxer'],
  },
  // Treat gzipped test fixtures as static assets so `import x from './f.gz?url'`
  // resolves to a served URL. The large DIFAT CFB regression fixture is ~6.8 MB
  // uncompressed but commits to ~75 KB gzipped (inflated in the test).
  assetsInclude: ['**/*.gz'],
  build: {
    target: 'esnext',
  },
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/__tests__/**', 'src/edge-test.ts'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'browser',
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [
              { browser: 'chromium' },
            ],
          },
          include: ['src/**/*.test.ts', 'src/__tests__/**/*.test.ts'],
          exclude: ['**/*.node.test.ts'],
        },
      },
      {
        // Tests that drive a production build from Node (e.g. offline.node.test.ts)
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/__tests__/**/*.node.test.ts'],
        },
      },
    ],
  },
});
