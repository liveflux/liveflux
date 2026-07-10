import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { LivefluxClient } from '@liveflux/core';
import { LivefluxProvider } from '@liveflux/react';
import { ws } from '@liveflux/ws';
import { App } from './App';
import { WS_URL } from './config';

// One client for the whole app: the @liveflux/ws adapter over the local mock server (server.mjs).
const client = new LivefluxClient({
  adapter: ws(WS_URL),
  reconnect: { baseMs: 500, maxMs: 5000 },
});
client.connect();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LivefluxProvider client={client}>
      <App />
    </LivefluxProvider>
  </StrictMode>,
);
