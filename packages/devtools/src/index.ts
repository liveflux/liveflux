/**
 * @liveflux/devtools — dev-only observability tooling for Liveflux.
 *
 * Install as a devDependency and attach to a client behind a dev guard so it is stripped from
 * production builds (see {@link attachDevtools}). A DevTools panel discovers attached clients through
 * the global hook and reads their {@link ObservabilityBus}.
 */

export { attachDevtools } from './attach';
export type { AttachDevtoolsOptions } from './attach';

export { attachLogger } from './logger';
export type { AttachLoggerOptions, LogLevel, LogSink } from './logger';

export { ObservabilityBus } from './bus';
export { getDevtoolsHook, DEVTOOLS_HOOK_KEY } from './hook';
export type { DevtoolsHook, ClientHandle } from './hook';

export type { DevtoolsEvent, DevtoolsErrorInfo } from './events';
export { DEFAULT_REDACT_KEYS } from './redact';

export { ClientModel, DevtoolsModel } from './view-model';
export type {
  ClientView,
  DevtoolsState,
  ConnectionTransition,
  SubscriptionView,
  EventLogEntry,
  ErrorLogEntry,
  ViewModelCaps,
} from './view-model';
