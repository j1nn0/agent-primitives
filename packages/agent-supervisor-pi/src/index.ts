// These exports are private package-internal API; no SemVer promise is made.

export { SupervisorContractError } from './errors.js';
export type { SupervisorContractErrorCode } from './errors.js';

export { assertJsonValue, isJsonValue } from './json.js';
export type { JsonPrimitive, JsonValue } from './json.js';

export {
  SUPERVISOR_ID_SEGMENT_PATTERN,
  assertSupervisorCapabilityId,
  assertSupervisorFactKind,
  assertSupervisorFeatureId,
  assertSupervisorNamespacedId,
  assertSupervisorReasonCode,
  isSupervisorCapabilityId,
  isSupervisorFactKind,
  isSupervisorFeatureId,
  isSupervisorNamespacedId,
  isSupervisorReasonCode,
} from './ids.js';

export {
  SUPERVISOR_OBSERVATION_KINDS,
  isSupervisorObservationKind,
  validateSupervisorObservation,
} from './observation.js';
export type {
  SupervisorBuiltinObservationKind,
  SupervisorObservation,
  SupervisorObservationKind,
} from './observation.js';

export {
  SUPERVISOR_KERNEL_FACT_NAMESPACE,
  createSupervisorFactRecord,
  createSupervisorFactSnapshot,
  validateSupervisorFactCandidate,
} from './fact.js';
export type {
  SupervisorFactCandidate,
  SupervisorFactRecord,
  SupervisorFactSnapshot,
} from './fact.js';

export {
  SUPERVISOR_STATE_CUSTOM_TYPE,
  validateSupervisorFeatureStateEnvelope,
} from './state.js';
export type { SupervisorFeatureStateEnvelope } from './state.js';

export {
  SUPERVISOR_INTERVENTION_BOUNDARIES,
  SUPERVISOR_INTERVENTION_DELIVERIES,
  SUPERVISOR_INTERVENTION_INTENTS,
  validateSupervisorInterventionProposal,
} from './intervention.js';
export type {
  SupervisorInterventionBoundary,
  SupervisorInterventionDelivery,
  SupervisorInterventionIntent,
  SupervisorInterventionProposal,
} from './intervention.js';

export { validateSupervisorFeatureDescriptor } from './feature.js';
export type {
  EffectiveFeatureMode,
  FeatureMaturity,
  SupervisorFeatureDescriptor,
  SupervisorFeatureMode,
  SupervisorFeatureRegistration,
  SupervisorMode,
} from './feature.js';

export type {
  SupervisorFeatureContext,
  SupervisorFeatureEmission,
  SupervisorFeatureModule,
  SupervisorFeatureRuntime,
  SupervisorFeatureRuntimeContext,
} from './module.js';

export { DEFAULT_SUPERVISOR_CONFIG, parseSupervisorConfig } from './config.js';
export type {
  SupervisorConfigDiagnostic,
  SupervisorConfigDiagnosticCode,
  SupervisorConfigFeatureDiagnostic,
  SupervisorConfigParseResult,
  SupervisorConfigV1,
  SupervisorFeatureConfigEntry,
} from './config.js';

export { dispatchObservation } from './dispatch.js';
export type {
  SupervisorDispatchFeature,
  SupervisorDispatchInput,
  SupervisorDispatchResult,
} from './dispatch.js';

export { SupervisorFeatureRegistry, resolveSupervisorPlan } from './registry.js';
export type {
  ResolvedSupervisorFeature,
  SupervisorFeatureResolutionReason,
  SupervisorPlan,
} from './registry.js';

export { SUPERVISOR_INTENT_RANKS, arbitrateInterventions } from './arbitration.js';
export type { SupervisorArbitrationResult } from './arbitration.js';
