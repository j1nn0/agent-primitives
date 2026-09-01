import { describe, expect, it } from 'vitest';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from '@earendil-works/pi-coding-agent';
import {
  createAgentSupervisorExtension,
  registerAgentSupervisorExtension,
} from '../src/extension.js';
import { computeSupervisorJsonDigest } from '../src/digest.js';
import type { SupervisorFactCandidate } from '../src/fact.js';
import type {
  SupervisorFeatureDescriptor,
  SupervisorFeatureMode,
} from '../src/feature.js';
import type {
  SupervisorInterventionBoundary,
  SupervisorInterventionDelivery,
  SupervisorInterventionProposal,
} from '../src/intervention.js';
import type {
  SupervisorFeatureContext,
  SupervisorFeatureEmission,
  SupervisorFeatureModule,
  SupervisorFeatureRuntime,
  SupervisorFeatureRuntimeContext,
} from '../src/module.js';
import {
  SUPERVISOR_OBSERVATION_KINDS,
  type SupervisorObservation,
} from '../src/observation.js';
import { isJsonValue, type JsonValue } from '../src/json.js';
import {
  SUPERVISOR_CONFIG_CUSTOM_TYPE,
  type SupervisorConfigV1,
} from '../src/config.js';
import {
  SUPERVISOR_STATE_CUSTOM_TYPE,
  type SupervisorFeatureStateEnvelope,
} from '../src/state.js';

interface Notification {
  readonly message: string;
  readonly type: string | undefined;
}

interface SentMessage {
  readonly content: unknown;
  readonly options: unknown;
}

type EventHandler = (event: unknown, context: ExtensionContext) => Promise<unknown> | unknown;
type CommandHandler = (args: string, context: ExtensionCommandContext) => Promise<void>;

function customEntry(customType: string, data: unknown): SessionEntry {
  return {
    type: 'custom',
    id: `seed-${customType}`,
    parentId: null,
    timestamp: '1970-01-01T00:00:00.000Z',
    customType,
    data,
  } as SessionEntry;
}

class RecordingPi {
  public readonly handlers = new Map<string, EventHandler>();

  public readonly commands = new Map<string, CommandHandler>();

  public readonly appendedEntries: { customType: string; data: unknown }[] = [];

  public readonly notifications: Notification[] = [];

  public readonly sentMessages: SentMessage[] = [];

  public registerToolCalls = 0;

  private readonly branch: SessionEntry[];

  public readonly pi: ExtensionAPI;

  public constructor(initialBranch: readonly SessionEntry[] = []) {
    this.branch = [...initialBranch];
    this.pi = {
      on: (event: string, handler: unknown): void => {
        this.handlers.set(event, handler as EventHandler);
      },
      registerCommand: (name: string, options: { handler: CommandHandler }): void => {
        this.commands.set(name, options.handler);
      },
      registerTool: (): void => {
        this.registerToolCalls += 1;
      },
      appendEntry: (customType: string, data?: unknown): void => {
        this.appendedEntries.push({ customType, data });
        this.branch.push(customEntry(customType, data));
      },
      sendUserMessage: (content: unknown, options?: unknown): void => {
        this.sentMessages.push({ content, options });
      },
    } as unknown as ExtensionAPI;
  }

  public context(): ExtensionContext {
    return {
      ui: {
        notify: (message: string, type?: 'info' | 'warning' | 'error'): void => {
          this.notifications.push({ message, type });
        },
      },
      sessionManager: {
        getBranch: (): SessionEntry[] => this.branch,
      },
    } as unknown as ExtensionContext;
  }
  public branchSnapshot(): readonly SessionEntry[] {
    return [...this.branch];
  }

  public async emit(type: string, event: unknown): Promise<unknown> {
    const handler = this.handlers.get(type);
    if (handler === undefined) {
      throw new Error(`No handler for ${type}`);
    }
    return handler(event, this.context());
  }

  public async command(args: string): Promise<void> {
    const handler = this.commands.get('agent-supervisor');
    if (handler === undefined) {
      throw new Error('Supervisor command was not registered.');
    }
    await handler(args, this.context() as unknown as ExtensionCommandContext);
  }
}

