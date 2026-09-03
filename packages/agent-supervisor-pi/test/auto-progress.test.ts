import { describe, expect, it } from 'vitest';
import { judgeProgress } from '@j1nn0/agent-progress';
import type {
  AgentSettledEvent,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  SessionEntry,
  ToolResultEvent,
  TurnEndEvent,
} from '@earendil-works/pi-coding-agent';
import { computeSupervisorJsonDigest } from '../src/digest.js';
import { createSupervisorFactRecord, createSupervisorFactSnapshot } from '../src/fact.js';
import type { SupervisorFactRecord } from '../src/fact.js';
import {
  AUTO_PROGRESS_MAX_RECORDED_MILESTONES,
  createAutoProgress,
} from '../src/features/auto-progress.js';
import type { AutoProgressFeatureState } from '../src/features/auto-progress.js';
import { SupervisorKernel } from '../src/kernel/kernel.js';
import { validateSupervisorFeatureModule } from '../src/module.js';
import type {
  SupervisorFeatureEmission,
  SupervisorFeatureRuntimeContext,
} from '../src/module.js';
import type { SupervisorObservation } from '../src/observation.js';

function evidenceDigest(value: unknown): string {
  const digest = computeSupervisorJsonDigest(value);
  if (digest === null) {
    throw new Error('Digest failed for a JSON-safe value.');
  }
  return digest;
}

interface FactEvidenceOptions {
  readonly isError?: boolean;
  readonly inputDigest?: string | null;
  readonly resultDigest?: string | null;
  readonly mutation?: boolean;
  readonly verificationKind?: string | null;
  readonly toolName?: string;
  readonly toolCallId?: string;
}

function factEvidence(id: string, options: FactEvidenceOptions = {}): {
  readonly id: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly isError: boolean;
  readonly inputDigest: string | null;
  readonly resultDigest: string | null;
  readonly mutationEpoch: number;
  readonly mutation: boolean;
  readonly verificationKind: string | null;
} {
  return {
    id,
    toolName: options.toolName ?? 'custom-tool',
    toolCallId: options.toolCallId ?? `${id}-call`,
    isError: options.isError ?? false,
    inputDigest: options.inputDigest === undefined ? evidenceDigest({ input: id }) : options.inputDigest,
    resultDigest: options.resultDigest === undefined ? evidenceDigest({ result: id }) : options.resultDigest,
    mutationEpoch: 0,
    mutation: options.mutation ?? false,
    verificationKind: options.verificationKind === undefined ? null : options.verificationKind,
  };
}

function mutationEvidence(id: string): ReturnType<typeof factEvidence> {
  return factEvidence(id, { toolName: 'edit', mutation: true });
}

type ProgressCandidateInput = { readonly kind: string; readonly evidence: readonly string[] };

type ProgressDomainInput =
  | { readonly available: false }
  | { readonly available: true; readonly candidates: readonly ProgressCandidateInput[] };

function toFactProgressDomain(input: ProgressDomainInput): Record<string, unknown> {
  if (!input.available) {
    return { available: false };
  }
  return {
    available: true,
    candidates: input.candidates.map((candidate) => ({
      kind: candidate.kind,
      evidence: [...candidate.evidence],
    })),
  };
}

