import { judgeEvidence } from '@j1nn0/agent-evidence';
import type {
  ClaimResult,
  EvidenceRecord,
  UnsupportedReason,
} from '@j1nn0/agent-evidence';
import {
  SUPERVISOR_VERIFICATION_KINDS,
  type SupervisorVerificationKind,
} from '../assessment/verification.js';
import type { SupervisorFactRecord } from '../fact.js';
import type {
  SupervisorFeatureEmission,
  SupervisorFeatureModule,
  SupervisorFeatureRuntimeContext,
} from '../module.js';
import type { SupervisorObservation } from '../observation.js';
import { isPlainObject } from '../internal.js';

const FEATURE_ID = 'completion-gate';
const ASSESSMENT_FACT_KIND = 'kernel:completion-assessment';
const VERDICT_FACT_KIND = `${FEATURE_ID}:verdict`;
const KERNEL_SOURCE_ID = 'kernel';
const COMPLETION_CLAIM_KIND = 'completion';
const VERIFICATION_CLAIM_KIND = 'verification';

const FOLLOW_UP_MESSAGE =
  'Agent Supervisor: the previous completion claim is not supported by current verification evidence. Run an appropriate post-change verification using available tools, inspect the result, and only claim completion when the observed evidence supports it.';

const COMPLETION_GATE_DESCRIPTOR = {
  id: FEATURE_ID,
  schemaVersion: 1,
  maturity: 'validated',
  defaultMode: 'autonomous',
  observes: ['root-request-started', 'assessment-ready'],
  provides: [],
  requires: ['kernel:assessment', 'kernel:observation', 'kernel:intervention'],
  conflictsWith: [],
  usesAuxiliaryModel: true,
  interventionIntents: ['verify'],
} as const;

interface AssessmentEvidence {
  readonly id: string;
  readonly isError: boolean;
  readonly mutationEpoch: number;
  readonly verificationKind: SupervisorVerificationKind | null;
  readonly sequence: number;
}

interface AssessmentClaimReference {
  readonly id: string;
}

interface AssessmentClaim {
  readonly id: string;
  readonly kind: typeof COMPLETION_CLAIM_KIND | typeof VERIFICATION_CLAIM_KIND;
  readonly evidence: readonly AssessmentClaimReference[];
}

interface AssessmentFact {
  readonly rootRequestId: string;
  readonly assessmentId: string;
  readonly runSequence: number;
  readonly mutationEpoch: number;
  readonly claims: readonly AssessmentClaim[];
  readonly evidence: readonly AssessmentEvidence[];
}

interface AssessmentReadyPayload {
  readonly assessmentId: string;
  readonly runSequence: number;
}

interface LinkedEvidence extends AssessmentEvidence {
  readonly linkedIndex: number;
}

interface CompletionGateClaimVerdict {
  readonly claimId: string;
  readonly outcome: ClaimResult['outcome'];
  readonly reason: UnsupportedReason | null;
  readonly evidenceId: string | null;
}

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

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === 'string' ? value : undefined;
}

function readVerificationKind(value: unknown): SupervisorVerificationKind | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === 'string' &&
      (SUPERVISOR_VERIFICATION_KINDS as readonly string[]).includes(value)
    ? (value as SupervisorVerificationKind)
    : undefined;
}

function readEvidenceSequence(id: string): number | undefined {
  const match = /^e([1-9][0-9]*)$/u.exec(id);
  if (match === null || match[1] === undefined) {
    return undefined;
  }
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) ? sequence : undefined;
}

function readFactEvidence(value: unknown): AssessmentEvidence | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const id = readNonEmptyString(value.id);
  const isError = value.isError;
  const mutationEpoch = readNonNegativeSafeInteger(value.mutationEpoch);
  const verificationKind = readVerificationKind(value.verificationKind);
  const inputDigest = readNullableString(value.inputDigest);
  const resultDigest = readNullableString(value.resultDigest);
  const sequence = id === undefined ? undefined : readEvidenceSequence(id);
  if (
    id === undefined ||
    typeof isError !== 'boolean' ||
    mutationEpoch === undefined ||
    verificationKind === undefined ||
    inputDigest === undefined ||
    resultDigest === undefined ||
    sequence === undefined
  ) {
    return undefined;
  }
  return { id, isError, mutationEpoch, verificationKind, sequence };
}

