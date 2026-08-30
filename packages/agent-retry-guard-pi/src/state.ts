import {
  judgeRetry,
  type RetryAttempt,
  type RetryAttemptOutcome,
  type RetryPolicy,
  type RetryVerdict,
} from '@j1nn0/agent-retry-guard';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

export const STATE_CUSTOM_TYPE = 'agent-retry-state';
export const ADAPTER_SCHEMA_VERSION = 1 as const;

export const AUTO_RECORD_CUSTOM_TYPE = 'agent-retry-auto-record';

export interface RetryState {
  readonly attempts: readonly RetryAttempt[];
  readonly policy: RetryPolicy;
}

export interface PersistedState {
  readonly schemaVersion: 1;
  readonly attempts: readonly RetryAttempt[];
  readonly policy: RetryPolicy;
}

export interface StateController {
  readonly getState: () => RetryState;
  readonly replaceState: (state: RetryState) => void;
  readonly persist: () => void;
}

export type AddAttemptResult =
  | { readonly changed: true; readonly state: RetryState }
  | { readonly changed: false; readonly reason: 'invalid' };

export type SetPolicyResult =
  | { readonly changed: true; readonly state: RetryState }
  | { readonly changed: false };

export type StartEpisodeResult =
  | { readonly changed: true; readonly state: RetryState }
  | { readonly changed: false };

const INVALID_STATE_WARNING =
  'Agent Retry Guard: persisted state was invalid; starting with fresh state.';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function isRetryAttemptOutcome(
  value: unknown,
): value is RetryAttemptOutcome {
  return (
    value === 'success' ||
    value === 'failure' ||
    value === 'no_progress' ||
    value === 'unknown'
  );
}

export function isValidStrategyId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 1
  );
}

function copyAttempt(attempt: RetryAttempt): RetryAttempt {
  return attempt.strategyId === undefined
    ? { outcome: attempt.outcome }
    : { outcome: attempt.outcome, strategyId: attempt.strategyId };
}

function copyPolicy(policy: RetryPolicy): RetryPolicy {
  return {
    ...(policy.maxAttempts === undefined
      ? {}
      : { maxAttempts: policy.maxAttempts }),
    ...(policy.maxStrategyAttempts === undefined
      ? {}
      : { maxStrategyAttempts: policy.maxStrategyAttempts }),
  };
}

function parsePersistedAttempt(value: unknown): RetryAttempt | undefined {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ['outcome', 'strategyId']) ||
    !hasOwn(value, 'outcome') ||
    !isRetryAttemptOutcome(value.outcome)
  ) {
    return undefined;
  }

  if (!hasOwn(value, 'strategyId')) {
    return { outcome: value.outcome };
  }

  return isValidStrategyId(value.strategyId)
    ? { outcome: value.outcome, strategyId: value.strategyId }
    : undefined;
}

function parsePersistedPolicy(value: unknown): RetryPolicy | undefined {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['maxAttempts', 'maxStrategyAttempts'])) {
    return undefined;
  }

  let maxAttempts: number | undefined;
  if (hasOwn(value, 'maxAttempts')) {
    if (!isPositiveInteger(value.maxAttempts)) {
      return undefined;
    }
    maxAttempts = value.maxAttempts;
  }

  let maxStrategyAttempts: number | undefined;
  if (hasOwn(value, 'maxStrategyAttempts')) {
    if (!isPositiveInteger(value.maxStrategyAttempts)) {
      return undefined;
    }
    maxStrategyAttempts = value.maxStrategyAttempts;
  }

  return {
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    ...(maxStrategyAttempts === undefined ? {} : { maxStrategyAttempts }),
  };
}

function parsePersistedState(value: unknown): RetryState | undefined {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ['schemaVersion', 'attempts', 'policy']) ||
    !hasOwn(value, 'schemaVersion') ||
    value.schemaVersion !== ADAPTER_SCHEMA_VERSION ||
    !hasOwn(value, 'attempts') ||
    !Array.isArray(value.attempts) ||
    !hasOwn(value, 'policy')
  ) {
    return undefined;
  }

  const attempts: RetryAttempt[] = [];
  for (const rawAttempt of value.attempts) {
    const attempt = parsePersistedAttempt(rawAttempt);
    if (attempt === undefined) {
      return undefined;
    }
    attempts.push(attempt);
  }

  const policy = parsePersistedPolicy(value.policy);
  if (policy === undefined) {
    return undefined;
  }

  return { attempts, policy };
}

