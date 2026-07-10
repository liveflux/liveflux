import type {
  AdapterHandlers,
  Cursor,
  NormalizedEvent,
  StreamAdapter,
  SubscribeRequest,
} from '@liveflux/core';

/** One recorded `resume(subId, cursor)` invocation. */
export interface ResumeCall {
  subId: string;
  cursor: Cursor | null;
}

/**
 * A fully programmable {@link StreamAdapter} with **no real socket and no timers** — the Layer-1
 * testing tool from the Liveflux test strategy. It faithfully records everything the core drives it
 * with (connect / subscribe / unsubscribe / resume / heartbeat / disconnect) and lets a test act as
 * the server through a tiny synchronous control surface (`open` / `emit` / `drop` / `fail`).
 *
 * Everything is deterministic and synchronous: a `drop()` calls `onClose` immediately, an `emit()`
 * calls `onEvent` immediately — no fake timers required (pair with Vitest fake timers only when the
 * code under test schedules its own).
 *
 * Reconnect fidelity: like every real adapter, it retains its active subscription set across an
 * unexpected drop and **replays it on the next `open()`** (the core re-invokes `connect`, never
 * `subscribe`, on reconnect — replaying active subs is the adapter's contract). This is what makes it
 * a valid subject for the shared conformance suite as well as a driver for core's own unit tests.
 *
 * All state is `#private` (runtime-encapsulated); the introspection getters return defensive copies,
 * so a test can read what happened without being able to corrupt the adapter's internal state.
 */
export class MockAdapter implements StreamAdapter {
  #handlers: AdapterHandlers | null = null;
  #open = false;
  #everConnected = false;

  /** subId → its most recent SubscribeRequest (the current active set). */
  readonly #active = new Map<string, SubscribeRequest>();
  /** channel → the subIds currently subscribed to it (for cursor attribution on `emit`). */
  readonly #byChannel = new Map<string, Set<string>>();
  /** subId → last cursor observed on an event for that subscription's channel. */
  readonly #cursors = new Map<string, Cursor>();

  readonly #subscribeLog: SubscribeRequest[] = [];
  readonly #unsubscribeLog: string[] = [];
  readonly #resumeLog: ResumeCall[] = [];
  #heartbeats = 0;

  // ---- StreamAdapter contract (driven by the core) -----------------------------------------

  connect(handlers: AdapterHandlers): void {
    // A fresh (re)connect: capture the new handlers and re-arm. The active set is intentionally
    // preserved so the next `open()` can replay it — mirroring how real adapters reconnect.
    this.#handlers = handlers;
    this.#open = false;
    this.#everConnected = true;
  }

  disconnect(): void {
    // Permanent teardown: no callback may fire after this until a new `connect()`.
    this.#open = false;
    this.#handlers = null;
  }

