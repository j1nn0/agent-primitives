import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { SupervisorKernelFeatureModule } from './kernel/runtime.js';
import { SupervisorKernel } from './kernel/kernel.js';

/**
 * A bounded existential wrapper for feature modules. The kernel validates and erases each module's
 * private config and state types at the adapter boundary, without exposing `any`.
 */
export type AgentSupervisorFeatureModule = SupervisorKernelFeatureModule;

export interface AgentSupervisorExtensionOptions {
  readonly features?: readonly AgentSupervisorFeatureModule[];
}

/** Creates a Pi extension factory with the supplied feature modules. */
export function createAgentSupervisorExtension(
  options: AgentSupervisorExtensionOptions = {},
): (pi: ExtensionAPI) => void {
  const features = options.features === undefined ? [] : [...options.features];
  return (pi: ExtensionAPI): void => {
    const kernel = new SupervisorKernel(pi, features);
    kernel.register();
  };
}

/** Registers the production profile, which intentionally has no built-in features. */
export function registerAgentSupervisorExtension(pi: ExtensionAPI): void {
  createAgentSupervisorExtension({ features: [] })(pi);
}

export default registerAgentSupervisorExtension;
