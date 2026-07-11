import { WebSocketServer, type WebSocket as NodeWebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

/**
 * A real in-process Phoenix Channels **v2** server for exercising `@liveflux/phoenix` over a genuine
 * socket. Every frame on the wire is the v2 tuple `[join_ref, ref, topic, event, payload]`. It:
 *
 *  • replies `phx_reply {status:'ok'}` to a `phx_join` (or `{status:'error'}` for topics registered
 *    via {@link rejectTopic}, to drive the join-error path),
 *  • replies `phx_reply {status:'ok'}` to a `phoenix`/`heartbeat` keepalive — unless heartbeat acking
 *    is turned off via {@link setAckHeartbeats}, which drives the dead-link zombie-close path,
 *  • acknowledges a `phx_leave`,
 *  • broadcasts data events as `[null, null, topic, event, payload]`,
 *  • can inject a `phx_error` for a topic on demand (the crashed-channel → transparent-rejoin path),
 *  • can emit an arbitrary lifecycle frame with a chosen `join_ref` via {@link sendToLatest} (the
 *    stale-instance filtering path).
 *
 * It records the connect query string and the joined topics per connection so tests can assert
 * reconnect re-joins and dynamic-param re-auth. Joins are recorded even while replies are suppressed
 * (see {@link setReplyToJoins}), so a test can still count retry-join frames on the wire.
 */

export type PhoenixMessage = [
  joinRef: string | null,
  ref: string | null,
  topic: string,
  event: string,
  payload: unknown,
];

const REPLY = 'phx_reply';
const JOIN = 'phx_join';
const LEAVE = 'phx_leave';
const ERROR = 'phx_error';
const HEARTBEAT = 'heartbeat';
const HEARTBEAT_TOPIC = 'phoenix';

/** One join the server accepted: its topic, the client's join_ref/ref, and the params it carried. */
export interface PhoenixJoin {
  topic: string;
  joinRef: string;
  /** The per-connection request `ref` the join was sent with (needed to correlate a late reply). */
  ref: string | null;
  params: Record<string, unknown>;
}

/** Everything the server observed on one physical connection. */
export interface PhoenixConnection {
  /** The raw query string the client connected with (includes `vsn` and any auth params). */
  readonly query: string;
  /** Every accepted join on this connection, in order (reconnect replays included per-connection). */
  readonly joins: PhoenixJoin[];
  /** Topics a `phx_leave` was received for on this connection. */
  readonly leaves: string[];
  /** How many keepalive frames arrived on this connection. */
  heartbeats: number;
  /** topic → the live join_refs on it (for routing / stale filtering). */
  readonly topics: Map<string, Set<string>>;
  readonly socket: NodeWebSocket;
}

export class PhoenixServer {
  readonly #wss: WebSocketServer;
  readonly #connections: PhoenixConnection[] = [];
  readonly #port: number;
  /** Topics for which a join is answered with `{status:'error'}` instead of ok. */
  readonly #rejectTopics = new Set<string>();
  /** If false, joins receive no reply at all (drives the join-timeout path). Joins are still recorded. */
  #replyToJoins = true;
  /** If false, heartbeats are counted but never acked (drives the dead-link zombie-close path). */
  #ackHeartbeats = true;

  private constructor(wss: WebSocketServer, port: number) {
    this.#wss = wss;
    this.#port = port;
    this.#wss.on('connection', (socket, req) => {
      const q = (req.url ?? '').split('?')[1] ?? '';
      const conn: PhoenixConnection = {
        query: q,
        joins: [],
        leaves: [],
        heartbeats: 0,
        topics: new Map(),
        socket,
      };
      this.#connections.push(conn);
      socket.on('message', (data) => this.#onMessage(conn, data.toString()));
    });
  }

  static async start(): Promise<PhoenixServer> {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const port = (wss.address() as AddressInfo).port;
    return new PhoenixServer(wss, port);
  }

  #send(socket: NodeWebSocket, message: PhoenixMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }

  #onMessage(conn: PhoenixConnection, raw: string): void {
    let msg: PhoenixMessage;
    try {
      msg = JSON.parse(raw) as PhoenixMessage;
    } catch {
      return;
    }
    if (!Array.isArray(msg) || msg.length < 5) return;
    const [joinRef, ref, topic, event, payload] = msg;

    if (event === HEARTBEAT && topic === HEARTBEAT_TOPIC) {
      conn.heartbeats += 1;
      // A silent server (ack off) leaves the client's heartbeat unacked → its next tick closes the
      // zombie socket and the core reconnects.
      if (this.#ackHeartbeats) {
        this.#send(conn.socket, [null, ref, HEARTBEAT_TOPIC, REPLY, { status: 'ok', response: {} }]);
      }
      return;
    }

    if (event === JOIN) {
      // Record the join even when replies are suppressed, so a test can still observe retry-join
      // frames on the wire (and route broadcasts to the topic while the client awaits a timeout).
      if (joinRef !== null) {
        conn.joins.push({
          topic,
          joinRef,
          ref,
          params: (payload ?? {}) as Record<string, unknown>,
        });
        let refs = conn.topics.get(topic);
        if (!refs) {
          refs = new Set();
          conn.topics.set(topic, refs);
        }
        refs.add(joinRef);
      }
      if (!this.#replyToJoins) return; // stay silent → the client's join timeout fires
      const status = this.#rejectTopics.has(topic) ? 'error' : 'ok';
      const response = status === 'error' ? { reason: 'unauthorized' } : {};
      this.#send(conn.socket, [joinRef, ref, topic, REPLY, { status, response }]);
      return;
    }

    if (event === LEAVE) {
      conn.leaves.push(topic);
      if (joinRef !== null) conn.topics.get(topic)?.delete(joinRef);
      this.#send(conn.socket, [joinRef, ref, topic, REPLY, { status: 'ok', response: {} }]);
      return;
    }
  }

  url(query = ''): string {
    return `ws://127.0.0.1:${this.#port}${query}`;
  }

  get connections(): readonly PhoenixConnection[] {
    return this.#connections;
  }

  get latest(): PhoenixConnection | undefined {
    return this.#connections[this.#connections.length - 1];
  }

  /** Every accepted join across every connection (reconnect replays included). */
  allJoins(): PhoenixJoin[] {
    return this.#connections.flatMap((c) => c.joins);
  }

  /** Register a topic whose future joins are answered with `{status:'error'}`. */
  rejectTopic(topic: string): void {
    this.#rejectTopics.add(topic);
  }

  /** Stop / resume replying to joins — a silent server drives the client's join-timeout backoff. */
  setReplyToJoins(reply: boolean): void {
    this.#replyToJoins = reply;
  }

  /**
   * Stop / resume acking heartbeats. With acking off, the client's outstanding heartbeat stays
   * unacked, so its next `heartbeat()` tick detects the dead link and closes the zombie socket —
   * driving a core reconnect. Heartbeats are still counted while acking is off.
   */
  setAckHeartbeats(ack: boolean): void {
    this.#ackHeartbeats = ack;
  }

  /**
   * Emit an arbitrary v2 frame `[joinRef, ref, topic, event, payload]` to the latest live
   * connection. The escape hatch for stale-instance tests: a lifecycle frame (`phx_error` /
   * `phx_reply`) carrying a chosen — possibly superseded — `join_ref`, to assert the client filters
   * it against the current join instance.
   */
  sendToLatest(
    joinRef: string | null,
    ref: string | null,
    topic: string,
    event: string,
    payload: unknown,
  ): void {
    const conn = this.latest;
    if (conn && conn.socket.readyState === conn.socket.OPEN) {
      this.#send(conn.socket, [joinRef, ref, topic, event, payload]);
    }
  }

  /** Broadcast a data event to every live connection that has joined `topic`. */
  broadcast(topic: string, event: string, payload: unknown): void {
    for (const conn of this.#connections) {
      if (conn.socket.readyState !== conn.socket.OPEN) continue;
      if ((conn.topics.get(topic)?.size ?? 0) > 0) {
        this.#send(conn.socket, [null, null, topic, event, payload]);
      }
    }
  }

  /** Inject a `phx_error` for `topic` on every live connection that has joined it. */
  emitChannelError(topic: string): void {
    for (const conn of this.#connections) {
      if (conn.socket.readyState !== conn.socket.OPEN) continue;
      if ((conn.topics.get(topic)?.size ?? 0) > 0) {
        this.#send(conn.socket, [null, null, topic, ERROR, {}]);
        conn.topics.get(topic)?.clear(); // the channel crashed; the client must re-join
      }
    }
  }

  /** Forcibly close every live client socket, simulating an abrupt server-side connection loss. */
  dropAll(): void {
    for (const conn of this.#connections) {
      if (conn.socket.readyState === conn.socket.OPEN) conn.socket.terminate();
    }
  }

  async close(): Promise<void> {
    for (const conn of this.#connections) conn.socket.terminate();
    await new Promise<void>((resolve, reject) =>
      this.#wss.close((err) => (err ? reject(err) : resolve())),
    );
  }
}
