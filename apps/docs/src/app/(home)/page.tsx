import Link from 'next/link';
import { ArrowRight, Boxes } from 'lucide-react';
// Dogfooding our own @bpdm/ui — themed to Liveflux blue via the token bridge in global.css.
import { Button } from '@bpdm/ui/button';
import { Badge } from '@bpdm/ui/badge';
import { ScrollToTop } from '@/components/scroll-to-top';
import { CopyButton } from '@/components/copy-button';
import { LiveDemo } from '@/components/live-demo';

// The brand "signal pulse" mark — same shape as the nav mark, filled with the
// theme-aware accent var so it reads on both themes.
function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <rect width="32" height="32" rx="8" fill="var(--lf-accent)" />
      <path
        d="M6 16 h5 l3 -7 4 14 3 -7 h5"
        fill="none"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// SoftwareSourceCode structured data — helps search engines surface Liveflux as
// an open-source library. Every field is accurate to the (pre-alpha) project;
// no ratings, downloads, or other fabricated signals.
const JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareSourceCode',
  name: 'Liveflux',
  description:
    'Typed, reconnect-safe realtime streaming state for the frontend — protocol-agnostic via adapters, framework-agnostic via bindings.',
  url: 'https://liveflux.bpdm.dev',
  codeRepository: 'https://github.com/liveflux/liveflux',
  programmingLanguage: 'TypeScript',
  runtimePlatform: [
    'React',
    'WebSocket',
    'Server-Sent Events',
    'Socket.IO',
    'graphql-transport-ws',
    'Phoenix Channels',
  ],
  license: 'https://opensource.org/licenses/MIT',
  author: { '@type': 'Person', name: 'Bhavin Devamorari', url: 'https://bpdm.dev' },
  keywords:
    'websocket, sse, server-sent events, socket.io, graphql-ws, phoenix channels, realtime, streaming state, react, reconnect, typescript',
};

const APP_SNIPPET = `import { useStream } from '@liveflux/react';

type Trade = { id: number; symbol: string; price: number };

export function Trades() {
  // upsert → Trade[]: a matching id updates in place, a new id is appended.
  const trades = useStream<Trade>({
    channel: 'trades',
    into: { strategy: 'upsert', key: 'id', cap: 50 },
  });

  return trades.map((t) => <Row key={t.id} symbol={t.symbol} price={t.price} />);
}`;

const HANDLES: { title: string; body: string }[] = [
  {
    title: 'Reconnect-safe',
    body: 'On an unexpected close it backs off with jitter and replays every active subscription on the new connection — streams resume on their own.',
  },
  {
    title: 'One multiplexed connection',
    body: 'Many subscriptions share a single socket. Identical subscriptions fold once, ref-counted, and release only when the last subscriber leaves.',
  },
  {
    title: 'Cache-shaped state',
    body: 'Fold raw events into the shape your UI renders — append (log), upsert (keyed list), replace (latest), or your own reducer.',
  },
  {
    title: 'Backpressure',
    body: 'Adapters watch the send buffer and queue control frames past a high-water mark; oversized inbound frames are dropped before decoding.',
  },
  {
    title: 'Tear-free React',
    body: 'Reads go through useSyncExternalStore, so state is consistent under concurrent rendering. Pass a selector to re-render only on the slice you use.',
  },
  {
    title: 'Typed end-to-end',
    body: 'Generics flow from the channel through the fold strategy to the value your component receives — the return type follows the strategy.',
  },
];

const PACKAGES: { name: string; body: string }[] = [
  { name: '@liveflux/core', body: 'Framework-agnostic engine — connection, subscriptions, store, backpressure.' },
  { name: '@liveflux/react', body: 'React binding — the useStream hook + LivefluxProvider.' },
];

