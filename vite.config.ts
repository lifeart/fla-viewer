import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/fla-viewer/' : '/',
  server: {
    port: 3000,
  },
  build: {
    target: 'esnext',
  },
});