interface FeatureOptions {
  readonly defaultMode?: SupervisorFeatureMode;
  readonly observes?: readonly SupervisorObservationDescriptorKind[];
  readonly validateConfig?: (value: unknown) => JsonValue;
  readonly validateState?: (value: unknown) => StatefulValue;
}

type SupervisorObservationDescriptorKind = (typeof SUPERVISOR_OBSERVATION_KINDS)[number];

type StatelessCallback = (
  observation: SupervisorObservation,
  context: SupervisorFeatureRuntimeContext<never>,
) => void | SupervisorFeatureEmission<never> | Promise<void | SupervisorFeatureEmission<never>>;

type StatefulValue = { readonly count: number };
type StatefulCallback = (
  observation: SupervisorObservation,
  context: SupervisorFeatureRuntimeContext<StatefulValue>,
) => void | SupervisorFeatureEmission<StatefulValue> | Promise<void | SupervisorFeatureEmission<StatefulValue>>;

function descriptor(id: string, options: FeatureOptions = {}): SupervisorFeatureDescriptor {
  return {
    id,
    schemaVersion: 1,
    maturity: 'default',
    defaultMode: options.defaultMode ?? 'autonomous',
    observes: options.observes ?? SUPERVISOR_OBSERVATION_KINDS,
    provides: [],
    requires: [],
    conflictsWith: [],
    usesAuxiliaryModel: false,
    interventionIntents: ['continue'],
  };
}

function statelessFeature(
  id: string,
  callback: StatelessCallback,
  options: FeatureOptions = {},
): SupervisorFeatureModule {
  const module: SupervisorFeatureModule<JsonValueForTest, never> = {
    descriptor: descriptor(id, options),
    create: (context: SupervisorFeatureContext<JsonValueForTest, never>) => ({
      onObservation: (observation, runtimeContext) => callback(observation, runtimeContext),
      ...(context.featureId === '' ? { dispose: (): void => undefined } : {}),
    }),
    ...(options.validateConfig === undefined ? {} : { validateConfig: options.validateConfig }),
  };
  return module;
}

type JsonValueForTest = JsonValue;

function statefulFeature(
  id: string,
  callback: StatefulCallback,
  options: FeatureOptions = {},
): SupervisorFeatureModule<JsonValueForTest, StatefulValue> {
  return {
    descriptor: descriptor(id, options),
    state: {
      schemaVersion: 1,
      validate: options.validateState ?? ((value: unknown): StatefulValue => value as StatefulValue),
    },
    create: (context: SupervisorFeatureContext<JsonValueForTest, StatefulValue>) => ({
      onObservation: (observation, runtimeContext) => callback(observation, runtimeContext),
      ...(context.featureId === '' ? { dispose: (): void => undefined } : {}),
    }),
    ...(options.validateConfig === undefined ? {} : { validateConfig: options.validateConfig }),
  };
}

function proposal(
  sourceFeatureId: string,
  delivery: SupervisorInterventionDelivery,
  boundary: SupervisorInterventionBoundary,
  message = `${sourceFeatureId} message`,
  targetToolCallId?: string,
  priority = 1,
): SupervisorInterventionProposal {
  const base = {
    sourceFeatureId,
    boundary,
    intent: 'continue' as const,
    delivery,
    priority,
    reasonCode: `${sourceFeatureId}:reason`,
    message,
  };
  return targetToolCallId === undefined ? base : { ...base, targetToolCallId };
}

function fact(sourceFeatureId: string): SupervisorFactCandidate {
  return {
    kind: `${sourceFeatureId}:seen`,
    evidenceRefs: ['observation'],
    data: { seen: true },
  };
}

function inputEvent(source: 'interactive' | 'rpc' | 'extension', text = 'private prompt'): unknown {
  return { type: 'input', source, text };
}

function toolCallEvent(toolCallId = 'tool-1', input: unknown = { path: 'private input' }): unknown {
  return { type: 'tool_call', toolCallId, toolName: 'custom-tool', input };
}

