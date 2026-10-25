'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type {
  ConnectionState,
  IntoStrategy,
  LivefluxClient,
  PublishOptions,
  RequestOptions,
  SubscribeConfig,
  Subscription,
} from '@liveflux/core';
import { SnapshotMemo } from './internal/snapshot-memo';

const LivefluxContext = createContext<LivefluxClient | null>(null);
LivefluxContext.displayName = 'LivefluxContext';

/**
 * When `enabled` is `false` the hook holds off subscribing and returns the strategy's initial
 * state (`[]` / `undefined` / the reducer initial); flipping it to `true` subscribes. Lets a stream
 * wait on a prerequisite (an id, auth, a visible tab) without conditionally calling the hook.
 */
type EnabledOption = { enabled?: boolean };
/** Config for a strategy whose folded state is a list (`append` / `upsert`). */
type ListConfig<T> = EnabledOption & {
  channel: string;
  params?: Record<string, unknown>;
  into: Extract<IntoStrategy<T>, { strategy: 'append' | 'upsert' }>;
};
/** Config for the `replace` strategy — the latest payload (or `undefined` before the first). */
type ReplaceConfig<T> = EnabledOption & {
  channel: string;
  params?: Record<string, unknown>;
  into: Extract<IntoStrategy<T>, { strategy: 'replace' }>;
};
/** Config for the `reducer` strategy — a custom fold into `S`. */
type ReducerConfig<T, S> = EnabledOption & {
  channel: string;
  params?: Record<string, unknown>;
  into: Extract<IntoStrategy<T, S>, { strategy: 'reducer' }>;
};

/**
 * Provides a {@link LivefluxClient} to the React tree. Place it once near the root; the client
 * owns the single multiplexed connection, so all `useStream` calls below share it.
 */
export function LivefluxProvider({
  client,
  children,
}: {
  client: LivefluxClient;
  children: ReactNode;
}) {
  return <LivefluxContext.Provider value={client}>{children}</LivefluxContext.Provider>;
}

function useClient(): LivefluxClient {
  const client = useContext(LivefluxContext);
  if (!client) {
    throw new Error('useStream/useConnection must be used within a <LivefluxProvider>.');
  }
  return client;
}

/** The stable initial value for a strategy, returned before the first event (before subscribe). */
function initialState<T, S>(into: IntoStrategy<T, S>): T[] | T | S | undefined {
  switch (into.strategy) {
    case 'append':
    case 'upsert':
      return [];
    case 'reducer':
      return into.initial;
    default:
      return undefined; // 'replace' — no value until the first event
  }
}

/**
 * Subscribe to a channel and read its folded state, re-rendering as events arrive. The wire
 * subscription is multiplexed + ref-counted and reconnect-safe; reads go through
 * `useSyncExternalStore`, so they are tear-free and safe under concurrent rendering.
 *
 * The return type follows the strategy: `append`/`upsert` → `T[]`, `replace` → `T | undefined`,
 * `reducer` → `S`. Pass the item type as `T` (and the reduced type as `S` for reducers).
 * Re-subscribes only when the client or the `channel` identity changes.
 *
 * Pass a `select` to subscribe to a derived slice — the component then re-renders **only when the
 * selected value changes** (compared with `isEqual`, default `Object.is`), not on every event. This
 * is the key optimization for high-frequency streams. Before the first event, `append`/`upsert`
 * yield `[]`, `reducer` yields its `initial`, and `replace` yields `undefined` — `select` (and the
 * no-selector return) see the same, so list results are always safe to `.map` immediately.
 *
 * Security & integrity:
 * - The returned value is **untrusted server data** — React escapes it in normal JSX, but apply the
 *   usual hygiene before feeding it to dangerous sinks (`dangerouslySetInnerHTML`, `href`/`src`).
 * - Treat the returned state as **read-only** — do not mutate it in place. Identical subscriptions
 *   share one folded store (dedup), so mutating a returned array/object would corrupt every other
 *   subscriber and break the store's invariants. Copy before transforming.
 */
