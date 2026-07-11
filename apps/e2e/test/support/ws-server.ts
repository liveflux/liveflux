import { WebSocketServer, type WebSocket as NodeWebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

/**
 * A real in-process server for the `@liveflux/ws` control protocol, running on an ephemeral
 * localhost port over the `ws` package. It speaks the exact wire dialect the default `ws` adapter
 * expects — inbound `{ type: 'subscribe' | 'unsubscribe' | 'heartbeat', … }` control frames and
 * outbound `{ channel, event, payload }` event frames — so the adapter is exercised end to end over
 * a genuine socket, not a stub.
 *
 * It records enough per-connection history (the connect query string, every subscribe / unsubscribe
 * / heartbeat frame) for the tests to assert reconnect replay and dynamic-token re-auth, and it can
 * broadcast events and forcibly drop the live socket to simulate a server-side connection loss.
 */

interface SubscribeFrame {
  type: 'subscribe';
  subId: string;
  channel: string;
  params?: Record<string, unknown>;
}
interface UnsubscribeFrame {
  type: 'unsubscribe';
  subId: string;
}
interface HeartbeatFrame {
  type: 'heartbeat';
}
type InboundFrame = SubscribeFrame | UnsubscribeFrame | HeartbeatFrame;

/** Everything the server observed on one physical connection. */
export interface WsConnection {
  /** The raw query string the client connected with (after the `?`), e.g. `token=abc`. */
  readonly query: string;
  /**
   * The `Sec-WebSocket-Protocol` request header the client offered, or `''` if none — lets a test
   * assert a function-form `protocols` option is re-resolved per (re)connect (token-in-subprotocol).
   */
  readonly protocol: string;
  /** Every subscribe frame received on this connection, in order. */
  readonly subscribes: SubscribeFrame[];
  /** Every unsubscribed subId on this connection, in order. */
  readonly unsubscribes: string[];
  /** How many heartbeat frames arrived on this connection. */
  heartbeats: number;
  /** Every raw inbound wire string, in order — lets a test assert a custom `encode`'s output. */
  readonly rawMessages: string[];
  /** subId → channel, for routing broadcasts to interested sockets. */
  readonly subs: Map<string, string>;
  readonly socket: NodeWebSocket;
}

export class WsControlServer {
  readonly #wss: WebSocketServer;
  readonly #connections: WsConnection[] = [];
  readonly #port: number;

  private constructor(wss: WebSocketServer, port: number) {
    this.#wss = wss;
    this.#port = port;
    this.#wss.on('connection', (socket, req) => {
      const q = (req.url ?? '').split('?')[1] ?? '';
      const proto = req.headers['sec-websocket-protocol'] ?? '';
      const conn: WsConnection = {
        query: q,
        protocol: proto,
        subscribes: [],
        unsubscribes: [],
        heartbeats: 0,
        rawMessages: [],
        subs: new Map(),
        socket,
      };
      this.#connections.push(conn);
      socket.on('message', (data) => this.#onMessage(conn, data.toString()));
    });
  }

  /** Start a server on an ephemeral port and resolve once it is listening. */
  static async start(): Promise<WsControlServer> {
    const wss = new WebSocketServer({
      port: 0,
      host: '127.0.0.1',
      // Accept (echo) the first offered subprotocol so a client that carries a token in the
      // subprotocol connects cleanly; the offered value is still recorded on the connection.
      handleProtocols: (protocols) => [...protocols][0] ?? false,
    });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const port = (wss.address() as AddressInfo).port;
    return new WsControlServer(wss, port);
  }

  #onMessage(conn: WsConnection, raw: string): void {
    conn.rawMessages.push(raw);
    let frame: InboundFrame;
    try {
      frame = JSON.parse(raw) as InboundFrame;
    } catch {
      return;
    }
    switch (frame.type) {
      case 'subscribe':
        conn.subscribes.push(frame);
        conn.subs.set(frame.subId, frame.channel);
        break;
      case 'unsubscribe':
        conn.unsubscribes.push(frame.subId);
        conn.subs.delete(frame.subId);
        break;
      case 'heartbeat':
        conn.heartbeats += 1;
        break;
    }
  }

  /** `ws://127.0.0.1:<port>` — pass a suffix (e.g. `?token=x`) via the argument. */
  url(query = ''): string {
    return `ws://127.0.0.1:${this.#port}${query}`;
  }

  /** All connections seen so far, oldest first. Index `-1` is the current/most recent one. */
  get connections(): readonly WsConnection[] {
    return this.#connections;
  }

  /** The most recent connection, or `undefined` before the first client connects. */
  get latest(): WsConnection | undefined {
    return this.#connections[this.#connections.length - 1];
  }

  /** Every subscribe frame across every connection (i.e. including reconnect replays). */
  allSubscribes(): SubscribeFrame[] {
    return this.#connections.flatMap((c) => c.subscribes);
  }

  /**
   * Broadcast an event to every live connection currently subscribed to `channel`. The client's
   * core registry fans it out to that channel's listeners.
   */
  broadcast(channel: string, event: string, payload: unknown): void {
    const frame = JSON.stringify({ channel, event, payload });
    for (const conn of this.#connections) {
      if (conn.socket.readyState !== conn.socket.OPEN) continue;
      if ([...conn.subs.values()].includes(channel)) conn.socket.send(frame);
    }
  }

  /** Forcibly close every live client socket, simulating an abrupt server-side connection loss. */
  dropAll(): void {
    for (const conn of this.#connections) {
      if (conn.socket.readyState === conn.socket.OPEN) conn.socket.terminate();
    }
  }

  /** Shut the server down and release the port. */
  async close(): Promise<void> {
    for (const conn of this.#connections) conn.socket.terminate();
    await new Promise<void>((resolve, reject) =>
      this.#wss.close((err) => (err ? reject(err) : resolve())),
    );
  }
}
