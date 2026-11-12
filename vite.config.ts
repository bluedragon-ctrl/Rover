import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    rollupOptions: { input: { main: 'index.html', preview: 'preview.html' } },
  },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
