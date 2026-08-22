import type {
  ExtensionAPI,
  ToolResultEvent,
  TurnEndEvent,
} from '@earendil-works/pi-coding-agent';
import { registerContextGuardCommand } from './command.js';
import { createDiscoveryController } from './discovery.js';
import { createExtractionController } from './extraction.js';
import { createLifecycle } from './lifecycle.js';
import {
  createEmptyState,
  loadState,
  saveState,
} from './state.js';
import { createRequestTracker } from './request.js';
import type {
  DiscoveryMode,
  RecoveryMode,
  RuntimeState,
} from './types.js';

export type {
  DiscoveryMode,
  ExtractionMode,
  PersistedState,
  RecoveryMode,
} from './types.js';

export default function registerContextGuardExtension(pi: ExtensionAPI): void {
  let state: RuntimeState = createEmptyState();
  let sessionEpoch = 0;
  const requestTracker = createRequestTracker();
  const lifecycle = createLifecycle({
    pi,
    getGuard: (): RuntimeState['guard'] => state.guard,
    getRecoveryMode: (): RecoveryMode => state.recovery,
  });
  const extraction = createExtractionController({
    getEpoch: (): number => sessionEpoch,
    getState: (): RuntimeState => state,
    clearPendingSnapshot: lifecycle.clearPendingSnapshot,
    persist: (): void => {
      saveState(pi, state);
    },
    requestTracker,
  });
  const discovery = createDiscoveryController({
    getEpoch: (): number => sessionEpoch,
    getState: (): RuntimeState => state,
    clearPendingSnapshot: lifecycle.clearPendingSnapshot,
    persist: (): void => {
      saveState(pi, state);
    },
    requestTracker,
  });

  registerContextGuardCommand(pi, {
    getState: (): RuntimeState => state,
    setRecoveryMode: (mode: RecoveryMode): void => {
      state.recovery = mode;
    },
    setExtractionMode: (mode): void => {
      state.extraction = mode;
    },
    setDiscoveryMode: (mode: DiscoveryMode): void => {
      state.discovery = mode;
    },
    clearPendingSnapshot: lifecycle.clearPendingSnapshot,
    persist: (): void => {
      saveState(pi, state);
    },
    getLastVerification: lifecycle.getLastVerification,
    getLastUnverifiableCompactionId:
      lifecycle.getLastUnverifiableCompactionId,
  });

  pi.on('session_start', (_event, ctx): void => {
    sessionEpoch += 1;
    requestTracker.abortActive();
    discovery.resetForSession();
    lifecycle.resetForSession();
    state = loadState(ctx);
  });

  pi.on('session_shutdown', (): void => {
    sessionEpoch += 1;
    requestTracker.abortActive();
    discovery.resetForSession();
    lifecycle.resetForSession();
  });

  // Pi 0.84.2 has no session_compact_failed event. These structural
  // invariants provide the same safety: before_compact always overwrites the
  // snapshot, session_compact consumes it, and every state mutation clears it.
  // A future failure hook only needs one call to clearPendingSnapshot().
  pi.on('session_before_compact', (): void => {
    lifecycle.captureSnapshot();
  });

  pi.on('session_compact', (event, ctx): void => {
    lifecycle.handleCompaction(event, ctx);
  });

  pi.on('turn_start', (): void => {
    discovery.beginTurn();
  });

  pi.on('tool_result', (event): void => {
    discovery.handleToolResult(event as ToolResultEvent);
  });

  pi.on('turn_end', async (event, ctx): Promise<void> => {
    await discovery.handleTurnEnd(event as TurnEndEvent, ctx);
  });

  pi.on('context', async (event, ctx) => lifecycle.handleContext(event, ctx));

  pi.on('input', async (event, ctx): Promise<void> => {
    await extraction.handleInput(event, ctx);
  });
}
