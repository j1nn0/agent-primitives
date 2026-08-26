import { EvidenceError } from './errors.js';
import {
  hasOwn,
  isPlainObject,
  validateEvidenceInput,
} from './validation.js';
import type { ClaimResult, EvidenceVerdict } from './types.js';

function invalidInput(): never {
  throw new EvidenceError('invalid_input', 'Invalid evidence input.');
}

export function judgeEvidence(input: unknown): EvidenceVerdict {
  try {
    if (!isPlainObject(input) || !hasOwn(input, 'claims') || !hasOwn(input, 'evidence')) {
      return invalidInput();
    }

    const validated = validateEvidenceInput(input);
    const evidenceById = new Map(
      validated.evidence.map((record) => [record.id, record]),
    );
    const results: ClaimResult[] = [];

    for (const claim of validated.claims) {
      let firstContradictedEvidenceId: string | undefined;
      let firstSubjectMismatchEvidenceId: string | undefined;
      let firstMissingEvidenceId: string | undefined;
      let firstUnconfirmedEvidenceId: string | undefined;

      for (const requirement of claim.requires) {
        const record = evidenceById.get(requirement.evidenceId);
        if (record === undefined) {
          if (firstMissingEvidenceId === undefined) {
            firstMissingEvidenceId = requirement.evidenceId;
          }
          continue;
        }

        if (
          requirement.subject !== undefined &&
          (record.subject === undefined || record.subject !== requirement.subject)
        ) {
          if (firstSubjectMismatchEvidenceId === undefined) {
            firstSubjectMismatchEvidenceId = requirement.evidenceId;
          }
          continue;
        }

        if (record.outcome === 'refuted') {
          if (firstContradictedEvidenceId === undefined) {
            firstContradictedEvidenceId = requirement.evidenceId;
          }
        } else if (record.outcome === 'unknown') {
          if (firstUnconfirmedEvidenceId === undefined) {
            firstUnconfirmedEvidenceId = requirement.evidenceId;
          }
        }
      }

      let result: ClaimResult;
      if (firstContradictedEvidenceId !== undefined) {
        result = {
          claimId: claim.id,
          outcome: 'contradicted',
          evidenceId: firstContradictedEvidenceId,
        };
      } else if (firstSubjectMismatchEvidenceId !== undefined) {
        result = {
          claimId: claim.id,
          outcome: 'unsupported',
          reason: 'subject_mismatch',
          evidenceId: firstSubjectMismatchEvidenceId,
        };
      } else if (firstMissingEvidenceId !== undefined) {
        result = {
          claimId: claim.id,
          outcome: 'unsupported',
          reason: 'missing_evidence',
          evidenceId: firstMissingEvidenceId,
        };
      } else if (firstUnconfirmedEvidenceId !== undefined) {
        result = {
          claimId: claim.id,
          outcome: 'unsupported',
          reason: 'unconfirmed_evidence',
          evidenceId: firstUnconfirmedEvidenceId,
        };
      } else {
        result = { claimId: claim.id, outcome: 'supported' };
      }
      results.push(result);
    }

    return { claims: results };
  } catch (error) {
    if (error instanceof EvidenceError) {
      throw error;
    }
    return invalidInput();
  }
}
