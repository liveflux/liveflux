import { describe, expect, it } from 'vitest';
import { AdapterError, ConnectionError, LivefluxError, SchemaValidationError } from './errors';

describe('LivefluxError — edge cases', () => {
  it('formats via toString like a native error (name: message)', () => {
    expect(String(new ConnectionError('link down'))).toBe('ConnectionError: link down');
    expect(String(new AdapterError('bad frame'))).toBe('AdapterError: bad frame');
  });

  it('handles an empty message', () => {
    const err = new ConnectionError('');
    expect(err.message).toBe('');
    expect(err.code).toBe('CONNECTION_FAILED');
  });

  it('SchemaValidationError carries channel, path, and cause together', () => {
    const root = new Error('zod: expected number');
    const err = new SchemaValidationError('price is not a number', {
      channel: 'trades',
      path: 'data.price',
      cause: root,
    });
    expect(err.channel).toBe('trades');
    expect(err.path).toBe('data.price');
    expect(err.cause).toBe(root);
    expect(err).toBeInstanceOf(LivefluxError);
  });

  it('every code maps to a distinct, kebab-cased docs anchor', () => {
    const docs = [
      new ConnectionError('x').docs,
      new AdapterError('x').docs,
      new SchemaValidationError('x', { channel: 'c' }).docs,
    ];
    expect(new Set(docs).size).toBe(3);
    for (const d of docs)
      expect(d).toMatch(/^https:\/\/liveflux\.bpdm\.dev\/docs\/errors#[a-z-]+$/);
  });

  it('preserves a multi-level cause chain', () => {
    const a = new Error('io');
    const b = new AdapterError('decode failed', { cause: a });
    const c = new ConnectionError('gave up', { cause: b });
    expect(c.cause).toBe(b);
    expect((c.cause as AdapterError).cause).toBe(a);
  });
});
