import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LivefluxClient } from '@liveflux/core';
import { ws } from '@liveflux/ws';
import { LivefluxProvider, useConnection, useStream } from '@liveflux/react';
import { WsClientCtor } from '../support/node-ws';
import { WsControlServer } from '../support/ws-server';

/**
 * Cross-package "dashboard" smoke — every layer wired together and exercised the way an app would:
 * a `LivefluxProvider` over a real `@liveflux/ws` client + server, two `useStream` panels on
 * different channels, and a `useConnection` status pill. Events are driven from the server and the
 * DOM is asserted; then the socket is dropped and the whole dashboard is checked for recovery.
 */

interface Order {
  id: number;
}
interface Trade {
  symbol: string;
}

function Orders() {
  const orders = useStream<Order>({ channel: 'orders', into: { strategy: 'append' } });
  return (
    <ul data-testid="orders">
      {orders.map((o) => (
        <li key={o.id}>order {o.id}</li>
      ))}
    </ul>
  );
}

function Trades() {
  const trades = useStream<Trade>({ channel: 'trades', into: { strategy: 'append' } });
  return (
    <ul data-testid="trades">
      {trades.map((t, i) => (
        <li key={i}>trade {t.symbol}</li>
      ))}
    </ul>
  );
}

function Status() {
  const state = useConnection();
  return <span data-testid="status">{state}</span>;
}

let server: WsControlServer;
let client: LivefluxClient;

afterEach(async () => {
  cleanup();
  client.destroy();
  await server.close();
});

describe('dashboard · two streams + a connection pill over a real ws server', () => {
  it('renders live events on both channels and recovers after a drop', async () => {
    server = await WsControlServer.start();
    const adapter = ws(server.url(), { WebSocket: WsClientCtor });
    client = new LivefluxClient({ adapter, reconnect: { baseMs: 20, jitter: 0 } });
    client.connect();

    render(
      <LivefluxProvider client={client}>
        <Status />
        <Orders />
        <Trades />
      </LivefluxProvider>,
    );

    // Connection comes up.
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('open'));
    // Both channels must be subscribed before we broadcast.
    await waitFor(() => expect(server.latest?.subs.size).toBe(2));

    server.broadcast('orders', 'created', { id: 1 });
    server.broadcast('trades', 'exec', { symbol: 'ACME' });
    await screen.findByText('order 1');
    await screen.findByText('trade ACME');

    // Abrupt server-side drop → the pill flips away from open, then recovers.
    server.dropAll();
    await waitFor(() => expect(server.connections.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('open'));
    // Both channels were re-subscribed on the fresh connection.
    await waitFor(() => expect(server.latest?.subs.size).toBe(2));

    // Live again: a new order streams straight into the same panel.
    server.broadcast('orders', 'created', { id: 2 });
    await screen.findByText('order 2');
    expect(screen.getByText('order 1')).toBeDefined();
  });
});
