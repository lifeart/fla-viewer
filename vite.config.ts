import { defineConfig } from 'vite';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/fla-viewer/' : '/',
  server: {
    port: 3000,
  },
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
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [
        { browser: 'chromium' },
      ],
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/__tests__/**', 'src/edge-test.ts'],
    },
    include: ['src/**/*.test.ts', 'src/__tests__/**/*.test.ts'],
  },
});
