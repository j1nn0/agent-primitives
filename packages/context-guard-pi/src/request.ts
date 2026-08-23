import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export const REQUEST_TIMEOUT_MS = 20_000;

type ActiveModel = NonNullable<ExtensionContext['model']>;
type AuxiliaryModel = Pick<ActiveModel, 'reasoning' | 'thinkingLevelMap'>;
type AuxiliaryReasoningLevel = Exclude<
  keyof NonNullable<ActiveModel['thinkingLevelMap']>,
  'off'
>;

const AUXILIARY_REASONING_LEVELS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly AuxiliaryReasoningLevel[];

export function getAuxiliaryReasoningEffort(
  model: AuxiliaryModel,
): AuxiliaryReasoningLevel | undefined {
  if (model.reasoning !== true) {
    return undefined;
  }

  const thinkingLevelMap = model.thinkingLevelMap;
  if (typeof thinkingLevelMap?.off !== 'string') {
    return undefined;
  }

  // Auxiliary extraction and discovery are small classification requests, so
  // the cheapest declared level is the right ask. Only a concrete mapping is
  // safe because pi-ai forwards the raw level when the mapping is null.
  for (const level of AUXILIARY_REASONING_LEVELS) {
    const mapping = thinkingLevelMap[level];
    if (typeof mapping === 'string' && mapping.length > 0) {
      return level;
    }
  }
  return undefined;
}

export type SessionIdRead =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false };

export interface RequestTracker {
  track(controller: AbortController): void;
  untrack(controller: AbortController): void;
  abortActive(): void;
}

export interface RequestIdentityDependencies<TState> {
  readonly getEpoch: () => number;
  readonly getState: () => TState;
}

export function createRequestTracker(): RequestTracker {
  const activeControllers = new Set<AbortController>();

  return {
    track(controller: AbortController): void {
      activeControllers.add(controller);
    },
    untrack(controller: AbortController): void {
      activeControllers.delete(controller);
    },
    abortActive(): void {
      for (const controller of activeControllers) {
        controller.abort('aborted');
      }
      activeControllers.clear();
    },
  };
}

export function readSessionId(ctx: ExtensionContext): SessionIdRead {
  try {
    return { ok: true, id: ctx.sessionManager.getSessionId() };
  } catch {
    return { ok: false };
  }
}

export function signalFailureKind(
  signal: AbortSignal,
): 'timeout' | 'aborted' | undefined {
  if (!signal.aborted) {
    return undefined;
  }
  if (signal.reason === 'timeout') {
    return 'timeout';
  }
  if (signal.reason === 'aborted') {
    return 'aborted';
  }
  return undefined;
}

export function currentRequestState<TState>(
  dependencies: RequestIdentityDependencies<TState>,
  ctx: ExtensionContext,
  epochAtStart: number,
  stateAtStart: TState,
  sessionIdAtStart: SessionIdRead,
): TState | undefined {
  const currentEpoch = dependencies.getEpoch();
  let state: TState | undefined;
  try {
    state = dependencies.getState();
  } catch {
    state = undefined;
  }
  const currentSessionId = readSessionId(ctx);
  if (
    currentEpoch === epochAtStart &&
    state === stateAtStart &&
    currentSessionId.ok &&
    sessionIdAtStart.ok &&
    currentSessionId.id === sessionIdAtStart.id
  ) {
    return state;
  }
  return undefined;
}
