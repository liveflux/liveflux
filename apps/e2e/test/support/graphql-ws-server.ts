import { WebSocketServer, type WebSocket as NodeWebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { useServer } from 'graphql-ws/use/ws';
import {
  GraphQLBoolean,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
} from 'graphql';

/**
 * A real in-process `graphql-transport-ws` backend on an ephemeral localhost port: the genuine
 * `graphql-ws` server (`useServer`) over a `ws` `WebSocketServer`, with a tiny schema whose
 * `stream(channel)` subscription yields events pushed through a per-channel pub/sub. The adapter —
 * which speaks the protocol by hand over a raw socket — is exercised against a real server handshake
 * (`connection_init` → `connection_ack`), real `subscribe` operations, and real `next` results.
 *
 * It records every physical socket and every subscribed channel (for reconnect-replay assertions),
 * publishes events to the sockets subscribed to a channel, and can terminate every socket to
 * simulate a server-side drop.
 */

/** A minimal channel-keyed pub/sub exposing an async iterator per subscription. */
function createPubSub() {
  const listeners = new Map<string, Set<(v: unknown) => void>>();
  return {
    publish(channel: string, value: unknown): void {
      for (const fn of listeners.get(channel) ?? []) fn(value);
    },
    subscribe(channel: string): AsyncIterableIterator<unknown> {
      const queue: unknown[] = [];
      const waiters: ((r: IteratorResult<unknown>) => void)[] = [];
      let closed = false;
      const push = (v: unknown): void => {
        if (closed) return;
        const w = waiters.shift();
        if (w) w({ value: v, done: false });
        else queue.push(v);
      };
      let set = listeners.get(channel);
      if (!set) listeners.set(channel, (set = new Set()));
      set.add(push);
      const cleanup = (): void => {
        closed = true;
        set!.delete(push);
        for (const w of waiters.splice(0)) w({ value: undefined, done: true });
      };
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next(): Promise<IteratorResult<unknown>> {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
        return(): Promise<IteratorResult<unknown>> {
          cleanup();
          return Promise.resolve({ value: undefined, done: true });
        },
        throw(err?: unknown): Promise<IteratorResult<unknown>> {
          cleanup();
          return Promise.reject(err);
        },
      };
    },
  };
}

interface StreamPayload {
  event: string;
  payload: string;
}

function buildSchema(
  pubsub: ReturnType<typeof createPubSub>,
  onChannel: (channel: string) => void,
): GraphQLSchema {
  const StreamEvent = new GraphQLObjectType({
    name: 'StreamEvent',
    fields: {
      event: { type: new GraphQLNonNull(GraphQLString) },
      // Payload travels as a JSON string — no custom scalar needed for the test.
      payload: { type: new GraphQLNonNull(GraphQLString) },
    },
  });
  return new GraphQLSchema({
    query: new GraphQLObjectType({ name: 'Query', fields: { _empty: { type: GraphQLBoolean } } }),
    subscription: new GraphQLObjectType({
      name: 'Subscription',
      fields: {
        stream: {
          type: new GraphQLNonNull(StreamEvent),
          args: { channel: { type: new GraphQLNonNull(GraphQLString) } },
          subscribe: (_root, args: { channel: string }) => {
            onChannel(args.channel); // a subscription genuinely started for this channel
            return pubsub.subscribe(args.channel);
          },
          resolve: (payload: StreamPayload) => payload,
        },
      },
    }),
  });
}

export class GraphqlWsServer {
  readonly #wss: WebSocketServer;
  readonly #port: number;
  readonly #pubsub = createPubSub();
  readonly #sockets = new Set<NodeWebSocket>();
  #connectionCount = 0;
  readonly #subscribedChannels: string[] = [];

  private constructor(wss: WebSocketServer, port: number) {
    this.#wss = wss;
    this.#port = port;
    this.#wss.on('connection', (socket) => {
      this.#connectionCount += 1;
      this.#sockets.add(socket);
      socket.on('close', () => this.#sockets.delete(socket));
    });
  }

  static async start(): Promise<GraphqlWsServer> {
    let self: GraphqlWsServer;
    const wss = new WebSocketServer({
      port: 0,
      host: '127.0.0.1',
      handleProtocols: (protocols) =>
        protocols.has('graphql-transport-ws') ? 'graphql-transport-ws' : false,
    });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const port = (wss.address() as AddressInfo).port;
    self = new GraphqlWsServer(wss, port);
    useServer(
      { schema: buildSchema(self.#pubsub, (channel) => self.#subscribedChannels.push(channel)) },
      wss,
    );
    return self;
  }

  /** `ws://127.0.0.1:<port>` — the client (adapter) connect target. */
  get url(): string {
    return `ws://127.0.0.1:${this.#port}`;
  }

  /** How many physical sockets have connected (grows by one on each reconnect). */
  get connectionCount(): number {
    return this.#connectionCount;
  }

  /** Every channel subscribed via a `subscribe` op, across all connections (incl. reconnect replays). */
  get subscribedChannels(): readonly string[] {
    return this.#subscribedChannels;
  }

  /** Push an event to every live `stream(channel:…)` subscription for `channel`. */
  broadcast(channel: string, event: string, payload: unknown): void {
    this.#pubsub.publish(channel, { event, payload: JSON.stringify(payload) });
  }

  /** Forcibly terminate every live socket, simulating an abrupt server-side connection loss. */
  dropAll(): void {
    for (const s of [...this.#sockets]) s.terminate();
  }

  async close(): Promise<void> {
    for (const s of [...this.#sockets]) s.terminate();
    await new Promise<void>((resolve, reject) =>
      this.#wss.close((err) => (err ? reject(err) : resolve())),
    );
  }
}
