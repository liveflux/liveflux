// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { LivefluxClient } from '@liveflux/core';
import type { AdapterHandlers, StreamAdapter, SubscribeRequest } from '@liveflux/core';
import { attachDevtools } from './attach';
import { DEVTOOLS_HOOK_KEY } from './hook';
import { defineLivefluxDevtools, LivefluxDevtoolsElement } from './element';

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
  fail(err: unknown): void {
    this.handlers?.onError(err);
  }
}

/** Attach devtools + drive a client, THEN mount the panel — its constructor replays the bus buffer
 *  synchronously, so the initial render reflects everything with no rAF/microtask wait. */
function mountWith(setup: (client: LivefluxClient, adapter: MockAdapter) => void): LivefluxDevtoolsElement {
  const adapter = new MockAdapter();
  const client = new LivefluxClient({ adapter });
  attachDevtools(client);
  setup(client, adapter);
  const el = document.createElement('liveflux-devtools') as LivefluxDevtoolsElement;
  document.body.appendChild(el);
  openPanel(el); // the panel is minimized to a launcher by default — open it for content assertions
  return el;
}

/** Click the floating launcher to open the panel (it starts minimized). */
const openPanel = (el: LivefluxDevtoolsElement) => (el.shadowRoot!.querySelector('.launcher') as HTMLElement).click();

const text = (el: LivefluxDevtoolsElement) => el.shadowRoot?.textContent ?? '';
const q = (el: LivefluxDevtoolsElement, sel: string) => el.shadowRoot?.querySelector(sel) ?? null;
const rowCount = (el: LivefluxDevtoolsElement) => el.shadowRoot?.querySelectorAll('.body .row').length ?? 0;
const type = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
/** Flush the microtask (model notify) + rAF (element render) so a live event reaches the DOM. */
const flush = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[DEVTOOLS_HOOK_KEY];
  document.body.innerHTML = '';
  try {
    localStorage.clear(); // don't let one test's persisted position/open-state leak into the next
  } catch {
    /* no storage */
  }
  defineLivefluxDevtools();
});

