import { useState, type ReactNode } from 'react';
import { useConnection, useStream } from '@liveflux/react';
import { CHANNEL, WS_URL } from './config';

type Trade = { id: number; symbol: string; price: number; at: string };
type Strategy = 'append' | 'upsert' | 'replace' | 'reducer';

function StatusPill({ status }: { status: string }) {
  return (
    <span className="pill" data-status={status}>
      <span className="dot" />
      {status}
    </span>
  );
}

/**
 * Force the live connection closed to showcase reconnect-safety. There is no client-side "kick"
 * API (by design — the client owns its socket), so we simulate an *external* network drop the
 * honest way: open a throwaway control socket, ask the mock server to close every other client,
 * then discard it. The Liveflux client sees an unexpected close and reconnects + replays its
 * subscription on its own. Playground-only glue — nothing here ships in the library.
 */
function simulateDrop(): void {
  const control = new WebSocket(WS_URL);
  control.onopen = () => {
    control.send(JSON.stringify({ type: 'drop' }));
    control.close();
  };
}

/* ── connection: the headline reconnect-safety feature ───────────────────── */
function ConnectionPanel() {
  const state = useConnection();
  return (
    <section className="conn">
      <div className="conn-bar">
        <StatusPill status={state} />
        <button className="btn-drop" type="button" onClick={simulateDrop}>
          Simulate connection drop
        </button>
      </div>
      <p className="conn-note">
        <b>Reconnect-safety</b> is the headline feature. Hit <b>Simulate connection drop</b> to force the
        socket closed: the client detects the drop, backs off, reconnects automatically, and{' '}
        <b>replays the active subscription</b> — the stream resumes on its own, no code from you. Watch the
        status go <b>open → reconnecting → open</b> and the feed pick right back up.
      </p>
    </section>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <div className="note">{children}</div>;
}

function Badge({ symbol }: { symbol: string }) {
  return (
    <span className="badge" data-sym={symbol}>
      {symbol}
    </span>
  );
}

/* ── append: an ever-growing log ─────────────────────────────────────────── */
function AppendDemo() {
  const feed = useStream<Trade>({ channel: CHANNEL, into: { strategy: 'append', cap: 20 } });
  return (
    <>
      <Note>
        <b>append</b> — every event is added as a <b>new entry</b>; it never updates or replaces an
        existing one (that's the difference from <code>upsert</code>). The list keeps the full arrival
        order — shown here <b>newest-first</b>, capped at 20. Heads-up: the mock server cycles ids 1–8,
        so the same id shows up repeatedly — in <code>append</code> each occurrence is its own separate
        entry (that's why the top keeps changing: new entries arriving, not rows reordering). Great for
        <b> logs, chat, activity feeds</b>. Returns <code>T[]</code>.
      </Note>
      <section className="feed">
        <div className="feed-head">
          <span>Event log · newest first</span>
          <span className="live">
            <span className="dot" /> live
          </span>
        </div>
        <div className="feed-scroll">
          {feed.length === 0 ? (
            <div className="row-empty">Waiting for events…</div>
          ) : (
            [...feed].reverse().map((t, i) => (
              // append is a log (ids repeat) → positional key is fine here
              <div className="row" key={feed.length - i}>
                <span className="row-id">#{t.id}</span>
                <Badge symbol={t.symbol} />
                <span className="price">{t.price.toFixed(2)}</span>
                <span className="row-id">{t.at}</span>
              </div>
            ))
          )}
        </div>
      </section>
    </>
  );
}

/* ── upsert: a keyed list that updates in place ──────────────────────────── */
function UpsertDemo() {
  const trades = useStream<Trade>({
    channel: CHANNEL,
    into: { strategy: 'upsert', key: 'id', cap: 8 },
  });
  return (
    <>
      <Note>
        <b>upsert</b> — events are merged into a keyed list: a matching <code>key</code> updates that row
        in place, a new key is inserted (capped at 8). Use it for <b>live entity lists</b> — orders,
        prices by symbol, users — anything with a stable id that changes over time. Returned value:{' '}
        <code>T[]</code>.
      </Note>
      <section className="feed">
        <div className="feed-head">
          <span>Live rows · keyed by id</span>
          <span className="live">
            <span className="dot" /> live
          </span>
        </div>
        {trades.length === 0 ? (
          <div className="row-empty">Waiting for events…</div>
        ) : (
          trades.map((t) => (
            <div className="row" key={t.id}>
              <span className="row-id">#{t.id}</span>
              <Badge symbol={t.symbol} />
              {/* keyed by price → re-mounts on change → flash animation replays */}
              <span className="price flash" key={t.price}>
                {t.price.toFixed(2)}
              </span>
              <span className="row-id">{t.at}</span>
            </div>
          ))
        )}
      </section>
    </>
  );
}

/* ── replace: only the latest value ──────────────────────────────────────── */
function ReplaceDemo() {
  const latest = useStream<Trade>({ channel: CHANNEL, into: { strategy: 'replace' } });
  return (
    <>
      <Note>
        <b>replace</b> — only the most recent event is kept: a single value, not a list. Use it for
        <b> "current" state</b> — the latest price, a live status, a gauge — where only the newest value
        matters. Returned value: <code>T | undefined</code>.
      </Note>
      {!latest ? (
        <div className="row-empty">Waiting for the first event…</div>
      ) : (
        <div className="latest">
          <div className="sym">
            <Badge symbol={latest.symbol} />
          </div>
          {/* keyed by price → flash on each new value */}
          <div className="big flash" key={latest.price}>
            {latest.price.toFixed(2)}
          </div>
          <div className="at">
            #{latest.id} · {latest.at}
          </div>
        </div>
      )}
    </>
  );
}

/* ── reducer: custom fold into aggregate state ───────────────────────────── */
type Tally = { count: number; bySymbol: Record<string, number> };

function ReducerDemo() {
  const stats = useStream<Trade, Tally>({
    channel: CHANNEL,
    into: {
      strategy: 'reducer',
      reduce: (acc, e) => {
        const sym = (e.payload as Trade).symbol;
        return { count: acc.count + 1, bySymbol: { ...acc.bySymbol, [sym]: (acc.bySymbol[sym] ?? 0) + 1 } };
      },
      initial: { count: 0, bySymbol: {} },
    },
  });
  return (
    <>
      <Note>
        <b>reducer</b> — each event is folded into state with your own function (like{' '}
        <code>Array.reduce</code>). Use it for <b>derived / aggregate state</b> — counters, running
        totals, per-group tallies — anything the built-in strategies don't cover. Returned value:{' '}
        <code>S</code> (here a tally object).
      </Note>
      <div className="stats">
        <div className="stat">
          <div className="stat-label">Total events</div>
          <div className="stat-value">{stats.count.toLocaleString()}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Distinct symbols</div>
          <div className="stat-value">{Object.keys(stats.bySymbol).length}</div>
        </div>
      </div>
      <section className="feed">
        <div className="feed-head">
          <span>Events per symbol (custom fold)</span>
        </div>
        <div className="tally">
          {Object.keys(stats.bySymbol).length === 0 ? (
            <span className="row-id">Waiting for events…</span>
          ) : (
            Object.entries(stats.bySymbol).map(([sym, n]) => (
              <span className="tally-item" key={sym}>
                <Badge symbol={sym} /> <b>{n}</b>
              </span>
            ))
          )}
        </div>
      </section>
    </>
  );
}

const TABS: { id: Strategy; label: string }[] = [
  { id: 'append', label: 'append' },
  { id: 'upsert', label: 'upsert' },
  { id: 'replace', label: 'replace' },
  { id: 'reducer', label: 'reducer' },
];

export function App() {
  const [tab, setTab] = useState<Strategy>('upsert');

  return (
    <div className="app">
      <header className="header">
        <div className="logo">L</div>
        <div style={{ flex: 1 }}>
          <h1 className="title">Liveflux Playground</h1>
          <p className="subtitle">One connection · four fold strategies · live from the source packages</p>
        </div>
      </header>

      <ConnectionPanel />

      <div className="hint">
        Each tab subscribes to the same <code>trades</code> channel but folds events a different way. Switch
        tabs → the old subscription tears down and the new one starts (watch the connection stay{' '}
        <b>open</b> — only the channel subscription changes). Edit <code>packages/*/src</code> → HMR.
      </div>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'append' && <AppendDemo />}
      {tab === 'upsert' && <UpsertDemo />}
      {tab === 'replace' && <ReplaceDemo />}
      {tab === 'reducer' && <ReducerDemo />}

      <p className="footer">
        one connection · multiplexed · <code>@liveflux/ws</code> → <code>@liveflux/core</code> →{' '}
        <code>@liveflux/react</code>
      </p>
    </div>
  );
}
