'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  LivefluxClient,
  type AdapterHandlers,
  type NormalizedEvent,
  type StreamAdapter,
  type SubscribeRequest,
} from '@liveflux/core';
import { LivefluxProvider, useStream } from '@liveflux/react';
import { cn } from '@/lib/cn';

/** The row shape the demo folds into — the exact `Trade` type from the code snippet beside it. */
type Trade = { id: number; symbol: string; price: number };

/** Deterministic seed — also the SSR/first-render content, so hydration never mismatches. */
const SEED: Trade[] = [
  { id: 1, symbol: 'AAPL', price: 227.4 },
  { id: 2, symbol: 'BTC', price: 68450 },
  { id: 3, symbol: 'ETH', price: 3720 },
  { id: 4, symbol: 'TSLA', price: 251.3 },
  { id: 5, symbol: 'NVDA', price: 124.8 },
];

const CHANNEL = 'trades';

/**
 * A self-contained {@link StreamAdapter} with no server: on `connect` it opens synchronously and
 * then, on an interval, drifts one trade's price and emits it as a {@link NormalizedEvent}. The
 * core folds each event via `upsert` (keyed by `id`), so the same rows update in place. The tick
 * is slowed under reduced-motion. `disconnect()` (called by `client.destroy()`) clears the timer.
 */
class MockTradesAdapter implements StreamAdapter {
  #handlers: AdapterHandlers | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #prices = new Map<number, number>(SEED.map((t) => [t.id, t.price]));
  readonly #tickMs: number;

  constructor(tickMs: number) {
    this.#tickMs = tickMs;
  }

  connect(handlers: AdapterHandlers): void {
    this.#handlers = handlers;
    handlers.onOpen();
    // Emit the seed once so the live list matches the visible SSR rows immediately, then drift.
    for (const t of SEED) this.#emit(t);
    this.#timer = setInterval(() => this.#tick(), this.#tickMs);
  }

  disconnect(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#handlers = null;
  }

  // The demo drives a single fixed channel; no per-subscription wire state is needed.
  subscribe(_sub: SubscribeRequest): void {}
  unsubscribe(_subId: string): void {}

  #tick(): void {
    const seed = SEED[Math.floor(Math.random() * SEED.length)];
    const last = this.#prices.get(seed.id) ?? seed.price;
    // Random walk bounded to ±0.6% of the seed so prices drift but stay recognisable.
    const drift = (Math.random() - 0.5) * 0.012 * seed.price;
    const next = Math.max(0.01, last + drift);
    this.#prices.set(seed.id, next);
    this.#emit({ id: seed.id, symbol: seed.symbol, price: next });
  }

  #emit(trade: Trade): void {
    this.#handlers?.onEvent({ channel: CHANNEL, event: 'update', payload: trade });
  }
}

/** No-op subscribe → useSyncExternalStore as a client-mount flag (false on server, true on client). */
const emptySubscribe = () => () => {};

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window === 'undefined') return () => {};
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    () => false,
  );
}

function formatPrice(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** One row — flashes a subtle up/down tint on a price change, unless reduced motion is preferred. */
function Row({ trade, animate }: { trade: Trade; animate: boolean }) {
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const prev = useRef(trade.price);

  useEffect(() => {
    if (!animate) {
      prev.current = trade.price;
      return;
    }
    if (trade.price === prev.current) return;
    const dir = trade.price > prev.current ? 'up' : 'down';
    prev.current = trade.price;
    setFlash(dir);
    const id = setTimeout(() => setFlash(null), 550);
    return () => clearTimeout(id);
  }, [trade.price, animate]);

  return (
    <div
      className={cn(
        'flex items-center justify-between px-4 py-2 text-sm transition-colors duration-500',
        flash === 'up' && 'bg-emerald-500/10',
        flash === 'down' && 'bg-rose-500/10',
      )}
    >
      <span className="font-medium">{trade.symbol}</span>
      <span className="font-mono tabular-nums text-fd-muted-foreground">
        {formatPrice(trade.price)}
      </span>
    </div>
  );
}

/** Reads the folded `upsert` list via the real `useStream` and renders it. */
function LiveTable({ animate }: { animate: boolean }) {
  const trades = useStream<Trade>({
    channel: CHANNEL,
    into: { strategy: 'upsert', key: 'id', cap: 6 },
  });
  // Before the first event, `upsert` yields `[]` — show the seed so the table is never empty.
  const rows = trades.length > 0 ? trades : SEED;

  return (
    <div
      role="img"
      aria-label={`Live trades feed streaming ${rows.length} symbols with prices updating in place`}
    >
      {/* Rows update several times a second — hidden from the SR announcement queue (the label
          above conveys the meaning) so a screen reader is never spammed with every tick. */}
      <div aria-hidden className="divide-y divide-fd-border">
        {rows.map((t) => (
          <Row key={t.id} trade={t} animate={animate} />
        ))}
      </div>
    </div>
  );
}

/**
 * A real Liveflux pipeline running on the landing page — no server. A {@link MockTradesAdapter}
 * feeds a {@link LivefluxClient}; `useStream` folds the events and renders a live, in-place table.
 * The client is created once, connected on mount, and torn down (`destroy()`) on unmount.
 */
export function LiveDemo() {
  const reduced = usePrefersReducedMotion();
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);

  const [client] = useState(
    () => new LivefluxClient({ adapter: new MockTradesAdapter(reduced ? 2200 : 900) }),
  );

  useEffect(() => {
    client.connect();
    return () => client.destroy();
  }, [client]);

  return (
    <div className="overflow-hidden rounded-xl border border-fd-border bg-fd-card">
      <div className="flex items-center gap-2 border-b border-fd-border px-4 py-2.5">
        <span className="relative flex size-2.5 items-center justify-center">
          {!reduced && (
            <span
              className="absolute inline-flex size-full animate-ping rounded-full opacity-60"
              style={{ backgroundColor: 'var(--lf-accent)' }}
            />
          )}
          <span
            className="relative inline-flex size-2 rounded-full"
            style={{ backgroundColor: 'var(--lf-accent)' }}
          />
        </span>
        <span className="text-xs font-medium text-fd-muted-foreground">Live · running now</span>
      </div>
      {mounted ? (
        <LivefluxProvider client={client}>
          <LiveTable animate={!reduced} />
        </LivefluxProvider>
      ) : (
        // Server / pre-mount: render the deterministic seed so hydration matches exactly.
        <div className="divide-y divide-fd-border" aria-hidden>
          {SEED.map((t) => (
            <div key={t.id} className="flex items-center justify-between px-4 py-2 text-sm">
              <span className="font-medium">{t.symbol}</span>
              <span className="font-mono tabular-nums text-fd-muted-foreground">
                {formatPrice(t.price)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