  subscribe(sub: SubscribeRequest): void {
    this.#active.set(sub.subId, sub);
    let channelSubs = this.#byChannel.get(sub.channel);
    if (!channelSubs) {
      channelSubs = new Set();
      this.#byChannel.set(sub.channel, channelSubs);
    }
    channelSubs.add(sub.subId);
    // A subscribe issued while open goes out immediately; while closed it is held until the next
    // `open()` replays the active set — exactly one wire frame per (re)open.
    if (this.#open) this.#subscribeLog.push(sub);
  }

  unsubscribe(subId: string): void {
    this.#unsubscribeLog.push(subId);
    const sub = this.#active.get(subId);
    if (sub) {
      this.#active.delete(subId);
      const channelSubs = this.#byChannel.get(sub.channel);
      if (channelSubs) {
        channelSubs.delete(subId);
        if (channelSubs.size === 0) this.#byChannel.delete(sub.channel);
      }
    }
    this.#cursors.delete(subId);
  }

  heartbeat(): void {
    this.#heartbeats += 1;
  }

  resume(subId: string, cursor: Cursor | null): void {
    this.#resumeLog.push({ subId, cursor });
  }

  // ---- Control surface (a test plays the server) -------------------------------------------

  /** Complete the connection handshake: fire `onOpen` and replay the active subscription set. */
  open(): void {
    const handlers = this.#requireHandlers('open');
    this.#open = true;
    // Replay active subs first (the server learns them on (re)open), then signal open — the same
    // order a real adapter uses so a reconnect re-subscribes before anything else runs.
    for (const sub of this.#active.values()) this.#subscribeLog.push(sub);
    handlers.onOpen();
  }

  /**
   * Push one server event down the wire; delivered to `onEvent` only while open. A frame that
   * arrives on a torn-down connection (before open, while dropped, or after disconnect) is silently
   * ignored — exactly as a real adapter drops a late frame from a retired connection.
   */
  emit(event: NormalizedEvent): void {
    const handlers = this.#liveHandlers('emit');
    if (handlers === null || !this.#open) return; // a closed/dead connection carries nothing
    if (event.cursor !== undefined) {
      const channelSubs = this.#byChannel.get(event.channel);
      if (channelSubs) for (const subId of channelSubs) this.#cursors.set(subId, event.cursor);
    }
    handlers.onEvent(event);
  }

  /** Simulate an unexpected close (network loss). Fires `onClose`; the active set is retained. */
  drop(reason?: unknown): void {
    const handlers = this.#liveHandlers('drop');
    if (handlers === null) return; // already disconnected → nothing to close
    this.#open = false;
    handlers.onClose(reason);
  }

  /** Simulate a transport error surfaced by the connection. Fires `onError`. */
  fail(err: unknown): void {
    const handlers = this.#liveHandlers('fail');
    if (handlers === null) return; // already disconnected → nothing to surface
    handlers.onError(err);
  }

  // ---- Introspection (defensive copies; never leaks internal state) ------------------------

  /** The handlers captured on the most recent `connect`, or `null` before connect / after disconnect. */
  get handlers(): AdapterHandlers | null {
    return this.#handlers;
  }

  /** Whether the connection is currently open (between `open()` and the next `drop()`/`disconnect()`). */
  get connected(): boolean {
    return this.#open;
  }

  /** The current active subscriptions, in insertion order. */
  get subscriptions(): readonly SubscribeRequest[] {
    return [...this.#active.values()];
  }

  /** Every subscribe frame sent to the server, in order — including reconnect replays. */
  get subscribeLog(): readonly SubscribeRequest[] {
    return [...this.#subscribeLog];
  }

  /** The subIds an `unsubscribe` frame was sent for, in order. */
  get unsubscribeLog(): readonly string[] {
    return [...this.#unsubscribeLog];
  }

  /** Every `resume(subId, cursor)` call, in order. */
  get resumeLog(): readonly ResumeCall[] {
    return this.#resumeLog.map((call) => ({ ...call }));
  }

  /** How many `heartbeat()` frames the core has requested. */
  get heartbeats(): number {
    return this.#heartbeats;
  }

  /** The last cursor observed for `subId`'s channel, or `null` if none has arrived. */
  lastCursor(subId: string): Cursor | null {
    return this.#cursors.get(subId) ?? null;
  }

  /** Handlers for a step that strictly requires a live connect (`open`); throws otherwise. */
  #requireHandlers(action: string): AdapterHandlers {
    if (this.#handlers === null) {
      throw new Error(
        `MockAdapter: cannot ${action}() ` +
          (this.#everConnected ? 'after disconnect() — connect() again first' : 'before connect()'),
      );
    }
    return this.#handlers;
  }

  /**
   * Handlers for a server-driven step (`emit` / `drop` / `fail`). Returns `null` once the adapter has
   * been disconnected — a late frame on a dead connection is ignored, not an error — but still throws
   * if `connect()` was never called, to catch genuine test misuse.
   */
  #liveHandlers(action: string): AdapterHandlers | null {
    if (this.#handlers === null) {
      if (this.#everConnected) return null; // disconnected: silently ignore late server activity
      throw new Error(`MockAdapter: cannot ${action}() before connect()`);
    }
    return this.#handlers;
  }
}
