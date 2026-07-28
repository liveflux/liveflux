/**
 * @liveflux/devtools — redaction pass.
 *
 * Before a payload reaches the bus (and a panel), it is deep-cloned with credential-carrying keys
 * replaced by a marker. Security pillar: tokens are never rendered in devtools. The clone is
 * essential — the live payload still enters the store untouched; only the emitted copy is scrubbed.
 */

/** Keys always scrubbed (case-insensitive), on top of any the consumer supplies via `redactKeys`. */
export const DEFAULT_REDACT_KEYS: readonly string[] = [
  'authorization',
  'token',
  'access_token',
  'refresh_token',
  'password',
  'secret',
  'cookie',
  'set-cookie',
  'x-api-key',
  'apikey',
  'api_key',
];

const REDACTED = '«redacted»';
const CIRCULAR = '«circular»';
const MAX_DEPTH = 8;

/** Build the lowercase key set once per attachment from the defaults plus any consumer additions. */
export function buildRedactSet(extra?: readonly string[]): ReadonlySet<string> {
  const set = new Set<string>();
  for (const key of DEFAULT_REDACT_KEYS) set.add(key.toLowerCase());
  if (extra) for (const key of extra) set.add(key.toLowerCase());
  return set;
}

/**
 * Deep-clone `value`, replacing any property whose key matches `keys` (case-insensitive) with a
 * redaction marker. Never mutates the input, guards against cycles, and caps recursion depth so a
 * pathological payload can't blow the stack.
 */
export function redactValue(
  value: unknown,
  keys: ReadonlySet<string>,
  depth = MAX_DEPTH,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return CIRCULAR;
  if (depth <= 0) return value; // stop cloning very deep structures
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, keys, depth - 1, seen));
  // Only traverse plain objects. A Date/Map/Set/class instance has no credential-keyed own fields to
  // scrub, and walking it with Object.entries would flatten it to `{}` — so preserve it as-is.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = keys.has(key.toLowerCase()) ? REDACTED : redactValue(val, keys, depth - 1, seen);
  }
  return out;
}
