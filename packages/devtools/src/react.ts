/**
 * @liveflux/devtools/react — the React wrapper for the `<liveflux-devtools>` panel.
 *
 * A thin component that registers the custom element on mount and renders it. Dev-only — guard the
 * usage so it is stripped from production builds:
 *
 * ```tsx
 * import { LivefluxDevtools } from '@liveflux/devtools/react';
 *
 * export function App() {
 *   return (
 *     <>
 *       <YourApp />
 *       {import.meta.env.DEV && <LivefluxDevtools />}
 *     </>
 *   );
 * }
 * ```
 *
 * The panel discovers every attached client through the global hook, so it needs no `client` prop.
 * (Non-React apps: `import '@liveflux/devtools/element'`, call `defineLivefluxDevtools()`, and drop the
 * `<liveflux-devtools>` tag into the page.)
 */

import { createElement, useEffect, type ReactElement } from 'react';
import { defineLivefluxDevtools } from './element';

/** Mounts the `<liveflux-devtools>` panel. No props — it auto-discovers clients via the global hook. */
export function LivefluxDevtools(): ReactElement {
  useEffect(() => {
    defineLivefluxDevtools();
  }, []);
  return createElement('liveflux-devtools');
}