function readFactClaim(value: unknown): AssessmentClaim | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const id = readNonEmptyString(value.id);
  const kind = value.kind;
  const rawEvidence = value.evidence;
  if (
    id === undefined ||
    (kind !== COMPLETION_CLAIM_KIND && kind !== VERIFICATION_CLAIM_KIND) ||
    !Array.isArray(rawEvidence)
  ) {
    return undefined;
  }

  const evidence: AssessmentClaimReference[] = [];
  const seenEvidenceIds = new Set<string>();
  for (const referenceValue of rawEvidence) {
    if (!isPlainObject(referenceValue)) {
      return undefined;
    }
    const evidenceId = readNonEmptyString(referenceValue.id);
    const quoteHash = referenceValue.quoteHash;
    if (
      evidenceId === undefined ||
      typeof quoteHash !== 'string' ||
      quoteHash.length === 0 ||
      seenEvidenceIds.has(evidenceId)
    ) {
      return undefined;
    }
    seenEvidenceIds.add(evidenceId);
    evidence.push({ id: evidenceId });
  }
  return { id, kind, evidence };
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
  const mutationEpoch = readNonNegativeSafeInteger(data.mutationEpoch);
  const rawClaims = data.claims;
  const rawEvidence = data.evidence;
  if (
    assessmentId === undefined ||
    dataRootRequestId !== rootRequestId ||
    runSequence === undefined ||
    mutationEpoch === undefined ||
    !Array.isArray(rawClaims) ||
    !Array.isArray(rawEvidence)
  ) {
    return undefined;
  }

  const claims: AssessmentClaim[] = [];
  const claimIds = new Set<string>();
  for (const claimValue of rawClaims) {
    if (!isPlainObject(claimValue) || typeof claimValue.quote !== 'string') {
      return undefined;
    }
    const claim = readFactClaim(claimValue);
    if (claim === undefined || claimIds.has(claim.id)) {
      return undefined;
    }
    claimIds.add(claim.id);
    claims.push(claim);
  }

  const evidence: AssessmentEvidence[] = [];
  const evidenceIds = new Set<string>();
  for (const evidenceValue of rawEvidence) {
    const record = readFactEvidence(evidenceValue);
    if (record === undefined || evidenceIds.has(record.id) || record.mutationEpoch > mutationEpoch) {
      return undefined;
    }
    evidenceIds.add(record.id);
    evidence.push(record);
  }

  for (const claim of claims) {
    if (claim.evidence.some((reference) => !evidenceIds.has(reference.id))) {
      return undefined;
    }
  }

  return { rootRequestId, assessmentId, runSequence, mutationEpoch, claims, evidence };
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
  return assessmentId === undefined || runSequence === undefined ? undefined : { assessmentId, runSequence };
}

function readMatchingAssessment(
  observation: SupervisorObservation,
  context: SupervisorFeatureRuntimeContext<never>,
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
      hasMatchingFactIdentity(
        factValue,
        observation.rootRequestId,
        payload.assessmentId,
        payload.runSequence,
      )
    ) {
      return undefined;
    }
  }

  return matchCount === 1 ? match : undefined;
}

function compareEvidence(left: LinkedEvidence, right: LinkedEvidence): number {
  if (left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }
  return left.linkedIndex - right.linkedIndex;
}

function latestEvidence(evidence: readonly LinkedEvidence[]): LinkedEvidence | undefined {
  return [...evidence].sort((left, right) => compareEvidence(right, left))[0];
}

function linkedEvidenceForClaim(
  claim: AssessmentClaim,
  evidenceById: ReadonlyMap<string, AssessmentEvidence>,
): LinkedEvidence[] {
  return claim.evidence.flatMap((reference, linkedIndex) => {
    const evidence = evidenceById.get(reference.id);
    return evidence === undefined ? [] : [{ ...evidence, linkedIndex }];
  });
}

function makeEvidenceRecord(
  evidence: AssessmentEvidence,
  outcome: EvidenceRecord['outcome'],
  subject: string,
): EvidenceRecord {
  return { id: evidence.id, outcome, subject };
}

function judgeCompletionClaim(
  claim: AssessmentClaim,
  linkedEvidence: readonly LinkedEvidence[],
  finalMutationEpoch: number,
): ClaimResult | undefined {
  const currentSubject = `mutation-epoch:${finalMutationEpoch}`;
  const currentRecognized = linkedEvidence
    .filter(
      (evidence) =>
        evidence.verificationKind !== null && evidence.mutationEpoch === finalMutationEpoch,
    )
    .sort(compareEvidence);
  const allRecognized = linkedEvidence
    .filter((evidence) => evidence.verificationKind !== null)
    .sort(compareEvidence);

  let records: readonly EvidenceRecord[];
  let requirements: readonly { readonly evidenceId: string; readonly subject: string }[];
  if (currentRecognized.length > 0) {
    records = currentRecognized.map((evidence) =>
      makeEvidenceRecord(
        evidence,
        evidence.isError ? 'refuted' : 'confirmed',
        `mutation-epoch:${evidence.mutationEpoch}`,
      ),
    );
    requirements = currentRecognized.map((evidence) => ({
      evidenceId: evidence.id,
      subject: currentSubject,
    }));
  } else if (allRecognized.length > 0) {
    const stale = latestEvidence(
      allRecognized.filter((evidence) => evidence.mutationEpoch < finalMutationEpoch),
    );
    if (stale === undefined) {
      return undefined;
    }
    records = [
      makeEvidenceRecord(
        stale,
        stale.isError ? 'refuted' : 'confirmed',
        `mutation-epoch:${stale.mutationEpoch}`,
      ),
    ];
    requirements = [{ evidenceId: stale.id, subject: currentSubject }];
  } else {
    const currentUnknown = linkedEvidence
      .filter(
        (evidence) =>
          evidence.verificationKind === null && evidence.mutationEpoch === finalMutationEpoch,
      )
      .sort(compareEvidence);
    const unknown = latestEvidence(currentUnknown);
    if (unknown !== undefined) {
      records = [makeEvidenceRecord(unknown, 'unknown', currentSubject)];
      requirements = [{ evidenceId: unknown.id, subject: currentSubject }];
    } else {
      const syntheticEvidenceId = `completion-gate:required-verification:${claim.id}`;
      records = [];
      requirements = [{ evidenceId: syntheticEvidenceId, subject: currentSubject }];
    }
  }

  try {
    return judgeEvidence({
      claims: [{ id: claim.id, requires: requirements }],
      evidence: records,
    }).claims[0];
  } catch {
    return undefined;
  }
}

