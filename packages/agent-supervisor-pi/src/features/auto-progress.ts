import { judgeProgress } from '@j1nn0/agent-progress';
import type { ProgressVerdict } from '@j1nn0/agent-progress';
import {
  SUPERVISOR_ASSESSMENT_MAX_PROGRESS_CANDIDATES,
  SUPERVISOR_ASSESSMENT_MAX_PROGRESS_EVIDENCE_REFERENCES,
} from '../assessment/parse.js';
import { SUPERVISOR_COMPLETION_SUPPORTING_KINDS } from '../assessment/verification.js';
import { computeSupervisorJsonDigest } from '../digest.js';
import { SupervisorContractError } from '../errors.js';
import type { SupervisorFactRecord } from '../fact.js';
import { hasOnlyAllowedKeys, hasOwn, isDenseArray, isPlainObject } from '../internal.js';
import type { JsonValue } from '../json.js';
import type {
  SupervisorFeatureEmission,
  SupervisorFeatureModule,
  SupervisorFeatureRuntimeContext,
  SupervisorFeatureStateCodec,
} from '../module.js';
import type { SupervisorObservation } from '../observation.js';

const FEATURE_ID = 'auto-progress';
const ASSESSMENT_FACT_KIND = 'kernel:completion-assessment';
const VERDICT_FACT_KIND = `${FEATURE_ID}:verdict`;
const KERNEL_SOURCE_ID = 'kernel';

/** Maximum number of cumulative recorded milestones. The core has no capacity limit; bounding is this feature's job. */
export const AUTO_PROGRESS_MAX_RECORDED_MILESTONES = 256;

const AUTO_PROGRESS_DESCRIPTOR = {
  id: FEATURE_ID,
  schemaVersion: 1,
  maturity: 'validated',
  defaultMode: 'autonomous',
  observes: ['assessment-ready'],
  provides: [],
  requires: ['kernel:assessment', 'kernel:observation', 'kernel:persistence'],
  conflictsWith: [],
  usesAuxiliaryModel: true,
  interventionIntents: [],
} as const;

export type AutoProgressFeatureState = {
  readonly schemaVersion: 1;
  readonly recordedMilestones: string[];
};

const AUTO_PROGRESS_STATE_SCHEMA_VERSION = 1;

const AUTO_PROGRESS_STATE_KEYS = new Set(['schemaVersion', 'recordedMilestones']);

const EMPTY_AUTO_PROGRESS_FEATURE_STATE: AutoProgressFeatureState = {
  schemaVersion: 1,
  recordedMilestones: [],
};

function invalidAutoProgressState(): never {
  throw new SupervisorContractError('invalid_state', 'Invalid auto-progress feature state.');
}

/**
 * Codec validation keeps only opaque milestone ids. Duplicates are rejected because the
 * Progress core throws on them; anything else malformed is rejected rather than repaired.
 */
function validateAutoProgressFeatureState(value: unknown): AutoProgressFeatureState {
  if (!isPlainObject(value) || !hasOnlyAllowedKeys(value, AUTO_PROGRESS_STATE_KEYS)) {
    return invalidAutoProgressState();
  }
  if (!hasOwn(value, 'schemaVersion') || !hasOwn(value, 'recordedMilestones')) {
    return invalidAutoProgressState();
  }
  if (value.schemaVersion !== AUTO_PROGRESS_STATE_SCHEMA_VERSION) {
    return invalidAutoProgressState();
  }
  if (!isDenseArray(value.recordedMilestones)) {
    return invalidAutoProgressState();
  }
  const recordedMilestones: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value.recordedMilestones) {
    if (typeof candidate !== 'string' || candidate.trim().length === 0 || seen.has(candidate)) {
      return invalidAutoProgressState();
    }
    seen.add(candidate);
    recordedMilestones.push(candidate);
  }
  return { schemaVersion: 1, recordedMilestones };
}

const AUTO_PROGRESS_STATE_CODEC: SupervisorFeatureStateCodec<AutoProgressFeatureState> = {
  schemaVersion: AUTO_PROGRESS_STATE_SCHEMA_VERSION,
  validate: validateAutoProgressFeatureState,
};

type AutoProgressKind = 'implementation' | 'verification' | 'diagnosis' | 'research';

