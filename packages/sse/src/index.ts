import type {
  AdapterHandlers,
  Cursor,
  NormalizedEvent,
  StreamAdapter,
  SubscribeRequest,
} from '@liveflux/core';

/** A minimal EventSource-like object (browser EventSource, a Node polyfill, or a test double). */
interface EventSourceLike {
  readonly readyState: number;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown; lastEventId?: string }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  close(): void;
}
type EventSourceCtor = new (url: string, init?: { withCredentials?: boolean }) => EventSourceLike;

/** The minimal fetch shape used for the upstream control channel. */
type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

/**
 * An upstream control frame. SSE is a one-way (server→client) transport, so subscribe / unsubscribe
 * / resume are sent over a separate channel — by default an HTTP POST alongside the event stream.
 */
export type SseControlFrame =
  | { type: 'subscribe'; subId: string; channel: string; params?: Record<string, unknown> }
  | { type: 'unsubscribe'; subId: string }
  | { type: 'resume'; subId: string; cursor: Cursor | null };

export interface SseOptions {
  /** Forwarded to `EventSource` — send credentials (cookies) with the stream request. */
  withCredentials?: boolean;
  /** EventSource constructor. Default: `globalThis.EventSource`. Inject for Node or tests. */
  EventSource?: EventSourceCtor;
  /**
   * How to send upstream control frames (SSE can't send on the event stream itself):
   * - a URL string → the frame is POSTed there as JSON;
   * - a function → called with the frame (bring your own transport);
   * - omitted → POST to the stream `url` (many servers route POST vs. GET separately).
   */
  control?: string | ((frame: SseControlFrame) => void | Promise<void>);
  /** `fetch` used for the default control POST. Default: `globalThis.fetch`. Inject for tests. */
  fetch?: FetchLike;
  /** Encode a control frame to a request body. Default: `JSON.stringify`. */
  encode?: (frame: SseControlFrame) => string;
  /**
   * Decode an inbound message into a NormalizedEvent, or return `null` to ignore it. Receives the
   * raw `data` and the SSE `lastEventId`. Default: JSON-parse expecting `{ channel, event, payload }`,
   * taking the cursor from the payload's `cursor` or falling back to `lastEventId`.
   */
  decode?: (data: string, lastEventId: string) => NormalizedEvent | null;
  /**
   * Security guard: drop inbound frames longer than this (approx. bytes, as string length) before
   * decoding — bounds memory/CPU from a malicious or buggy server. Set `0` to disable. Default: 1 MiB.
   */
  maxMessageBytes?: number;
}

const OPEN = 1; // EventSource.OPEN
const DEFAULT_MAX_MESSAGE = 1_048_576; // 1 MiB

function defaultDecode(data: string, lastEventId: string): NormalizedEvent | null {
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (
    typeof msg === 'object' &&
    msg !== null &&
    typeof (msg as { channel?: unknown }).channel === 'string' &&
    typeof (msg as { event?: unknown }).event === 'string'
  ) {
    const ev = msg as NormalizedEvent;
    // SSE carries the cursor in the `id:` field (lastEventId); honour it when the payload omits one.
    if (ev.cursor === undefined && lastEventId) return { ...ev, cursor: lastEventId };
    return ev;
  }
  return null;
}

/**
 * Server-Sent Events adapter for `@liveflux/core`. Works with ANY backend that exposes an SSE
 * endpoint, in any language — the downstream event stream is a standard `EventSource`, and because
 * SSE is one-way, subscribe / unsubscribe / resume are sent upstream over a separate control channel
 * (an HTTP POST by default, or your own via `control`).
 *
 * Reconnect-safe: on every (re)open the active subscription set is replayed, so a dropped stream
 * recovers its subscriptions with no work from the consumer. The core drives reconnect (the adapter
 * closes the EventSource on error and fires `onClose`), so there is exactly one reconnect policy —
 * the core's backoff — instead of the browser's opaque auto-retry fighting it. Gap recovery is
 * supported via `resume(subId, cursor)`, which sends a resume control frame (and the default decoder
 * also threads the SSE `lastEventId` through as the cursor).
 *
 * Security: inbound is untrusted. Frames over `maxMessageBytes` are dropped before decoding (DoS
 * bound), and the default decoder accepts only `{ channel, event, … }` objects with string
 * `channel`/`event` — which core routes as Map keys, so there is no prototype-pollution path.
 * Payload is opaque app data. The returned adapter is frozen and all connection state is
 * closure-private.
 *
 * Reconnect auth: pass `url` (and/or a string `control`) as usual; for a rotated token, pass `url`
 * as a function so it is re-resolved on every (re)connect. Credentials (cookies) ride along when
 * `withCredentials` is set.
 */
