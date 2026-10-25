import type {
  NormalizedEvent,
  PublishRequest,
  ReplyFrame,
  RequestFrame,
  SubscribeRequest,
} from '@liveflux/core';
import { type AdapterHarness, runAdapterConformance } from '@liveflux/adapter-tests';
import { graphqlWs, type GraphqlWsOptions } from './index';

interface SubscribeFrame {
  id: string;
  type: 'subscribe';
  payload: { query: string; variables?: Record<string, unknown>; operationName?: string };
}

/**
 * A command (publish / request) rides the same `subscribe` message as a subscription; the default
 * `command` mapper marks it by putting `event` in the variables (the mutation's args). Publishes use
 * an adapter-minted `cmd-*` id; requests use the Liveflux requestId.
 */
function isCommandFrame(m: SubscribeFrame): boolean {
  return m.type === 'subscribe' && m.payload.variables !== undefined && 'event' in m.payload.variables;
}

/** Decode a command frame's `{ query, variables }` back to its transport-neutral command fields. */
function decodeCommand(m: SubscribeFrame): {
  channel: string;
  event: string;
  payload: unknown;
  meta?: Record<string, unknown>;
} {
  const v = m.payload.variables as { event: string; payload: unknown; meta?: Record<string, unknown> };
  return {
    channel: m.payload.query,
    event: v.event,
    payload: v.payload,
    ...(v.meta !== undefined ? { meta: v.meta } : {}),
  };
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
    const allSubscribeMessages = (): SubscribeFrame[] =>
      instances.flatMap((s) => s.sent).filter((m): m is SubscribeFrame => (m as { type?: string }).type === 'subscribe');
    // Real subscriptions only — commands (publish / request) share the `subscribe` message but are
    // filtered out so they never masquerade as subscriptions.
    const allSubscribes = (): SubscribeFrame[] => allSubscribeMessages().filter((m) => !isCommandFrame(m));
    const allCommands = (): SubscribeFrame[] => allSubscribeMessages().filter(isCommandFrame);

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
      sentPublishes: (): PublishRequest[] =>
        allCommands()
          .filter((m) => m.id.startsWith('cmd-'))
          .map(decodeCommand),
      sentRequests: (): RequestFrame[] =>
        allCommands()
          .filter((m) => !m.id.startsWith('cmd-'))
          .map((m) => ({ requestId: m.id, ...decodeCommand(m) })),
      // Play the server: a mutation's single `next` result IS the reply, then `complete` ends it.
      deliverReply: (reply: ReplyFrame) => {
        latest().serverSend({
          id: reply.requestId,
          type: 'next',
          payload: reply.ok ? { data: reply.payload } : { errors: reply.error },
        });
        latest().serverSend({ id: reply.requestId, type: 'complete' });
      },
      // No resume capability (graphql-transport-ws has none) and no app-level keepalive frame
      // (ping is server-initiated, answered with pong) — those optional scenarios are skipped.
    };
  },
});