interface AutoProgressCandidate {
  readonly kind: AutoProgressKind;
  readonly evidence: readonly string[];
}

interface AutoProgressAdmittedCandidate {
  readonly milestoneId: string;
  readonly evidenceRefs: readonly string[];
}

type AutoProgressDomain =
  | { readonly available: false }
  | {
      readonly available: true;
      readonly candidates: readonly AutoProgressCandidate[];
    };

interface AutoProgressEvidence {
  readonly id: string;
  readonly toolName: string | null;
  readonly isError: boolean;
  readonly inputDigest: string | null;
  readonly resultDigest: string | null;
  readonly mutation: boolean;
  readonly verificationKind: string | null;
}

interface AssessmentFact {
  readonly rootRequestId: string;
  readonly assessmentId: string;
  readonly runSequence: number;
  readonly progress: AutoProgressDomain | undefined;
  readonly evidence: readonly AutoProgressEvidence[];
}

interface AssessmentReadyPayload {
  readonly assessmentId: string;
  readonly runSequence: number;
}

const AUTO_PROGRESS_DOMAIN_KEYS = new Set(['available', 'candidates']);
const AUTO_PROGRESS_CANDIDATE_KEYS = new Set(['kind', 'evidence']);

const COMPLETION_SUPPORTING_KINDS = new Set<string>(SUPERVISOR_COMPLETION_SUPPORTING_KINDS);

function defensiveJsonParse(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : JSON.parse(serialized);
  } catch {
    return undefined;
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readNonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readNullableDigest(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === 'string' ? value : undefined;
}

function isProgressKind(value: unknown): value is AutoProgressKind {
  return (
    value === 'implementation' || value === 'verification' || value === 'diagnosis' || value === 'research'
  );
}

function readProgressDomain(value: unknown): AutoProgressDomain | undefined {
  if (!isPlainObject(value) || !hasOnlyAllowedKeys(value, AUTO_PROGRESS_DOMAIN_KEYS) || !hasOwn(value, 'available')) {
    return undefined;
  }
  if (value.available === false) {
    return hasOwn(value, 'candidates') ? undefined : { available: false };
  }
  if (value.available !== true || !hasOwn(value, 'candidates')) {
    return undefined;
  }
  if (!isDenseArray(value.candidates) || value.candidates.length > SUPERVISOR_ASSESSMENT_MAX_PROGRESS_CANDIDATES) {
    return undefined;
  }
  const seenCandidates = new Set<string>();
  const candidates: AutoProgressCandidate[] = [];
  for (const entry of value.candidates) {
    if (
      !isPlainObject(entry) ||
      !hasOnlyAllowedKeys(entry, AUTO_PROGRESS_CANDIDATE_KEYS) ||
      !hasOwn(entry, 'kind') ||
      !hasOwn(entry, 'evidence') ||
      !isProgressKind(entry.kind) ||
      !isDenseArray(entry.evidence) ||
      entry.evidence.length === 0 ||
      entry.evidence.length > SUPERVISOR_ASSESSMENT_MAX_PROGRESS_EVIDENCE_REFERENCES
    ) {
      return undefined;
    }
    const seenEvidenceIds = new Set<string>();
    const evidence: string[] = [];
    for (const evidenceId of entry.evidence) {
      if (typeof evidenceId !== 'string' || evidenceId.trim().length === 0 || seenEvidenceIds.has(evidenceId)) {
        return undefined;
      }
      seenEvidenceIds.add(evidenceId);
      evidence.push(evidenceId);
    }
    const identity = JSON.stringify([entry.kind, evidence]);
    if (seenCandidates.has(identity)) {
      return undefined;
    }
    seenCandidates.add(identity);
    candidates.push({ kind: entry.kind, evidence });
  }
  return { available: true, candidates };
}

/**
 * Reads one sanitized evidence record. Records that fail validation are skipped by the
 * caller rather than failing the whole run; candidates that reference them are simply
 * never admitted. The verification kind is read leniently as a string because only
 * membership in the completion-supporting subset matters for admission.
 */
function readFactEvidence(value: unknown): AutoProgressEvidence | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const id = readNonEmptyString(value.id);
  const toolName = hasOwn(value, 'toolName') ? readNonEmptyString(value.toolName) : undefined;
  const inputDigest = hasOwn(value, 'inputDigest') ? readNullableDigest(value.inputDigest) : undefined;
  const resultDigest = hasOwn(value, 'resultDigest') ? readNullableDigest(value.resultDigest) : undefined;
  if (id === undefined || typeof value.isError !== 'boolean' || typeof value.mutation !== 'boolean') {
    return undefined;
  }
  if (inputDigest === undefined || resultDigest === undefined) {
    return undefined;
  }
  const rawVerificationKind = hasOwn(value, 'verificationKind') ? value.verificationKind : undefined;
  if (rawVerificationKind !== null && typeof rawVerificationKind !== 'string') {
    return undefined;
  }
  return {
    id,
    toolName: toolName ?? null,
    isError: value.isError,
    inputDigest,
    resultDigest,
    mutation: value.mutation,
    verificationKind: rawVerificationKind,
  };
}

