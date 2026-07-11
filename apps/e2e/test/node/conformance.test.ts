import type { Cursor, NormalizedEvent, SubscribeRequest } from '@liveflux/core';
import { type AdapterHarness, runAdapterConformance } from '@liveflux/adapter-tests';
import { ws, type OutboundFrame, type WsOptions } from '@liveflux/ws';
import { phoenix, type PhoenixMessage, type PhoenixOptions } from '@liveflux/phoenix';
import { ControllableSocket, controllableCtor } from '../support/controllable-socket';

/**
 * Cross-adapter conformance gate (re-run inside the E2E suite). The shared, protocol-agnostic
 * `runAdapterConformance` suite is executed against **both** real adapters here too, so the E2E
 * boundary also enforces that `@liveflux/ws` and `@liveflux/phoenix` honour the identical
 * `StreamAdapter` contract. The adapters are real; only the transport is a controllable double
 * (the deterministic Layer-1 tool the harness contract is built around).
 */

// ---- @liveflux/ws harness ----

function wsSubscribeFrame(raw: string): SubscribeRequest | null {
  const frame = JSON.parse(raw) as OutboundFrame;
  if (frame.type !== 'subscribe') return null;
  return {
    subId: frame.subId,
    channel: frame.channel,
    ...(frame.params !== undefined ? { params: frame.params } : {}),
  };
}
function wsUnsubscribeSubId(raw: string): string | null {
  const frame = JSON.parse(raw) as OutboundFrame;
  return frame.type === 'unsubscribe' ? frame.subId : null;
}
function wsIsHeartbeat(raw: string): boolean {
  return (JSON.parse(raw) as OutboundFrame).type === 'heartbeat';
}

runAdapterConformance({
  name: '@liveflux/ws (e2e)',
  setup(): AdapterHarness {
    const instances: ControllableSocket[] = [];
    const adapter = ws('wss://e2e.test', {
      WebSocket: controllableCtor(instances) as WsOptions['WebSocket'],
    });
    const latest = () => instances[instances.length - 1]!;
    const allSent = () => instances.flatMap((s) => s.sent);
    return {
      adapter,
      open: () => latest().open(),
      emit: (event: NormalizedEvent) => latest().emit(JSON.stringify(event)),
      drop: (reason) => latest().drop(reason),
      fail: (err) => latest().error(err),
      sentSubscribes: () =>
        allSent()
          .map(wsSubscribeFrame)
          .filter((s): s is SubscribeRequest => s !== null),
      sentUnsubscribes: () =>
        allSent()
          .map(wsUnsubscribeSubId)
          .filter((id): id is string => id !== null),
      sentHeartbeats: () => allSent().filter(wsIsHeartbeat).length,
    };
  },
});

// ---- @liveflux/phoenix harness ----

interface Envelope {
  payload: unknown;
  cursor?: Cursor;
  meta?: Record<string, unknown>;
}

function recoverSubId(joinRef: string): string {
  const i = joinRef.lastIndexOf('#');
  return i < 0 ? joinRef : joinRef.slice(0, i);
}
function phxJoinFrame(raw: string): SubscribeRequest | null {
  const [joinRef, , topic, event, payload] = JSON.parse(raw) as PhoenixMessage;
  if (event !== 'phx_join' || joinRef === null) return null;
  const params = payload as Record<string, unknown>;
  const hasParams = params != null && Object.keys(params).length > 0;
  return { subId: recoverSubId(joinRef), channel: topic, ...(hasParams ? { params } : {}) };
}
function phxLeaveSubId(raw: string): string | null {
  const [joinRef, , , event] = JSON.parse(raw) as PhoenixMessage;
  return event === 'phx_leave' && joinRef !== null ? recoverSubId(joinRef) : null;
}
const encodeEnveloped = (event: NormalizedEvent): string => {
  const envelope: Envelope = {
    payload: event.payload,
    ...(event.cursor !== undefined ? { cursor: event.cursor } : {}),
    ...(event.meta !== undefined ? { meta: event.meta } : {}),
  };
  const frame: PhoenixMessage = [null, null, event.channel, event.event, envelope];
  return JSON.stringify(frame);
};
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

runAdapterConformance({
  name: '@liveflux/phoenix (e2e)',
  setup(): AdapterHarness {
    const instances: ControllableSocket[] = [];
    const adapter = phoenix('wss://e2e.test/socket', {
      WebSocket: controllableCtor(instances) as PhoenixOptions['WebSocket'],
      decode: decodeEnveloped,
    });
    const latest = () => instances[instances.length - 1]!;
    const allSent = () => instances.flatMap((s) => s.sent);
    return {
      adapter,
      open: () => latest().open(),
      emit: (event: NormalizedEvent) => latest().emit(encodeEnveloped(event)),
      drop: (reason) => latest().drop(reason),
      fail: (err) => latest().error(err),
      sentSubscribes: () =>
        allSent()
          .map(phxJoinFrame)
          .filter((s): s is SubscribeRequest => s !== null),
      sentUnsubscribes: () =>
        allSent()
          .map(phxLeaveSubId)
          .filter((id): id is string => id !== null),
    };
  },
});
