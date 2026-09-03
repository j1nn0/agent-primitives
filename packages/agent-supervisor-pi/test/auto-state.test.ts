import { describe, expect, it } from 'vitest';
import { restoreAgentState } from '@j1nn0/agent-state';
import type { AgentStateSnapshot } from '@j1nn0/agent-state';
import type {
  AgentSettledEvent,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  SessionEntry,
  TurnEndEvent,
} from '@earendil-works/pi-coding-agent';
import { computeSupervisorJsonDigest } from '../src/digest.js';
import { createSupervisorFactRecord, createSupervisorFactSnapshot } from '../src/fact.js';
import type { SupervisorFactRecord } from '../src/fact.js';
import {
  AUTO_STATE_MAX_DECISIONS,
  AUTO_STATE_MAX_WORK_ITEMS,
  createAutoState,
} from '../src/features/auto-state.js';
import type { AutoStateFeatureState } from '../src/features/auto-state.js';
import { SupervisorKernel } from '../src/kernel/kernel.js';
import { validateSupervisorFeatureModule } from '../src/module.js';
import type {
  SupervisorFeatureEmission,
  SupervisorFeatureRuntimeContext,
} from '../src/module.js';
import type { SupervisorObservation } from '../src/observation.js';

const TASK_TEXT =
  'Fix the login redirect so users land on the dashboard. The dashboard must show recent activity.';
const OBJECTIVE_QUOTE = 'Fix the login redirect so users land on the dashboard.';
const WORK_QUOTE = 'users land on the dashboard';
const TASK_DECISION_QUOTE = 'The dashboard must show recent activity.';
const FINAL_TEXT = 'The fix is implemented and the dashboard shows recent activity.';
const ASSISTANT_DECISION_QUOTE = 'The fix is implemented';

function workId(quote: string): string {
  const digest = computeSupervisorJsonDigest(quote);
  if (digest === null) {
    throw new Error('Digest failed for a string quote.');
  }
  return `auto:work:${digest.slice(0, 12)}`;
}

function decisionId(quote: string): string {
  const digest = computeSupervisorJsonDigest(quote);
  if (digest === null) {
    throw new Error('Digest failed for a string quote.');
  }
  return `auto:decision:${digest.slice(0, 12)}`;
}

type AvailableStateInput = {
  readonly objective?: string;
  readonly workItems?: readonly { readonly quote: string; readonly status: string }[];
  readonly decisions?: readonly { readonly source: string; readonly quote: string }[];
};

type StateDomainInput = { readonly available: false } | ({ readonly available: true } & AvailableStateInput);

function toFactStateDomain(input: AvailableStateInput): Record<string, unknown> {
  const inner: Record<string, unknown> = {};
  if (input.objective !== undefined) {
    inner.objective = { quote: input.objective };
  }
  if (input.workItems !== undefined) {
    inner.workItems = input.workItems;
  }
  if (input.decisions !== undefined) {
    inner.decisions = input.decisions;
  }
  return { available: true, state: inner };
}

function autoStateFact(
  options: {
    readonly sequence?: number;
    readonly assessmentId?: string;
    readonly runSequence?: number;
    readonly rootRequestId?: string;
    readonly state?: StateDomainInput | undefined;
    readonly omitStateKey?: boolean;
  } = {},
): SupervisorFactRecord {
  const rootRequestId = options.rootRequestId ?? 'root-1';
  const stateData: Record<string, unknown> = {};
  if (options.omitStateKey !== true) {
    if (options.state === undefined) {
      stateData.state = toFactStateDomain({
        objective: OBJECTIVE_QUOTE,
        workItems: [{ quote: WORK_QUOTE, status: 'open' }],
        decisions: [{ source: 'assistant', quote: ASSISTANT_DECISION_QUOTE }],
      });
    } else if (!options.state.available) {
      stateData.state = { available: false };
    } else {
      stateData.state = toFactStateDomain(options.state);
    }
  }
  return createSupervisorFactRecord({
    candidate: {
      kind: 'kernel:completion-assessment',
      evidenceRefs: [],
      data: {
        assessmentId: options.assessmentId ?? 'assessment-1',
        rootRequestId,
        runSequence: options.runSequence ?? 1,
        mutationEpoch: 0,
        claims: [],
        evidence: [],
        ...stateData,
      },
    },
    sourceFeatureId: 'kernel',
    rootRequestId,
    sequence: options.sequence ?? 0,
  });
}

