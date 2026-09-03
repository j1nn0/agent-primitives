import { computeSupervisorJsonDigest } from '../digest.js';
import { hasOnlyAllowedKeys, hasOwn, isDenseArray, isPlainObject } from '../internal.js';
import type { SupervisorAssessmentEvidence } from './types.js';

/** Maximum number of claims accepted from one auxiliary assessment response. */
export const SUPERVISOR_ASSESSMENT_MAX_CLAIMS = 4;

/** Maximum number of Unicode code points in one assistant claim quote. */
export const SUPERVISOR_ASSESSMENT_MAX_CLAIM_QUOTE_CODE_POINTS = 500;
/** Maximum UTF-16 code units accepted from one auxiliary provider response. */
export const SUPERVISOR_ASSESSMENT_MAX_RESPONSE_UTF16_CODE_UNITS = 16_000;

/** Maximum number of evidence references accepted for one claim. */
export const SUPERVISOR_ASSESSMENT_MAX_EVIDENCE_REFERENCES_PER_CLAIM = 4;

/** Maximum number of work-item candidates accepted in one state domain. */
export const SUPERVISOR_ASSESSMENT_MAX_STATE_WORK_ITEMS = 8;

/** Maximum number of decision candidates accepted in one state domain. */
export const SUPERVISOR_ASSESSMENT_MAX_STATE_DECISIONS = 4;

/** Maximum number of Unicode code points in one state objective quote. */
export const SUPERVISOR_ASSESSMENT_MAX_STATE_OBJECTIVE_QUOTE_CODE_POINTS = 1000;

/** Maximum number of Unicode code points in one state work-item or decision quote. */
export const SUPERVISOR_ASSESSMENT_MAX_STATE_QUOTE_CODE_POINTS = 500;

/** Maximum number of progress candidates accepted in one progress domain. */
export const SUPERVISOR_ASSESSMENT_MAX_PROGRESS_CANDIDATES = 6;

/** Maximum number of evidence references accepted for one progress candidate. */
export const SUPERVISOR_ASSESSMENT_MAX_PROGRESS_EVIDENCE_REFERENCES = 4;

const ASSESSMENT_OUTPUT_KEYS = new Set(['schemaVersion', 'claims', 'state', 'progress']);
const ASSESSMENT_CLAIM_KEYS = new Set(['kind', 'quote', 'evidence']);
const ASSESSMENT_EVIDENCE_REFERENCE_KEYS = new Set(['id', 'quote']);
const ASSESSMENT_STATE_KEYS = new Set(['objective', 'workItems', 'decisions']);
const ASSESSMENT_STATE_OBJECTIVE_KEYS = new Set(['quote']);
const ASSESSMENT_STATE_WORK_ITEM_KEYS = new Set(['quote', 'status']);
const ASSESSMENT_STATE_DECISION_KEYS = new Set(['source', 'quote']);
const ASSESSMENT_PROGRESS_CANDIDATE_KEYS = new Set(['kind', 'evidence']);

export type SupervisorAssessmentClaimKind = 'completion' | 'verification';
export type SupervisorAssessmentStateWorkItemStatus = 'open' | 'in_progress' | 'blocked';
export type SupervisorAssessmentStateDecisionSource = 'task' | 'assistant';
export type SupervisorAssessmentProgressKind =
  | 'implementation'
  | 'verification'
  | 'diagnosis'
  | 'research';

type AssessmentTextBlock = {
  readonly type: 'text';
  readonly text: string;
};

type AssessmentProviderResponse = {
  readonly content?: readonly unknown[];
  readonly stopReason?: unknown;
};

export interface SupervisorAssessmentEvidenceReference {
  readonly id: string;
  readonly quoteHash: string;
}

export interface SupervisorAssessmentClaim {
  readonly kind: SupervisorAssessmentClaimKind;
  readonly quote: string;
  readonly evidence: readonly SupervisorAssessmentEvidenceReference[];
}

export interface SupervisorAssessmentStateObjective {
  readonly quote: string;
}

export interface SupervisorAssessmentStateWorkItem {
  readonly quote: string;
  readonly status: SupervisorAssessmentStateWorkItemStatus;
}

export interface SupervisorAssessmentStateDecision {
  readonly source: SupervisorAssessmentStateDecisionSource;
  readonly quote: string;
}

