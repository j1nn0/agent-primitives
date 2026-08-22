import { createContextGuard } from '@j1nn0/agent-context-guard';
import type { ContextItemInput } from '@j1nn0/agent-context-guard';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type {
  PersistedState,
  PersistedStateV1,
  PersistedStateV2,
  RecoveryMode,
  RuntimeState,
} from './types.js';

export const STATE_CUSTOM_TYPE = 'agent-context-guard-state';

const INVALID_STATE_WARNING =
  'Context Guard: persisted state was invalid and has been discarded.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecoveryMode(value: unknown): value is RecoveryMode {
  return value === 'off' || value === 'critical';
}

function isExtractionMode(value: unknown): value is RuntimeState['extraction'] {
  return value === 'off' || value === 'automatic';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isPersistedStateV1Shape(value: unknown): value is PersistedStateV1 {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    isRecoveryMode(value.recovery) &&
    Array.isArray(value.items)
  );
}

function isPersistedStateV2Shape(value: unknown): value is PersistedStateV2 {
  return (
    isRecord(value) &&
    value.schemaVersion === 2 &&
    isRecoveryMode(value.recovery) &&
    isExtractionMode(value.extraction) &&
    Array.isArray(value.items) &&
    isStringArray(value.autoItemIds)
  );
}

export function createEmptyState(): RuntimeState {
  return {
    guard: createContextGuard(),
    recovery: 'off',
    extraction: 'off',
    autoItemIds: new Set<string>(),
    degraded: false,
    lastExtraction: undefined,
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
    const data = latestStateEntry.data;
    if (isPersistedStateV2Shape(data)) {
      const guard = createContextGuard(
        data.items as readonly ContextItemInput[],
      );
      return {
        guard,
        recovery: data.recovery,
        extraction: data.extraction,
        autoItemIds: new Set<string>(
          data.autoItemIds.filter((id) => guard.has(id)),
        ),
        degraded: false,
        lastExtraction: undefined,
      };
    }

    if (isPersistedStateV1Shape(data)) {
      const guard = createContextGuard(
        data.items as readonly ContextItemInput[],
      );
      return {
        guard,
        recovery: data.recovery,
        extraction: 'off',
        autoItemIds: new Set<string>(),
        degraded: false,
        lastExtraction: undefined,
      };
    }

    throw new Error('Invalid persisted state shape.');
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
    schemaVersion: 2,
    recovery: state.recovery,
    extraction: state.extraction,
    items: state.guard.list(),
    autoItemIds: Array.from(state.autoItemIds).filter((id) => state.guard.has(id)),
  };
  pi.appendEntry(STATE_CUSTOM_TYPE, payload);
  state.degraded = false;
}
