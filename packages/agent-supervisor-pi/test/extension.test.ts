import { describe, expect, it, vi } from 'vitest';
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
import { SupervisorKernel } from '../src/kernel/kernel.js';
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

  public appendFailuresRemaining = 0;
  public appendStateBeforeFailure = false;

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
        if (this.appendFailuresRemaining > 0) {
          this.appendFailuresRemaining -= 1;
          if (customType === SUPERVISOR_STATE_CUSTOM_TYPE && this.appendStateBeforeFailure) {
            this.branch.push(customEntry(customType, data));
          }
          throw new Error('private append failure');
        }
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

function runtimeEntry(nextRootRequestSequence: number): SessionEntry {
  return customEntry(SUPERVISOR_STATE_CUSTOM_TYPE, {
    schemaVersion: 1,
    kind: 'runtime',
    state: { schemaVersion: 1, nextRootRequestSequence },
  });
}

function invalidRuntimeEntry(): SessionEntry {
  return runtimeEntry(0);
}

function featureEntry(featureId: string, data: JsonValue): SessionEntry {
  return customEntry(SUPERVISOR_STATE_CUSTOM_TYPE, {
    schemaVersion: 1,
    kind: 'feature',
    state: { schemaVersion: 1, featureId, featureSchemaVersion: 1, data },
  });
}

function invalidFeatureEntry(featureId: string): SessionEntry {
  return customEntry(SUPERVISOR_STATE_CUSTOM_TYPE, {
    schemaVersion: 1,
    kind: 'feature',
    state: { schemaVersion: 1, featureId, featureSchemaVersion: 1, data: undefined },
  });
}

function unclassifiableEntry(): SessionEntry {
  return customEntry(SUPERVISOR_STATE_CUSTOM_TYPE, {
    schemaVersion: 1,
    kind: 'garbled',
    state: {},
  });
}

interface KernelRuntimeInternals {
  readonly nextRootRequestSequence: number;
}

function readNextRootRequestSequence(kernel: SupervisorKernel): number {
  return (kernel as unknown as KernelRuntimeInternals).nextRootRequestSequence;
}

interface RuntimeRecordForTest {
  readonly state: { readonly nextRootRequestSequence: number };
}

function runtimeSequence(data: unknown): number {
  return (data as RuntimeRecordForTest).state.nextRootRequestSequence;
}

