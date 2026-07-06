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
 * Payloads are trusted here; schema validation happens upstream (a later increment).
 */
export class Store<T = unknown, S = T> {
  private readonly strategy: IntoStrategy<T, S>;
  private readonly listeners = new Set<Listener>();

  /** append / upsert state */
  private list: T[] = [];
  /** upsert: key → index in `list` */
  private readonly keyIndex = new Map<Id, number>();
  /** replace state */
  private latest: T | undefined;
  /** reducer state */
  private reduced: S | undefined;

  constructor(strategy: IntoStrategy<T, S>) {
    this.strategy = strategy;
    if (strategy.strategy === 'reducer') this.reduced = strategy.initial;
  }

  /** Current derived state. Shape depends on the strategy: `T[] | T | S | undefined`. */
  getState(): T[] | T | S | undefined {
    switch (this.strategy.strategy) {
      case 'append':
      case 'upsert':
        return this.list;
      case 'replace':
        return this.latest;
      case 'reducer':
        return this.reduced;
    }
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Fold one event into the state, then notify subscribers. */
  apply(event: NormalizedEvent): void {
    const s = this.strategy;
    switch (s.strategy) {
      case 'append': {
        const next = [...this.list, event.payload as T];
        this.list =
          s.cap !== undefined && next.length > s.cap ? next.slice(next.length - s.cap) : next;
        break;
      }
      case 'upsert': {
        const item = event.payload as T;
        const id = this.keyOf(s.key, item);
        const pos = this.keyIndex.get(id);
        if (pos !== undefined) {
          const next = this.list.slice();
          next[pos] = item;
          this.list = next; // same positions → index unchanged
        } else {
          this.list = [...this.list, item];
          this.keyIndex.set(id, this.list.length - 1);
          if (s.cap !== undefined && this.list.length > s.cap) {
            this.list = this.list.slice(this.list.length - s.cap);
            this.reindexUpsert(s.key); // positions shifted after the trim
          }
        }
        break;
      }
      case 'replace': {
        this.latest = event.payload as T;
        break;
      }
      case 'reducer': {
        this.reduced = s.reduce(this.reduced as S, event);
        break;
      }
    }
    this.notify();
  }

  private keyOf(key: keyof T | ((item: T) => Id), item: T): Id {
    return typeof key === 'function' ? key(item) : (item[key] as unknown as Id);
  }

  private reindexUpsert(key: keyof T | ((item: T) => Id)): void {
    this.keyIndex.clear();
    this.list.forEach((item, i) => this.keyIndex.set(this.keyOf(key, item), i));
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
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
