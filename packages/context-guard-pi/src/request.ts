import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
export const REQUEST_TIMEOUT_MS = 20_000;

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
