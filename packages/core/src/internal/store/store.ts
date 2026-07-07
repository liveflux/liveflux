import type { Id, NormalizedEvent } from '../../types';

/** How incoming events fold into a subscription's state. */
export type IntoStrategy<T, S = T> =
  | { strategy: 'append'; cap?: number } // log / feed → T[]
  | { strategy: 'upsert'; key: keyof T | ((item: T) => Id); cap?: number } // entity list → T[]
  | { strategy: 'replace' } // latest snapshot → T
  | { strategy: 'reducer'; reduce: (state: S, event: NormalizedEvent) => S; initial: S }; // → S

type Listener = () => void;

/**
 * Holds the state derived from a subscription's events, folding each event according to the
 * chosen strategy. Framework-agnostic and subscribe-able — bindings read it (e.g. via
 * useSyncExternalStore) and re-render when it changes.
 *
 * All state is held in `#private` fields — runtime-encapsulated, not merely `private` at compile
 * time. Payloads are trusted here; schema validation happens upstream (a later increment).
 */
export class Store<T = unknown, S = T> {
  readonly #strategy: IntoStrategy<T, S>;
  readonly #listeners = new Set<Listener>();

  // Only the current strategy's backing state is allocated (see constructor): a `replace` or
  // `reducer` store carries neither the list nor the entities map — lean at scale (many stores).
  /** append state */
  #list: T[] | null = null;
  /** upsert state: insertion-ordered id → item — O(1) set/delete, no index to rebuild */
  #entities: Map<Id, T> | null = null;
  /** upsert: lazily materialized, cached array view of `#entities` (invalidated on each change) */
  #upsertSnapshot: T[] | null = null;
  /** replace state */
  #latest: T | undefined;
  /** reducer state */
  #reduced: S | undefined;

  constructor(strategy: IntoStrategy<T, S>) {
    this.#strategy = strategy;
    // Allocate exactly the backing state this strategy uses — nothing more.
    switch (strategy.strategy) {
      case 'append':
        this.#list = [];
        break;
      case 'upsert':
        this.#entities = new Map();
        break;
      case 'reducer':
        this.#reduced = strategy.initial;
        break;
      // 'replace' keeps only `#latest` — no collection to allocate
    }
  }

  /** Current derived state. Shape depends on the strategy: `T[] | T | S | undefined`. */
  getState(): T[] | T | S | undefined {
    switch (this.#strategy.strategy) {
      case 'append':
        return this.#list!; // allocated in the constructor for 'append'
      case 'upsert':
        // Materialize once per change, then serve the cached array (stable ref between events).
        if (this.#upsertSnapshot === null) this.#upsertSnapshot = [...this.#entities!.values()];
        return this.#upsertSnapshot;
      case 'replace':
        return this.#latest;
      case 'reducer':
        return this.#reduced;
    }
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Fold one event into the state, then notify subscribers. */
  apply(event: NormalizedEvent): void {
    const s = this.#strategy;
    switch (s.strategy) {
      case 'append': {
        const cap = s.cap;
        const list = this.#list!; // allocated in the constructor for 'append'
        if (cap === undefined) {
          this.#list = [...list, event.payload as T];
        } else if (cap <= 0) {
          this.#list = [];
        } else {
          // Keep the last `cap` items of (list + payload) in ONE new array — no spread-then-slice.
          const drop = list.length + 1 - cap;
          const next = drop > 0 ? list.slice(drop) : list.slice();
          next.push(event.payload as T);
          this.#list = next;
        }
        break;
      }
      case 'upsert': {
        const item = event.payload as T;
        const entities = this.#entities!; // allocated in the constructor for 'upsert'
        const id = this.#keyOf(s.key, item);
        const existed = entities.has(id);
        entities.set(id, item); // O(1) — updates in place (keeps order) or appends at the end
        if (!existed && s.cap !== undefined && entities.size > s.cap) {
          // Drop the oldest (first-inserted). Map preserves insertion order, so this is O(1) — no
          // index rebuild, unlike a positional array.
          const oldest = entities.keys().next().value;
          if (oldest !== undefined) entities.delete(oldest);
        }
        this.#upsertSnapshot = null; // invalidate the cached view
        break;
      }
      case 'replace': {
        this.#latest = event.payload as T;
        break;
      }
      case 'reducer': {
        this.#reduced = s.reduce(this.#reduced as S, event);
        break;
      }
    }
    this.#notify();
  }

  #keyOf(key: keyof T | ((item: T) => Id), item: T): Id {
    return typeof key === 'function' ? key(item) : (item[key] as unknown as Id);
  }

  #notify(): void {
    // Iterate the live set directly — no per-event snapshot allocation. Deleting a listener mid-
    // dispatch is safe under Set iteration, and store listeners (useSyncExternalStore callbacks)
    // don't (un)subscribe synchronously. A throwing listener is isolated so it can't break fan-out.
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }
}