function readyObservation(
  payload: { readonly assessmentId: string; readonly runSequence: number } = {
    assessmentId: 'assessment-1',
    runSequence: 1,
  },
): SupervisorObservation {
  return {
    schemaVersion: 1,
    id: 'observation-ready',
    sequence: 1,
    rootRequestId: 'root-1',
    kind: 'assessment-ready',
    payload,
  };
}

function directAutoStateEmission(
  facts: readonly SupervisorFactRecord[],
  options: {
    readonly state?: AutoStateFeatureState | null;
    readonly mode?: 'autonomous' | 'observe';
    readonly payload?: { readonly assessmentId: string; readonly runSequence: number };
  } = {},
): SupervisorFeatureEmission<AutoStateFeatureState> | undefined {
  const mode = options.mode ?? 'autonomous';
  const persisted = options.state === undefined ? null : options.state;
  const runtime = createAutoState().create({
    featureId: 'auto-state',
    config: null,
    initialState: persisted,
    effectiveMode: mode,
  });
  if (runtime.onObservation === undefined) {
    throw new Error('Auto-state did not create an observation runtime.');
  }
  const context: SupervisorFeatureRuntimeContext<AutoStateFeatureState> = {
    featureId: 'auto-state',
    effectiveMode: mode,
    facts: createSupervisorFactSnapshot(facts),
    state: persisted,
  };
  return runtime.onObservation(readyObservation(options.payload), context) as
    | SupervisorFeatureEmission<AutoStateFeatureState>
    | undefined;
}

function verdictData(emission: SupervisorFeatureEmission<AutoStateFeatureState> | undefined): Record<string, unknown> {
  const fact = emission?.facts?.[0];
  if (fact === undefined || fact.kind !== 'auto-state:verdict') {
    throw new Error('Expected an auto-state:verdict fact.');
  }
  return fact.data as Record<string, unknown>;
}

type EventHandler = (event: unknown, context: ExtensionContext) => Promise<unknown> | unknown;
type CompletionHandler = (model: unknown, context: unknown, options: unknown) => Promise<unknown>;
type CommandHandler = (args: string, context: ExtensionContext) => Promise<void>;

class RecordingPi {
  public readonly handlers = new Map<string, EventHandler>();
  public readonly commands = new Map<string, CommandHandler>();
  public readonly branch: SessionEntry[] = [];
  public readonly model = { reasoning: false, thinkingLevelMap: {} };
  public completionHandler: CompletionHandler = async () => assessmentResponseWithState({});
  public readonly pi: ExtensionAPI;

  public constructor() {
    this.pi = {
      on: (type: string, handler: unknown): void => {
        this.handlers.set(type, handler as EventHandler);
      },
      registerCommand: (name: string, options: { handler: CommandHandler }): void => {
        this.commands.set(name, options.handler);
      },
      appendEntry: (customType: string, data?: unknown): void => {
        this.branch.push({
          type: 'custom',
          id: `entry-${this.branch.length}`,
          parentId: null,
          timestamp: '1970-01-01T00:00:00.000Z',
          customType,
          data,
        } as SessionEntry);
      },
      sendUserMessage: (): void => undefined,
      getAllTools: (): readonly unknown[] => [],
    } as unknown as ExtensionAPI;
  }

  public context(): ExtensionContext {
    return {
      model: this.model,
      modelRegistry: {
        complete: (model: unknown, context: unknown, options: unknown): Promise<unknown> =>
          this.completionHandler(model, context, options),
      },
      sessionManager: {
        getBranch: (): SessionEntry[] => this.branch,
        getSessionId: (): string => 'session-1',
      },
      ui: { notify: (): void => undefined },
    } as unknown as ExtensionContext;
  }

  public async emit(type: string, event: unknown): Promise<unknown> {
    const handler = this.handlers.get(type);
    if (handler === undefined) {
      throw new Error(`No handler for ${type}.`);
    }
    return handler(event, this.context());
  }

