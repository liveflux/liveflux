/**
 * @liveflux/devtools/element — the `<liveflux-devtools>` panel.
 *
 * A framework-agnostic **Web Component** (Shadow DOM) that visualises every attached Liveflux client:
 * connection state + timeline, the active-subscriptions table, a live event log, and errors. It reads
 * the headless {@link DevtoolsModel} (which discovers clients through the global hook), so it works in
 * React / Vue / Angular / vanilla and with every transport adapter, with zero per-framework code.
 *
 * Dev-only: import from `@liveflux/devtools/element` behind a dev guard and drop `<liveflux-devtools>`
 * into the page (or call {@link defineLivefluxDevtools}). Nothing here ships to production when the
 * import is tree-shaken out of a prod build.
 *
 * Security: all dynamic text (channels, payloads, messages) is HTML-escaped before it reaches the DOM,
 * and payloads arrive already redacted from the bus — the panel never renders a raw token.
 */

import {
  DevtoolsModel,
  type ClientView,
  type EventLogEntry,
  type ErrorLogEntry,
  type ConnectionTransition,
  type SubscriptionView,
} from './view-model';

const TAG = 'liveflux-devtools';
type Tab = 'connection' | 'subscriptions' | 'events' | 'errors';
const TABS: Tab[] = ['connection', 'subscriptions', 'events', 'errors'];
/** Max log rows kept in the DOM (older ones are trimmed while following) — bounds per-frame cost. */
const DOM_ROW_CAP = 300;
/** localStorage key for the launcher's position + open/minimized state (per origin). */
const STORE_KEY = 'liveflux-devtools';

/** The launcher mark: a clean monoline bug glyph (white on the brand-gradient badge). */
const DEBUG_ICON =
  `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/>` +
  `<path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/>` +
  `<path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/>` +
  `<path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/>` +
  `<path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/>` +
  `<path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/>` +
  `</svg>`;

/** DOM-safe base: falls back to a stub off the DOM so importing this module never throws in Node/SSR. */
const ElementBase: typeof HTMLElement =
  typeof HTMLElement !== 'undefined' ? HTMLElement : (class {} as unknown as typeof HTMLElement);

