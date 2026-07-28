/**
 * @liveflux/devtools — attach the observability tooling to a client.
 *
 * `attachDevtools(client)` builds a bus, wires it to the client's {@link ClientObserver} tap
 * (redacting payloads on the way), and registers the client on the global hook so a panel can find
 * it. Intended for dev only:
 *
 * ```ts
 * import { LivefluxClient } from '@liveflux/core';
 * import { attachDevtools } from '@liveflux/devtools';
 *
 * const client = new LivefluxClient({ adapter });
 * if (import.meta.env.DEV) attachDevtools(client);
 * ```
 *
 * In a production build the guarded import is tree-shaken away, so neither this package nor the bus
 * ships — core stays lean.
 */

import { LivefluxError, type ClientObserver, type LivefluxClient } from '@liveflux/core';
import { ObservabilityBus } from './bus';
import type { DevtoolsErrorInfo } from './events';
import { getDevtoolsHook } from './hook';
import { buildRedactSet, redactValue } from './redact';

export interface AttachDevtoolsOptions {
  /** Extra object keys (case-insensitive) to scrub from emitted payloads, on top of the defaults. */
  redactKeys?: string[];
  /** How many recent events to retain for a late-attaching panel (default 1000). */
  bufferSize?: number;
}

/** Monotonic client id source — deterministic and cheap. */
let clientSeq = 0;

/** Approximate serialized size (characters) of a payload, tolerant of non-serializable values. */
function approxBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Compact, bus-safe description of an error; carries the `code` for `LivefluxError`s. */
function describeError(err: unknown): DevtoolsErrorInfo {
  if (err instanceof LivefluxError) return { name: err.name, code: err.code, message: err.message };
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: 'UnknownError', message: String(err) };
}

/**
 * Attach observability tooling to a client. Returns a detach function that emits `client:destroy`,
 * deregisters from the global hook, and unwires the observer — call it when the client is torn down.
 */
export function attachDevtools(
  client: LivefluxClient,
  options: AttachDevtoolsOptions = {},
): () => void {
  const bus = new ObservabilityBus(options.bufferSize);
  const redactKeys = buildRedactSet(options.redactKeys);
  const clientId = `client-${(clientSeq += 1)}`;

  const observer: ClientObserver = {
    onConnectionState: (state, previous) =>
      bus.emit({ t: 'connection:state', clientId, from: previous, to: state, at: Date.now() }),
    onError: (err) => bus.emit({ t: 'error', clientId, error: describeError(err), at: Date.now() }),
    onSubscriptionAdd: (sub) =>
      bus.emit({
        t: 'sub:add',
        clientId,
        subId: sub.id,
        channel: sub.channel,
        strategy: sub.strategy,
        cap: sub.cap,
        refCount: sub.refCount,
        at: Date.now(),
      }),
    onSubscriptionRefChange: (id, refCount) =>
      bus.emit({ t: 'sub:refchange', clientId, subId: id, refCount, at: Date.now() }),
    onSubscriptionRemove: (id) =>
      bus.emit({ t: 'sub:remove', clientId, subId: id, at: Date.now() }),
    onEvent: (event) =>
      bus.emit({
        t: 'event:in',
        clientId,
        channel: event.channel,
        event: event.event,
        payload: redactValue(event.payload, redactKeys),
        bytes: approxBytes(event.payload),
        at: Date.now(),
      }),
  };

  const detachObserver = client.observe(observer);
  const handle = { id: clientId, bus, meta: { createdAt: Date.now() } };
  getDevtoolsHook().register(handle);
  bus.emit({ t: 'client:register', clientId, at: Date.now() });

  let detached = false;
  return () => {
    if (detached) return; // idempotent — a double detach must not re-emit destroy
    detached = true;
    bus.emit({ t: 'client:destroy', clientId, at: Date.now() });
    getDevtoolsHook().deregister(handle);
    detachObserver();
  };
}
