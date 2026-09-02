import type { SupervisorFeatureModule } from '../module.js';
import { createRetryLoopBreaker } from './retry-loop-breaker.js';

/** Creates the open-ended production built-in feature set. */
export function createSupervisorBuiltInFeatures(): readonly SupervisorFeatureModule[] {
  return Object.freeze([createRetryLoopBreaker()]);
}