function toolResultEvent(toolCallId = 'tool-1'): unknown {
  return {
    type: 'tool_result',
    toolCallId,
    toolName: 'custom-tool',
    input: { path: 'private input' },
    content: [{ type: 'text', text: 'private result content' }],
    isError: false,
    details: { stdout: 'private stdout' },
  };
}

function sessionStartEvent(): unknown {
  return { type: 'session_start', reason: 'startup' };
}

describe('Agent Supervisor Pi extension', () => {
  it('registers exactly one command and never registers a model-callable tool', () => {
    const recording = new RecordingPi();
    registerAgentSupervisorExtension(recording.pi);

    expect(recording.registerToolCalls).toBe(0);
    expect([...recording.commands.keys()]).toEqual(['agent-supervisor']);
  });

  it('normalizes all eleven lifecycle mappings with safe deterministic envelopes', async () => {
    const observations: SupervisorObservation[] = [];
    const feature = statelessFeature('observer', (observation) => {
      observations.push(observation);
    });
    const recording = new RecordingPi();
    createAgentSupervisorExtension({ features: [feature] })(recording.pi);

    await recording.emit('session_start', sessionStartEvent());
    await recording.emit('input', inputEvent('interactive'));
    await recording.emit('tool_call', toolCallEvent());
    await recording.emit('tool_result', toolResultEvent());
    await recording.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 2,
      message: { role: 'assistant', content: [{ type: 'text', text: 'private assistant response' }] },
      toolResults: [],
    });
    await recording.emit('agent_settled', { type: 'agent_settled' });
    await recording.emit('session_start', { type: 'session_start', reason: 'resume' });
    await recording.emit('session_shutdown', { type: 'session_shutdown', reason: 'reload' });
    await recording.emit('session_before_compact', {
      type: 'session_before_compact',
      reason: 'overflow',
      willRetry: true,
      preparation: {},
      branchEntries: [],
      signal: new AbortController().signal,
    });
    await recording.emit('session_compact', {
      type: 'session_compact',
      reason: 'manual',
      willRetry: false,
      fromExtension: true,
      compactionEntry: {},
    });
    await recording.emit('session_compact_failed', {
      type: 'session_compact_failed',
      reason: 'threshold',
      aborted: true,
      willRetry: false,
      fromExtension: false,
      errorMessage: 'private compaction error',
    });
    await recording.emit('context', {
      type: 'context',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'private context' }] }],
    });

    expect(observations.map((observation) => observation.kind)).toEqual([
      'session-started',
      'root-request-started',
      'before-tool-call',
      'tool-result',
      'turn-ended',
      'agent-settled',
      'session-started',
      'session-shutdown',
      'before-compact',
      'compacted',
      'compaction-failed',
      'context-changed',
    ]);
    expect(observations.map((observation) => observation.id)).toEqual(
      observations.map((_observation, index) => `observation-${index}`),
    );
    expect(observations.map((observation) => observation.sequence)).toEqual(
      observations.map((_observation, index) => index),
    );
    expect(observations.every((observation) => isJsonValue(observation.payload))).toBe(true);
    expect(JSON.stringify(observations)).not.toContain('private prompt');
    expect(JSON.stringify(observations)).not.toContain('private input');
    expect(JSON.stringify(observations)).not.toContain('private result content');
    expect(JSON.stringify(observations)).not.toContain('private assistant response');
    expect(JSON.stringify(observations)).not.toContain('private compaction error');
    expect(observations[0]?.rootRequestId).toBeNull();
    expect(observations[1]?.rootRequestId).toBe('root-1');
  });

  it('uses canonical, stable digests and safely returns null for non-JSON tool input', () => {
    const first = computeSupervisorJsonDigest({ b: 2, a: 1 });
    const reordered = computeSupervisorJsonDigest({ a: 1, b: 2 });
    const different = computeSupervisorJsonDigest({ a: 2, b: 1 });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(first).toBe(reordered);
    expect(first).not.toBe(different);
    expect(computeSupervisorJsonDigest(cyclic)).toBeNull();
    expect(first).not.toContain('private');
  });

  it('tracks roots across extension input, settlement, restart, and persisted counters', async () => {
    const observations: SupervisorObservation[] = [];
    const feature = statelessFeature('root-observer', (observation) => {
      observations.push(observation);
    });
    const persistedRuntime = {
      schemaVersion: 1,
      kind: 'runtime',
      state: { schemaVersion: 1, nextRootRequestSequence: 7 },
    };
    const recording = new RecordingPi([customEntry(SUPERVISOR_STATE_CUSTOM_TYPE, persistedRuntime)]);
    createAgentSupervisorExtension({ features: [feature] })(recording.pi);

    await recording.emit('input', inputEvent('interactive'));
    await recording.emit('input', inputEvent('extension'));
    await recording.emit('agent_settled', { type: 'agent_settled' });
    await recording.emit('input', inputEvent('extension'));
    await recording.emit('input', inputEvent('rpc'));
    await recording.emit('session_start', { type: 'session_start', reason: 'resume' });
    await recording.emit('input', inputEvent('extension'));

    expect(observations.map((observation) => [observation.kind, observation.rootRequestId])).toEqual([
      ['root-request-started', 'root-7'],
      ['agent-settled', 'root-7'],
      ['root-request-started', 'root-8'],
      ['session-started', null],
    ]);
    const runtimeEntries = recording.appendedEntries.filter(
      (entry) => entry.customType === SUPERVISOR_STATE_CUSTOM_TYPE,
    );
    expect(runtimeEntries[0]?.data).toEqual({
      schemaVersion: 1,
      kind: 'runtime',
      state: { schemaVersion: 1, nextRootRequestSequence: 8 },
    });
    expect(runtimeEntries[1]?.data).toEqual({
      schemaVersion: 1,
      kind: 'runtime',
      state: { schemaVersion: 1, nextRootRequestSequence: 9 },
    });
  });

  it('does not persist the absent default config and persists only real mode changes', async () => {
    const recording = new RecordingPi();
    const feature = statelessFeature('feature-a', () => undefined);
    createAgentSupervisorExtension({ features: [feature] })(recording.pi);

    await recording.command('status');
    await recording.command('mode autonomous');
    expect(recording.appendedEntries.filter((entry) => entry.customType === SUPERVISOR_CONFIG_CUSTOM_TYPE)).toHaveLength(0);

    await recording.command('mode observe');
    await recording.command('mode observe');
    const configEntries = recording.appendedEntries.filter(
      (entry) => entry.customType === SUPERVISOR_CONFIG_CUSTOM_TYPE,
    );
    expect(configEntries).toHaveLength(1);
    expect(configEntries[0]?.data).toEqual({ schemaVersion: 1, mode: 'observe', features: {} });
  });

  it('repairs corrupt global config only through mode and refuses feature edits until repair', async () => {
    const corrupt = customEntry(SUPERVISOR_CONFIG_CUSTOM_TYPE, { mode: 'autonomous' });
    const recording = new RecordingPi([corrupt]);
    const feature = statelessFeature('feature-a', () => undefined);
    createAgentSupervisorExtension({ features: [feature] })(recording.pi);

    await recording.command('feature feature-a off');
    expect(recording.appendedEntries).toHaveLength(0);
    expect(recording.notifications.at(-1)?.message).toContain('repair the global mode');
    await recording.command('status');
    expect(recording.notifications.at(-1)?.message).toContain('Global config: degraded');
    expect(recording.notifications.at(-1)?.message).toContain('Registered features: 1');
    expect(recording.notifications.at(-1)?.message).toContain('feature-a');

    await recording.command('mode observe');
    expect(recording.appendedEntries.at(-1)?.data).toEqual({
      schemaVersion: 1,
      mode: 'observe',
      features: {},
    });
  });

  it('preserves unknown future config entries when changing a known feature', async () => {
    const config: SupervisorConfigV1 = {
      schemaVersion: 1,
      mode: 'autonomous',
      features: {
        'future-feature': { mode: 'observe', settings: { keep: true } },
      },
    };
    const recording = new RecordingPi([customEntry(SUPERVISOR_CONFIG_CUSTOM_TYPE, config)]);
    const feature = statelessFeature('known-feature', () => undefined);
    createAgentSupervisorExtension({ features: [feature] })(recording.pi);

    await recording.command('feature known-feature off');

    expect(recording.appendedEntries.at(-1)?.data).toEqual({
      schemaVersion: 1,
      mode: 'autonomous',
      features: {
        'future-feature': { mode: 'observe', settings: { keep: true } },
        'known-feature': { mode: 'off' },
      },
    });
  });

  it('degrades and isolates a feature with a corrupt recoverable state id', async () => {
    const corrupt = customEntry(SUPERVISOR_STATE_CUSTOM_TYPE, {
      schemaVersion: 1,
      kind: 'feature',
      state: {
        schemaVersion: 1,
        featureId: 'corrupt-state',
        featureSchemaVersion: 1,
        data: undefined,
      },
    });
    let corruptCalls = 0;
    let siblingCalls = 0;
    const corruptFeature = statelessFeature('corrupt-state', () => {
      corruptCalls += 1;
    });
    const sibling = statelessFeature('healthy-sibling', () => {
      siblingCalls += 1;
    });
    const recording = new RecordingPi([corrupt]);
    createAgentSupervisorExtension({ features: [corruptFeature, sibling] })(recording.pi);

    const inputResult = await recording.emit('input', inputEvent('interactive'));
    const toolResult = await recording.emit('tool_call', toolCallEvent());
    await recording.command('status');

    expect(inputResult).toEqual({ action: 'continue' });
    expect(toolResult).toBeUndefined();
    expect(corruptCalls).toBe(0);
    expect(siblingCalls).toBe(2);
    const status = recording.notifications.at(-1)?.message ?? '';
    expect(status).toContain('Kernel health: degraded');
    expect(status).toContain('corrupt-state');
    expect(status).toContain('state-invalid');
    expect(status).toContain('healthy-sibling');
    expect(status).toContain('status=active');
  });

  it('degrades without disabling registered features when a corrupt state id is unrecoverable', async () => {
    const corrupt = customEntry(SUPERVISOR_STATE_CUSTOM_TYPE, {
      schemaVersion: 1,
      kind: 'garbled',
      state: { schemaVersion: 1, featureSchemaVersion: 1, data: {} },
    });
    const calls = { first: 0, second: 0 };
    const first = statelessFeature('feature-a', () => {
      calls.first += 1;
    });
    const second = statelessFeature('feature-b', () => {
      calls.second += 1;
    });
    const recording = new RecordingPi([corrupt]);
    createAgentSupervisorExtension({ features: [second, first] })(recording.pi);

    const result = await recording.emit('input', inputEvent('interactive'));
    await recording.command('status');

    expect(result).toEqual({ action: 'continue' });
    expect(calls).toEqual({ first: 1, second: 1 });
    const status = recording.notifications.at(-1)?.message ?? '';
    expect(status).toContain('Kernel health: degraded');
    expect(status).toContain('feature-a');
    expect(status).toContain('feature-b');
    expect(status.match(/status=active/gu)).toHaveLength(2);
  });

  it('honors valid state and runtime records alongside corrupt state and preserves unknown state', async () => {
    const runtimeRecord = {
      schemaVersion: 1,
      kind: 'runtime',
      state: { schemaVersion: 1, nextRootRequestSequence: 5 },
    };
    const featureStateRecord = (featureId: string, data: JsonValue) => ({
      schemaVersion: 1,
      kind: 'feature' as const,
      state: { schemaVersion: 1, featureId, featureSchemaVersion: 1, data },
    });
    const validFeatureRecord = customEntry(
      SUPERVISOR_STATE_CUSTOM_TYPE,
      featureStateRecord('restored-state', { count: 7 }),
    );
    const unknownFeatureRecord = customEntry(
      SUPERVISOR_STATE_CUSTOM_TYPE,
      featureStateRecord('future-state', { count: 9 }),
    );
    const corrupt = customEntry(SUPERVISOR_STATE_CUSTOM_TYPE, {
      schemaVersion: 1,
      kind: 'garbled',
      state: {},
    });
    const restored: (StatefulValue | null)[] = [];
    const roots: (string | null)[] = [];
    const feature = statefulFeature('restored-state', (observation, context) => {
      roots.push(observation.rootRequestId);
      restored.push(context.state);
    });
    const recording = new RecordingPi([
      customEntry(SUPERVISOR_STATE_CUSTOM_TYPE, runtimeRecord),
      validFeatureRecord,
      unknownFeatureRecord,
      corrupt,
    ]);
    createAgentSupervisorExtension({ features: [feature] })(recording.pi);

    await recording.emit('input', inputEvent('interactive'));
    await recording.command('status');

    expect(roots).toEqual(['root-5']);
    expect(restored).toEqual([{ count: 7 }]);
    expect(recording.branchSnapshot()).toContainEqual(unknownFeatureRecord);
    expect(recording.notifications.at(-1)?.message).toContain('Kernel health: degraded');
  });

  it('retains the valid-runtime supremum when the latest runtime record is corrupt', async () => {
    const observations: SupervisorObservation[] = [];
    const feature = statelessFeature('runtime-observer', (observation) => {
      observations.push(observation);
    });
    const firstValid = {
      schemaVersion: 1,
      kind: 'runtime',
      state: { schemaVersion: 1, nextRootRequestSequence: 3 },
    };
    const secondValid = {
      schemaVersion: 1,
      kind: 'runtime',
      state: { schemaVersion: 1, nextRootRequestSequence: 9 },
    };
    const invalidLatest = {
      schemaVersion: 1,
      kind: 'runtime',
      state: { schemaVersion: 1, nextRootRequestSequence: 0 },
    };
    const recording = new RecordingPi([
      customEntry(SUPERVISOR_STATE_CUSTOM_TYPE, firstValid),
      customEntry(SUPERVISOR_STATE_CUSTOM_TYPE, secondValid),
      customEntry(SUPERVISOR_STATE_CUSTOM_TYPE, invalidLatest),
    ]);
    createAgentSupervisorExtension({ features: [feature] })(recording.pi);

    await recording.emit('input', inputEvent('interactive'));
    await recording.command('status');

    expect(observations[0]?.rootRequestId).toBe('root-9');
    expect(recording.appendedEntries.at(-1)?.data).toEqual({
      schemaVersion: 1,
      kind: 'runtime',
      state: { schemaVersion: 1, nextRootRequestSequence: 10 },
    });
    expect(recording.notifications.at(-1)?.message).toContain('Kernel health: degraded');
  });

  it('creates applicable features in ascending id order, disposes on rebuild, and isolates failures', async () => {
    const created: string[] = [];
    const disposed: string[] = [];
    const make = (id: string, throws = false): SupervisorFeatureModule => ({
      descriptor: descriptor(id),
      create: (): SupervisorFeatureRuntime<never> => {
        created.push(id);
        if (throws) {
          throw new Error('private initialization detail');
        }
        return {
          dispose: (): void => {
            disposed.push(id);
          },
        };
      },
    });
    const config: SupervisorConfigV1 = {
      schemaVersion: 1,
      mode: 'autonomous',
      features: { 'feature-a': {}, 'feature-b': {}, 'feature-c': {} },
    };
    const recording = new RecordingPi([customEntry(SUPERVISOR_CONFIG_CUSTOM_TYPE, config)]);
    createAgentSupervisorExtension({
      features: [make('feature-c'), make('feature-a'), make('feature-b', true)],
    })(recording.pi);

    await recording.emit('session_start', sessionStartEvent());
    await recording.command('mode observe');

    expect(created).toEqual(['feature-a', 'feature-b', 'feature-c', 'feature-a', 'feature-c']);
    expect(disposed).toEqual(['feature-a', 'feature-c']);
    await recording.command('status');
    expect(recording.notifications.at(-1)?.message).toContain('feature-b');
    expect(recording.notifications.at(-1)?.message).toContain('initialization-failed');
  });

  it('quarantines observation failures and stateless nextState violations without stopping siblings', async () => {
    let failingCalls = 0;
    let siblingCalls = 0;
    const failing = statelessFeature('failing-feature', () => {
      failingCalls += 1;
      throw new Error('private observation detail');
    });
    const sibling = statelessFeature('sibling-feature', () => {
      siblingCalls += 1;
    });
    const statelessStateEmitter = statelessFeature('state-emitter', () => ({
      nextState: { private: 'state' } as never,
    }));
    const invalidStateEmitter = statefulFeature(
      'invalid-state-emitter',
      () => ({ nextState: { count: 1 } }),
      { validateState: () => { throw new Error('private next state detail'); } },
    );
    const recording = new RecordingPi();
    createAgentSupervisorExtension({
      features: [sibling, failing, statelessStateEmitter, invalidStateEmitter],
    })(recording.pi);

    await recording.emit('input', inputEvent('interactive'));
    await recording.emit('tool_call', toolCallEvent());
    await recording.command('status');

    expect(failingCalls).toBe(1);
    expect(siblingCalls).toBe(2);
    const status = recording.notifications.at(-1)?.message ?? '';
    expect(status).toContain('failing-feature');
    expect(status).toContain('quarantined');
    expect(status).toContain('state-emitter');
    expect(status).toContain('state-emission-without-codec');
    expect(status).toContain('invalid-state-emitter');
    expect(status).toContain('observation-failed');
  });

  it('restores valid state and isolates semantic config and state validation failures', async () => {
    const restored: (StatefulValue | null)[] = [];
    const valid = statefulFeature('valid-state', (_observation, context) => {
      restored.push(context.state);
    });
    const invalidConfig = statefulFeature(
      'invalid-config',
      () => undefined,
      { validateConfig: () => { throw new Error('private config detail'); } },
    );
    const invalidState = statefulFeature('invalid-state', () => undefined, {
      validateState: () => {
        throw new Error('private state detail');
      },
    });
    const stateEnvelope = (featureId: string, data: unknown): SupervisorFeatureStateEnvelope => ({
      schemaVersion: 1,
      featureId,
      featureSchemaVersion: 1,
      data: data as SupervisorFeatureStateEnvelope['data'],
    });
    const branch = [
      customEntry(SUPERVISOR_STATE_CUSTOM_TYPE, {
        schemaVersion: 1,
        kind: 'feature',
        state: stateEnvelope('valid-state', { count: 4 }),
      }),
      customEntry(SUPERVISOR_STATE_CUSTOM_TYPE, {
        schemaVersion: 1,
        kind: 'feature',
        state: stateEnvelope('invalid-state', { count: 1 }),
      }),
    ];
    const recording = new RecordingPi(branch);
    createAgentSupervisorExtension({ features: [invalidState, invalidConfig, valid] })(recording.pi);

    await recording.emit('input', inputEvent('interactive'));
    await recording.command('status');

    expect(restored).toEqual([{ count: 4 }]);
    const status = recording.notifications.at(-1)?.message ?? '';
    expect(status).toContain('invalid-config');
    expect(status).toContain('configuration-invalid');
    expect(status).toContain('invalid-state');
    expect(status).toContain('state-invalid');
  });

  it('routes arbitration winners through block, steer, and follow-up transport', async () => {
    const blocker = statelessFeature('blocker', (observation) =>
      observation.kind === 'before-tool-call'
        ? { interventions: [proposal('blocker', 'block', 'tool-call', 'blocked', 'tool-1')] }
        : undefined,
    );
    const steerer = statelessFeature('steerer', (observation) =>
      observation.kind === 'before-tool-call'
        ? { interventions: [proposal('steerer', 'steer', 'tool-call', 'steered', 'tool-1')] }
        : undefined,
    );
    const follower = statelessFeature('follower', (observation) =>
      observation.kind === 'agent-settled'
        ? { interventions: [proposal('follower', 'follow-up', 'settled', 'followed')] }
        : undefined,
    );
    const recording = new RecordingPi();
    createAgentSupervisorExtension({ features: [blocker, steerer, follower] })(recording.pi);

    await recording.emit('input', inputEvent('interactive'));
    const blocked = await recording.emit('tool_call', toolCallEvent('tool-1'));
    await recording.emit('agent_settled', { type: 'agent_settled' });

    expect(blocked).toEqual({ block: true, reason: 'blocked' });
    expect(recording.sentMessages).toEqual([
      { content: 'followed', options: { deliverAs: 'followUp' } },
    ]);
  });

  it('suppresses observe, losing, and degraded autonomous interventions', async () => {
    const observeBlocker = statelessFeature(
      'observe-blocker',
      (observation) =>
        observation.kind === 'before-tool-call'
          ? { interventions: [proposal('observe-blocker', 'block', 'tool-call', 'observed', 'tool-1')] }
          : undefined,
      { defaultMode: 'observe' },
    );
    const winner = statelessFeature('winner', (observation) =>
      observation.kind === 'before-tool-call'
        ? { interventions: [proposal('winner', 'block', 'tool-call', 'winner', 'tool-1', 2)] }
        : undefined,
    );
    const loser = statelessFeature('loser', (observation) =>
      observation.kind === 'before-tool-call'
        ? { interventions: [proposal('loser', 'block', 'tool-call', 'loser', 'tool-1')] }
        : undefined,
    );
    const invalidRuntime = {
      schemaVersion: 1,
      kind: 'runtime',
      state: { schemaVersion: 1, nextRootRequestSequence: 4 },
    };
    const corruptTail = customEntry(SUPERVISOR_STATE_CUSTOM_TYPE, {
      schemaVersion: 1,
      kind: 'runtime',
      state: { schemaVersion: 1, nextRootRequestSequence: 0 },
    });
    const healthyRecording = new RecordingPi();
    createAgentSupervisorExtension({ features: [observeBlocker, winner, loser] })(healthyRecording.pi);
    await healthyRecording.emit('input', inputEvent('interactive'));
    const healthyResult = await healthyRecording.emit('tool_call', toolCallEvent('tool-1'));
    expect(healthyResult).toEqual({ block: true, reason: 'winner' });

    const degradedRecording = new RecordingPi([
      customEntry(SUPERVISOR_STATE_CUSTOM_TYPE, invalidRuntime),
      corruptTail,
    ]);
    createAgentSupervisorExtension({ features: [winner] })(degradedRecording.pi);
    await degradedRecording.emit('input', inputEvent('interactive'));
    const degradedResult = await degradedRecording.emit('tool_call', toolCallEvent('tool-1'));
    expect(degradedResult).toBeUndefined();
    expect(degradedRecording.sentMessages).toHaveLength(0);
  });

  it('keeps facts ephemeral, private, and isolated within one dispatch', async () => {
    const seenBySibling: number[] = [];
    const first = statelessFeature('feature-a', (observation) =>
      observation.kind === 'root-request-started' ? { facts: [fact('feature-a')] } : undefined,
    );
    const second = statelessFeature('feature-b', (observation, context) => {
      if (observation.kind === 'root-request-started' || observation.kind === 'before-tool-call') {
        seenBySibling.push(context.facts.all().length);
      }
    });
    const recording = new RecordingPi();
    createAgentSupervisorExtension({ features: [second, first] })(recording.pi);

    await recording.emit('input', inputEvent('interactive', 'private prompt'));
    await recording.emit('tool_call', toolCallEvent('tool-1', { secret: 'private input' }));
    await recording.emit('agent_settled', { type: 'agent_settled' });
    await recording.command('status');

    expect(seenBySibling).toEqual([0, 1]);
    const persisted = recording.appendedEntries
      .filter((entry) => entry.customType === SUPERVISOR_STATE_CUSTOM_TYPE)
      .map((entry) => JSON.stringify(entry.data))
      .join('\n');
    expect(persisted).not.toContain('private prompt');
    expect(persisted).not.toContain('private input');
    expect(persisted).not.toContain('private result content');
    expect(persisted).not.toContain('private stdout');
    expect(persisted).not.toContain('private assistant response');
  });
});
