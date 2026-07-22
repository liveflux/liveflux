import { describe, expect, it, vi } from 'vitest';
import type { AdapterHandlers, NormalizedEvent } from '@liveflux/core';
import { sse, type SseOptions } from './index';

class FakeEventSource {
  readyState = 0;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown; lastEventId?: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  constructor(readonly instances: FakeEventSource[]) {
    instances.push(this);
  }
  close(): void {
    this.readyState = 2;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(data: unknown, lastEventId = ''): void {
    this.onmessage?.({ data, lastEventId });
  }
  fail(reason?: unknown): void {
    this.readyState = 2;
    this.onerror?.(reason);
  }
}

interface FetchCall {
  url: string;
  body: unknown;
}
function mockFetch(impl?: () => Promise<{ ok: boolean; status: number }>) {
  const calls: FetchCall[] = [];
  const fn = (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return impl ? impl() : Promise.resolve({ ok: true, status: 200 });
  };
  return Object.assign(fn, { calls });
}

function recorder(): AdapterHandlers & {
  opens: number;
  closes: number;
  errors: unknown[];
  events: NormalizedEvent[];
} {
  const rec = {
    opens: 0,
    closes: 0,
    errors: [] as unknown[],
    events: [] as NormalizedEvent[],
    onOpen() {
      rec.opens += 1;
    },
    onClose() {
      rec.closes += 1;
    },
    onError(err: unknown) {
      rec.errors.push(err);
    },
    onEvent(ev: NormalizedEvent) {
      rec.events.push(ev);
    },
  };
  return rec;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function harness(opts: Partial<SseOptions> = {}) {
  const instances: FakeEventSource[] = [];
  const Ctor = class extends FakeEventSource {
    constructor() {
      super(instances);
    }
  } as unknown as SseOptions['EventSource'];
  const fetchFn = mockFetch(opts.fetch as never);
  const adapter = sse('https://x.test/stream', {
    EventSource: Ctor,
    fetch: fetchFn as never,
    ...opts,
  });
  const rec = recorder();
  adapter.connect(rec);
  return { adapter, rec, instances, latest: () => instances[instances.length - 1]!, fetchFn };
}

describe('@liveflux/sse', () => {
  it('POSTs a subscribe frame to the stream URL by default once open', () => {
    const h = harness();
    h.latest().open();
    h.adapter.subscribe({ subId: 's1', channel: 'orders', params: { region: 'eu' } });
    expect(h.fetchFn.calls).toEqual([
      { url: 'https://x.test/stream', body: { type: 'subscribe', subId: 's1', channel: 'orders', params: { region: 'eu' } } },
    ]);
  });

  it('POSTs control frames to a dedicated control URL when given one', () => {
    const h = harness({ control: 'https://x.test/control' });
    h.latest().open();
    h.adapter.subscribe({ subId: 's1', channel: 'orders' });
    expect(h.fetchFn.calls[0]!.url).toBe('https://x.test/control');
  });

  it('decodes the cursor from lastEventId when the payload omits it', () => {
    const h = harness();
    h.latest().open();
    h.adapter.subscribe({ subId: 's1', channel: 'orders' });
    h.latest().emit(JSON.stringify({ channel: 'orders', event: 'update', payload: 1 }), 'evt-42');
    expect(h.rec.events).toEqual([
      { channel: 'orders', event: 'update', payload: 1, cursor: 'evt-42' },
    ]);
  });

  it('drops inbound frames larger than maxMessageBytes before decoding', () => {
    const h = harness({ maxMessageBytes: 10 });
    h.latest().open();
    h.latest().emit(JSON.stringify({ channel: 'orders', event: 'update', payload: 'x'.repeat(100) }));
    expect(h.rec.events).toEqual([]);
  });

  it('surfaces a non-ok control response through onError', async () => {
    const h = harness({ fetch: () => Promise.resolve({ ok: false, status: 500 }) });
    h.latest().open();
    h.adapter.subscribe({ subId: 's1', channel: 'orders' });
    await flush();
    expect(h.rec.errors).toHaveLength(1);
  });

  it('surfaces a control transport rejection through onError', async () => {
    const boom = new Error('network down');
    const h = harness({ fetch: () => Promise.reject(boom) });
    h.latest().open();
    h.adapter.subscribe({ subId: 's1', channel: 'orders' });
    await flush();
    expect(h.rec.errors).toEqual([boom]);
  });

  it('closes and fires onClose on a stream error (core drives reconnect)', () => {
    const h = harness();
    h.latest().open();
    expect(h.rec.opens).toBe(1);
    h.latest().fail('network-loss');
    expect(h.rec.closes).toBe(1);
    // a second event source is NOT auto-created by the adapter — the core will call connect() again
    expect(h.instances).toHaveLength(1);
  });

  it('stops delivering events after disconnect', () => {
    const h = harness();
    h.latest().open();
    h.adapter.subscribe({ subId: 's1', channel: 'orders' });
    h.adapter.disconnect();
    h.latest().emit(JSON.stringify({ channel: 'orders', event: 'update', payload: 1 }));
    expect(h.rec.events).toEqual([]);
  });

  it('throws when no EventSource implementation is available', () => {
    const adapter = sse('https://x.test/stream', { fetch: mockFetch() as never });
    expect(() => adapter.connect(recorder())).toThrow(/EventSource/);
  });

  it('throws when neither a fetch nor a function control is available', () => {
    const instances: FakeEventSource[] = [];
    const Ctor = class extends FakeEventSource {
      constructor() {
        super(instances);
      }
    } as unknown as SseOptions['EventSource'];
    const orig = (globalThis as { fetch?: unknown }).fetch;
    // simulate an environment with no global fetch (the adapter captures it at construction)
    (globalThis as { fetch?: unknown }).fetch = undefined;
    try {
      const adapter = sse('https://x.test/stream', { EventSource: Ctor });
      expect(() => adapter.connect(recorder())).toThrow(/control channel/);
    } finally {
      (globalThis as { fetch?: unknown }).fetch = orig;
    }
  });
});
