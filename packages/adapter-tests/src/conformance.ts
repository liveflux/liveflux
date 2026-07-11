import { describe, expect, it } from 'vitest';
import type {
  AdapterHandlers,
  Cursor,
  NormalizedEvent,
  StreamAdapter,
  SubscribeRequest,
} from '@liveflux/core';

/** A value that may be produced synchronously or asynchronously. */
export type MaybePromise<T> = T | Promise<T>;

/** A resume frame the adapter sent to the server, decoded back to its logical shape. */
export interface ResumeFrame {
  subId: string;
  cursor: Cursor | null;
}

/**
 * The seam between the shared conformance suite and one concrete adapter. A harness owns a single
 * freshly-created adapter and knows how to (a) play the server for it and (b) observe what the
 * adapter put on the wire — decoded back to the transport-neutral core shapes so every adapter is
 * asserted against the identical contract.
 *
 * The suite drives the adapter's own {@link StreamAdapter} methods directly (that is how the core
 * drives it); the harness only simulates the *server side* and reports what was sent.
 */
export interface AdapterHarness {
  /** The adapter under test — the suite calls `connect` / `subscribe` / … on it. */
  readonly adapter: StreamAdapter;

  /** Play the server: accept the current connection. The adapter must fire `onOpen`. */
  open(): MaybePromise<void>;
  /** Play the server: deliver one event on the live connection. The adapter must fire `onEvent`. */
  emit(event: NormalizedEvent): MaybePromise<void>;
  /** Play the server: unexpectedly close the live connection. The adapter must fire `onClose`. */
  drop(reason?: unknown): MaybePromise<void>;
  /**
   * Play the server: surface a transport-level error on the live connection. The adapter must fire
   * `onError` with the value passed here. Provide this only for adapters whose harness can inject an
   * error (e.g. the socket's error path); omit it otherwise and the onError scenario is skipped.
   */
  fail?(err: unknown): MaybePromise<void>;

  /** Every subscribe frame the adapter has sent, in order — including reconnect replays. */
  sentSubscribes(): readonly SubscribeRequest[];
  /** The subIds the adapter has sent an unsubscribe frame for, in order. */
  sentUnsubscribes(): readonly string[];
  /**
   * Every resume frame the adapter has sent, in order. Provide this only for adapters that
   * implement the optional `resume` capability; omit it otherwise and the resume scenario is
   * skipped.
   */
  sentResumes?(): readonly ResumeFrame[];
  /**
   * How many heartbeat keepalive frames the adapter has put on the wire so far. Provide this only
   * for adapters that emit an observable keepalive frame from `heartbeat()`; omit it otherwise and
   * the heartbeat scenario is skipped.
   */
  sentHeartbeats?(): number;
}

/** Options for {@link runAdapterConformance}. */
export interface AdapterConformanceOptions {
  /** Label for the `describe` block, e.g. the adapter package name. */
  name: string;
  /**
   * Build a pristine adapter + harness for a single scenario. Invoked once per test, so no state
   * leaks between scenarios. May be async (e.g. to stand up a fresh reference server).
   */
  setup(): MaybePromise<AdapterHarness>;
  /** Optional per-scenario cleanup (close servers, restore timers, …). */
  teardown?(harness: AdapterHarness): MaybePromise<void>;
}

/** Records everything the adapter reports back through the {@link AdapterHandlers} contract. */
interface Recorder extends AdapterHandlers {
  opens: number;
  closes: number;
  errors: number;
  closeReasons: unknown[];
  errorValues: unknown[];
  events: NormalizedEvent[];
}

function recorder(): Recorder {
  const rec: Recorder = {
    opens: 0,
    closes: 0,
    errors: 0,
    closeReasons: [],
    errorValues: [],
    events: [],
    onOpen() {
      rec.opens += 1;
    },
    onClose(reason?: unknown) {
      rec.closes += 1;
      rec.closeReasons.push(reason);
    },
    onError(err: unknown) {
      rec.errors += 1;
      rec.errorValues.push(err);
    },
    onEvent(event: NormalizedEvent) {
      rec.events.push(event);
    },
  };
  return rec;
}

