/**
 * The single source of truth for what `create-liveflux` can scaffold.
 *
 * Every selectable option lives here exactly once. Both the interactive prompts
 * and the non-interactive flag parser read from this list, so there is no code
 * path — menu, flag, or piped input — that can select something not defined
 * here, and nothing marked `soon` can be chosen until it is promoted to
 * `stable`. Adding a future adapter/binding is a one-line change.
 */

export type Status = 'stable' | 'soon';

export interface Choice {
  /** stable id used on the CLI (`--adapter ws`) and in prompts */
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly status: Status;
  /** npm package this choice pulls in (omitted when it needs no extra package, e.g. vanilla/core) */
  readonly pkg?: string;
  /** named export used in generated code (adapters: the factory, e.g. `ws`) */
  readonly importName?: string;
  /** extra packages this choice also needs (e.g. a peer client the consumer supplies) */
  readonly extraPkgs?: readonly string[];
}

/** The core engine — always installed, regardless of choices. */
export const CORE_PKG = '@liveflux/core';

export const FRAMEWORKS: readonly Choice[] = [
  { id: 'react', label: 'React', hint: 'useStream hook — typed, reconnect-safe state', status: 'stable', pkg: '@liveflux/react' },
  { id: 'vanilla', label: 'Vanilla', hint: 'framework-agnostic core only, no binding', status: 'stable' },
  { id: 'vue', label: 'Vue', hint: 'coming soon', status: 'soon' },
  { id: 'svelte', label: 'Svelte', hint: 'coming soon', status: 'soon' },
  { id: 'angular', label: 'Angular', hint: 'coming soon', status: 'soon' },
] as const;

export const ADAPTERS: readonly Choice[] = [
  { id: 'ws', label: 'ws', hint: 'generic WebSocket — any backend, any language', status: 'stable', pkg: '@liveflux/ws', importName: 'ws' },
  { id: 'phoenix', label: 'phoenix', hint: 'Elixir Phoenix Channels (v2 wire protocol)', status: 'stable', pkg: '@liveflux/phoenix', importName: 'phoenix' },
  { id: 'sse', label: 'sse', hint: 'Server-Sent Events — any backend', status: 'stable', pkg: '@liveflux/sse', importName: 'sse' },
  { id: 'socket.io', label: 'socket.io', hint: 'Socket.IO client (bring your own socket)', status: 'stable', pkg: '@liveflux/socketio', importName: 'socketio', extraPkgs: ['socket.io-client'] },
  { id: 'gql-ws', label: 'gql-ws', hint: 'GraphQL subscriptions (graphql-transport-ws)', status: 'stable', pkg: '@liveflux/graphql-ws', importName: 'graphqlWs' },
] as const;

export const stable = (choices: readonly Choice[]): Choice[] =>
  choices.filter((c) => c.status === 'stable');

export const soon = (choices: readonly Choice[]): Choice[] =>
  choices.filter((c) => c.status === 'soon');

export const byId = (choices: readonly Choice[], id: string): Choice | undefined =>
  choices.find((c) => c.id === id);