  public async command(args: string): Promise<void> {
    const handler = this.commands.get('agent-supervisor');
    if (handler === undefined) {
      throw new Error('Supervisor command was not registered.');
    }
    await handler(args, this.context());
  }
}

function assessmentResponseWithState(state: Record<string, unknown>): unknown {
  return {
    stopReason: 'stop',
    content: [{ type: 'text', text: JSON.stringify({ schemaVersion: 1, claims: [], state }) }],
  };
}

async function settleWithState(recording: RecordingPi, state: Record<string, unknown>): Promise<void> {
  recording.completionHandler = async () => assessmentResponseWithState(state);
  await recording.emit('input', { type: 'input', source: 'interactive', text: TASK_TEXT } as InputEvent);
  await recording.emit('turn_end', {
    type: 'turn_end',
    turnIndex: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: FINAL_TEXT }] },
    toolResults: [],
  } as unknown as TurnEndEvent);
  await recording.emit('agent_settled', { type: 'agent_settled' } as AgentSettledEvent);
}

function kernelVerdict(kernel: SupervisorKernel): SupervisorFactRecord | undefined {
  return kernel.getFacts().find((fact) => fact.kind === 'auto-state:verdict');
}

function toPersisted(snapshot: AgentStateSnapshot): AutoStateFeatureState {
  return {
    schemaVersion: 1,
    ...(snapshot.objective === undefined ? {} : { objective: snapshot.objective }),
    workItems: snapshot.workItems.map((item) => ({ id: item.id, content: item.content, status: item.status })),
    decisions: snapshot.decisions.map((decision) => ({ id: decision.id, content: decision.content })),
  };
}

function persistedAutoStateEntries(recording: RecordingPi): unknown[] {
  return recording.branch
    .filter((entry) => (entry as { customType?: unknown }).customType === 'agent-supervisor-state')
    .map((entry) => (entry as { data?: unknown }).data)
    .filter(
      (data): data is { kind: string; state: { featureId: string; data: unknown } } =>
        typeof data === 'object' &&
        data !== null &&
        (data as { kind?: unknown }).kind === 'feature' &&
        (data as { state?: { featureId?: unknown } }).state?.featureId === 'auto-state',
    )
    .map((data) => data.state.data);
}

describe('auto-state descriptor and codec', () => {
  it('registers a valid tracking-only module with the specified descriptor', () => {
    const module = createAutoState();
    expect(() => validateSupervisorFeatureModule(module)).not.toThrow();
    expect(module.descriptor).toEqual({
      id: 'auto-state',
      schemaVersion: 1,
      maturity: 'validated',
      defaultMode: 'autonomous',
      observes: ['assessment-ready'],
      provides: [],
      requires: ['kernel:assessment', 'kernel:observation', 'kernel:persistence'],
      conflictsWith: [],
      usesAuxiliaryModel: true,
      interventionIntents: [],
    });
  });

  it('validates persisted state through the real core and rejects garbage', () => {
    const module = createAutoState();
    expect(module.state).toBeDefined();
    expect(module.state.schemaVersion).toBe(1);
    expect(
      module.state.validate({ schemaVersion: 1, workItems: [], decisions: [] }),
    ).toEqual({ schemaVersion: 1, workItems: [], decisions: [] });
    expect(() => module.state.validate({ schemaVersion: 1 })).toThrow();
    expect(() => module.state.validate(null)).toThrow();
    expect(() =>
      module.state.validate({
        schemaVersion: 1,
        workItems: [{ id: 'x', content: 'x' }],
        decisions: [],
      }),
    ).toThrow();
  });
});

