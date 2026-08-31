import { SupervisorContractError } from './errors.js';
import {
  parseSupervisorConfig,
  type SupervisorConfigDiagnostic,
  type SupervisorConfigFeatureDiagnostic,
} from './config.js';
import {
  validateSupervisorFeatureDescriptor,
  type EffectiveFeatureMode,
  type SupervisorFeatureDescriptor,
  type SupervisorFeatureMode,
  type SupervisorFeatureRegistration,
  type SupervisorMode,
} from './feature.js';

export type SupervisorFeatureResolutionReason =
  | 'not-registered'
  | 'invalid-config'
  | 'dependency-unsatisfied'
  | 'conflict'
  | 'global-observe'
  | 'global-off';

export interface ResolvedSupervisorFeature {
  readonly id: string;
  readonly requestedMode: SupervisorFeatureMode | null;
  readonly effectiveMode: EffectiveFeatureMode;
  readonly reason?: SupervisorFeatureResolutionReason;
  readonly descriptor?: SupervisorFeatureDescriptor;
}

export interface SupervisorPlan {
  readonly configStatus: 'valid' | 'degraded';
  readonly configDiagnostics: readonly SupervisorConfigDiagnostic[];
  readonly requestedGlobalMode: SupervisorMode | null;
  readonly effectiveGlobalMode: SupervisorMode;
  readonly features: readonly ResolvedSupervisorFeature[];
}

export class SupervisorFeatureRegistry<
  TFeature extends SupervisorFeatureRegistration = SupervisorFeatureRegistration,
> {
  private readonly features = new Map<string, TFeature>();

  register(feature: TFeature): void {
    const descriptor = validateSupervisorFeatureDescriptor(feature.descriptor);
    if (this.features.has(descriptor.id)) {
      throw new SupervisorContractError('duplicate_feature', 'Duplicate supervisor feature.');
    }
    this.features.set(descriptor.id, feature);
  }

  get(id: string): TFeature | undefined {
    return this.features.get(id);
  }

  has(id: string): boolean {
    return this.features.has(id);
  }

  list(): readonly TFeature[] {
    return [...this.features.values()].sort((left, right) =>
      compareStrings(left.descriptor.id, right.descriptor.id),
    );
  }
}

