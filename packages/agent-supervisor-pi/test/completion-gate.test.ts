import { describe, expect, it } from 'vitest';
import { judgeEvidence } from '@j1nn0/agent-evidence';
import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  SessionEntry,
  ToolResultEvent,
  TurnEndEvent,
} from '@earendil-works/pi-coding-agent';
import { createSupervisorFactRecord, createSupervisorFactSnapshot } from '../src/fact.js';
import type { SupervisorFactRecord } from '../src/fact.js';
import { createSupervisorBuiltInFeatures } from '../src/features/builtins.js';
import { createCompletionGate } from '../src/features/completion-gate.js';
import { SupervisorKernel } from '../src/kernel/kernel.js';
import type {
  SupervisorFeatureEmission,
  SupervisorFeatureRuntimeContext,
} from '../src/module.js';
import type { SupervisorObservation } from '../src/observation.js';

const FOLLOW_UP_MESSAGE =
  'Agent Supervisor: the previous completion claim is not supported by current verification evidence. Run an appropriate post-change verification using available tools, inspect the result, and only claim completion when the observed evidence supports it.';
const TOOL_REGISTRY = [
  { name: 'bash', sourceInfo: { source: 'builtin' } },
  { name: 'powershell', sourceInfo: { source: 'builtin' } },
  { name: 'edit', sourceInfo: { source: 'builtin' } },
  { name: 'write', sourceInfo: { source: 'builtin' } },
  { name: 'read', sourceInfo: { source: 'builtin' } },
];

type EventHandler = (event: unknown, context: ExtensionContext) => Promise<unknown> | unknown;
type CompletionHandler = (model: unknown, context: unknown, options: unknown) => Promise<unknown>;
type CommandHandler = (args: string, context: ExtensionContext) => Promise<void>;

type ToolSpec = {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly isError?: boolean;
};

type ClaimSpec = {
  readonly kind?: 'completion' | 'verification';
  readonly evidence: readonly string[];
  readonly quote?: string;
};

class RecordingPi {
  public readonly handlers = new Map<string, EventHandler>();
  public readonly commands = new Map<string, CommandHandler>();
  public readonly sentMessages: { readonly content: unknown; readonly options: unknown }[] = [];
  public readonly completionCalls: unknown[] = [];
  public readonly branch: SessionEntry[] = [];
  public readonly model = { reasoning: false, thinkingLevelMap: {} };
  public completionHandler: CompletionHandler = async () => assessmentResponse([]);
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
      sendUserMessage: (content: unknown, options?: unknown): void => {
        this.sentMessages.push({ content, options });
      },
      getAllTools: (): readonly unknown[] => TOOL_REGISTRY,
    } as unknown as ExtensionAPI;
  }

  public context(): ExtensionContext {
    return {
      model: this.model,
      modelRegistry: {
        complete: (model: unknown, context: unknown, options: unknown): Promise<unknown> => {
          this.completionCalls.push({ model, context, options });
          return this.completionHandler(model, context, options);
        },
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
      throw new Error(`No handler for ${type}`);
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


function inputEvent(): InputEvent {
  return { type: 'input', source: 'interactive', text: 'private task' } as InputEvent;
}

function toolResultEvent(spec: ToolSpec, index: number): ToolResultEvent {
  return {
    type: 'tool_result',
    toolCallId: `call-${index}`,
    toolName: spec.toolName,
    input: spec.input,
    content: [{ type: 'text', text: 'verification result' }],
    isError: spec.isError ?? false,
    details: { private: 'details' },
  } as ToolResultEvent;
}

function turnEndEvent(text = 'Done.'): TurnEndEvent {
  return {
    type: 'turn_end',
    turnIndex: 1,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    toolResults: [],
  } as unknown as TurnEndEvent;
}

function assessmentResponse(claims: readonly ClaimSpec[]): unknown {
  return {
    stopReason: 'stop',
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          schemaVersion: 1,
          claims: claims.map((claim) => ({
            kind: claim.kind ?? 'completion',
            quote: claim.quote ?? 'Done.',
            evidence: claim.evidence.map((id) => ({ id, quote: 'verification result' })),
          })),
        }),
      },
    ],
  };
}

function createKernel(recording: RecordingPi, features = [createCompletionGate()]): SupervisorKernel {
  const kernel = new SupervisorKernel(recording.pi, features);
  kernel.register();
  return kernel;
}

async function settle(
  kernel: SupervisorKernel,
  recording: RecordingPi,
  tools: readonly ToolSpec[],
  claims: readonly ClaimSpec[],
  finalText = 'Done.',
): Promise<void> {
  recording.completionHandler = async () => assessmentResponse(claims);
  await recording.emit('input', inputEvent());
  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index];
    if (tool !== undefined) {
      await recording.emit('tool_result', toolResultEvent(tool, index + 1));
    }
  }
  await recording.emit('turn_end', turnEndEvent(finalText));
  await recording.emit('agent_settled', { type: 'agent_settled' });
}

