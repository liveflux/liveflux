import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Alias every @liveflux/* package to its SOURCE (not dist) so editing library code hot-reloads the
// playground instantly — no build step, real breakpoints in the TS source. Add new packages here.
export default defineConfig({
  plugins: [react()],
  server: { port: 9000 }, // digits sum to 9
  resolve: {
    alias: {
      '@liveflux/core': src('../../packages/core/src/index.ts'),
      '@liveflux/ws': src('../../packages/ws/src/index.ts'),
      '@liveflux/react': src('../../packages/react/src/index.tsx'),
    },
  },
});
