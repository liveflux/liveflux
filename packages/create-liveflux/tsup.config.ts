import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  dts: false, // a CLI ships no types
  clean: true,
  minify: false, // readable stack traces matter more than bytes for a CLI
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
});
