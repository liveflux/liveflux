import type { NormalizedEvent, SubscribeRequest } from '@liveflux/core';
import {
  type AdapterHarness,
  type ResumeFrame,
  runAdapterConformance,
} from '@liveflux/adapter-tests';
import { sse, type SseControlFrame, type SseOptions } from './index';

/**
 * A controllable EventSource double: exposes `open` / `emit` / `drop` so a test can play the server.
 * One instance is created per (re)connect, so `instances` records the full history — which the
 * harness aggregates to see the latest live stream.
 */
class FakeEventSource {
  readyState = 0; // CONNECTING
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown; lastEventId?: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;

  constructor(readonly instances: FakeEventSource[]) {
    instances.push(this);
  }
  close(): void {
    this.readyState = 2; // CLOSED
  }
  open(): void {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }
  emit(data: unknown, lastEventId = ''): void {
    this.onmessage?.({ data, lastEventId });
  }
  drop(reason?: unknown): void {
    this.readyState = 2;
    this.onerror?.(reason);
  }
}

runAdapterConformance({
  name: '@liveflux/sse',
  setup(): AdapterHarness {
    const instances: FakeEventSource[] = [];
    const Ctor = class extends FakeEventSource {
      constructor() {
        super(instances);
      }
    } as unknown as SseOptions['EventSource'];

    // Upstream control frames are captured via a function `control` (no real HTTP in the suite).
    const sent: SseControlFrame[] = [];
    const adapter = sse('https://conformance.test/stream', {
      EventSource: Ctor,
      control: (frame) => {
        sent.push(frame);
      },
    });
    const latest = () => instances[instances.length - 1]!;

    return {
      adapter,
      open: () => latest().open(),
      // Serialize the whole event (cursor included) as the SSE `data`, mirroring lastEventId too.
      emit: (event: NormalizedEvent) => latest().emit(JSON.stringify(event), event.cursor ?? ''),
      drop: (reason) => latest().drop(reason),
      sentSubscribes: (): SubscribeRequest[] =>
        sent
          .filter((f): f is Extract<SseControlFrame, { type: 'subscribe' }> => f.type === 'subscribe')
          .map((f) => ({
            subId: f.subId,
            channel: f.channel,
            ...(f.params !== undefined ? { params: f.params } : {}),
          })),
      sentUnsubscribes: (): string[] =>
        sent.filter((f) => f.type === 'unsubscribe').map((f) => f.subId),
      sentResumes: (): ResumeFrame[] =>
        sent
          .filter((f): f is Extract<SseControlFrame, { type: 'resume' }> => f.type === 'resume')
          .map((f) => ({ subId: f.subId, cursor: f.cursor })),
      // EventSource collapses transient + permanent failures into one error signal, which the adapter
      // maps to onClose (so the core reconnects). It has no distinct onError seam and no keepalive
      // frame, so those optional scenarios are skipped. onError-on-control-failure is unit-tested.
    };
  },
});