export function useStream<T>(config: ListConfig<T>): T[];
export function useStream<T, R>(
  config: ListConfig<T>,
  select: (state: T[]) => R,
  isEqual?: (a: R, b: R) => boolean,
): R;
export function useStream<T>(config: ReplaceConfig<T>): T | undefined;
export function useStream<T, R>(
  config: ReplaceConfig<T>,
  select: (state: T | undefined) => R,
  isEqual?: (a: R, b: R) => boolean,
): R;
export function useStream<T, S>(config: ReducerConfig<T, S>): S;
export function useStream<T, S, R>(
  config: ReducerConfig<T, S>,
  select: (state: S) => R,
  isEqual?: (a: R, b: R) => boolean,
): R;
export function useStream<T, S = T, R = unknown>(
  config: SubscribeConfig<T, S> & EnabledOption,
  select?: (state: T[] | T | S | undefined) => R,
  isEqual: (a: R, b: R) => boolean = Object.is,
): T[] | T | S | undefined | R {
  const client = useClient();
  const { channel, params, into } = config;
  const enabled = config.enabled !== false; // default true

  // A stable identity for the wire subscription, mirroring core's subscription identity (channel +
  // params + strategy) plus `enabled`. `useSyncExternalStore` re-subscribes when `subscribe` changes
  // identity, so keying it on this — not just `channel` — tears down the old subscription and opens
  // the new one whenever `params`, the fold `strategy`, or `enabled` change. Without it the component
  // would silently keep the OLD subscription and render the wrong stream's data.
  const key = channel + '|' + JSON.stringify(params ?? null) + '|' + into.strategy + '|' + enabled;

  // All per-instance mutable state lives in ONE lazily-initialised ref (one hook slot, one object),
  // including the selector memo. Nothing is allocated per render — the latest render inputs are just
  // reassigned onto it (a `useRef({...})` would re-allocate its initial object on every render).
  type Out = T[] | T | S | undefined | R;
  const ref = useRef<{
    config: SubscribeConfig<T, S>;
    select: ((state: T[] | T | S | undefined) => R) | undefined;
    isEqual: (a: R, b: R) => boolean;
    sub: Subscription<T, S> | null;
    initial: Out;
    memo: SnapshotMemo<Out>;
  } | null>(null);
  const inst = (ref.current ??= {
    config,
    select,
    isEqual,
    sub: null,
    // Stable initial (computed once) so the first render — before subscribe — returns `[]` for list
    // strategies etc., never `undefined`. Same reference each call keeps `useSyncExternalStore` happy.
    initial: initialState(config.into),
    memo: new SnapshotMemo<Out>(),
  });
  inst.config = config;
  inst.select = select;
  inst.isEqual = isEqual;

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const i = ref.current!;
      if (!enabled) return () => {}; // disabled → no wire subscription; getSnapshot returns initial
      const sub = client.subscribe(i.config);
      i.sub = sub;
      const off = sub.subscribe(onStoreChange);
      return () => {
        off();
        sub.destroy();
        i.sub = null;
      };
    },
    // Subscription lifecycle is owned by React: re-run when the client or the subscription identity
    // (channel + params + strategy + enabled, via `key`) changes — a clean teardown + re-subscribe.
    [client, key, enabled],
  );

  // Snapshot memoisation is encapsulated in SnapshotMemo. `select` maps the raw state and `isEqual`
  // compares the selected value — runtime-compatible with the memo's `Out` type, so these casts are
  // confined to this single boundary.
  const getSnapshot = useCallback((): Out => {
    const i = ref.current!;
    return i.memo.read(
      i.sub ? i.sub.getState() : i.initial, // stable initial before subscribe → never undefined for lists
      i.select as ((input: unknown) => Out) | undefined,
      i.isEqual as (a: Out, b: Out) => boolean,
    );
  }, []);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Read the connection state and re-render on every transition — handy for a global status pill.
 */
