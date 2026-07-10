// Tiny mock WebSocket backend for the playground — NOT part of the shipped library.
// Speaks the @liveflux/ws default protocol: receives {type:'subscribe', channel} frames and streams
// {channel, event, payload} events back. Restart-safe: the client reconnects automatically.
import { WebSocketServer } from 'ws';

const PORT = 8100; // digits sum to 9
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'ADA', 'XRP'];
const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (socket) => {
  const timers = new Set();

  socket.on('message', (raw) => {
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return; // ignore non-JSON
    }
    // Out-of-band control frame from the playground's "Simulate connection drop" button (sent over a
    // throwaway socket). Close every OTHER client so the live Liveflux connection sees an unexpected
    // drop and exercises its automatic reconnect + subscription-replay path.
    if (frame.type === 'drop') {
      for (const client of wss.clients) {
        if (client !== socket) client.close(4001, 'simulated drop');
      }
      return;
    }
    if (frame.type === 'subscribe' && frame.channel === 'trades') {
      let seq = 0;
      const timer = setInterval(() => {
        const payload = {
          id: (seq = (seq % 8) + 1), // cycle 1..8 so upsert updates rows in place
          symbol: SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)],
          price: Math.round(Math.random() * 100_000) / 100,
          at: new Date().toLocaleTimeString(),
        };
        socket.send(JSON.stringify({ channel: 'trades', event: 'update', payload }));
      }, 700);
      timers.add(timer);
    }
  });

  socket.on('close', () => {
    for (const timer of timers) clearInterval(timer);
    timers.clear();
  });
});

console.log(`▶ mock WS server on ws://localhost:${PORT} — streaming fake trades on "trades"`);
