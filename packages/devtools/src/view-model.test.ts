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
});