describe('auto-state initial update', () => {
  it('records an objective, work item, and decision into a core-valid snapshot', () => {
    const emission = directAutoStateEmission([autoStateFact()]);
    expect(emission).toBeDefined();
    expect(emission).not.toHaveProperty('interventions');
    expect(emission?.nextState).toBeDefined();
    const fact = emission?.facts?.[0];
    expect(fact?.kind).toBe('auto-state:verdict');
    expect(fact?.evidenceRefs).toEqual([]);
    expect(fact?.data).toEqual({
      schemaVersion: 1,
      assessmentId: 'assessment-1',
      runSequence: 1,
      changed: true,
      objectiveChanged: true,
      workItemsAdded: 1,
      workItemStatusesChanged: 0,
      decisionsAdded: 1,
    });
    // The verdict carries counts only: no objective, work-item, or decision text.
    const serialized = JSON.stringify(fact);
    expect(serialized).not.toContain(OBJECTIVE_QUOTE);
    expect(serialized).not.toContain(WORK_QUOTE);
    expect(serialized).not.toContain(ASSISTANT_DECISION_QUOTE);
    expect(restoreAgentState(emission?.nextState ?? {}).snapshot().objective).toBe(OBJECTIVE_QUOTE);
  });

  it('persists the new snapshot when the runtime state is threaded like the Kernel does', () => {
    const first = directAutoStateEmission([autoStateFact()], { state: null });
    const nextState = first?.nextState;
    expect(nextState).toBeDefined();
    if (nextState === undefined) {
      throw new Error('Expected nextState on the initial change.');
    }
    const snapshot = restoreAgentState(nextState).snapshot();
    expect(snapshot.objective).toBe(OBJECTIVE_QUOTE);
    expect(snapshot.workItems).toEqual([{ id: workId(WORK_QUOTE), content: WORK_QUOTE, status: 'open' }]);
    expect(snapshot.decisions).toEqual([
      { id: decisionId(ASSISTANT_DECISION_QUOTE), content: ASSISTANT_DECISION_QUOTE },
    ]);
  });

  it('derives stable deterministic ids with the documented 12-hex truncation', () => {
    const first = directAutoStateEmission([autoStateFact()], { state: null });
    const second = directAutoStateEmission([autoStateFact()], { state: first?.nextState ?? null });
    expect(workId(WORK_QUOTE)).toMatch(/^auto:work:[0-9a-f]{12}$/);
    expect(decisionId(ASSISTANT_DECISION_QUOTE)).toMatch(/^auto:decision:[0-9a-f]{12}$/);
    // The same quote twice yields the same id and no duplicate: the second run is a no-op.
    expect(verdictData(second)).toMatchObject({ changed: false, workItemsAdded: 0, decisionsAdded: 0 });
    expect(second).not.toHaveProperty('nextState');
    const snapshot = restoreAgentState(first?.nextState ?? {}).snapshot();
    expect(snapshot.workItems).toHaveLength(1);
    expect(snapshot.decisions).toHaveLength(1);
  });
});

describe('auto-state status transitions', () => {
  it('moves open -> in_progress -> blocked -> in_progress through the core', () => {
    let state: AutoStateFeatureState | null = null;
    for (const status of ['open', 'in_progress', 'blocked', 'in_progress'] as const) {
      const emission = directAutoStateEmission(
        [
          autoStateFact({
            state: {
              available: true,
              workItems: [{ quote: WORK_QUOTE, status }],
              decisions: [],
            },
          }),
        ],
        { state },
      );
      const data = verdictData(emission);
      if (status === 'open' && state === null) {
        expect(data).toMatchObject({ changed: true, workItemsAdded: 1, workItemStatusesChanged: 0 });
      } else {
        expect(data).toMatchObject({ changed: true, workItemsAdded: 0, workItemStatusesChanged: 1 });
      }
      const next = emission?.nextState;
      if (next === undefined) {
        throw new Error('Expected nextState on a status change.');
      }
      state = next;
      expect(restoreAgentState(state).snapshot().workItems[0]?.status).toBe(status);
    }
  });

  it('never regresses an existing done work item', () => {
    const persisted = toPersisted(
      restoreAgentState({
        schemaVersion: 1,
        workItems: [{ id: workId(WORK_QUOTE), content: WORK_QUOTE, status: 'done' }],
        decisions: [],
      }).snapshot(),
    );
    const emission = directAutoStateEmission(
      [
        autoStateFact({
          state: {
            available: true,
            workItems: [{ quote: WORK_QUOTE, status: 'open' }],
            decisions: [],
          },
        }),
      ],
      { state: persisted },
    );
    expect(verdictData(emission)).toMatchObject({ changed: false, workItemStatusesChanged: 0 });
    expect(emission).not.toHaveProperty('nextState');
  });
});

