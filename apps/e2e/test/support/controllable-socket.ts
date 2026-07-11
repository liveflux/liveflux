/**
 * A fully controllable in-process WebSocket double. Unlike the real servers used elsewhere in this
 * suite, this one hands the *test* the server side synchronously (`open` / `emit` / `drop` /
 * `error`), which is exactly what the shared `runAdapterConformance` harness needs to drive an
 * adapter deterministically — no timers, no round-trips. The adapter under test is entirely real;
 * only the transport is faked.
 *
 * One instance is created per (re)connect; the shared `instances` array records the full socket
 * history so a harness can aggregate every frame an adapter ever sent, across reconnects.
 */
export class ControllableSocket {
  readyState = 0; // CONNECTING
  bufferedAmount = 0;
  readonly sent: string[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(readonly instances: ControllableSocket[]) {
    instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3; // CLOSED
  }

  // ---- server-side control surface ----
  open(): void {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
  drop(reason?: unknown): void {
    this.readyState = 3;
    this.onclose?.(reason);
  }
  error(err: unknown): void {
    this.onerror?.(err);
  }
}

/** Build a WebSocket-constructor stand-in wired to a shared `instances` history array. */
export function controllableCtor(instances: ControllableSocket[]): unknown {
  return class extends ControllableSocket {
    constructor() {
      super(instances);
    }
  };
}
