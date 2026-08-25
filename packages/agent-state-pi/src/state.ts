import {
  restoreAgentState,
  type AgentState,
  type AgentStateSnapshot,
} from '@j1nn0/agent-state';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

export const STATE_CUSTOM_TYPE = 'agent-state-state';
export const ADAPTER_SCHEMA_VERSION = 1 as const;

export interface PersistedState {
  readonly schemaVersion: 1;
  readonly state: AgentStateSnapshot;
}

const INVALID_STATE_WARNING =
  'Agent State: persisted state was invalid; starting with empty state.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPersistedState(value: unknown): value is PersistedState {
  return (
    isRecord(value) &&
    value.schemaVersion === ADAPTER_SCHEMA_VERSION &&
    Object.prototype.hasOwnProperty.call(value, 'state')
  );
}

export interface StateController {
  readonly getState: () => AgentState;
  readonly replaceState: (state: AgentState) => void;
  readonly persist: () => void;
}

export function createEmptyState(): AgentState {
  return restoreAgentState({
    schemaVersion: 1,
    workItems: [],
    decisions: [],
  });
}

export function loadState(
  ctx: Pick<ExtensionContext, 'sessionManager' | 'ui'>,
): AgentState {
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

  try {
    if (!isPersistedState(latestStateEntry.data)) {
      ctx.ui.notify(INVALID_STATE_WARNING, 'warning');
      return createEmptyState();
    }
    return restoreAgentState(latestStateEntry.data.state);
  } catch {
    ctx.ui.notify(INVALID_STATE_WARNING, 'warning');
    return createEmptyState();
  }
}

export function saveState(
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  state: AgentState,
): void {
  const payload: PersistedState = {
    schemaVersion: ADAPTER_SCHEMA_VERSION,
    state: state.snapshot(),
  };
  pi.appendEntry(STATE_CUSTOM_TYPE, payload);
}
