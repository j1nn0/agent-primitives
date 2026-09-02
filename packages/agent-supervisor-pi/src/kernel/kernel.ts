import type {
  AgentSettledEvent,
  ContextEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionEvent,
  InputEvent,
  InputEventResult,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionEntry,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  TurnEndEvent,
} from '@earendil-works/pi-coding-agent';
import { SupervisorAssessmentCapture } from '../assessment/evidence.js';
import type { SupervisorAssessmentInput } from '../assessment/types.js';
import {
  SupervisorAssessmentController,
  type SupervisorAssessmentIdentity,
  type SupervisorAssessmentOutcome,
} from '../assessment/controller.js';

type SessionCompactFailedEvent = Extract<ExtensionEvent, { type: 'session_compact_failed' }>;
import {
  DEFAULT_SUPERVISOR_CONFIG,
  SUPERVISOR_CONFIG_CUSTOM_TYPE,
  parseSupervisorConfig,
  type SupervisorConfigV1,
  type SupervisorFeatureConfigEntry,
} from '../config.js';
import { arbitrateInterventions, type SupervisorArbitrationResult } from '../arbitration.js';
import { dispatchObservation } from '../dispatch.js';
import { isSupervisorAssessmentEnabled } from '../assessment/types.js';
import type { SupervisorFeatureMode } from '../feature.js';
import {
  createSupervisorFactRecord,
  validateSupervisorFactCandidate,
  type SupervisorFactCandidate,
  type SupervisorFactRecord,
} from '../fact.js';
import type { SupervisorInterventionDelivery } from '../intervention.js';
import { hasOwn, isPlainObject } from '../internal.js';
import { isRegistrableSupervisorFeatureId } from '../ids.js';
import type { JsonValue } from '../json.js';
import type { SupervisorObservation } from '../observation.js';
import {
  DEFAULT_SUPERVISOR_RUNTIME_STATE,
  SUPERVISOR_STATE_CUSTOM_TYPE,
  parseSupervisorStateRecord,
  validateSupervisorFeatureStateEnvelope,
  type SupervisorFeatureStateEnvelope,
  type SupervisorRuntimeStateRecordV1,
} from '../state.js';
import {
  createSupervisorFeatureStateRecord,
  SupervisorFeatureRuntimeManager,
  type SupervisorKernelFeatureModule,
} from './runtime.js';
import {
  SupervisorObservationNormalizer,
  type SupervisorPiObservationEvent,
} from './observation.js';

export type SupervisorKernelHealth = 'healthy' | 'degraded';
export type SupervisorRootStatus = 'active' | 'settled';

interface CurrentRoot {
  readonly id: string;
  status: SupervisorRootStatus;
}

const USAGE_MESSAGE =
  'Usage: /agent-supervisor [status|mode autonomous|observe|off|feature <id> autonomous|observe|off|default]';

const SUPERVISOR_COMPLETION_ASSESSMENT_KIND = 'kernel:completion-assessment' as const;

function incrementGeneration(value: number): number {
  return value === Number.MAX_SAFE_INTEGER ? value : value + 1;
}

function isRuntimeShaped(value: unknown): boolean {
  try {
    return isPlainObject(value) && value.kind === 'runtime';
  } catch {
    return false;
  }
}
function recoverFeatureId(value: unknown): string | undefined {
  try {
    if (!isPlainObject(value)) {
      return undefined;
    }
    const state = hasOwn(value, 'state') ? value.state : undefined;
    if (isPlainObject(state) && hasOwn(state, 'featureId')) {
      const featureId = state.featureId;
      if (isRegistrableSupervisorFeatureId(featureId)) {
        return featureId;
      }
    }
    if (hasOwn(value, 'featureId')) {
      const featureId = value.featureId;
      if (isRegistrableSupervisorFeatureId(featureId)) {
        return featureId;
      }
    }
  } catch {
    // Corrupt persisted values are never allowed to escape the recovery path.
  }
  return undefined;
}

type PersistedStateClassification =
  | { readonly kind: 'runtime-valid'; readonly record: SupervisorRuntimeStateRecordV1 }
  | { readonly kind: 'runtime-invalid' }
  | { readonly kind: 'feature-valid'; readonly state: SupervisorFeatureStateEnvelope }
  | { readonly kind: 'feature-invalid'; readonly featureId: string }
  | { readonly kind: 'unclassifiable' };

