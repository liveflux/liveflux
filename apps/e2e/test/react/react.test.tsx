import { act, render, renderHook } from '@testing-library/react';
import { StrictMode, useRef, type ReactElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { LivefluxClient } from '@liveflux/core';
import type { NormalizedEvent } from '@liveflux/core';
import { MockAdapter } from '@liveflux/adapter-tests';
import { LivefluxProvider, useConnection, useStream } from '@liveflux/react';

/**
 * `@liveflux/react` bindings driven through the real `LivefluxClient` against the programmable
 * `MockAdapter`, under jsdom + Testing Library. Covers every store strategy, `useConnection`,
 * selector + `isEqual` re-render behaviour, param re-subscription, StrictMode double-mount, and SSR.
 */

interface Harness {
  adapter: MockAdapter;
  client: LivefluxClient;
  wrapper: ({ children }: { children: ReactNode }) => ReactElement;
}

const live: LivefluxClient[] = [];

function setup(): Harness {
  const adapter = new MockAdapter();
  const client = new LivefluxClient({ adapter });
  client.connect();
  adapter.open();
  live.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <LivefluxProvider client={client}>{children}</LivefluxProvider>
  );
  return { adapter, client, wrapper };
}

/** Emit an update event on `channel` inside act() so React flushes the re-render. */
function emit(adapter: MockAdapter, channel: string, payload: unknown, extra?: Partial<NormalizedEvent>): void {
  act(() => adapter.emit({ channel, event: 'update', payload, ...extra }));
}

afterEach(() => {
  for (const client of live.splice(0)) client.destroy();
});

describe('useStream · strategies render and update', () => {
  it('append renders each event in order', () => {
    const { adapter, wrapper } = setup();
    const { result } = renderHook(
      () => useStream<number>({ channel: 'feed', into: { strategy: 'append' } }),
      { wrapper },
    );
    expect(result.current).toEqual([]);
    emit(adapter, 'feed', 1);
    emit(adapter, 'feed', 2);
    expect(result.current).toEqual([1, 2]);
  });

  it('upsert renders entities keyed by id', () => {
    interface Row {
      id: number;
      v: string;
    }
    const { adapter, wrapper } = setup();
    const { result } = renderHook(
      () => useStream<Row>({ channel: 'rows', into: { strategy: 'upsert', key: 'id' } }),
      { wrapper },
    );
    emit(adapter, 'rows', { id: 1, v: 'a' });
    emit(adapter, 'rows', { id: 1, v: 'a2' });
    expect(result.current).toEqual([{ id: 1, v: 'a2' }]);
  });

  it('replace renders the latest snapshot (undefined first)', () => {
    const { adapter, wrapper } = setup();
    const { result } = renderHook(
      () => useStream<{ p: number }>({ channel: 'ticker', into: { strategy: 'replace' } }),
      { wrapper },
    );
    expect(result.current).toBeUndefined();
    emit(adapter, 'ticker', { p: 1 });
    emit(adapter, 'ticker', { p: 2 });
    expect(result.current).toEqual({ p: 2 });
  });

  it('reducer renders custom folded state', () => {
    const { adapter, wrapper } = setup();
    const { result } = renderHook(
      () =>
        useStream<number, number>({
          channel: 'counter',
          into: {
            strategy: 'reducer',
            initial: 0,
            reduce: (total, e) => total + (e.payload as number),
          },
        }),
      { wrapper },
    );
    expect(result.current).toBe(0);
    emit(adapter, 'counter', 5);
    emit(adapter, 'counter', 4);
    expect(result.current).toBe(9);
  });
});

describe('useConnection', () => {
  it('reflects connection-state transitions', () => {
    const { adapter, wrapper } = setup();
    const { result } = renderHook(() => useConnection(), { wrapper });
    expect(result.current).toBe('open');
    act(() => adapter.drop()); // unexpected close → reconnect scheduled
    expect(result.current).toBe('reconnecting');
  });
});

