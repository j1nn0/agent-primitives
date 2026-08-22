import { createContextGuard } from '@j1nn0/agent-context-guard';
import type { ContextItemInput } from '@j1nn0/agent-context-guard';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { PersistedState, RecoveryMode, RuntimeState } from './types.js';

export const STATE_CUSTOM_TYPE = 'agent-context-guard-state';

const INVALID_STATE_WARNING =
  'Context Guard: persisted state was invalid and has been discarded.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecoveryMode(value: unknown): value is RecoveryMode {
  return value === 'off' || value === 'critical';
}

function isPersistedStateShape(value: unknown): value is {
  schemaVersion: 1;
  recovery: RecoveryMode;
  items: unknown[];
} {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    isRecoveryMode(value.recovery) &&
    Array.isArray(value.items)
  );
}

export function createEmptyState(): RuntimeState {
  return {
    guard: createContextGuard(),
    recovery: 'off',
    degraded: false,
  };
}

export function loadState(
  ctx: Pick<ExtensionContext, 'sessionManager' | 'ui'>,
): RuntimeState {
  const entries = ctx.sessionManager.getBranch();
  const latestStateEntry = entries
    .filter(
      (entry) =>
        entry.type === 'custom' && entry.customType === STATE_CUSTOM_TYPE,
    )
    .at(-1);

  if (latestStateEntry === undefined || latestStateEntry.type !== 'custom') {
    return createEmptyState();
  }

  try {
    if (!isPersistedStateShape(latestStateEntry.data)) {
      throw new Error('Invalid persisted state shape.');
    }

    const guard = createContextGuard(
      latestStateEntry.data.items as readonly ContextItemInput[],
    );
    return {
      guard,
      recovery: latestStateEntry.data.recovery,
      degraded: false,
    };
  } catch {
    ctx.ui.notify(INVALID_STATE_WARNING, 'warning');
    return {
      ...createEmptyState(),
      degraded: true,
    };
  }
}

export function saveState(
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  state: RuntimeState,
): void {
  const payload: PersistedState = {
    schemaVersion: 1,
    recovery: state.recovery,
    items: state.guard.list(),
  };
  pi.appendEntry(STATE_CUSTOM_TYPE, payload);
  state.degraded = false;
}
