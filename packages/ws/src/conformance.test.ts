import type { NormalizedEvent, SubscribeRequest } from '@liveflux/core';
import { type AdapterHarness, runAdapterConformance } from '@liveflux/adapter-tests';
import { ws, type OutboundFrame, type WsOptions } from './index';

/**
 * A controllable WebSocket double: the same fake used by the adapter's own unit tests, exposing
 * `open` / `emit` / `drop` so a test can play the server. One instance is created per (re)connect,
 * so `instances` records the full socket history — which the harness aggregates to see every frame
 * the adapter has ever sent, across reconnects.
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

/** Decode a captured wire frame back to the transport-neutral shape the core contract speaks. */
function subscribeFrame(raw: string): SubscribeRequest | null {
  const frame = JSON.parse(raw) as OutboundFrame;
  if (frame.type !== 'subscribe') return null;
  return {
    subId: frame.subId,
    channel: frame.channel,
    ...(frame.params !== undefined ? { params: frame.params } : {}),
  };
}

function unsubscribeSubId(raw: string): string | null {
  const frame = JSON.parse(raw) as OutboundFrame;
  return frame.type === 'unsubscribe' ? frame.subId : null;
}

runAdapterConformance({
  name: '@liveflux/ws',
  setup(): AdapterHarness {
    const instances: FakeWebSocket[] = [];
    const Ctor = class extends FakeWebSocket {
      constructor() {
        super(instances);
      }
    } as unknown as WsOptions['WebSocket'];
    const adapter = ws('wss://conformance.test', { WebSocket: Ctor });
    const latest = () => instances[instances.length - 1]!;
    const allSent = () => instances.flatMap((socket) => socket.sent);

    return {
      adapter,
      open: () => latest().open(),
      emit: (event: NormalizedEvent) => latest().emit(JSON.stringify(event)),
      drop: (reason) => latest().drop(reason),
      sentSubscribes: () =>
        allSent()
          .map(subscribeFrame)
          .filter((sub): sub is SubscribeRequest => sub !== null),
      sentUnsubscribes: () =>
        allSent()
          .map(unsubscribeSubId)
          .filter((id): id is string => id !== null),
      // `@liveflux/ws` does not implement the optional `resume` capability, so the resume scenario
      // is skipped for it (no `sentResumes`).
    };
  },
});
