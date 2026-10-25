import { describe, expect, it } from 'vitest';
import { ClientModel } from './view-model';
import type { DevtoolsEvent } from './events';

let clock = 0;
const at = () => (clock += 1);

const feed = (model: ClientModel, ...events: DevtoolsEvent[]) => {
  for (const e of events) model.apply(e);
};

describe('ClientModel', () => {
  it('starts idle and absent', () => {
    const view = new ClientModel('c1').getView();
    expect(view).toMatchObject({
      id: 'c1',
      present: false,
      connectionState: 'idle',
      eventCount: 0,
    });
    expect(view.subscriptions).toEqual([]);
    expect(view.events).toEqual([]);
  });

  it('folds register / destroy into presence', () => {
    const m = new ClientModel('c1');
    feed(m, { t: 'client:register', clientId: 'c1', at: at() });
    expect(m.getView().present).toBe(true);
    expect(m.getView().createdAt).toBeGreaterThan(0);
    feed(m, { t: 'client:destroy', clientId: 'c1', at: at() });
    expect(m.getView().present).toBe(false);
  });

  it('tracks connection state and appends a timeline', () => {
    const m = new ClientModel('c1');
    feed(
      m,
      { t: 'connection:state', clientId: 'c1', from: 'idle', to: 'connecting', at: at() },
      { t: 'connection:state', clientId: 'c1', from: 'connecting', to: 'open', at: at() },
    );
    const view = m.getView();
    expect(view.connectionState).toBe('open');
    expect(view.connectionTimeline.map((t) => t.to)).toEqual(['connecting', 'open']);
  });

  it('maintains an active-subscriptions table across add / refchange / remove', () => {
    const m = new ClientModel('c1');
    feed(m, {
      t: 'sub:add',
      clientId: 'c1',
      subId: 's1',
      channel: 'trades',
      strategy: 'append',
      refCount: 1,
      at: at(),
    });
    expect(m.getView().subscriptions).toEqual([
      { id: 's1', channel: 'trades', strategy: 'append', cap: undefined, refCount: 1 },
    ]);

    feed(m, { t: 'sub:refchange', clientId: 'c1', subId: 's1', refCount: 3, at: at() });
    expect(m.getView().subscriptions[0]!.refCount).toBe(3);

    feed(m, { t: 'sub:remove', clientId: 'c1', subId: 's1', at: at() });
    expect(m.getView().subscriptions).toEqual([]);
  });

  it('logs events and counts them', () => {
    const m = new ClientModel('c1');
    feed(
      m,
      {
        t: 'event:in',
        clientId: 'c1',
        channel: 'trades',
        event: 'update',
        payload: { a: 1 },
        bytes: 7,
        at: at(),
      },
      {
        t: 'event:in',
        clientId: 'c1',
        channel: 'trades',
        event: 'update',
        payload: { a: 2 },
        bytes: 7,
        at: at(),
      },
    );
    const view = m.getView();
    expect(view.eventCount).toBe(2);
    expect(view.events).toHaveLength(2);
    expect(view.events[1]!.payload).toEqual({ a: 2 });
    expect(view.lastEventAt).toBe(clock);
  });

  it('logs errors with code', () => {
    const m = new ClientModel('c1');
    feed(m, {
      t: 'error',
      clientId: 'c1',
      error: { name: 'ConnectionError', code: 'CONNECTION_FAILED', message: 'down' },
      at: at(),
    });
    const errors = m.getView().errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      name: 'ConnectionError',
      code: 'CONNECTION_FAILED',
      message: 'down',
    });
    expect(errors[0]!.at).toBeGreaterThan(0);
  });

  it('bounds each log by its cap', () => {
    const m = new ClientModel('c1', { events: 2, timeline: 2, errors: 2 });
    for (let i = 0; i < 5; i++) {
      m.apply({
        t: 'event:in',
        clientId: 'c1',
        channel: 'c',
        event: 'e',
        payload: i,
        bytes: 1,
        at: at(),
      });
    }
    const view = m.getView();
    expect(view.events).toHaveLength(2);
    expect(view.events.map((e) => e.payload)).toEqual([3, 4]); // oldest evicted
    expect(view.eventCount).toBe(5); // count is not bounded
  });

  it('getView returns copies — mutating them does not corrupt the model', () => {
    const m = new ClientModel('c1');
    feed(m, {
      t: 'event:in',
      clientId: 'c1',
      channel: 'c',
      event: 'e',
      payload: 1,
      bytes: 1,
      at: at(),
    });
    const view = m.getView();
    view.events.push({ seq: -1, channel: 'x', event: 'y', payload: 0, bytes: 0, at: 0 });
    view.subscriptions.push({ id: 'z', channel: 'z', strategy: 'append', refCount: 9 });
    expect(m.getView().events).toHaveLength(1);
    expect(m.getView().subscriptions).toHaveLength(0);
  });

  it('markGone clears presence', () => {
    const m = new ClientModel('c1');
    feed(m, { t: 'client:register', clientId: 'c1', at: at() });
    m.markGone();
    expect(m.getView().present).toBe(false);
  });

  it('ignores refchange / remove for an unknown subscription', () => {
    const m = new ClientModel('c1');
    expect(() => {
      m.apply({ t: 'sub:refchange', clientId: 'c1', subId: 'ghost', refCount: 2, at: at() });
      m.apply({ t: 'sub:remove', clientId: 'c1', subId: 'ghost', at: at() });
    }).not.toThrow();
    expect(m.getView().subscriptions).toEqual([]);
  });

  describe('command log (publish / request)', () => {
    it('folds a publish into a terminal command row', () => {
      const m = new ClientModel('c1');
      feed(m, {
        t: 'publish:out',
        clientId: 'c1',
        channel: 'orders',
        event: 'create',
        payload: { sku: 'A1' },
        bytes: 12,
        idempotencyKey: 'k-1',
        queued: false,
        at: 5,
      });
      expect(m.getView().commands).toEqual([
        {
          seq: 0,
          kind: 'publish',
          channel: 'orders',
          event: 'create',
          payload: { sku: 'A1' },
          bytes: 12,
          idempotencyKey: 'k-1',
          queued: false,
          at: 5,
        },
      ]);
    });

    it('folds a request pending, then settles it in place (status + duration + result)', () => {
      const m = new ClientModel('c1');
      feed(m, {
        t: 'request:out',
        clientId: 'c1',
        requestId: 'req-1',
        channel: 'orders',
        event: 'create',
        payload: { sku: 'A1' },
        bytes: 12,
        queued: false,
        at: 10,
      });
      expect(m.getView().commands[0]).toMatchObject({ kind: 'request', requestId: 'req-1', status: 'pending' });

      feed(m, {
        t: 'request:settle',
        clientId: 'c1',
        requestId: 'req-1',
        outcome: 'resolved',
        payload: { id: 7 },
        at: 25,
      });
      const row = m.getView().commands[0]!;
      expect(row).toMatchObject({
        requestId: 'req-1',
        status: 'resolved',
        settledAt: 25,
        durationMs: 15,
        result: { id: 7 },
      });
      expect(m.getView().commands).toHaveLength(1); // settled in place, not appended
    });

    it('records a rejected request with its error', () => {
      const m = new ClientModel('c1');
      feed(
        m,
        {
          t: 'request:out',
          clientId: 'c1',
          requestId: 'req-1',
          channel: 'orders',
          event: 'create',
          payload: {},
          bytes: 2,
          queued: false,
          at: 1,
        },
        {
          t: 'request:settle',
          clientId: 'c1',
          requestId: 'req-1',
          outcome: 'rejected',
          error: { name: 'RequestError', code: 'REQUEST_FAILED', message: 'nope' },
          at: 4,
        },
      );
      expect(m.getView().commands[0]).toMatchObject({
        status: 'rejected',
        durationMs: 3,
        error: { name: 'RequestError', code: 'REQUEST_FAILED', message: 'nope' },
      });
    });

    it('tolerates a settle for an unknown / evicted request', () => {
      const m = new ClientModel('c1');
      expect(() =>
        m.apply({ t: 'request:settle', clientId: 'c1', requestId: 'ghost', outcome: 'resolved', at: 1 }),
      ).not.toThrow();
      expect(m.getView().commands).toEqual([]);
    });

    it('caps the command log and untracks an evicted pending request', () => {
      const m = new ClientModel('c1', { commands: 2 });
      // req-1 is pending, then two more publishes push it past the cap of 2.
      feed(
        m,
        { t: 'request:out', clientId: 'c1', requestId: 'req-1', channel: 'c', event: 'e', payload: 0, bytes: 1, queued: false, at: 1 },
        { t: 'publish:out', clientId: 'c1', channel: 'c', event: 'e', payload: 0, bytes: 1, queued: false, at: 2 },
        { t: 'publish:out', clientId: 'c1', channel: 'c', event: 'e', payload: 0, bytes: 1, queued: false, at: 3 },
      );
      expect(m.getView().commands).toHaveLength(2); // req-1 evicted
      // A late settle for the evicted req-1 must NOT resurrect or crash it.
      feed(m, { t: 'request:settle', clientId: 'c1', requestId: 'req-1', outcome: 'resolved', payload: 9, at: 4 });
      expect(m.getView().commands.every((c) => c.requestId !== 'req-1')).toBe(true);
    });
  });
});
