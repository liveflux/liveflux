/**
 * @liveflux/devtools — observability bus.
 *
 * A per-client, in-memory bus: a bounded ring of recent events plus a set of live listeners. The
 * ring lets a DevTools panel that attaches late still see recent history; new events also stream to
 * listeners as they happen.
 */

import type { DevtoolsEvent } from './events';

/** Default number of events retained for late-attaching panels. */
const DEFAULT_CAP = 1000;

export class ObservabilityBus {
  readonly #buffer: DevtoolsEvent[] = [];
  readonly #cap: number;
  readonly #listeners = new Set<(event: DevtoolsEvent) => void>();

  constructor(cap: number = DEFAULT_CAP) {
    this.#cap = Math.max(1, Math.floor(cap));
  }

  /**
   * Record an event: append to the ring (evicting the oldest once past `cap`) and notify every
   * listener. A throwing listener is isolated so one bad observer can't break emission or the caller.
   */
  emit(event: DevtoolsEvent): void {
    this.#buffer.push(event);
    if (this.#buffer.length > this.#cap) this.#buffer.shift();
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // isolate observer failures — the bus must never break the client
      }
    }
  }

  /** Observe events live. History is not replayed; call {@link getBuffer} for what came before. */
  subscribe(listener: (event: DevtoolsEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** A snapshot copy of buffered history, oldest first. */
  getBuffer(): readonly DevtoolsEvent[] {
    return this.#buffer.slice();
  }

  /** Drop buffered history; listeners stay attached. */
  clear(): void {
    this.#buffer.length = 0;
  }
}
