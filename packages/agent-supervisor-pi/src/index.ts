// These exports are private package-internal API; no SemVer promise is made.

export { SupervisorContractError } from './errors.js';
export type { SupervisorContractErrorCode } from './errors.js';

export { assertJsonValue, isJsonValue } from './json.js';
export type { JsonPrimitive, JsonValue } from './json.js';

export { computeSupervisorJsonDigest } from './digest.js';

export {
  SUPERVISOR_ID_SEGMENT_PATTERN,
  SUPERVISOR_KERNEL_SOURCE_ID,
  assertSupervisorCapabilityId,
  assertSupervisorFactKind,
  assertRegistrableSupervisorFeatureId,
  assertSupervisorFeatureId,
  assertSupervisorNamespacedId,
  assertSupervisorReasonCode,
  isSupervisorCapabilityId,
  isSupervisorFactKind,
  isRegistrableSupervisorFeatureId,
  isSupervisorFeatureId,
  isSupervisorIdSegment,
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
  DEFAULT_SUPERVISOR_RUNTIME_STATE,
  SUPERVISOR_STATE_CUSTOM_TYPE,
  parseSupervisorStateRecord,
  validateSupervisorFeatureStateEnvelope,
} from './state.js';
export type {
  SupervisorFeatureStateEnvelope,
  SupervisorFeatureStateRecordV1,
  SupervisorRuntimeStateRecordV1,
  SupervisorRuntimeStateV1,
  SupervisorStateDiagnostic,
  SupervisorStateDiagnosticCode,
  SupervisorStateRecordParseResult,
  SupervisorStateRecordV1,
} from './state.js';

export {
  SUPERVISOR_INTERVENTION_BOUNDARIES,
  SUPERVISOR_INTERVENTION_COMPATIBILITY_MATRIX,
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

export {
  SUPERVISOR_KERNEL_CAPABILITIES_V1,
  SUPERVISOR_KERNEL_CAPABILITY_NAMESPACE,
  isSupervisorKernelCapabilityId,
  validateSupervisorFeatureDescriptor,
} from './feature.js';
export type {
  EffectiveFeatureMode,
  FeatureMaturity,
  SupervisorFeatureDescriptor,
  SupervisorFeatureMode,
  SupervisorFeatureRegistration,
  SupervisorMode,
} from './feature.js';

export {
  validateSupervisorFeatureModule,
  validateSupervisorFeatureStateCodec,
} from './module.js';
export type {
  SupervisorFeatureContext,
  SupervisorFeatureEmission,
  SupervisorFeatureModule,
  SupervisorFeatureRuntime,
  SupervisorFeatureRuntimeContext,
  SupervisorFeatureStateCodec,
} from './module.js';

export {
  DEFAULT_SUPERVISOR_CONFIG,
  SUPERVISOR_CONFIG_CUSTOM_TYPE,
  parseSupervisorConfig,
} from './config.js';
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

export {
  canonicalizeSupervisorBenchmarkPlan,
  computeSupervisorBenchmarkPlanFingerprint,
} from './benchmark/plan.js';
export { validateSupervisorBenchmarkDataset, validateSupervisorBenchmarkPlan } from './benchmark/validate.js';
export { indexSupervisorBenchmarkPairs } from './benchmark/pairing.js';
export type {
  SupervisorBenchmarkCompletedRun,
  SupervisorBenchmarkDatasetV1,
  SupervisorBenchmarkExpectedPair,
  SupervisorBenchmarkInfrastructureErrorRun,
  SupervisorBenchmarkOracle,
  SupervisorBenchmarkPlanV1,
  SupervisorBenchmarkRun,
  SupervisorBenchmarkRunMetrics,
  SupervisorBenchmarkVariant,
} from './benchmark/types.js';
export type {
  SupervisorBenchmarkPairIndex,
  SupervisorBenchmarkPairIndexEntry,
} from './benchmark/pairing.js';

export {
  compareRationals,
  computeExactPairedSignTest,
  computePairwiseOverhead,
  computeReductionRatio,
  medianRational,
  rationalMeetsThreshold,
  rationalToNumber,
  reductionMeetsThreshold,
} from './benchmark/statistics.js';
export type {
  SupervisorBenchmarkExactPairedSignTest,
  SupervisorBenchmarkRational,
  SupervisorBenchmarkReductionRatio,
} from './benchmark/statistics.js';
export { aggregateSupervisorBenchmarkDataset } from './benchmark/aggregate.js';
export type {
  SupervisorBenchmarkAggregate,
  SupervisorBenchmarkScenarioAggregate,
} from './benchmark/aggregate.js';

export {
  SUPERVISOR_RELEASE_BENCHMARK_POLICY_V1,
} from './benchmark/policy.js';
export type {
  SupervisorBenchmarkRatioThreshold,
  SupervisorReleaseBenchmarkCoveragePolicy,
  SupervisorReleaseBenchmarkOverheadPolicy,
  SupervisorReleaseBenchmarkPolicyV1,
  SupervisorReleaseBenchmarkReductionPolicy,
} from './benchmark/policy.js';
export {
  evaluateSupervisorBenchmark,
  evaluateSupervisorBenchmarkDataset,
} from './benchmark/evaluate.js';
export type {
  SupervisorBenchmarkCoverageReport,
  SupervisorBenchmarkGateResult,
  SupervisorBenchmarkGateStatus,
  SupervisorBenchmarkOutcomesReport,
  SupervisorBenchmarkOverheadReport,
  SupervisorBenchmarkReportV1,
  SupervisorBenchmarkScenarioCoverageReport,
  SupervisorBenchmarkSignTestReport,
  SupervisorBenchmarkVerdict,
} from './benchmark/evaluate.js';
