import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.tsx'],
  format: ['esm'],
  dts: true,
  clean: true,
  minify: true, // ship a lean artifact; source map preserves debuggability
  sourcemap: true,
  // NOTE: no `treeshake: true`. esbuild's own DCE (with `minify`) already prunes dead code, and the
  // extra rollup treeshake pass strips module-level directives — it would drop the `'use client'`
  // banner below (rollup warns "Module level directives cause errors when bundled … was ignored").
  // esbuild's banner is emitted verbatim at the top of the file and is not treated as a directive.
  //
  // esbuild strips top-of-file directives, so the source `'use client'` never survives the build.
  // Re-emit it as a banner so the published bundle is a valid React client module — importing the
  // hooks/Provider from a Server Component graph (Next.js App Router) would otherwise throw.
  banner: { js: "'use client';" },
});
