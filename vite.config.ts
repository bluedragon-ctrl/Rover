import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
