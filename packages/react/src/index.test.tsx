import { act, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LivefluxClient } from '@liveflux/core';
import type { AdapterHandlers, StreamAdapter, SubscribeRequest } from '@liveflux/core';
import type { ReactNode } from 'react';
import { LivefluxProvider, useConnection, useStream } from './index';

/** Minimal adapter that opens synchronously and lets a test push events. */
class MockAdapter implements StreamAdapter {
  private handlers: AdapterHandlers | null = null;
  /** Wire subscriptions currently open (added on subscribe, removed on unsubscribe). */
  readonly active = new Set<string>();
  connect(handlers: AdapterHandlers): void {
    this.handlers = handlers;
    handlers.onOpen();
  }
  disconnect(): void {
    this.handlers = null;
  }
  subscribe(req: SubscribeRequest): void {
    this.active.add(req.subId);
  }
  unsubscribe(subId: string): void {
    this.active.delete(subId);
  }
  emit(channel: string, payload: unknown): void {
    this.handlers?.onEvent({ channel, event: 'update', payload });
  }
}

function setup() {
  const adapter = new MockAdapter();
  const client = new LivefluxClient({ adapter });
  client.connect();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <LivefluxProvider client={client}>{children}</LivefluxProvider>
  );
  return { adapter, client, wrapper };
}

describe('useStream', () => {
  it('starts empty and appends events as they arrive', () => {
    const { adapter, wrapper } = setup();
    const { result } = renderHook(
      () => useStream<number>({ channel: 'trades', into: { strategy: 'append' } }),
      { wrapper },
    );
    expect(result.current).toEqual([]);
    act(() => adapter.emit('trades', 1));
    expect(result.current).toEqual([1]);
    act(() => adapter.emit('trades', 2));
    expect(result.current).toEqual([1, 2]);
  });

  it('returns [] synchronously on the first render — never undefined before subscribe', () => {
    const { wrapper } = setup();
    // Reading `.length` DURING render would throw if the value were undefined before the subscribe
    // effect runs (the bug the playground caught). With a stable initial it is `[]` from render 1.
    const { result } = renderHook(
      () => useStream<number>({ channel: 'trades', into: { strategy: 'append' } }).length,
      { wrapper },
    );
    expect(result.current).toBe(0);
  });

  it('ignores events on other channels', () => {
    const { adapter, wrapper } = setup();
    const { result } = renderHook(
      () => useStream<number>({ channel: 'trades', into: { strategy: 'append' } }),
      { wrapper },
    );
    act(() => adapter.emit('quotes', 99));
    expect(result.current).toEqual([]);
  });

  it('replace keeps only the latest payload', () => {
    const { adapter, wrapper } = setup();
    const { result } = renderHook(
      () => useStream<{ n: number }>({ channel: 'price', into: { strategy: 'replace' } }),
      { wrapper },
    );
    act(() => adapter.emit('price', { n: 1 }));
    act(() => adapter.emit('price', { n: 2 }));
    expect(result.current).toEqual({ n: 2 });
  });

  it('tears down the subscription on unmount', () => {
    const { adapter, wrapper } = setup();
    const { result, unmount } = renderHook(
      () => useStream<number>({ channel: 'trades', into: { strategy: 'append' } }),
      { wrapper },
    );
    act(() => adapter.emit('trades', 1));
    expect(result.current).toEqual([1]);
    unmount();
    // Emitting after unmount must not throw or affect the last snapshot.
    act(() => adapter.emit('trades', 2));
    expect(result.current).toEqual([1]);
  });

  it('throws when used outside a provider', () => {
    expect(() =>
      renderHook(() => useStream<number>({ channel: 'x', into: { strategy: 'append' } })),
    ).toThrow(/LivefluxProvider/);
  });

  it('re-subscribes when params change on the same channel and shows the new stream', () => {
    const { adapter, wrapper } = setup();
    const { result, rerender } = renderHook(
      ({ room }: { room: string }) =>
        useStream<number>({ channel: 'trades', params: { room }, into: { strategy: 'append' } }),
      { wrapper, initialProps: { room: 'a' } },
    );
    act(() => adapter.emit('trades', 1));
    expect(result.current).toEqual([1]); // fold for room:a

    // Same channel, different params → core has a distinct subscription identity. The binding must
    // tear down the old fold and subscribe to the new (empty) one — not silently keep the old data.
    rerender({ room: 'b' });
    expect(result.current).toEqual([]); // fresh fold for room:b (would be [1] with the F1 bug)

    act(() => adapter.emit('trades', 2));
    expect(result.current).toEqual([2]); // only room:b's fold saw this event
  });

  it('keeps exactly one live wire subscription across a StrictMode double-mount', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    client.connect();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>
        <LivefluxProvider client={client}>{children}</LivefluxProvider>
      </StrictMode>
    );
    const { unmount } = renderHook(
      () => useStream<number>({ channel: 'trades', into: { strategy: 'append' } }),
      { wrapper },
    );
    // StrictMode runs subscribe → cleanup → subscribe. Ref-counting must net to a single open wire.
    expect(adapter.active.size).toBe(1);
    unmount();
    expect(adapter.active.size).toBe(0); // fully released, no leak
  });
});

