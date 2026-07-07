/** Host `setTimeout`/`clearTimeout` without pulling in DOM/Node lib types. */
const timers = globalThis as {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

/** Writability of the link an {@link Outbox} drains into. */
export type SinkState = 'ready' | 'congested' | 'closed';

/** The destination an {@link Outbox} writes to — decouples queueing from any WebSocket specifics. */
export interface Sink {
  /**
   * `ready` → writable now · `congested` → open but the send buffer is full (retry as it drains) ·
   * `closed` → not open (queued frames wait for the caller to re-push on reopen).
   */
  state(): SinkState;
  /** Transmit one frame; the sink swallows transient send failures. */
  write(data: string): void;
}

/**
 * A memory-lean outbound queue with backpressure, fully self-contained (owns its buffer and timer;
 * exposes only `push` / `reset`). On a healthy link a pushed frame is written straight through, so
 * the buffer never holds more than the one just-pushed frame; while the sink is `congested` frames
 * accumulate and drain — via a single splice, never O(n²) shifting — as it clears, polled because a
 * WebSocket has no drain event; while `closed` they wait for a re-push.
 */
export class Outbox {
  private readonly queue: string[] = [];
  private timer: unknown = null;

  constructor(
    private readonly sink: Sink,
    private readonly pollMs: number,
  ) {}

  /** Queue a frame and attempt to drain immediately. */
  push(data: string): void {
    this.queue.push(data);
    this.flush();
  }

  /** Drop everything pending and cancel any scheduled retry — call on (re)connect and teardown. */
  reset(): void {
    if (this.timer !== null) {
      timers.clearTimeout(this.timer);
      this.timer = null;
    }
    this.queue.length = 0;
  }

  private flush(): void {
    let sent = 0;
    while (sent < this.queue.length && this.sink.state() === 'ready') {
      this.sink.write(this.queue[sent]!);
      sent += 1;
    }
    if (sent > 0) this.queue.splice(0, sent); // drop the sent prefix in one op
    if (this.queue.length > 0 && this.sink.state() === 'congested') this.schedule();
    // when 'closed', leave the queue intact for the next reopen (no reschedule)
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = timers.setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.pollMs);
  }
}