interface FeatureState {
  readonly descriptor: SupervisorFeatureDescriptor;
  readonly requestedMode: SupervisorFeatureMode;
  effectiveMode: EffectiveFeatureMode;
  reason?: SupervisorFeatureResolutionReason;
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function applyGlobalCeiling(
  requestedMode: SupervisorFeatureMode,
  globalMode: SupervisorMode,
): SupervisorFeatureMode {
  if (globalMode === 'off') {
    return 'off';
  }
  if (globalMode === 'observe' && requestedMode === 'autonomous') {
    return 'observe';
  }
  return requestedMode;
}

function degradedPlan(): SupervisorPlan {
  return {
    configStatus: 'degraded',
    configDiagnostics: [{ code: 'invalid-top-level' }],
    requestedGlobalMode: null,
    effectiveGlobalMode: 'observe',
    features: [],
  };
}

function withRegisteredDescriptor(
  state: FeatureState,
): ResolvedSupervisorFeature {
  const base = {
    id: state.descriptor.id,
    requestedMode: state.requestedMode,
    effectiveMode: state.effectiveMode,
    descriptor: state.descriptor,
  };
  if (state.reason !== undefined) {
    return { ...base, reason: state.reason };
  }
  return base;
}

function withUnknownFeature(
  id: string,
  requestedMode: SupervisorFeatureMode | null,
): ResolvedSupervisorFeature {
  return { id, requestedMode, effectiveMode: 'unavailable', reason: 'not-registered' };
}

export function resolveSupervisorPlan(input: {
  readonly features: readonly SupervisorFeatureRegistration[];
  readonly config: unknown;
  readonly kernelCapabilities: readonly string[];
}): SupervisorPlan {
  const validatedFeatures: SupervisorFeatureRegistration[] = [];
  const seenFeatureIds = new Set<string>();
  for (const feature of input.features) {
    const descriptor = validateSupervisorFeatureDescriptor(feature.descriptor);
    if (seenFeatureIds.has(descriptor.id)) {
      throw new SupervisorContractError('duplicate_feature', 'Duplicate supervisor feature.');
    }
    seenFeatureIds.add(descriptor.id);
    validatedFeatures.push({ descriptor });
  }

  try {
    const parsedConfig = parseSupervisorConfig(input.config);
    const registered = [...validatedFeatures].sort((left, right) =>
      compareStrings(left.descriptor.id, right.descriptor.id),
    );

    const featureDiagnostics =
      parsedConfig.status === 'valid' ? parsedConfig.featureDiagnostics : [];
    const invalidFeatureIds = new Set(
      featureDiagnostics.map((diagnostic: SupervisorConfigFeatureDiagnostic) => diagnostic.featureId),
    );

    const configStatus = parsedConfig.status === 'valid' ? 'valid' : 'degraded';
    const requestedGlobalMode = parsedConfig.status === 'valid' ? parsedConfig.config.mode : null;
    const effectiveGlobalMode = parsedConfig.status === 'valid' ? parsedConfig.config.mode : 'observe';
    const configDiagnostics =
      parsedConfig.status === 'valid' ? parsedConfig.featureDiagnostics : parsedConfig.diagnostics;

    const states: FeatureState[] = [];
    for (const feature of registered) {
      const descriptor = feature.descriptor;
      const requestedMode =
        parsedConfig.status === 'valid' && !invalidFeatureIds.has(descriptor.id)
          ? parsedConfig.config.features[descriptor.id]?.mode ?? descriptor.defaultMode
          : descriptor.defaultMode;

      if (parsedConfig.status === 'valid' && invalidFeatureIds.has(descriptor.id)) {
        states.push({
          descriptor,
          requestedMode,
          effectiveMode: 'unavailable',
          reason: 'invalid-config',
        });
        continue;
      }

      const effectiveMode = applyGlobalCeiling(requestedMode, effectiveGlobalMode);
      const state: FeatureState = { descriptor, requestedMode, effectiveMode };
      if (effectiveMode !== requestedMode) {
        state.reason = effectiveGlobalMode === 'off' ? 'global-off' : 'global-observe';
      }
      states.push(state);
    }

    const candidateStates = states.filter(
      (state) => state.effectiveMode === 'autonomous' || state.effectiveMode === 'observe',
    );
    const conflictIds = new Set<string>();
    for (let leftIndex = 0; leftIndex < candidateStates.length; leftIndex += 1) {
      const left = candidateStates[leftIndex];
      if (left === undefined) {
        continue;
      }
      for (let rightIndex = leftIndex + 1; rightIndex < candidateStates.length; rightIndex += 1) {
        const right = candidateStates[rightIndex];
        if (right === undefined) {
          continue;
        }
        if (
          left.descriptor.conflictsWith.includes(right.descriptor.id) ||
          right.descriptor.conflictsWith.includes(left.descriptor.id)
        ) {
          conflictIds.add(left.descriptor.id);
          conflictIds.add(right.descriptor.id);
        }
      }
    }

    for (const state of candidateStates) {
      if (conflictIds.has(state.descriptor.id)) {
        state.effectiveMode = 'unavailable';
        state.reason = 'conflict';
      }
    }

    const dependencyCandidates = candidateStates.filter(
      (state) => state.effectiveMode === 'autonomous' || state.effectiveMode === 'observe',
    );
    const available = new Set(input.kernelCapabilities);
    const satisfied = new Set<string>();
    let madeProgress = true;
    while (madeProgress) {
      madeProgress = false;
      for (const state of dependencyCandidates) {
        if (satisfied.has(state.descriptor.id)) {
          continue;
        }
        if (!state.descriptor.requires.every((capability) => available.has(capability))) {
          continue;
        }
        satisfied.add(state.descriptor.id);
        madeProgress = true;
        for (const capability of state.descriptor.provides) {
          available.add(capability);
        }
      }
    }

    for (const state of dependencyCandidates) {
      if (!satisfied.has(state.descriptor.id)) {
        state.effectiveMode = 'unavailable';
        state.reason = 'dependency-unsatisfied';
      }
    }

    const resolved: ResolvedSupervisorFeature[] = states.map(withRegisteredDescriptor);
    if (parsedConfig.status === 'valid') {
      const registeredIds = new Set(states.map((state) => state.descriptor.id));
      for (const featureId of Object.keys(parsedConfig.config.features).sort(compareStrings)) {
        if (registeredIds.has(featureId)) {
          continue;
        }
        const entry = parsedConfig.config.features[featureId];
        resolved.push(withUnknownFeature(featureId, entry?.mode ?? null));
      }
    }
    resolved.sort((left, right) => compareStrings(left.id, right.id));

    return {
      configStatus,
      configDiagnostics,
      requestedGlobalMode,
      effectiveGlobalMode,
      features: resolved,
    };
  } catch (error) {
    if (error instanceof SupervisorContractError) {
      throw error;
    }
    return degradedPlan();
  }
}
