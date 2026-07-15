import Link from 'next/link';
import { ArrowRight, Boxes } from 'lucide-react';
import { ScrollToTop } from '@/components/scroll-to-top';
import { CopyButton } from '@/components/copy-button';
import { LiveDemo } from '@/components/live-demo';

// GitHub's mark, inlined — lucide deprecated brand icons, so an inline SVG is the
// reliable way to render it (and it inherits currentColor).
// The brand "signal pulse" mark — same shape as the nav mark in layout.shared.tsx,
// filled with the theme-aware accent var so it reads on both themes.
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

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
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
  runtimePlatform: ['React', 'WebSocket', 'Phoenix Channels'],
  license: 'https://opensource.org/licenses/MIT',
  author: { '@type': 'Person', name: 'Bhavin Devamorari', url: 'https://bpdm.dev' },
  keywords: 'websocket, realtime, streaming state, react, phoenix channels, reconnect, typescript',
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
  { name: '@liveflux/ws', body: 'Generic WebSocket adapter for any plain-WebSocket backend, in any language.' },
  { name: '@liveflux/phoenix', body: 'Phoenix Channels (v2) adapter — joins, rejoin backoff, heartbeat topic.' },
  { name: '@liveflux/react', body: 'React binding — the useStream hook + LivefluxProvider.' },
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
        <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-fd-border px-3 py-1 text-xs font-medium text-fd-muted-foreground">
          <span className="size-1.5 rounded-full" style={{ backgroundColor: 'var(--lf-accent)' }} />
          Realtime streaming state · pre-alpha
        </span>

        <h1 className="text-5xl font-bold tracking-tight sm:text-6xl">Liveflux</h1>

        <p className="mt-5 max-w-2xl text-lg text-fd-muted-foreground">
          Turn a live connection — WebSocket, Phoenix Channels, any push transport — into{' '}
          <strong className="font-semibold text-fd-foreground">typed, reconnect-safe</strong> UI
          state. You describe the channel and how its events fold; Liveflux owns the sockets, cache
          glue, dedup, backpressure, and reconnect logic.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/docs"
            className="inline-flex h-11 items-center gap-2 rounded-lg bg-fd-primary px-6 text-sm font-semibold text-fd-primary-foreground transition-opacity hover:opacity-90"
          >
            Get started
            <ArrowRight className="size-4" />
          </Link>
          <a
            href="https://github.com/liveflux/liveflux"
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-11 items-center gap-2 rounded-lg border border-fd-border px-6 text-sm font-semibold text-fd-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
          >
            <GitHubIcon className="size-4" />
            GitHub
          </a>
        </div>
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
          {['Binding · @liveflux/react', 'Engine · @liveflux/core', 'Adapter · ws / phoenix', 'Your backend'].map(
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

      {/* Packages */}
      <section className="border-t border-fd-border py-16">
        <h2 className="text-center text-2xl font-semibold tracking-tight">Packages</h2>
        <div className="mx-auto mt-8 grid max-w-3xl gap-4 sm:grid-cols-2">
          {PACKAGES.map((p) => (
            <div key={p.name} className="rounded-xl border border-fd-border p-5">
              <code className="text-sm font-semibold" style={{ color: 'var(--lf-accent)' }}>
                {p.name}
              </code>
              <p className="mt-2 text-sm text-fd-muted-foreground">{p.body}</p>
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
          <Link
            href="/docs/getting-started"
            className="inline-flex h-11 items-center gap-2 rounded-lg bg-fd-primary px-6 text-sm font-semibold text-fd-primary-foreground transition-opacity hover:opacity-90"
          >
            Get started
            <ArrowRight className="size-4" />
          </Link>
          <Link
            href="/docs/concepts"
            className="inline-flex h-11 items-center gap-2 rounded-lg border border-fd-border px-6 text-sm font-semibold text-fd-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
          >
            <Boxes className="size-4" />
            Read the concepts
          </Link>
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
            className="inline-flex items-center gap-1.5 transition-colors hover:text-fd-foreground"
          >
            <GitHubIcon className="size-3.5" />
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