export interface SupervisorAssessmentState {
  readonly objective?: SupervisorAssessmentStateObjective;
  readonly workItems: readonly SupervisorAssessmentStateWorkItem[];
  readonly decisions: readonly SupervisorAssessmentStateDecision[];
}

export type SupervisorAssessmentStateResult =
  | {
      readonly available: true;
      readonly state: SupervisorAssessmentState;
    }
  | {
      readonly available: false;
    };

export interface SupervisorAssessmentProgressCandidate {
  readonly kind: SupervisorAssessmentProgressKind;
  readonly evidence: readonly string[];
}

export type SupervisorAssessmentProgressResult =
  | {
      readonly available: true;
      readonly candidates: readonly SupervisorAssessmentProgressCandidate[];
    }
  | {
      readonly available: false;
    };

export interface SupervisorAssessmentOutput {
  readonly claims: readonly SupervisorAssessmentClaim[];
  readonly state: SupervisorAssessmentStateResult;
  readonly progress: SupervisorAssessmentProgressResult;
}

export type SupervisorAssessmentFailureKind =
  | 'aborted'
  | 'provider'
  | 'invalid-response'
  | 'invalid-output';

export type SupervisorAssessmentTextResult =
  | {
      readonly ok: true;
      readonly text: string;
    }
  | {
      readonly ok: false;
      readonly failureKind: 'aborted' | 'provider' | 'invalid-response';
    };

export type SupervisorAssessmentParseResult =
  | {
      readonly ok: true;
      readonly output: SupervisorAssessmentOutput;
    }
  | {
      readonly ok: false;
      readonly failureKind: SupervisorAssessmentFailureKind;
    };

const EMPTY_SUPERVISOR_ASSESSMENT_STATE: SupervisorAssessmentState = Object.freeze({
  workItems: Object.freeze([]),
  decisions: Object.freeze([]),
});

const EMPTY_SUPERVISOR_ASSESSMENT_PROGRESS_CANDIDATES: readonly SupervisorAssessmentProgressCandidate[] =
  Object.freeze([]);

function isTextBlock(value: unknown): value is AssessmentTextBlock {
  return isPlainObject(value) && value.type === 'text' && typeof value.text === 'string';
}

/** Mirrors the local single-surrounding-fence behavior used by Context Guard. */
function stripSingleFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

/** Validate the provider envelope and return only its text, never provider error content. */
export function parseSupervisorAssessmentText(response: unknown): SupervisorAssessmentTextResult {
  try {
    if (!isPlainObject(response)) {
      return { ok: false, failureKind: 'invalid-response' };
    }

    const typedResponse = response as AssessmentProviderResponse;
    if (typedResponse.stopReason === 'aborted') {
      return { ok: false, failureKind: 'aborted' };
    }
    if (typedResponse.stopReason !== 'stop') {
      return { ok: false, failureKind: 'provider' };
    }
    if (!isDenseArray(typedResponse.content)) {
      return { ok: false, failureKind: 'invalid-response' };
    }

    const text = typedResponse.content
      .filter(isTextBlock)
      .map((block) => block.text)
      .join('');
    if (text.length > SUPERVISOR_ASSESSMENT_MAX_RESPONSE_UTF16_CODE_UNITS) {
      return { ok: false, failureKind: 'invalid-response' };
    }
    if (text.trim().length === 0) {
      return { ok: false, failureKind: 'invalid-response' };
    }

    return { ok: true, text: stripSingleFence(text) };
  } catch {
    return { ok: false, failureKind: 'invalid-response' };
  }
}

function indexEvidence(
  evidence: readonly SupervisorAssessmentEvidence[],
): Map<string, SupervisorAssessmentEvidence> | undefined {
  try {
    const evidenceById = new Map<string, SupervisorAssessmentEvidence>();
    for (const record of evidence) {
      if (
        !isPlainObject(record) ||
        typeof record.id !== 'string' ||
        typeof record.text !== 'string' ||
        evidenceById.has(record.id)
      ) {
        return undefined;
      }
      evidenceById.set(record.id, record);
    }
    return evidenceById;
  } catch {
    return undefined;
  }
}

function isStateWorkItemStatus(value: unknown): value is SupervisorAssessmentStateWorkItemStatus {
  return value === 'open' || value === 'in_progress' || value === 'blocked';
}

