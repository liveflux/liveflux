import type { NormalizedEvent, SubscribeRequest } from '@liveflux/core';
import { type AdapterHarness, runAdapterConformance } from '@liveflux/adapter-tests';
import { graphqlWs, type GraphqlWsOptions } from './index';

interface SubscribeFrame {
  id: string;
  type: 'subscribe';
  payload: { query: string; variables?: Record<string, unknown>; operationName?: string };
}

/**
 * A controllable WebSocket double that also plays a minimal graphql-transport-ws server: it
 * auto-answers `connection_init` with `connection_ack` (so the adapter can reach onOpen), and lets a
 * test push `next` / drop / error frames. One instance per (re)connect; `instances` records the full
 * history so the harness sees every frame the adapter sent across reconnects.
 */
class FakeSocket {
  readyState = 0; // CONNECTING
  sent: unknown[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(readonly instances: FakeSocket[]) {
    instances.push(this);
  }
  send(data: string): void {
    const msg = JSON.parse(data);
    this.sent.push(msg);
    if (msg.type === 'connection_init') {
      // the server accepts the connection
      this.onmessage?.({ data: JSON.stringify({ type: 'connection_ack' }) });
    }
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  serverSend(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(reason?: unknown): void {
    this.readyState = 3;
    this.onclose?.(reason);
  }
}

runAdapterConformance({
  name: '@liveflux/graphql-ws',
  setup(): AdapterHarness {
    const instances: FakeSocket[] = [];
    const Ctor = class extends FakeSocket {
      constructor() {
        super(instances);
      }
    } as unknown as GraphqlWsOptions['WebSocket'];

    // passthrough decode: the `next` payload IS the normalized event, so onEvent === the emitted
    // event (channel/event/payload/cursor/meta preserved) — the suite's contract.
    const adapter = graphqlWs('wss://conformance.test/graphql', {
      WebSocket: Ctor,
      decode: (payload) => payload as NormalizedEvent,
    });
    const latest = () => instances[instances.length - 1]!;
    const allSubscribes = (): SubscribeFrame[] =>
      instances.flatMap((s) => s.sent).filter((m): m is SubscribeFrame => (m as { type?: string }).type === 'subscribe');

    return {
      adapter,
      open: () => latest().open(),
      // route a server `next` to the subscription whose document (query) matches the event's channel
      emit: (event: NormalizedEvent) => {
        const frame = [...allSubscribes()].reverse().find((f) => f.payload.query === event.channel);
        latest().serverSend({ id: frame?.id, type: 'next', payload: event });
      },
      drop: (reason) => latest().drop(reason),
      fail: (err) => latest().onerror?.(err),
      sentSubscribes: (): SubscribeRequest[] =>
        allSubscribes().map((f) => ({
          subId: f.id,
          channel: f.payload.query,
          ...(f.payload.variables !== undefined ? { params: f.payload.variables } : {}),
        })),
      sentUnsubscribes: (): string[] =>
        instances
          .flatMap((s) => s.sent)
          .filter((m): m is { id: string; type: 'complete' } => (m as { type?: string }).type === 'complete')
          .map((m) => m.id),
      // No resume capability (graphql-transport-ws has none) and no app-level keepalive frame
      // (ping is server-initiated, answered with pong) — those optional scenarios are skipped.
    };
  },
});