export function sse(url: string | (() => string), options: SseOptions = {}): StreamAdapter {
  const encode = options.encode ?? JSON.stringify;
  const decode = options.decode ?? defaultDecode;
  const rawMax = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE;
  const messageLimit = rawMax > 0 ? rawMax : Infinity; // <= 0 disables the cap
  const Ctor =
    options.EventSource ??
    ((globalThis as { EventSource?: unknown }).EventSource as EventSourceCtor | undefined);
  const fetchImpl =
    options.fetch ?? ((globalThis as { fetch?: unknown }).fetch as FetchLike | undefined);

  let source: EventSourceLike | null = null;
  let handlers: AdapterHandlers | null = null;
  const isOpen = (): boolean => source !== null && source.readyState === OPEN;
  // subId → its subscribe frame. Immutable once created; replayed verbatim on every reopen.
  const active = new Map<string, Extract<SseControlFrame, { type: 'subscribe' }>>();

  const resolveUrl = (): string => (typeof url === 'function' ? url() : url);

  const onControlError = (err: unknown): void => handlers?.onError(err);

  // Invoke the control transport *synchronously* (so a caller's send is observable on the same tick);
  // only error handling is deferred. A sync throw or an async rejection surfaces through onError and
  // never breaks the calling core method.
  const sendControl = (frame: SseControlFrame): void => {
    try {
      if (typeof options.control === 'function') {
        const r = options.control(frame);
        if (r && typeof (r as Promise<void>).then === 'function') {
          (r as Promise<void>).catch(onControlError);
        }
        return;
      }
      const target = typeof options.control === 'string' ? options.control : resolveUrl();
      fetchImpl!(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: encode(frame),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`@liveflux/sse: control POST failed (${res.status}).`);
        })
        .catch(onControlError);
    } catch (err) {
      onControlError(err);
    }
  };

  const retire = (s: EventSourceLike): void => {
    s.onopen = s.onmessage = s.onerror = null; // detach: no callbacks after this
    try {
      s.close();
    } catch {
      /* already closed */
    }
  };

  return Object.freeze<StreamAdapter>({
    connect(h: AdapterHandlers): void {
      if (!Ctor) {
        throw new Error('@liveflux/sse: no EventSource implementation found — pass options.EventSource.');
      }
      if (typeof options.control !== 'function' && !fetchImpl) {
        throw new Error(
          '@liveflux/sse: no fetch for the control channel — pass options.fetch or a function options.control.',
        );
      }
      handlers = h;
      if (source) retire(source); // never leave a dangling stream behind on reconnect
      const s = new Ctor(resolveUrl(), { withCredentials: options.withCredentials ?? false });
      source = s;
      s.onopen = () => {
        for (const frame of active.values()) sendControl(frame); // replay active subs on (re)open
        h.onOpen();
      };
      s.onmessage = (ev) => {
        const raw = ev.data;
        if (typeof raw !== 'string') return; // SSE data is always text
        if (raw.length > messageLimit) return; // DoS guard before decoding
        const event = decode(raw, ev.lastEventId ?? '');
        if (event) h.onEvent(event);
      };
      // EventSource has one error signal for both transient and permanent failures. Close it and let
      // the core reconnect on its own policy — no double retry from the browser's opaque auto-retry.
      s.onerror = (ev) => {
        if (source !== s) return;
        source = null;
        retire(s);
        h.onClose(ev);
      };
    },

    disconnect(): void {
      const s = source;
      source = null;
      if (s) retire(s);
    },

    subscribe(sub: SubscribeRequest): void {
      const frame: Extract<SseControlFrame, { type: 'subscribe' }> = {
        type: 'subscribe',
        subId: sub.subId,
        channel: sub.channel,
        ...(sub.params !== undefined ? { params: sub.params } : {}),
      };
      active.set(sub.subId, frame); // cache once; replayed on every reopen
      // Send now only if the stream is up; otherwise onopen replays the whole active set (so a
      // subscribe issued before open is never lost and never double-sent).
      if (isOpen()) sendControl(frame);
    },

    unsubscribe(subId: string): void {
      if (!active.has(subId)) return; // idempotent: unknown / already-removed → no frame
      active.delete(subId);
      if (isOpen()) sendControl({ type: 'unsubscribe', subId });
    },

    resume(subId: string, cursor: Cursor | null): void {
      // The control channel is independent of the event stream, so a resume can be sent even while
      // the stream is mid-reconnect.
      sendControl({ type: 'resume', subId, cursor });
    },
  });
}