function autoProgressFact(
  options: {
    readonly sequence?: number;
    readonly assessmentId?: string;
    readonly runSequence?: number;
    readonly rootRequestId?: string;
    readonly evidence?: readonly ReturnType<typeof factEvidence>[];
    readonly progress?: ProgressDomainInput | undefined;
    readonly omitProgressKey?: boolean;
  } = {},
): SupervisorFactRecord {
  const rootRequestId = options.rootRequestId ?? 'root-1';
  const progressData: Record<string, unknown> = {};
  if (options.omitProgressKey !== true) {
    if (options.progress === undefined) {
      progressData.progress = toFactProgressDomain({
        available: true,
        candidates: [{ kind: 'implementation', evidence: ['e1'] }],
      });
    } else {
      progressData.progress = toFactProgressDomain(options.progress);
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
        evidence: [...(options.evidence ?? [mutationEvidence('e1')])],
        ...progressData,
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
  rootRequestId = 'root-1',
): SupervisorObservation {
  return {
    schemaVersion: 1,
    id: 'observation-ready',
    sequence: 1,
    rootRequestId,
    kind: 'assessment-ready',
    payload,
  };
}

function directAutoProgressEmission(
  facts: readonly SupervisorFactRecord[],
  options: {
    readonly state?: AutoProgressFeatureState | null;
    readonly mode?: 'autonomous' | 'observe';
    readonly payload?: { readonly assessmentId: string; readonly runSequence: number };
    readonly rootRequestId?: string;
  } = {},
): SupervisorFeatureEmission<AutoProgressFeatureState> | undefined {
  const mode = options.mode ?? 'autonomous';
  const persisted = options.state === undefined ? null : options.state;
  const runtime = createAutoProgress().create({
    featureId: 'auto-progress',
    config: null,
    initialState: persisted,
    effectiveMode: mode,
  });
  if (runtime.onObservation === undefined) {
    throw new Error('Auto-progress did not create an observation runtime.');
  }
  const context: SupervisorFeatureRuntimeContext<AutoProgressFeatureState> = {
    featureId: 'auto-progress',
    effectiveMode: mode,
    facts: createSupervisorFactSnapshot(facts),
    state: persisted,
  };
  return runtime.onObservation(
    readyObservation(options.payload, options.rootRequestId),
    context,
  ) as SupervisorFeatureEmission<AutoProgressFeatureState> | undefined;
}

function verdictData(
  emission: SupervisorFeatureEmission<AutoProgressFeatureState> | undefined,
): Record<string, unknown> {
  const fact = emission?.facts?.[0];
  if (fact === undefined || fact.kind !== 'auto-progress:verdict') {
    throw new Error('Expected an auto-progress:verdict fact.');
  }
  return fact.data as Record<string, unknown>;
}

/**
 * Independent statement of the milestone-identity formula: the canonical digest of the
 * kind plus the sorted content-digest pairs. Root, run, and evidence ids never enter.
 */
function expectedMilestoneId(kind: string, digests: ReadonlyArray<readonly [string, string]>): string {
  const sorted = [...digests].sort((left, right) => {
    if (left[0] < right[0]) {
      return -1;
    }
    if (left[0] > right[0]) {
      return 1;
    }
    if (left[1] < right[1]) {
      return -1;
    }
    if (left[1] > right[1]) {
      return 1;
    }
    return 0;
  });
  const digest = computeSupervisorJsonDigest([kind, sorted]);
  if (digest === null) {
    throw new Error('Digest failed for a JSON-safe identity input.');
  }
  return `auto:${kind}:${digest}`;
}

function milestoneOf(
  emission: SupervisorFeatureEmission<AutoProgressFeatureState> | undefined,
  index = 0,
): string {
  const milestones = verdictData(emission).newMilestones;
  if (!Array.isArray(milestones)) {
    throw new Error('Expected newMilestones to be an array.');
  }
  const milestone: unknown = milestones[index];
  if (typeof milestone !== 'string') {
    throw new Error('Expected a string milestone id.');
  }
  return milestone;
}

describe('auto-progress descriptor and codec', () => {
  it('registers a valid tracking-only module with the specified descriptor', () => {
    const module = createAutoProgress();
    expect(() => validateSupervisorFeatureModule(module)).not.toThrow();
    expect(module.descriptor).toEqual({
      id: 'auto-progress',
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

  it('validates an opaque milestone baseline and rejects garbage', () => {
    const module = createAutoProgress();
    expect(module.state).toBeDefined();
    expect(module.state.schemaVersion).toBe(1);
    expect(module.state.validate({ schemaVersion: 1, recordedMilestones: [] })).toEqual({
      schemaVersion: 1,
      recordedMilestones: [],
    });
    expect(module.state.validate({ schemaVersion: 1, recordedMilestones: ['auto:research:abc'] })).toEqual({
      schemaVersion: 1,
      recordedMilestones: ['auto:research:abc'],
    });
    expect(() => module.state.validate({ schemaVersion: 1 })).toThrow();
    expect(() => module.state.validate(null)).toThrow();
    expect(() => module.state.validate({ schemaVersion: 1, recordedMilestones: ['a', 'a'] })).toThrow();
    expect(() => module.state.validate({ schemaVersion: 1, recordedMilestones: ['  '] })).toThrow();
    expect(() =>
      module.state.validate({ schemaVersion: 1, recordedMilestones: [], extra: true }),
    ).toThrow();
  });
});

describe('auto-progress first milestone and repeats', () => {
  it('records the first implementation milestone from an empty baseline as progress', () => {
    const evidence = [mutationEvidence('e1')];
    const expected = expectedMilestoneId('implementation', [
      [evidence[0]?.inputDigest ?? '', evidence[0]?.resultDigest ?? ''],
    ]);
    const emission = directAutoProgressEmission([autoProgressFact({ evidence })]);
    expect(emission).toBeDefined();
    expect(emission).not.toHaveProperty('interventions');
    expect(emission?.nextState).toBeDefined();
    const fact = emission?.facts?.[0];
    expect(fact?.kind).toBe('auto-progress:verdict');
    expect(fact?.evidenceRefs).toEqual(['e1']);
    expect(fact?.data).toEqual({
      schemaVersion: 1,
      assessmentId: 'assessment-1',
      runSequence: 1,
      outcome: 'progress',
      newMilestones: [expected],
      recordedMilestoneCount: 1,
      capacityReached: false,
    });
    expect(expected).toMatch(/^auto:implementation:[0-9a-f]{64}$/);
    // The verdict carries opaque ids only: no content digests leak into it.
    const serialized = JSON.stringify(fact);
    expect(serialized).not.toContain(evidence[0]?.inputDigest ?? 'missing-input-digest');
    expect(serialized).not.toContain(evidence[0]?.resultDigest ?? 'missing-result-digest');
    expect(emission?.nextState).toEqual({ schemaVersion: 1, recordedMilestones: [expected] });
  });

  it('reports no_progress without persistence when the same stable milestone repeats', () => {
    const first = directAutoProgressEmission([autoProgressFact()], { state: null });
    const firstId = milestoneOf(first);
    const second = directAutoProgressEmission([autoProgressFact()], { state: first?.nextState ?? null });
    expect(second).toBeDefined();
    expect(second).not.toHaveProperty('nextState');
    expect(verdictData(second)).toEqual({
      schemaVersion: 1,
      assessmentId: 'assessment-1',
      runSequence: 1,
      outcome: 'no_progress',
      newMilestones: [],
      recordedMilestoneCount: 1,
      capacityReached: false,
    });
    expect(milestoneOf(first)).toBe(firstId);
  });

  it('reports progress for a genuinely new milestone on top of the baseline', () => {
    const first = directAutoProgressEmission([autoProgressFact()], { state: null });
    const firstId = milestoneOf(first);
    const research = factEvidence('e2');
    const secondId = expectedMilestoneId('research', [[research.inputDigest ?? '', research.resultDigest ?? '']]);
    expect(secondId).not.toBe(firstId);
    const second = directAutoProgressEmission(
      [
        autoProgressFact({
          evidence: [mutationEvidence('e1'), research],
          progress: { available: true, candidates: [{ kind: 'research', evidence: ['e2'] }] },
        }),
      ],
      { state: first?.nextState ?? null },
    );
    expect(verdictData(second)).toEqual({
      schemaVersion: 1,
      assessmentId: 'assessment-1',
      runSequence: 1,
      outcome: 'progress',
      newMilestones: [secondId],
      recordedMilestoneCount: 2,
      capacityReached: false,
    });
    expect(second?.nextState).toEqual({ schemaVersion: 1, recordedMilestones: [firstId, secondId] });
  });

  it('admits two distinct kinds over the same evidence as two milestones', () => {
    const evidence = [mutationEvidence('e1')];
    const implementationId = expectedMilestoneId('implementation', [
      [evidence[0]?.inputDigest ?? '', evidence[0]?.resultDigest ?? ''],
    ]);
    const researchId = expectedMilestoneId('research', [
      [evidence[0]?.inputDigest ?? '', evidence[0]?.resultDigest ?? ''],
    ]);
    expect(researchId).not.toBe(implementationId);
    const emission = directAutoProgressEmission([
      autoProgressFact({
        evidence,
        progress: {
          available: true,
          candidates: [
            { kind: 'implementation', evidence: ['e1'] },
            { kind: 'research', evidence: ['e1'] },
          ],
        },
      }),
    ]);
    expect(verdictData(emission)).toMatchObject({
      outcome: 'progress',
      newMilestones: [implementationId, researchId],
      recordedMilestoneCount: 2,
    });
  });
});

describe('auto-progress core judgment', () => {
  it('uses the real core: an empty baseline plus one milestone is progress', () => {
    const verdict = judgeProgress({ previous: { milestones: [] }, current: { milestones: ['m1'] } });
    expect(verdict).toEqual({ outcome: 'progress', newMilestones: ['m1'], recordedMilestones: ['m1'] });
  });

  it('uses the real core: the same milestone set reordered is no_progress', () => {
    const verdict = judgeProgress({
      previous: { milestones: ['m1', 'm2'] },
      current: { milestones: ['m2', 'm1'] },
    });
    expect(verdict.outcome).toBe('no_progress');
    expect(verdict.recordedMilestones).toEqual(['m1', 'm2']);
  });

  it('uses the real core: a withdrawn milestone is no_progress, never invented progress', () => {
    const verdict = judgeProgress({
      previous: { milestones: ['m1', 'm2'] },
      current: { milestones: ['m1'] },
    });
    expect(verdict.outcome).toBe('no_progress');
    expect(verdict.recordedMilestones).toEqual(['m1', 'm2']);
  });
});

describe('auto-progress eligibility', () => {
  it('does not admit implementation without trusted successful mutation metadata', () => {
    const emission = directAutoProgressEmission([
      autoProgressFact({
        // toolName looks like a mutation, but the Kernel-owned flag says otherwise.
        evidence: [factEvidence('e1', { toolName: 'edit', mutation: false })],
        progress: { available: true, candidates: [{ kind: 'implementation', evidence: ['e1'] }] },
      }),
    ]);
    expect(verdictData(emission)).toEqual({
      schemaVersion: 1,
      assessmentId: 'assessment-1',
      runSequence: 1,
      outcome: 'no_progress',
      newMilestones: [],
      recordedMilestoneCount: 0,
      capacityReached: false,
    });
    const fact = emission?.facts?.[0];
    expect(fact?.evidenceRefs).toEqual([]);
    expect(emission).not.toHaveProperty('nextState');
  });

  it.each(['test', 'lint', 'typecheck', 'build', 'validation', 'read-back'] as const)(
    'admits verification for a successful completion-supporting %s result',
    (verificationKind) => {
      const emission = directAutoProgressEmission([
        autoProgressFact({
          evidence: [factEvidence('e1', { verificationKind })],
          progress: { available: true, candidates: [{ kind: 'verification', evidence: ['e1'] }] },
        }),
      ]);
      expect(verdictData(emission)).toMatchObject({ outcome: 'progress', recordedMilestoneCount: 1 });
      expect(emission?.nextState).toBeDefined();
    },
  );

  it('does not admit verification for repository-inspection', () => {
    const emission = directAutoProgressEmission([
      autoProgressFact({
        evidence: [factEvidence('e1', { verificationKind: 'repository-inspection' })],
        progress: { available: true, candidates: [{ kind: 'verification', evidence: ['e1'] }] },
      }),
    ]);
    expect(verdictData(emission)).toMatchObject({ outcome: 'no_progress', recordedMilestoneCount: 0 });
    expect(emission).not.toHaveProperty('nextState');
  });

  it('does not admit verification for a failed verification result', () => {
    const emission = directAutoProgressEmission([
      autoProgressFact({
        evidence: [factEvidence('e1', { verificationKind: 'test', isError: true })],
        progress: { available: true, candidates: [{ kind: 'verification', evidence: ['e1'] }] },
      }),
    ]);
    expect(verdictData(emission)).toMatchObject({ outcome: 'no_progress', recordedMilestoneCount: 0 });
    expect(emission).not.toHaveProperty('nextState');
  });

  it('admits diagnosis only with at least one error result', () => {
    const admitted = directAutoProgressEmission([
      autoProgressFact({
        evidence: [factEvidence('e1', { isError: true })],
        progress: { available: true, candidates: [{ kind: 'diagnosis', evidence: ['e1'] }] },
      }),
    ]);
    expect(verdictData(admitted)).toMatchObject({ outcome: 'progress', recordedMilestoneCount: 1 });

    const rejected = directAutoProgressEmission([
      autoProgressFact({
        evidence: [factEvidence('e1', { isError: false })],
        progress: { available: true, candidates: [{ kind: 'diagnosis', evidence: ['e1'] }] },
      }),
    ]);
    expect(verdictData(rejected)).toMatchObject({ outcome: 'no_progress', recordedMilestoneCount: 0 });
    expect(rejected).not.toHaveProperty('nextState');
  });

  it('admits research only with at least one successful record', () => {
    const admitted = directAutoProgressEmission([
      autoProgressFact({
        evidence: [factEvidence('e1', { isError: false })],
        progress: { available: true, candidates: [{ kind: 'research', evidence: ['e1'] }] },
      }),
    ]);
    expect(verdictData(admitted)).toMatchObject({ outcome: 'progress', recordedMilestoneCount: 1 });

    const rejected = directAutoProgressEmission([
      autoProgressFact({
        evidence: [factEvidence('e1', { isError: true })],
        progress: { available: true, candidates: [{ kind: 'research', evidence: ['e1'] }] },
      }),
    ]);
    expect(verdictData(rejected)).toMatchObject({ outcome: 'no_progress', recordedMilestoneCount: 0 });
    expect(rejected).not.toHaveProperty('nextState');
  });
});

describe('auto-progress milestone identity', () => {
  it('yields the same milestone id for the same evidence in a different root and run', () => {
    const inputDigest = evidenceDigest({ shared: 'input' });
    const resultDigest = evidenceDigest({ shared: 'result' });
    const first = directAutoProgressEmission(
      [
        autoProgressFact({
          rootRequestId: 'root-1',
          runSequence: 1,
          assessmentId: 'assessment-1',
          evidence: [factEvidence('e1', { mutation: true, inputDigest, resultDigest, toolCallId: 'call-A' })],
          progress: { available: true, candidates: [{ kind: 'implementation', evidence: ['e1'] }] },
        }),
      ],
      { rootRequestId: 'root-1' },
    );
    const second = directAutoProgressEmission(
      [
        autoProgressFact({
          rootRequestId: 'root-9',
          runSequence: 9,
          assessmentId: 'assessment-9',
          evidence: [factEvidence('e7', { mutation: true, inputDigest, resultDigest, toolCallId: 'call-B' })],
          progress: { available: true, candidates: [{ kind: 'implementation', evidence: ['e7'] }] },
        }),
      ],
      {
        rootRequestId: 'root-9',
        payload: { assessmentId: 'assessment-9', runSequence: 9 },
      },
    );
    const firstId = milestoneOf(first);
    const secondId = milestoneOf(second);
    expect(firstId).toBe(secondId);
    expect(firstId).toBe(expectedMilestoneId('implementation', [[inputDigest, resultDigest]]));
    // The verdicts still carry their own root-local assessment identity.
    expect(verdictData(first)).toMatchObject({ assessmentId: 'assessment-1', runSequence: 1 });
    expect(verdictData(second)).toMatchObject({ assessmentId: 'assessment-9', runSequence: 9 });
  });

  it.each([{ inputDigest: null }, { resultDigest: null }] as const)(
    'produces no milestone when digests are missing instead of fabricating an id',
    (missing) => {
      const emission = directAutoProgressEmission([
        autoProgressFact({
          evidence: [factEvidence('e1', { mutation: true, ...missing })],
          progress: { available: true, candidates: [{ kind: 'implementation', evidence: ['e1'] }] },
        }),
      ]);
      expect(verdictData(emission)).toEqual({
        schemaVersion: 1,
        assessmentId: 'assessment-1',
        runSequence: 1,
        outcome: 'no_progress',
        newMilestones: [],
        recordedMilestoneCount: 0,
        capacityReached: false,
      });
      expect(emission?.facts?.[0]?.evidenceRefs).toEqual([]);
      expect(emission).not.toHaveProperty('nextState');
    },
  );
});

describe('auto-progress capacity', () => {
  function seededBaseline(count: number): AutoProgressFeatureState {
    return {
      schemaVersion: 1,
      recordedMilestones: Array.from({ length: count }, (_, index) => `seed-${index}`),
    };
  }

  it('never exceeds 256 cumulative milestones and reports the capacity stop distinctly', () => {
    expect(AUTO_PROGRESS_MAX_RECORDED_MILESTONES).toBe(256);
    const firstNew = factEvidence('e1', { mutation: true });
    const secondNew = factEvidence('e2');
    const first = directAutoProgressEmission(
      [
        autoProgressFact({
          evidence: [firstNew, secondNew],
          progress: {
            available: true,
            candidates: [
              { kind: 'implementation', evidence: ['e1'] },
              { kind: 'research', evidence: ['e2'] },
            ],
          },
        }),
      ],
      { state: seededBaseline(255) },
    );
    const firstData = verdictData(first);
    expect(firstData).toMatchObject({ outcome: 'progress', recordedMilestoneCount: 256, capacityReached: true });
    expect(first?.nextState?.recordedMilestones).toHaveLength(256);

    const thirdNew = factEvidence('e3');
    const second = directAutoProgressEmission(
      [
        autoProgressFact({
          evidence: [thirdNew],
          progress: { available: true, candidates: [{ kind: 'research', evidence: ['e3'] }] },
        }),
      ],
      { state: first?.nextState ?? null },
    );
    // A capacity stop is never progress, and the baseline is left untouched.
    expect(verdictData(second)).toEqual({
      schemaVersion: 1,
      assessmentId: 'assessment-1',
      runSequence: 1,
      outcome: 'no_progress',
      newMilestones: [],
      recordedMilestoneCount: 256,
      capacityReached: true,
    });
    expect(second).not.toHaveProperty('nextState');
  });
});

describe('auto-progress fail-open selection', () => {
  it('fails open on a missing, duplicate, or malformed match', () => {
    const valid = autoProgressFact();
    const malformedEnvelope = {
      ...valid,
      data: { ...(valid.data as Record<string, unknown>), runSequence: 'bad' },
    } as unknown as SupervisorFactRecord;
    const malformedDomain = autoProgressFact({
      progress: { available: true, candidates: [{ kind: 'planning', evidence: ['e1'] }] },
    });

    expect(directAutoProgressEmission([])).toBeUndefined();
    expect(directAutoProgressEmission([valid, autoProgressFact({ sequence: 1 })])).toBeUndefined();
    expect(directAutoProgressEmission([malformedEnvelope])).toBeUndefined();
    expect(directAutoProgressEmission([malformedDomain])).toBeUndefined();
    expect(
      directAutoProgressEmission([valid], { payload: { assessmentId: 'other', runSequence: 1 } }),
    ).toBeUndefined();
    expect(
      directAutoProgressEmission([
        autoProgressFact({ rootRequestId: 'root-9', assessmentId: 'assessment-9', runSequence: 9 }),
      ]),
    ).toBeUndefined();
  });

  it('ignores observations that are not assessment-ready', () => {
    const runtime = createAutoProgress().create({
      featureId: 'auto-progress',
      config: null,
      initialState: null,
      effectiveMode: 'autonomous',
    });
    if (runtime.onObservation === undefined) {
      throw new Error('Auto-progress did not create an observation runtime.');
    }
    const context: SupervisorFeatureRuntimeContext<AutoProgressFeatureState> = {
      featureId: 'auto-progress',
      effectiveMode: 'autonomous',
      facts: createSupervisorFactSnapshot([autoProgressFact()]),
      state: null,
    };
    const observation: SupervisorObservation = { ...readyObservation(), kind: 'agent-settled' };
    expect(runtime.onObservation(observation, context)).toBeUndefined();
  });

  it('leaves the baseline untouched for a missing progress key or an unavailable domain', () => {
    const persisted: AutoProgressFeatureState = { schemaVersion: 1, recordedMilestones: ['seed-0'] };
    expect(directAutoProgressEmission([autoProgressFact({ omitProgressKey: true })], { state: persisted })).toBeUndefined();
    expect(
      directAutoProgressEmission([autoProgressFact({ progress: { available: false } })], { state: persisted }),
    ).toBeUndefined();
    expect(directAutoProgressEmission([autoProgressFact({ progress: { available: false } })])).toBeUndefined();
  });

  it('does not quarantine the feature over one malformed fact', () => {
    const malformed = autoProgressFact({
      progress: { available: true, candidates: [{ kind: 'planning', evidence: ['e1'] }] },
    });
    expect(directAutoProgressEmission([malformed])).toBeUndefined();
    const recovered = directAutoProgressEmission([autoProgressFact()], { state: null });
    expect(verdictData(recovered)).toMatchObject({ outcome: 'progress', recordedMilestoneCount: 1 });
  });

  it('reads only the assessment fact and ignores sibling verdict facts', () => {
    const sibling = (kind: string): SupervisorFactRecord =>
      createSupervisorFactRecord({
        candidate: {
          kind,
          evidenceRefs: [],
          data: { schemaVersion: 1, assessmentId: 'assessment-1', runSequence: 1 },
        },
        sourceFeatureId: kind.slice(0, kind.indexOf(':')),
        rootRequestId: 'root-1',
        sequence: 7,
      });
    const emission = directAutoProgressEmission(
      [autoProgressFact(), sibling('auto-state:verdict'), sibling('completion-gate:verdict')],
      { state: null },
    );
    expect(verdictData(emission)).toMatchObject({ outcome: 'progress', recordedMilestoneCount: 1 });
  });
});

const TASK_TEXT = 'Fix the login redirect so users land on the dashboard.';
const FINAL_TEXT = 'The fix is implemented and tests pass.';

type EventHandler = (event: unknown, context: ExtensionContext) => Promise<unknown> | unknown;
type CompletionHandler = (model: unknown, context: unknown, options: unknown) => Promise<unknown>;
type CommandHandler = (args: string, context: ExtensionContext) => Promise<void>;

class RecordingPi {
  public readonly handlers = new Map<string, EventHandler>();
  public readonly commands = new Map<string, CommandHandler>();
  public readonly branch: SessionEntry[] = [];
  public readonly model = { reasoning: false, thinkingLevelMap: {} };
  public completionHandler: CompletionHandler = async () => assessmentResponseWithProgress([]);
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

function assessmentResponseWithProgress(progress: unknown): unknown {
  return {
    stopReason: 'stop',
    content: [{ type: 'text', text: JSON.stringify({ schemaVersion: 1, claims: [], progress }) }],
  };
}

async function settleWithProgress(recording: RecordingPi, progress: unknown): Promise<void> {
  recording.completionHandler = async () => assessmentResponseWithProgress(progress);
  await recording.emit('input', { type: 'input', source: 'interactive', text: TASK_TEXT } as InputEvent);
  await recording.emit('tool_result', {
    type: 'tool_result',
    toolCallId: 'tool-1',
    toolName: 'custom-tool',
    input: { command: 'pnpm test' },
    content: [{ type: 'text', text: 'tests pass' }],
    isError: false,
    details: {},
  } as unknown as ToolResultEvent);
  await recording.emit('turn_end', {
    type: 'turn_end',
    turnIndex: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: FINAL_TEXT }] },
    toolResults: [],
  } as unknown as TurnEndEvent);
  await recording.emit('agent_settled', { type: 'agent_settled' } as AgentSettledEvent);
}

function kernelVerdict(kernel: SupervisorKernel): SupervisorFactRecord | undefined {
  return kernel.getFacts().find((fact) => fact.kind === 'auto-progress:verdict');
}

function persistedAutoProgressEntries(recording: RecordingPi): unknown[] {
  return recording.branch
    .filter((entry) => (entry as { customType?: unknown }).customType === 'agent-supervisor-state')
    .map((entry) => (entry as { data?: unknown }).data)
    .filter(
      (data): data is { kind: string; state: { featureId: string; data: unknown } } =>
        typeof data === 'object' &&
        data !== null &&
        (data as { kind?: unknown }).kind === 'feature' &&
        (data as { state?: { featureId?: unknown } }).state?.featureId === 'auto-progress',
    )
    .map((data) => data.state.data);
}

function assessmentEvidenceDigests(kernel: SupervisorKernel): { inputDigest: string; resultDigest: string } {
  const assessment = kernel.getFacts().find((fact) => fact.kind === 'kernel:completion-assessment');
  const evidence = (assessment?.data as { evidence?: readonly unknown[] } | undefined)?.evidence?.[0] as
    | { inputDigest?: unknown; resultDigest?: unknown }
    | undefined;
  if (typeof evidence?.inputDigest !== 'string' || typeof evidence?.resultDigest !== 'string') {
    throw new Error('Expected string content digests on the committed assessment evidence.');
  }
  return { inputDigest: evidence.inputDigest, resultDigest: evidence.resultDigest };
}

describe('auto-progress runtime modes', () => {
  it('emits the fact but no nextState in observe mode across two shadow runs', () => {
    const module = createAutoProgress();
    const runtime = module.create({
      featureId: 'auto-progress',
      config: null,
      initialState: null,
      effectiveMode: 'observe',
    });
    if (runtime.onObservation === undefined) {
      throw new Error('Auto-progress did not create an observation runtime.');
    }
    const observe = (
      facts: readonly SupervisorFactRecord[],
    ): SupervisorFeatureEmission<AutoProgressFeatureState> | undefined => {
      const context: SupervisorFeatureRuntimeContext<AutoProgressFeatureState> = {
        featureId: 'auto-progress',
        effectiveMode: 'observe',
        facts: createSupervisorFactSnapshot(facts),
        // The Kernel persists nothing in observe mode, so the persisted state stays null.
        state: null,
      };
      return runtime.onObservation?.(readyObservation(), context) as
        | SupervisorFeatureEmission<AutoProgressFeatureState>
        | undefined;
    };
    const first = observe([autoProgressFact()]);
    expect(verdictData(first)).toMatchObject({ outcome: 'progress', recordedMilestoneCount: 1 });
    expect(first).not.toHaveProperty('nextState');
    // The second identical run sees the shadow: no progress, still a fact, still no persistence.
    const second = observe([autoProgressFact()]);
    expect(verdictData(second)).toMatchObject({ outcome: 'no_progress', recordedMilestoneCount: 1 });
    expect(second).not.toHaveProperty('nextState');
  });

  it('computes a verdict but persists nothing in feature observe mode through the Kernel', async () => {
    const recording = new RecordingPi();
    const kernel = new SupervisorKernel(recording.pi, [createAutoProgress()]);
    kernel.register();
    await recording.command('feature auto-progress observe');
    await settleWithProgress(recording, [{ kind: 'research', evidence: ['e1'] }]);

    expect(kernel.getRuntimeStatuses().find((status) => status.id === 'auto-progress')?.effectiveMode).toBe(
      'observe',
    );
    const verdict = kernelVerdict(kernel);
    expect(verdict?.data).toMatchObject({ outcome: 'progress', recordedMilestoneCount: 1 });
    expect(verdict?.evidenceRefs).toEqual(['e1']);
    expect(persistedAutoProgressEntries(recording)).toEqual([]);
  });

  it('honors off mode without instantiating the feature', async () => {
    const recording = new RecordingPi();
    const kernel = new SupervisorKernel(recording.pi, [createAutoProgress()]);
    kernel.register();
    await recording.command('feature auto-progress off');
    await settleWithProgress(recording, [{ kind: 'research', evidence: ['e1'] }]);

    expect(kernel.getRuntimeStatuses().find((status) => status.id === 'auto-progress')?.status).toBe('off');
    expect(kernelVerdict(kernel)).toBeUndefined();
  });

  it('maintains a durable milestone baseline end to end in autonomous mode through the Kernel', async () => {
    const recording = new RecordingPi();
    const kernel = new SupervisorKernel(recording.pi, [createAutoProgress()]);
    kernel.register();
    await settleWithProgress(recording, [{ kind: 'research', evidence: ['e1'] }]);

    const { inputDigest, resultDigest } = assessmentEvidenceDigests(kernel);
    const expected = expectedMilestoneId('research', [[inputDigest, resultDigest]]);
    expect(kernelVerdict(kernel)?.data).toEqual({
      schemaVersion: 1,
      assessmentId: 'assessment-1',
      runSequence: 1,
      outcome: 'progress',
      newMilestones: [expected],
      recordedMilestoneCount: 1,
      capacityReached: false,
    });
    expect(kernelVerdict(kernel)?.evidenceRefs).toEqual(['e1']);
    expect(persistedAutoProgressEntries(recording)).toEqual([
      { schemaVersion: 1, recordedMilestones: [expected] },
    ]);
  });

  it('leaves the baseline untouched for an unavailable progress domain through the Kernel', async () => {
    const recording = new RecordingPi();
    const kernel = new SupervisorKernel(recording.pi, [createAutoProgress()]);
    kernel.register();
    await settleWithProgress(recording, { available: false });

    expect(kernelVerdict(kernel)).toBeUndefined();
    expect(persistedAutoProgressEntries(recording)).toEqual([]);
  });
});