function isStateDecisionSource(value: unknown): value is SupervisorAssessmentStateDecisionSource {
  return value === 'task' || value === 'assistant';
}

function isProgressKind(value: unknown): value is SupervisorAssessmentProgressKind {
  return (
    value === 'implementation' ||
    value === 'verification' ||
    value === 'diagnosis' ||
    value === 'research'
  );
}

/**
 * Check one extracted quote against its declared source text. Matching is exact and contiguous:
 * character for character, with no normalization or fuzzy matching.
 */
function isExactSourceQuote(
  quote: unknown,
  sourceText: string | undefined,
  maxCodePoints: number,
): quote is string {
  return (
    typeof quote === 'string' &&
    quote.trim().length > 0 &&
    Array.from(quote).length <= maxCodePoints &&
    sourceText !== undefined &&
    sourceText.includes(quote)
  );
}

function parseSupervisorAssessmentStateObjective(
  value: unknown,
  taskText: string | undefined,
): SupervisorAssessmentStateObjective | undefined {
  if (
    !isPlainObject(value) ||
    !hasOnlyAllowedKeys(value, ASSESSMENT_STATE_OBJECTIVE_KEYS) ||
    !hasOwn(value, 'quote') ||
    !isExactSourceQuote(
      value.quote,
      taskText,
      SUPERVISOR_ASSESSMENT_MAX_STATE_OBJECTIVE_QUOTE_CODE_POINTS,
    )
  ) {
    return undefined;
  }
  return Object.freeze({ quote: value.quote });
}

function parseSupervisorAssessmentStateWorkItems(
  value: unknown,
  taskText: string | undefined,
): readonly SupervisorAssessmentStateWorkItem[] | undefined {
  if (!isDenseArray(value) || value.length > SUPERVISOR_ASSESSMENT_MAX_STATE_WORK_ITEMS) {
    return undefined;
  }
  const seenQuotes = new Set<string>();
  const workItems: SupervisorAssessmentStateWorkItem[] = [];
  for (const candidate of value) {
    if (
      !isPlainObject(candidate) ||
      !hasOnlyAllowedKeys(candidate, ASSESSMENT_STATE_WORK_ITEM_KEYS) ||
      !hasOwn(candidate, 'quote') ||
      !hasOwn(candidate, 'status') ||
      !isStateWorkItemStatus(candidate.status) ||
      !isExactSourceQuote(
        candidate.quote,
        taskText,
        SUPERVISOR_ASSESSMENT_MAX_STATE_QUOTE_CODE_POINTS,
      ) ||
      seenQuotes.has(candidate.quote)
    ) {
      return undefined;
    }
    seenQuotes.add(candidate.quote);
    workItems.push(Object.freeze({ quote: candidate.quote, status: candidate.status }));
  }
  return Object.freeze(workItems);
}

function parseSupervisorAssessmentStateDecisions(
  value: unknown,
  taskText: string | undefined,
  finalAssistantText: string,
): readonly SupervisorAssessmentStateDecision[] | undefined {
  if (!isDenseArray(value) || value.length > SUPERVISOR_ASSESSMENT_MAX_STATE_DECISIONS) {
    return undefined;
  }
  const seenQuotes = new Set<string>();
  const decisions: SupervisorAssessmentStateDecision[] = [];
  for (const candidate of value) {
    if (
      !isPlainObject(candidate) ||
      !hasOnlyAllowedKeys(candidate, ASSESSMENT_STATE_DECISION_KEYS) ||
      !hasOwn(candidate, 'source') ||
      !hasOwn(candidate, 'quote') ||
      !isStateDecisionSource(candidate.source)
    ) {
      return undefined;
    }
    const sourceText = candidate.source === 'task' ? taskText : finalAssistantText;
    if (
      !isExactSourceQuote(
        candidate.quote,
        sourceText,
        SUPERVISOR_ASSESSMENT_MAX_STATE_QUOTE_CODE_POINTS,
      ) ||
      seenQuotes.has(candidate.quote)
    ) {
      return undefined;
    }
    seenQuotes.add(candidate.quote);
    decisions.push(Object.freeze({ source: candidate.source, quote: candidate.quote }));
  }
  return Object.freeze(decisions);
}

/**
 * Parse the optional state domain. An absent domain means there are no state candidates, which is
 * available but empty. A present but malformed domain is unavailable; it never invalidates claims.
 */
