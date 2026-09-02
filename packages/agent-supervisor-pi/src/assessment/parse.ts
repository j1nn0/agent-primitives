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

const ASSESSMENT_OUTPUT_KEYS = new Set(['schemaVersion', 'claims']);
const ASSESSMENT_CLAIM_KEYS = new Set(['kind', 'quote', 'evidence']);
const ASSESSMENT_EVIDENCE_REFERENCE_KEYS = new Set(['id', 'quote']);

export type SupervisorAssessmentClaimKind = 'completion' | 'verification';

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

export interface SupervisorAssessmentOutput {
  readonly claims: readonly SupervisorAssessmentClaim[];
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

function parseSupervisorAssessmentOutput(
  text: string,
  finalAssistantText: string,
  evidence: readonly SupervisorAssessmentEvidence[],
): SupervisorAssessmentOutput | undefined {
  if (typeof finalAssistantText !== 'string') {
    return undefined;
  }

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

  return Object.freeze({
    claims: Object.freeze(claims),
  });
}

export function parseSupervisorAssessmentResponse(
  response: unknown,
  finalAssistantText: string,
  evidence: readonly SupervisorAssessmentEvidence[],
): SupervisorAssessmentParseResult {
  const responseText = parseSupervisorAssessmentText(response);
  if (!responseText.ok) {
    return responseText;
  }

  const output = parseSupervisorAssessmentOutput(responseText.text, finalAssistantText, evidence);
  return output === undefined
    ? { ok: false, failureKind: 'invalid-output' }
    : { ok: true, output };
}
