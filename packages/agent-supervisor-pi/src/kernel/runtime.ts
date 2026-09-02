import {
  SupervisorFeatureRegistry,
  resolveSupervisorPlan,
  type ResolvedSupervisorFeature,
  type SupervisorPlan,
} from '../registry.js';
import { parseSupervisorConfig } from '../config.js';
import {
  createSupervisorFactRecord,
  validateSupervisorFactCandidate,
} from '../fact.js';
import {
  SUPERVISOR_KERNEL_CAPABILITIES_V1,
  type EffectiveFeatureMode,
  type SupervisorFeatureDescriptor,
} from '../feature.js';
import {
  validateSupervisorInterventionProposal,
  type SupervisorInterventionProposal,
} from '../intervention.js';
import {
  assertJsonValue,
  isJsonValue,
  type JsonValue,
} from '../json.js';
import {
  hasOnlyAllowedKeys,
  hasOwn,
  isDenseArray,
  isPlainObject,
} from '../internal.js';
import {
  validateSupervisorFeatureModule,
  type SupervisorFeatureContext,
  type SupervisorFeatureEmission,
  type SupervisorFeatureRuntime,
  type SupervisorFeatureRuntimeContext,
  type SupervisorFeatureStateCodec,
} from '../module.js';
import type {
  SupervisorObservation,
  SupervisorObservationKind,
} from '../observation.js';
import type {
  SupervisorFeatureStateEnvelope,
  SupervisorFeatureStateRecordV1,
} from '../state.js';

/** The failure state of one feature runtime. */
export type SupervisorRuntimeStatus = 'active' | 'off' | 'unavailable' | 'quarantined';

/**
 * A bounded, erased module shape used only at the Pi adapter boundary. The public extension type
 * uses the same never-argument existential bound, so heterogeneous feature generics do not expose
 * `any`.
 */
export interface SupervisorKernelFeatureModule {
  readonly descriptor: SupervisorFeatureDescriptor;
  readonly validateConfig?: (value: unknown) => unknown;
  readonly state?: {
    readonly schemaVersion: number;
    readonly validate: (value: unknown) => unknown;
  };
  readonly create: (...args: never[]) => unknown;
}

interface CallableFeatureModule {
  readonly descriptor: SupervisorFeatureDescriptor;
  readonly validateConfig?: (value: unknown) => unknown;
  readonly state?: SupervisorFeatureStateCodec<JsonValue>;
  readonly create: (
    context: SupervisorFeatureContext<JsonValue, JsonValue>,
  ) => SupervisorFeatureRuntime<JsonValue>;
}

interface RuntimeRecord {
  readonly id: string;
  readonly module: CallableFeatureModule;
  readonly planFeature: ResolvedSupervisorFeature;
  readonly descriptor: SupervisorFeatureDescriptor;
  config: JsonValue | null;
  state: JsonValue | null;
  runtime: SupervisorFeatureRuntime<JsonValue> | undefined;
  guardedRuntime: SupervisorFeatureRuntime | undefined;
  status: SupervisorRuntimeStatus;
  reason: string | undefined;
}

export interface SupervisorRuntimeFeatureStatus {
  readonly id: string;
  readonly descriptor: SupervisorFeatureDescriptor;
  readonly requestedMode: ResolvedSupervisorFeature['requestedMode'];
  readonly effectiveMode: EffectiveFeatureMode;
  readonly runtimeMode: EffectiveFeatureMode;
  readonly status: SupervisorRuntimeStatus;
  readonly reason?: string;
}

const ALLOWED_EMISSION_KEYS = new Set(['facts', 'interventions', 'nextState']);

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function isRuntimeObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asCallableFeatureModule(module: SupervisorKernelFeatureModule): CallableFeatureModule {
  return module as unknown as CallableFeatureModule;
}

function featureSettings(config: unknown, featureId: string): unknown {
  const parsed = parseSupervisorConfig(config);
  if (parsed.status !== 'valid') {
    return undefined;
  }
  return parsed.config.features[featureId]?.settings;
}

function reasonForPlanFeature(feature: ResolvedSupervisorFeature): string | undefined {
  if (feature.reason !== undefined) {
    return feature.reason;
  }
  return feature.effectiveMode === 'unavailable' ? 'unavailable' : undefined;
}

/**
 * Owns feature plan resolution, semantic configuration, state restore, runtime creation, and
 * guarded dispatch views. It has no Pi or ExtensionContext handle.
 */
export class SupervisorFeatureRuntimeManager {
  private readonly registry = new SupervisorFeatureRegistry<SupervisorKernelFeatureModule>();

  private readonly modulesById = new Map<string, CallableFeatureModule>();

  private readonly initializationFailures = new Set<string>();

