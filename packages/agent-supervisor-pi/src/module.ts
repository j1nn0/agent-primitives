import type {
  SupervisorFeatureDescriptor,
  SupervisorFeatureRegistration,
} from './feature.js';
import type {
  SupervisorFactCandidate,
  SupervisorFactSnapshot,
} from './fact.js';
import type { SupervisorInterventionProposal } from './intervention.js';
import type { JsonValue } from './json.js';
import type { SupervisorObservation } from './observation.js';

export interface SupervisorFeatureEmission {
  readonly facts?: readonly SupervisorFactCandidate[];
  readonly interventions?: readonly SupervisorInterventionProposal[];
  /** A nextState is a WHOLE-state replacement; partial or implicit mutation is not supported. */
  readonly nextState?: JsonValue;
}

export interface SupervisorFeatureRuntimeContext<TState extends JsonValue = JsonValue> {
  readonly featureId: string;
  readonly effectiveMode: 'autonomous' | 'observe';
  readonly facts: SupervisorFactSnapshot;
  readonly state: TState | null;
}

export interface SupervisorFeatureContext<
  TConfig extends JsonValue = JsonValue,
  TState extends JsonValue = JsonValue,
> {
  readonly featureId: string;
  readonly config: TConfig;
  readonly initialState: TState | null;
  readonly effectiveMode: 'autonomous' | 'observe';
}

export interface SupervisorFeatureRuntime<TState extends JsonValue = JsonValue> {
  readonly onObservation?: (
    observation: SupervisorObservation,
    context: SupervisorFeatureRuntimeContext<TState>,
  ) => void | SupervisorFeatureEmission | Promise<void | SupervisorFeatureEmission>;
  readonly dispose?: () => void | Promise<void>;
}

/**
 * ARCHITECTURAL INVARIANT: neither context type exposes a handle to another feature.
 * There is deliberately no getFeature, callFeature, features, registry, emit, or bus member.
 * Features communicate only through the observation bus, the fact bus, and intervention proposals
 * routed through the kernel.
 */
export interface SupervisorFeatureModule<
  TConfig extends JsonValue = JsonValue,
  TState extends JsonValue = JsonValue,
> extends SupervisorFeatureRegistration {
  readonly descriptor: SupervisorFeatureDescriptor;
  readonly validateConfig?: (value: unknown) => TConfig;
  readonly create: (
    context: SupervisorFeatureContext<TConfig, TState>,
  ) => SupervisorFeatureRuntime<TState>;
}