describe('auto-state objective rebuild', () => {
  it('changes the objective while work items and decisions survive restoration', () => {
    const first = directAutoStateEmission([autoStateFact()], { state: null });
    const before = restoreAgentState(first?.nextState ?? {}).snapshot();
    expect(before.objective).toBe(OBJECTIVE_QUOTE);

    const nextObjective = 'The dashboard must show recent activity.';
    const second = directAutoStateEmission(
      [
        autoStateFact({
          state: {
            available: true,
            objective: nextObjective,
            workItems: [{ quote: WORK_QUOTE, status: 'open' }],
            decisions: [{ source: 'assistant', quote: ASSISTANT_DECISION_QUOTE }],
          },
        }),
      ],
      { state: first?.nextState ?? null },
    );
    expect(verdictData(second)).toMatchObject({
      changed: true,
      objectiveChanged: true,
      workItemsAdded: 0,
      decisionsAdded: 0,
    });
    const after = restoreAgentState(second?.nextState ?? {}).snapshot();
    expect(after.objective).toBe(nextObjective);
    expect(after.workItems).toEqual(before.workItems);
    expect(after.decisions).toEqual(before.decisions);
  });

  it('preserves the existing objective when the assessment carries none', () => {
    const first = directAutoStateEmission([autoStateFact()], { state: null });
    const second = directAutoStateEmission(
      [
        autoStateFact({
          state: { available: true, workItems: [], decisions: [] },
        }),
      ],
      { state: first?.nextState ?? null },
    );
    expect(verdictData(second)).toMatchObject({ changed: false, objectiveChanged: false });
    expect(second).not.toHaveProperty('nextState');
  });
});

describe('auto-state decision dedup', () => {
  it('does not duplicate an identical decision quote', () => {
    const first = directAutoStateEmission([autoStateFact()], { state: null });
    const second = directAutoStateEmission([autoStateFact()], { state: first?.nextState ?? null });
    expect(verdictData(second)).toMatchObject({ changed: false, decisionsAdded: 0 });
    expect(second).not.toHaveProperty('nextState');
  });
});

describe('auto-state invalid updates', () => {
  it('rejects a colliding id and preserves the previous state untouched', () => {
    const colliding = workId('a completely different quote');
    const persisted: AutoStateFeatureState = {
      schemaVersion: 1,
      workItems: [{ id: colliding, content: 'unrelated stored content', status: 'open' }],
      decisions: [],
    };
    const emission = directAutoStateEmission(
      [
        autoStateFact({
          state: {
            available: true,
            objective: OBJECTIVE_QUOTE,
            workItems: [{ quote: 'a completely different quote', status: 'open' }],
            decisions: [{ source: 'task', quote: TASK_DECISION_QUOTE }],
          },
        }),
      ],
      { state: persisted },
    );
    // The whole update is rejected: no verdict, no state, even though sibling candidates are valid.
    expect(emission).toBeUndefined();
  });

  it('rejects an oversized candidate without partial application', () => {
    const oversized = 'x'.repeat(501);
    const emission = directAutoStateEmission(
      [
        autoStateFact({
          state: {
            available: true,
            objective: OBJECTIVE_QUOTE,
            workItems: [{ quote: oversized, status: 'open' }],
            decisions: [],
          },
        }),
      ],
      { state: null },
    );
    expect(emission).toBeUndefined();
  });

  it('rejects an oversized objective', () => {
    const oversized = 'y'.repeat(1001);
    const emission = directAutoStateEmission(
      [autoStateFact({ state: { available: true, objective: oversized } })],
      { state: null },
    );
    expect(emission).toBeUndefined();
  });

  it('fails open on a missing, duplicate, or malformed match', () => {
    const valid = autoStateFact();
    const malformedEnvelope = {
      ...valid,
      data: { ...(valid.data as Record<string, unknown>), runSequence: 'bad' },
    } as unknown as SupervisorFactRecord;
    const malformedDomain = autoStateFact({
      state: { available: true, workItems: [{ quote: WORK_QUOTE, status: 'done' }] } as unknown as StateDomainInput,
    });

    expect(directAutoStateEmission([])).toBeUndefined();
    expect(directAutoStateEmission([valid, autoStateFact({ sequence: 1 })])).toBeUndefined();
    expect(directAutoStateEmission([malformedEnvelope])).toBeUndefined();
    expect(directAutoStateEmission([malformedDomain])).toBeUndefined();
    expect(directAutoStateEmission([autoStateFact()], { payload: { assessmentId: 'other', runSequence: 1 } })).toBeUndefined();
    expect(
      directAutoStateEmission([
        autoStateFact({ rootRequestId: 'root-9', assessmentId: 'assessment-9', runSequence: 9 }),
      ]),
    ).toBeUndefined();
  });

  it('leaves state untouched for a missing state key or an unavailable domain', () => {
    const persisted: AutoStateFeatureState = {
      schemaVersion: 1,
      objective: OBJECTIVE_QUOTE,
      workItems: [],
      decisions: [],
    };
    expect(directAutoStateEmission([autoStateFact({ omitStateKey: true })], { state: persisted })).toBeUndefined();
    expect(
      directAutoStateEmission([autoStateFact({ state: { available: false } })], { state: persisted }),
    ).toBeUndefined();
    expect(directAutoStateEmission([autoStateFact({ state: { available: false } })])).toBeUndefined();
  });
});

