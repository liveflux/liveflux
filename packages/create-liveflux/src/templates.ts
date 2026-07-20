import type { Choice } from './registry';

/** Where the generated files land, per framework + language. */
export function filenames(framework: string, typescript: boolean): { client: string; example: string } {
  const ext = typescript ? 'ts' : 'js';
  const exampleExt = framework === 'react' ? (typescript ? 'tsx' : 'jsx') : ext;
  return {
    client: `src/liveflux.${ext}`,
    example: `src/liveflux-example.${exampleExt}`,
  };
}

/** The shared client module: one client for the whole app, over the chosen adapter. */
export function clientModule(adapter: Choice, typescript: boolean): string {
  const factory = adapter.importName ?? adapter.id;
  const pkg = adapter.pkg ?? '@liveflux/ws';
  const file = typescript ? 'liveflux.ts' : 'liveflux.js';
  return `// ${file} — one client for the whole app, over your realtime backend.
import { LivefluxClient } from '@liveflux/core';
import { ${factory} } from '${pkg}';

// Point this at your backend's realtime endpoint.
const ENDPOINT = 'wss://example.com/socket';

export const client = new LivefluxClient({
  adapter: ${factory}(ENDPOINT),
});

client.connect();
`;
}

const REACT_TS = `// liveflux-example.tsx — subscribe to a channel and fold its events into state.
import { LivefluxProvider, useStream } from '@liveflux/react';
import { client } from './liveflux';

type Trade = { id: number; symbol: string; price: number };

function Trades() {
  // upsert -> Trade[]: a matching id updates in place, a new id is appended (capped at 50).
  const trades = useStream<Trade>({
    channel: 'trades',
    into: { strategy: 'upsert', key: 'id', cap: 50 },
  });

  return (
    <ul>
      {trades.map((t) => (
        <li key={t.id}>
          {t.symbol}: {t.price}
        </li>
      ))}
    </ul>
  );
}

// Wrap your app once, near the root, so every component shares one connection.
export function Example() {
  return (
    <LivefluxProvider client={client}>
      <Trades />
    </LivefluxProvider>
  );
}
`;

const REACT_JS = `// liveflux-example.jsx — subscribe to a channel and fold its events into state.
import { LivefluxProvider, useStream } from '@liveflux/react';
import { client } from './liveflux';

function Trades() {
  // upsert -> array: a matching id updates in place, a new id is appended (capped at 50).
  const trades = useStream({
    channel: 'trades',
    into: { strategy: 'upsert', key: 'id', cap: 50 },
  });

  return (
    <ul>
      {trades.map((t) => (
        <li key={t.id}>
          {t.symbol}: {t.price}
        </li>
      ))}
    </ul>
  );
}

// Wrap your app once, near the root, so every component shares one connection.
export function Example() {
  return (
    <LivefluxProvider client={client}>
      <Trades />
    </LivefluxProvider>
  );
}
`;

const VANILLA_TS = `// liveflux-example.ts — fold a channel's events into state and react to updates.
import { client } from './liveflux';

type Trade = { id: number; symbol: string; price: number };

const trades = client.subscribe<Trade>({
  channel: 'trades',
  into: { strategy: 'upsert', key: 'id', cap: 50 },
});

// getState() is the current folded value; subscribe() fires on every change.
const off = trades.subscribe(() => {
  console.log(trades.getState());
});

// When you're done: off(); trades.destroy();
`;

const VANILLA_JS = `// liveflux-example.js — fold a channel's events into state and react to updates.
import { client } from './liveflux';

const trades = client.subscribe({
  channel: 'trades',
  into: { strategy: 'upsert', key: 'id', cap: 50 },
});

// getState() is the current folded value; subscribe() fires on every change.
const off = trades.subscribe(() => {
  console.log(trades.getState());
});

// When you're done: off(); trades.destroy();
`;

/** A ready-to-adapt usage example for the chosen framework + language. */
export function exampleModule(framework: string, _adapter: Choice, typescript: boolean): string {
  if (framework === 'react') return typescript ? REACT_TS : REACT_JS;
  return typescript ? VANILLA_TS : VANILLA_JS;
}