describe('useStream selector', () => {
  it('re-renders only when the selected slice changes', () => {
    const { adapter, wrapper } = setup();
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders += 1;
        return useStream(
          { channel: 'trades', into: { strategy: 'append' } as const },
          (list) => (list?.length ?? 0) >= 1, // boolean slice
        );
      },
      { wrapper },
    );
    act(() => adapter.emit('trades', 1)); // false → true (one re-render)
    expect(result.current).toBe(true);
    const rendersAfterChange = renders;
    act(() => adapter.emit('trades', 2)); // slice still true — unchanged
    act(() => adapter.emit('trades', 3)); // slice still true — unchanged
    expect(result.current).toBe(true);
    expect(renders).toBe(rendersAfterChange); // no re-renders for an unchanged selected slice
  });

  it('recomputes and re-renders when the derived value changes', () => {
    const { adapter, wrapper } = setup();
    const { result } = renderHook(
      () =>
        useStream({ channel: 'c', into: { strategy: 'append' } as const }, (list) => list?.length ?? 0),
      { wrapper },
    );
    act(() => adapter.emit('c', 10));
    expect(result.current).toBe(1);
    act(() => adapter.emit('c', 20));
    expect(result.current).toBe(2);
  });

  it('reflects a prop the selector closes over on the next render, without a new event', () => {
    const { adapter, wrapper } = setup();
    const { result, rerender } = renderHook(
      ({ threshold }: { threshold: number }) =>
        useStream(
          { channel: 'nums', into: { strategy: 'append' } as const },
          (list: number[]) => (list ?? []).filter((x) => x > threshold).length,
        ),
      { wrapper, initialProps: { threshold: 15 } },
    );
    act(() => adapter.emit('nums', 10));
    act(() => adapter.emit('nums', 20));
    act(() => adapter.emit('nums', 30));
    expect(result.current).toBe(2); // 20, 30 > 15

    // The store is untouched here — only the prop the selector closes over changes. The selected
    // value must update on re-render (F3); a stale-selector memo would keep returning 2.
    rerender({ threshold: 25 });
    expect(result.current).toBe(1); // only 30 > 25
  });
});

describe('useStream SSR', () => {
  it('renders the server snapshot without throwing', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    function Feed() {
      const trades = useStream<number>({ channel: 'trades', into: { strategy: 'append' } });
      return <span>{trades.length}</span>;
    }
    const html = renderToString(
      <LivefluxProvider client={client}>
        <Feed />
      </LivefluxProvider>,
    );
    // getServerSnapshot returns the stable initial `[]` — `.length` is safe, so SSR yields 0.
    expect(html).toContain('<span>0</span>');
  });
});

describe('useConnection', () => {
  it('reflects the current connection state', () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useConnection(), { wrapper });
    expect(result.current).toBe('open');
  });
});
