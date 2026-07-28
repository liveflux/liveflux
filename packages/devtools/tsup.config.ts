import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/element.ts', 'src/react.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  minify: true, // ship a lean artifact; source map preserves debuggability
  sourcemap: true,
  treeshake: true,
});