  private readonly quarantined = new Map<string, string>();

  private restoredStates = new Map<string, SupervisorFeatureStateEnvelope>();
  private invalidRestoredStateFeatureIds = new Set<string>();

  private records = new Map<string, RuntimeRecord>();

  private plan: SupervisorPlan | undefined;

  public constructor(
    modules: readonly SupervisorKernelFeatureModule[],
    private readonly onHealthDegraded: () => void,
  ) {
    for (const module of modules) {
      const validatedModule = validateSupervisorFeatureModule(module);
      this.registry.register(validatedModule);
      this.modulesById.set(
        validatedModule.descriptor.id,
        asCallableFeatureModule(validatedModule),
      );
    }
  }

  /** Reset session-scoped failure isolation before loading a new session. */
  public resetSession(): void {
    this.initializationFailures.clear();
    this.quarantined.clear();
  }

  public setRestoredStates(states: ReadonlyMap<string, SupervisorFeatureStateEnvelope>): void {
    this.restoredStates = new Map(states);
  }

  public setInvalidRestoredStateFeatureIds(ids: ReadonlySet<string>): void {
    this.invalidRestoredStateFeatureIds = new Set(ids);
  }

  /**
   * Resolves before disposing old runtimes, then recreates only applicable features in ascending
   * feature-id order.
   */
  public async rebuild(config: unknown): Promise<void> {
    const nextPlan = resolveSupervisorPlan({
      features: this.registry.list(),
      config,
      kernelCapabilities: SUPERVISOR_KERNEL_CAPABILITIES_V1,
    });

    await this.disposeCurrentRuntimes();
    this.plan = nextPlan;
    this.records = new Map();

    const sortedFeatures = [...nextPlan.features].sort((left, right) =>
      compareStrings(left.id, right.id),
    );
    for (const planFeature of sortedFeatures) {
      const module = this.modulesById.get(planFeature.id);
      if (module === undefined) {
        continue;
      }

      const record: RuntimeRecord = {
        id: planFeature.id,
        module,
        planFeature,
        descriptor: module.descriptor,
        config: null,
        state: null,
        runtime: undefined,
        guardedRuntime: undefined,
        status: 'unavailable',
        reason: reasonForPlanFeature(planFeature),
      };
      this.records.set(record.id, record);

      if (planFeature.effectiveMode === 'off') {
        record.status = 'off';
        continue;
      }
      if (planFeature.effectiveMode !== 'autonomous' && planFeature.effectiveMode !== 'observe') {
        record.status = 'unavailable';
        continue;
      }
      if (this.invalidRestoredStateFeatureIds.has(record.id)) {
        record.status = 'unavailable';
        record.reason = 'state-invalid';
        continue;
      }
      if (this.quarantined.has(record.id)) {
        record.status = 'quarantined';
        record.reason = this.quarantined.get(record.id);
        continue;
      }
      if (this.initializationFailures.has(record.id)) {
        record.status = 'unavailable';
        record.reason = 'initialization-failed';
        continue;
      }

      if (!this.resolveSemanticConfig(config, record)) {
        continue;
      }
      if (!this.restoreState(record)) {
        continue;
      }
      if (!this.createRuntime(record)) {
        continue;
      }
      record.status = 'active';
    }
    if (nextPlan.configStatus === 'degraded') {
      for (const module of this.modulesById.values()) {
        if (this.records.has(module.descriptor.id)) {
          continue;
        }
        const planFeature: ResolvedSupervisorFeature = {
          id: module.descriptor.id,
          requestedMode: null,
          effectiveMode: 'unavailable',
          reason: 'invalid-config',
          descriptor: module.descriptor,
        };
        this.records.set(module.descriptor.id, {
          id: module.descriptor.id,
          module,
          planFeature,
          descriptor: module.descriptor,
          config: null,
          state: null,
          runtime: undefined,
          guardedRuntime: undefined,
          status: 'unavailable',
          reason: 'invalid-config',
        });
      }
    }
  }

  public getPlan(): SupervisorPlan | undefined {
    return this.plan;
  }

  public getDispatchFeatures(suppressAutonomous: boolean): readonly {
    readonly featureId: string;
    readonly effectiveMode: EffectiveFeatureMode;
    readonly observes: readonly SupervisorObservationKind[];
    readonly runtime: SupervisorFeatureRuntime;
    readonly state: JsonValue | null;
  }[] {
    const features: {
      readonly featureId: string;
      readonly effectiveMode: EffectiveFeatureMode;
      readonly observes: readonly SupervisorObservationKind[];
      readonly runtime: SupervisorFeatureRuntime;
      readonly state: JsonValue | null;
    }[] = [];

    for (const record of this.records.values()) {
      if (record.status !== 'active' || record.guardedRuntime === undefined) {
        continue;
      }
      const mode =
        suppressAutonomous && record.planFeature.effectiveMode === 'autonomous'
          ? 'observe'
          : record.planFeature.effectiveMode;
      features.push({
        featureId: record.id,
        effectiveMode: mode,
        observes: record.descriptor.observes,
        runtime: record.guardedRuntime,
        state: record.state,
      });
    }
    return Object.freeze(features);
  }

