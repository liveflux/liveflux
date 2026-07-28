/**
 * @liveflux/devtools — headless view-model.
 *
 * Folds the raw {@link DevtoolsEvent} stream into panel-ready state: per client a connection state +
 * timeline, an active-subscriptions table, a bounded event log, and a bounded error log. Pure and
 * DOM-free, so it is unit-testable, reusable by any UI shell, and worker-safe.
 *
 * - {@link ClientModel} folds one client's events (drive it with `apply`, read with `getView`).
 * - {@link DevtoolsModel} discovers clients through the global hook, folds each one, and exposes an
 *   aggregate snapshot plus a coalesced change subscription for a panel to render from.
 */

import type { ConnectionState } from '@liveflux/core';
import type { DevtoolsEvent } from './events';
import { getDevtoolsHook, type ClientHandle, type DevtoolsHook } from './hook';

/** One connection-state transition, for the timeline. */
export interface ConnectionTransition {
  readonly from: ConnectionState;
  readonly to: ConnectionState;
  readonly at: number;
}

/** A row in the active-subscriptions table. */
export interface SubscriptionView {
  readonly id: string;
  readonly channel: string;
  readonly strategy: string;
  readonly cap?: number;
  readonly refCount: number;
}

/** A row in the event log (payload already redacted upstream). */
export interface EventLogEntry {
  /** Monotonic id (per client), so a renderer can append only rows it hasn't shown yet. */
  readonly seq: number;
  readonly channel: string;
  readonly event: string;
  readonly payload: unknown;
  readonly bytes: number;
  readonly at: number;
}

/** A row in the error log. */
export interface ErrorLogEntry {
  /** Monotonic id (per client), for incremental append. */
  readonly seq: number;
  readonly name: string;
  readonly code?: string;
  readonly message: string;
  readonly at: number;
}

/** Everything a panel needs to render one client. */
export interface ClientView {
  readonly id: string;
  /** Still registered on the hook (false once its client is destroyed/detached). */
  readonly present: boolean;
  readonly connectionState: ConnectionState;
  readonly connectionTimeline: ConnectionTransition[];
  readonly subscriptions: SubscriptionView[];
  readonly events: EventLogEntry[];
  readonly errors: ErrorLogEntry[];
  readonly eventCount: number;
  readonly lastEventAt?: number;
  readonly createdAt?: number;
}

/** The aggregate snapshot across every discovered client. */
export interface DevtoolsState {
  readonly clients: ClientView[];
}

/** How much history to retain per client (bounded so memory can't grow without limit). */
export interface ViewModelCaps {
  /** Connection transitions kept (default 100). */
  timeline?: number;
  /** Events kept (default 500). */
  events?: number;
  /** Errors kept (default 100). */
  errors?: number;
}

const DEFAULT_CAPS: Required<ViewModelCaps> = { timeline: 100, events: 500, errors: 100 };

function pushCapped<T>(arr: T[], item: T, cap: number): void {
  arr.push(item);
  if (arr.length > cap) arr.shift();
}

/**
 * Folds one client's {@link DevtoolsEvent} stream into a {@link ClientView}. State updates
 * synchronously on `apply`; `getView` returns a fresh, copy-safe snapshot.
 */
export class ClientModel {
  readonly #id: string;
  readonly #caps: Required<ViewModelCaps>;
  #present = false;
  #createdAt: number | undefined;
  #connectionState: ConnectionState = 'idle';
  #eventCount = 0;
  #lastEventAt: number | undefined;
  #seq = 0; // monotonic id source for event/error rows (per client)
  readonly #timeline: ConnectionTransition[] = [];
  readonly #subs = new Map<
    string,
    { id: string; channel: string; strategy: string; cap?: number; refCount: number }
  >();
  readonly #events: EventLogEntry[] = [];
  readonly #errors: ErrorLogEntry[] = [];

  constructor(id: string, caps: ViewModelCaps = {}) {
    this.#id = id;
    this.#caps = { ...DEFAULT_CAPS, ...caps };
  }

