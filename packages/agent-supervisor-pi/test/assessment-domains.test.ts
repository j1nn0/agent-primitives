import { describe, expect, it } from 'vitest';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import { SupervisorAssessmentEvidenceCollector } from '../src/assessment/evidence.js';
import {
  parseSupervisorAssessmentResponse,
  type SupervisorAssessmentOutput,
  type SupervisorAssessmentParseResult,
} from '../src/assessment/parse.js';
import { SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT } from '../src/assessment/prompt.js';
import { createSupervisorAssessmentPayload } from '../src/assessment/request.js';
import type { SupervisorAssessmentEvidence } from '../src/assessment/types.js';
import { validateSupervisorFeatureDescriptor } from '../src/feature.js';
import { SupervisorKernel } from '../src/kernel/kernel.js';
import type { SupervisorFeatureModule } from '../src/module.js';

const TASK_TEXT =
  'Fix the login redirect so users land on the dashboard. The dashboard must show recent activity.';
const OBJECTIVE_QUOTE = 'Fix the login redirect so users land on the dashboard.';
const WORK_ITEM_QUOTE = 'users land on the dashboard';
const TASK_DECISION_QUOTE = 'The dashboard must show recent activity.';
const FINAL_TEXT = 'The fix is implemented and the dashboard shows recent activity.';
const CLAIM_QUOTE = 'The fix is implemented';
const ASSISTANT_DECISION_QUOTE = 'The fix is implemented';

const WORD_TASK = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';

function evidenceRecord(id: string, text: string): SupervisorAssessmentEvidence {
  return {
    id,
    toolName: 'tool',
    toolCallId: `${id}-call`,
    isError: false,
    inputDigest: null,
    resultDigest: null,
    mutationEpoch: 0,
    mutation: false,
    verificationKind: null,
    text,
  };
}

const EVIDENCE = [
  evidenceRecord('e1', 'login redirect now lands on the dashboard'),
  evidenceRecord('e2', 'recent activity renders'),
];

