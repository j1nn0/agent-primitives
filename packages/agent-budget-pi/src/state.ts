import { judgeBudget } from '@j1nn0/agent-budget';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { INVALID_STATE_WARNING } from './messages.js';

export const STATE_CUSTOM_TYPE = 'agent-budget-state' as const;
export const ADAPTER_SCHEMA_VERSION = 1 as const;

export interface PersistedRecord {
  readonly id: string;
  readonly consumed: number;
  readonly limit: number;
}

export interface BudgetState {
  readonly schemaVersion: 1;
  readonly budgets: readonly PersistedRecord[];
}

export interface PersistedState {
  readonly schemaVersion: 1;
  readonly budgets: readonly PersistedRecord[];
}

export interface StateController {
  readonly getState: () => BudgetState;
  readonly replaceState: (state: BudgetState) => void;
  readonly persist: () => void;
}

export type UpsertBudgetResult =
  | {
      readonly changed: true;
      readonly reason: 'created' | 'replaced';
      readonly state: BudgetState;
    }
  | { readonly changed: false; readonly reason: 'invalid' }
  | { readonly changed: false; readonly reason: 'unchanged'; readonly index: number };

export type RemoveBudgetResult =
  | { readonly changed: true; readonly state: BudgetState }
  | { readonly changed: false; readonly reason: 'unknown' };

export type ClearAllResult =
  | { readonly changed: true; readonly state: BudgetState }
  | { readonly changed: false; readonly reason: 'nothing_to_clear' };

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
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

export function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

export function isValidIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^\S+$/.test(value);
}

function copyRecord(record: PersistedRecord): PersistedRecord {
  return {
    id: record.id,
    consumed: record.consumed,
    limit: record.limit,
  };
}

export function parsePersistedState(value: unknown): BudgetState | undefined {
  try {
    if (
      !isPlainRecord(value) ||
      !hasOnlyKeys(value, ['schemaVersion', 'budgets']) ||
      !hasOwn(value, 'schemaVersion') ||
      value.schemaVersion !== ADAPTER_SCHEMA_VERSION ||
      !hasOwn(value, 'budgets') ||
      !Array.isArray(value.budgets)
    ) {
      return undefined;
    }

    const budgets: PersistedRecord[] = [];
    const seenIds = new Set<string>();

    for (const raw of value.budgets) {
      if (
        !isPlainRecord(raw) ||
        !hasOnlyKeys(raw, ['id', 'consumed', 'limit']) ||
        !hasOwn(raw, 'id') ||
        !hasOwn(raw, 'consumed') ||
        !hasOwn(raw, 'limit')
      ) {
        return undefined;
      }

      const id = raw.id;
      const consumed = raw.consumed as number;
      const limit = raw.limit as number;
      if (!isValidIdentifier(id)) {
        return undefined;
      }

      try {
        judgeBudget({ consumed, limit });
      } catch {
        return undefined;
      }

      if (seenIds.has(id)) {
        return undefined;
      }
      seenIds.add(id);
      budgets.push({ id, consumed, limit });
    }

    return {
      schemaVersion: ADAPTER_SCHEMA_VERSION,
      budgets,
    };
  } catch {
    return undefined;
  }
}

export function createEmptyState(): BudgetState {
  return {
    schemaVersion: ADAPTER_SCHEMA_VERSION,
    budgets: [],
  };
}

export function loadState(ctx: Pick<ExtensionContext, 'sessionManager' | 'ui'>): BudgetState {
  try {
    const latestStateEntry = ctx.sessionManager
      .getBranch()
      .filter((entry) => entry.type === 'custom' && entry.customType === STATE_CUSTOM_TYPE)
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

export function saveState(pi: Pick<ExtensionAPI, 'appendEntry'>, state: BudgetState): void {
  const payload: PersistedState = {
    schemaVersion: ADAPTER_SCHEMA_VERSION,
    budgets: state.budgets.map(copyRecord),
  };
  pi.appendEntry(STATE_CUSTOM_TYPE, payload);
}

export function isFreshState(state: BudgetState): boolean {
  return state.budgets.length === 0;
}

export function upsertBudget(state: BudgetState, candidate: unknown): UpsertBudgetResult {
  if (
    !isPlainRecord(candidate) ||
    !hasOnlyKeys(candidate, ['id', 'consumed', 'limit']) ||
    !hasOwn(candidate, 'id') ||
    !hasOwn(candidate, 'consumed') ||
    !hasOwn(candidate, 'limit')
  ) {
    return { changed: false, reason: 'invalid' };
  }

  const id = candidate.id;
  if (!isValidIdentifier(id)) {
    return { changed: false, reason: 'invalid' };
  }

  const consumed = candidate.consumed as number;
  const limit = candidate.limit as number;
  try {
    judgeBudget({ consumed, limit });
  } catch {
    return { changed: false, reason: 'invalid' };
  }

  const index = state.budgets.findIndex((budget) => budget.id === id);
  if (index >= 0) {
    const existing = state.budgets[index];
    if (existing !== undefined && consumed === existing.consumed && limit === existing.limit) {
      return { changed: false, reason: 'unchanged', index };
    }

    const budgets = state.budgets.map(copyRecord);
    budgets[index] = { id, consumed, limit };
    return {
      changed: true,
      reason: 'replaced',
      state: {
        schemaVersion: ADAPTER_SCHEMA_VERSION,
        budgets,
      },
    };
  }

  return {
    changed: true,
    reason: 'created',
    state: {
      schemaVersion: ADAPTER_SCHEMA_VERSION,
      budgets: [...state.budgets.map(copyRecord), { id, consumed, limit }],
    },
  };
}

export function removeBudget(state: BudgetState, id: string): RemoveBudgetResult {
  const index = state.budgets.findIndex((budget) => budget.id === id);
  if (index < 0) {
    return { changed: false, reason: 'unknown' };
  }

  return {
    changed: true,
    state: {
      schemaVersion: ADAPTER_SCHEMA_VERSION,
      budgets: state.budgets.filter((_, i) => i !== index).map(copyRecord),
    },
  };
}

export function clearAll(state: BudgetState): ClearAllResult {
  if (isFreshState(state)) {
    return { changed: false, reason: 'nothing_to_clear' };
  }

  return {
    changed: true,
    state: createEmptyState(),
  };
}
