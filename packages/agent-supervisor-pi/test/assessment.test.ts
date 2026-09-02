import { describe, expect, it } from 'vitest';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
  ToolResultEvent,
  TurnEndEvent,
} from '@earendil-works/pi-coding-agent';
import { SupervisorAssessmentCapture, SupervisorAssessmentEvidenceCollector } from '../src/assessment/evidence.js';
import { SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT } from '../src/assessment/prompt.js';
import {
  parseSupervisorAssessmentResponse,
  parseSupervisorAssessmentText,
  SUPERVISOR_ASSESSMENT_MAX_CLAIMS,
  SUPERVISOR_ASSESSMENT_MAX_CLAIM_QUOTE_CODE_POINTS,
  SUPERVISOR_ASSESSMENT_MAX_EVIDENCE_REFERENCES_PER_CLAIM,
  SUPERVISOR_ASSESSMENT_MAX_RESPONSE_UTF16_CODE_UNITS,
} from '../src/assessment/parse.js';
import {
  getSupervisorAssessmentReasoningEffort,
  SUPERVISOR_ASSESSMENT_MAX_TOKENS,
  SUPERVISOR_ASSESSMENT_TIMEOUT_MS,
} from '../src/assessment/request.js';
import { computeSupervisorJsonDigest } from '../src/digest.js';
import {
  extractSupervisorAssessmentText,
  isSupervisorAssessmentEnabled,
  SUPERVISOR_ASSESSMENT_EVIDENCE_RECORD_MAX_UTF16_CODE_UNITS,
  SUPERVISOR_ASSESSMENT_EVIDENCE_TOTAL_MAX_UTF16_CODE_UNITS,
  SUPERVISOR_ASSESSMENT_FINAL_ASSISTANT_TEXT_MAX_UTF16_CODE_UNITS,
  SUPERVISOR_ASSESSMENT_MAX_EVIDENCE_RECORDS,
  SUPERVISOR_ASSESSMENT_TASK_TEXT_MAX_UTF16_CODE_UNITS,
} from '../src/assessment/types.js';
import { validateSupervisorFeatureDescriptor } from '../src/feature.js';
import type {
  EffectiveFeatureMode,
  SupervisorFeatureDescriptor,
  SupervisorFeatureMode,
} from '../src/feature.js';
import { SupervisorKernel } from '../src/kernel/kernel.js';
import type { SupervisorFeatureModule, SupervisorFeatureRuntime } from '../src/module.js';
import type { ResolvedSupervisorFeature, SupervisorPlan } from '../src/registry.js';

const CAPABILITY = 'kernel:assessment';

type EventHandler = (event: unknown, context: ExtensionContext) => Promise<unknown> | unknown;
type CompletionHandler = (model: unknown, context: unknown, options: unknown) => Promise<unknown>;

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

class AssessmentRecordingPi {
  public readonly handlers = new Map<string, EventHandler>();
  public readonly commands = new Map<string, (args: string, context: ExtensionCommandContext) => Promise<void>>();
  public readonly notifications: string[] = [];

  public readonly pi: ExtensionAPI;

  public readonly completionCalls: { readonly model: unknown; readonly context: unknown; readonly options: unknown }[] = [];

  public completionHandler: CompletionHandler = async () => assessmentResponse('{}');

  public model: unknown = undefined;

  public sessionId = 'session-1';

  private readonly branch: SessionEntry[];

  public readonly modelRegistry: { complete: CompletionHandler };

  public constructor(initialBranch: readonly SessionEntry[] = []) {
    this.branch = [...initialBranch];
    this.modelRegistry = {
      complete: (model, context, options): Promise<unknown> => {
        this.completionCalls.push({ model, context, options });
        return this.completionHandler(model, context, options);
      },
    };
    this.pi = {
      on: (type: string, handler: unknown): void => {
        this.handlers.set(type, handler as EventHandler);
      },
      registerCommand: (name: string, options: { handler: (args: string, context: ExtensionCommandContext) => Promise<void> }): void => {
        this.commands.set(name, options.handler);
      },
      appendEntry: (customType: string, data?: unknown): void => {
        this.branch.push(customEntry(customType, data));
      },
      sendUserMessage: (): void => undefined,
    } as unknown as ExtensionAPI;
  }