/** Count how many sent subscribe frames carry each subId. */
function countBySubId(frames: readonly SubscribeRequest[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const frame of frames) counts.set(frame.subId, (counts.get(frame.subId) ?? 0) + 1);
  return counts;
}

/**
 * Register the shared adapter-conformance suite for one adapter. Call it at the top level of a test
 * file in the adapter's package; it declares a `describe` block of `it` scenarios proving the adapter
 * honours the core's `StreamAdapter` contract identically to every other adapter.
 *
 * Contract proven (each scenario maps to real core behaviour):
 *
 * 1. **connect → onOpen.** The core opens the adapter and waits for `onOpen` before it is `open`.
 * 2. **subscribe encodes a faithful SubscribeRequest.** The registry hands the adapter a
 *    `{ subId, channel, params? }`; the adapter must transmit exactly that (params included).
 * 3. **subscribe-before-open sends exactly one frame per subId.** A subscribe issued while the link
 *    is still opening must not be lost *nor* double-sent: on open the adapter replays the active set
 *    and each subId appears exactly once on the wire (no eager-push + replay duplication).
 * 4. **a server event surfaces as a normalized onEvent.** The adapter decodes the wire frame into a
 *    transport-neutral `NormalizedEvent` (channel / event / payload / cursor / meta preserved).
 * 5. **multi-channel routing has no cross-talk.** With two channels live, an event on one surfaces
 *    once carrying that channel; an event on the other surfaces once carrying the other.
 * 6. **event order is preserved.** Events emitted A, B, C surface in that order.
 * 7. **unsubscribe sends its frame and is not replayed on reconnect.** Event *filtering* is the
 *    core's job (the registry drops events for dropped channels); the adapter's guarantee is that it
 *    sends the unsubscribe frame and removes the sub from the set it replays on reopen.
 * 8. **an unknown / already-removed unsubscribe is a no-op.** It must not throw or emit a spurious
 *    unsubscribe frame.
 * 9. **an unexpected drop → onClose, then reconnect replays each active sub exactly once.** The core
 *    reacts to `onClose` by calling `connect` again (never `subscribe`), so the adapter must replay
 *    every active subscription on the fresh connection — once each, at any scale.
 * 10. **resume-from-cursor (optional, v0.2).** If the adapter implements `resume`, calling
 *    `resume(subId, cursor)` transmits a gap-recovery frame carrying exactly that cursor (and a
 *    `null` cursor for a from-scratch resync). Skipped for adapters without the capability.
 * 11. **onError surfacing (optional seam `fail`).** A transport error injected via the harness
 *    surfaces through `onError` with the same value. Skipped when the harness can't inject one.
 * 12. **heartbeat keepalive (optional seam `sentHeartbeats`).** Each `heartbeat()` while open puts
 *    exactly one keepalive frame on the wire; none is sent while the link is not open. Skipped when
 *    the adapter emits no observable keepalive frame.
 * 13. **disconnect cleans up.** After `disconnect` no further server activity reaches the handlers.
 *
 * TODO: a channel-level error → rejoin scenario (a single channel erroring while the socket stays up)
 * needs fake-timer control over the adapter's backoff and a per-channel-error harness seam; deferred.
 */
