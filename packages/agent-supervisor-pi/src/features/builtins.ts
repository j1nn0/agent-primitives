import type { SupervisorKernelFeatureModule } from '../kernel/runtime.js';
import { createAutoProgress } from './auto-progress.js';
import { createAutoState } from './auto-state.js';
import { createCompletionGate } from './completion-gate.js';
import { createRetryLoopBreaker } from './retry-loop-breaker.js';

/** Creates the open-ended production built-in feature set. */
export function createSupervisorBuiltInFeatures(): readonly SupervisorKernelFeatureModule[] {
  return Object.freeze([
    createRetryLoopBreaker(),
    createCompletionGate(),
    createAutoState(),
    createAutoProgress(),
  ]);
}