  public getFeatureModes(): Readonly<Record<string, EffectiveFeatureMode>> {
    const modes: Record<string, EffectiveFeatureMode> = {};
    for (const record of this.records.values()) {
      modes[record.id] =
        record.status === 'active'
          ? record.planFeature.effectiveMode
          : record.status === 'off'
            ? 'off'
            : 'unavailable';
    }
    return Object.freeze(modes);
  }

  public getRegisteredDescriptor(featureId: string): SupervisorFeatureDescriptor | undefined {
    return this.modulesById.get(featureId)?.descriptor;
  }

  public getRegisteredCount(): number {
    return this.modulesById.size;
  }

  public getFeatureStateCodec(featureId: string): SupervisorFeatureStateCodec<JsonValue> | undefined {
    const record = this.records.get(featureId);
    return record?.module.state;
  }

  public applyNextStates(nextStates: Readonly<Record<string, JsonValue>>): void {
    for (const [featureId, state] of Object.entries(nextStates)) {
      const record = this.records.get(featureId);
      if (record === undefined || record.status !== 'active') {
        continue;
      }
      record.state = state;
    }
  }

  public getStatuses(): readonly SupervisorRuntimeFeatureStatus[] {
    const statuses: SupervisorRuntimeFeatureStatus[] = [];
    for (const record of this.records.values()) {
      const runtimeMode =
        record.status === 'quarantined' || record.status === 'unavailable'
          ? 'unavailable'
          : record.planFeature.effectiveMode;
      const status: SupervisorRuntimeFeatureStatus = {
        id: record.id,
        descriptor: record.descriptor,
        requestedMode: record.planFeature.requestedMode,
        effectiveMode: record.planFeature.effectiveMode,
        runtimeMode,
        status: record.status,
        ...(record.reason === undefined ? {} : { reason: record.reason }),
      };
      statuses.push(status);
    }
    return Object.freeze(statuses);
  }

  public async dispose(): Promise<void> {
    await this.disposeCurrentRuntimes();
    this.records = new Map();
  }

  private async disposeCurrentRuntimes(): Promise<void> {
    for (const record of this.records.values()) {
      try {
        await record.runtime?.dispose?.();
      } catch {
        this.onHealthDegraded();
      }
    }
  }

  private resolveSemanticConfig(config: unknown, record: RuntimeRecord): boolean {
    const settings = featureSettings(config, record.id);
    try {
      const effectiveConfig =
        record.module.validateConfig === undefined
          ? settings === undefined
            ? null
            : settings
          : record.module.validateConfig(settings);
      if (!isJsonValue(effectiveConfig)) {
        record.status = 'unavailable';
        record.reason = 'configuration-invalid';
        return false;
      }
      record.config = effectiveConfig;
      return true;
    } catch {
      record.status = 'unavailable';
      record.reason = 'configuration-invalid';
      return false;
    }
  }

  private restoreState(record: RuntimeRecord): boolean {
    const codec = record.module.state;
    const envelope = this.restoredStates.get(record.id);
    if (codec === undefined || envelope === undefined) {
      record.state = null;
      return true;
    }
    if (envelope.featureSchemaVersion !== codec.schemaVersion) {
      record.status = 'unavailable';
      record.reason = 'schema-mismatch';
      return false;
    }
    try {
      const restored = codec.validate(envelope.data);
      if (!isJsonValue(restored)) {
        record.status = 'unavailable';
        record.reason = 'state-invalid';
        return false;
      }
      record.state = restored;
      return true;
    } catch {
      record.status = 'unavailable';
      record.reason = 'state-invalid';
      return false;
    }
  }