describe('auto-state capacity bounds', () => {
  function persistedWithWorkItems(count: number): AutoStateFeatureState {
    const workItems = Array.from({ length: count }, (_, index) => ({
      id: workId(`persisted work item ${index}`),
      content: `persisted work item ${index}`,
      status: 'open' as const,
    }));
    return toPersisted(restoreAgentState({ schemaVersion: 1, workItems, decisions: [] }).snapshot());
  }

  it('rejects a work-item addition past 64 persisted items', () => {
    const emission = directAutoStateEmission(
      [
        autoStateFact({
          state: {
            available: true,
            workItems: [{ quote: 'one more work item', status: 'open' }],
            decisions: [],
          },
        }),
      ],
      { state: persistedWithWorkItems(AUTO_STATE_MAX_WORK_ITEMS) },
    );
    expect(emission).toBeUndefined();
    expect(AUTO_STATE_MAX_WORK_ITEMS).toBe(64);
  });

  it('rejects a decision addition past 64 persisted decisions', () => {
    const decisions = Array.from({ length: AUTO_STATE_MAX_DECISIONS }, (_, index) => ({
      id: decisionId(`persisted decision ${index}`),
      content: `persisted decision ${index}`,
    }));
    const persisted = toPersisted(
      restoreAgentState({ schemaVersion: 1, workItems: [], decisions }).snapshot(),
    );
    const emission = directAutoStateEmission(
      [
        autoStateFact({
          state: {
            available: true,
            workItems: [],
            decisions: [{ source: 'task', quote: 'one more decision' }],
          },
        }),
      ],
      { state: persisted },
    );
    expect(emission).toBeUndefined();
    expect(AUTO_STATE_MAX_DECISIONS).toBe(64);
  });
});

describe('auto-state no-op persistence', () => {
  it('emits the verdict but no nextState when nothing changed semantically', () => {
    const first = directAutoStateEmission([autoStateFact()], { state: null });
    const second = directAutoStateEmission([autoStateFact()], { state: first?.nextState ?? null });
    expect(second).toBeDefined();
    expect(second).not.toHaveProperty('nextState');
    expect(verdictData(second)).toEqual({
      schemaVersion: 1,
      assessmentId: 'assessment-1',
      runSequence: 1,
      changed: false,
      objectiveChanged: false,
      workItemsAdded: 0,
      workItemStatusesChanged: 0,
      decisionsAdded: 0,
    });
  });
});

