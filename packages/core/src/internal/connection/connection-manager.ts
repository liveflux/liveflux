import type { AdapterHandlers, ConnectionState, NormalizedEvent, StreamAdapter } from '../../types';
import { backoffDelay, resolveReconnectPolicy, type ReconnectPolicy } from './reconnect';

/** Heartbeat keepalive policy. */
export interface HeartbeatPolicy {
  /** Send a periodic keepalive while open (only if the adapter implements `heartbeat`). Default: false. */
  enabled: boolean;
  /** Interval between heartbeats, in ms. Default: 25_000. */
  intervalMs: number;
}

export const defaultHeartbeatPolicy: Readonly<HeartbeatPolicy> = Object.freeze({
  enabled: false,
  intervalMs: 25_000,
});

export interface ConnectionManagerOptions {
  adapter: StreamAdapter;
  reconnect?: Partial<ReconnectPolicy>;
  heartbeat?: Partial<HeartbeatPolicy>;
  /** Injectable RNG for backoff jitter — deterministic in tests. Defaults to Math.random. */
  random?: () => number;
  /** Called for every decoded event from the adapter (the client routes these to the registry). */
  onEvent?: (event: NormalizedEvent) => void;
}

type StateListener = (state: ConnectionState, previous: ConnectionState) => void;

/**
 * Owns a StreamAdapter's connection lifecycle: connect/close, automatic backoff reconnection,
 * and an optional heartbeat. Transport-agnostic — it only speaks the StreamAdapter contract.
 * Internal to the package: consumers drive it through the LivefluxClient context layer, and all
 * state is `#private` (runtime-encapsulated).
 */
export class ConnectionManager {
  readonly #adapter: StreamAdapter;
  readonly #reconnect: ReconnectPolicy;
  readonly #heartbeat: HeartbeatPolicy;
  readonly #random: () => number;
  readonly #onEvent: ((event: NormalizedEvent) => void) | undefined;

  #state: ConnectionState = 'idle';
  #attempts = 0; // consecutive failed reconnects
  #manualClose = false; // was close() called by the user?
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  readonly #listeners = new Set<StateListener>();

  constructor(opts: ConnectionManagerOptions) {
    this.#adapter = opts.adapter;
    this.#reconnect = resolveReconnectPolicy(opts.reconnect);
    const hb = { ...defaultHeartbeatPolicy, ...opts.heartbeat };
    this.#heartbeat = {
      enabled: hb.enabled === true,
      // A 0/negative/NaN interval would spam setInterval — fall back to the safe default.
      intervalMs:
        Number.isFinite(hb.intervalMs) && hb.intervalMs > 0
          ? hb.intervalMs
          : defaultHeartbeatPolicy.intervalMs,
    };
    this.#random = opts.random ?? Math.random;
    this.#onEvent = opts.onEvent;
  }

  /** Current connection state. */
  getState(): ConnectionState {
    return this.#state;
  }

  /** Subscribe to state transitions. Returns an unsubscribe function. */
  onStateChange(listener: StateListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Open the connection. No-op while already connecting/open. */
  connect(): void {
    if (this.#state === 'connecting' || this.#state === 'open') return;
    this.#manualClose = false;
    this.#clearReconnect(); // cancel any pending backoff and connect now
    this.#openAdapter();
  }

  /** Close permanently: cancels reconnect/heartbeat and disconnects the adapter. Idempotent. */
  close(): void {
    if (this.#state === 'closed') return;
    this.#manualClose = true;
    this.#clearReconnect();
    this.#stopHeartbeat();
    this.#adapter.disconnect();
    this.#setState('closed');
  }

  #openAdapter(): void {
    this.#setState(this.#attempts > 0 ? 'reconnecting' : 'connecting');
    const handlers: AdapterHandlers = {
      onOpen: () => this.#handleOpen(),
      onClose: () => this.#handleClose(),
      onError: () => {
        /* errors surface via observability later; the ensuing close drives reconnect */
      },
      onEvent: (event) => {
        this.#onEvent?.(event);
      },
    };
    this.#adapter.connect(handlers);
  }

  #handleOpen(): void {
    this.#attempts = 0;
    this.#setState('open');
    this.#startHeartbeat();
  }

  #handleClose(): void {
    this.#stopHeartbeat();
    if (this.#manualClose) {
      this.#setState('closed');
      return;
    }
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (!this.#reconnect.enabled || this.#attempts >= this.#reconnect.maxAttempts) {
      this.#setState('closed');
      return;
    }
    this.#attempts += 1;
    const delay = backoffDelay(this.#attempts, this.#reconnect, this.#random);
    this.#setState('reconnecting');
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#openAdapter();
    }, delay);
  }

  #startHeartbeat(): void {
    if (!this.#heartbeat.enabled || !this.#adapter.heartbeat) return;
    this.#heartbeatTimer = setInterval(() => this.#adapter.heartbeat?.(), this.#heartbeat.intervalMs);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  #clearReconnect(): void {
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }

  #setState(next: ConnectionState): void {
    if (next === this.#state) return;
    const previous = this.#state;
    this.#state = next;
    // Notify a snapshot so a listener that (un)subscribes during dispatch can't corrupt iteration,
    // and isolate failures so one bad subscriber can't break the state machine or the others.
    for (const listener of [...this.#listeners]) {
      try {
        listener(next, previous);
      } catch (err) {
        // Never swallow: resurface asynchronously so it reaches the host error handler
        // without breaking the synchronous dispatch loop.
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }
}