  private createRuntime(record: RuntimeRecord): boolean {
    try {
      const context: SupervisorFeatureContext<JsonValue, JsonValue> = {
        featureId: record.id,
        config: record.config ?? null,
        initialState: record.state,
        effectiveMode: record.planFeature.effectiveMode as 'autonomous' | 'observe',
      };
      const runtimeUnknown = record.module.create(context);
      if (!isRuntimeObject(runtimeUnknown)) {
        throw new Error('invalid runtime');
      }
      const onObservation = runtimeUnknown.onObservation;
      if (onObservation !== undefined && typeof onObservation !== 'function') {
        throw new Error('invalid runtime');
      }
      const dispose = runtimeUnknown.dispose;
      if (dispose !== undefined && typeof dispose !== 'function') {
        throw new Error('invalid runtime');
      }
      const runtime = runtimeUnknown as unknown as SupervisorFeatureRuntime<JsonValue>;
      record.runtime = runtime;
      if (onObservation !== undefined) {
        const typedOnObservation = onObservation as NonNullable<
          SupervisorFeatureRuntime<JsonValue>['onObservation']
        >;
        const boundOnObservation = typedOnObservation.bind(runtime);
        const guardedRuntime: SupervisorFeatureRuntime = {
          onObservation: (observation, runtimeContext) =>
            this.guardObservation(record, boundOnObservation, observation, runtimeContext),
        };
        record.guardedRuntime = guardedRuntime;
      } else {
        record.guardedRuntime = Object.freeze({});
      }
      return true;
    } catch {
      this.initializationFailures.add(record.id);
      record.status = 'unavailable';
      record.reason = 'initialization-failed';
      record.runtime = undefined;
      record.guardedRuntime = undefined;
      return false;
    }
  }

  private async guardObservation(
    record: RuntimeRecord,
    onObservation: NonNullable<SupervisorFeatureRuntime<JsonValue>['onObservation']>,
    observation: SupervisorObservation,
    runtimeContext: SupervisorFeatureRuntimeContext,
  ): Promise<SupervisorFeatureEmission | undefined> {
    try {
      const emission = await onObservation(
        observation,
        runtimeContext as SupervisorFeatureRuntimeContext<JsonValue>,
      );
      return emission === undefined ? undefined : this.validateAndCopyEmission(record, emission);
    } catch {
      this.quarantineFeature(record, 'observation-failed');
      return undefined;
    }
  }

  private validateAndCopyEmission(
    record: RuntimeRecord,
    value: SupervisorFeatureEmission | undefined,
  ): SupervisorFeatureEmission | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (!isPlainObject(value) || !hasOnlyAllowedKeys(value, ALLOWED_EMISSION_KEYS)) {
      throw new Error('invalid emission');
    }

    const emission: {
      facts?: readonly ReturnType<typeof validateSupervisorFactCandidate>[];
      interventions?: readonly SupervisorInterventionProposal[];
      nextState?: JsonValue;
    } = {};

    if (hasOwn(value, 'facts')) {
      if (!isDenseArray(value.facts)) {
        throw new Error('invalid facts');
      }
      const facts = [] as ReturnType<typeof validateSupervisorFactCandidate>[];
      for (const candidateValue of value.facts) {
        const candidate = validateSupervisorFactCandidate(candidateValue);
        createSupervisorFactRecord({
          candidate,
          sourceFeatureId: record.id,
          rootRequestId: null,
          sequence: 0,
        });
        facts.push(candidate);
      }
      emission.facts = Object.freeze(facts);
    }

    if (hasOwn(value, 'interventions')) {
      if (!isDenseArray(value.interventions)) {
        throw new Error('invalid interventions');
      }
      const interventions: SupervisorInterventionProposal[] = [];
      for (const proposalValue of value.interventions) {
        const proposal = validateSupervisorInterventionProposal(proposalValue);
        if (proposal.sourceFeatureId !== record.id) {
          throw new Error('invalid intervention source');
        }
        if (!record.descriptor.interventionIntents.includes(proposal.intent)) {
          this.quarantineFeature(record, 'intervention-intent-not-declared');
          return undefined;
        }
        interventions.push(proposal);
      }
      emission.interventions = Object.freeze(interventions);
    }

    if (hasOwn(value, 'nextState')) {
      if (record.module.state === undefined) {
        this.quarantineFeature(record, 'state-emission-without-codec');
        return undefined;
      }
      const nextState = assertJsonValue(value.nextState);
      emission.nextState = assertJsonValue(record.module.state.validate(nextState));
    }

    return Object.freeze(emission);
  }

  private quarantineFeature(record: RuntimeRecord, reason: string): void {
    this.quarantined.set(record.id, reason);
    record.status = 'quarantined';
    record.reason = reason;
  }
}

/** A state record ready for append-only persistence after a feature emission. */
export function createSupervisorFeatureStateRecord(
  featureId: string,
  codec: SupervisorFeatureStateCodec<JsonValue>,
  data: JsonValue,
): SupervisorFeatureStateRecordV1 {
  const envelope: SupervisorFeatureStateEnvelope = {
    schemaVersion: 1,
    featureId,
    featureSchemaVersion: codec.schemaVersion,
    data,
  };
  return {
    schemaVersion: 1,
    kind: 'feature',
    state: envelope,
  };
}