describe('<liveflux-devtools>', () => {
  it('registers the custom element (idempotent)', () => {
    defineLivefluxDevtools();
    expect(customElements.get('liveflux-devtools')).toBe(LivefluxDevtoolsElement);
  });

  it('shows an empty state when no client is attached', () => {
    const el = document.createElement('liveflux-devtools') as LivefluxDevtoolsElement;
    document.body.appendChild(el);
    openPanel(el);
    expect(text(el)).toContain('No Liveflux client attached');
  });

  it('renders a connected client with its events (default tab)', () => {
    const el = mountWith((client, adapter) => {
      client.connect();
      client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
      adapter.emit('trades', { price: 42 });
    });
    expect(text(el)).toContain('trades/update');
    expect(text(el)).toContain('42');
    expect(q(el, '.pill')?.getAttribute('data-state')).toBe('open');
  });

  it('switches to the subscriptions tab and shows the table', () => {
    const el = mountWith((client) => {
      client.connect();
      client.subscribe({ channel: 'orders', into: { strategy: 'upsert', key: 'id', cap: 50 } });
    });
    (q(el, '[data-tab="subscriptions"]') as HTMLElement).click();
    expect(text(el)).toContain('orders');
    expect(text(el)).toContain('upsert');
    expect(text(el)).toContain('cap 50');
  });

  it('escapes payload content — no HTML injection into the panel', () => {
    const el = mountWith((client, adapter) => {
      client.connect();
      client.subscribe({ channel: 'c', into: { strategy: 'append' } });
      adapter.emit('c', { note: '<img src=x onerror=alert(1)>' });
    });
    expect(el.shadowRoot?.querySelector('img')).toBeNull(); // not parsed as HTML
    expect(text(el)).toContain('<img src=x'); // shown as literal text
  });

  it('renders the errors tab with a surfaced error', () => {
    const el = mountWith((client, adapter) => {
      client.connect();
      adapter.fail(new Error('boom'));
    });
    (q(el, '[data-tab="errors"]') as HTMLElement).click();
    expect(text(el)).toContain('boom');
  });

  it('exposes a11y roles (region / tablist / 4 tabs / tabpanel)', () => {
    const el = document.createElement('liveflux-devtools') as LivefluxDevtoolsElement;
    document.body.appendChild(el);
    openPanel(el);
    expect(q(el, '[role="region"]')?.getAttribute('aria-label')).toContain('Liveflux');
    expect(q(el, '[role="tablist"]')).toBeTruthy();
    expect(el.shadowRoot?.querySelectorAll('[role="tab"]').length).toBe(4);
    expect(q(el, '[role="tabpanel"]')).toBeTruthy();
    expect(q(el, '[role="tab"][aria-selected="true"]')).toBeTruthy();
  });

  it('mounts minimized as a labelled launcher button by default', () => {
    const el = document.createElement('liveflux-devtools') as LivefluxDevtoolsElement;
    document.body.appendChild(el);
    expect(el.hasAttribute('open')).toBe(false);
    const launcher = q(el, '.launcher');
    expect(launcher).toBeTruthy();
    expect(launcher?.getAttribute('aria-label')).toContain('Liveflux');
    expect(q(el, '.launcher svg')).toBeTruthy(); // the D-with-bug mark
  });

  it('opens from the launcher and minimizes back to it', () => {
    const el = mountWith((client) => client.connect()); // mountWith opens it
    expect(el.hasAttribute('open')).toBe(true);
    (q(el, '[data-action="minimize"]') as HTMLElement).click();
    expect(el.hasAttribute('open')).toBe(false);
    openPanel(el);
    expect(el.hasAttribute('open')).toBe(true);
  });

  it('a drag on the launcher does not open the panel', () => {
    const el = document.createElement('liveflux-devtools') as LivefluxDevtoolsElement;
    document.body.appendChild(el);
    const launcher = q(el, '.launcher') as HTMLElement;
    // jsdom lacks the PointerEvent constructor — synthesise events the handlers can read.
    const pointer = (type: string, x: number, y: number) => {
      const e = new Event(type, { bubbles: true });
      Object.assign(e, { clientX: x, clientY: y, pointerId: 1 });
      launcher.dispatchEvent(e);
    };
    pointer('pointerdown', 100, 100);
    pointer('pointermove', 300, 250); // > 4px → a drag, not a tap
    pointer('pointerup', 300, 250);
    launcher.click(); // the click that trails a drag must be swallowed
    expect(el.hasAttribute('open')).toBe(false);
  });

  it('launcher status dot reflects the connection state', () => {
    const el = mountWith((client) => client.connect());
    expect(q(el, '.launcher .status')?.getAttribute('data-state')).toBe('open');
  });

  it('filters the event log case-insensitively (channel / event / payload)', () => {
    const el = mountWith((client, adapter) => {
      client.connect();
      client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
      adapter.emit('trades', { symbol: 'ADA' });
      adapter.emit('trades', { symbol: 'XRP' });
      adapter.emit('trades', { symbol: 'ADA' });
    });
    const input = q(el, '.toolbar input[data-action="filter"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    type(input, 'ada');
    expect(rowCount(el)).toBe(2);
    expect([...el.shadowRoot!.querySelectorAll('.body .row')].every((r) => /ADA/.test(r.textContent ?? ''))).toBe(true);
    type(input, ''); // clearing the filter restores all rows
    expect(rowCount(el)).toBe(3);
  });

  it('expands a row to reveal the full pretty-printed payload + a copy button', () => {
    const el = mountWith((client, adapter) => {
      client.connect();
      client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
      adapter.emit('trades', { deep: { a: 1, b: [2, 3] } });
    });
    expect(q(el, '.body .detail')).toBeNull(); // collapsed by default
    (q(el, '.body .row .row-main') as HTMLElement).click();
    const pre = q(el, '.body .row[aria-expanded="true"] .detail pre');
    expect(pre?.textContent).toContain('"deep"');
    expect(pre?.textContent).toContain('"b"');
    expect(q(el, '.body .detail .copy')).toBeTruthy();
    (q(el, '.body .row .row-main') as HTMLElement).click(); // collapses again
    expect(q(el, '.body .detail')).toBeNull();
  });

  it('pause toggles the control state', () => {
    const el = mountWith((client) => client.connect());
    const pause = q(el, '[data-action="pause"]') as HTMLElement;
    expect(pause.textContent).toBe('Pause');
    pause.click();
    expect(pause.textContent).toBe('Resume');
    expect(pause.getAttribute('aria-pressed')).toBe('true');
  });

  it('clear hides existing rows, and NEW live events still appear afterwards', async () => {
    const adapter = new MockAdapter();
    const client = new LivefluxClient({ adapter });
    attachDevtools(client);
    client.connect();
    client.subscribe({ channel: 'trades', into: { strategy: 'append' } });
    adapter.emit('trades', { n: 1 });
    adapter.emit('trades', { n: 2 });
    const el = document.createElement('liveflux-devtools') as LivefluxDevtoolsElement;
    document.body.appendChild(el);
    openPanel(el);
    expect(rowCount(el)).toBe(2);

    (q(el, '[data-action="clear"]') as HTMLElement).click();
    expect(rowCount(el)).toBe(0); // existing rows hidden

    adapter.emit('trades', { n: 3 }); // a brand-new event after clearing
    await flush();
    expect(rowCount(el)).toBe(1);
    expect(text(el)).toContain('trades/update');
  });

  it('tears down cleanly on disconnect', () => {
    const el = mountWith((client) => client.connect());
    expect(() => el.remove()).not.toThrow();
  });
});