export function createEmptyState(): RetryState {
  return { attempts: [], policy: {} };
}

export function loadState(
  ctx: Pick<ExtensionContext, 'sessionManager' | 'ui'>,
): RetryState {
  try {
    const latestStateEntry = ctx.sessionManager
      .getBranch()
      .filter(
        (entry) =>
          entry.type === 'custom' && entry.customType === STATE_CUSTOM_TYPE,
      )
      .at(-1);

    if (latestStateEntry === undefined || latestStateEntry.type !== 'custom') {
      return createEmptyState();
    }

    const state = parsePersistedState(latestStateEntry.data);
    if (state === undefined) {
      ctx.ui.notify(INVALID_STATE_WARNING, 'warning');
      return createEmptyState();
    }
    return state;
  } catch {
    ctx.ui.notify(INVALID_STATE_WARNING, 'warning');
    return createEmptyState();
  }
}

export function loadAutoRecordEnabled(
  ctx: Pick<ExtensionContext, 'sessionManager'>,
): boolean {
  try {
    const latestAutoRecordEntry = ctx.sessionManager
      .getBranch()
      .filter(
        (entry) =>
          entry.type === 'custom' && entry.customType === AUTO_RECORD_CUSTOM_TYPE,
      )
      .at(-1);

    if (latestAutoRecordEntry === undefined || latestAutoRecordEntry.type !== 'custom') {
      return false;
    }

    const data = latestAutoRecordEntry.data;
    return (
      isPlainRecord(data) &&
      hasOnlyKeys(data, ['schemaVersion', 'enabled']) &&
      hasOwn(data, 'schemaVersion') &&
      data.schemaVersion === ADAPTER_SCHEMA_VERSION &&
      hasOwn(data, 'enabled') &&
      data.enabled === true
    );
  } catch {
    return false;
  }
}

export function persistAutoRecordEnabled(
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  enabled: boolean,
): void {
  pi.appendEntry(AUTO_RECORD_CUSTOM_TYPE, {
    schemaVersion: ADAPTER_SCHEMA_VERSION,
    enabled,
  });
}

export function saveState(
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  state: RetryState,
): void {
  const payload: PersistedState = {
    schemaVersion: ADAPTER_SCHEMA_VERSION,
    attempts: state.attempts.map(copyAttempt),
    policy: copyPolicy(state.policy),
  };
  pi.appendEntry(STATE_CUSTOM_TYPE, payload);
}

export function addAttempt(
  state: RetryState,
  outcome: unknown,
  strategyId?: unknown,
): AddAttemptResult {
  if (!isRetryAttemptOutcome(outcome)) {
    return { changed: false, reason: 'invalid' };
  }

  if (strategyId !== undefined && !isValidStrategyId(strategyId)) {
    return { changed: false, reason: 'invalid' };
  }

  const attempt: RetryAttempt =
    strategyId === undefined
      ? { outcome }
      : { outcome, strategyId };
  return {
    changed: true,
    state: {
      attempts: [...state.attempts, attempt],
      policy: copyPolicy(state.policy),
    },
  };
}

export function setPolicy(
  state: RetryState,
  policy: RetryPolicy,
): SetPolicyResult {
  if (
    state.policy.maxAttempts === policy.maxAttempts &&
    state.policy.maxStrategyAttempts === policy.maxStrategyAttempts
  ) {
    return { changed: false };
  }

  return {
    changed: true,
    state: {
      attempts: [...state.attempts],
      policy: copyPolicy(policy),
    },
  };
}

export function startEpisode(state: RetryState): StartEpisodeResult {
  if (state.attempts.length === 0) {
    return { changed: false };
  }

  return {
    changed: true,
    state: {
      attempts: [],
      policy: copyPolicy(state.policy),
    },
  };
}

export function clearState(): RetryState {
  return createEmptyState();
}

export function isFreshState(state: RetryState): boolean {
  return (
    state.attempts.length === 0 &&
    state.policy.maxAttempts === undefined &&
    state.policy.maxStrategyAttempts === undefined
  );
}

export function judgeState(state: RetryState): RetryVerdict {
  return judgeRetry({
    attempts: state.attempts.map(copyAttempt),
    policy: copyPolicy(state.policy),
  });
}
