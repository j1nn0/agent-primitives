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
import type { SupervisorFeatureMode } from '../feature.js';
import type { SupervisorFactRecord } from '../fact.js';
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

/**
 * The Pi adapter kernel. It is the only owner of lifecycle normalization, ephemeral facts,
 * persistence, feature runtime isolation, arbitration, and external intervention transport.
 */
export class SupervisorKernel {
  private readonly normalizer = new SupervisorObservationNormalizer();

  private readonly runtimeManager: SupervisorFeatureRuntimeManager;

  private readonly pi: ExtensionAPI;

  private currentRoot: CurrentRoot | null = null;

  private facts: SupervisorFactRecord[] = [];

  private nextFactSequence = 0;

  private nextRootRequestSequence = DEFAULT_SUPERVISOR_RUNTIME_STATE.nextRootRequestSequence;

  private health: SupervisorKernelHealth = 'healthy';

  private loaded = false;

  private configEntryPresent = false;

  private configValue: unknown = DEFAULT_SUPERVISOR_CONFIG;

  private parsedConfig: SupervisorConfigV1 | null = DEFAULT_SUPERVISOR_CONFIG;

  private restoredFeatureStates = new Map<string, SupervisorFeatureStateEnvelope>();
  private invalidRestoredStateFeatureIds = new Set<string>();

  private operationQueue: Promise<void> = Promise.resolve();

  public constructor(pi: ExtensionAPI, features: readonly SupervisorKernelFeatureModule[]) {
    this.pi = pi;
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

    this.pi.on('input', (event, ctx) => this.enqueue(() => this.handleInput(event, ctx)));
    this.pi.on('tool_call', (event, ctx) => this.enqueue(() => this.handleToolCall(event, ctx)));
    this.pi.on('tool_result', (event, ctx) => this.enqueue(() => this.handleToolResult(event, ctx)));
    this.pi.on('turn_end', (event, ctx) => this.enqueue(() => this.handleTurnEnd(event, ctx)));
    this.pi.on('agent_settled', (event, ctx) =>
      this.enqueue(() => this.handleAgentSettled(event, ctx)),
    );
    this.pi.on('session_start', (event, ctx) =>
      this.enqueue(() => this.handleSessionStart(event, ctx)),
    );
    this.pi.on('session_shutdown', (event, ctx) =>
      this.enqueue(() => this.handleSessionShutdown(event, ctx)),
    );
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

  private async handleInput(event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult> {
    return this.safe({ action: 'continue' }, async () => {
      await this.ensureLoaded(ctx);
      if (event.source === 'extension') {
        if (this.currentRoot !== null) {
          this.currentRoot.status = 'active';
        }
        return { action: 'continue' };
      }

      if (!this.beginRootRequest()) {
        return { action: 'continue' };
      }
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
      await this.dispatchEvent(event, this.currentRoot?.id ?? null);
    });
  }

  private async handleTurnEnd(event: TurnEndEvent, ctx: ExtensionContext): Promise<void> {
    await this.safe(undefined, async () => {
      await this.ensureLoaded(ctx);
      await this.dispatchEvent(event, this.currentRoot?.id ?? null);
    });
  }

  private async handleAgentSettled(event: AgentSettledEvent, ctx: ExtensionContext): Promise<void> {
    await this.safe(undefined, async () => {
      await this.ensureLoaded(ctx);
      if (this.currentRoot !== null) {
        this.currentRoot.status = 'settled';
      }
      await this.dispatchEvent(event, this.currentRoot?.id ?? null);
    });
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
      await this.ensureLoaded(ctx);
      await this.dispatchEvent(event, null);
      await this.runtimeManager.dispose();
      this.currentRoot = null;
      this.facts = [];
      this.nextFactSequence = 0;
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
    if (this.nextRootRequestSequence === Number.MAX_SAFE_INTEGER) {
      this.markDegraded();
      return false;
    }
    const sequence = this.nextRootRequestSequence;
    this.nextRootRequestSequence += 1;
    this.currentRoot = { id: `root-${sequence}`, status: 'active' };
    this.facts = [];
    this.nextFactSequence = 0;
    this.persistRuntimeSequence();
    return true;
  }

  private persistRuntimeSequence(): void {
    const state: SupervisorRuntimeStateRecordV1 = {
      schemaVersion: 1,
      kind: 'runtime',
      state: {
        schemaVersion: 1,
        nextRootRequestSequence: this.nextRootRequestSequence,
      },
    };
    try {
      this.pi.appendEntry(SUPERVISOR_STATE_CUSTOM_TYPE, state);
    } catch {
      this.markDegraded();
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
    this.currentRoot = null;
    this.facts = [];
    this.nextFactSequence = 0;
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
    const validRuntimeStates: SupervisorRuntimeStateRecordV1[] = [];
    let latestRuntimeSeen = false;
    let latestRuntime: SupervisorRuntimeStateRecordV1 | undefined;
    let latestRuntimeWasValid = false;

    for (const entry of branch) {
      if (entry.type !== 'custom' || entry.customType !== SUPERVISOR_STATE_CUSTOM_TYPE) {
        continue;
      }
      const raw = entry.data;
      const parsed = parseSupervisorStateRecord(raw);
      if (isRuntimeShaped(raw)) {
        latestRuntimeSeen = true;
        latestRuntime =
          parsed.status === 'valid' && parsed.record.kind === 'runtime' ? parsed.record : undefined;
        latestRuntimeWasValid = parsed.status === 'valid' && parsed.record.kind === 'runtime';
      }
      if (parsed.status !== 'valid') {
        this.markDegraded();
        if (!isRuntimeShaped(raw)) {
          const featureId = recoverFeatureId(raw);
          if (featureId !== undefined) {
            this.invalidRestoredStateFeatureIds.add(featureId);
          }
        }
        continue;
      }
      if (parsed.record.kind === 'runtime') {
        validRuntimeStates.push(parsed.record);
      } else {
        // Unknown feature ids remain in this map and are never rewritten by the kernel.
        this.restoredFeatureStates.set(parsed.record.state.featureId, parsed.record.state);
      }
    }

    if (latestRuntimeSeen && latestRuntime !== undefined && latestRuntimeWasValid) {
      this.nextRootRequestSequence = latestRuntime.state.nextRootRequestSequence;
    } else if (latestRuntimeSeen) {
      // If the latest runtime record is invalid, use the monotonic supremum of every valid runtime
      // record on the branch. This prevents an invalid tail from ever causing a root id reuse.
      this.health = 'degraded';
      this.nextRootRequestSequence = validRuntimeStates.reduce(
        (maximum, record) => Math.max(maximum, record.state.nextRootRequestSequence),
        DEFAULT_SUPERVISOR_RUNTIME_STATE.nextRootRequestSequence,
      );
    } else {
      this.nextRootRequestSequence = DEFAULT_SUPERVISOR_RUNTIME_STATE.nextRootRequestSequence;
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
    const lines = [
      'Agent Supervisor',
      `Global config: ${plan?.configStatus ?? (this.configEntryPresent ? 'degraded' : 'valid')}`,
      `Requested global mode: ${plan?.requestedGlobalMode ?? 'none'}`,
      `Effective global mode: ${plan?.effectiveGlobalMode ?? 'observe'}`,
      `Kernel health: ${this.health}`,
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
