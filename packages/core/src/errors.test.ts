import { describe, expect, it } from 'vitest';
import { AdapterError, ConnectionError, LivefluxError, SchemaValidationError } from './errors';

describe('LivefluxError hierarchy', () => {
  it('every subclass is a LivefluxError and a native Error', () => {
    for (const err of [
      new ConnectionError('x'),
      new AdapterError('x'),
      new SchemaValidationError('x', { channel: 'c' }),
    ]) {
      expect(err).toBeInstanceOf(LivefluxError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('narrows by concrete type — instanceof discriminates the subclasses', () => {
    const conn = new ConnectionError('down');
    expect(conn).toBeInstanceOf(ConnectionError);
    expect(conn).not.toBeInstanceOf(AdapterError);
  });

  it('sets name, code, message, and a docs deep-link derived from the code', () => {
    const err = new ConnectionError('socket closed');
    expect(err.name).toBe('ConnectionError');
    expect(err.code).toBe('CONNECTION_FAILED');
    expect(err.message).toBe('socket closed');
    expect(err.docs).toBe('https://liveflux.bpdm.dev/docs/errors#connection-failed');
  });

  it('carries each subclass code + docs anchor', () => {
    expect(new AdapterError('x').code).toBe('ADAPTER_CONTRACT');
    expect(new AdapterError('x').docs).toBe(
      'https://liveflux.bpdm.dev/docs/errors#adapter-contract',
    );
    const schema = new SchemaValidationError('x', { channel: 'c' });
    expect(schema.code).toBe('SCHEMA_VALIDATION');
    expect(schema.docs).toBe('https://liveflux.bpdm.dev/docs/errors#schema-validation');
  });

  it('propagates the underlying cause', () => {
    const root = new Error('ECONNRESET');
    const err = new ConnectionError('reconnect gave up', { cause: root });
    expect(err.cause).toBe(root);
  });

  it('omits cause when none is given (never sets an explicit undefined)', () => {
    const err = new AdapterError('bad frame');
    expect(err.cause).toBeUndefined();
    expect('cause' in err).toBe(false);
  });

  it('SchemaValidationError locates the drift by channel and optional path', () => {
    const withPath = new SchemaValidationError('price is not a number', {
      channel: 'trades',
      path: 'price',
    });
    expect(withPath.channel).toBe('trades');
    expect(withPath.path).toBe('price');

    const withoutPath = new SchemaValidationError('shape mismatch', { channel: 'quotes' });
    expect(withoutPath.channel).toBe('quotes');
    expect(withoutPath.path).toBeUndefined();
  });

  it('is throwable and catchable through the base type', () => {
    let caught: unknown;
    try {
      throw new ConnectionError('boom');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LivefluxError);
    expect((caught as ConnectionError).code).toBe('CONNECTION_FAILED');
  });

  it('has a stack trace', () => {
    expect(typeof new AdapterError('x').stack).toBe('string');
  });
});