export function useConnection(): ConnectionState {
  const client = useClient();
  const subscribe = useCallback(
    (onStoreChange: () => void) => client.onConnectionChange(onStoreChange),
    [client],
  );
  const getSnapshot = useCallback(() => client.getConnectionState(), [client]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Connection status plus the most recent transport error (cleared once the link reopens). */
export interface ConnectionStatus {
  status: ConnectionState;
  error: unknown;
}

/**
 * Like {@link useConnection}, but also surfaces the latest transport `error`. The connection is
 * shared across every `useStream`, so this is the status/error for the whole client. `error` holds
 * the last error the adapter reported and is cleared automatically whenever the link (re)opens —
 * render a reconnecting banner or a retry affordance from it.
 */
export function useConnectionStatus(): ConnectionStatus {
  const client = useClient();
  const status = useConnection();
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    // event-driven: record the last error; clear it the moment the link is healthy again
    const offError = client.onError((err) => setError(err));
    const offState = client.onConnectionChange((next) => {
      if (next === 'open') setError(null);
    });
    return () => {
      offError();
      offState();
    };
  }, [client]);

  return { status, error };
}

/** The fire-and-forget publish function returned by {@link usePublish}. */
export type PublishFn = (
  channel: string,
  event: string,
  payload: unknown,
  opts?: PublishOptions,
) => void;

/**
 * Returns a stable function that sends a fire-and-forget command to the server (client→server).
 * Same client and connection as every `useStream`, so no extra wiring. It throws if the connection
 * is not open or the transport can't publish — call it from an event handler and handle the error
 * (a request/response `useCommand` with pending/error state lands in a later version).
 */
export function usePublish(): PublishFn {
  const client = useClient();
  return useCallback<PublishFn>(
    (channel, event, payload, opts) => client.publish(channel, event, payload, opts),
    [client],
  );
}

/** Lifecycle of a {@link useCommand} call. */
export type CommandStatus = 'idle' | 'pending' | 'success' | 'error';

/** The handle returned by {@link useCommand} — a react-query-style mutation over a request/response. */
export interface CommandResult<Res, Req> {
  /** Fire the request; updates `status`/`data`/`error`. Rejections are swallowed (read `error`). */
  mutate: (payload: Req) => void;
  /** Like `mutate`, but returns the promise so you can `await` and try/catch it. */
  mutateAsync: (payload: Req) => Promise<Res>;
  status: CommandStatus;
  data: Res | undefined;
  error: unknown;
  /** Return to the `idle` state, clearing `data`/`error`. */
  reset: () => void;
}

/**
 * Request/response (client→server RPC) as a stateful hook — same client and connection as every
 * `useStream`, no extra wiring. Call `mutate(payload)` from an event handler; read `status` /
 * `data` / `error` to drive the UI. Modeled on react-query's `useMutation` for zero learning curve.
 */
export function useCommand<Res = unknown, Req = unknown>(
  channel: string,
  event: string,
  opts?: RequestOptions,
): CommandResult<Res, Req> {
  const client = useClient();
  const [state, setState] = useState<{ status: CommandStatus; data: Res | undefined; error: unknown }>({
    status: 'idle',
    data: undefined,
    error: undefined,
  });

  // Latest opts without destabilizing the callbacks; and a guard against setState after unmount.
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const mutateAsync = useCallback(
    (payload: Req): Promise<Res> => {
      setState({ status: 'pending', data: undefined, error: undefined });
      return client.request<Res>(channel, event, payload, optsRef.current).then(
        (data) => {
          if (mountedRef.current) setState({ status: 'success', data, error: undefined });
          return data;
        },
        (error) => {
          if (mountedRef.current) setState({ status: 'error', data: undefined, error });
          throw error;
        },
      );
    },
    [client, channel, event],
  );

  const mutate = useCallback(
    (payload: Req): void => {
      void mutateAsync(payload).catch(() => {
        /* error is captured in state; swallow the rejection so it isn't an unhandled promise */
      });
    },
    [mutateAsync],
  );

  const reset = useCallback(
    () => setState({ status: 'idle', data: undefined, error: undefined }),
    [],
  );

  return { mutate, mutateAsync, status: state.status, data: state.data, error: state.error, reset };
}
