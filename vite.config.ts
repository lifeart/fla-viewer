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
