/**
 * @liveflux/devtools — structured console logger.
 *
 * `attachLogger(client, { level })` prints the client's lifecycle to the console, filtered by level.
 * Like the panel, it rides the core `observe()` tap and lives in this dev-only package, so it never
 * ships to production. For production logging, wire your own sink onto `client.onError` /
 * `client.onConnectionChange` / `client.observe` — the same public surface, no bundle cost.
 */

import type { ClientObserver, LivefluxClient } from '@liveflux/core';
import { buildRedactSet, redactValue } from './redact';

/** Verbosity, least to most: `silent` disables logging entirely. */
export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

/** The console-shaped surface the logger writes to (defaults to the global `console`). */
export interface LogSink {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

export interface AttachLoggerOptions {
  /** Minimum level to print (default `'info'`). */
  level?: LogLevel;
  /** Extra keys (case-insensitive) to scrub from logged payloads, on top of the defaults. */
  redactKeys?: string[];
  /** Where to write (default `console`). */
  sink?: LogSink;
  /** Line prefix (default `'[liveflux]'`). */
  prefix?: string;
}

/**
 * Attach a console logger to a client. Returns a detach function. At `error` only failures print; at
 * `info` connection and subscription lifecycle print too; at `debug` ref-count changes and every
 * (redacted) event print. `silent` wires nothing.
 */
export function attachLogger(
  client: LivefluxClient,
  options: AttachLoggerOptions = {},
): () => void {
  const threshold = ORDER[options.level ?? 'info'];
  if (threshold === ORDER.silent) return () => {};

  const sink = options.sink ?? console;
  const prefix = options.prefix ?? '[liveflux]';
  const redactKeys = buildRedactSet(options.redactKeys);
  const observer: ClientObserver = {
    // Past `silent`, `error` is always in range.
    onError: (err) => sink.error(prefix, 'error', err),
  };

  if (threshold >= ORDER.info) {
    observer.onConnectionState = (state, previous) =>
      sink.info(prefix, `connection ${previous} → ${state}`);
    observer.onSubscriptionAdd = (sub) =>
      sink.info(prefix, `subscribe "${sub.channel}" (${sub.strategy})`);
    observer.onSubscriptionRemove = (id) => sink.info(prefix, `unsubscribe ${id}`);
  }

  if (threshold >= ORDER.debug) {
    observer.onSubscriptionRefChange = (id, refCount) =>
      sink.debug(prefix, `refcount ${id} = ${refCount}`);
    observer.onEvent = (event) =>
      sink.debug(
        prefix,
        `event "${event.channel}"/${event.event}`,
        redactValue(event.payload, redactKeys),
      );
  }

  return client.observe(observer);
}