function verdictFact(kernel: SupervisorKernel): SupervisorFactRecord | undefined {
  return kernel.getFacts().find((fact) => fact.kind === 'completion-gate:verdict');
}

function completionGateFact(
  options: {
    readonly sequence?: number;
    readonly assessmentId?: string;
    readonly runSequence?: number;
    readonly mutationEpoch?: number;
    readonly claims?: readonly ClaimSpec[];
    readonly evidence?: readonly {
      readonly id: string;
      readonly isError?: boolean;
      readonly mutationEpoch?: number;
      readonly verificationKind?: string | null;
    }[];
  } = {},
): SupervisorFactRecord {
  const rootRequestId = 'root-1';
  const evidence = (options.evidence ?? []).map((record) => ({
    id: record.id,
    toolName: 'tool',
    toolCallId: `${record.id}-call`,
    isError: record.isError ?? false,
    inputDigest: null,
    resultDigest: null,
    mutationEpoch: record.mutationEpoch ?? options.mutationEpoch ?? 0,
    verificationKind: record.verificationKind ?? null,
  }));
  const claims = (options.claims ?? [{ evidence: [] }]).map((claim, index) => ({
    id: `claim-${index + 1}`,
    kind: claim.kind ?? 'completion',
    quote: claim.quote ?? 'Done.',
    evidence: claim.evidence.map((id) => ({ id, quoteHash: 'quote-hash' })),
  }));
  const data = {
    assessmentId: options.assessmentId ?? 'assessment-1',
    rootRequestId,
    runSequence: options.runSequence ?? 1,
    mutationEpoch: options.mutationEpoch ?? 0,
    claims,
    evidence,
  };
  return createSupervisorFactRecord({
    candidate: {
      kind: 'kernel:completion-assessment',
      evidenceRefs: evidence.map((record) => record.id),
      data,
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

function directCompletionGateEmission(
  facts: readonly SupervisorFactRecord[],
  payload?: { readonly assessmentId: string; readonly runSequence: number },
) {
  const runtime = createCompletionGate().create({
    featureId: 'completion-gate',
    config: null,
    initialState: null,
    effectiveMode: 'autonomous',
  });
  if (runtime.onObservation === undefined) {
    throw new Error('Completion gate did not create an observation runtime.');
  }
  const context: SupervisorFeatureRuntimeContext<never> = {
    featureId: 'completion-gate',
    effectiveMode: 'autonomous',
    facts: createSupervisorFactSnapshot(facts),
    state: null,
  };
  return runtime.onObservation(readyObservation(payload), context) as
    | SupervisorFeatureEmission<never>
    | undefined;
}

const WRITE = { toolName: 'write', input: { path: '/tmp/changed.txt' } } as const;
const TEST = { toolName: 'bash', input: { command: 'pnpm test' } } as const;
const LINT = { toolName: 'bash', input: { command: 'eslint' } } as const;
const TYPECHECK = { toolName: 'bash', input: { command: 'tsc' } } as const;
const LS = { toolName: 'bash', input: { command: 'ls' } } as const;
const UNKNOWN_TOOL = { toolName: 'custom-tool', input: { value: 1 } } as const;

describe('completion-gate evidence judgments', () => {
  it('uses the real Evidence core on a sanitized subject-bound input', () => {
    const input = {
      claims: [{ id: 'claim-1', requires: [{ evidenceId: 'e1', subject: 'mutation-epoch:1' }] }],
      evidence: [{ id: 'e1', outcome: 'confirmed', subject: 'mutation-epoch:1' }],
    };
    expect(judgeEvidence(input)).toEqual({ claims: [{ claimId: 'claim-1', outcome: 'supported' }] });
  });

  it('supports a successful recognized verification after a mutation without a follow-up', async () => {
    const recording = new RecordingPi();
    const kernel = createKernel(recording);
    await settle(kernel, recording, [WRITE, TEST], [{ evidence: ['e2'] }]);

    expect(verdictFact(kernel)?.data).toMatchObject({
      mutationEpoch: 1,
      claims: [{ claimId: 'claim-1', outcome: 'supported', reason: null, evidenceId: null }],
    });
    expect(recording.sentMessages).toEqual([]);
  });

  it('contradicts a failed recognized verification and proposes one follow-up', async () => {
    const recording = new RecordingPi();
    const kernel = createKernel(recording);
    await settle(kernel, recording, [WRITE, { ...TEST, isError: true }], [{ evidence: ['e2'] }]);

    expect(verdictFact(kernel)?.data).toMatchObject({
      claims: [{ claimId: 'claim-1', outcome: 'contradicted', reason: null, evidenceId: 'e2' }],
    });
    expect(recording.sentMessages).toEqual([{ content: FOLLOW_UP_MESSAGE, options: { deliverAs: 'followUp' } }]);
  });

  it('reports a pre-mutation verification as subject-mismatched and proposes a follow-up', async () => {
    const recording = new RecordingPi();
    const kernel = createKernel(recording);
    await settle(kernel, recording, [TEST, WRITE], [{ evidence: ['e1'] }]);

    expect(verdictFact(kernel)?.data).toMatchObject({
      claims: [{ claimId: 'claim-1', outcome: 'unsupported', reason: 'subject_mismatch', evidenceId: 'e1' }],
    });
    expect(recording.sentMessages).toHaveLength(1);
  });

  it('uses current unknown linked evidence as unconfirmed evidence', async () => {
    const recording = new RecordingPi();
    const kernel = createKernel(recording);
    await settle(kernel, recording, [WRITE, LS], [{ evidence: ['e2'] }]);

    expect(verdictFact(kernel)?.data).toMatchObject({
      claims: [{ claimId: 'claim-1', outcome: 'unsupported', reason: 'unconfirmed_evidence', evidenceId: 'e2' }],
    });
    expect(recording.sentMessages).toHaveLength(1);
  });

  it('uses missing evidence when a mutation has no usable linked evidence', async () => {
    const recording = new RecordingPi();
    const kernel = createKernel(recording);
    await settle(kernel, recording, [WRITE], [{ evidence: [] }]);

    expect(verdictFact(kernel)?.data).toMatchObject({
      claims: [
        {
          claimId: 'claim-1',
          outcome: 'unsupported',
          reason: 'missing_evidence',
          evidenceId: 'completion-gate:required-verification:claim-1',
        },
      ],
    });
    expect(recording.sentMessages).toHaveLength(1);
  });

  it('ignores stale verification when a successful current-epoch verification is also linked', async () => {
    const recording = new RecordingPi();
    const kernel = createKernel(recording);
    await settle(kernel, recording, [TEST, WRITE, TEST], [{ evidence: ['e1', 'e3'] }]);

    expect(verdictFact(kernel)?.data).toMatchObject({
      claims: [{ claimId: 'claim-1', outcome: 'supported', reason: null, evidenceId: null }],
    });
    expect(recording.sentMessages).toEqual([]);
  });

  it('supports multiple current verifications and contradicts when one fails', async () => {
    const successfulRecording = new RecordingPi();
    const successfulKernel = createKernel(successfulRecording);
    await settle(successfulKernel, successfulRecording, [WRITE, TEST, TYPECHECK], [{ evidence: ['e2', 'e3'] }]);
    expect(verdictFact(successfulKernel)?.data).toMatchObject({
      claims: [{ outcome: 'supported' }],
    });

    const failedRecording = new RecordingPi();
    const failedKernel = createKernel(failedRecording);
    await settle(failedKernel, failedRecording, [WRITE, TEST, { ...LINT, isError: true }], [{ evidence: ['e2', 'e3'] }]);
    expect(verdictFact(failedKernel)?.data).toMatchObject({
      claims: [{ claimId: 'claim-1', outcome: 'contradicted', evidenceId: 'e3' }],
    });
    expect(failedRecording.sentMessages).toHaveLength(1);
  });

  it('stays quiet for a completion claim without mutation or recognized verification', async () => {
    const recording = new RecordingPi();
    const kernel = createKernel(recording);
    await settle(kernel, recording, [UNKNOWN_TOOL], [{ evidence: ['e1'] }]);

    expect(verdictFact(kernel)).toBeUndefined();
    expect(recording.sentMessages).toEqual([]);
  });

  it('gates a mutated completion even when no verification is linked', async () => {
    const recording = new RecordingPi();
    const kernel = createKernel(recording);
    await settle(kernel, recording, [WRITE], [{ evidence: [] }]);

    expect(verdictFact(kernel)).toBeDefined();
    expect(recording.sentMessages).toHaveLength(1);
  });

  it('does not trigger for verification-only claims or an empty claims array', async () => {
    const verificationRecording = new RecordingPi();
    const verificationKernel = createKernel(verificationRecording);
    await settle(verificationKernel, verificationRecording, [WRITE, TEST], [{ kind: 'verification', evidence: ['e2'] }]);
    expect(verdictFact(verificationKernel)).toBeUndefined();
    expect(verificationRecording.sentMessages).toEqual([]);

    const emptyRecording = new RecordingPi();
    const emptyKernel = createKernel(emptyRecording);
    await settle(emptyKernel, emptyRecording, [WRITE], []);
    expect(verdictFact(emptyKernel)).toBeUndefined();
    expect(emptyRecording.sentMessages).toEqual([]);
  });

  it('does not expose claim quotes or evidence content in the verdict fact or message', async () => {
    const recording = new RecordingPi();
    const kernel = createKernel(recording);
    await settle(kernel, recording, [WRITE], [{ evidence: [] }]);

    const fact = verdictFact(kernel);
    expect(fact).toBeDefined();
    const serializedFact = JSON.stringify(fact);
    expect(serializedFact).not.toContain('Done.');
    expect(serializedFact).not.toContain('verification result');
    expect(JSON.stringify(recording.sentMessages)).not.toContain('Done.');
  });
});

describe('completion-gate fact selection and runtime modes', () => {
  it('fails open for a missing, duplicate, or malformed matching assessment fact', () => {
    const valid = completionGateFact({
      mutationEpoch: 1,
      claims: [{ evidence: [] }],
      evidence: [{ id: 'e1', mutationEpoch: 1 }],
    });
    const malformed = {
      ...valid,
      data: { ...(valid.data as Record<string, unknown>), mutationEpoch: 'bad' },
    } as unknown as SupervisorFactRecord;

    expect(directCompletionGateEmission([])).toBeUndefined();
    expect(directCompletionGateEmission([valid, completionGateFact({ sequence: 1, mutationEpoch: 1, claims: [{ evidence: [] }], evidence: [{ id: 'e1', mutationEpoch: 1 }] })])).toBeUndefined();
    expect(directCompletionGateEmission([malformed])).toBeUndefined();
  });

  it('matches assessment facts by root, assessment id, and run sequence rather than recency', () => {
    const older = completionGateFact({ assessmentId: 'assessment-old', runSequence: 1 });
    const current = completionGateFact({ assessmentId: 'assessment-current', runSequence: 2, mutationEpoch: 1, claims: [{ evidence: [] }] });
    const emission = directCompletionGateEmission([older, current], {
      assessmentId: 'assessment-current',
      runSequence: 2,
    });

    expect(emission?.facts?.[0]).toMatchObject({ kind: 'completion-gate:verdict' });
  });

  it('instantiates and transports in autonomous mode through the Kernel', async () => {
    const recording = new RecordingPi();
    const kernel = createKernel(recording);
    await settle(kernel, recording, [WRITE], [{ evidence: [] }]);

    expect(kernel.getRuntimeStatuses().find((status) => status.id === 'completion-gate')?.status).toBe('active');
    expect(recording.sentMessages).toHaveLength(1);
  });

  it('computes a verdict but transports nothing in feature observe mode', async () => {
    const recording = new RecordingPi();
    const kernel = createKernel(recording);
    await recording.command('feature completion-gate observe');
    await settle(kernel, recording, [WRITE], [{ evidence: [] }]);

    expect(kernel.getRuntimeStatuses().find((status) => status.id === 'completion-gate')?.effectiveMode).toBe('observe');
    expect(verdictFact(kernel)).toBeDefined();
    expect(recording.completionCalls).toHaveLength(1);
    expect(recording.sentMessages).toEqual([]);
  });

  it('honors off mode without instantiating the feature and the global observe ceiling', async () => {
    const offRecording = new RecordingPi();
    const offKernel = createKernel(offRecording);
    await offRecording.command('feature completion-gate off');
    await settle(offKernel, offRecording, [WRITE], [{ evidence: [] }]);
    expect(offKernel.getRuntimeStatuses().find((status) => status.id === 'completion-gate')?.status).toBe('off');
    expect(offRecording.completionCalls).toHaveLength(0);
    expect(offRecording.sentMessages).toEqual([]);

    const globalObserveRecording = new RecordingPi();
    const globalObserveKernel = createKernel(globalObserveRecording);
    await globalObserveRecording.command('mode observe');
    await settle(globalObserveKernel, globalObserveRecording, [WRITE], [{ evidence: [] }]);
    expect(globalObserveKernel.getRuntimeStatuses().find((status) => status.id === 'completion-gate')?.effectiveMode).toBe('observe');
    expect(verdictFact(globalObserveKernel)).toBeDefined();
    expect(globalObserveRecording.completionCalls).toHaveLength(1);
    expect(globalObserveRecording.sentMessages).toEqual([]);
  });

  it('registers exactly retry-loop-breaker and completion-gate together without tools or conflicts', () => {
    const features = createSupervisorBuiltInFeatures();
    expect(features.map((feature) => feature.descriptor.id)).toEqual([
      'retry-loop-breaker',
      'completion-gate',
    ]);
    expect(features.every((feature) => feature.descriptor.interventionIntents.includes('verify') || feature.descriptor.id === 'retry-loop-breaker')).toBe(true);
  });
});