  apply(event: DevtoolsEvent): void {
    switch (event.t) {
      case 'client:register':
        this.#present = true;
        this.#createdAt = event.at;
        break;
      case 'client:destroy':
        this.#present = false;
        break;
      case 'connection:state':
        this.#connectionState = event.to;
        pushCapped(
          this.#timeline,
          { from: event.from, to: event.to, at: event.at },
          this.#caps.timeline,
        );
        break;
      case 'sub:add':
        this.#subs.set(event.subId, {
          id: event.subId,
          channel: event.channel,
          strategy: event.strategy,
          cap: event.cap,
          refCount: event.refCount,
        });
        break;
      case 'sub:refchange': {
        const sub = this.#subs.get(event.subId);
        if (sub) sub.refCount = event.refCount;
        break;
      }
      case 'sub:remove':
        this.#subs.delete(event.subId);
        break;
      case 'event:in':
        this.#eventCount += 1;
        this.#lastEventAt = event.at;
        pushCapped(
          this.#events,
          {
            seq: this.#seq++,
            channel: event.channel,
            event: event.event,
            payload: event.payload,
            bytes: event.bytes,
            at: event.at,
          },
          this.#caps.events,
        );
        break;
      case 'error':
        pushCapped(
          this.#errors,
          {
            seq: this.#seq++,
            name: event.error.name,
            code: event.error.code,
            message: event.error.message,
            at: event.at,
          },
          this.#caps.errors,
        );
        break;
    }
  }

  /** Mark the client gone when the hook drops it without a `client:destroy` event. */
  markGone(): void {
    this.#present = false;
  }

  getView(): ClientView {
    return {
      id: this.#id,
      present: this.#present,
      connectionState: this.#connectionState,
      connectionTimeline: [...this.#timeline],
      subscriptions: [...this.#subs.values()].map((s) => ({ ...s })),
      events: [...this.#events],
      errors: [...this.#errors],
      eventCount: this.#eventCount,
      lastEventAt: this.#lastEventAt,
      createdAt: this.#createdAt,
    };
  }
}

/**
 * Discovers clients through the global hook, folds each client's bus into a {@link ClientModel}, and
 * exposes an aggregate {@link DevtoolsState} plus a change subscription. Change notifications are
 * coalesced to one per microtask, so a burst of events triggers a single render. `getState()` is
 * always current (folding is synchronous) — only the notification is deferred.
 */
export class DevtoolsModel {
  readonly #hook: DevtoolsHook;
  readonly #caps: ViewModelCaps;
  readonly #models = new Map<string, ClientModel>();
  readonly #busOffs = new Map<string, () => void>();
  readonly #listeners = new Set<() => void>();
  readonly #hookOff: () => void;
  #notifyScheduled = false;
  #destroyed = false;

  constructor(options: { hook?: DevtoolsHook; caps?: ViewModelCaps } = {}) {
    this.#hook = options.hook ?? getDevtoolsHook();
    this.#caps = options.caps ?? {};
    this.#hookOff = this.#hook.subscribe((clients) => this.#sync(clients));
    this.#sync([...this.#hook.clients]);
  }

  getState(): DevtoolsState {
    return { clients: [...this.#models.values()].map((m) => m.getView()) };
  }

  /** Subscribe to change notifications (coalesced per microtask). Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Detach from the hook and every client bus; clears listeners. */
  destroy(): void {
    this.#destroyed = true;
    this.#hookOff();
    for (const off of this.#busOffs.values()) off();
    this.#busOffs.clear();
    this.#listeners.clear();
  }

  #sync(clients: readonly ClientHandle[]): void {
    if (this.#destroyed) return;
    const present = new Set<string>();
    for (const handle of clients) {
      present.add(handle.id);
      if (this.#models.has(handle.id)) continue;
      const model = new ClientModel(handle.id, this.#caps);
      this.#models.set(handle.id, model);
      // Replay buffered history, then fold live events. Both are synchronous, so nothing is missed.
      for (const event of handle.bus.getBuffer()) model.apply(event);
      const off = handle.bus.subscribe((event) => {
        model.apply(event);
        this.#scheduleNotify();
      });
      this.#busOffs.set(handle.id, off);
    }
    // A client dropped from the hook: stop folding it but keep its view (marked gone) for inspection.
    for (const [id, model] of this.#models) {
      if (present.has(id)) continue;
      const off = this.#busOffs.get(id);
      if (off) {
        off();
        this.#busOffs.delete(id);
        model.markGone();
      }
    }
    this.#scheduleNotify();
  }

  #scheduleNotify(): void {
    if (this.#notifyScheduled || this.#destroyed) return;
    this.#notifyScheduled = true;
    queueMicrotask(() => {
      this.#notifyScheduled = false;
      if (this.#destroyed) return;
      for (const listener of [...this.#listeners]) {
        try {
          listener();
        } catch {
          // isolate observer failures
        }
      }
    });
  }
}
