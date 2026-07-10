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
 * 3. **a server event surfaces as a normalized onEvent.** The adapter decodes the wire frame into a
 *    transport-neutral `NormalizedEvent` (channel / event / payload / cursor / meta preserved).
 * 4. **unsubscribe sends its frame and is not replayed on reconnect.** Event *filtering* is the
 *    core's job (the registry drops events for dropped channels); the adapter's guarantee is that it
 *    sends the unsubscribe frame and removes the sub from the set it replays on reopen.
 * 5. **an unexpected drop → onClose, then reconnect re-subscribes the active set.** The core reacts
 *    to `onClose` by calling `connect` again (never `subscribe`), so the adapter must replay every
 *    active subscription on the fresh connection.
 * 6. **resume-from-cursor (optional, v0.2).** If the adapter implements `resume`, calling
 *    `resume(subId, cursor)` transmits a gap-recovery frame carrying exactly that cursor (and a
 *    `null` cursor for a from-scratch resync). Skipped for adapters without the capability.
 * 7. **disconnect cleans up.** After `disconnect` no further server activity reaches the handlers.
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

    it('reconnects after an unexpected drop and re-subscribes the active set', async () => {
      await withHarness(async (h, rec) => {
        await h.open();
        const subs: SubscribeRequest[] = [
          { subId: 'sub_1', channel: 'orders' },
          { subId: 'sub_2', channel: 'trades', params: { symbol: 'ACME' } },
        ];
        for (const sub of subs) h.adapter.subscribe(sub);

        await h.drop('network-loss');
        expect(rec.closes).toBe(1);
        expect(rec.closeReasons).toEqual(['network-loss']);

        const before = h.sentSubscribes().length;
        h.adapter.connect(rec); // core's reconnect: connect again, never subscribe again
        await h.open();

        const replayed = countBySubId(h.sentSubscribes().slice(before));
        for (const sub of subs) expect(replayed.get(sub.subId) ?? 0).toBeGreaterThanOrEqual(1);
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
