// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { LivefluxClient } from '@liveflux/core';
import type { AdapterHandlers, StreamAdapter, SubscribeRequest } from '@liveflux/core';
import { attachDevtools } from './attach';
import { DEVTOOLS_HOOK_KEY } from './hook';
import { LivefluxDevtools } from './react';

class MockAdapter implements StreamAdapter {
  handlers: AdapterHandlers | null = null;
  connect(handlers: AdapterHandlers): void {
    this.handlers = handlers;
    handlers.onOpen();
  }
  disconnect(): void {}
  subscribe(_req: SubscribeRequest): void {}
  unsubscribe(_subId: string): void {}
  emit(channel: string, payload: unknown): void {
    this.handlers?.onEvent({ channel, event: 'update', payload });
  }
}

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[DEVTOOLS_HOOK_KEY];
  try {
    localStorage.clear();
  } catch {
    /* no storage */
  }
});
afterEach(() => cleanup());

/** The panel starts minimized to a launcher — click it to open. */
const openPanel = (el: HTMLElement) => (el.shadowRoot!.querySelector('.launcher') as HTMLElement).click();

describe('<LivefluxDevtools> (React wrapper)', () => {
  it('registers the custom element and renders it (upgraded, with a shadow root)', () => {
    const { container } = render(createElement(LivefluxDevtools));
    const el = container.querySelector('liveflux-devtools') as HTMLElement | null;
    expect(el).toBeTruthy();
    expect(customElements.get('liveflux-devtools')).toBeTruthy();
    expect(el!.shadowRoot).toBeTruthy(); // upgraded by the mount effect
  });

  it('the mounted panel reflects a client attached before render', () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    attachDevtools(client);
    client.connect();
    client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
    adapter.emit('trades', { price: 7 });

    const { container } = render(createElement(LivefluxDevtools));
    const el = container.querySelector('liveflux-devtools') as HTMLElement;
    openPanel(el); // starts minimized — open it to inspect the panel contents
    expect(el.shadowRoot?.textContent).toContain('trades/update');
  });

  it('reflects events that stream AFTER the panel mounts (live sequence)', async () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    attachDevtools(client);
    client.connect();

    // Panel mounts FIRST — as in the playground (attach at module load, then React renders the panel).
    const { container } = render(createElement(LivefluxDevtools));
    const el = container.querySelector('liveflux-devtools') as HTMLElement;
    openPanel(el); // the panel is minimized by default

    // Only AFTER the panel is on-screen do subscription + events start flowing.
    await act(async () => {
      client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
      adapter.emit('trades', { price: 42 });
      // flush: model notify (microtask) + element render (rAF, ~16ms in jsdom)
      await new Promise((r) => setTimeout(r, 40));
    });

    expect(el.shadowRoot?.textContent).toContain('trades/update');
  });

  it('unmounts cleanly', () => {
    const { unmount } = render(createElement(LivefluxDevtools));
    expect(() => unmount()).not.toThrow();
  });
});
