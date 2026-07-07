import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  minify: true, // ship a lean artifact; source map preserves debuggability
  sourcemap: true,
  treeshake: true,
});