function readAssessmentFact(value: unknown): AssessmentFact | undefined {
  const parsed = defensiveJsonParse(value);
  if (!isPlainObject(parsed)) {
    return undefined;
  }
  const schemaVersion = parsed.schemaVersion;
  const factId = readNonEmptyString(parsed.id);
  const sequence = readNonNegativeSafeInteger(parsed.sequence);
  const sourceFeatureId = parsed.sourceFeatureId;
  const rootRequestId = readNonEmptyString(parsed.rootRequestId);
  const kind = parsed.kind;
  const data = parsed.data;
  if (
    schemaVersion !== 1 ||
    factId === undefined ||
    sequence === undefined ||
    sourceFeatureId !== KERNEL_SOURCE_ID ||
    rootRequestId === undefined ||
    kind !== ASSESSMENT_FACT_KIND ||
    !isPlainObject(data)
  ) {
    return undefined;
  }
  const assessmentId = readNonEmptyString(data.assessmentId);
  const dataRootRequestId = readNonEmptyString(data.rootRequestId);
  const runSequence = readNonNegativeSafeInteger(data.runSequence);
  if (assessmentId === undefined || dataRootRequestId !== rootRequestId || runSequence === undefined) {
    return undefined;
  }
  if (!hasOwn(data, 'evidence') || !Array.isArray(data.evidence)) {
    return undefined;
  }
  const evidence: AutoProgressEvidence[] = [];
  for (const entry of data.evidence) {
    const record = readFactEvidence(entry);
    if (record !== undefined) {
      evidence.push(record);
    }
  }
  const progress = !hasOwn(data, 'progress') ? undefined : readProgressDomain(data.progress);
  return { rootRequestId, assessmentId, runSequence, progress, evidence };
}

function hasMatchingFactIdentity(
  value: unknown,
  rootRequestId: string,
  assessmentId: string,
  runSequence: number,
): boolean {
  const parsed = defensiveJsonParse(value);
  if (!isPlainObject(parsed) || parsed.rootRequestId !== rootRequestId || !isPlainObject(parsed.data)) {
    return false;
  }
  return parsed.data.assessmentId === assessmentId && parsed.data.runSequence === runSequence;
}

function readAssessmentReadyPayload(value: unknown): AssessmentReadyPayload | undefined {
  const parsed = defensiveJsonParse(value);
  if (!isPlainObject(parsed)) {
    return undefined;
  }
  const assessmentId = readNonEmptyString(parsed.assessmentId);
  const runSequence = readNonNegativeSafeInteger(parsed.runSequence);
  return assessmentId === undefined || runSequence === undefined
    ? undefined
    : { assessmentId, runSequence };
}

function readMatchingAssessment(
  observation: SupervisorObservation,
  context: SupervisorFeatureRuntimeContext<AutoProgressFeatureState>,
): AssessmentFact | undefined {
  if (observation.rootRequestId === null) {
    return undefined;
  }
  const payload = readAssessmentReadyPayload(observation.payload);
  if (payload === undefined) {
    return undefined;
  }
  let facts: readonly SupervisorFactRecord[];
  try {
    facts = context.facts.byKind(ASSESSMENT_FACT_KIND);
  } catch {
    return undefined;
  }
  if (!Array.isArray(facts)) {
    return undefined;
  }
  let match: AssessmentFact | undefined;
  let matchCount = 0;
  for (const factValue of facts) {
    const fact = readAssessmentFact(factValue);
    if (fact !== undefined) {
      if (
        fact.rootRequestId === observation.rootRequestId &&
        fact.assessmentId === payload.assessmentId &&
        fact.runSequence === payload.runSequence
      ) {
        match = fact;
        matchCount += 1;
      }
      continue;
    }
    if (
      hasMatchingFactIdentity(factValue, observation.rootRequestId, payload.assessmentId, payload.runSequence)
    ) {
      return undefined;
    }
  }
  return matchCount === 1 ? match : undefined;
}

