/**
 * @liveflux/core — typed error hierarchy.
 *
 * Every error Liveflux raises is a {@link LivefluxError} subclass carrying a stable, machine-readable
 * `code`, a human message, an optional `cause`, and a `docs` deep-link. Bindings and app error
 * boundaries branch on `instanceof` or `code` instead of matching message strings — so error
 * handling survives message rewording and is safe to switch on.
 */

/** Base of the docs deep-links attached to every error (see {@link LivefluxError.docs}). */
const DOCS_BASE = 'https://liveflux.bpdm.dev/docs/errors';

/** Stable, machine-readable discriminant. Guaranteed not to change across releases. */
export type LivefluxErrorCode = 'CONNECTION_FAILED' | 'ADAPTER_CONTRACT' | 'SCHEMA_VALIDATION';

/** Options common to every Liveflux error. */
export interface LivefluxErrorOptions {
  /** The underlying error or value that triggered this one (standard ES2022 `cause`). */
  cause?: unknown;
}

/**
 * Base class for every error Liveflux raises. Never thrown directly — always via a concrete subclass,
 * so `code` and `instanceof` are meaningful. The `docs` link is derived from the code, so every error
 * points a developer straight at its explanation.
 */
export abstract class LivefluxError extends Error {
  /** Machine-readable discriminant — stable across releases, safe to switch on. */
  readonly code: LivefluxErrorCode;
  /** Deep link to the docs entry for this error code. */
  readonly docs: string;

  protected constructor(code: LivefluxErrorCode, message: string, options?: LivefluxErrorOptions) {
    // Only forward `cause` when present, so we never set an explicit `cause: undefined`.
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.code = code;
    this.docs = `${DOCS_BASE}#${code.toLowerCase().replaceAll('_', '-')}`;
    // `new.target` is the concrete subclass, so the name and prototype are always the real type.
    this.name = new.target.name;
    // Restore the prototype chain so `instanceof` holds across realms and compile targets — cheap
    // insurance for a library consumed under many bundler/transpile setups.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The transport failed or behaved unexpectedly — the socket errored, closed abnormally, or could not
 * be opened. The originating transport error, when there is one, is on `cause`.
 */
export class ConnectionError extends LivefluxError {
  constructor(message: string, options?: LivefluxErrorOptions) {
    super('CONNECTION_FAILED', message, options);
  }
}

/**
 * An adapter violated the `StreamAdapter` contract — e.g. surfaced an event before the connection
 * opened, or lacks a capability required for the requested operation. This signals a bug in the
 * adapter, not in the consuming application.
 */
export class AdapterError extends LivefluxError {
  constructor(message: string, options?: LivefluxErrorOptions) {
    super('ADAPTER_CONTRACT', message, options);
  }
}

/** Locating details for a {@link SchemaValidationError}. */
export interface SchemaValidationDetails extends LivefluxErrorOptions {
  /** The channel whose inbound payload failed validation. */
  channel: string;
  /** Dotted path to the first failing field, when the validator reports one. */
  path?: string;
}

/**
 * An inbound payload failed its per-channel schema at the store boundary and was rejected rather than
 * folded into state. `channel` and `path` locate the drift — catching the single most common realtime
 * bug ("the server changed the shape") the moment it happens.
 */
export class SchemaValidationError extends LivefluxError {
  /** The channel whose inbound payload failed validation. */
  readonly channel: string;
  /** Dotted path to the first failing field, when known. */
  readonly path?: string;

  constructor(message: string, details: SchemaValidationDetails) {
    super('SCHEMA_VALIDATION', message, { cause: details.cause });
    this.channel = details.channel;
    this.path = details.path;
  }
}