function parseSupervisorAssessmentState(
  value: unknown,
  taskText: string | undefined,
  finalAssistantText: string,
): SupervisorAssessmentStateResult {
  if (!isPlainObject(value) || !hasOnlyAllowedKeys(value, ASSESSMENT_STATE_KEYS)) {
    return { available: false };
  }
  let objective: SupervisorAssessmentStateObjective | undefined;
  if (hasOwn(value, 'objective')) {
    const parsedObjective = parseSupervisorAssessmentStateObjective(value.objective, taskText);
    if (parsedObjective === undefined) {
      return { available: false };
    }
    objective = parsedObjective;
  }
  let workItems: readonly SupervisorAssessmentStateWorkItem[] = EMPTY_SUPERVISOR_ASSESSMENT_STATE.workItems;
  if (hasOwn(value, 'workItems')) {
    const parsedWorkItems = parseSupervisorAssessmentStateWorkItems(value.workItems, taskText);
    if (parsedWorkItems === undefined) {
      return { available: false };
    }
    workItems = parsedWorkItems;
  }
  let decisions: readonly SupervisorAssessmentStateDecision[] = EMPTY_SUPERVISOR_ASSESSMENT_STATE.decisions;
  if (hasOwn(value, 'decisions')) {
    const parsedDecisions = parseSupervisorAssessmentStateDecisions(
      value.decisions,
      taskText,
      finalAssistantText,
    );
    if (parsedDecisions === undefined) {
      return { available: false };
    }
    decisions = parsedDecisions;
  }
  if (objective === undefined) {
    return { available: true, state: Object.freeze({ workItems, decisions }) };
  }
  return { available: true, state: Object.freeze({ objective, workItems, decisions }) };
}

/**
 * Parse the optional progress domain. An absent domain means there are no progress candidates,
 * which is available but empty. A present but malformed domain is unavailable; it never
 * invalidates claims.
 */
function parseSupervisorAssessmentProgress(
  value: unknown,
  evidenceById: ReadonlyMap<string, SupervisorAssessmentEvidence>,
): SupervisorAssessmentProgressResult {
  if (!isDenseArray(value) || value.length > SUPERVISOR_ASSESSMENT_MAX_PROGRESS_CANDIDATES) {
    return { available: false };
  }
  const seenCandidates = new Set<string>();
  const candidates: SupervisorAssessmentProgressCandidate[] = [];
  for (const candidate of value) {
    if (
      !isPlainObject(candidate) ||
      !hasOnlyAllowedKeys(candidate, ASSESSMENT_PROGRESS_CANDIDATE_KEYS) ||
      !hasOwn(candidate, 'kind') ||
      !hasOwn(candidate, 'evidence') ||
      !isProgressKind(candidate.kind) ||
      !isDenseArray(candidate.evidence) ||
      candidate.evidence.length === 0 ||
      candidate.evidence.length > SUPERVISOR_ASSESSMENT_MAX_PROGRESS_EVIDENCE_REFERENCES
    ) {
      return { available: false };
    }
    const seenEvidenceIds = new Set<string>();
    const evidence: string[] = [];
    for (const evidenceId of candidate.evidence) {
      if (
        typeof evidenceId !== 'string' ||
        seenEvidenceIds.has(evidenceId) ||
        !evidenceById.has(evidenceId)
      ) {
        return { available: false };
      }
      seenEvidenceIds.add(evidenceId);
      evidence.push(evidenceId);
    }
    const identity = JSON.stringify([candidate.kind, evidence]);
    if (seenCandidates.has(identity)) {
      return { available: false };
    }
    seenCandidates.add(identity);
    candidates.push(Object.freeze({ kind: candidate.kind, evidence: Object.freeze(evidence) }));
  }
  return { available: true, candidates: Object.freeze(candidates) };
}

