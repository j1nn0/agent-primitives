import {
  judgeProgress,
  type ProgressVerdict,
} from '@j1nn0/agent-progress';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

export const STATE_CUSTOM_TYPE = 'agent-progress-state';
export const ADAPTER_SCHEMA_VERSION = 1 as const;

export interface ProgressState {
  readonly hasBaseline: boolean;
  readonly currentMilestones: readonly string[];
  readonly recordedMilestones: readonly string[];
}

export interface PersistedState {
  readonly schemaVersion: 1;
  readonly hasBaseline: boolean;
  readonly currentMilestones: readonly string[];
  readonly recordedMilestones: readonly string[];
}

export interface StateController {
  readonly getState: () => ProgressState;
  readonly replaceState: (state: ProgressState) => void;
  readonly persist: () => void;
}

export interface JudgeStateResult {
  readonly state: ProgressState;
  readonly verdict: ProgressVerdict;
  readonly changed: boolean;
}

const INVALID_STATE_WARNING =
  'Agent Progress: persisted state was invalid; starting with fresh state.';

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

function parsePersistedState(value: unknown): ProgressState | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }

  try {
    if (
      !hasOwn(value, 'schemaVersion') ||
      value.schemaVersion !== ADAPTER_SCHEMA_VERSION ||
      !hasOwn(value, 'hasBaseline') ||
      typeof value.hasBaseline !== 'boolean' ||
      !hasOwn(value, 'currentMilestones') ||
      !Array.isArray(value.currentMilestones) ||
      !hasOwn(value, 'recordedMilestones') ||
      !Array.isArray(value.recordedMilestones)
    ) {
      return undefined;
    }

    const hasBaseline = value.hasBaseline;
    const currentMilestones: readonly unknown[] = value.currentMilestones;
    const recordedMilestones: readonly unknown[] = value.recordedMilestones;
    if (!hasBaseline && recordedMilestones.length !== 0) {
      return undefined;
    }

    // Deliberately reuse the core's documented observation validation rather
    // than duplicating its milestone-entry and duplicate rules here.
    try {
      judgeProgress({
        previous: { milestones: recordedMilestones },
        current: { milestones: currentMilestones },
      });
    } catch {
      return undefined;
    }

    return {
      hasBaseline,
      currentMilestones: [...currentMilestones] as string[],
      recordedMilestones: [...recordedMilestones] as string[],
    };
  } catch {
    return undefined;
  }
}

export function createEmptyState(): ProgressState {
  return {
    hasBaseline: false,
    currentMilestones: [],
    recordedMilestones: [],
  };
}

export function loadState(
  ctx: Pick<ExtensionContext, 'sessionManager' | 'ui'>,
): ProgressState {
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

export function saveState(
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  state: ProgressState,
): void {
  const payload: PersistedState = {
    schemaVersion: ADAPTER_SCHEMA_VERSION,
    hasBaseline: state.hasBaseline,
    currentMilestones: [...state.currentMilestones],
    recordedMilestones: [...state.recordedMilestones],
  };
  pi.appendEntry(STATE_CUSTOM_TYPE, payload);
}

function isValidMilestone(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export type AddMilestoneResult =
  | { readonly changed: true; readonly state: ProgressState }
  | { readonly changed: false; readonly reason: 'invalid' | 'duplicate' };

export function addMilestone(
  state: ProgressState,
  milestone: unknown,
): AddMilestoneResult {
  if (!isValidMilestone(milestone)) {
    return { changed: false, reason: 'invalid' };
  }
  if (state.currentMilestones.includes(milestone)) {
    return { changed: false, reason: 'duplicate' };
  }
  return {
    changed: true,
    state: {
      hasBaseline: state.hasBaseline,
      currentMilestones: [...state.currentMilestones, milestone],
      recordedMilestones: [...state.recordedMilestones],
    },
  };
}

export type WithdrawMilestoneResult =
  | { readonly changed: true; readonly state: ProgressState }
  | { readonly changed: false; readonly reason: 'invalid' | 'unknown' };

export function withdrawMilestone(
  state: ProgressState,
  milestone: unknown,
): WithdrawMilestoneResult {
  if (!isValidMilestone(milestone)) {
    return { changed: false, reason: 'invalid' };
  }
  if (!state.currentMilestones.includes(milestone)) {
    return { changed: false, reason: 'unknown' };
  }
  return {
    changed: true,
    state: {
      hasBaseline: state.hasBaseline,
      currentMilestones: state.currentMilestones.filter(
        (candidate) => candidate !== milestone,
      ),
      recordedMilestones: [...state.recordedMilestones],
    },
  };
}

export function isFreshState(state: ProgressState): boolean {
  return (
    !state.hasBaseline &&
    state.currentMilestones.length === 0 &&
    state.recordedMilestones.length === 0
  );
}

function sameMilestones(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((milestone, index) => milestone === right[index]);
}

export function judgeState(state: ProgressState): JudgeStateResult {
  const currentMilestones = [...state.currentMilestones];
  const input = state.hasBaseline
    ? {
        previous: { milestones: [...state.recordedMilestones] },
        current: { milestones: currentMilestones },
      }
    : { current: { milestones: currentMilestones } };
  const verdict = judgeProgress(input);
  const nextState: ProgressState = {
    hasBaseline: true,
    currentMilestones,
    recordedMilestones: [...verdict.recordedMilestones],
  };

  return {
    state: nextState,
    verdict,
    changed:
      !state.hasBaseline ||
      !sameMilestones(state.recordedMilestones, nextState.recordedMilestones),
  };
}
