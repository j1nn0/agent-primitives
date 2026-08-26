import { EvidenceError } from './errors.js';
import type {
  ClaimRequirement,
  EvidenceClaim,
  EvidenceOutcome,
  EvidenceRecord,
} from './types.js';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function invalidInput(): never {
  throw new EvidenceError('invalid_input', 'Invalid evidence input.');
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isEvidenceOutcome(value: unknown): value is EvidenceOutcome {
  return value === 'confirmed' || value === 'refuted' || value === 'unknown';
}

function validateOptionalIdentifier(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  const candidate = value[key];
  if (!isIdentifier(candidate)) {
    return invalidInput();
  }
  return candidate;
}

function validateRequirement(value: unknown): ClaimRequirement {
  if (!isPlainObject(value)) {
    return invalidInput();
  }

  try {
    if (!hasOwn(value, 'evidenceId')) {
      return invalidInput();
    }

    const evidenceId = value.evidenceId;
    if (!isIdentifier(evidenceId)) {
      return invalidInput();
    }

    const subject = validateOptionalIdentifier(value, 'subject');
    return {
      evidenceId,
      ...(subject === undefined ? {} : { subject }),
    };
  } catch (error) {
    if (error instanceof EvidenceError) {
      throw error;
    }
    return invalidInput();
  }
}

function validateClaim(value: unknown): EvidenceClaim {
  if (!isPlainObject(value)) {
    return invalidInput();
  }

  try {
    if (!hasOwn(value, 'id')) {
      return invalidInput();
    }

    const id = value.id;
    if (!isIdentifier(id)) {
      return invalidInput();
    }
    if (!hasOwn(value, 'requires')) {
      return invalidInput();
    }

    const rawRequires = value.requires;
    if (!Array.isArray(rawRequires)) {
      return invalidInput();
    }
    const requiresLength = rawRequires.length;
    if (!Number.isSafeInteger(requiresLength) || requiresLength < 1) {
      return invalidInput();
    }

    const requires: ClaimRequirement[] = [];
    const requirementIds = new Set<string>();
    for (let index = 0; index < requiresLength; index += 1) {
      const requirement = validateRequirement(rawRequires[index]);
      if (requirementIds.has(requirement.evidenceId)) {
        return invalidInput();
      }
      requirementIds.add(requirement.evidenceId);
      requires.push(requirement);
    }

    return { id, requires };
  } catch (error) {
    if (error instanceof EvidenceError) {
      throw error;
    }
    return invalidInput();
  }
}

function validateEvidenceRecord(value: unknown): EvidenceRecord {
  if (!isPlainObject(value)) {
    return invalidInput();
  }

  try {
    if (!hasOwn(value, 'id')) {
      return invalidInput();
    }
    const id = value.id;
    if (!isIdentifier(id)) {
      return invalidInput();
    }
    if (!hasOwn(value, 'outcome')) {
      return invalidInput();
    }
    const outcome = value.outcome;
    if (!isEvidenceOutcome(outcome)) {
      return invalidInput();
    }

    const subject = validateOptionalIdentifier(value, 'subject');
    return {
      id,
      outcome,
      ...(subject === undefined ? {} : { subject }),
    };
  } catch (error) {
    if (error instanceof EvidenceError) {
      throw error;
    }
    return invalidInput();
  }
}

type ValidatedEvidenceInput = {
  readonly claims: readonly EvidenceClaim[];
  readonly evidence: readonly EvidenceRecord[];
};

export function validateEvidenceInput(value: unknown): ValidatedEvidenceInput {
  if (!isPlainObject(value)) {
    return invalidInput();
  }

  try {
    if (!hasOwn(value, 'claims') || !hasOwn(value, 'evidence')) {
      return invalidInput();
    }

    const rawClaims = value.claims;
    const rawEvidence = value.evidence;
    if (!Array.isArray(rawClaims) || !Array.isArray(rawEvidence)) {
      return invalidInput();
    }
    const claimsLength = rawClaims.length;
    const evidenceLength = rawEvidence.length;
    if (
      !Number.isSafeInteger(claimsLength) ||
      claimsLength < 0 ||
      !Number.isSafeInteger(evidenceLength) ||
      evidenceLength < 0
    ) {
      return invalidInput();
    }

    const claims: EvidenceClaim[] = [];
    const claimIds = new Set<string>();
    for (let index = 0; index < claimsLength; index += 1) {
      const claim = validateClaim(rawClaims[index]);
      if (claimIds.has(claim.id)) {
        return invalidInput();
      }
      claimIds.add(claim.id);
      claims.push(claim);
    }

    const evidence: EvidenceRecord[] = [];
    const evidenceIds = new Set<string>();
    for (let index = 0; index < evidenceLength; index += 1) {
      const record = validateEvidenceRecord(rawEvidence[index]);
      if (evidenceIds.has(record.id)) {
        return invalidInput();
      }
      evidenceIds.add(record.id);
      evidence.push(record);
    }

    return { claims, evidence };
  } catch (error) {
    if (error instanceof EvidenceError) {
      throw error;
    }
    return invalidInput();
  }
}