function toVerdictClaim(result: ClaimResult): CompletionGateClaimVerdict {
  if (result.outcome === 'supported') {
    return { claimId: result.claimId, outcome: result.outcome, reason: null, evidenceId: null };
  }
  if (result.outcome === 'contradicted') {
    return { claimId: result.claimId, outcome: result.outcome, reason: null, evidenceId: result.evidenceId };
  }
  return {
    claimId: result.claimId,
    outcome: result.outcome,
    reason: result.reason,
    evidenceId: result.evidenceId,
  };
}

function evaluateAssessment(
  assessment: AssessmentFact,
): { readonly claims: readonly CompletionGateClaimVerdict[]; readonly needsFollowUp: boolean } | undefined {
  const evidenceById = new Map(assessment.evidence.map((evidence) => [evidence.id, evidence]));
  // Initial boundary: without a trusted mutation or recognized verification, completion-sounding explanations remain quiet to prefer missed detection over false intervention.
  const applicableClaims = assessment.claims.filter((claim) => {
    if (claim.kind !== COMPLETION_CLAIM_KIND) {
      return false;
    }
    const linkedEvidence = linkedEvidenceForClaim(claim, evidenceById);
    return (
      assessment.mutationEpoch > 0 ||
      linkedEvidence.some((evidence) => evidence.verificationKind !== null)
    );
  });
  if (applicableClaims.length === 0) {
    return undefined;
  }

  const claims: CompletionGateClaimVerdict[] = [];
  for (const claim of applicableClaims) {
    const result = judgeCompletionClaim(
      claim,
      linkedEvidenceForClaim(claim, evidenceById),
      assessment.mutationEpoch,
    );
    if (result === undefined) {
      return undefined;
    }
    claims.push(toVerdictClaim(result));
  }
  return {
    claims,
    needsFollowUp: claims.some((claim) => claim.outcome === 'unsupported' || claim.outcome === 'contradicted'),
  };
}

function onObservation(
  observation: SupervisorObservation,
  context: SupervisorFeatureRuntimeContext<never>,
): SupervisorFeatureEmission<never> | undefined {
  if (observation.kind !== 'assessment-ready') {
    return undefined;
  }

  try {
    const assessment = readMatchingAssessment(observation, context);
    if (assessment === undefined) {
      return undefined;
    }
    const evaluation = evaluateAssessment(assessment);
    if (evaluation === undefined) {
      return undefined;
    }

    const data = {
      schemaVersion: 1,
      assessmentId: assessment.assessmentId,
      runSequence: assessment.runSequence,
      mutationEpoch: assessment.mutationEpoch,
      claims: evaluation.claims.map(({ claimId, outcome, reason, evidenceId }) => ({
        claimId,
        outcome,
        reason,
        evidenceId,
      })),
    };
    const emission: SupervisorFeatureEmission<never> = {
      facts: [
        {
          kind: VERDICT_FACT_KIND,
          evidenceRefs: evaluation.claims.map((claim) => claim.claimId),
          data,
        },
      ],
    };
    if (evaluation.needsFollowUp) {
      return {
        ...emission,
        interventions: [
          {
            sourceFeatureId: FEATURE_ID,
            boundary: 'settled',
            intent: 'verify',
            delivery: 'follow-up',
            priority: 60,
            reasonCode: 'completion-gate:unsupported-completion',
            message: FOLLOW_UP_MESSAGE,
          },
        ],
      };
    }
    return emission;
  } catch {
    return undefined;
  }
}

export function createCompletionGate(): SupervisorFeatureModule {
  return {
    descriptor: COMPLETION_GATE_DESCRIPTOR,
    create: () => ({ onObservation }),
  };
}

export default createCompletionGate;