function runtimeSequences(entries: readonly SessionEntry[]): number[] {
  return entries.flatMap((entry) => {
    if (entry.type !== 'custom' || entry.customType !== SUPERVISOR_STATE_CUSTOM_TYPE) {
      return [];
    }
    const entryData = entry.data as { readonly kind?: unknown };
    return entryData.kind === 'runtime' ? [runtimeSequence(entryData)] : [];
  });
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

  it('reserves a root before publishing it or dispatching root-started', async () => {
    const trace: string[] = [];
    const recording = new RecordingPi([runtimeEntry(7)]);
    const kernelRef: { current?: SupervisorKernel } = {};
    const getKernel = (): SupervisorKernel => {
      const currentKernel = kernelRef.current;
      if (currentKernel === undefined) {
        throw new Error('Kernel was not initialized.');
      }
      return currentKernel;
    };
    const rootObserver = vi.fn((observation: SupervisorObservation): void => {
      if (observation.kind === 'root-request-started') {
        const currentKernel = getKernel();
        trace.push(
          `candidate root observable: ${observation.rootRequestId}; currentRoot=${currentKernel.getCurrentRoot()?.id ?? 'null'}; next=${readNextRootRequestSequence(currentKernel)}`,
        );
      }
    });
    const rootDispatch = vi.fn((observation: SupervisorObservation): void => {
      if (observation.kind === 'root-request-started') {
        trace.push(`root-start dispatch: ${observation.rootRequestId}`);
      }
    });
    const rootObserverFeature = statelessFeature('root-observer', rootObserver);
    const rootDispatchFeature = statelessFeature('root-start-dispatch', rootDispatch);
    const kernel = new SupervisorKernel(recording.pi, [rootObserverFeature, rootDispatchFeature]);
    kernelRef.current = kernel;
    kernel.register();

    const appendImplementation = recording.pi.appendEntry;
    const appendSpy = vi.spyOn(recording.pi, 'appendEntry').mockImplementation((customType, data) => {
      if (customType === SUPERVISOR_STATE_CUSTOM_TYPE) {
        const currentKernel = getKernel();
        trace.push(
          `persist call: candidate next=${runtimeSequence(data)}; currentRoot=${currentKernel.getCurrentRoot()?.id ?? 'null'}; next=${readNextRootRequestSequence(currentKernel)}`,
        );
        appendImplementation(customType, data);
        trace.push(
          `persist result: accepted; currentRoot=${currentKernel.getCurrentRoot()?.id ?? 'null'}; next=${readNextRootRequestSequence(currentKernel)}`,
        );
        return;
      }
      appendImplementation(customType, data);
    });

    const result = await recording.emit('input', inputEvent('interactive'));

    expect(result).toEqual({ action: 'continue' });
    expect(trace).toEqual([
      'persist call: candidate next=8; currentRoot=null; next=7',
      'persist result: accepted; currentRoot=null; next=7',
      'candidate root observable: root-7; currentRoot=root-7; next=8',
      'root-start dispatch: root-7',
    ]);
    expect(appendSpy.mock.invocationCallOrder[0]!).toBeLessThan(rootObserver.mock.invocationCallOrder[0]!);
    expect(rootObserver.mock.invocationCallOrder[0]!).toBeLessThan(rootDispatch.mock.invocationCallOrder[0]!);
  });

  it('publishes no root when root reservation persistence fails', async () => {
    const onObservation = vi.fn((): void => undefined);
    const recording = new RecordingPi([runtimeEntry(7)]);
    recording.appendFailuresRemaining = 1;
    const kernel = new SupervisorKernel(recording.pi, [statelessFeature('root-observer', onObservation)]);
    kernel.register();

    const result = await recording.emit('input', inputEvent('interactive'));
    const extensionResult = await recording.emit('input', inputEvent('extension'));

    expect(result).toEqual({ action: 'continue' });
    expect(extensionResult).toEqual({ action: 'continue' });
    expect(kernel.getCurrentRoot()).toBeNull();
    expect(onObservation).not.toHaveBeenCalled();
    expect(recording.appendedEntries).toHaveLength(0);
    expect(kernel.getHealth()).toBe('degraded');
  });

  it('does not consume the root sequence when reservation fails', async () => {
    const recording = new RecordingPi([runtimeEntry(7)]);
    recording.appendFailuresRemaining = 1;
    const kernel = new SupervisorKernel(recording.pi, []);
    kernel.register();

    const result = await recording.emit('input', inputEvent('interactive'));

    expect(result).toEqual({ action: 'continue' });
    expect(readNextRootRequestSequence(kernel)).toBe(7);
    expect(kernel.getHealth()).toBe('degraded');
  });

  it('retries the same root after a transient reservation failure', async () => {
    const roots: string[] = [];
    const feature = statelessFeature('root-observer', (observation) => {
      if (observation.kind === 'root-request-started' && observation.rootRequestId !== null) {
        roots.push(observation.rootRequestId);
      }
    });
    const recording = new RecordingPi([runtimeEntry(7)]);
    recording.appendFailuresRemaining = 1;
    const kernel = new SupervisorKernel(recording.pi, [feature]);
    kernel.register();

    const firstResult = await recording.emit('input', inputEvent('interactive'));
    const secondResult = await recording.emit('input', inputEvent('interactive'));

    expect(firstResult).toEqual({ action: 'continue' });
    expect(secondResult).toEqual({ action: 'continue' });
    expect(roots).toEqual(['root-7']);
    expect(kernel.getCurrentRoot()).toEqual({ id: 'root-7', status: 'active' });
    expect(readNextRootRequestSequence(kernel)).toBe(8);
    expect(recording.appendedEntries).toHaveLength(1);
    expect(recording.appendedEntries[0]?.data).toEqual({
      schemaVersion: 1,
      kind: 'runtime',
      state: { schemaVersion: 1, nextRootRequestSequence: 8 },
    });
    expect(kernel.getHealth()).toBe('degraded');
  });

  it('isolates a failed new allocation from the previous root', async () => {
    const trace: string[] = [];
    const onObservation = vi.fn((observation: SupervisorObservation): void => {
      if (observation.kind === 'root-request-started') {
        trace.push(`root-start dispatch: ${observation.rootRequestId}`);
      } else if (observation.kind === 'agent-settled') {
        trace.push(`settled dispatch: ${observation.rootRequestId}`);
      } else if (observation.kind === 'before-tool-call') {
        trace.push(`tool observation: ${observation.rootRequestId}`);
      }
    });
    const recording = new RecordingPi([runtimeEntry(1)]);
    const kernel = new SupervisorKernel(recording.pi, [statelessFeature('root-observer', onObservation)]);
    kernel.register();
    const appendImplementation = recording.pi.appendEntry;
    const appendSpy = vi.spyOn(recording.pi, 'appendEntry').mockImplementation((customType, data) => {
      if (customType === SUPERVISOR_STATE_CUSTOM_TYPE) {
        trace.push(`persist call: candidate next=${runtimeSequence(data)}`);
        try {
          appendImplementation(customType, data);
          trace.push('persist result: accepted');
        } catch (error) {
          trace.push('persist result: rejected');
          throw error;
        }
        return;
      }
      appendImplementation(customType, data);
    });

    await recording.emit('input', inputEvent('interactive'));
    await recording.emit('agent_settled', { type: 'agent_settled' });
    recording.appendFailuresRemaining = 1;
    const failedResult = await recording.emit('input', inputEvent('interactive'));
    trace.push(`after failed allocation: currentRoot=${kernel.getCurrentRoot()?.id ?? 'null'}`);
    await recording.emit('tool_call', toolCallEvent());

    expect(failedResult).toEqual({ action: 'continue' });
    expect(kernel.getCurrentRoot()).toBeNull();
    expect(kernel.getHealth()).toBe('degraded');
    expect(onObservation.mock.calls.map(([observation]) => [observation.kind, observation.rootRequestId])).toEqual([
      ['root-request-started', 'root-1'],
      ['agent-settled', 'root-1'],
      ['before-tool-call', null],
    ]);
    expect(appendSpy.mock.invocationCallOrder.length).toBe(2);
    expect(trace).toEqual([
      'persist call: candidate next=2',
      'persist result: accepted',
      'root-start dispatch: root-1',
      'settled dispatch: root-1',
      'persist call: candidate next=3',
      'persist result: rejected',
      'after failed allocation: currentRoot=null',
      'tool observation: null',
    ]);
  });

  it('clears root-local facts when a new root allocation fails', async () => {
    const toolFactCounts: number[] = [];
    const feature = statelessFeature('fact-owner', (observation, context) => {
      if (observation.kind === 'root-request-started') {
        return { facts: [fact('fact-owner')] };
      }
      if (observation.kind === 'before-tool-call') {
        toolFactCounts.push(context.facts.all().length);
      }
      return undefined;
    });
    const recording = new RecordingPi([runtimeEntry(1)]);
    const kernel = new SupervisorKernel(recording.pi, [feature]);
    kernel.register();

    await recording.emit('input', inputEvent('interactive'));
    expect(kernel.getFacts()).toHaveLength(1);
    recording.appendFailuresRemaining = 1;
    const failedResult = await recording.emit('input', inputEvent('interactive'));
    expect(failedResult).toEqual({ action: 'continue' });
    expect(kernel.getCurrentRoot()).toBeNull();
    expect(kernel.getFacts()).toHaveLength(0);
    await recording.emit('tool_call', toolCallEvent());

    expect(toolFactCounts).toEqual([0]);
    expect(kernel.getHealth()).toBe('degraded');
  });

  it('clears root tracking when the root sequence overflows', async () => {
    const observations: SupervisorObservation[] = [];
    const feature = statelessFeature('root-observer', (observation) => {
      observations.push(observation);
    });
    const previousRootSequence = Number.MAX_SAFE_INTEGER - 1;
    // The max-1 persisted seed permits a successful previous root; its accepted reservation records max for the overflow attempt.
    const recording = new RecordingPi([runtimeEntry(previousRootSequence)]);
    const kernel = new SupervisorKernel(recording.pi, [feature]);
    kernel.register();

    const firstResult = await recording.emit('input', inputEvent('interactive'));
    expect(firstResult).toEqual({ action: 'continue' });
    expect(kernel.getCurrentRoot()).toEqual({
      id: `root-${previousRootSequence}`,
      status: 'active',
    });
    expect(readNextRootRequestSequence(kernel)).toBe(Number.MAX_SAFE_INTEGER);

    const overflowResult = await recording.emit('input', inputEvent('interactive'));
    expect(overflowResult).toEqual({ action: 'continue' });
    expect(kernel.getCurrentRoot()).toBeNull();
    expect(kernel.getHealth()).toBe('degraded');

    await recording.emit('tool_call', toolCallEvent());

    expect(observations.map((observation) => [observation.kind, observation.rootRequestId])).toEqual([
      ['root-request-started', `root-${previousRootSequence}`],
      ['before-tool-call', null],
    ]);
    expect(runtimeSequences(recording.branchSnapshot())).toEqual([
      previousRootSequence,
      Number.MAX_SAFE_INTEGER,
    ]);
    expect(
      recording.appendedEntries
        .filter((entry) => entry.customType === SUPERVISOR_STATE_CUSTOM_TYPE)
        .map((entry) => runtimeSequence(entry.data)),
    ).toEqual([Number.MAX_SAFE_INTEGER]);
  });

  it('skips a failed reservation remnant after reload instead of reusing its root', async () => {
    const roots: string[] = [];
    const feature = statelessFeature('root-observer', (observation) => {
      if (observation.kind === 'root-request-started' && observation.rootRequestId !== null) {
        roots.push(observation.rootRequestId);
      }
    });
    const recording = new RecordingPi([runtimeEntry(7)]);
    const kernel = new SupervisorKernel(recording.pi, [feature]);
    kernel.register();

    await recording.emit('input', inputEvent('interactive'));
    expect(kernel.getCurrentRoot()).toEqual({ id: 'root-7', status: 'active' });
    expect(readNextRootRequestSequence(kernel)).toBe(8);

    recording.appendStateBeforeFailure = true;
    recording.appendFailuresRemaining = 1;
    const failedResult = await recording.emit('input', inputEvent('interactive'));

    expect(failedResult).toEqual({ action: 'continue' });
    expect(kernel.getCurrentRoot()).toBeNull();
    expect(readNextRootRequestSequence(kernel)).toBe(8);
    expect(kernel.getHealth()).toBe('degraded');
    expect(roots).toEqual(['root-7']);
    expect(runtimeSequences(recording.branchSnapshot())).toEqual([7, 8, 9]);

    await recording.emit('session_start', sessionStartEvent());

    // Reload lands on 9, not 8: the remnant may accompany an issued root-8, so skipping it is safe and never reuses a possibly issued ID.
    expect(readNextRootRequestSequence(kernel)).toBe(9);

    const nextResult = await recording.emit('input', inputEvent('interactive'));
    expect(nextResult).toEqual({ action: 'continue' });
    expect(roots).toEqual(['root-7', 'root-9']);
    expect(kernel.getCurrentRoot()).toEqual({ id: 'root-9', status: 'active' });
    expect(readNextRootRequestSequence(kernel)).toBe(10);
    expect(runtimeSequences(recording.branchSnapshot())).toEqual([7, 8, 9, 10]);
  });

  it('passes the recovered sequence explicitly to runtime persistence', async () => {
    const recording = new RecordingPi([runtimeEntry(2), invalidRuntimeEntry()]);
    const kernel = new SupervisorKernel(recording.pi, []);
    kernel.register();
    const persistRuntimeSequence = vi.spyOn(
      kernel as unknown as { persistRuntimeSequence: (nextSequence: number) => boolean },
      'persistRuntimeSequence',
    );

    await recording.command('status');

    expect(persistRuntimeSequence).toHaveBeenCalledTimes(1);
    expect(persistRuntimeSequence).toHaveBeenCalledWith(3);
    expect(readNextRootRequestSequence(kernel)).toBe(3);
    expect(recording.appendedEntries[0]?.data).toEqual({
      schemaVersion: 1,
      kind: 'runtime',
      state: { schemaVersion: 1, nextRootRequestSequence: 3 },
    });
  });

  it('persists root-derived feature state after the runtime reservation', async () => {
    const feature = statefulFeature('stateful-feature', (observation) =>
      observation.kind === 'root-request-started' ? { nextState: { count: 1 } } : undefined,
    );
    const recording = new RecordingPi([runtimeEntry(7)]);
    const kernel = new SupervisorKernel(recording.pi, [feature]);
    kernel.register();
    const appendSpy = vi.spyOn(recording.pi, 'appendEntry');

    await recording.emit('input', inputEvent('interactive'));

    const runtimeIndex = appendSpy.mock.calls.findIndex((call) => {
      const data = call[1] as { readonly kind?: unknown };
      return call[0] === SUPERVISOR_STATE_CUSTOM_TYPE && data.kind === 'runtime';
    });
    const featureIndex = appendSpy.mock.calls.findIndex((call) => {
      const data = call[1] as { readonly kind?: unknown };
      return call[0] === SUPERVISOR_STATE_CUSTOM_TYPE && data.kind === 'feature';
    });
    expect(runtimeIndex).toBe(0);
    expect(featureIndex).toBe(1);
    expect(appendSpy.mock.invocationCallOrder[runtimeIndex]!).toBeLessThan(
      appendSpy.mock.invocationCallOrder[featureIndex]!,
    );
    expect(recording.appendedEntries.map((entry) => (entry.data as { readonly kind: string }).kind)).toEqual([
      'runtime',
      'feature',
    ]);
    expect(recording.appendedEntries[0]?.data).toEqual({
      schemaVersion: 1,
      kind: 'runtime',
      state: { schemaVersion: 1, nextRootRequestSequence: 8 },
    });
    expect(recording.appendedEntries[1]?.data).toEqual({
      schemaVersion: 1,
      kind: 'feature',
      state: { schemaVersion: 1, featureId: 'stateful-feature', featureSchemaVersion: 1, data: { count: 1 } },
    });
    expect(kernel.getCurrentRoot()).toEqual({ id: 'root-7', status: 'active' });
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

  it('isolates a feature with a corrupt recoverable state id without degrading the kernel', async () => {
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
    expect(status).toContain('Kernel health: healthy');
    expect(status).toContain('corrupt-state');
    expect(status).toContain('state-invalid');
    expect(status).toContain('healthy-sibling');
    expect(status).toContain('status=active');
  });

  it('keeps registered features available when a corrupt state id is unrecoverable', async () => {
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
    expect(status).toContain('Kernel health: healthy');
    expect(status).toContain('feature-a');
    expect(status).toContain('feature-b');
    expect(status.match(/status=active/gu)).toHaveLength(2);
  });

  it('honors valid state and recovers past an unclassifiable state while preserving unknown state', async () => {
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

    expect(roots).toEqual(['root-6']);
    expect(restored).toEqual([{ count: 7 }]);
    expect(recording.branchSnapshot()).toContainEqual(unknownFeatureRecord);
    expect(recording.notifications.at(-1)?.message).toContain('Kernel health: healthy');
  });

  it('uses the latest valid runtime record and ignores superseded invalid runtime state', async () => {
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
      customEntry(SUPERVISOR_STATE_CUSTOM_TYPE, invalidLatest),
      customEntry(SUPERVISOR_STATE_CUSTOM_TYPE, secondValid),
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
    expect(recording.appendedEntries).toHaveLength(1);
    expect(recording.notifications.at(-1)?.message).toContain('Kernel health: healthy');
    expect(recording.notifications.at(-1)?.message).toContain('Runtime state: normal');
  });

  it('uses the latest valid feature state after an older invalid record', async () => {
    const restored: (StatefulValue | null)[] = [];
    const feature = statefulFeature('feature-a', (_observation, context) => {
      restored.push(context.state);
    });
    const recording = new RecordingPi([
      invalidFeatureEntry('feature-a'),
      featureEntry('feature-a', { count: 7 }),
    ]);
    createAgentSupervisorExtension({ features: [feature] })(recording.pi);

    await recording.emit('input', inputEvent('interactive'));
    await recording.command('status');

    expect(restored).toEqual([{ count: 7 }]);
    const status = recording.notifications.at(-1)?.message ?? '';
    expect(status).toContain('Kernel health: healthy');
    expect(status).toContain('feature-a');
    expect(status).toContain('status=active');
    expect(status).not.toContain('state-invalid');
  });

  it('lets a newer invalid feature state supersede an older valid state', async () => {
    let calls = 0;
    const feature = statefulFeature('feature-a', () => {
      calls += 1;
    });
    const recording = new RecordingPi([
      featureEntry('feature-a', { count: 7 }),
      invalidFeatureEntry('feature-a'),
    ]);
    createAgentSupervisorExtension({ features: [feature] })(recording.pi);

    await recording.emit('input', inputEvent('interactive'));
    await recording.command('status');

    expect(calls).toBe(0);
    const status = recording.notifications.at(-1)?.message ?? '';
    expect(status).toContain('Kernel health: healthy');
    expect(status).toContain('runtime=unavailable');
    expect(status).toContain('status=unavailable reason=state-invalid');
  });

  it('keeps an eligible sibling autonomous when the latest state for another feature is invalid', async () => {
    const invalidFeature = statelessFeature('feature-a', () => undefined);
    const winner = statelessFeature('feature-b', (observation) =>
      observation.kind === 'before-tool-call'
        ? { interventions: [proposal('feature-b', 'block', 'tool-call', 'feature-b won', 'tool-1')] }
        : undefined,
    );
    const recording = new RecordingPi([invalidFeatureEntry('feature-a')]);
    createAgentSupervisorExtension({ features: [invalidFeature, winner] })(recording.pi);

    await recording.emit('input', inputEvent('interactive'));
    const result = await recording.emit('tool_call', toolCallEvent('tool-1'));
    await recording.command('status');

    expect(result).toEqual({ block: true, reason: 'feature-b won' });
    const status = recording.notifications.at(-1)?.message ?? '';
    expect(status).toContain('Kernel health: healthy');
    expect(status).toContain('feature-a');
    expect(status).toContain('feature-b');
    expect(status).toContain('feature-b: maturity=default');
    expect(status.match(/status=active/gu)).toHaveLength(1);
    expect(status).toContain('state-invalid');
  });

  it('retains invalid state diagnostics for an unregistered feature without harming a registered sibling', async () => {
    let siblingCalls = 0;
    const sibling = statelessFeature('feature-b', () => {
      siblingCalls += 1;
    });
    const recording = new RecordingPi([
      invalidFeatureEntry('future-feature'),
      runtimeEntry(5),
    ]);
    createAgentSupervisorExtension({ features: [sibling] })(recording.pi);

    await recording.emit('input', inputEvent('interactive'));
    await recording.command('status');

    expect(siblingCalls).toBe(1);
    const status = recording.notifications.at(-1)?.message ?? '';
    expect(status).toContain('Kernel health: healthy');
    expect(status).toContain('Invalid persisted feature state: future-feature (state-invalid)');
    expect(status).toContain('feature-b');
    expect(status).toContain('status=active');
  });

  it('recovers one invalid runtime tail and skips the root it may represent', async () => {
    const roots: (string | null)[] = [];
    const feature = statelessFeature('runtime-observer', (observation) => {
      roots.push(observation.rootRequestId);
    });
    const recording = new RecordingPi([runtimeEntry(2), invalidRuntimeEntry()]);
    createAgentSupervisorExtension({ features: [feature] })(recording.pi);

    await recording.command('status');
    expect(recording.appendedEntries[0]?.data).toEqual({
      schemaVersion: 1,
      kind: 'runtime',
      state: { schemaVersion: 1, nextRootRequestSequence: 3 },
    });
    expect(recording.notifications.at(-1)?.message).toContain(
      'Runtime state: recovered (next root request sequence: 3)',
    );

    await recording.emit('input', inputEvent('interactive'));
    await recording.command('status');

    expect(roots).toEqual(['root-3']);
    expect(recording.appendedEntries.map((entry) => entry.data)).toEqual([
      {
        schemaVersion: 1,
        kind: 'runtime',
        state: { schemaVersion: 1, nextRootRequestSequence: 3 },
      },
      {
        schemaVersion: 1,
        kind: 'runtime',
        state: { schemaVersion: 1, nextRootRequestSequence: 4 },
      },
    ]);
    expect(recording.notifications.at(-1)?.message).toContain('Kernel health: healthy');
  });

  it('recovers two invalid runtime tails and skips both potentially issued roots', async () => {
    const roots: (string | null)[] = [];
    const feature = statelessFeature('runtime-observer', (observation) => {
      roots.push(observation.rootRequestId);
    });
    const recording = new RecordingPi([
      runtimeEntry(2),
      invalidRuntimeEntry(),
      invalidRuntimeEntry(),
    ]);
    createAgentSupervisorExtension({ features: [feature] })(recording.pi);

    await recording.command('status');
    expect(recording.appendedEntries[0]?.data).toEqual({
      schemaVersion: 1,
      kind: 'runtime',
      state: { schemaVersion: 1, nextRootRequestSequence: 4 },
    });

    await recording.emit('input', inputEvent('interactive'));

    expect(roots).toEqual(['root-4']);
    expect(recording.appendedEntries[1]?.data).toEqual({
      schemaVersion: 1,
      kind: 'runtime',
      state: { schemaVersion: 1, nextRootRequestSequence: 5 },
    });
  });

  it('recovers deterministically from malformed history with no valid runtime record', async () => {
    const roots: (string | null)[] = [];
    const feature = statelessFeature('runtime-observer', (observation) => {
      roots.push(observation.rootRequestId);
    });
    const recording = new RecordingPi([invalidRuntimeEntry(), unclassifiableEntry()]);
    createAgentSupervisorExtension({ features: [feature] })(recording.pi);

    await recording.command('status');
    expect(recording.appendedEntries[0]?.data).toEqual({
      schemaVersion: 1,
      kind: 'runtime',
      state: { schemaVersion: 1, nextRootRequestSequence: 3 },
    });

    await recording.emit('input', inputEvent('interactive'));

    expect(roots).toEqual(['root-3']);
    expect(recording.appendedEntries[1]?.data).toEqual({
      schemaVersion: 1,
      kind: 'runtime',
      state: { schemaVersion: 1, nextRootRequestSequence: 4 },
    });
  });

  it('does not append another recovery record when the recovered runtime state is durable', async () => {
    const recording = new RecordingPi([runtimeEntry(2), invalidRuntimeEntry()]);
    createAgentSupervisorExtension({ features: [] })(recording.pi);

    await recording.command('status');
    expect(recording.appendedEntries).toHaveLength(1);
    await recording.emit('session_start', sessionStartEvent());
    await recording.command('status');

    expect(recording.appendedEntries).toHaveLength(1);
    expect(recording.notifications.at(-1)?.message).toContain('Kernel health: healthy');
    expect(recording.notifications.at(-1)?.message).toContain('Runtime state: normal');
  });

  it('degrades on recovery append failure, continues the agent, and suppresses autonomous execution', async () => {
    const winner = statelessFeature('winner', (observation) =>
      observation.kind === 'before-tool-call'
        ? { interventions: [proposal('winner', 'block', 'tool-call', 'must not run', 'tool-1')] }
        : undefined,
    );
    const recording = new RecordingPi([invalidRuntimeEntry()]);
    recording.appendFailuresRemaining = 1;
    createAgentSupervisorExtension({ features: [winner] })(recording.pi);

    await recording.command('status');
    const inputResult = await recording.emit('input', inputEvent('interactive'));
    const toolResult = await recording.emit('tool_call', toolCallEvent('tool-1'));
    await recording.command('status');

    expect(inputResult).toEqual({ action: 'continue' });
    expect(toolResult).toBeUndefined();
    expect(recording.sentMessages).toHaveLength(0);
    expect(recording.notifications.at(-1)?.message).toContain('Kernel health: degraded');
    expect(recording.notifications.at(-1)?.message).toContain('Runtime state: recovery failed');
  });

  it('leaves a healthy runtime sequence unchanged until normal root creation', async () => {
    const roots: (string | null)[] = [];
    const feature = statelessFeature('runtime-observer', (observation) => {
      roots.push(observation.rootRequestId);
    });
    const recording = new RecordingPi([runtimeEntry(7)]);
    createAgentSupervisorExtension({ features: [feature] })(recording.pi);

    await recording.emit('input', inputEvent('interactive'));
    await recording.command('status');

    expect(roots).toEqual(['root-7']);
    expect(recording.appendedEntries).toHaveLength(1);
    expect(recording.appendedEntries[0]?.data).toEqual({
      schemaVersion: 1,
      kind: 'runtime',
      state: { schemaVersion: 1, nextRootRequestSequence: 8 },
    });
    expect(recording.notifications.at(-1)?.message).toContain('Kernel health: healthy');
    expect(recording.notifications.at(-1)?.message).toContain('Runtime state: normal');
    expect(recording.notifications.at(-1)?.message).not.toContain('Runtime state: recovered');
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
    degradedRecording.appendFailuresRemaining = 1;
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