describe('auto-state runtime modes', () => {
  it('emits the fact but no nextState in observe mode across two shadow runs', () => {
    const module = createAutoState();
    const runtime = module.create({
      featureId: 'auto-state',
      config: null,
      initialState: null,
      effectiveMode: 'observe',
    });
    if (runtime.onObservation === undefined) {
      throw new Error('Auto-state did not create an observation runtime.');
    }
    const observe = (facts: readonly SupervisorFactRecord[]): SupervisorFeatureEmission<AutoStateFeatureState> | undefined => {
      const context: SupervisorFeatureRuntimeContext<AutoStateFeatureState> = {
        featureId: 'auto-state',
        effectiveMode: 'observe',
        facts: createSupervisorFactSnapshot(facts),
        // The Kernel persists nothing in observe mode, so the persisted state stays null.
        state: null,
      };
      return runtime.onObservation?.(readyObservation(), context) as
        | SupervisorFeatureEmission<AutoStateFeatureState>
        | undefined;
    };
    const first = observe([autoStateFact()]);
    expect(verdictData(first)).toMatchObject({ changed: true });
    expect(first).not.toHaveProperty('nextState');
    // The second identical run sees the shadow: no change, still a fact, still no persistence.
    const second = observe([autoStateFact()]);
    expect(verdictData(second)).toMatchObject({ changed: false });
    expect(second).not.toHaveProperty('nextState');
  });

  it('computes a verdict but persists nothing in feature observe mode through the Kernel', async () => {
    const recording = new RecordingPi();
    const kernel = new SupervisorKernel(recording.pi, [createAutoState()]);
    kernel.register();
    await recording.command('feature auto-state observe');
    await settleWithState(recording, {
      objective: { quote: OBJECTIVE_QUOTE },
      workItems: [{ quote: WORK_QUOTE, status: 'open' }],
      decisions: [{ source: 'assistant', quote: ASSISTANT_DECISION_QUOTE }],
    });

    expect(kernel.getRuntimeStatuses().find((status) => status.id === 'auto-state')?.effectiveMode).toBe(
      'observe',
    );
    expect(kernelVerdict(kernel)?.data).toMatchObject({ changed: true, workItemsAdded: 1 });
    expect(persistedAutoStateEntries(recording)).toEqual([]);
  });

  it('honors off mode without instantiating the feature', async () => {
    const recording = new RecordingPi();
    const kernel = new SupervisorKernel(recording.pi, [createAutoState()]);
    kernel.register();
    await recording.command('feature auto-state off');
    await settleWithState(recording, {
      objective: { quote: OBJECTIVE_QUOTE },
      workItems: [{ quote: WORK_QUOTE, status: 'open' }],
      decisions: [{ source: 'assistant', quote: ASSISTANT_DECISION_QUOTE }],
    });

    expect(kernel.getRuntimeStatuses().find((status) => status.id === 'auto-state')?.status).toBe('off');
    expect(kernelVerdict(kernel)).toBeUndefined();
  });

  it('maintains durable state end to end in autonomous mode through the Kernel', async () => {
    const recording = new RecordingPi();
    const kernel = new SupervisorKernel(recording.pi, [createAutoState()]);
    kernel.register();
    await settleWithState(recording, {
      objective: { quote: OBJECTIVE_QUOTE },
      workItems: [{ quote: WORK_QUOTE, status: 'open' }],
      decisions: [{ source: 'assistant', quote: ASSISTANT_DECISION_QUOTE }],
    });

    const assessment = kernel.getFacts().find((fact) => fact.kind === 'kernel:completion-assessment');
    expect(assessment?.data).toMatchObject({
      state: {
        available: true,
        state: {
          objective: { quote: OBJECTIVE_QUOTE },
          workItems: [{ quote: WORK_QUOTE, status: 'open' }],
          decisions: [{ source: 'assistant', quote: ASSISTANT_DECISION_QUOTE }],
        },
      },
    });
    expect(kernelVerdict(kernel)?.data).toEqual({
      schemaVersion: 1,
      assessmentId: 'assessment-1',
      runSequence: 1,
      changed: true,
      objectiveChanged: true,
      workItemsAdded: 1,
      workItemStatusesChanged: 0,
      decisionsAdded: 1,
    });
    const entries = persistedAutoStateEntries(recording);
    expect(entries).toHaveLength(1);
    const snapshot = restoreAgentState(entries[0]).snapshot();
    expect(snapshot.objective).toBe(OBJECTIVE_QUOTE);
    expect(snapshot.workItems).toEqual([{ id: workId(WORK_QUOTE), content: WORK_QUOTE, status: 'open' }]);
    expect(snapshot.decisions).toEqual([
      { id: decisionId(ASSISTANT_DECISION_QUOTE), content: ASSISTANT_DECISION_QUOTE },
    ]);
  });
});
