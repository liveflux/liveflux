import type { NormalizedEvent, StreamAdapter, SubscribeRequest } from '../../types';

/** A listener for events arriving on a single channel. */
export type EventListener = (event: NormalizedEvent) => void;

/** The subset of a StreamAdapter the registry drives. */
type Wire = Pick<StreamAdapter, 'subscribe' | 'unsubscribe'>;

interface ChannelEntry {
  subId: string;
  listeners: Map<number, EventListener>; // local subscription id → listener
}

/**
 * Multiplexes many channel subscriptions over one connection and ref-counts them: the first
 * subscriber to a channel opens the wire subscription; the last to leave tears it down. Incoming
 * events are fanned out to every listener on their channel. All state is `#private` — runtime-
 * encapsulated, driven only through the public methods below.
 */
export class SubscriptionRegistry {
  readonly #wire: Wire;
  readonly #channels = new Map<string, ChannelEntry>();
  #nextWireId = 1;
  #nextLocalId = 1;

  constructor(wire: Wire) {
    this.#wire = wire;
  }

  /**
   * Subscribe `listener` to `channel`. Returns an idempotent unsubscribe function; when the last
   * listener on a channel unsubscribes, the wire subscription is torn down.
   */
  subscribe(
    channel: string,
    listener: EventListener,
    params?: Record<string, unknown>,
  ): () => void {
    let entry = this.#channels.get(channel);
    if (!entry) {
      const subId = `sub_${this.#nextWireId++}`;
      entry = { subId, listeners: new Map() };
      this.#channels.set(channel, entry);
      const req: SubscribeRequest = { subId, channel, ...(params !== undefined ? { params } : {}) };
      this.#wire.subscribe(req);
    }

    const localId = this.#nextLocalId++;
    entry.listeners.set(localId, listener);

    let active = true;
    return () => {
      if (!active) return; // idempotent
      active = false;
      const current = this.#channels.get(channel);
      if (!current) return;
      current.listeners.delete(localId);
      if (current.listeners.size === 0) {
        this.#channels.delete(channel);
        this.#wire.unsubscribe(current.subId);
      }
    };
  }

  /** Route an incoming event to every listener on its channel. */
  handleEvent(event: NormalizedEvent): void {
    const entry = this.#channels.get(event.channel);
    if (!entry) return; // no local subscribers (e.g., a late event after teardown)
    // Iterate listeners directly — no per-event snapshot allocation. Map iteration tolerates
    // deletion mid-dispatch, and channel listeners (store.apply) don't (un)subscribe synchronously.
    // A throwing listener is isolated so it can't break fan-out to the rest.
    for (const listener of entry.listeners.values()) {
      try {
        listener(event);
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }

  /** Number of active wire subscriptions (channels with ≥1 listener). */
  get size(): number {
    return this.#channels.size;
  }

  /** Tear down every wire subscription (e.g., on client destroy). */
  clear(): void {
    for (const entry of this.#channels.values()) this.#wire.unsubscribe(entry.subId);
    this.#channels.clear();
  }
}
