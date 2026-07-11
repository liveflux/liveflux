import react from '@vitejs/plugin-react';
import { defineWorkspace } from 'vitest/config';

/**
 * Two isolated Vitest projects, one per environment:
 *
 *  • **node** — core / ws / phoenix integration and the cross-adapter conformance gate. Runs in a
 *    plain Node process so the real in-process `ws` servers and Node WebSocket clients behave exactly
 *    as they would in production.
 *  • **react** — the `@liveflux/react` bindings and the cross-package "dashboard" flow, under jsdom
 *    with the React plugin (JSX transform + Fast Refresh-free test build).
 *
 * Keeping them apart means a jsdom global never leaks into the transport tests and vice versa.
 */
export default defineWorkspace([
  {
    test: {
      name: 'node',
      environment: 'node',
      include: ['test/node/**/*.test.ts'],
    },
  },
  {
    plugins: [react()],
    test: {
      name: 'react',
      environment: 'jsdom',
      include: ['test/react/**/*.test.{ts,tsx}'],
    },
  },
]);