export function runAdapterConformance(options: AdapterConformanceOptions): void {
  const { name, setup, teardown } = options;

  describe(`adapter conformance: ${name}`, () => {
    async function withHarness(run: (h: AdapterHarness, rec: Recorder) => Promise<void>) {
      const harness = await setup();
      const rec = recorder();
      try {
        harness.adapter.connect(rec);
        await run(harness, rec);
      } finally {
        await teardown?.(harness);
      }
    }

    it('opens the connection and fires onOpen', async () => {
      await withHarness(async (h, rec) => {
        expect(rec.opens).toBe(0);
        await h.open();
        expect(rec.opens).toBe(1);
      });
    });

    it('encodes a subscribe as a faithful SubscribeRequest (params included)', async () => {
      await withHarness(async (h) => {
        await h.open();
        const sub: SubscribeRequest = {
          subId: 'sub_1',
          channel: 'orders',
          params: { region: 'eu', tier: 2 },
        };
        h.adapter.subscribe(sub);
        expect(h.sentSubscribes()).toEqual([sub]);
      });
    });

    it('sends exactly one subscribe frame per subId when subscribing before open', async () => {
      await withHarness(async (h) => {
        const subs: SubscribeRequest[] = [
          { subId: 'sub_1', channel: 'orders' },
          { subId: 'sub_2', channel: 'trades', params: { symbol: 'ACME' } },
        ];
        for (const sub of subs) h.adapter.subscribe(sub); // subscribe BEFORE the link is open
        await h.open(); // the adapter replays its active set on open

        const counts = countBySubId(h.sentSubscribes());
        for (const sub of subs) {
          // exactly once: not lost (>=1) and not duplicated by an eager push + reopen replay
          expect(counts.get(sub.subId)).toBe(1);
        }
      });
    });

    it('surfaces an inbound server event as a normalized onEvent', async () => {
      await withHarness(async (h, rec) => {
        await h.open();
        h.adapter.subscribe({ subId: 'sub_1', channel: 'orders' });
        const event: NormalizedEvent = {
          channel: 'orders',
          event: 'update',
          payload: { id: 7, status: 'filled' },
          cursor: 'cursor-1',
        };
        await h.emit(event);
        expect(rec.events).toEqual([event]);
      });
    });

    it('routes events by channel with no cross-talk', async () => {
      await withHarness(async (h, rec) => {
        await h.open();
        h.adapter.subscribe({ subId: 'sub_a', channel: 'A' });
        h.adapter.subscribe({ subId: 'sub_b', channel: 'B' });

        const onA: NormalizedEvent = { channel: 'A', event: 'update', payload: 1 };
        await h.emit(onA);
        expect(rec.events).toEqual([onA]); // fired once, carrying channel 'A'

        const onB: NormalizedEvent = { channel: 'B', event: 'update', payload: 2 };
        await h.emit(onB);
        expect(rec.events).toEqual([onA, onB]); // one more, carrying channel 'B' — no A duplicate
      });
    });

    it('preserves the order of inbound events', async () => {
      await withHarness(async (h, rec) => {
        await h.open();
        h.adapter.subscribe({ subId: 'sub_1', channel: 'orders' });
        const ordered: NormalizedEvent[] = [
          { channel: 'orders', event: 'a', payload: 1 },
          { channel: 'orders', event: 'b', payload: 2 },
          { channel: 'orders', event: 'c', payload: 3 },
        ];
        for (const event of ordered) await h.emit(event);
        expect(rec.events).toEqual(ordered);
      });
    });

    it('sends an unsubscribe frame and does not replay it after reconnect', async () => {
      await withHarness(async (h) => {
        await h.open();
        h.adapter.subscribe({ subId: 'sub_1', channel: 'orders' });
        h.adapter.unsubscribe('sub_1');
        expect(h.sentUnsubscribes()).toEqual(['sub_1']);

        const before = h.sentSubscribes().length;
        h.adapter.connect(recorder()); // the core reconnects by re-opening the adapter
        await h.open();
        const replayed = h.sentSubscribes().slice(before);
        expect(replayed.some((frame) => frame.subId === 'sub_1')).toBe(false);
      });
    });

    it('treats an unknown or already-removed unsubscribe as a no-op', async () => {
      await withHarness(async (h) => {
        await h.open();
        // never subscribed → no throw and no spurious frame
        expect(() => h.adapter.unsubscribe('never-subscribed')).not.toThrow();
        expect(h.sentUnsubscribes()).toEqual([]);

        h.adapter.subscribe({ subId: 'sub_1', channel: 'orders' });
        h.adapter.unsubscribe('sub_1');
        expect(h.sentUnsubscribes()).toEqual(['sub_1']);

        // already removed → still exactly one frame, no throw
        expect(() => h.adapter.unsubscribe('sub_1')).not.toThrow();
        expect(h.sentUnsubscribes()).toEqual(['sub_1']);
      });
    });

    it('reconnects after an unexpected drop and replays each active sub exactly once', async () => {
      await withHarness(async (h, rec) => {
        await h.open();
        // Scale up so a per-sub double-replay bug can't hide behind a lenient count.
        const subs: SubscribeRequest[] = Array.from({ length: 20 }, (_, i) => ({
          subId: `sub_${i + 1}`,
          channel: `channel_${i + 1}`,
          params: { i },
        }));
        for (const sub of subs) h.adapter.subscribe(sub);

        await h.drop('network-loss');
        expect(rec.closes).toBe(1);
        expect(rec.closeReasons).toEqual(['network-loss']);

        const before = h.sentSubscribes().length;
        h.adapter.connect(rec); // core's reconnect: connect again, never subscribe again
        await h.open();

        const replayed = countBySubId(h.sentSubscribes().slice(before));
        expect(replayed.size).toBe(subs.length); // every active sub replayed, and only those
        for (const sub of subs) expect(replayed.get(sub.subId)).toBe(1); // exactly once each
      });
    });

    it('resumes from a cursor when the adapter supports it (optional, v0.2)', async () => {
      await withHarness(async (h) => {
        const resume = h.adapter.resume;
        if (typeof resume !== 'function' || typeof h.sentResumes !== 'function') return; // capability absent → skip
        await h.open();
        h.adapter.subscribe({ subId: 'sub_1', channel: 'orders' });
        await h.emit({ channel: 'orders', event: 'update', payload: 1, cursor: 'cursor-1' });

        resume.call(h.adapter, 'sub_1', 'cursor-1');
        resume.call(h.adapter, 'sub_1', null); // a null cursor means "resync from scratch"
        expect(h.sentResumes()).toEqual([
          { subId: 'sub_1', cursor: 'cursor-1' },
          { subId: 'sub_1', cursor: null },
        ]);
      });
    });

    it('surfaces a transport error through onError when the harness can inject one', async () => {
      await withHarness(async (h, rec) => {
        if (typeof h.fail !== 'function') return; // seam absent → skip
        await h.open();
        const err = new Error('transport-boom');
        await h.fail(err);
        expect(rec.errors).toBe(1);
        expect(rec.errorValues).toEqual([err]); // the exact value flows through
      });
    });

    it('emits one keepalive per heartbeat while open, and none while closed', async () => {
      await withHarness(async (h) => {
        const heartbeat = h.adapter.heartbeat;
        if (typeof heartbeat !== 'function' || typeof h.sentHeartbeats !== 'function') return; // skip
        heartbeat.call(h.adapter); // not open yet
        expect(h.sentHeartbeats()).toBe(0); // no keepalive on a closed link

        await h.open();
        heartbeat.call(h.adapter);
        heartbeat.call(h.adapter);
        expect(h.sentHeartbeats()).toBe(2); // one wire keepalive per heartbeat() while open
      });
    });

    it('cleans up on disconnect: no server activity reaches the handlers afterward', async () => {
      await withHarness(async (h, rec) => {
        await h.open();
        h.adapter.subscribe({ subId: 'sub_1', channel: 'orders' });
        h.adapter.disconnect();
        await h.emit({ channel: 'orders', event: 'update', payload: 1 });
        expect(rec.events).toEqual([]);
      });
    });
  });
}
