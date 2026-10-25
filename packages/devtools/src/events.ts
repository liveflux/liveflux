/**
 * @liveflux/devtools — observability event contract.
 *
 * The typed records the bus carries and a DevTools panel folds into a live view of a client. The
 * union is **additive** — later versions introduce new variants as their sources land (e.g.
 * `event:dropped` with backpressure, `resync` with gap recovery) — so consumers must tolerate
 * unknown `t` values.
 */

import type { ConnectionState } from '@liveflux/core';

/** Compact, redaction-safe description of an error surfaced on the bus. */
export interface DevtoolsErrorInfo {
  readonly name: string;
  /** Present when the error is a `LivefluxError` (its stable `code`). */
  readonly code?: string;
  readonly message: string;
}

/** A single observability record. Discriminated by `t`. `at` is a `Date.now()` timestamp. */
export type DevtoolsEvent =
  | { readonly t: 'client:register'; readonly clientId: string; readonly at: number }
  | { readonly t: 'client:destroy'; readonly clientId: string; readonly at: number }
  | {
      readonly t: 'connection:state';
      readonly clientId: string;
      readonly from: ConnectionState;
      readonly to: ConnectionState;
      readonly at: number;
    }
  | {
      readonly t: 'sub:add';
      readonly clientId: string;
      readonly subId: string;
      readonly channel: string;
      readonly strategy: string;
      readonly cap?: number;
      readonly refCount: number;
      readonly at: number;
    }
  | {
      readonly t: 'sub:refchange';
      readonly clientId: string;
      readonly subId: string;
      readonly refCount: number;
      readonly at: number;
    }
  | {
      readonly t: 'sub:remove';
      readonly clientId: string;
      readonly subId: string;
      readonly at: number;
    }
  | {
      readonly t: 'event:in';
      readonly clientId: string;
      readonly channel: string;
      readonly event: string;
      /** Redacted, deep-cloned copy of the payload — safe to display; never the live store object. */
      readonly payload: unknown;
      /** Approximate serialized size of the original payload, in characters. */
      readonly bytes: number;
      readonly at: number;
    }
  | {
      readonly t: 'error';
      readonly clientId: string;
      readonly error: DevtoolsErrorInfo;
      readonly at: number;
    }
  | {
      readonly t: 'publish:out';
      readonly clientId: string;
      readonly channel: string;
      readonly event: string;
      /** Redacted, deep-cloned copy of the payload — safe to display. */
      readonly payload: unknown;
      /** Approximate serialized size of the original payload, in characters. */
      readonly bytes: number;
      readonly idempotencyKey?: string;
      /** `true` when held in the offline outbox (connection not open) rather than sent now. */
      readonly queued: boolean;
      readonly at: number;
    }
  | {
      readonly t: 'request:out';
      readonly clientId: string;
      readonly requestId: string;
      readonly channel: string;
      readonly event: string;
      /** Redacted, deep-cloned copy of the payload — safe to display. */
      readonly payload: unknown;
      /** Approximate serialized size of the original payload, in characters. */
      readonly bytes: number;
      readonly idempotencyKey?: string;
      /** `true` when held in the offline outbox (connection not open) rather than sent now. */
      readonly queued: boolean;
      readonly at: number;
    }
  | {
      readonly t: 'request:settle';
      readonly clientId: string;
      readonly requestId: string;
      readonly outcome: 'resolved' | 'rejected';
      /** Present on a resolved request — redacted reply payload. */
      readonly payload?: unknown;
      /** Present on a rejected request — a compact error description. */
      readonly error?: DevtoolsErrorInfo;
      readonly at: number;
    };
