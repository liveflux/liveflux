import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A real in-process Server-Sent Events backend on an ephemeral localhost port, matching the split
 * `@liveflux/sse` expects: a one-way `text/event-stream` download (`GET /events`) plus a separate
 * upstream control channel (`POST /control`) carrying the adapter's `{ type: 'subscribe' |
 * 'unsubscribe' | 'resume', … }` frames. A stable per-client `cid` query param on both URLs
 * correlates the two — exactly how a cookieless SSE deployment threads a session id.
 *
 * It records every control frame and every physical stream connection (so tests can assert reconnect
 * replay), broadcasts `id:`/`data:` events to the streams subscribed to a channel, and can abruptly
 * end a stream to simulate a server-side drop.
 */

export type SseControlFrame =
  | { type: 'subscribe'; subId: string; channel: string; params?: Record<string, unknown> }
  | { type: 'unsubscribe'; subId: string }
  | { type: 'resume'; subId: string; cursor: string | null };

/** One physical event-stream connection for a client id. */
interface SseStream {
  readonly cid: string;
  readonly res: ServerResponse;
  /** subId → channel, for routing broadcasts to this stream. */
  readonly subs: Map<string, string>;
}

export class SseServer {
  readonly #server: Server;
  readonly #port: number;
  /** Live streams, in connect order — index `-1` is the most recent (post-reconnect) one. */
  readonly #streams: SseStream[] = [];
  /** Every control frame received, across all POSTs, in order. */
  readonly #controlFrames: SseControlFrame[] = [];

  private constructor(server: Server, port: number) {
    this.#server = server;
    this.#port = port;
  }

  static async start(): Promise<SseServer> {
    let self: SseServer;
    const server = createServer((req, res) => self.#onRequest(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    self = new SseServer(server, port);
    return self;
  }

  #onRequest(req: IncomingMessage, res: ServerResponse): void {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const cid = u.searchParams.get('cid') ?? '';
    if (req.method === 'GET' && u.pathname === '/events') {
      this.#openStream(cid, res);
      return;
    }
    if (req.method === 'POST' && u.pathname === '/control') {
      this.#onControl(cid, req, res);
      return;
    }
    res.writeHead(404).end();
  }

  #openStream(cid: string, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    // A leading comment flushes headers so the client's EventSource fires `open` promptly.
    res.write(': ok\n\n');
    const stream: SseStream = { cid, res, subs: new Map() };
    this.#streams.push(stream);
    res.on('close', () => {
      const i = this.#streams.indexOf(stream);
      if (i !== -1) this.#streams.splice(i, 1);
    });
  }

  #onControl(cid: string, req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let frame: SseControlFrame | null = null;
      try {
        frame = JSON.parse(body) as SseControlFrame;
      } catch {
        res.writeHead(400).end();
        return;
      }
      this.#controlFrames.push(frame);
      // Apply the frame to the live stream for this cid (the most recent one, if reconnected).
      const stream = [...this.#streams].reverse().find((s) => s.cid === cid);
      if (stream) {
        if (frame.type === 'subscribe') stream.subs.set(frame.subId, frame.channel);
        else if (frame.type === 'unsubscribe') stream.subs.delete(frame.subId);
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  }

  /** `http://127.0.0.1:<port>` — build the two URLs off this base with a shared `?cid=`. */
  get base(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  get streams(): readonly SseStream[] {
    return this.#streams;
  }

  /** The most recent live stream for a cid, or `undefined`. */
  streamFor(cid: string): SseStream | undefined {
    return [...this.#streams].reverse().find((s) => s.cid === cid);
  }

  get controlFrames(): readonly SseControlFrame[] {
    return this.#controlFrames;
  }

  /** Every subscribe frame received (including reconnect replays). */
  subscribes(): Extract<SseControlFrame, { type: 'subscribe' }>[] {
    return this.#controlFrames.filter(
      (f): f is Extract<SseControlFrame, { type: 'subscribe' }> => f.type === 'subscribe',
    );
  }

  /**
   * Send an event to every live stream subscribed to `channel`. An optional `id` becomes the SSE
   * `id:` field — surfaced to the adapter as `lastEventId` and threaded through as the event cursor.
   */
  broadcast(channel: string, event: string, payload: unknown, id?: string): void {
    const frame =
      (id ? `id: ${id}\n` : '') + `data: ${JSON.stringify({ channel, event, payload })}\n\n`;
    for (const s of this.#streams) {
      if ([...s.subs.values()].includes(channel)) s.res.write(frame);
    }
  }

  /** Forcibly end every live stream, simulating an abrupt server-side connection loss. */
  dropAll(): void {
    for (const s of [...this.#streams]) s.res.end();
  }

  async close(): Promise<void> {
    for (const s of [...this.#streams]) s.res.end();
    await new Promise<void>((resolve, reject) =>
      this.#server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}
