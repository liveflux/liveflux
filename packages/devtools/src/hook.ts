/**
 * @liveflux/devtools — global discovery hook.
 *
 * A DevTools panel must find every attached client without being wired to each one by hand. Following
 * the Redux / React Query / Vue devtools pattern, {@link attachDevtools} registers a
 * {@link ClientHandle} on a single well-known global. A panel reads `clients` and `subscribe`s to be
 * notified as clients come and go — so discovery is framework-agnostic and needs zero app wiring.
 */

import type { ObservabilityBus } from './bus';

/** The well-known global key a DevTools panel looks up. */
export const DEVTOOLS_HOOK_KEY = '__LIVEFLUX_DEVTOOLS_HOOK__';

/** A registered client, exposed to a panel through the global hook. */
export interface ClientHandle {
  readonly id: string;
  readonly bus: ObservabilityBus;
  readonly meta: { readonly createdAt: number; readonly adapter?: string };
}

/** The global discovery surface. */
export interface DevtoolsHook {
  readonly version: 1;
  /** The currently registered clients. */
  readonly clients: ReadonlySet<ClientHandle>;
  register(handle: ClientHandle): void;
  deregister(handle: ClientHandle): void;
  /** Notified with the full client list whenever a client registers or deregisters. */
  subscribe(listener: (clients: readonly ClientHandle[]) => void): () => void;
}

/** Get (or lazily create) the process/window-global hook. Safe to call repeatedly. */
export function getDevtoolsHook(): DevtoolsHook {
  const host = globalThis as unknown as Record<string, DevtoolsHook | undefined>;
  const existing = host[DEVTOOLS_HOOK_KEY];
  if (existing) return existing;

  const clients = new Set<ClientHandle>();
  const listeners = new Set<(clients: readonly ClientHandle[]) => void>();
  const notify = (): void => {
    const snapshot = [...clients];
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // isolate observer failures
      }
    }
  };

  const hook: DevtoolsHook = {
    version: 1,
    clients,
    register(handle) {
      clients.add(handle);
      notify();
    },
    deregister(handle) {
      if (clients.delete(handle)) notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  host[DEVTOOLS_HOOK_KEY] = hook;
  return hook;
}
