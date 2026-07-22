import type { NormalizedEvent, SubscribeRequest } from '@liveflux/core';
import {
  type AdapterHarness,
  type ResumeFrame,
  runAdapterConformance,
} from '@liveflux/adapter-tests';
import { socketio, type SocketLike } from './index';

/** A controllable Socket.IO `Socket` double — the server side is driven via the `server*` helpers. */
class FakeSocket implements SocketLike {
  connected = false;
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  readonly outbound: { event: string; args: unknown[] }[] = [];

  on(event: string, listener: (...args: unknown[]) => void): this {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return this;
  }
  off(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  emit(event: string, ...args: unknown[]): this {
    this.outbound.push({ event, args });
    return this;
  }
  connect(): this {
    return this; // the harness controls the open via serverConnect()
  }
  disconnect(): this {
    this.connected = false;
    this.fire('disconnect', 'io client disconnect');
    return this;
  }

  private fire(event: string, ...args: unknown[]): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) l(...args);
  }
  serverConnect(): void {
    this.connected = true;
    this.fire('connect');
  }
  serverDrop(reason?: unknown): void {
    this.connected = false;
    this.fire('disconnect', reason);
  }
  serverError(err: unknown): void {
    this.fire('connect_error', err);
  }
  serverEmit(event: string, payload: unknown): void {
    this.fire(event, payload);
  }
}

runAdapterConformance({
  name: '@liveflux/socketio',
  setup(): AdapterHarness {
    const socket = new FakeSocket();
    const adapter = socketio(socket); // default eventName 'message', control events subscribe/unsubscribe/resume

    return {
      adapter,
      open: () => socket.serverConnect(),
      emit: (event: NormalizedEvent) => socket.serverEmit('message', event),
      drop: (reason) => socket.serverDrop(reason),
      fail: (err) => socket.serverError(err),
      sentSubscribes: (): SubscribeRequest[] =>
        socket.outbound
          .filter((f) => f.event === 'subscribe')
          .map((f) => f.args[0] as SubscribeRequest),
      sentUnsubscribes: (): string[] =>
        socket.outbound
          .filter((f) => f.event === 'unsubscribe')
          .map((f) => (f.args[0] as { subId: string }).subId),
      sentResumes: (): ResumeFrame[] =>
        socket.outbound
          .filter((f) => f.event === 'resume')
          .map((f) => f.args[0] as ResumeFrame),
      // Socket.IO manages its own Engine.IO ping/pong, so the adapter emits no app-level keepalive —
      // the heartbeat scenario is skipped.
    };
  },
});