/**
 * Deterministic admission per progress kind, using only Kernel-sanitized evidence metadata.
 * The model proposes the kind; this rule decides. A candidate that fails its rule is simply
 * not admitted: no milestone, no error.
 */
function isQualifyingProgressEvidence(
  kind: AutoProgressKind,
  record: AutoProgressEvidence,
): boolean {
  switch (kind) {
    case 'implementation':
      return record.mutation === true;
    case 'verification':
      return (
        record.isError === false &&
        record.verificationKind !== null &&
        COMPLETION_SUPPORTING_KINDS.has(record.verificationKind)
      );
    case 'diagnosis':
      return record.isError === true;
    case 'research':
      return record.isError === false;
  }
}

function isAdmittedProgressCandidate(
  kind: AutoProgressKind,
  records: readonly AutoProgressEvidence[],
): boolean {
  return records.some((record) => isQualifyingProgressEvidence(kind, record));
}

function usableProgressEvidence(
  kind: AutoProgressKind,
  records: readonly AutoProgressEvidence[],
): readonly AutoProgressEvidence[] {
  return records.filter(
    (record) =>
      isQualifyingProgressEvidence(kind, record) &&
      record.toolName !== null &&
      record.inputDigest !== null &&
      record.resultDigest !== null,
  );
}

/**
 * Stable milestone identity derived only from the progress kind plus the sorted, deduplicated
 * tuples of qualifying evidence. Non-qualifying records, including records with null digests, do
 * not affect identity. The input deliberately excludes the Root Request id, the run sequence,
 * evidence ids, tool call ids, and timestamps.
 */
function autoProgressMilestoneId(
  kind: AutoProgressKind,
  records: readonly AutoProgressEvidence[],
): string | undefined {
  try {
    const uniqueTuples = new Map<string, readonly [string, string, string]>();
    for (const record of usableProgressEvidence(kind, records)) {
      if (record.toolName === null || record.inputDigest === null || record.resultDigest === null) {
        continue;
      }
      const tuple: readonly [string, string, string] = [
        record.toolName,
        record.inputDigest,
        record.resultDigest,
      ];
      const key = JSON.stringify(tuple);
      if (key !== undefined) {
        uniqueTuples.set(key, tuple);
      }
    }
    const tuples = [...uniqueTuples.values()];
    tuples.sort((left, right) => {
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
      if (left[2] < right[2]) {
        return -1;
      }
      if (left[2] > right[2]) {
        return 1;
      }
      return 0;
    });
    if (tuples.length === 0) {
      return undefined;
    }
    const digest = computeSupervisorJsonDigest([kind, tuples]);
    return digest === null ? undefined : `auto:${kind}:${digest}`;
  } catch {
    return undefined;
  }
}

function isSameMilestoneList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((milestone, index) => right[index] === milestone);
}