  public context(): ExtensionContext {
    return {
      sessionManager: {
        getBranch: (): SessionEntry[] => this.branch,
        getSessionId: (): string => this.sessionId,
      },
      model: this.model,
      modelRegistry: this.modelRegistry,
      ui: {
        notify: (message: string): void => {
          this.notifications.push(message);
        },
      },
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
    await handler(args, this.context() as unknown as ExtensionCommandContext);
  }
}


function descriptor(
  requires: readonly string[] = [CAPABILITY],
  id = 'assessment-consumer',
  observes: readonly string[] = [],
): SupervisorFeatureDescriptor {
  return validateSupervisorFeatureDescriptor({
    id,
    schemaVersion: 1,
    maturity: 'validated',
    defaultMode: 'autonomous',
    observes: [...observes],
    provides: [],
    requires: [...requires],
    conflictsWith: [],
    usesAuxiliaryModel: true,
    interventionIntents: [],
  });
}

type AssessmentObservationHandler = NonNullable<SupervisorFeatureRuntime<never>['onObservation']>;

function assessmentConsumer(
  id = 'assessment-consumer',
  onObservation?: AssessmentObservationHandler,
): SupervisorFeatureModule {
  return {
    descriptor: descriptor([CAPABILITY], id, ['agent-settled']),
    create: () => (onObservation === undefined ? {} : { onObservation }),
  };
}

function assessmentFeature(
  effectiveMode: EffectiveFeatureMode,
): ResolvedSupervisorFeature {
  const requestedMode: SupervisorFeatureMode | null =
    effectiveMode === 'unavailable' ? null : effectiveMode;
  return {
    id: 'assessment-consumer',
    requestedMode,
    effectiveMode,
    descriptor: descriptor(),
  };
}

function planWith(effectiveMode: EffectiveFeatureMode): SupervisorPlan {
  return {
    configStatus: 'valid',
    configDiagnostics: [],
    requestedGlobalMode: 'autonomous',
    effectiveGlobalMode: 'autonomous',
    features: [assessmentFeature(effectiveMode)],
  };
}

function toolResultEvent(
  toolCallId: string,
  text: string,
  isError = false,
  input: Record<string, unknown> = { secret: 'private input' },
): ToolResultEvent {
  return {
    type: 'tool_result',
    toolCallId,
    toolName: 'custom-tool',
    input,
    content: [{ type: 'text', text }],
    isError,
    details: { private: 'details' },
  } as ToolResultEvent;
}

function turnEndEvent(content: readonly unknown[]): TurnEndEvent {
  return {
    type: 'turn_end',
    turnIndex: 1,
    message: {
      role: 'assistant',
      content,
    },
    toolResults: [],
  } as unknown as TurnEndEvent;
}

function inputEvent(source: 'interactive' | 'rpc' | 'extension', text: string): unknown {
  return { type: 'input', source, text };
}

function blockingFeature(): SupervisorFeatureModule {
  return {
    descriptor: validateSupervisorFeatureDescriptor({
      id: 'blocker',
      schemaVersion: 1,
      maturity: 'validated',
      defaultMode: 'autonomous',
      observes: ['before-tool-call'],
      provides: [],
      requires: [],
      conflictsWith: [],
      usesAuxiliaryModel: false,
      interventionIntents: ['stop'],
    }),
    create: () => ({
      onObservation: (observation) => observation.kind === 'before-tool-call'
        ? {
            interventions: [{
              sourceFeatureId: 'blocker',
              boundary: 'tool-call',
              intent: 'stop',
              delivery: 'block',
              priority: 1,
              reasonCode: 'blocker:stop',
              message: 'blocked',
              targetToolCallId: 'blocked-tool',
            }],
          }
        : undefined,
    }),
  };
}

function captureObserver(onObservation: AssessmentObservationHandler): SupervisorFeatureModule {
  return {
    descriptor: validateSupervisorFeatureDescriptor({
      id: 'capture-observer',
      schemaVersion: 1,
      maturity: 'validated',
      defaultMode: 'autonomous',
      observes: ['tool-result', 'turn-ended'],
      provides: [],
      requires: [],
      conflictsWith: [],
      usesAuxiliaryModel: false,
      interventionIntents: [],
    }),
    create: () => ({ onObservation }),
  };
}

describe('Supervisor assessment activation', () => {
  it('extracts only text blocks and concatenates them', () => {
    expect(
      extractSupervisorAssessmentText([
        { type: 'text', text: 'first' },
        { type: 'image', data: 'private image' },
        { type: 'thinking', thinking: 'private thinking' },
        { type: 'text', text: 'second' },
      ]),
    ).toBe('firstsecond');
  });

  it('returns false when there is no assessment consumer', () => {
    expect(isSupervisorAssessmentEnabled(undefined)).toBe(false);
    expect(isSupervisorAssessmentEnabled({ ...planWith('off'), features: [] })).toBe(false);
  });

  it.each([
    ['autonomous', true],
    ['observe', true],
    ['off', false],
    ['unavailable', false],
  ] as const)('activates only for an enabled %s consumer', (effectiveMode, expected) => {
    expect(isSupervisorAssessmentEnabled(planWith(effectiveMode))).toBe(expected);
  });

  it('requires the assessment capability in the enabled consumer', () => {
    const plan = { ...planWith('autonomous'), features: [
      { ...assessmentFeature('autonomous'), descriptor: descriptor(['other:capability']) },
    ] };
    expect(isSupervisorAssessmentEnabled(plan)).toBe(false);
  });
});

describe('Supervisor assessment capture', () => {
  it('retains the first bounded task units and clears response data for a new root', () => {
    const capture = new SupervisorAssessmentCapture();
    const task = `front${'x'.repeat(SUPERVISOR_ASSESSMENT_TASK_TEXT_MAX_UTF16_CODE_UNITS)}tail`;

    capture.beginRootRequest(task);
    capture.observeTurnEnd(turnEndEvent([{ type: 'text', text: 'old response' }]));
    capture.observeToolResult(toolResultEvent('tool-1', 'old result'));
    expect(capture.getTaskText()).toBe(task.slice(0, SUPERVISOR_ASSESSMENT_TASK_TEXT_MAX_UTF16_CODE_UNITS));

    capture.beginRootRequest('new task');

    expect(capture.getTaskText()).toBe('new task');
    expect(capture.getFinalAssistantText()).toBeUndefined();
    expect(capture.getEvidence()).toEqual([]);
  });

  it('retains the latest assistant text, bounded to its tail, and treats empty text as absent', () => {
    const capture = new SupervisorAssessmentCapture();
    const response = `head${'x'.repeat(SUPERVISOR_ASSESSMENT_FINAL_ASSISTANT_TEXT_MAX_UTF16_CODE_UNITS)}tail`;

    capture.beginRootRequest('task');
    capture.observeTurnEnd(turnEndEvent([{ type: 'text', text: 'older response' }]));
    capture.observeTurnEnd(turnEndEvent([
      { type: 'image', data: 'private image' },
      { type: 'text', text: response },
    ]));

    expect(capture.getFinalAssistantText()).toBe(
      response.slice(-SUPERVISOR_ASSESSMENT_FINAL_ASSISTANT_TEXT_MAX_UTF16_CODE_UNITS),
    );
    capture.observeTurnEnd(turnEndEvent([{ type: 'text', text: '' }]));
    expect(capture.getFinalAssistantText()).toBeUndefined();
  });

  it('collects only tool-result evidence and preserves bounded metadata without raw input', () => {
    const collector = new SupervisorAssessmentEvidenceCollector();
    const event = toolResultEvent('tool-1', 'tool conclusion', true, { secret: 'do not retain' });

    collector.observeToolResult(event);
    const [record] = collector.getRecords();

    expect(record).toMatchObject({
      id: 'e1',
      toolName: 'custom-tool',
      toolCallId: 'tool-1',
      isError: true,
      inputDigest: expect.any(String),
      resultDigest: expect.any(String),
      text: 'tool conclusion',
    });
    expect(JSON.stringify(record)).not.toContain('do not retain');
  });

  it('retains the most recent records and applies the total budget newest-first', () => {
    const collector = new SupervisorAssessmentEvidenceCollector();
    const text = 'a'.repeat(SUPERVISOR_ASSESSMENT_EVIDENCE_RECORD_MAX_UTF16_CODE_UNITS + 100);

    for (let index = 1; index <= SUPERVISOR_ASSESSMENT_MAX_EVIDENCE_RECORDS + 2; index += 1) {
      collector.observeToolResult(toolResultEvent(`tool-${index}`, text));
    }

    const records = collector.getRecords();
    const textUnits = records.map((record) => record.text.length);

    expect(records.map((record) => record.id)).toEqual(['e5', 'e6', 'e7', 'e8', 'e9', 'e10']);
    expect(textUnits).toEqual([4_000, 4_000, 4_000, 4_000, 4_000, 4_000]);
    expect(textUnits.reduce((total, units) => total + units, 0)).toBe(
      SUPERVISOR_ASSESSMENT_EVIDENCE_TOTAL_MAX_UTF16_CODE_UNITS,
    );
  });
});

describe('Supervisor assessment Kernel lifecycle wiring', () => {
  it('does not replace task text or clear evidence for extension input, but does reset for a new root', async () => {
    const recording = new AssessmentRecordingPi();
    const kernel = new SupervisorKernel(recording.pi, []);
    kernel.register();

    await recording.emit('input', inputEvent('interactive', 'original task'));
    await recording.emit('tool_result', toolResultEvent('tool-1', 'result'));
    await recording.emit('turn_end', turnEndEvent([{ type: 'text', text: 'final answer' }]));
    const beforeExtension = kernel.getAssessmentInput();

    await recording.emit('input', inputEvent('extension', 'internal continuation'));
    expect(kernel.getAssessmentInput()).toEqual(beforeExtension);

    await recording.emit('input', inputEvent('rpc', 'replacement task'));
    expect(kernel.getAssessmentInput()).toEqual({ taskText: 'replacement task', evidence: [] });
  });

  it('starts a resumed session with empty assessment data', async () => {
    const recording = new AssessmentRecordingPi();
    const kernel = new SupervisorKernel(recording.pi, []);
    kernel.register();

    await recording.emit('input', inputEvent('interactive', 'task'));
    await recording.emit('tool_result', toolResultEvent('tool-1', 'result'));
    await recording.emit('session_start', { type: 'session_start', reason: 'resume' });

    expect(kernel.getAssessmentInput()).toEqual({ evidence: [] });
  });

  it('contains malformed assessment content without degrading Kernel or suppressing observations', async () => {
    const recording = new AssessmentRecordingPi();
    const observations: string[] = [];
    const kernel = new SupervisorKernel(recording.pi, [
      captureObserver((observation) => {
        observations.push(observation.kind);
      }),
    ]);
    kernel.register();

    await recording.emit('input', inputEvent('interactive', 'task'));
    await recording.emit('tool_result', {
      type: 'tool_result',
      toolCallId: 'tool-1',
      toolName: 'custom-tool',
      input: { secret: 'private input' },
      content: { invalid: true },
      isError: false,
      details: {},
    });
    await recording.emit('turn_end', {
      type: 'turn_end',
      turnIndex: 1,
      message: { role: 'assistant', content: { invalid: true } },
      toolResults: [],
    });

    expect(kernel.getHealth()).toBe('healthy');
    expect(observations).toEqual(['tool-result', 'turn-ended']);
    expect(kernel.getAssessmentInput()).toEqual({ taskText: 'task', evidence: [] });
  });

  it('cannot collect evidence from a blocked tool call because no tool result is observed', async () => {
    const recording = new AssessmentRecordingPi();
    const kernel = new SupervisorKernel(recording.pi, [blockingFeature()]);
    kernel.register();

    await recording.emit('input', inputEvent('interactive', 'task'));
    const result = await recording.emit('tool_call', {
      type: 'tool_call',
      toolCallId: 'blocked-tool',
      toolName: 'custom-tool',
      input: { secret: 'blocked input' },
    });

    expect(result).toEqual({ block: true, reason: 'blocked' });
    expect(kernel.getAssessmentInput().evidence).toEqual([]);
  });
});


type AssessmentProviderResponse = {
  stopReason: string;
  content: readonly unknown[];
};

function assessmentResponse(text: string, stopReason = 'stop'): AssessmentProviderResponse {
  return {
    stopReason,
    content: [{ type: 'text', text }],
  };
}

function assessmentJson(value: unknown): string {
  return JSON.stringify(value);
}

function assessmentEvidence(id: string, text: string): {
  readonly id: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly isError: boolean;
  readonly inputDigest: string | null;
  readonly resultDigest: string | null;
  readonly text: string;
} {
  return {
    id,
    toolName: 'tool',
    toolCallId: `${id}-call`,
    isError: false,
    inputDigest: null,
    resultDigest: null,
    text,
  };
}

function assessmentOutput(
  claimQuote: string,
  evidence: readonly unknown[] = [],
  kind: 'completion' | 'verification' = 'completion',
): string {
  return assessmentJson({
    schemaVersion: 1,
    claims: [{ kind, quote: claimQuote, evidence }],
  });
}

describe('Supervisor assessment prompt', () => {
  it('states the bounded extraction and exact-source contract', () => {
    expect(SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT).toContain('bounded claim/evidence extractor');
    expect(SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT).toContain(
      'Use ONLY the supplied final assistant response and the supplied tool evidence.',
    );
    expect(SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT).toContain(
      'Extract affirmative COMPLETION or VERIFICATION claims only.',
    );
    expect(SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT).toContain(
      'Every claim quote MUST be an exact contiguous substring of the final assistant response',
    );
    expect(SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT).toContain(
      'Every evidence reference MUST use a supplied evidence id.',
    );
    expect(SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT).toContain(
      "Every evidence quote MUST be an exact contiguous substring of THAT evidence record's bounded text",
    );
    expect(SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT).toContain(
      'Evidence shows only what it literally shows; do not infer root cause or success beyond it.',
    );
    expect(SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT).toContain(
      'If no completion or verification claim exists, return claims: [].',
    );
    expect(SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT).toContain(
      'If a claim has no supporting supplied evidence, return evidence: [].',
    );
    expect(SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT).toContain('Never fabricate support or invent evidence.');
    expect(SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT).toContain(
      'A verification claim is still only a claim; do not judge whether it is true.',
    );
    expect(SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT).toContain(
      'Do not decide whether to continue, intervene, or run another turn.',
    );
    expect(SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT).toContain('Return JSON only.');
    expect(SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT).toContain(
      'Plans, intentions, possibilities, questions, future work, and conditional statements are NOT claims.',
    );
  });
});

describe('Supervisor assessment response envelope', () => {
  const finalText = 'The fix is implemented.';
  const evidence: readonly ReturnType<typeof assessmentEvidence>[] = [];

  it('accepts stop plus non-empty text', () => {
    expect(parseSupervisorAssessmentText(assessmentResponse('{}'))).toEqual({ ok: true, text: '{}' });
  });

  it('rejects an aborted stop reason', () => {
    expect(parseSupervisorAssessmentText(assessmentResponse('{}', 'aborted'))).toEqual({
      ok: false,
      failureKind: 'aborted',
    });
  });

  it('rejects every other stop reason', () => {
    expect(parseSupervisorAssessmentText(assessmentResponse('{}', 'length'))).toEqual({
      ok: false,
      failureKind: 'provider',
    });
  });

  it('rejects a non-text response', () => {
    expect(parseSupervisorAssessmentText({ stopReason: 'stop', content: [{ type: 'image' }] })).toEqual({
      ok: false,
      failureKind: 'invalid-response',
    });
  });

  it('rejects empty text', () => {
    expect(parseSupervisorAssessmentText(assessmentResponse('  \n\t'))).toEqual({
      ok: false,
      failureKind: 'invalid-response',
    });
  });

  it('strips one surrounding markdown code fence', () => {
    expect(parseSupervisorAssessmentText(assessmentResponse('```json\n{}\n```'))).toEqual({
      ok: true,
      text: '{}',
    });
  });

  it('does not accept prose around JSON', () => {
    const response = assessmentResponse('Here is the result:\n{}');
    expect(parseSupervisorAssessmentResponse(response, finalText, evidence)).toEqual({
      ok: false,
      failureKind: 'invalid-output',
    });
  });
});

describe('Supervisor assessment structural validation', () => {
  const finalText = 'The fix is implemented and tests pass.';
  const evidence = [assessmentEvidence('e1', 'tests pass'), assessmentEvidence('e2', 'fix implemented')];

  it('accepts an exact claim substring', () => {
    const result = parseSupervisorAssessmentResponse(
      assessmentResponse(assessmentOutput('The fix is implemented')),
      finalText,
      evidence,
    );
    expect(result).toEqual({
      ok: true,
      output: {
        claims: [{ kind: 'completion', quote: 'The fix is implemented', evidence: [] }],
      },
    });
  });

  it('rejects a paraphrased claim', () => {
    expect(
      parseSupervisorAssessmentResponse(
        assessmentResponse(assessmentOutput('The implementation is complete')),
        finalText,
        evidence,
      ),
    ).toEqual({ ok: false, failureKind: 'invalid-output' });
  });

  it('rejects a claim absent from the final assistant text', () => {
    expect(
      parseSupervisorAssessmentResponse(
        assessmentResponse(assessmentOutput('The fix is implemented.')),
        finalText,
        evidence,
      ),
    ).toEqual({ ok: false, failureKind: 'invalid-output' });
  });

  it('rejects an oversized claim by Unicode code points', () => {
    const claim = '😀'.repeat(SUPERVISOR_ASSESSMENT_MAX_CLAIM_QUOTE_CODE_POINTS + 1);
    expect(
      parseSupervisorAssessmentResponse(
        assessmentResponse(assessmentOutput(claim)),
        claim,
        evidence,
      ),
    ).toEqual({ ok: false, failureKind: 'invalid-output' });
  });

  it('accepts a claim at the Unicode code-point bound', () => {
    const claim = '😀'.repeat(SUPERVISOR_ASSESSMENT_MAX_CLAIM_QUOTE_CODE_POINTS);
    expect(
      parseSupervisorAssessmentResponse(
        assessmentResponse(assessmentOutput(claim)),
        claim,
        evidence,
      ),
    ).toMatchObject({ ok: true });
  });

  it('rejects duplicate exact claim quotes', () => {
    const output = assessmentJson({
      schemaVersion: 1,
      claims: [
        { kind: 'completion', quote: 'The fix is implemented', evidence: [] },
        { kind: 'verification', quote: 'The fix is implemented', evidence: [] },
      ],
    });
    expect(parseSupervisorAssessmentResponse(assessmentResponse(output), finalText, evidence)).toEqual({
      ok: false,
      failureKind: 'invalid-output',
    });
  });

  it('accepts an existing evidence id and exact evidence quote', () => {
    const response = assessmentResponse(assessmentOutput('tests pass', [{ id: 'e1', quote: 'tests pass' }], 'verification'));
    const result = parseSupervisorAssessmentResponse(response, finalText, evidence);
    expect(result).toEqual({
      ok: true,
      output: {
        claims: [{
          kind: 'verification',
          quote: 'tests pass',
          evidence: [{ id: 'e1', quoteHash: computeSupervisorJsonDigest('tests pass') }],
        }],
      },
    });
  });

  it('rejects an invented evidence id', () => {
    expect(
      parseSupervisorAssessmentResponse(
        assessmentResponse(assessmentOutput('tests pass', [{ id: 'e9', quote: 'tests pass' }], 'verification')),
        finalText,
        evidence,
      ),
    ).toEqual({ ok: false, failureKind: 'invalid-output' });
  });

  it('rejects a fuzzy or non-contiguous evidence quote', () => {
    const fuzzy = assessmentOutput('tests pass', [{ id: 'e1', quote: 'test pass' }], 'verification');
    const nonContiguous = assessmentOutput('tests pass', [{ id: 'e1', quote: 'tests  pass' }], 'verification');
    expect(parseSupervisorAssessmentResponse(assessmentResponse(fuzzy), finalText, evidence)).toEqual({
      ok: false,
      failureKind: 'invalid-output',
    });
    expect(parseSupervisorAssessmentResponse(assessmentResponse(nonContiguous), finalText, evidence)).toEqual({
      ok: false,
      failureKind: 'invalid-output',
    });
  });

  it('rejects a quote belonging to a different evidence id', () => {
    expect(
      parseSupervisorAssessmentResponse(
        assessmentResponse(assessmentOutput('tests pass', [{ id: 'e2', quote: 'tests pass' }], 'verification')),
        finalText,
        evidence,
      ),
    ).toEqual({ ok: false, failureKind: 'invalid-output' });
  });

  it('rejects duplicate evidence refs within one claim', () => {
    const output = assessmentJson({
      schemaVersion: 1,
      claims: [{
        kind: 'verification',
        quote: 'tests pass',
        evidence: [
          { id: 'e1', quote: 'tests pass' },
          { id: 'e1', quote: 'tests pass' },
        ],
      }],
    });
    expect(parseSupervisorAssessmentResponse(assessmentResponse(output), finalText, evidence)).toEqual({
      ok: false,
      failureKind: 'invalid-output',
    });
  });

  it('accepts a claim with no evidence references', () => {
    expect(
      parseSupervisorAssessmentResponse(
        assessmentResponse(assessmentOutput('The fix is implemented')),
        finalText,
        [],
      ),
    ).toMatchObject({ ok: true, output: { claims: [{ evidence: [] }] } });
  });

  it('rejects more than four claims', () => {
    const claims = Array.from({ length: SUPERVISOR_ASSESSMENT_MAX_CLAIMS + 1 }, (_, index) => ({
      kind: 'completion',
      quote: `Claim ${index}`,
      evidence: [],
    }));
    const response = assessmentResponse(assessmentJson({ schemaVersion: 1, claims }));
    expect(parseSupervisorAssessmentResponse(response, claims.map((claim) => claim.quote).join(' '), [])).toEqual({
      ok: false,
      failureKind: 'invalid-output',
    });
  });

  it('rejects more than four evidence references', () => {
    const refs = Array.from({ length: SUPERVISOR_ASSESSMENT_MAX_EVIDENCE_REFERENCES_PER_CLAIM + 1 }, (_, index) => ({
      id: `e${index + 1}`,
      quote: `evidence ${index + 1}`,
    }));
    const records = refs.map((reference) => assessmentEvidence(reference.id, reference.quote));
    const response = assessmentResponse(assessmentOutput('The fix is implemented', refs));
    expect(parseSupervisorAssessmentResponse(response, finalText, records)).toEqual({
      ok: false,
      failureKind: 'invalid-output',
    });
  });

  it('accepts an empty claims array', () => {
    expect(
      parseSupervisorAssessmentResponse(
        assessmentResponse(assessmentJson({ schemaVersion: 1, claims: [] })),
        finalText,
        evidence,
      ),
    ).toEqual({ ok: true, output: { claims: [] } });
  });

  it('discards evidence quote text and keeps a stable canonical hash', () => {
    const quote = 'tests pass';
    const result = parseSupervisorAssessmentResponse(
      assessmentResponse(assessmentOutput('The fix is implemented', [{ id: 'e1', quote }])),
      finalText,
      evidence,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(JSON.stringify(result.output)).not.toContain(quote);
    expect(result.output.claims[0]?.evidence[0]?.quoteHash).toBe(computeSupervisorJsonDigest(quote));
    expect(result.output.claims[0]?.evidence[0]?.quoteHash).toBe(computeSupervisorJsonDigest('tests pass'));
  });
});


type AssessmentRequestContext = {
  readonly systemPrompt?: unknown;
  readonly messages?: readonly { readonly content?: unknown }[];
};

type AssessmentCompletionOptions = {
  readonly signal?: AbortSignal;
  readonly maxTokens?: number;
  readonly reasoningEffort?: unknown;
};

function assessmentModel(overrides: Record<string, unknown> = {}): unknown {
  return {
    reasoning: false,
    thinkingLevelMap: {},
    ...overrides,
  };
}

function assessmentDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createAssessmentKernel(
  recording: AssessmentRecordingPi,
  features: readonly SupervisorFeatureModule[],
  timeoutMs?: number,
): SupervisorKernel {
  const kernel = timeoutMs === undefined
    ? new SupervisorKernel(recording.pi, features)
    : new SupervisorKernel(recording.pi, features, { assessmentTimeoutMs: timeoutMs });
  kernel.register();
  return kernel;
}

const ASSESSMENT_FINAL_TEXT = 'The fix is implemented.';
const ASSESSMENT_CLAIM_QUOTE = 'The fix is implemented';

async function settleCurrentAssessmentRun(
  recording: AssessmentRecordingPi,
  finalText = ASSESSMENT_FINAL_TEXT,
): Promise<void> {
  await recording.emit('turn_end', turnEndEvent([{ type: 'text', text: finalText }]));
  await recording.emit('agent_settled', { type: 'agent_settled' });
}

async function settleAssessmentRoot(
  recording: AssessmentRecordingPi,
  finalText = ASSESSMENT_FINAL_TEXT,
  evidenceText?: string,
): Promise<void> {
  await recording.emit('input', inputEvent('interactive', 'task'));
  if (evidenceText !== undefined) {
    await recording.emit('tool_result', toolResultEvent('tool-1', evidenceText));
  }
  await settleCurrentAssessmentRun(recording, finalText);
}

describe('Supervisor assessment Kernel requests', () => {
  it('makes no auxiliary call for a production-style kernel with no consumers', async () => {
    const recording = new AssessmentRecordingPi();
    const kernel = createAssessmentKernel(recording, []);
    recording.model = assessmentModel();
    recording.completionHandler = async () => assessmentResponse(assessmentOutput(ASSESSMENT_CLAIM_QUOTE));

    await settleAssessmentRoot(recording);

    expect(recording.completionCalls).toHaveLength(0);
    expect(kernel.getFacts()).toEqual([]);
  });

  it('makes one bounded call for one active consumer', async () => {
    const recording = new AssessmentRecordingPi();
    const kernel = createAssessmentKernel(recording, [assessmentConsumer()]);
    recording.model = assessmentModel();
    recording.completionHandler = async () => assessmentResponse(assessmentOutput(ASSESSMENT_CLAIM_QUOTE));

    await settleAssessmentRoot(recording);

    expect(recording.completionCalls).toHaveLength(1);
    expect(kernel.getFacts()).toHaveLength(1);
  });

  it('shares one call between two consumers', async () => {
    const recording = new AssessmentRecordingPi();
    const kernel = createAssessmentKernel(recording, [
      assessmentConsumer('assessment-a'),
      assessmentConsumer('assessment-b'),
    ]);
    recording.model = assessmentModel();
    recording.completionHandler = async () => assessmentResponse(assessmentOutput(ASSESSMENT_CLAIM_QUOTE));

    await settleAssessmentRoot(recording);

    expect(recording.completionCalls).toHaveLength(1);
    expect(kernel.getFacts()).toHaveLength(1);
  });

  it('deduplicates a duplicate settled event and permits one later run in the same root', async () => {
    const recording = new AssessmentRecordingPi();
    const kernel = createAssessmentKernel(recording, [assessmentConsumer()]);
    recording.model = assessmentModel();
    recording.completionHandler = async () => assessmentResponse(assessmentOutput(ASSESSMENT_CLAIM_QUOTE));

    await settleAssessmentRoot(recording);
    await recording.emit('agent_settled', { type: 'agent_settled' });
    expect(recording.completionCalls).toHaveLength(1);

    await recording.emit('input', inputEvent('extension', 'supervisor follow-up'));
    await settleCurrentAssessmentRun(recording);

    expect(recording.completionCalls).toHaveLength(2);
    expect(kernel.getFacts().map((fact) => (fact.data as { assessmentId: string }).assessmentId)).toEqual([
      'assessment-1',
      'assessment-2',
    ]);
  });

  it.each([
    ['feature off', 'feature assessment-consumer off', 0],
    ['feature observe', 'feature assessment-consumer observe', 1],
    ['global observe', 'mode observe', 1],
    ['global off', 'mode off', 0],
  ] as const)('honors %s assessment activation', async (_label, command, expectedCalls) => {
    const recording = new AssessmentRecordingPi();
    const kernel = createAssessmentKernel(recording, [assessmentConsumer()]);
    recording.model = assessmentModel();
    recording.completionHandler = async () => assessmentResponse(assessmentOutput(ASSESSMENT_CLAIM_QUOTE));

    await recording.command(command);
    await settleAssessmentRoot(recording);

    expect(recording.completionCalls).toHaveLength(expectedCalls);
    expect(kernel.getFacts()).toHaveLength(expectedCalls);
  });

  it('skips when there is no active model', async () => {
    const recording = new AssessmentRecordingPi();
    const kernel = createAssessmentKernel(recording, [assessmentConsumer()]);

    await settleAssessmentRoot(recording);

    expect(recording.completionCalls).toHaveLength(0);
    expect(kernel.getFacts()).toEqual([]);
  });

  it('skips when the settled run has no final assistant text', async () => {
    const recording = new AssessmentRecordingPi();
    const kernel = createAssessmentKernel(recording, [assessmentConsumer()]);
    recording.model = assessmentModel();

    await recording.emit('input', inputEvent('interactive', 'task'));
    await recording.emit('agent_settled', { type: 'agent_settled' });

    expect(recording.completionCalls).toHaveLength(0);
    expect(kernel.getFacts()).toEqual([]);
  });

  it('skips when there is no current Root Request', async () => {
    const recording = new AssessmentRecordingPi();
    const kernel = createAssessmentKernel(recording, [assessmentConsumer()]);
    recording.model = assessmentModel();

    await recording.emit('agent_settled', { type: 'agent_settled' });

    expect(recording.completionCalls).toHaveLength(0);
    expect(kernel.getFacts()).toEqual([]);
  });

  it('uses the bounded payload, token cap, and lowest concretely mapped reasoning level', async () => {
    const recording = new AssessmentRecordingPi();
    const kernel = createAssessmentKernel(recording, [assessmentConsumer()]);
    recording.model = assessmentModel({
      reasoning: true,
      thinkingLevelMap: {
        off: 'none',
        minimal: null,
        low: '',
        medium: 'mapped-medium',
        high: 'mapped-high',
      },
    });
    expect(SUPERVISOR_ASSESSMENT_TIMEOUT_MS).toBe(20_000);
    expect(getSupervisorAssessmentReasoningEffort({
      reasoning: true,
      thinkingLevelMap: { off: 'none', minimal: null, low: '', medium: 'mapped-medium' },
    } as Parameters<typeof getSupervisorAssessmentReasoningEffort>[0])).toBe('medium');
    recording.completionHandler = async () => assessmentResponse(assessmentOutput(ASSESSMENT_CLAIM_QUOTE, [
      { id: 'e1', quote: 'tests pass' },
    ], 'verification'));

    await settleAssessmentRoot(recording, ASSESSMENT_FINAL_TEXT, 'tests pass');

    const call = recording.completionCalls[0];
    expect(call).toBeDefined();
    if (call === undefined) {
      return;
    }
    const requestContext = call.context as AssessmentRequestContext;
    const message = requestContext.messages?.[0];
    expect(requestContext.systemPrompt).toBe(SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT);
    expect(message).toBeDefined();
    if (message === undefined) {
      return;
    }
    expect(JSON.parse(String(message.content))).toEqual({
      taskText: 'task',
      finalAssistantText: ASSESSMENT_FINAL_TEXT,
      evidence: [{ id: 'e1', toolName: 'custom-tool', isError: false, text: 'tests pass' }],
    });
    expect(String(message.content)).not.toContain('private input');
    expect(String(message.content)).not.toContain('tool-1');

    const options = call.options as AssessmentCompletionOptions;
    expect(call.model).toBe(recording.model);
    expect(options.maxTokens).toBe(SUPERVISOR_ASSESSMENT_MAX_TOKENS);
    expect(options.reasoningEffort).toBe('medium');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal).not.toBe((recording.context() as unknown as { signal?: unknown }).signal);
    expect(kernel.getHealth()).toBe('healthy');
  });

  it('aborts a timed-out assessment without degrading Kernel health', async () => {
    const recording = new AssessmentRecordingPi();
    const kernel = createAssessmentKernel(recording, [assessmentConsumer()], 1);
    recording.model = assessmentModel();
    let signal: AbortSignal | undefined;
    recording.completionHandler = async (_model, _context, options) => {
      signal = (options as AssessmentCompletionOptions).signal;
      return new Promise<unknown>(() => undefined);
    };

    await settleAssessmentRoot(recording);

    expect(signal?.aborted).toBe(true);
    expect(kernel.getFacts()).toEqual([]);
    expect(kernel.getHealth()).toBe('healthy');
    await recording.command('status');
    const status = recording.notifications.at(-1) ?? '';
    expect(status).toContain('Kernel health: healthy');
    expect(status).toContain('Assessment: failed(timeout)');
    expect(status.match(/^Assessment:/gmu)).toHaveLength(1);
  });

  it('discards a response after the Root Request identity changes', async () => {
    const recording = new AssessmentRecordingPi();
    const kernel = createAssessmentKernel(recording, [assessmentConsumer()]);
    recording.model = assessmentModel();
    const response = assessmentDeferred<unknown>();
    const started = assessmentDeferred<void>();
    let signal: AbortSignal | undefined;
    recording.completionHandler = async (_model, _context, options) => {
      signal = (options as AssessmentCompletionOptions).signal;
      started.resolve(undefined);
      return response.promise;
    };

    await recording.emit('input', inputEvent('interactive', 'task'));
    await recording.emit('turn_end', turnEndEvent([{ type: 'text', text: ASSESSMENT_FINAL_TEXT }]));
    const settled = recording.emit('agent_settled', { type: 'agent_settled' });
    await started.promise;
    await recording.emit('input', inputEvent('interactive', 'replacement task'));
    response.resolve(assessmentResponse(assessmentOutput(ASSESSMENT_CLAIM_QUOTE)));
    await settled;

    expect(signal?.aborted).toBe(true);
    expect(kernel.getCurrentRoot()?.id).toBe('root-2');
    expect(kernel.getFacts()).toEqual([]);
    expect(kernel.getHealth()).toBe('healthy');
  });

  it('dispatches agent-settled when an assessment result is stale', async () => {
    const recording = new AssessmentRecordingPi();
    const observations: string[] = [];
    const kernel = createAssessmentKernel(recording, [assessmentConsumer(
      'assessment-observer',
      (observation) => {
        observations.push(observation.kind);
      },
    )]);
    recording.model = assessmentModel();
    const response = assessmentDeferred<unknown>();
    const started = assessmentDeferred<void>();
    recording.completionHandler = async () => {
      started.resolve(undefined);
      return response.promise;
    };

    await recording.emit('input', inputEvent('interactive', 'task'));
    await recording.emit('turn_end', turnEndEvent([{ type: 'text', text: ASSESSMENT_FINAL_TEXT }]));
    const settled = recording.emit('agent_settled', { type: 'agent_settled' });
    await started.promise;
    await recording.emit('input', inputEvent('interactive', 'replacement task'));
    response.resolve(assessmentResponse(assessmentOutput(ASSESSMENT_CLAIM_QUOTE)));
    await settled;

    expect(observations).toEqual(['agent-settled']);
    expect(kernel.getFacts()).toEqual([]);
  });

  it('aborts a pending assessment on session shutdown', async () => {
    const recording = new AssessmentRecordingPi();
    const kernel = createAssessmentKernel(recording, [assessmentConsumer()]);
    recording.model = assessmentModel();
    const response = assessmentDeferred<unknown>();
    const started = assessmentDeferred<void>();
    let signal: AbortSignal | undefined;
    recording.completionHandler = async (_model, _context, options) => {
      signal = (options as AssessmentCompletionOptions).signal;
      started.resolve(undefined);
      return response.promise;
    };

    await recording.emit('input', inputEvent('interactive', 'task'));
    await recording.emit('turn_end', turnEndEvent([{ type: 'text', text: ASSESSMENT_FINAL_TEXT }]));
    const settled = recording.emit('agent_settled', { type: 'agent_settled' });
    await started.promise;
    await recording.emit('session_shutdown', { type: 'session_shutdown', reason: 'reload' });
    response.resolve(assessmentResponse(assessmentOutput(ASSESSMENT_CLAIM_QUOTE)));
    await settled;

    expect(signal?.aborted).toBe(true);
    expect(kernel.getCurrentRoot()).toBeNull();
    expect(kernel.getFacts()).toEqual([]);
    expect(kernel.getHealth()).toBe('healthy');
  });

  it('aborts a pending assessment when a session starts or reloads', async () => {
    const recording = new AssessmentRecordingPi();
    const kernel = createAssessmentKernel(recording, [assessmentConsumer()]);
    recording.model = assessmentModel();
    const response = assessmentDeferred<unknown>();
    const started = assessmentDeferred<void>();
    let signal: AbortSignal | undefined;
    recording.completionHandler = async (_model, _context, options) => {
      signal = (options as AssessmentCompletionOptions).signal;
      started.resolve(undefined);
      return response.promise;
    };

    await recording.emit('input', inputEvent('interactive', 'task'));
    await recording.emit('turn_end', turnEndEvent([{ type: 'text', text: ASSESSMENT_FINAL_TEXT }]));
    const settled = recording.emit('agent_settled', { type: 'agent_settled' });
    await started.promise;
    await recording.emit('session_start', { type: 'session_start', reason: 'resume' });
    response.resolve(assessmentResponse(assessmentOutput(ASSESSMENT_CLAIM_QUOTE)));
    await settled;

    expect(signal?.aborted).toBe(true);
    expect(kernel.getCurrentRoot()).toBeNull();
    expect(kernel.getFacts()).toEqual([]);
    expect(kernel.getHealth()).toBe('healthy');
  });

  const assessmentFailureCases: readonly {
    readonly name: string;
    readonly response?: unknown;
    readonly handler?: CompletionHandler;
    readonly evidenceText?: string;
  }[] = [
    {
      name: 'provider error',
      handler: async () => {
        throw new Error('provider failure');
      },
    },
    {
      name: 'non-stop finish reason',
      response: assessmentResponse(assessmentOutput(ASSESSMENT_CLAIM_QUOTE), 'length'),
    },
    {
      name: 'provider-reported abort',
      response: assessmentResponse(assessmentOutput(ASSESSMENT_CLAIM_QUOTE), 'aborted'),
    },
    { name: 'invalid response envelope', response: { stopReason: 'stop', content: [{ type: 'image' }] } },
    { name: 'invalid JSON', response: assessmentResponse('not JSON') },
    {
      name: 'invalid schema',
      response: assessmentResponse(assessmentJson({ schemaVersion: 2, claims: [] })),
    },
    {
      name: 'non-exact claim quote',
      response: assessmentResponse(assessmentOutput('The implementation is complete')),
    },
    {
      name: 'invented evidence id',
      response: assessmentResponse(assessmentOutput(
        ASSESSMENT_CLAIM_QUOTE,
        [{ id: 'e9', quote: 'tests pass' }],
        'verification',
      )),
      evidenceText: 'tests pass',
    },
    {
      name: 'invalid evidence quote',
      response: assessmentResponse(assessmentOutput(
        ASSESSMENT_CLAIM_QUOTE,
        [{ id: 'e1', quote: 'not present' }],
        'verification',
      )),
      evidenceText: 'tests pass',
    },
    {
      name: 'oversized output',
      response: assessmentResponse('x'.repeat(SUPERVISOR_ASSESSMENT_MAX_RESPONSE_UTF16_CODE_UNITS + 1)),
    },
  ];

  it.each(assessmentFailureCases)('fails open for $name and preserves sibling intervention ability', async (failureCase) => {
    const recording = new AssessmentRecordingPi();
    const kernel = createAssessmentKernel(recording, [assessmentConsumer(), blockingFeature()]);
    recording.model = assessmentModel();
    recording.completionHandler = failureCase.handler ?? (async () => failureCase.response);

    await settleAssessmentRoot(recording, ASSESSMENT_FINAL_TEXT, failureCase.evidenceText);

    expect(kernel.getFacts()).toEqual([]);
    expect(kernel.getHealth()).toBe('healthy');
    expect(recording.notifications).toEqual([]);
    const result = await recording.emit('tool_call', {
      type: 'tool_call',
      toolCallId: 'blocked-tool',
      toolName: 'custom-tool',
      input: { secret: 'blocked input' },
    });
    expect(result).toEqual({ block: true, reason: 'blocked' });
  });

  it('commits a sanitized deterministic fact before agent-settled feature dispatch', async () => {
    const recording = new AssessmentRecordingPi();
    const factSnapshots: (readonly unknown[])[] = [];
    const kernel = createAssessmentKernel(recording, [assessmentConsumer(
      'assessment-observer',
      (observation, context) => {
        if (observation.kind === 'agent-settled') {
          factSnapshots.push(context.facts.all());
        }
      },
    )]);
    recording.model = assessmentModel();
    recording.completionHandler = async () => assessmentResponse(assessmentOutput(
      ASSESSMENT_CLAIM_QUOTE,
      [{ id: 'e1', quote: 'tests pass' }],
      'verification',
    ));

    await settleAssessmentRoot(recording, ASSESSMENT_FINAL_TEXT, 'tests pass');

    const [fact] = kernel.getFacts();
    expect(fact).toEqual({
      schemaVersion: 1,
      id: 'fact-0',
      sequence: 0,
      sourceFeatureId: 'kernel',
      rootRequestId: 'root-1',
      kind: 'kernel:completion-assessment',
      evidenceRefs: ['e1'],
      data: {
        assessmentId: 'assessment-1',
        rootRequestId: 'root-1',
        runSequence: 1,
        claims: [{
          id: 'claim-1',
          kind: 'verification',
          quote: ASSESSMENT_CLAIM_QUOTE,
          evidence: [{ id: 'e1', quoteHash: computeSupervisorJsonDigest('tests pass') }],
        }],
        evidence: [{
          id: 'e1',
          toolName: 'custom-tool',
          toolCallId: 'tool-1',
          isError: false,
          inputDigest: computeSupervisorJsonDigest({ secret: 'private input' }),
          resultDigest: computeSupervisorJsonDigest([{ type: 'text', text: 'tests pass' }]),
        }],
      },
    });
    if (fact === undefined) {
      return;
    }
    expect(factSnapshots).toHaveLength(1);
    expect(factSnapshots[0]).toEqual([fact]);
    const serialized = JSON.stringify(fact);
    expect(serialized).toContain(ASSESSMENT_CLAIM_QUOTE);
    expect(serialized).not.toContain('tests pass');
    expect(serialized).not.toContain('private input');
    expect(serialized).not.toContain(ASSESSMENT_FINAL_TEXT);
    expect(serialized).not.toContain(SUPERVISOR_ASSESSMENT_SYSTEM_PROMPT);
  });

  it('does not recurse through Pi events and keeps feature context Pi-free', async () => {
    const recording = new AssessmentRecordingPi();
    const observations: string[] = [];
    const contextKeys: string[][] = [];
    const kernel = createAssessmentKernel(recording, [assessmentConsumer(
      'assessment-observer',
      (observation, context) => {
        observations.push(observation.kind);
        contextKeys.push(Object.keys(context).sort());
      },
    )]);
    recording.model = assessmentModel();
    recording.completionHandler = async () => assessmentResponse(assessmentOutput(ASSESSMENT_CLAIM_QUOTE));

    await settleAssessmentRoot(recording);

    expect(recording.completionCalls).toHaveLength(1);
    expect(observations).toEqual(['agent-settled']);
    expect(contextKeys).toEqual([['effectiveMode', 'facts', 'featureId', 'state']]);
    expect(kernel.getHealth()).toBe('healthy');
  });

  it('does not reuse a previous run final response before a follow-up settles', async () => {
    const recording = new AssessmentRecordingPi();
    const kernel = createAssessmentKernel(recording, [assessmentConsumer()]);
    recording.model = assessmentModel();
    recording.completionHandler = async () => assessmentResponse(assessmentOutput(ASSESSMENT_CLAIM_QUOTE));

    await settleAssessmentRoot(recording);
    await recording.emit('input', inputEvent('extension', 'supervisor follow-up'));
    await recording.emit('agent_settled', { type: 'agent_settled' });

    expect(recording.completionCalls).toHaveLength(1);
    expect(kernel.getFacts()).toHaveLength(1);
  });
});
