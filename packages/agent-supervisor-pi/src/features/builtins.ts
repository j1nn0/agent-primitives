import type { SupervisorFeatureModule } from '../module.js';
import { createCompletionGate } from './completion-gate.js';
import { createRetryLoopBreaker } from './retry-loop-breaker.js';

/** Creates the open-ended production built-in feature set. */
export function createSupervisorBuiltInFeatures(): readonly SupervisorFeatureModule[] {
  return Object.freeze([createRetryLoopBreaker(), createCompletionGate()]);
}