function parseSupervisorAssessmentOutput(
  text: string,
  finalAssistantText: string,
  evidence: readonly SupervisorAssessmentEvidence[],
  taskText: string | undefined,
): SupervisorAssessmentOutput | undefined {
  if (typeof finalAssistantText !== 'string') {
    return undefined;
  }
  const boundedTaskText = typeof taskText === 'string' ? taskText : undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (
    !isPlainObject(parsed) ||
    !hasOnlyAllowedKeys(parsed, ASSESSMENT_OUTPUT_KEYS) ||
    !hasOwn(parsed, 'schemaVersion') ||
    parsed.schemaVersion !== 1 ||
    !hasOwn(parsed, 'claims') ||
    !isDenseArray(parsed.claims) ||
    parsed.claims.length > SUPERVISOR_ASSESSMENT_MAX_CLAIMS
  ) {
    return undefined;
  }

  const evidenceById = indexEvidence(evidence);
  if (evidenceById === undefined) {
    return undefined;
  }

  const seenClaimQuotes = new Set<string>();
  const claims: SupervisorAssessmentClaim[] = [];

  for (const candidate of parsed.claims) {
    if (
      !isPlainObject(candidate) ||
      !hasOnlyAllowedKeys(candidate, ASSESSMENT_CLAIM_KEYS) ||
      !hasOwn(candidate, 'kind') ||
      !hasOwn(candidate, 'quote') ||
      !hasOwn(candidate, 'evidence')
    ) {
      return undefined;
    }

    const kind = candidate.kind;
    if (kind !== 'completion' && kind !== 'verification') {
      return undefined;
    }

    const claimQuote = candidate.quote;
    if (
      typeof claimQuote !== 'string' ||
      claimQuote.trim().length === 0 ||
      Array.from(claimQuote).length > SUPERVISOR_ASSESSMENT_MAX_CLAIM_QUOTE_CODE_POINTS ||
      !finalAssistantText.includes(claimQuote) ||
      seenClaimQuotes.has(claimQuote)
    ) {
      return undefined;
    }
    seenClaimQuotes.add(claimQuote);

    if (!isDenseArray(candidate.evidence)) {
      return undefined;
    }
    if (candidate.evidence.length > SUPERVISOR_ASSESSMENT_MAX_EVIDENCE_REFERENCES_PER_CLAIM) {
      return undefined;
    }

    const seenEvidenceIds = new Set<string>();
    const references: SupervisorAssessmentEvidenceReference[] = [];
    for (const candidateReference of candidate.evidence) {
      if (
        !isPlainObject(candidateReference) ||
        !hasOnlyAllowedKeys(candidateReference, ASSESSMENT_EVIDENCE_REFERENCE_KEYS) ||
        !hasOwn(candidateReference, 'id') ||
        !hasOwn(candidateReference, 'quote') ||
        typeof candidateReference.id !== 'string' ||
        typeof candidateReference.quote !== 'string' ||
        candidateReference.quote.trim().length === 0 ||
        seenEvidenceIds.has(candidateReference.id)
      ) {
        return undefined;
      }

      const source = evidenceById.get(candidateReference.id);
      if (source === undefined || !source.text.includes(candidateReference.quote)) {
        return undefined;
      }

      const quoteHash = computeSupervisorJsonDigest(candidateReference.quote);
      if (quoteHash === null) {
        return undefined;
      }

      seenEvidenceIds.add(candidateReference.id);
      references.push({ id: candidateReference.id, quoteHash });
    }

    claims.push({
      kind,
      quote: claimQuote,
      evidence: Object.freeze(references),
    });
  }

  const state: SupervisorAssessmentStateResult = hasOwn(parsed, 'state')
    ? parseSupervisorAssessmentState(parsed.state, boundedTaskText, finalAssistantText)
    : { available: true, state: EMPTY_SUPERVISOR_ASSESSMENT_STATE };
  const progress: SupervisorAssessmentProgressResult = hasOwn(parsed, 'progress')
    ? parseSupervisorAssessmentProgress(parsed.progress, evidenceById)
    : { available: true, candidates: EMPTY_SUPERVISOR_ASSESSMENT_PROGRESS_CANDIDATES };

  return Object.freeze({
    claims: Object.freeze(claims),
    state,
    progress,
  });
}

export function parseSupervisorAssessmentResponse(
  response: unknown,
  finalAssistantText: string,
  evidence: readonly SupervisorAssessmentEvidence[],
  taskText?: string,
): SupervisorAssessmentParseResult {
  const responseText = parseSupervisorAssessmentText(response);
  if (!responseText.ok) {
    return responseText;
  }

  const output = parseSupervisorAssessmentOutput(
    responseText.text,
    finalAssistantText,
    evidence,
    taskText,
  );
  return output === undefined
    ? { ok: false, failureKind: 'invalid-output' }
    : { ok: true, output };
}
