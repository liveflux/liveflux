import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server, type Socket } from 'socket.io';

/**
 * A real in-process Socket.IO backend on an ephemeral localhost port, speaking the dialect
 * `@liveflux/socketio` emits: client→server `subscribe` / `unsubscribe` / `resume` control events and
 * server→client `message` events carrying `{ channel, event, payload }`. It runs the genuine
 * `socket.io` server over a real HTTP upgrade, so the adapter (with a genuine `socket.io-client`
 * socket) is exercised end to end.
 *
 * It records every physical connection and every control frame (so tests can assert reconnect
 * replay), routes broadcasts to the sockets subscribed to a channel, and can forcibly disconnect
 * every client to simulate a server-side connection loss.
 */

interface SubscribeFrame {
  subId: string;
  channel: string;
  params?: Record<string, unknown>;
}

/** Everything observed on one physical socket. */
export interface IoConnection {
  readonly socket: Socket;
  readonly subscribes: SubscribeFrame[];
  readonly unsubscribes: string[];
  /** subId → channel, for routing broadcasts. */
  readonly subs: Map<string, string>;
}

export class SocketioServer {
  readonly #http: HttpServer;
  readonly #io: Server;
  readonly #port: number;
  readonly #connections: IoConnection[] = [];

  private constructor(http: HttpServer, io: Server, port: number) {
    this.#http = http;
    this.#io = io;
    this.#port = port;
    this.#io.on('connection', (socket) => this.#onConnection(socket));
  }

  static async start(): Promise<SocketioServer> {
    const http = createServer();
    const io = new Server(http, { transports: ['websocket'], cors: { origin: '*' } });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
    const port = (http.address() as AddressInfo).port;
    return new SocketioServer(http, io, port);
  }

  #onConnection(socket: Socket): void {
    const conn: IoConnection = { socket, subscribes: [], unsubscribes: [], subs: new Map() };
    this.#connections.push(conn);
    socket.on('subscribe', (frame: SubscribeFrame) => {
      conn.subscribes.push(frame);
      conn.subs.set(frame.subId, frame.channel);
    });
    socket.on('unsubscribe', ({ subId }: { subId: string }) => {
      conn.unsubscribes.push(subId);
      conn.subs.delete(subId);
    });
  }

  /** `http://127.0.0.1:<port>` — the client `io()` target. */
  get url(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  get connections(): readonly IoConnection[] {
    return this.#connections;
  }

  get latest(): IoConnection | undefined {
    return this.#connections[this.#connections.length - 1];
  }

  /** Every subscribe frame across every connection (i.e. including reconnect replays). */
  allSubscribes(): SubscribeFrame[] {
    return this.#connections.flatMap((c) => c.subscribes);
  }

  /** Emit an event to every live socket subscribed to `channel`. */
  broadcast(channel: string, event: string, payload: unknown): void {
    for (const conn of this.#connections) {
      if (conn.socket.connected && [...conn.subs.values()].includes(channel)) {
        conn.socket.emit('message', { channel, event, payload });
      }
    }
  }

  /** Forcibly close every live socket, simulating an abrupt server-side connection loss. */
  dropAll(): void {
    for (const conn of this.#connections) {
      if (conn.socket.connected) conn.socket.disconnect(true);
    }
  }

  async close(): Promise<void> {
    await this.#io.close();
    await new Promise<void>((resolve) => this.#http.close(() => resolve()));
  }
}