export function createAutoProgress(): SupervisorFeatureModule<JsonValue, AutoProgressFeatureState> {
  return {
    descriptor: AUTO_PROGRESS_DESCRIPTOR,
    state: AUTO_PROGRESS_STATE_CODEC,
    create: () => {
      // Observe-mode shadow only: autonomous mode always reads the persisted context state.
      // A mode change rebuilds the runtime and resets this shadow; that is expected.
      let shadow: AutoProgressFeatureState | null = null;
      let shadowSeeded = false;
      const onObservation = (
        observation: SupervisorObservation,
        context: SupervisorFeatureRuntimeContext<AutoProgressFeatureState>,
      ): SupervisorFeatureEmission<AutoProgressFeatureState> | undefined => {
        if (observation.kind !== 'assessment-ready') {
          return undefined;
        }
        try {
          const matched = readMatchingAssessment(observation, context);
          if (matched === undefined || matched.progress === undefined || !matched.progress.available) {
            return undefined;
          }
          const observe = context.effectiveMode === 'observe';
          let persisted: AutoProgressFeatureState | null;
          if (observe) {
            if (!shadowSeeded) {
              shadow = validateAutoProgressFeatureState(
                context.state ?? EMPTY_AUTO_PROGRESS_FEATURE_STATE,
              );
              shadowSeeded = true;
            }
            persisted = shadow;
          } else {
            persisted = context.state;
          }
          const baseline = validateAutoProgressFeatureState(
            persisted ?? EMPTY_AUTO_PROGRESS_FEATURE_STATE,
          );
          const previous = [...baseline.recordedMilestones];
          const evidenceById = new Map(matched.evidence.map((record) => [record.id, record] as const));
          const admitted = new Map<string, AutoProgressAdmittedCandidate>();
          const baselineMilestones = new Set(previous);
          for (const candidate of matched.progress.candidates) {
            const records: AutoProgressEvidence[] = [];
            let referencedUnknown = false;
            for (const evidenceId of candidate.evidence) {
              const record = evidenceById.get(evidenceId);
              if (record === undefined) {
                referencedUnknown = true;
                break;
              }
              records.push(record);
            }
            if (referencedUnknown || !isAdmittedProgressCandidate(candidate.kind, records)) {
              continue;
            }
            const milestoneId = autoProgressMilestoneId(candidate.kind, records);
            if (milestoneId === undefined || baselineMilestones.has(milestoneId)) {
              continue;
            }
            const evidenceRefs = usableProgressEvidence(candidate.kind, records)
              .map((record) => record.id)
              .sort();
            const existing = admitted.get(milestoneId);
            if (existing === undefined) {
              admitted.set(milestoneId, { milestoneId, evidenceRefs });
              continue;
            }
            const mergedEvidenceRefs = [...new Set([...existing.evidenceRefs, ...evidenceRefs])].sort();
            admitted.set(milestoneId, { milestoneId, evidenceRefs: mergedEvidenceRefs });
          }
          const admittedCandidates = [...admitted.values()];
          admittedCandidates.sort((left, right) => {
            if (left.milestoneId < right.milestoneId) {
              return -1;
            }
            if (left.milestoneId > right.milestoneId) {
              return 1;
            }
            return 0;
          });
          const room = Math.max(0, AUTO_PROGRESS_MAX_RECORDED_MILESTONES - previous.length);
          const recordable = admittedCandidates.slice(0, room);
          const capacityReached = admittedCandidates.length > recordable.length;
          const supportingEvidence: string[] = [];
          const seenSupporting = new Set<string>();
          for (const candidate of recordable) {
            for (const evidenceId of candidate.evidenceRefs) {
              if (!seenSupporting.has(evidenceId)) {
                seenSupporting.add(evidenceId);
                supportingEvidence.push(evidenceId);
              }
            }
          }
          const current = [...previous, ...recordable.map((candidate) => candidate.milestoneId)];
          let verdict: ProgressVerdict;
          try {
            verdict = judgeProgress({ previous: { milestones: previous }, current: { milestones: current } });
          } catch {
            return undefined;
          }
          const newMilestones = verdict.outcome === 'progress' ? [...verdict.newMilestones] : [];
          const data: JsonValue = {
            schemaVersion: 1,
            assessmentId: matched.assessmentId,
            runSequence: matched.runSequence,
            outcome: verdict.outcome,
            ...(verdict.outcome === 'unknown' ? { reason: verdict.reason } : {}),
            newMilestones,
            recordedMilestoneCount: verdict.recordedMilestones.length,
            capacityReached,
          };
          const fact = { kind: VERDICT_FACT_KIND, evidenceRefs: supportingEvidence, data };
          if (observe) {
            shadow = { schemaVersion: 1, recordedMilestones: [...verdict.recordedMilestones] };
            return { facts: [fact] };
          }
          if (isSameMilestoneList(previous, verdict.recordedMilestones)) {
            return { facts: [fact] };
          }
          return {
            facts: [fact],
            nextState: { schemaVersion: 1, recordedMilestones: [...verdict.recordedMilestones] },
          };
        } catch {
          return undefined;
        }
      };
      return { onObservation };
    },
  };
}

export default createAutoProgress;