describe('useStream · selector + isEqual', () => {
  it('does not re-render when the selected slice is unchanged, but recomputes on a prop change', () => {
    const { adapter, wrapper } = setup();
    let renders = 0;

    // A selected slice: the count of items. Adding an item that does not change the derived value
    // under a custom isEqual must not re-render; a changed closed-over `threshold` must recompute.
    function Probe({ threshold }: { threshold: number }) {
      renders += 1;
      const overThreshold = useStream<number, boolean>(
        { channel: 'feed', into: { strategy: 'append' } },
        (items) => items.length > threshold,
        (a, b) => a === b,
      );
      return <span data-testid="v">{String(overThreshold)}</span>;
    }

    const { rerender, getByTestId } = render(<Probe threshold={2} />, { wrapper });
    expect(getByTestId('v').textContent).toBe('false');
    const afterMount = renders;

    // Two events: length goes 0→1→2, still not > 2, so the selected boolean stays false → no re-render.
    emit(adapter, 'feed', 1);
    emit(adapter, 'feed', 2);
    expect(getByTestId('v').textContent).toBe('false');
    expect(renders).toBe(afterMount); // selected value unchanged → React skipped the re-render

    // A third event pushes length to 3 (> 2) → the boolean flips → exactly one re-render.
    emit(adapter, 'feed', 3);
    expect(getByTestId('v').textContent).toBe('true');
    expect(renders).toBe(afterMount + 1);

    // Changing the closed-over prop must recompute the selector against the same stream (3 > 1).
    rerender(<Probe threshold={1} />);
    expect(getByTestId('v').textContent).toBe('true');
  });
});

describe('useStream · param re-subscription', () => {
  it('re-subscribes with a fresh fold when params change on the same channel', () => {
    const { adapter, wrapper } = setup();
    const { result, rerender } = renderHook(
      ({ room }: { room: number }) =>
        useStream<number>({ channel: 'feed', into: { strategy: 'append' }, params: { room } }),
      { wrapper, initialProps: { room: 1 } },
    );
    emit(adapter, 'feed', 1);
    expect(result.current).toEqual([1]);

    // New params → new subscription identity → a fresh, empty fold.
    rerender({ room: 2 });
    expect(result.current).toEqual([]);
    emit(adapter, 'feed', 9);
    expect(result.current).toEqual([9]);
  });
});

describe('useStream · lifecycle', () => {
  it('leaves exactly one live wire subscription under StrictMode, and none after unmount', () => {
    const { adapter, wrapper } = setup();
    const { unmount } = renderHook(
      () => useStream<number>({ channel: 'feed', into: { strategy: 'append' } }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <StrictMode>{wrapper({ children })}</StrictMode>
        ),
      },
    );
    // StrictMode double-invokes mount effects; the ref-counted registry must still hold exactly one.
    expect(adapter.subscriptions).toHaveLength(1);
    unmount();
    expect(adapter.subscriptions).toHaveLength(0);
  });

  it('shares one wire subscription across two components on the same channel + params', () => {
    const { adapter, wrapper } = setup();
    function Two() {
      const a = useStream<number>({ channel: 'feed', into: { strategy: 'append' } });
      const b = useStream<number>({ channel: 'feed', into: { strategy: 'append' } });
      const seen = useRef(0);
      seen.current = a.length + b.length;
      return <span>{seen.current}</span>;
    }
    render(<Two />, { wrapper });
    expect(adapter.subscriptions).toHaveLength(1);
  });
});

describe('useStream · SSR', () => {
  it('renderToString uses getServerSnapshot and does not throw', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    // No connect()/open() — SSR must render from the stable server snapshot alone.
    function App() {
      const items = useStream<number>({ channel: 'feed', into: { strategy: 'append' } });
      const state = useConnection();
      return (
        <div>
          <span>{items.length}</span>
          <span>{state}</span>
        </div>
      );
    }
    const html = renderToString(
      <LivefluxProvider client={client}>
        <App />
      </LivefluxProvider>,
    );
    expect(html).toContain('<span>0</span>');
    expect(html).toContain('idle');
  });
});