// The 5 transport adapters — one engine, swappable backends. `transport` is the
// human-recognizable name; `pkg` the package that normalizes it into a stream.
const ADAPTERS: { transport: string; pkg: string; body: string }[] = [
  { transport: 'WebSocket', pkg: '@liveflux/ws', body: 'Any plain-WebSocket backend, in any language.' },
  { transport: 'Server-Sent Events', pkg: '@liveflux/sse', body: 'An EventSource stream with reconnect and cursor resume.' },
  { transport: 'Socket.IO', pkg: '@liveflux/socketio', body: 'Wraps an existing Socket.IO client into a normalized stream.' },
  { transport: 'GraphQL over WebSocket', pkg: '@liveflux/graphql-ws', body: 'graphql-transport-ws subscriptions, zero-dependency.' },
  { transport: 'Phoenix Channels', pkg: '@liveflux/phoenix', body: 'Phoenix Channels v2 — joins, rejoin backoff, heartbeat topic.' },
];

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />
      {/* Hero */}
      <section className="flex flex-col items-center py-20 text-center sm:py-28">
        {/* dogfood: @bpdm/ui Badge — its dot+pulse is the live "signal" indicator, on-brand
            for a realtime library. variant=primary tints the pulse blue; the pill itself keeps
            the muted eyebrow look via Fumadocs' theme-aware border/text tokens. */}
        <Badge
          variant="primary"
          appearance="outline"
          dot
          pulse
          className="mb-5 border-fd-border text-fd-muted-foreground"
        >
          Realtime streaming state · pre-alpha
        </Badge>

        <h1 className="text-5xl font-bold tracking-tight sm:text-6xl">Liveflux</h1>

        <p className="mt-5 max-w-2xl text-lg text-fd-muted-foreground">
          Turn a live connection — WebSocket, SSE, Socket.IO, Phoenix Channels, any push transport — into{' '}
          <strong className="font-semibold text-fd-foreground">typed, reconnect-safe</strong> UI
          state. You describe the channel and how its events fold; Liveflux owns the sockets, cache
          glue, dedup, backpressure, and reconnect logic.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          {/* dogfood: @bpdm/ui Button (primary, blue via bridge) */}
          <Button asChild variant="primary" size="lg" className="font-semibold">
            <Link href="/docs">
              Get started
              <ArrowRight className="size-4" />
            </Link>
          </Button>
          {/* repo is public — GitHub CTA (dogfood: @bpdm/ui Button, outline) */}
          <Button
            asChild
            appearance="outline"
            size="lg"
            className="border-fd-border font-semibold text-fd-foreground hover:bg-fd-accent hover:text-fd-accent-foreground"
          >
            <a href="https://github.com/liveflux/liveflux" target="_blank" rel="noreferrer">
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-4">
                <path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.2 3.44 9.6 8.2 11.16.6.1.82-.25.82-.56v-2c-3.34.72-4.04-1.6-4.04-1.6-.55-1.36-1.33-1.73-1.33-1.73-1.09-.73.08-.72.08-.72 1.2.08 1.83 1.22 1.83 1.22 1.07 1.8 2.8 1.28 3.49.98.1-.76.42-1.28.76-1.57-2.67-.3-5.47-1.31-5.47-5.84 0-1.29.47-2.35 1.24-3.18-.13-.3-.54-1.51.11-3.15 0 0 1.01-.32 3.3 1.21a11.6 11.6 0 016 0c2.29-1.53 3.3-1.21 3.3-1.21.65 1.64.24 2.85.11 3.15.77.83 1.24 1.89 1.24 3.18 0 4.54-2.81 5.54-5.48 5.83.43.37.81 1.1.81 2.22v3.29c0 .32.21.68.82.56A12.01 12.01 0 0024 12.29C24 5.78 18.63.5 12 .5z" />
              </svg>
              GitHub
            </a>
          </Button>
        </div>

        <div className="mt-5 flex justify-center">
          <div className="inline-flex items-center gap-3 rounded-lg border border-fd-border bg-fd-card px-4 py-2 font-mono text-sm">
            <span className="select-none text-fd-muted-foreground">$</span>
            <span>pnpm create liveflux@latest</span>
            <CopyButton text="pnpm create liveflux@latest" />
          </div>
        </div>
        <p className="mt-2 text-center text-xs text-fd-muted-foreground">
          Scaffolds the client and installs the packages for your framework and transport.
        </p>
      </section>

      {/* The punchline: the code AND its running result, side by side */}
      <section className="pb-20">
        <p className="mb-4 text-center text-sm font-medium text-fd-muted-foreground">
          A live, keyed list of trades — the whole component, and it running:
        </p>
        <div className="grid items-start gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div className="overflow-hidden rounded-xl border border-fd-border bg-fd-card">
            <div className="flex items-center gap-1.5 border-b border-fd-border px-4 py-2.5">
              <span className="size-2.5 rounded-full bg-fd-border" />
              <span className="size-2.5 rounded-full bg-fd-border" />
              <span className="size-2.5 rounded-full bg-fd-border" />
              <span className="ml-2 text-xs text-fd-muted-foreground">Trades.tsx</span>
              <CopyButton text={APP_SNIPPET} className="ml-auto" />
            </div>
            <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed">
              <code>{APP_SNIPPET}</code>
            </pre>
          </div>
          <LiveDemo />
        </div>
        <p className="mt-4 text-center text-sm text-fd-muted-foreground">
          The wire subscription is multiplexed onto one connection, deduped, and re-sent after a
          reconnect — none of which you wrote.
        </p>
      </section>

      {/* What it handles for you */}
      <section className="border-t border-fd-border py-16">
        <h2 className="text-center text-2xl font-semibold tracking-tight">
          The realtime plumbing it owns
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-fd-muted-foreground">
          A realtime feature looks small until you ship it. Liveflux is the layer that owns the
          parts you&apos;d otherwise hand-roll every time — behind a small typed surface.
        </p>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {HANDLES.map((f) => (
            <div key={f.title} className="rounded-xl border border-fd-border p-5">
              <h3 className="flex items-center gap-2 font-semibold">
                <span
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: 'var(--lf-accent)' }}
                />
                {f.title}
              </h3>
              <p className="mt-2 text-sm text-fd-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Architecture */}
      <section className="border-t border-fd-border py-16">
        <h2 className="text-center text-2xl font-semibold tracking-tight">
          Protocol- and framework-agnostic
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-fd-muted-foreground">
          One engine, swappable transports, per-framework bindings. Point it at a new backend by
          changing the adapter; the components don&apos;t move.
        </p>
        <div className="mx-auto mt-8 flex max-w-3xl flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-center">
          {['Binding · @liveflux/react', 'Engine · @liveflux/core', 'Adapter · one of 5', 'Your backend'].map(
            (node, i) => (
              <div key={node} className="flex items-center gap-3 sm:contents">
                <div className="flex-1 rounded-lg border border-fd-border px-4 py-3 text-center text-sm font-medium">
                  {node}
                </div>
                {i < 3 && (
                  <span className="hidden text-fd-muted-foreground sm:inline" aria-hidden>
                    →
                  </span>
                )}
              </div>
            ),
          )}
        </div>
      </section>

      {/* Core packages */}
      <section className="border-t border-fd-border py-16">
        <h2 className="text-center text-2xl font-semibold tracking-tight">Core packages</h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-fd-muted-foreground">
          The engine and the React binding — the two you always install. Add one adapter for your
          transport and you&apos;re set.
        </p>
        <div className="mx-auto mt-8 grid max-w-2xl gap-4 sm:grid-cols-2">
          {PACKAGES.map((p) => (
            <div
              key={p.name}
              className="rounded-xl border border-fd-border bg-fd-card p-5 transition-colors hover:border-[color:var(--lf-accent)]"
            >
              <code className="text-sm font-semibold" style={{ color: 'var(--lf-accent)' }}>
                {p.name}
              </code>
              <p className="mt-2 text-sm text-fd-muted-foreground">{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Adapters */}
      <section className="border-t border-fd-border py-16">
        <h2 className="text-center text-2xl font-semibold tracking-tight">
          One core, five transports
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-fd-muted-foreground">
          Each adapter normalizes a different backend into the same stream. Same components, same{' '}
          <code>useStream</code> — you only swap the adapter.
        </p>
        <div className="mx-auto mt-10 grid max-w-4xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ADAPTERS.map((a, i) => (
            <div
              key={a.pkg}
              className="rounded-xl border border-fd-border bg-fd-card p-5 transition-colors hover:border-[color:var(--lf-accent)]"
            >
              <div className="flex items-center gap-2.5">
                <span
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-xs font-bold"
                  style={{
                    background: 'color-mix(in srgb, var(--lf-accent) 15%, transparent)',
                    color: 'var(--lf-accent)',
                  }}
                  aria-hidden
                >
                  {i + 1}
                </span>
                <h3 className="font-semibold leading-tight">{a.transport}</h3>
              </div>
              <code
                className="mt-3 inline-block text-xs font-semibold"
                style={{ color: 'var(--lf-accent)' }}
              >
                {a.pkg}
              </code>
              <p className="mt-2 text-sm text-fd-muted-foreground">{a.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="border-t border-fd-border py-20 text-center">
        <h2 className="text-2xl font-semibold tracking-tight">Wire up your first stream</h2>
        <p className="mx-auto mt-3 max-w-xl text-fd-muted-foreground">
          Install three packages, drop in a provider, and call <code>useStream</code>. It&apos;s
          about a dozen lines.
        </p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          {/* dogfood: @bpdm/ui Button (primary blue via bridge) */}
          <Button asChild variant="primary" size="lg" className="font-semibold">
            <Link href="/docs/getting-started">
              Get started
              <ArrowRight className="size-4" />
            </Link>
          </Button>
          {/* dogfood: @bpdm/ui Button, outline. bpdm's colored-text uses `-strong` tokens which
              don't resolve in this Fumadocs stack, so the border/text/hover use Fumadocs' own
              theme-aware tokens (matching the site) while keeping the Button's shape + press. */}
          <Button
            asChild
            appearance="outline"
            size="lg"
            className="border-fd-border font-semibold text-fd-foreground hover:bg-fd-accent hover:text-fd-accent-foreground"
          >
            <Link href="/docs/concepts">
              <Boxes className="size-4" />
              Read the concepts
            </Link>
          </Button>
        </div>
      </section>

      <SiteFooter />

      <ScrollToTop />
    </main>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t border-fd-border py-10 text-sm text-fd-muted-foreground">
      <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-xs">
          <div className="flex items-center gap-2">
            <BrandMark className="size-6" />
            <span className="font-semibold text-fd-foreground">Liveflux</span>
          </div>
          <p className="mt-3 leading-relaxed">
            Typed, reconnect-safe realtime streaming state for the frontend.
          </p>
          <p className="mt-2 text-xs">MIT licensed.</p>
        </div>

        <nav aria-label="Footer" className="flex flex-col gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-fd-foreground">
            Documentation
          </span>
          <Link href="/docs" className="transition-colors hover:text-fd-foreground">
            Docs
          </Link>
          <Link href="/docs/getting-started" className="transition-colors hover:text-fd-foreground">
            Getting Started
          </Link>
          <Link href="/docs/concepts" className="transition-colors hover:text-fd-foreground">
            Concepts
          </Link>
          <a
            href="https://github.com/liveflux/liveflux"
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-fd-foreground"
          >
            GitHub
          </a>
        </nav>
      </div>

      <div className="mt-8 border-t border-fd-border pt-6 text-xs">
        Built by{' '}
        <a
          href="https://bpdm.dev"
          target="_blank"
          rel="noreferrer"
          aria-label="BPDM — Bhavin Devamorari"
          className="font-mono font-semibold underline-offset-4 hover:underline"
          style={{ color: 'var(--bpdm-brand)' }}
        >
          &lt;BPDM/&gt;
        </a>
      </div>
    </footer>
  );
}