function assessmentEnvelope(value: unknown): { stopReason: string; content: readonly unknown[] } {
  return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function validClaims(): readonly unknown[] {
  return [{ kind: 'completion', quote: CLAIM_QUOTE, evidence: [] }];
}

function parseWithDomains(options: {
  readonly state?: unknown;
  readonly progress?: unknown;
  readonly taskText?: string;
  readonly finalText?: string;
  readonly evidence?: readonly SupervisorAssessmentEvidence[];
}): SupervisorAssessmentParseResult {
  const { state, progress, taskText = TASK_TEXT, finalText = FINAL_TEXT, evidence = EVIDENCE } = options;
  const body: Record<string, unknown> = { schemaVersion: 1, claims: validClaims() };
  if (state !== undefined) {
    body.state = state;
  }
  if (progress !== undefined) {
    body.progress = progress;
  }
  return parseSupervisorAssessmentResponse(assessmentEnvelope(body), finalText, evidence, taskText);
}

function requireOk(result: SupervisorAssessmentParseResult): SupervisorAssessmentOutput {
  if (!result.ok) {
    throw new Error(`Expected a successful parse but got ${result.failureKind}.`);
  }
  return result.output;
}

const EMPTY_STATE = { available: true, state: { workItems: [], decisions: [] } } as const;
const EMPTY_PROGRESS = { available: true, candidates: [] } as const;

describe('Supervisor assessment state domain', () => {
  it('accepts an exact task objective', () => {
    const output = requireOk(parseWithDomains({ state: { objective: { quote: OBJECTIVE_QUOTE } } }));
    expect(output.claims).toHaveLength(1);
    expect(output.state).toEqual({
      available: true,
      state: { objective: { quote: OBJECTIVE_QUOTE }, workItems: [], decisions: [] },
    });
    expect(output.progress).toEqual(EMPTY_PROGRESS);
  });

  it('rejects an objective paraphrase without invalidating claims', () => {
    const output = requireOk(parseWithDomains({ state: { objective: { quote: 'Fix login redirection' } } }));
    expect(output.claims).toHaveLength(1);
    expect(output.state).toEqual({ available: false });
  });

  it('rejects an objective sourced only from the assistant text', () => {
    const output = requireOk(
      parseWithDomains({ state: { objective: { quote: ASSISTANT_DECISION_QUOTE } } }),
    );
    expect(output.claims).toHaveLength(1);
    expect(output.state).toEqual({ available: false });
  });

  it('rejects an oversized objective', () => {
    const oversized = '😀'.repeat(1001);
    const taskText = `Prefix ${oversized} suffix`;
    const output = requireOk(
      parseWithDomains({ state: { objective: { quote: oversized } }, taskText }),
    );
    expect(output.claims).toHaveLength(1);
    expect(output.state).toEqual({ available: false });
  });

  it('accepts an objective at the code-point bound', () => {
    const bound = '😀'.repeat(1000);
    const taskText = `Prefix ${bound} suffix`;
    const output = requireOk(
      parseWithDomains({ state: { objective: { quote: bound } }, taskText }),
    );
    expect(output.state).toEqual({
      available: true,
      state: { objective: { quote: bound }, workItems: [], decisions: [] },
    });
  });

  it('accepts an exact task work item', () => {
    const output = requireOk(
      parseWithDomains({ state: { workItems: [{ quote: WORK_ITEM_QUOTE, status: 'in_progress' }] } }),
    );
    expect(output.claims).toHaveLength(1);
    expect(output.state).toEqual({
      available: true,
      state: {
        workItems: [{ quote: WORK_ITEM_QUOTE, status: 'in_progress' }],
        decisions: [],
      },
    });
  });

  it('rejects a work-item paraphrase without invalidating claims', () => {
    const output = requireOk(
      parseWithDomains({ state: { workItems: [{ quote: 'users reach the dashboard', status: 'open' }] } }),
    );
    expect(output.claims).toHaveLength(1);
    expect(output.state).toEqual({ available: false });
  });

  it('rejects a work item over 500 code points', () => {
    const oversized = 'W'.repeat(501);
    const taskText = `Prefix ${oversized} suffix`;
    const output = requireOk(
      parseWithDomains({
        state: { workItems: [{ quote: oversized, status: 'open' }] },
        taskText,
      }),
    );
    expect(output.claims).toHaveLength(1);
    expect(output.state).toEqual({ available: false });
  });

  it('rejects duplicate work-item quotes', () => {
    const output = requireOk(
      parseWithDomains({
        state: {
          workItems: [
            { quote: WORK_ITEM_QUOTE, status: 'open' },
            { quote: WORK_ITEM_QUOTE, status: 'blocked' },
          ],
        },
      }),
    );
    expect(output.claims).toHaveLength(1);
    expect(output.state).toEqual({ available: false });
  });

  it('rejects a done work-item status', () => {
    const output = requireOk(
      parseWithDomains({ state: { workItems: [{ quote: WORK_ITEM_QUOTE, status: 'done' }] } }),
    );
    expect(output.claims).toHaveLength(1);
    expect(output.state).toEqual({ available: false });
  });

  it('rejects an invalid work-item status', () => {
    const output = requireOk(
      parseWithDomains({ state: { workItems: [{ quote: WORK_ITEM_QUOTE, status: 'complete' }] } }),
    );
    expect(output.claims).toHaveLength(1);
    expect(output.state).toEqual({ available: false });
  });

  it('rejects more than 8 work items', () => {
    const words = WORD_TASK.split(' ');
    const workItems = words.slice(0, 9).map((quote) => ({ quote, status: 'open' }));
    const output = requireOk(parseWithDomains({ state: { workItems }, taskText: WORD_TASK }));
    expect(output.claims).toHaveLength(1);
    expect(output.state).toEqual({ available: false });
  });

  it('accepts a task decision', () => {
    const output = requireOk(
      parseWithDomains({ state: { decisions: [{ source: 'task', quote: TASK_DECISION_QUOTE }] } }),
    );
    expect(output.claims).toHaveLength(1);
    expect(output.state).toEqual({
      available: true,
      state: { workItems: [], decisions: [{ source: 'task', quote: TASK_DECISION_QUOTE }] },
    });
  });

  it('accepts an assistant decision', () => {
    const output = requireOk(
      parseWithDomains({
        state: { decisions: [{ source: 'assistant', quote: ASSISTANT_DECISION_QUOTE }] },
      }),
    );
    expect(output.claims).toHaveLength(1);
    expect(output.state).toEqual({
      available: true,
      state: { workItems: [], decisions: [{ source: 'assistant', quote: ASSISTANT_DECISION_QUOTE }] },
    });
  });

  it('rejects a decision quote absent from its declared source', () => {
    const taskSourced = requireOk(
      parseWithDomains({ state: { decisions: [{ source: 'task', quote: ASSISTANT_DECISION_QUOTE }] } }),
    );
    expect(taskSourced.claims).toHaveLength(1);
    expect(taskSourced.state).toEqual({ available: false });

    const assistantSourced = requireOk(
      parseWithDomains({
        state: { decisions: [{ source: 'assistant', quote: TASK_DECISION_QUOTE }] },
        finalText: 'The fix is implemented without further detail.',
      }),
    );
    expect(assistantSourced.claims).toHaveLength(1);
    expect(assistantSourced.state).toEqual({ available: false });
  });

  it('rejects duplicate decisions', () => {
    const output = requireOk(
      parseWithDomains({
        state: {
          decisions: [
            { source: 'task', quote: TASK_DECISION_QUOTE },
            { source: 'task', quote: TASK_DECISION_QUOTE },
          ],
        },
      }),
    );
    expect(output.claims).toHaveLength(1);
    expect(output.state).toEqual({ available: false });
  });

  it('rejects more than 4 decisions', () => {
    const quotes = [
      'The fix is implemented',
      'dashboard',
      'shows',
      'recent activity',
      'implemented and',
    ];
    const decisions = quotes.map((quote) => ({ source: 'assistant', quote }));
    const output = requireOk(parseWithDomains({ state: { decisions } }));
    expect(output.claims).toHaveLength(1);
    expect(output.state).toEqual({ available: false });
  });
});

describe('Supervisor assessment progress domain', () => {
  it('accepts candidates with valid evidence ids', () => {
    const output = requireOk(
      parseWithDomains({ progress: [{ kind: 'implementation', evidence: ['e1', 'e2'] }] }),
    );
    expect(output.claims).toHaveLength(1);
    expect(output.state).toEqual(EMPTY_STATE);
    expect(output.progress).toEqual({
      available: true,
      candidates: [{ kind: 'implementation', evidence: ['e1', 'e2'] }],
    });
  });

  it('rejects an invented evidence id without invalidating claims', () => {
    const output = requireOk(parseWithDomains({ progress: [{ kind: 'research', evidence: ['e9'] }] }));
    expect(output.claims).toHaveLength(1);
    expect(output.progress).toEqual({ available: false });
  });

  it('rejects an empty evidence array', () => {
    const output = requireOk(
      parseWithDomains({ progress: [{ kind: 'verification', evidence: [] }] }),
    );
    expect(output.claims).toHaveLength(1);
    expect(output.progress).toEqual({ available: false });
  });

  it('rejects more than 4 evidence references', () => {
    const evidence = [
      evidenceRecord('e1', 'one'),
      evidenceRecord('e2', 'two'),
      evidenceRecord('e3', 'three'),
      evidenceRecord('e4', 'four'),
      evidenceRecord('e5', 'five'),
    ];
    const output = requireOk(
      parseWithDomains({
        progress: [{ kind: 'diagnosis', evidence: ['e1', 'e2', 'e3', 'e4', 'e5'] }],
        evidence,
      }),
    );
    expect(output.claims).toHaveLength(1);
    expect(output.progress).toEqual({ available: false });
  });

  it('rejects more than 6 candidates', () => {
    const kinds = ['implementation', 'verification', 'diagnosis', 'research'] as const;
    const progress = Array.from({ length: 7 }, (_, index) => ({
      kind: kinds[index % kinds.length],
      evidence: index % 2 === 0 ? ['e1'] : ['e2'],
    }));
    const output = requireOk(parseWithDomains({ progress }));
    expect(output.claims).toHaveLength(1);
    expect(output.progress).toEqual({ available: false });
  });

  it('rejects an unknown kind', () => {
    const output = requireOk(parseWithDomains({ progress: [{ kind: 'planning', evidence: ['e1'] }] }));
    expect(output.claims).toHaveLength(1);
    expect(output.progress).toEqual({ available: false });
  });

  it('rejects duplicate evidence refs inside one candidate', () => {
    const output = requireOk(
      parseWithDomains({ progress: [{ kind: 'verification', evidence: ['e1', 'e1'] }] }),
    );
    expect(output.claims).toHaveLength(1);
    expect(output.progress).toEqual({ available: false });
  });

  it('rejects duplicate candidates', () => {
    const candidate = { kind: 'diagnosis', evidence: ['e1'] };
    const output = requireOk(parseWithDomains({ progress: [candidate, { ...candidate }] }));
    expect(output.claims).toHaveLength(1);
    expect(output.progress).toEqual({ available: false });
  });
});

describe('Supervisor assessment domain isolation', () => {
  it('treats absent domains as available but empty', () => {
    const output = requireOk(parseWithDomains({}));
    expect(output.claims).toHaveLength(1);
    expect(output.state).toEqual(EMPTY_STATE);
    expect(output.progress).toEqual(EMPTY_PROGRESS);
  });

  it('keeps claims and progress when the state domain is malformed', () => {
    const output = requireOk(
      parseWithDomains({
        state: { objective: { quote: 'A paraphrase that appears nowhere' } },
        progress: [{ kind: 'verification', evidence: ['e1'] }],
      }),
    );
    expect(output.claims).toHaveLength(1);
    expect(output.state).toEqual({ available: false });
    expect(output.progress).toEqual({
      available: true,
      candidates: [{ kind: 'verification', evidence: ['e1'] }],
    });
  });

  it('keeps claims and state when the progress domain is malformed', () => {
    const output = requireOk(
      parseWithDomains({
        state: { objective: { quote: OBJECTIVE_QUOTE } },
        progress: [{ kind: 'implementation', evidence: ['invented-id'] }],
      }),
    );
    expect(output.claims).toHaveLength(1);
    expect(output.state).toEqual({
      available: true,
      state: { objective: { quote: OBJECTIVE_QUOTE }, workItems: [], decisions: [] },
    });
    expect(output.progress).toEqual({ available: false });
  });
});

describe('Supervisor assessment prompt domains', () => {
  it('instructs exact-substring state extraction with a closed status set', () => {
    expect(SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT).toContain(
      'exact contiguous substrings of the Root Request',
    );
    expect(SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT).toContain(
      'a work-item status is exactly "open", "in_progress", or "blocked"',
    );
    expect(SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT).toContain(
      'Do not infer done or completed status',
    );
    expect(SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT).toContain('If uncertain, omit');
  });

  it('instructs evidence-backed progress extraction only', () => {
    expect(SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT).toContain(
      '"implementation", "verification", "diagnosis", or "research"',
    );
    expect(SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT).toContain(
      'model text alone is never progress',
    );
    expect(SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT).toContain('Never invent evidence ids');
    expect(SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT).toContain('return "progress": []');
  });
});

function trustedRegistry(): () => readonly unknown[] {
  return () => [
    { name: 'edit', sourceInfo: { source: 'builtin' } },
    { name: 'write', sourceInfo: { source: 'builtin' } },
    { name: 'bash', sourceInfo: { source: 'builtin' } },
    { name: 'read', sourceInfo: { source: 'builtin' } },
  ];
}

function collectedMutation(
  toolName: string,
  input: Record<string, unknown>,
  isError: boolean,
  getAllTools?: () => readonly unknown[],
): boolean | undefined {
  const collector = new SupervisorAssessmentEvidenceCollector(getAllTools);
  collector.observeToolResult({
    type: 'tool_result',
    toolCallId: `${toolName}-call`,
    toolName,
    input,
    content: [{ type: 'text', text: 'result' }],
    isError,
    details: {},
  } as ToolResultEvent);
  const [record] = collector.getRecords();
  return record?.mutation;
}

describe('Supervisor assessment mutation metadata', () => {
  it('marks a successful trusted edit as a mutation', () => {
    expect(collectedMutation('edit', { path: 'src/a.ts' }, false, trustedRegistry())).toBe(true);
  });

  it('marks a successful trusted write as a mutation', () => {
    expect(collectedMutation('write', { path: 'src/a.ts' }, false, trustedRegistry())).toBe(true);
  });

  it('does not mark a failed trusted edit as a mutation', () => {
    expect(collectedMutation('edit', { path: 'src/a.ts' }, true, trustedRegistry())).toBe(false);
  });

  it('does not mark trusted verification or inspection results as mutations', () => {
    expect(collectedMutation('bash', { command: 'pnpm test' }, false, trustedRegistry())).toBe(false);
    expect(collectedMutation('read', { path: 'src/a.ts' }, false, trustedRegistry())).toBe(false);
  });

  it('does not mark an untrusted edit-like tool as a mutation', () => {
    expect(collectedMutation('edit', { path: 'src/a.ts' }, false)).toBe(false);
  });

  it('never exposes mutation metadata to the assessment model', () => {
    const payload = createSupervisorAssessmentPayload({
      taskText: 'task',
      finalAssistantText: 'final',
      evidence: [
        {
          ...evidenceRecord('e1', 'edited src/a.ts'),
          mutationEpoch: 3,
          mutation: true,
          verificationKind: 'test',
        },
      ],
    });
    expect(JSON.parse(payload)).toEqual({
      taskText: 'task',
      finalAssistantText: 'final',
      evidence: [{ id: 'e1', toolName: 'tool', isError: false, text: 'edited src/a.ts' }],
    });
    expect(payload).not.toContain('mutation');
    expect(payload).not.toContain('verificationKind');
  });
});

type MutationKernelHandler = (event: unknown, context: ExtensionContext) => Promise<unknown> | unknown;

class MutationRecordingPi {
  public readonly handlers = new Map<string, MutationKernelHandler>();
  public readonly completionCalls: readonly unknown[] = [];
  private readonly mutableCompletionCalls: unknown[] = [];
  public completionHandler: (model: unknown, context: unknown, options: unknown) => Promise<unknown> =
    async () => ({ stopReason: 'stop', content: [{ type: 'text', text: '{}' }] });
  public model: unknown = undefined;
  public readonly pi: ExtensionAPI;
  public readonly modelRegistry: { complete: (model: unknown, context: unknown, options: unknown) => Promise<unknown> }; 

  public constructor(private readonly tools: readonly unknown[]) {
    this.modelRegistry = {
      complete: (model, context, options): Promise<unknown> => {
        this.mutableCompletionCalls.push({ model, context, options });
        return this.completionHandler(model, context, options);
      },
    };
    this.pi = {
      on: (type: string, handler: unknown): void => {
        this.handlers.set(type, handler as MutationKernelHandler);
      },
      registerCommand: (): void => undefined,
      appendEntry: (): void => undefined,
      sendUserMessage: (): void => undefined,
      getAllTools: (): readonly unknown[] => this.tools,
    } as unknown as ExtensionAPI;
  }

  public context(): ExtensionContext {
    return {
      sessionManager: {
        getBranch: (): readonly unknown[] => [],
        getSessionId: (): string => 'session-1',
      },
      model: this.model,
      modelRegistry: this.modelRegistry,
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
}

function assessmentConsumer(): SupervisorFeatureModule {
  return {
    descriptor: validateSupervisorFeatureDescriptor({
      id: 'assessment-consumer',
      schemaVersion: 1,
      maturity: 'validated',
      defaultMode: 'autonomous',
      observes: ['agent-settled'],
      provides: [],
      requires: ['kernel:assessment'],
      conflictsWith: [],
      usesAuxiliaryModel: true,
      interventionIntents: [],
    }),
    create: () => ({}),
  };
}

function kernelToolResult(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
  text: string,
  isError = false,
): ToolResultEvent {
  return {
    type: 'tool_result',
    toolCallId,
    toolName,
    input,
    content: [{ type: 'text', text }],
    isError,
    details: {},
  } as ToolResultEvent;
}

describe('Supervisor kernel completion-assessment mutation fact', () => {
  it('carries a Kernel-derived mutation boolean that is true only for a successful trusted builtin mutation', async () => {
    const recording = new MutationRecordingPi([
      { name: 'edit', sourceInfo: { source: 'builtin' } },
      { name: 'bash', sourceInfo: { source: 'builtin' } },
    ]);
    const kernel = new SupervisorKernel(recording.pi, [assessmentConsumer()]);
    kernel.register();
    recording.model = { reasoning: false, thinkingLevelMap: {} };
    recording.completionHandler = async () =>
      assessmentEnvelope({
        schemaVersion: 1,
        claims: [{ kind: 'completion', quote: CLAIM_QUOTE, evidence: [] }],
      });

    await recording.emit('input', { type: 'input', source: 'interactive', text: TASK_TEXT });
    await recording.emit('tool_result', kernelToolResult('edit-1', 'edit', { path: 'src/a.ts' }, 'edited src/a.ts'));
    await recording.emit(
      'tool_result',
      kernelToolResult('edit-2', 'edit', { path: 'src/b.ts' }, 'edit failed', true),
    );
    await recording.emit(
      'tool_result',
      kernelToolResult('bash-1', 'bash', { command: 'pnpm test' }, 'tests pass'),
    );
    await recording.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: FINAL_TEXT }] },
      toolResults: [],
    });
    await recording.emit('agent_settled', { type: 'agent_settled' });

    const [fact] = kernel.getFacts();
    expect(fact?.kind).toBe('kernel:completion-assessment');
    const data = fact?.data as { readonly evidence?: readonly unknown[] } | undefined;
    expect(data?.evidence).toEqual([
      {
        id: 'e1',
        toolName: 'edit',
        toolCallId: 'edit-1',
        isError: false,
        inputDigest: expect.any(String),
        resultDigest: expect.any(String),
        mutationEpoch: 1,
        mutation: true,
        verificationKind: null,
      },
      {
        id: 'e2',
        toolName: 'edit',
        toolCallId: 'edit-2',
        isError: true,
        inputDigest: expect.any(String),
        resultDigest: expect.any(String),
        mutationEpoch: 1,
        mutation: false,
        verificationKind: null,
      },
      {
        id: 'e3',
        toolName: 'bash',
        toolCallId: 'bash-1',
        isError: false,
        inputDigest: expect.any(String),
        resultDigest: expect.any(String),
        mutationEpoch: 1,
        mutation: false,
        verificationKind: 'test',
      },
    ]);
  });
});
