import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Alias every @liveflux/* package to its SOURCE (not dist) so editing library code hot-reloads the
// playground instantly — no build step, real breakpoints in the TS source. Add new packages here.
export default defineConfig({
  plugins: [react()],
  server: { port: 9000 }, // digits sum to 9
  // Don't pre-bundle the workspace @liveflux/* packages — serve them from source (via the aliases
  // below) as a single module graph, so the bare `@liveflux/devtools` import and the source-aliased
  // `/react` + `/element` subpaths share ONE instance (hook + bus singletons stay unified).
  optimizeDeps: { exclude: ['@liveflux/core', '@liveflux/ws', '@liveflux/react', '@liveflux/devtools'] },
  resolve: {
    alias: {
      '@liveflux/core': src('../../packages/core/src/index.ts'),
      '@liveflux/ws': src('../../packages/ws/src/index.ts'),
      '@liveflux/react': src('../../packages/react/src/index.tsx'),
      '@liveflux/devtools/react': src('../../packages/devtools/src/react.ts'),
      '@liveflux/devtools/element': src('../../packages/devtools/src/element.ts'),
      '@liveflux/devtools': src('../../packages/devtools/src/index.ts'),
    },
  },
});
