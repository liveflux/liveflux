import { describe, expect, it } from 'vitest';
import type { AdapterHandlers, NormalizedEvent } from '@liveflux/core';
import { graphqlWs, type GraphqlWsOptions } from './index';

interface WireMessage {
  type?: string;
  id?: string;
  payload?: unknown;
}

class FakeSocket {
  readyState = 0;
  sent: WireMessage[] = [];
  autoAck = true;
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
    if (this.autoAck && msg.type === 'connection_init') {
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
}

function recorder(): AdapterHandlers & {
  opens: number;
  closes: number;
  errors: unknown[];
  events: NormalizedEvent[];
  replies: unknown[];
} {
  const rec = {
    opens: 0,
    closes: 0,
    errors: [] as unknown[],
    events: [] as NormalizedEvent[],
    replies: [] as unknown[],
    onOpen() {
      rec.opens += 1;
    },
    onClose() {
      rec.closes += 1;
    },
    onError(e: unknown) {
      rec.errors.push(e);
    },
    onEvent(ev: NormalizedEvent) {
      rec.events.push(ev);
    },
    onReply(reply: unknown) {
      rec.replies.push(reply);
    },
  };
  return rec;
}

function harness(opts: Partial<GraphqlWsOptions> = {}) {
  const instances: FakeSocket[] = [];
  const Ctor = class extends FakeSocket {
    constructor() {
      super(instances);
    }
  } as unknown as GraphqlWsOptions['WebSocket'];
  const adapter = graphqlWs('wss://x.test/graphql', { WebSocket: Ctor, ...opts });
  const rec = recorder();
  adapter.connect(rec);
  return { adapter, rec, instances, latest: () => instances[instances.length - 1]! };
}

describe('@liveflux/graphql-ws', () => {
  it('opens with the graphql-transport-ws subprotocol', () => {
    const instances: FakeSocket[] = [];
    let protocol: unknown;
    const Ctor = class extends FakeSocket {
      constructor(_url: string, p?: string | string[]) {
        super(instances);
        protocol = p;
      }
    } as unknown as GraphqlWsOptions['WebSocket'];
    graphqlWs('wss://x.test/graphql', { WebSocket: Ctor }).connect(recorder());
    expect(protocol).toBe('graphql-transport-ws');
  });

  it('defers onOpen until connection_ack (init handshake)', () => {
    const h = harness({});
    h.latest().autoAck = false; // withhold the ack
    h.latest().open();
    expect(h.latest().sent[0]).toEqual({ type: 'connection_init' }); // init sent on socket open
    expect(h.rec.opens).toBe(0); // not open until the server acks
    h.latest().serverSend({ type: 'connection_ack' });
    expect(h.rec.opens).toBe(1);
  });

  it('maps channel→document and params→variables by default, only after ack', () => {
    const h = harness({});
    h.adapter.subscribe({ subId: 's1', channel: 'subscription { trades { id } }', params: { region: 'eu' } });
    expect(h.latest().sent.some((m) => m.type === 'subscribe')).toBe(false); // not before ack
    h.latest().open(); // → ack → replay
    const sub = h.latest().sent.find((m) => m.type === 'subscribe');
    expect(sub).toEqual({
      id: 's1',
      type: 'subscribe',
      payload: { query: 'subscription { trades { id } }', variables: { region: 'eu' } },
    });
  });

  it('routes a next result to its channel and unwraps data (default decode)', () => {
    const h = harness({});
    h.latest().open();
    h.adapter.subscribe({ subId: 's1', channel: 'orders' });
    h.latest().serverSend({ id: 's1', type: 'next', payload: { data: { id: 7 } } });
    expect(h.rec.events).toEqual([{ channel: 'orders', event: 'next', payload: { id: 7 } }]);
  });

  it('ignores a next for an unknown subscription id', () => {
    const h = harness({});
    h.latest().open();
    h.latest().serverSend({ id: 'ghost', type: 'next', payload: { data: 1 } });
    expect(h.rec.events).toEqual([]);
  });

  it('answers a server ping with a pong', () => {
    const h = harness({});
    h.latest().open();
    h.latest().serverSend({ type: 'ping' });
    expect(h.latest().sent).toContainEqual({ type: 'pong' });
  });

  it('surfaces a subscription error through onError', () => {
    const h = harness({});
    h.latest().open();
    h.adapter.subscribe({ subId: 's1', channel: 'orders' });
    h.latest().serverSend({ id: 's1', type: 'error', payload: [{ message: 'boom' }] });
    expect(h.rec.errors).toEqual([[{ message: 'boom' }]]);
  });

  it('drops a subscription locally on a server complete (no replay)', () => {
    const h = harness({});
    h.latest().open();
    h.adapter.subscribe({ subId: 's1', channel: 'orders' });
    h.latest().serverSend({ id: 's1', type: 'complete' });
    // reconnect → the completed sub is not replayed
    h.adapter.connect(h.rec);
    h.latest().open();
    expect(h.latest().sent.some((m) => m.type === 'subscribe' && m.id === 's1')).toBe(false);
  });

  it('sends connection_init payload from connectionParams', () => {
    const h = harness({ connectionParams: () => ({ authToken: 'abc' }) });
    h.latest().open();
    expect(h.latest().sent[0]).toEqual({ type: 'connection_init', payload: { authToken: 'abc' } });
  });

  it('drops inbound frames over maxMessageBytes before parsing', () => {
    const h = harness({ maxMessageBytes: 20 });
    h.latest().open();
    h.adapter.subscribe({ subId: 's1', channel: 'orders' });
    h.latest().serverSend({ id: 's1', type: 'next', payload: { data: 'x'.repeat(200) } });
    expect(h.rec.events).toEqual([]);
  });

  it('throws when no WebSocket implementation is available', () => {
    const adapter = graphqlWs('wss://x.test/graphql');
    // no global WebSocket in this Node test env
    expect(() => adapter.connect(recorder())).toThrow(/WebSocket/);
  });

  describe('publish + request (bidirectional)', () => {
    it('publishes a fire-and-forget mutation and discards its result', () => {
      const h = harness({});
      h.latest().open();
      h.adapter.publish?.({ channel: 'orders', event: 'create', payload: { sku: 'A1' }, meta: { r: 1 } });
      const cmd = h.latest().sent.find((m) => m.type === 'subscribe');
      expect(cmd).toEqual({
        id: 'cmd-1',
        type: 'subscribe',
        payload: { query: 'orders', variables: { event: 'create', payload: { sku: 'A1' }, meta: { r: 1 } } },
      });
      // its result must NOT surface as an event, and its error must NOT surface as onError
      h.latest().serverSend({ id: 'cmd-1', type: 'next', payload: { data: { id: 9 } } });
      h.latest().serverSend({ id: 'cmd-1', type: 'error', payload: [{ message: 'ignored' }] });
      expect(h.rec.events).toEqual([]);
      expect(h.rec.errors).toEqual([]);
    });

    it('carries an idempotencyKey in the mutation variables', () => {
      const h = harness({});
      h.latest().open();
      h.adapter.publish?.({ channel: 'orders', event: 'create', payload: 1, idempotencyKey: 'k-1' });
      const cmd = h.latest().sent.find((m) => m.type === 'subscribe');
      expect((cmd?.payload as { variables: unknown }).variables).toEqual({
        event: 'create',
        payload: 1,
        idempotencyKey: 'k-1',
      });
    });

    it('routes a request mutation `next` result to onReply, then completes', () => {
      const h = harness({});
      h.latest().open();
      h.adapter.request?.({ requestId: 'rq_1', channel: 'orders', event: 'create', payload: { sku: 'A1' } });
      const cmd = h.latest().sent.find((m) => m.id === 'rq_1');
      expect(cmd).toEqual({
        id: 'rq_1',
        type: 'subscribe',
        payload: { query: 'orders', variables: { event: 'create', payload: { sku: 'A1' } } },
      });

      h.latest().serverSend({ id: 'rq_1', type: 'next', payload: { data: { id: 7 } } });
      h.latest().serverSend({ id: 'rq_1', type: 'complete' });
      expect(h.rec.replies).toEqual([{ requestId: 'rq_1', ok: true, payload: { id: 7 } }]);
      expect(h.rec.events).toEqual([]);
    });

    it('routes a request-scoped `error` to onReply as a rejected reply (not onError)', () => {
      const h = harness({});
      h.latest().open();
      h.adapter.request?.({ requestId: 'rq_2', channel: 'orders', event: 'create', payload: {} });
      h.latest().serverSend({ id: 'rq_2', type: 'error', payload: [{ message: 'boom' }] });
      expect(h.rec.replies).toEqual([
        { requestId: 'rq_2', ok: false, error: { data: [{ message: 'boom' }] } },
      ]);
      expect(h.rec.errors).toEqual([]);
    });

    it('rejects a request whose result carries GraphQL errors', () => {
      const h = harness({});
      h.latest().open();
      h.adapter.request?.({ requestId: 'rq_3', channel: 'orders', event: 'create', payload: {} });
      h.latest().serverSend({ id: 'rq_3', type: 'next', payload: { errors: [{ message: 'nope' }] } });
      expect(h.rec.replies).toEqual([
        { requestId: 'rq_3', ok: false, error: { data: [{ message: 'nope' }] } },
      ]);
    });
  });
});
