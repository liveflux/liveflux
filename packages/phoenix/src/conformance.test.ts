import type { Cursor, NormalizedEvent, SubscribeRequest } from '@liveflux/core';
import { type AdapterHarness, runAdapterConformance } from '@liveflux/adapter-tests';
import { phoenix, type PhoenixMessage, type PhoenixOptions } from './index';

/**
 * A controllable WebSocket double that speaks Phoenix v2 frames. The same fake the adapter's own
 * unit tests use, exposing `open` / `emit` / `drop` so a test can play the server. One instance is
 * created per (re)connect, so `instances` records the full socket history — which the harness
 * aggregates to see every frame the adapter has ever sent, across reconnects.
 */
class FakeWebSocket {
  readyState = 0; // CONNECTING
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(readonly instances: FakeWebSocket[]) {
    instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
  drop(reason?: unknown): void {
    this.readyState = 3;
    this.onclose?.(reason);
  }
}

/**
 * Recover the `subId` from a composite `join_ref` (`` `${subId}#${instance}` ``). The adapter mints
 * a fresh join instance per join so a superseded channel's late frames can be filtered, but the
 * `subId` — what the core speaks — is the part before the last `#`.
 */
function recoverSubId(joinRef: string): string {
  const i = joinRef.lastIndexOf('#');
  return i < 0 ? joinRef : joinRef.slice(0, i);
}

/**
 * Decode a captured `phx_join` frame back to the transport-neutral `SubscribeRequest` the core
 * speaks. The `subId` is recovered from the composite `join_ref` in the frame's first element; the
 * topic is the `channel`; a non-empty join payload is the `params`.
 */
function joinFrame(raw: string): SubscribeRequest | null {
  const [joinRef, , topic, event, payload] = JSON.parse(raw) as PhoenixMessage;
  if (event !== 'phx_join' || joinRef === null) return null;
  const params = payload as Record<string, unknown>;
  const hasParams = params != null && Object.keys(params).length > 0;
  return { subId: recoverSubId(joinRef), channel: topic, ...(hasParams ? { params } : {}) };
}

function leaveSubId(raw: string): string | null {
  const [joinRef, , , event] = JSON.parse(raw) as PhoenixMessage;
  return event === 'phx_leave' && joinRef !== null ? recoverSubId(joinRef) : null;
}

/**
 * Phoenix Channels carry no native since-cursor slot, so the reference server encodes the full
 * `NormalizedEvent` into a small payload envelope and a matching `decode` lifts `cursor` / `meta`
 * back out. This proves the adapter surfaces exactly what its decode seam returns (cursor / meta
 * preserved end-to-end), which is what the shared contract asserts.
 */
interface Envelope {
  payload: unknown;
  cursor?: Cursor;
  meta?: Record<string, unknown>;
}

const decodeEnveloped = (message: PhoenixMessage): NormalizedEvent => {
  const [, , topic, event, payload] = message;
  const env = (payload ?? {}) as Envelope;
  return {
    channel: topic,
    event,
    payload: env.payload,
    ...(env.cursor !== undefined ? { cursor: env.cursor } : {}),
    ...(env.meta !== undefined ? { meta: env.meta } : {}),
  };
};

const encodeEnveloped = (event: NormalizedEvent): string => {
  const envelope: Envelope = {
    payload: event.payload,
    ...(event.cursor !== undefined ? { cursor: event.cursor } : {}),
    ...(event.meta !== undefined ? { meta: event.meta } : {}),
  };
  // A server-initiated broadcast: no join_ref / ref, routed by topic.
  const frame: PhoenixMessage = [null, null, event.channel, event.event, envelope];
  return JSON.stringify(frame);
};

runAdapterConformance({
  name: '@liveflux/phoenix',
  setup(): AdapterHarness {
    const instances: FakeWebSocket[] = [];
    const Ctor = class extends FakeWebSocket {
      constructor() {
        super(instances);
      }
    } as unknown as PhoenixOptions['WebSocket'];
    const adapter = phoenix('wss://conformance.test/socket', {
      WebSocket: Ctor,
      decode: decodeEnveloped,
    });
    const latest = () => instances[instances.length - 1]!;
    const allSent = () => instances.flatMap((socket) => socket.sent);

    return {
      adapter,
      open: () => latest().open(),
      emit: (event: NormalizedEvent) => latest().emit(encodeEnveloped(event)),
      drop: (reason) => latest().drop(reason),
      sentSubscribes: () =>
        allSent()
          .map(joinFrame)
          .filter((sub): sub is SubscribeRequest => sub !== null),
      sentUnsubscribes: () =>
        allSent()
          .map(leaveSubId)
          .filter((id): id is string => id !== null),
      // `@liveflux/phoenix` does not implement the optional `resume` capability (Phoenix Channels
      // have no native since-cursor), so the resume scenario is skipped for it (no `sentResumes`).
    };
  },
});