function classifyPersistedState(value: unknown): PersistedStateClassification {
  const parsed = parseSupervisorStateRecord(value);
  if (parsed.status === 'valid') {
    return parsed.record.kind === 'runtime'
      ? { kind: 'runtime-valid', record: parsed.record }
      : { kind: 'feature-valid', state: parsed.record.state };
  }
  if (isRuntimeShaped(value)) {
    return { kind: 'runtime-invalid' };
  }
  const featureId = recoverFeatureId(value);
  return featureId === undefined ? { kind: 'unclassifiable' } : { kind: 'feature-invalid', featureId };
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

function copyFeatureConfigEntry(entry: SupervisorFeatureConfigEntry): SupervisorFeatureConfigEntry {
  const mode = entry.mode;
  const settings = entry.settings;
  if (mode !== undefined && settings !== undefined) {
    return { mode, settings };
  }
  if (mode !== undefined) {
    return { mode };
  }
  if (settings !== undefined) {
    return { settings };
  }
  return {};
}

function copyConfig(config: SupervisorConfigV1, mode = config.mode): SupervisorConfigV1 {
  const features: Record<string, SupervisorFeatureConfigEntry> = {};
  for (const featureId of Object.keys(config.features).sort(compareStrings)) {
    const entry = config.features[featureId];
    if (entry !== undefined) {
      features[featureId] = copyFeatureConfigEntry(entry);
    }
  }
  return { schemaVersion: 1, mode, features };
}
export interface SupervisorKernelOptions {
  readonly assessmentTimeoutMs?: number;
}

/**
 * The Pi adapter kernel. It is the only owner of lifecycle normalization, ephemeral facts,
 * persistence, feature runtime isolation, arbitration, and external intervention transport.
 */
export class SupervisorKernel {
  private readonly normalizer = new SupervisorObservationNormalizer();
  private readonly assessmentCapture = new SupervisorAssessmentCapture();
  private readonly assessmentController: SupervisorAssessmentController;

  private readonly runtimeManager: SupervisorFeatureRuntimeManager;

  private readonly pi: ExtensionAPI;

  private currentRoot: CurrentRoot | null = null;

  private facts: SupervisorFactRecord[] = [];

  private nextFactSequence = 0;

  private nextRootRequestSequence = DEFAULT_SUPERVISOR_RUNTIME_STATE.nextRootRequestSequence;
  private sessionGeneration = 0;

  private rootGeneration = 0;

  private runGeneration = 0;
  private finalAssistantRunGeneration = 0;
  private assessmentLifecycleGeneration = 0;

  private health: SupervisorKernelHealth = 'healthy';

  private loaded = false;

  private configEntryPresent = false;

  private configValue: unknown = DEFAULT_SUPERVISOR_CONFIG;

  private parsedConfig: SupervisorConfigV1 | null = DEFAULT_SUPERVISOR_CONFIG;

  private restoredFeatureStates = new Map<string, SupervisorFeatureStateEnvelope>();
  private invalidRestoredStateFeatureIds = new Set<string>();

  private runtimeStateRecovery: 'none' | 'recovered' | 'failed' = 'none';

  private runtimeStateRecoveryNext: number | undefined;

  private operationQueue: Promise<void> = Promise.resolve();

  public constructor(
    pi: ExtensionAPI,
    features: readonly SupervisorKernelFeatureModule[],
    options: SupervisorKernelOptions = {},
  ) {
    this.pi = pi;
    this.assessmentController = new SupervisorAssessmentController(
      options.assessmentTimeoutMs === undefined ? {} : { timeoutMs: options.assessmentTimeoutMs },
    );
    this.runtimeManager = new SupervisorFeatureRuntimeManager(features, () => {
      this.markDegraded();
    });
  }

  /** Register the one operator command and all eleven lifecycle handlers. */
  public register(): void {
    this.pi.registerCommand('agent-supervisor', {
      description: 'Inspect and configure the Agent Supervisor.',
      handler: (args, ctx) => this.enqueue(() => this.handleCommand(args, ctx)),
    });

    this.pi.on('input', (event, ctx) => {
      this.invalidatePendingAssessment();
      return this.enqueue(() => this.handleInput(event, ctx));
    });
    this.pi.on('tool_call', (event, ctx) => this.enqueue(() => this.handleToolCall(event, ctx)));
    this.pi.on('tool_result', (event, ctx) => this.enqueue(() => this.handleToolResult(event, ctx)));
    this.pi.on('turn_end', (event, ctx) => this.enqueue(() => this.handleTurnEnd(event, ctx)));
    this.pi.on('agent_settled', (event, ctx) => this.enqueueAgentSettled(event, ctx));
    this.pi.on('session_start', (event, ctx) => {
      this.invalidatePendingAssessment();
      return this.enqueue(() => this.handleSessionStart(event, ctx));
    });
    this.pi.on('session_shutdown', (event, ctx) => {
      this.invalidatePendingAssessment();
      return this.enqueue(() => this.handleSessionShutdown(event, ctx));
    });
    this.pi.on('session_before_compact', (event, ctx) =>
      this.enqueue(() => this.handleSessionBeforeCompact(event, ctx)),
    );
    this.pi.on('session_compact', (event, ctx) =>
      this.enqueue(() => this.handleSessionCompact(event, ctx)),
    );
    this.pi.on('session_compact_failed', (event, ctx) =>
      this.enqueue(() => this.handleSessionCompactFailed(event, ctx)),
    );
    this.pi.on('context', (event, ctx) => this.enqueue(() => this.handleContext(event, ctx)));
  }

  public getHealth(): SupervisorKernelHealth {
    return this.health;
  }

  public getCurrentRoot(): Readonly<CurrentRoot> | null {
    return this.currentRoot;
  }

  public getFacts(): readonly SupervisorFactRecord[] {
    return Object.freeze([...this.facts]);
  }
  public getPlan() {
    return this.runtimeManager.getPlan();
  }

  public getAssessmentInput(): SupervisorAssessmentInput {
    return this.assessmentCapture.getSnapshot();
  }

  public getRuntimeStatuses() {
    return this.runtimeManager.getStatuses();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private markDegraded(): void {
    this.health = 'degraded';
  }

  private invalidatePendingAssessment(): void {
    this.assessmentLifecycleGeneration = incrementGeneration(this.assessmentLifecycleGeneration);
    this.assessmentController.abortActive();
  }

  private clearRootTracking(): void {
    this.invalidatePendingAssessment();
    this.assessmentController.resetForRoot();
    this.rootGeneration = incrementGeneration(this.rootGeneration);
    this.runGeneration = 0;
    this.finalAssistantRunGeneration = 0;
    this.currentRoot = null;
    this.facts = [];
    this.nextFactSequence = 0;
    this.assessmentCapture.clearRootRequest();
  }

  private async handleInput(event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult> {
    return this.safe({ action: 'continue' }, async () => {
      await this.ensureLoaded(ctx);
      if (event.source === 'extension') {
        if (this.currentRoot !== null) {
          this.currentRoot.status = 'active';
          this.runGeneration = incrementGeneration(this.runGeneration);
          this.finalAssistantRunGeneration = 0;
          this.invalidatePendingAssessment();
        }
        return { action: 'continue' };
      }

      this.invalidatePendingAssessment();
      this.assessmentController.resetForRoot();
      this.rootGeneration = incrementGeneration(this.rootGeneration);
      this.runGeneration = 0;
      this.finalAssistantRunGeneration = 0;
      if (!this.beginRootRequest()) {
        return { action: 'continue' };
      }
      this.assessmentCapture.beginRootRequest(event.text);
      const observation = this.normalizer.normalize(event, this.currentRoot?.id ?? null);
      if (observation !== undefined) {
        await this.dispatchAndIntervene(observation, undefined);
      }
      return { action: 'continue' };
    });
  }

  private async handleToolCall(
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): Promise<ToolCallEventResult | undefined> {
    return this.safe(undefined, async () => {
      await this.ensureLoaded(ctx);
      const observation = this.normalizer.normalize(event, this.currentRoot?.id ?? null);
      if (observation === undefined) {
        return undefined;
      }
      return this.dispatchAndIntervene(observation, event.toolCallId);
    });
  }

  private async handleToolResult(event: ToolResultEvent, ctx: ExtensionContext): Promise<void> {
    await this.safe(undefined, async () => {
      await this.ensureLoaded(ctx);
      if (this.currentRoot !== null) {
        this.assessmentCapture.observeToolResult(event);
      }
      await this.dispatchEvent(event, this.currentRoot?.id ?? null);
    });
  }

  private async handleTurnEnd(event: TurnEndEvent, ctx: ExtensionContext): Promise<void> {
    await this.safe(undefined, async () => {
      await this.ensureLoaded(ctx);
      if (this.currentRoot !== null) {
        this.assessmentCapture.observeTurnEnd(event);
        this.finalAssistantRunGeneration =
          this.assessmentCapture.getFinalAssistantText() === undefined ? 0 : this.runGeneration;
      }
      await this.dispatchEvent(event, this.currentRoot?.id ?? null);
    });
  }

  private enqueueAgentSettled(event: AgentSettledEvent, ctx: ExtensionContext): Promise<void> {
    let completion: Promise<void> | undefined;
    const queued = this.enqueue(async () => {
      try {
        await this.ensureLoaded(ctx);
        completion = this.processAgentSettled(event, ctx);
      } catch {
        this.markDegraded();
      }
    });
    return queued.then(async () => {
      await (completion ?? Promise.resolve());
    });
  }

  private processAgentSettled(event: AgentSettledEvent, ctx: ExtensionContext): Promise<void> {
    return this.safe(undefined, async () => {
      // Activation is deliberately checked before any model or request work.
      const assessmentEnabled = isSupervisorAssessmentEnabled(this.runtimeManager.getPlan());
      const root = this.currentRoot;
      const rootRequestId = root?.id ?? null;
      if (root !== null) {
        root.status = 'settled';
      }

      const identity = root === null ? undefined : this.readAssessmentIdentity(ctx);
      if (identity === undefined) {
        await this.dispatchEvent(event, rootRequestId);
        return;
      }

      const assessmentLifecycleGeneration = this.assessmentLifecycleGeneration;

      const capturedInput = this.assessmentCapture.getSnapshot();
      const input: SupervisorAssessmentInput = this.finalAssistantRunGeneration === this.runGeneration
        ? capturedInput
        : {
            ...(capturedInput.taskText === undefined ? {} : { taskText: capturedInput.taskText }),
            evidence: capturedInput.evidence,
          };
      const outcome = await this.assessmentController.assess(
        ctx,
        input,
        identity,
        () => this.isAssessmentIdentityCurrent(ctx, identity, assessmentLifecycleGeneration),
        assessmentEnabled,
      );
      const assessmentIsCurrent = this.isAssessmentIdentityCurrent(
        ctx,
        identity,
        assessmentLifecycleGeneration,
      );
      if (assessmentIsCurrent && outcome.kind === 'success') {
        this.commitAssessmentFact(outcome, identity, input);
      }
      await this.dispatchEvent(event, rootRequestId);
    });
  }

  private readAssessmentIdentity(ctx: ExtensionContext): SupervisorAssessmentIdentity | undefined {
    if (this.currentRoot === null) {
      return undefined;
    }

    let sessionId: string;
    try {
      sessionId = ctx.sessionManager.getSessionId();
    } catch {
      return undefined;
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return undefined;
    }
    return {
      sessionId,
      sessionGeneration: this.sessionGeneration,
      rootRequestId: this.currentRoot.id,
      rootGeneration: this.rootGeneration,
      runGeneration: this.runGeneration,
    };
  }

  private isAssessmentIdentityCurrent(
    ctx: ExtensionContext,
    identity: SupervisorAssessmentIdentity,
    assessmentLifecycleGeneration: number,
  ): boolean {
    if (
      this.assessmentLifecycleGeneration !== assessmentLifecycleGeneration ||
      this.sessionGeneration !== identity.sessionGeneration ||
      this.rootGeneration !== identity.rootGeneration ||
      this.runGeneration !== identity.runGeneration ||
      this.currentRoot?.id !== identity.rootRequestId
    ) {
      return false;
    }

    try {
      return ctx.sessionManager.getSessionId() === identity.sessionId;
    } catch {
      return false;
    }
  }

  private commitAssessmentFact(
    outcome: Extract<SupervisorAssessmentOutcome, { readonly kind: 'success' }>,
    identity: SupervisorAssessmentIdentity,
    input: SupervisorAssessmentInput,
  ): void {
    if (this.nextFactSequence === Number.MAX_SAFE_INTEGER) {
      return;
    }

    const candidate: SupervisorFactCandidate = {
      kind: SUPERVISOR_COMPLETION_ASSESSMENT_KIND,
      evidenceRefs: input.evidence.map((record) => record.id),
      data: {
        assessmentId: `assessment-${identity.runGeneration}`,
        rootRequestId: identity.rootRequestId,
        runSequence: identity.runGeneration,
        claims: outcome.output.claims.map((claim, index) => ({
          id: `claim-${index + 1}`,
          kind: claim.kind,
          quote: claim.quote,
          evidence: claim.evidence.map((reference) => ({
            id: reference.id,
            quoteHash: reference.quoteHash,
          })),
        })),
        evidence: input.evidence.map(
          ({ id, toolName, toolCallId, isError, inputDigest, resultDigest }) => ({
            id,
            toolName,
            toolCallId,
            isError,
            inputDigest,
            resultDigest,
          }),
        ),
      },
    };

    try {
      const record = createSupervisorFactRecord({
        candidate: validateSupervisorFactCandidate(candidate),
        sourceFeatureId: 'kernel',
        rootRequestId: identity.rootRequestId,
        sequence: this.nextFactSequence,
      });
      this.facts = [...this.facts, record];
      this.nextFactSequence += 1;
    } catch {
      // A model result never degrades the Kernel if a defensive fact boundary rejects it.
    }
  }

  private async handleSessionStart(event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
    await this.safe(undefined, async () => {
      await this.loadSession(ctx, true);
      await this.dispatchEvent(event, null);
    });
  }

  private async handleSessionShutdown(
    event: SessionShutdownEvent,
    ctx: ExtensionContext,
  ): Promise<void> {
    await this.safe(undefined, async () => {
      this.invalidatePendingAssessment();
      this.assessmentController.resetForSession();
      this.sessionGeneration = incrementGeneration(this.sessionGeneration);
      this.rootGeneration = incrementGeneration(this.rootGeneration);
      this.runGeneration = 0;
      this.finalAssistantRunGeneration = 0;
      await this.ensureLoaded(ctx);
      await this.dispatchEvent(event, null);
      await this.runtimeManager.dispose();
      this.currentRoot = null;
      this.facts = [];
      this.nextFactSequence = 0;
      this.assessmentCapture.resetSession();
      this.loaded = false;
    });
  }

  private async handleSessionBeforeCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): Promise<void> {
    await this.safe(undefined, async () => {
      await this.ensureLoaded(ctx);
      await this.dispatchEvent(event, null);
    });
  }

  private async handleSessionCompact(event: SessionCompactEvent, ctx: ExtensionContext): Promise<void> {
    await this.safe(undefined, async () => {
      await this.ensureLoaded(ctx);
      await this.dispatchEvent(event, null);
    });
  }

  private async handleSessionCompactFailed(
    event: SessionCompactFailedEvent,
    ctx: ExtensionContext,
  ): Promise<void> {
    await this.safe(undefined, async () => {
      await this.ensureLoaded(ctx);
      await this.dispatchEvent(event, null);
    });
  }

  private async handleContext(event: ContextEvent, ctx: ExtensionContext): Promise<void> {
    await this.safe(undefined, async () => {
      await this.ensureLoaded(ctx);
      await this.dispatchEvent(event, this.currentRoot?.id ?? null);
    });
  }

  private async dispatchEvent(
    event: SupervisorPiObservationEvent,
    rootRequestId: string | null,
  ): Promise<void> {
    const observation = this.normalizer.normalize(event, rootRequestId);
    if (observation !== undefined) {
      await this.dispatchAndIntervene(observation, undefined);
    }
  }

  private async dispatchAndIntervene(
    observation: SupervisorObservation,
    targetToolCallId: string | undefined,
  ): Promise<ToolCallEventResult | undefined> {
    let result;
    try {
      result = await dispatchObservation({
        observation,
        features: this.runtimeManager.getDispatchFeatures(this.health === 'degraded'),
        facts: this.facts,
        nextFactSequence: this.nextFactSequence,
      });
    } catch {
      this.markDegraded();
      return undefined;
    }

    this.facts = [...this.facts, ...result.emittedFacts];
    this.nextFactSequence = result.nextFactSequence;
    this.runtimeManager.applyNextStates(result.nextStates);
    this.persistNextStates(result.nextStates);

    let arbitration: readonly SupervisorArbitrationResult[];
    try {
      const featureModes = this.runtimeManager.getFeatureModes();
      const effectiveModes =
        this.health === 'degraded' ? this.observeOnlyFeatureModes(featureModes) : featureModes;
      arbitration = arbitrateInterventions({
        proposals: result.proposals,
        featureModes: effectiveModes,
      });
    } catch {
      this.markDegraded();
      return undefined;
    }
    return this.executeInterventions(arbitration, targetToolCallId);
  }

  private observeOnlyFeatureModes(
    featureModes: Readonly<Record<string, 'autonomous' | 'observe' | 'off' | 'unavailable'>>,
  ): Readonly<Record<string, 'autonomous' | 'observe' | 'off' | 'unavailable'>> {
    const modes: Record<string, 'autonomous' | 'observe' | 'off' | 'unavailable'> = {};
    for (const [featureId, mode] of Object.entries(featureModes)) {
      modes[featureId] = mode === 'autonomous' ? 'observe' : mode;
    }
    return Object.freeze(modes);
  }

  private executeInterventions(
    arbitration: readonly SupervisorArbitrationResult[],
    targetToolCallId: string | undefined,
  ): ToolCallEventResult | undefined {
    let blockResult: ToolCallEventResult | undefined;
    for (const group of arbitration) {
      const winner = group.winner;
      if (winner === undefined) {
        continue;
      }
      if (winner.delivery === 'block') {
        if (
          targetToolCallId !== undefined &&
          group.boundary === 'tool-call' &&
          group.targetToolCallId === targetToolCallId &&
          winner.message !== undefined
        ) {
          blockResult = { block: true, reason: winner.message };
        }
        continue;
      }
      if (winner.delivery === 'none' || winner.message === undefined) {
        continue;
      }
      this.sendIntervention(winner.delivery, winner.message);
    }
    return blockResult;
  }

  private sendIntervention(delivery: SupervisorInterventionDelivery, message: string): void {
    try {
      if (delivery === 'steer') {
        this.pi.sendUserMessage(message, { deliverAs: 'steer' });
      } else if (delivery === 'follow-up') {
        this.pi.sendUserMessage(message, { deliverAs: 'followUp' });
      }
    } catch {
      this.markDegraded();
    }
  }

  private persistNextStates(nextStates: Readonly<Record<string, JsonValue>>): void {
    for (const [featureId, data] of Object.entries(nextStates)) {
      const codec = this.runtimeManager.getFeatureStateCodec(featureId);
      if (codec === undefined) {
        this.markDegraded();
        continue;
      }
      try {
        const record = createSupervisorFeatureStateRecord(featureId, codec, data);
        validateSupervisorFeatureStateEnvelope(record.state);
        this.pi.appendEntry(SUPERVISOR_STATE_CUSTOM_TYPE, record);
        this.restoredFeatureStates.set(featureId, record.state);
        this.runtimeManager.setRestoredStates(this.restoredFeatureStates);
      } catch {
        this.markDegraded();
      }
    }
  }

  private beginRootRequest(): boolean {
    const sequence = this.nextRootRequestSequence;
    if (sequence === Number.MAX_SAFE_INTEGER) {
      this.markDegraded();
      this.clearRootTracking();
      return false;
    }

    const reservedNext = sequence + 1;
    if (!this.persistRuntimeSequence(reservedNext)) {
      this.clearRootTracking();
      return false;
    }

    this.nextRootRequestSequence = reservedNext;
    this.currentRoot = { id: `root-${sequence}`, status: 'active' };
    this.runGeneration = 1;
    this.finalAssistantRunGeneration = 0;
    this.facts = [];
    this.nextFactSequence = 0;
    return true;
  }

  private persistRuntimeSequence(nextSequence: number): boolean {
    const state: SupervisorRuntimeStateRecordV1 = {
      schemaVersion: 1,
      kind: 'runtime',
      state: {
        schemaVersion: 1,
        nextRootRequestSequence: nextSequence,
      },
    };
    try {
      this.pi.appendEntry(SUPERVISOR_STATE_CUSTOM_TYPE, state);
      return true;
    } catch {
      this.markDegraded();
      return false;
    }
  }

  private async ensureLoaded(ctx: ExtensionContext): Promise<void> {
    if (!this.loaded) {
      await this.loadSession(ctx, true);
    }
  }

  private async loadSession(ctx: ExtensionContext, resetFailureIsolation: boolean): Promise<void> {
    if (resetFailureIsolation) {
      this.runtimeManager.resetSession();
    }
    this.invalidatePendingAssessment();
    this.assessmentController.resetForSession();
    this.sessionGeneration = incrementGeneration(this.sessionGeneration);
    this.rootGeneration = incrementGeneration(this.rootGeneration);
    this.runGeneration = 0;
    this.finalAssistantRunGeneration = 0;
    this.currentRoot = null;
    this.facts = [];
    this.nextFactSequence = 0;
    this.assessmentCapture.resetSession();
    this.health = 'healthy';

    const branch = ctx.sessionManager.getBranch();
    const configEntry = branch
      .filter(
        (entry): entry is Extract<SessionEntry, { type: 'custom' }> =>
          entry.type === 'custom' && entry.customType === SUPERVISOR_CONFIG_CUSTOM_TYPE,
      )
      .at(-1);
    this.configEntryPresent = configEntry !== undefined;
    this.configValue = configEntry === undefined ? DEFAULT_SUPERVISOR_CONFIG : configEntry.data;
    const parsedConfig = this.configEntryPresent
      ? parseSupervisorConfig(this.configValue)
      : { status: 'valid' as const, config: DEFAULT_SUPERVISOR_CONFIG, featureDiagnostics: [] };
    this.parsedConfig = parsedConfig.status === 'valid' ? parsedConfig.config : null;

    this.loadPersistedState(branch);
    await this.runtimeManager.rebuild(this.configValue);
    this.loaded = true;
  }

  private loadPersistedState(branch: readonly SessionEntry[]): void {
    this.restoredFeatureStates = new Map();
    this.invalidRestoredStateFeatureIds = new Set();
    this.runtimeStateRecovery = 'none';
    this.runtimeStateRecoveryNext = undefined;

    let latestValidNext = DEFAULT_SUPERVISOR_RUNTIME_STATE.nextRootRequestSequence;
    let potentialAdvancements = 0;

    for (const entry of branch) {
      if (entry.type !== 'custom' || entry.customType !== SUPERVISOR_STATE_CUSTOM_TYPE) {
        continue;
      }
      const classification = classifyPersistedState(entry.data);
      switch (classification.kind) {
        case 'runtime-valid':
          latestValidNext = classification.record.state.nextRootRequestSequence;
          potentialAdvancements = 0;
          break;
        case 'runtime-invalid':
        case 'unclassifiable':
          potentialAdvancements += 1;
          break;
        case 'feature-valid':
          this.invalidRestoredStateFeatureIds.delete(classification.state.featureId);
          this.restoredFeatureStates.set(classification.state.featureId, classification.state);
          break;
        case 'feature-invalid':
          this.restoredFeatureStates.delete(classification.featureId);
          this.invalidRestoredStateFeatureIds.add(classification.featureId);
          break;
      }
    }

    this.nextRootRequestSequence = latestValidNext;
    if (potentialAdvancements > 0) {
      if (potentialAdvancements > Number.MAX_SAFE_INTEGER - latestValidNext) {
        this.nextRootRequestSequence = Number.MAX_SAFE_INTEGER;
        this.markDegraded();
        this.runtimeStateRecovery = 'failed';
      } else {
        const recoveredNext = latestValidNext + potentialAdvancements;
        this.nextRootRequestSequence = recoveredNext;
        if (this.persistRuntimeSequence(recoveredNext)) {
          this.runtimeStateRecovery = 'recovered';
          this.runtimeStateRecoveryNext = recoveredNext;
        } else {
          this.runtimeStateRecovery = 'failed';
        }
      }
    }

    this.runtimeManager.setRestoredStates(this.restoredFeatureStates);
    this.runtimeManager.setInvalidRestoredStateFeatureIds(this.invalidRestoredStateFeatureIds);
  }

  private async handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    try {
      await this.ensureLoaded(ctx);
      const tokens = args.trim().length === 0 ? [] : args.trim().split(/\s+/u);
      if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === 'status')) {
        ctx.ui.notify(this.statusMessage());
        return;
      }
      if (tokens.length === 2 && tokens[0] === 'mode') {
        const mode = tokens[1];
        if (mode === 'autonomous' || mode === 'observe' || mode === 'off') {
          await this.changeGlobalMode(mode, ctx);
          return;
        }
      }
      if (tokens.length === 3 && tokens[0] === 'feature') {
        const featureId = tokens[1];
        const mode = tokens[2];
        if (
          featureId !== undefined &&
          (mode === 'autonomous' || mode === 'observe' || mode === 'off' || mode === 'default')
        ) {
          await this.changeFeatureMode(featureId, mode, ctx);
          return;
        }
      }
      ctx.ui.notify(USAGE_MESSAGE, 'warning');
    } catch {
      this.markDegraded();
    }
  }

  private async changeGlobalMode(
    mode: SupervisorConfigV1['mode'],
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const currentMode = this.runtimeManager.getPlan()?.requestedGlobalMode;
    const configIsValid = !this.configEntryPresent || this.runtimeManager.getPlan()?.configStatus === 'valid';
    if (configIsValid && currentMode === mode) {
      ctx.ui.notify(`Agent Supervisor: global mode is already ${mode}.`);
      return;
    }

    const nextConfig =
      !configIsValid || this.parsedConfig === null
        ? { schemaVersion: 1 as const, mode, features: {} }
        : copyConfig(this.parsedConfig, mode);
    if (await this.persistConfigChange(nextConfig)) {
      ctx.ui.notify(`Agent Supervisor: global mode set to ${mode}.`);
    }
  }

  private async changeFeatureMode(
    featureId: string,
    mode: SupervisorFeatureMode | 'default',
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    if (this.configEntryPresent && this.runtimeManager.getPlan()?.configStatus !== 'valid') {
      ctx.ui.notify('Agent Supervisor: repair the global mode before changing a feature.', 'warning');
      return;
    }

    const descriptor = this.runtimeManager.getRegisteredDescriptor(featureId);
    if (descriptor === undefined) {
      ctx.ui.notify('Agent Supervisor: that feature is not registered.', 'warning');
      return;
    }

    const config = this.parsedConfig ?? DEFAULT_SUPERVISOR_CONFIG;
    const currentEntry = config.features[featureId];
    const nextFeatures: Record<string, SupervisorFeatureConfigEntry> = {};
    for (const id of Object.keys(config.features).sort(compareStrings)) {
      const entry = config.features[id];
      if (entry !== undefined) {
        nextFeatures[id] = copyFeatureConfigEntry(entry);
      }
    }

    if (mode === 'default') {
      if (currentEntry === undefined || !hasOwn(currentEntry, 'mode')) {
        ctx.ui.notify(`Agent Supervisor: feature ${featureId} is already using its default mode.`);
        return;
      }
      const settings = currentEntry.settings;
      if (settings !== undefined) {
        nextFeatures[featureId] = { settings };
      } else {
        delete nextFeatures[featureId];
      }
    } else {
      const currentEffectiveMode = currentEntry?.mode ?? descriptor.defaultMode;
      if (currentEffectiveMode === mode) {
        ctx.ui.notify(`Agent Supervisor: feature ${featureId} is already ${mode}.`);
        return;
      }
      nextFeatures[featureId] =
        currentEntry === undefined
          ? { mode }
          : currentEntry.settings !== undefined
            ? { mode, settings: currentEntry.settings }
            : { mode };
    }

    const nextConfig: SupervisorConfigV1 = {
      schemaVersion: 1,
      mode: config.mode,
      features: nextFeatures,
    };
    if (await this.persistConfigChange(nextConfig)) {
      ctx.ui.notify(
        mode === 'default'
          ? `Agent Supervisor: feature ${featureId} restored to its default mode.`
          : `Agent Supervisor: feature ${featureId} set to ${mode}.`,
      );
    }
  }

  private async persistConfigChange(nextConfig: SupervisorConfigV1): Promise<boolean> {
    try {
      this.pi.appendEntry(SUPERVISOR_CONFIG_CUSTOM_TYPE, nextConfig);
      this.configEntryPresent = true;
      this.configValue = nextConfig;
      this.parsedConfig = nextConfig;
      await this.runtimeManager.rebuild(nextConfig);
      this.loaded = true;
      return true;
    } catch {
      this.markDegraded();
      return false;
    }
  }

  private statusMessage(): string {
    const plan = this.runtimeManager.getPlan();
    const statuses = [...this.runtimeManager.getStatuses()].sort((left, right) =>
      compareStrings(left.id, right.id),
    );
    const runtimeStateLine =
      this.runtimeStateRecovery === 'recovered'
        ? `Runtime state: recovered (next root request sequence: ${this.runtimeStateRecoveryNext ?? this.nextRootRequestSequence})`
        : this.runtimeStateRecovery === 'failed'
          ? 'Runtime state: recovery failed'
          : 'Runtime state: normal';
    const invalidFeatureIds = [...this.invalidRestoredStateFeatureIds].sort(compareStrings);
    const lines = [
      'Agent Supervisor',
      `Global config: ${plan?.configStatus ?? (this.configEntryPresent ? 'degraded' : 'valid')}`,
      `Requested global mode: ${plan?.requestedGlobalMode ?? 'none'}`,
      `Effective global mode: ${plan?.effectiveGlobalMode ?? 'observe'}`,
      `Kernel health: ${this.health}`,
      `Assessment: ${this.assessmentController.getStatus()}`,
      runtimeStateLine,
      ...(invalidFeatureIds.length === 0
        ? []
        : [`Invalid persisted feature state: ${invalidFeatureIds.join(', ')} (state-invalid)`]),
      `Current root: ${this.currentRoot?.id ?? 'none'} (${this.currentRoot?.status ?? 'none'})`,
      `Registered features: ${this.runtimeManager.getRegisteredCount()}`,
    ];
    for (const status of statuses) {
      const reason = status.reason === undefined ? '' : ` reason=${status.reason}`;
      lines.push(
        `- ${status.id}: maturity=${status.descriptor.maturity}, default=${status.descriptor.defaultMode}, requested=${status.requestedMode}, effective=${status.effectiveMode}, runtime=${status.runtimeMode}, status=${status.status}${reason}`,
      );
    }
    return lines.join('\n');
  }

  private async safe<T>(fallback: T, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      this.markDegraded();
      return fallback;
    }
  }
}
