import { defineConfig } from 'vitest/config';

// The package's own tests, runnable on their own: `npm test` in this folder.
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], environment: 'node' } });