function esc(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function fmtTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function preview(payload: unknown, max = 140): string {
  let s: string;
  try {
    s = typeof payload === 'string' ? payload : JSON.stringify(payload);
  } catch {
    s = String(payload);
  }
  if (s === undefined) s = 'undefined';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Full, human-readable form of a value for the expanded row detail (pretty JSON, strings verbatim). */
function pretty(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const STYLE = `
:host {
  all: initial;
  /* Self-contained by default (fixed readable dark theme, so the panel looks right on ANY app —
     light or dark — and never inherits the host's --lf-* by accident). But each colour is sourced
     from an optional public --lf-dt-* variable, so a developer CAN retint the panel to match their
     app: e.g. \`liveflux-devtools { --lf-dt-primary: #e11d48; --lf-dt-surface: #1a1a1a }\` (or set the
     vars on :root). Overriding is opt-in; do nothing and you get the default. */
  --dt-fg: var(--lf-dt-fg, #e8ebf1);
  --dt-muted: var(--lf-dt-muted, #aab3c2);
  --dt-surface: var(--lf-dt-surface, #11151c);
  --dt-hover: var(--lf-dt-hover, rgba(255,255,255,0.06));
  --dt-border: var(--lf-dt-border, #2b3240);
  --dt-primary: var(--lf-dt-primary, #5b9dff);
}
*, *::before, *::after { box-sizing: border-box; }
.dock {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  /* STABLE size: a docked devtool must not resize when you switch tabs. Fixed height (not max-height)
     means a sparse tab (Connection) and a dense one (Events) look identical — sparse content
     top-aligns with room below, dense content scrolls inside. Stability > fit-to-content. */
  width: 420px; max-width: calc(100vw - 32px);
  height: min(60vh, 480px); max-height: calc(100vh - 32px);
  display: flex; flex-direction: column; overflow: hidden;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; line-height: 1.5;
  color: var(--dt-fg); background: var(--dt-surface);
  border: 1px solid var(--dt-border); border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.45);
}
.dock { transform-origin: right bottom; }
/* The floating launcher: a draggable "D-with-a-bug" badge shown when the panel is minimized. */
.launcher {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  width: 44px; height: 44px; padding: 0; border: none; border-radius: 14px; cursor: grab;
  display: grid; place-items: center; transform-origin: right bottom; touch-action: none;
  color: #fff; background: linear-gradient(140deg, #6aa8ff, #6366f1 58%, #5b54e6);
  box-shadow: 0 8px 22px rgba(79,70,229,0.42), inset 0 1px 0 rgba(255,255,255,0.22);
}
.launcher:hover { transform: translateY(-2px) scale(1.05); box-shadow: 0 14px 30px rgba(79,70,229,0.55), inset 0 1px 0 rgba(255,255,255,0.22); }
.launcher:active { cursor: grabbing; }
.launcher svg { width: 23px; height: 23px; display: block; pointer-events: none; }
.launcher .status {
  position: absolute; top: -2px; right: -2px; width: 11px; height: 11px; border-radius: 50%;
  border: 2.5px solid var(--dt-surface); background: var(--dt-muted);
  box-shadow: 0 1px 3px rgba(0,0,0,0.4);
}
.launcher .status[data-state="open"] { background: #34d399; }
.launcher .status[data-state="connecting"], .launcher .status[data-state="reconnecting"] { background: #fbbf24; }
.launcher .status[data-state="closed"] { background: #f87171; }
/* Minimized ⇄ open morph: launcher and dock scale from the same corner so it reads as one object. */
:host(:not([open])) .dock { opacity: 0; transform: scale(0.92); pointer-events: none; }
:host([open]) .launcher { opacity: 0; transform: scale(0.6); pointer-events: none; }
@media (prefers-reduced-motion: no-preference) {
  .dock, .launcher { transition: transform 170ms cubic-bezier(0.2,0.7,0.2,1), opacity 150ms ease, box-shadow 150ms ease; }
}
.header { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--dt-border); }
.brand { font-weight: 700; letter-spacing: -0.2px; color: var(--dt-fg); }
.brand .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: var(--dt-primary); }
.pill { font-size: 10px; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--dt-border); color: var(--dt-muted); text-transform: uppercase; letter-spacing: 0.4px; }
.pill[data-state="open"] { color: #34d399; border-color: #34d39955; }
.pill[data-state="reconnecting"], .pill[data-state="connecting"] { color: #fbbf24; border-color: #fbbf2455; }
.pill[data-state="closed"] { color: #f87171; border-color: #f8717155; }
.spacer { flex: 1; }
select, .toggle { font: inherit; color: var(--dt-fg); background: transparent; border: 1px solid var(--dt-border); border-radius: 6px; padding: 2px 6px; cursor: pointer; }
.toggle:hover { background: var(--dt-hover); }
:focus-visible { outline: 2px solid var(--dt-primary); outline-offset: 1px; }
.tabs { display: flex; gap: 2px; padding: 6px 8px 0; border-bottom: 1px solid var(--dt-border); }
[role="tab"] { border: none; border-bottom: 2px solid transparent; border-radius: 6px 6px 0 0; padding: 6px 10px; color: var(--dt-muted); background: transparent; cursor: pointer; }
[role="tab"]:hover { color: var(--dt-fg); background: var(--dt-hover); }
[role="tab"][aria-selected="true"] { color: var(--dt-fg); border-bottom-color: var(--dt-primary); }
.count { margin-left: 5px; font-size: 10px; color: var(--dt-muted); }
[role="tab"][aria-selected="true"] .count { color: var(--dt-primary); }
.header, .tabs { flex: none; }
.body {
  flex: 1 1 auto; min-height: 0;              /* take the remaining height in the flex column… */
  overflow-y: auto; overflow-x: hidden;        /* …and become the scroll container */
  overscroll-behavior: contain;                /* scrolling the log never chains to the page */
  padding: 8px 10px;
  scrollbar-width: thin; scrollbar-color: var(--dt-border) transparent;
}
.body::-webkit-scrollbar { width: 10px; }
.body::-webkit-scrollbar-thumb { background: var(--dt-border); border-radius: 8px; border: 3px solid var(--dt-surface); }
.body::-webkit-scrollbar-track { background: transparent; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--dt-border); vertical-align: top; }
th { color: var(--dt-muted); font-weight: 600; }
.mut { color: var(--dt-muted); }
.chan { color: var(--dt-primary); }
.pay { white-space: pre-wrap; word-break: break-word; color: var(--dt-fg); }
.empty { color: var(--dt-muted); padding: 18px 6px; text-align: center; }
.row { display: flex; flex-direction: column; padding: 0; border-bottom: 1px solid var(--dt-border); }
.row-main { display: flex; gap: 8px; align-items: baseline; padding: 4px 0; cursor: pointer; }
.row-main:hover { background: var(--dt-hover); }
.row[aria-expanded="true"] > .row-main { background: var(--dt-hover); }
.caret { color: var(--dt-muted); width: 10px; flex: none; text-align: center; }
.err { color: #f87171; }
.toolbar { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--dt-border); flex: none; }
.toolbar input { flex: 1; min-width: 0; font: inherit; color: var(--dt-fg); background: transparent; border: 1px solid var(--dt-border); border-radius: 6px; padding: 3px 8px; }
.toolbar input::placeholder { color: var(--dt-muted); }
.btn { font: inherit; color: var(--dt-muted); background: transparent; border: 1px solid var(--dt-border); border-radius: 6px; padding: 3px 8px; cursor: pointer; white-space: nowrap; }
.btn:hover { background: var(--dt-hover); color: var(--dt-fg); }
.btn[aria-pressed="true"] { color: var(--dt-primary); border-color: var(--dt-primary); }
.rate { margin-left: auto; color: var(--dt-muted); font-size: 10px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.detail { padding: 6px 8px 8px 18px; background: rgba(0,0,0,0.22); }
.detail pre { margin: 0 0 6px; white-space: pre-wrap; word-break: break-word; color: var(--dt-fg); max-height: 220px; overflow: auto; }
.copy { font: inherit; color: var(--dt-muted); background: transparent; border: 1px solid var(--dt-border); border-radius: 6px; padding: 2px 8px; cursor: pointer; }
.copy:hover { background: var(--dt-hover); color: var(--dt-fg); }
@media (prefers-reduced-motion: no-preference) {
  [role="tab"], .row-main, .toggle, .btn, .copy { transition: color 120ms ease, background 120ms ease, border-color 120ms ease; }
}
`;

/**
 * The `<liveflux-devtools>` custom element. Prefer {@link defineLivefluxDevtools} to register it.
 */
export class LivefluxDevtoolsElement extends ElementBase {
  #model: DevtoolsModel | null = null;
  #off: (() => void) | null = null;
  #renderScheduled = false;
  #selected: string | null = null;
  #tab: Tab = 'events';
  /** Panel open (full window) vs minimized (just the floating launcher icon). Persisted. */
  #open = false;
  /** Launcher top-left in px (persisted); null = default bottom-right corner. */
  #pos: { left: number; top: number } | null = null;
  /** Drag bookkeeping for the launcher: active pointer, grab offset, and moved-past-threshold flag. */
  #dragActive = false;
  #moved = false;
  #dragOff = { x: 0, y: 0 };
  #dragStart = { x: 0, y: 0 };
  /** "Follow the tail": stick to newest (bottom). Set false when the user scrolls up to read. */
  #follow = true;
  /** Signature of the currently-rendered (client, tab) — a change triggers a full body rebuild. */
  #renderKey = '';
  /** Highest event/error `seq` already appended to the log body — the incremental-append cursor. */
  #appendCursor = -1;
  /** Case-insensitive log filter (matches channel/event/payload, or name/code/message for errors). */
  #filter = '';
  /** Freeze the log view for inspection — the model keeps folding; resume rebuilds to catch up. */
  #paused = false;
  /** Hide every row at or below this `seq` (a non-destructive "Clear"); -1 = show all. */
  #clearSeq = -1;
  /** `seq`s of log rows the user has expanded to see the full, pretty-printed payload. */
  readonly #expanded = new Set<number>();

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    const root = this.shadowRoot;
    if (!root) return;
    // Build the shell ONCE — header, tabs, and body are stable elements. Renders update their
    // contents in place; the body element is never recreated, so the log can be appended to
    // incrementally and its scroll position survives (the key to handling a fast stream).
    root.innerHTML =
      `<style>${STYLE}</style>` +
      `<button class="launcher" data-action="open" type="button" aria-label="Open Liveflux DevTools" title="Liveflux DevTools">${DEBUG_ICON}<span class="status" aria-hidden="true"></span></button>` +
      `<div class="dock" part="dock" role="region" aria-label="Liveflux DevTools">` +
      `<div class="header"></div>` +
      `<div class="tabs" role="tablist" aria-label="DevTools sections"></div>` +
      `<div class="toolbar"></div>` +
      `<div class="body" id="lf-panel" role="tabpanel" tabindex="0"></div>` +
      `</div>`;
    root.addEventListener('click', (e) => this.#onClick(e));
    root.addEventListener('change', (e) => this.#onChange(e));
    root.addEventListener('input', (e) => this.#onInput(e));
    root.addEventListener('keydown', (e) => this.#onKeydown(e as KeyboardEvent));
    // `scroll` doesn't bubble — listen in the capture phase to catch the body scrolling.
    root.addEventListener('scroll', (e) => this.#onScroll(e), true);
    // Drag the launcher anywhere (pointer events → works for mouse, touch and pen).
    const launcher = root.querySelector('.launcher') as HTMLElement;
    launcher.addEventListener('pointerdown', (e) => this.#onDragStart(e as PointerEvent));
    launcher.addEventListener('pointermove', (e) => this.#onDragMove(e as PointerEvent));
    launcher.addEventListener('pointerup', (e) => this.#onDragEnd(e as PointerEvent));
    window.addEventListener('resize', this.#onResize);

    this.#restore(); // remembered position + open/minimized state
    this.toggleAttribute('open', this.#open);
    this.#applyPosition();
    this.#model = new DevtoolsModel();
    this.#off = this.#model.subscribe(() => this.#schedule());
    this.#render();
  }

  disconnectedCallback(): void {
    this.#off?.();
    this.#model?.destroy();
    this.#off = null;
    this.#model = null;
    window.removeEventListener('resize', this.#onResize);
  }

  #schedule(): void {
    if (this.#renderScheduled) return;
    this.#renderScheduled = true;
    const raf =
      typeof requestAnimationFrame !== 'undefined'
        ? requestAnimationFrame
        : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16);
    raf(() => {
      this.#renderScheduled = false;
      this.#render();
    });
  }

  #setOpen(open: boolean): void {
    if (this.#open === open) return;
    this.#open = open;
    this.toggleAttribute('open', open);
    this.#persist();
    if (open) {
      this.#renderKey = ''; // rebuild the panel body that was skipped while minimized
      this.#render();
      (this.shadowRoot?.querySelector('.body') as HTMLElement | null)?.focus();
    } else {
      (this.shadowRoot?.querySelector('.launcher') as HTMLElement | null)?.focus();
    }
  }

  /** Place the launcher at its custom position and anchor the panel to the nearest on-screen corner. */
  #applyPosition(): void {
    const root = this.shadowRoot;
    const launcher = root?.querySelector('.launcher') as HTMLElement | null;
    const dock = root?.querySelector('.dock') as HTMLElement | null;
    if (!launcher || !dock || !this.#pos) return; // no custom position → CSS default (bottom-right)
    const size = 44;
    const { left, top } = this.#pos;
    Object.assign(launcher.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
    const w = typeof window !== 'undefined' ? window.innerWidth : 1024;
    const h = typeof window !== 'undefined' ? window.innerHeight : 768;
    const right = left + size / 2 > w / 2;
    const bottom = top + size / 2 > h / 2;
    Object.assign(dock.style, {
      left: right ? 'auto' : '16px',
      right: right ? '16px' : 'auto',
      top: bottom ? 'auto' : '16px',
      bottom: bottom ? '16px' : 'auto',
    });
    const origin = `${right ? 'right' : 'left'} ${bottom ? 'bottom' : 'top'}`;
    dock.style.transformOrigin = origin;
    launcher.style.transformOrigin = origin;
  }

  #onDragStart(e: PointerEvent): void {
    const launcher = e.currentTarget as HTMLElement;
    launcher.setPointerCapture?.(e.pointerId);
    const r = launcher.getBoundingClientRect();
    this.#dragOff = { x: e.clientX - r.left, y: e.clientY - r.top };
    this.#dragStart = { x: e.clientX, y: e.clientY };
    this.#pos = { left: r.left, top: r.top }; // pin to px so the drag can move it freely
    this.#dragActive = true;
    this.#moved = false;
  }

  #onDragMove(e: PointerEvent): void {
    if (!this.#dragActive) return;
    if (Math.hypot(e.clientX - this.#dragStart.x, e.clientY - this.#dragStart.y) > 4) this.#moved = true;
    this.#pos = this.#clampPos(e.clientX - this.#dragOff.x, e.clientY - this.#dragOff.y);
    this.#applyPosition();
  }

  #onDragEnd(e: PointerEvent): void {
    if (!this.#dragActive) return;
    this.#dragActive = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (this.#moved) this.#persist(); // the trailing click is swallowed in #onClick via #moved
  }

  #onResize = (): void => {
    if (!this.#pos) return;
    this.#pos = this.#clampPos(this.#pos.left, this.#pos.top);
    this.#applyPosition();
  };

  #clampPos(left: number, top: number): { left: number; top: number } {
    const size = 44;
    const m = 8;
    const w = typeof window !== 'undefined' ? window.innerWidth : 1024;
    const h = typeof window !== 'undefined' ? window.innerHeight : 768;
    return {
      left: Math.min(Math.max(m, left), w - size - m),
      top: Math.min(Math.max(m, top), h - size - m),
    };
  }

  #persist(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ pos: this.#pos, open: this.#open }));
    } catch {
      // storage unavailable (private mode / disabled) — position simply won't persist
    }
  }

  #restore(): void {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw) as { pos?: { left: number; top: number } | null; open?: boolean };
      if (s.pos && typeof s.pos.left === 'number' && typeof s.pos.top === 'number') {
        this.#pos = this.#clampPos(s.pos.left, s.pos.top);
      }
      if (typeof s.open === 'boolean') this.#open = s.open;
    } catch {
      // ignore malformed / blocked storage
    }
  }

  #clients(): ClientView[] {
    return this.#model ? this.#model.getState().clients : [];
  }

  #current(clients: ClientView[]): ClientView | undefined {
    return clients.find((c) => c.id === this.#selected) ?? clients[0];
  }

  #onClick(e: Event): void {
    const target = e.target as HTMLElement | null;
    const el = target?.closest('[data-action]') as HTMLElement | null;
    if (el) {
      const action = el.dataset.action;
      if (action === 'open') {
        // A real drag ends in a click too — swallow that one so dragging never opens the panel.
        if (this.#moved) this.#moved = false;
        else this.#setOpen(true);
        return;
      }
      if (action === 'minimize') {
        this.#setOpen(false);
        return;
      }
      if (action === 'tab') this.#tab = el.dataset.tab as Tab;
      else if (action === 'pause') {
        this.#paused = !this.#paused;
        this.#renderKey = ''; // resume → rebuild the body once to catch up on what streamed while paused
      } else if (action === 'clear') {
        // Non-destructive: hide everything folded so far; new events still stream in below.
        this.#clearSeq = this.#lastSeq();
        this.#expanded.clear();
      } else if (action === 'copy') {
        this.#copyRow(Number(el.dataset.seq), el);
        return; // copying must not toggle the row
      }
      this.#render();
      return;
    }
    // A click on a row (not a control) toggles its expanded full-payload detail.
    const main = target?.closest('.row-main') as HTMLElement | null;
    const row = main?.parentElement as HTMLElement | null;
    if (row?.dataset.seq) this.#toggleExpand(Number(row.dataset.seq));
  }

  #onChange(e: Event): void {
    const el = e.target as HTMLSelectElement | null;
    if (el && el.dataset.action === 'select') {
      this.#selected = el.value;
      this.#render();
    }
  }

  #onInput(e: Event): void {
    const el = e.target as HTMLInputElement | null;
    if (el && el.dataset.action === 'filter') {
      this.#filter = el.value;
      this.#render(); // filter is part of the render key → a full, focus-preserving body rebuild
    }
  }

  /** Highest `seq` folded for the current client (events and errors share one per-client counter). */
  #lastSeq(): number {
    const c = this.#current(this.#clients());
    const last = c?.events.at(-1)?.seq ?? -1;
    return Math.max(last, c?.errors.at(-1)?.seq ?? -1);
  }

  #entryBySeq(seq: number): { entry: EventLogEntry | ErrorLogEntry; isErr: boolean } | undefined {
    const c = this.#current(this.#clients());
    if (!c) return undefined;
    const ev = c.events.find((x) => x.seq === seq);
    if (ev) return { entry: ev, isErr: false };
    const er = c.errors.find((x) => x.seq === seq);
    return er ? { entry: er, isErr: true } : undefined;
  }

  #toggleExpand(seq: number): void {
    const found = this.#entryBySeq(seq);
    if (!found) return;
    if (this.#expanded.has(seq)) this.#expanded.delete(seq);
    else this.#expanded.add(seq);
    // Rewrite just this row in place — no full rebuild, so the live stream is undisturbed.
    const row = this.shadowRoot?.querySelector(`.row[data-seq="${seq}"]`);
    if (row) row.outerHTML = this.#rowHTML(found.entry, found.isErr);
  }

  #copyRow(seq: number, btn: HTMLElement): void {
    const found = this.#entryBySeq(seq);
    if (!found) return;
    const text = found.isErr
      ? pretty({
          name: (found.entry as ErrorLogEntry).name,
          code: (found.entry as ErrorLogEntry).code,
          message: (found.entry as ErrorLogEntry).message,
        })
      : pretty((found.entry as EventLogEntry).payload);
    void navigator?.clipboard?.writeText(text).then(
      () => {
        btn.textContent = 'Copied';
        setTimeout(() => (btn.textContent = 'Copy'), 1200);
      },
      () => {},
    );
  }

  #onScroll(e: Event): void {
    const t = e.target as HTMLElement | null;
    if (!t || !t.classList.contains('body')) return;
    // Following = the user is at (or near) the bottom. Scroll up → pause; return to bottom → resume.
    this.#follow = t.scrollTop + t.clientHeight >= t.scrollHeight - 4;
  }

  #onKeydown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (!target || target.getAttribute('role') !== 'tab') return;
    const i = TABS.indexOf(this.#tab);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : (i - 1 + TABS.length) % TABS.length;
      this.#tab = TABS[next]!;
      this.#render();
      (this.shadowRoot?.querySelector('[role="tab"][aria-selected="true"]') as HTMLElement | null)?.focus();
    }
  }

  #isLogTab(): boolean {
    return this.#tab === 'events' || this.#tab === 'errors';
  }

  #render(): void {
    const root = this.shadowRoot;
    const dock = root?.querySelector('.dock') as HTMLElement | null;
    if (!root || !dock) return;

    const clients = this.#clients();
    const c = this.#current(clients);

    // The launcher's status dot reflects connection health at a glance — kept live even when minimized.
    const status = root.querySelector('.launcher .status') as HTMLElement | null;
    if (status) status.dataset.state = c?.connectionState ?? 'idle';
    // Minimized → the panel is hidden, so skip rendering it entirely (cheap while a stream runs).
    if (!this.#open) return;

    this.#renderHeader(root.querySelector('.header') as HTMLElement, c, clients);
    this.#renderTabs(root.querySelector('.tabs') as HTMLElement, c);

    const toolbar = root.querySelector('.toolbar') as HTMLElement;
    const body = root.querySelector('.body') as HTMLElement;
    body.setAttribute('aria-labelledby', `lf-tab-${this.#tab}`);

    if (!c) {
      toolbar.style.display = 'none';
      body.innerHTML = `<div class="empty">No Liveflux client attached.<br/>Call <code>attachDevtools(client)</code>.</div>`;
      this.#renderKey = 'none';
      return;
    }

    // The filter / pause / clear toolbar only applies to the event & error logs.
    if (this.#isLogTab()) {
      toolbar.style.display = 'flex';
      this.#renderToolbar(toolbar, c);
      if (this.#paused) return; // frozen for inspection — model keeps folding; resume rebuilds
    } else {
      toolbar.style.display = 'none';
    }

    // Filter + clear-baseline are part of "what is shown", so a change to either forces a rebuild.
    const key = this.#isLogTab()
      ? `${c.id}|${this.#tab}|${this.#filter}|${this.#clearSeq}`
      : `${c.id}|${this.#tab}`;
    if (key !== this.#renderKey) {
      // Client, tab, filter or clear changed → rebuild the whole body once for this view.
      this.#renderKey = key;
      this.#appendCursor = -1;
      this.#fullRenderBody(body, c);
    } else if (this.#tab === 'events') {
      this.#appendRows(body, c.events, false);
    } else if (this.#tab === 'errors') {
      this.#appendRows(body, c.errors, true);
    } else {
      // connection / subscriptions: small + mutate in place → a cheap full rebuild is fine.
      this.#fullRenderBody(body, c);
    }

    // Follow the tail: while at the bottom, trim the DOM to the cap and stick to newest. When the
    // user has scrolled up (paused), don't trim or scroll — appended rows sit below, view stays put.
    if (this.#follow) {
      if (this.#isLogTab()) {
        while (body.childElementCount > DOM_ROW_CAP) body.removeChild(body.firstElementChild!);
      }
      body.scrollTop = body.scrollHeight;
    }
  }

  #renderHeader(header: HTMLElement, c: ClientView | undefined, clients: ClientView[]): void {
    const state = c?.connectionState ?? 'idle';
    const selector =
      clients.length > 1
        ? `<select data-action="select" aria-label="Client">${clients
            .map((cl) => `<option value="${esc(cl.id)}"${cl.id === c?.id ? ' selected' : ''}>${esc(cl.id)}${cl.present ? '' : ' (gone)'}</option>`)
            .join('')}</select>`
        : '';
    header.innerHTML =
      `<span class="brand"><span class="dot"></span>Liveflux</span>` +
      `<span class="pill" data-state="${esc(state)}">${esc(state)}</span>` +
      selector +
      `<span class="spacer"></span>` +
      `<button class="toggle" data-action="minimize" aria-label="Minimize to launcher" title="Minimize">─</button>`;
  }

  #renderTabs(tabsEl: HTMLElement, c: ClientView | undefined): void {
    const counts: Record<Tab, number> = {
      connection: c?.connectionTimeline.length ?? 0,
      subscriptions: c?.subscriptions.length ?? 0,
      events: c?.events.length ?? 0,
      errors: c?.errors.length ?? 0,
    };
    tabsEl.innerHTML = TABS.map((t) => {
      const sel = t === this.#tab;
      return `<button role="tab" id="lf-tab-${t}" aria-selected="${sel}" aria-controls="lf-panel" tabindex="${sel ? 0 : -1}" data-action="tab" data-tab="${t}">${t[0]!.toUpperCase() + t.slice(1)}<span class="count">${counts[t]}</span></button>`;
    }).join('');
  }

  /** Build the log toolbar once (so typing never loses focus), then update its live bits in place. */
  #renderToolbar(toolbar: HTMLElement, c: ClientView): void {
    const isErr = this.#tab === 'errors';
    const list = isErr ? c.errors : c.events;
    if (!toolbar.querySelector('input')) {
      toolbar.innerHTML =
        `<input type="search" data-action="filter" aria-label="Filter log" placeholder="Filter…" />` +
        `<button class="btn" data-action="pause" aria-pressed="false">Pause</button>` +
        `<button class="btn" data-action="clear">Clear</button>` +
        `<span class="rate"></span>`;
    }
    const pause = toolbar.querySelector('[data-action="pause"]') as HTMLElement;
    pause.textContent = this.#paused ? 'Resume' : 'Pause';
    pause.setAttribute('aria-pressed', String(this.#paused));
    const last = list.at(-1);
    const filtered = this.#filter || this.#clearSeq >= 0 ? ' · filtered' : '';
    (toolbar.querySelector('.rate') as HTMLElement).textContent =
      `${list.length} ${isErr ? 'errors' : 'events'}${last ? ` · ${fmtTime(last.at)}` : ''}${filtered}`;
  }

  /** Case-insensitive filter across a row's visible fields. */
  #matches(e: EventLogEntry | ErrorLogEntry, isErr: boolean): boolean {
    if (!this.#filter) return true;
    const hay = isErr
      ? `${(e as ErrorLogEntry).name} ${(e as ErrorLogEntry).code ?? ''} ${(e as ErrorLogEntry).message}`
      : `${(e as EventLogEntry).channel} ${(e as EventLogEntry).event} ${preview((e as EventLogEntry).payload, 500)}`;
    return hay.toLowerCase().includes(this.#filter.toLowerCase());
  }

  #fullRenderBody(body: HTMLElement, c: ClientView): void {
    if (this.#tab === 'connection') {
      body.innerHTML = this.#renderConnection(c.connectionTimeline, c.connectionState);
      return;
    }
    if (this.#tab === 'subscriptions') {
      body.innerHTML = this.#renderSubs(c.subscriptions);
      return;
    }
    const isErr = this.#tab === 'errors';
    const entries = isErr ? c.errors : c.events;
    // Advance the cursor past everything folded so far, even rows hidden by clear/filter — so the
    // live append below only ever considers genuinely new rows.
    this.#appendCursor = entries.length ? entries[entries.length - 1]!.seq : -1;
    const visible = entries.filter((e) => e.seq > this.#clearSeq && this.#matches(e, isErr));
    if (!visible.length) {
      const msg = this.#filter ? 'No matching rows.' : isErr ? 'No errors.' : 'No events yet.';
      body.innerHTML = `<div class="empty">${msg}</div>`;
      return;
    }
    body.innerHTML = visible
      .slice(-DOM_ROW_CAP)
      .map((e) => this.#rowHTML(e, isErr))
      .join('');
  }

  /** Incrementally append only rows newer than {@link #appendCursor} — the hot path for a live log. */
  #appendRows(body: HTMLElement, entries: readonly (EventLogEntry | ErrorLogEntry)[], isErr: boolean): void {
    if (!entries.length) return;
    let html = '';
    for (const e of entries) {
      if (e.seq <= this.#appendCursor) continue;
      this.#appendCursor = e.seq;
      if (e.seq <= this.#clearSeq || !this.#matches(e, isErr)) continue; // hidden by clear/filter
      html += this.#rowHTML(e, isErr);
    }
    if (!html) return;
    if (body.querySelector(':scope > .empty')) body.innerHTML = ''; // drop any placeholder
    body.insertAdjacentHTML('beforeend', html);
  }

  #rowHTML(e: EventLogEntry | ErrorLogEntry, isErr: boolean): string {
    const expanded = this.#expanded.has(e.seq);
    let main: string;
    if (isErr) {
      const er = e as ErrorLogEntry;
      main = `<span class="mut">${fmtTime(er.at)}</span><span class="err">${esc(er.name)}${er.code ? ` <span class="mut">${esc(er.code)}</span>` : ''}</span><span class="pay">${esc(er.message)}</span>`;
    } else {
      const ev = e as EventLogEntry;
      main = `<span class="mut">${fmtTime(ev.at)}</span><span class="chan">${esc(ev.channel)}/${esc(ev.event)}</span><span class="mut">${esc(ev.bytes)}b</span><span class="pay">${esc(preview(ev.payload))}</span>`;
    }
    const detail = expanded ? this.#detailHTML(e, isErr) : '';
    return `<div class="row" data-seq="${e.seq}" aria-expanded="${expanded}"><div class="row-main"><span class="caret">${expanded ? '▾' : '▸'}</span>${main}</div>${detail}</div>`;
  }

  /** The expanded row: full, pretty-printed payload (events) or error object, plus a copy button. */
  #detailHTML(e: EventLogEntry | ErrorLogEntry, isErr: boolean): string {
    const text = isErr
      ? pretty({
          name: (e as ErrorLogEntry).name,
          code: (e as ErrorLogEntry).code,
          message: (e as ErrorLogEntry).message,
        })
      : pretty((e as EventLogEntry).payload);
    return `<div class="detail"><pre>${esc(text)}</pre><button class="copy" data-action="copy" data-seq="${e.seq}">Copy</button></div>`;
  }

  #renderConnection(timeline: ConnectionTransition[], state: string): string {
    const rows = timeline
      .map((t) => `<div class="row"><span class="mut">${fmtTime(t.at)}</span><span>${esc(t.from)} → <b>${esc(t.to)}</b></span></div>`)
      .join('');
    return `<div class="mut" style="margin-bottom:6px">Current: <b>${esc(state)}</b></div>` + (rows || `<div class="empty">No transitions yet.</div>`);
  }

  #renderSubs(subs: SubscriptionView[]): string {
    if (!subs.length) return `<div class="empty">No active subscriptions.</div>`;
    return (
      `<table><thead><tr><th>Channel</th><th>Strategy</th><th>Refs</th></tr></thead><tbody>` +
      subs
        .map(
          (s) =>
            `<tr><td class="chan">${esc(s.channel)}</td><td>${esc(s.strategy)}${s.cap !== undefined ? ` <span class="mut">cap ${esc(s.cap)}</span>` : ''}</td><td>${esc(s.refCount)}</td></tr>`,
        )
        .join('') +
      `</tbody></table>`
    );
  }

}

/**
 * Register `<liveflux-devtools>` (idempotent; no-op off the DOM). Call once, then drop the element into
 * the page. Pass a custom tag if the default collides.
 */
export function defineLivefluxDevtools(tag: string = TAG): void {
  if (typeof customElements === 'undefined') return;
  if (!customElements.get(tag)) customElements.define(tag, LivefluxDevtoolsElement);
}
