import {
  judgeEvidence,
  type ClaimRequirement,
  type EvidenceClaim,
  type EvidenceOutcome,
  type EvidenceRecord,
  type EvidenceVerdict,
} from '@j1nn0/agent-evidence';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

export const STATE_CUSTOM_TYPE = 'agent-evidence-state';
export const ADAPTER_SCHEMA_VERSION = 1 as const;

export interface EvidenceState {
  readonly claims: readonly EvidenceClaim[];
  readonly evidence: readonly EvidenceRecord[];
}

export interface PersistedState {
  readonly schemaVersion: 1;
  readonly claims: readonly EvidenceClaim[];
  readonly evidence: readonly EvidenceRecord[];
}

export interface StateController {
  readonly getState: () => EvidenceState;
  readonly replaceState: (state: EvidenceState) => void;
  readonly persist: () => void;
}

export type StateMutationResult =
  | { readonly changed: true; readonly state: EvidenceState }
  | {
      readonly changed: false;
      readonly reason: 'invalid' | 'not_found' | 'no_change';
    };

export type AddClaimResult = StateMutationResult;
export type RemoveClaimResult = StateMutationResult;
export type AddEvidenceResult = StateMutationResult;
export type ReplaceEvidenceResult = StateMutationResult;
export type RemoveEvidenceResult = StateMutationResult;
export type ClearStateResult = StateMutationResult;

type CandidateState = {
  readonly claims: readonly unknown[];
  readonly evidence: readonly unknown[];
};

const INVALID_STATE_WARNING =
  'Agent Evidence: persisted state was invalid; starting with fresh state.';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
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

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function isValidIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isEvidenceOutcome(value: unknown): value is EvidenceOutcome {
  return value === 'confirmed' || value === 'refuted' || value === 'unknown';
}

function copyRequirement(requirement: ClaimRequirement): ClaimRequirement {
  return requirement.subject === undefined
    ? { evidenceId: requirement.evidenceId }
    : { evidenceId: requirement.evidenceId, subject: requirement.subject };
}

function copyClaim(claim: EvidenceClaim): EvidenceClaim {
  return {
    id: claim.id,
    requires: claim.requires.map(copyRequirement),
  };
}

function copyEvidence(record: EvidenceRecord): EvidenceRecord {
  return record.subject === undefined
    ? { id: record.id, outcome: record.outcome }
    : { id: record.id, outcome: record.outcome, subject: record.subject };
}


function candidateIsValid(candidate: CandidateState): boolean {
  try {
    judgeEvidence({
      claims: candidate.claims,
      evidence: candidate.evidence,
    });
    return true;
  } catch {
    return false;
  }
}

export function validateCandidateState(
  candidate: CandidateState,
): boolean;
export function validateCandidateState(
  claims: readonly unknown[],
  evidence: readonly unknown[],
): boolean;
export function validateCandidateState(
  candidateOrClaims: CandidateState | readonly unknown[],
  evidence?: readonly unknown[],
): boolean {
  const candidate: CandidateState = Array.isArray(candidateOrClaims)
    ? { claims: candidateOrClaims, evidence: evidence ?? [] }
    : { claims: candidateOrClaims as readonly unknown[], evidence: evidence ?? [] };
  return candidateIsValid(candidate);
}

function changedState(
  claims: readonly unknown[],
  evidence: readonly unknown[],
): EvidenceState {
  return {
    claims: claims.map((claim) => copyClaim(claim as EvidenceClaim)),
    evidence: evidence.map((record) => copyEvidence(record as EvidenceRecord)),
  };
}

function invalidMutation(): StateMutationResult {
  return { changed: false, reason: 'invalid' };
}

export function createEmptyState(): EvidenceState {
  return { claims: [], evidence: [] };
}

function parsePersistedRequirement(
  value: unknown,
): ClaimRequirement | undefined {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ['evidenceId', 'subject']) ||
    !hasOwn(value, 'evidenceId') ||
    !isValidIdentifier(value.evidenceId)
  ) {
    return undefined;
  }

  if (!hasOwn(value, 'subject')) {
    return { evidenceId: value.evidenceId };
  }

  return isValidIdentifier(value.subject)
    ? { evidenceId: value.evidenceId, subject: value.subject }
    : undefined;
}

function parsePersistedClaim(value: unknown): EvidenceClaim | undefined {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ['id', 'requires']) ||
    !hasOwn(value, 'id') ||
    !isValidIdentifier(value.id) ||
    !hasOwn(value, 'requires') ||
    !Array.isArray(value.requires) ||
    value.requires.length < 1
  ) {
    return undefined;
  }

  const requires: ClaimRequirement[] = [];
  const requirementIds = new Set<string>();
  for (const rawRequirement of value.requires) {
    const requirement = parsePersistedRequirement(rawRequirement);
    if (
      requirement === undefined ||
      requirementIds.has(requirement.evidenceId)
    ) {
      return undefined;
    }
    requirementIds.add(requirement.evidenceId);
    requires.push(requirement);
  }

  return { id: value.id, requires };
}

function parsePersistedEvidence(
  value: unknown,
): EvidenceRecord | undefined {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ['id', 'outcome', 'subject']) ||
    !hasOwn(value, 'id') ||
    !isValidIdentifier(value.id) ||
    !hasOwn(value, 'outcome') ||
    !isEvidenceOutcome(value.outcome)
  ) {
    return undefined;
  }

  if (!hasOwn(value, 'subject')) {
    return { id: value.id, outcome: value.outcome };
  }

  return isValidIdentifier(value.subject)
    ? { id: value.id, outcome: value.outcome, subject: value.subject }
    : undefined;
}

function parsePersistedState(value: unknown): EvidenceState | undefined {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ['schemaVersion', 'claims', 'evidence']) ||
    !hasOwn(value, 'schemaVersion') ||
    value.schemaVersion !== ADAPTER_SCHEMA_VERSION ||
    !hasOwn(value, 'claims') ||
    !Array.isArray(value.claims) ||
    !hasOwn(value, 'evidence') ||
    !Array.isArray(value.evidence)
  ) {
    return undefined;
  }

  const claims: EvidenceClaim[] = [];
  const claimIds = new Set<string>();
  for (const rawClaim of value.claims) {
    const claim = parsePersistedClaim(rawClaim);
    if (claim === undefined || claimIds.has(claim.id)) {
      return undefined;
    }
    claimIds.add(claim.id);
    claims.push(claim);
  }

  const evidence: EvidenceRecord[] = [];
  const evidenceIds = new Set<string>();
  for (const rawEvidence of value.evidence) {
    const record = parsePersistedEvidence(rawEvidence);
    if (record === undefined || evidenceIds.has(record.id)) {
      return undefined;
    }
    evidenceIds.add(record.id);
    evidence.push(record);
  }

  return { claims, evidence };
}

export function loadState(
  ctx: Pick<ExtensionContext, 'sessionManager' | 'ui'>,
): EvidenceState {
  try {
    const latestStateEntry = ctx.sessionManager
      .getBranch()
      .filter(
        (entry) =>
          entry.type === 'custom' && entry.customType === STATE_CUSTOM_TYPE,
      )
      .at(-1);

    if (latestStateEntry === undefined || latestStateEntry.type !== 'custom') {
      return createEmptyState();
    }

    const state = parsePersistedState(latestStateEntry.data);
    if (state === undefined) {
      ctx.ui.notify(INVALID_STATE_WARNING, 'warning');
      return createEmptyState();
    }

    return state;
  } catch {
    ctx.ui.notify(INVALID_STATE_WARNING, 'warning');
    return createEmptyState();
  }
}

export function saveState(
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  state: EvidenceState,
): void {
  const payload: PersistedState = {
    schemaVersion: ADAPTER_SCHEMA_VERSION,
    claims: state.claims.map(copyClaim),
    evidence: state.evidence.map(copyEvidence),
  };
  pi.appendEntry(STATE_CUSTOM_TYPE, payload);
}

export function addClaim(
  state: EvidenceState,
  claim: unknown,
): AddClaimResult;
export function addClaim(
  state: EvidenceState,
  id: unknown,
  requires: unknown,
): AddClaimResult;
export function addClaim(
  state: EvidenceState,
  idOrClaim: unknown,
  requires?: unknown,
): AddClaimResult {
  const claim =
    arguments.length >= 3
      ? { id: idOrClaim, requires }
      : idOrClaim;
  const candidate: CandidateState = {
    claims: [...state.claims, claim],
    evidence: [...state.evidence],
  };

  if (!candidateIsValid(candidate)) {
    return invalidMutation();
  }

  return {
    changed: true,
    state: changedState(candidate.claims, candidate.evidence),
  };
}

export function removeClaim(
  state: EvidenceState,
  id: unknown,
): RemoveClaimResult {
  if (!isValidIdentifier(id)) {
    return invalidMutation();
  }

  const index = state.claims.findIndex((claim) => claim.id === id);
  if (index < 0) {
    return { changed: false, reason: 'not_found' };
  }

  const candidate: CandidateState = {
    claims: state.claims.filter((_claim, claimIndex) => claimIndex !== index),
    evidence: [...state.evidence],
  };
  if (!candidateIsValid(candidate)) {
    return invalidMutation();
  }

  return {
    changed: true,
    state: changedState(candidate.claims, candidate.evidence),
  };
}

export function addEvidence(
  state: EvidenceState,
  record: unknown,
): AddEvidenceResult;
export function addEvidence(
  state: EvidenceState,
  id: unknown,
  outcome: unknown,
  subject?: unknown,
): AddEvidenceResult;
export function addEvidence(
  state: EvidenceState,
  idOrRecord: unknown,
  outcome?: unknown,
  subject?: unknown,
): AddEvidenceResult {
  const record: unknown =
    arguments.length < 3
      ? idOrRecord
      : {
          id: idOrRecord,
          outcome,
          ...(subject === undefined ? {} : { subject }),
        };

  const candidate: CandidateState = {
    claims: [...state.claims],
    evidence: [...state.evidence, record],
  };
  if (!candidateIsValid(candidate)) {
    return invalidMutation();
  }

  return {
    changed: true,
    state: changedState(candidate.claims, candidate.evidence),
  };
}

export function replaceEvidence(
  state: EvidenceState,
  record: unknown,
): ReplaceEvidenceResult;
export function replaceEvidence(
  state: EvidenceState,
  id: unknown,
  outcome: unknown,
  subject?: unknown,
): ReplaceEvidenceResult;
export function replaceEvidence(
  state: EvidenceState,
  idOrRecord: unknown,
  outcome?: unknown,
  subject?: unknown,
): ReplaceEvidenceResult {
  const record: unknown =
    arguments.length < 3
      ? idOrRecord
      : {
          id: idOrRecord,
          outcome,
          ...(subject === undefined ? {} : { subject }),
        };

  if (!isPlainRecord(record) || !isValidIdentifier(record.id)) {
    return invalidMutation();
  }

  const index = state.evidence.findIndex((evidence) => evidence.id === record.id);
  if (index < 0) {
    return { changed: false, reason: 'not_found' };
  }

  const candidate: CandidateState = {
    claims: [...state.claims],
    evidence: state.evidence.map((current, evidenceIndex) =>
      evidenceIndex === index ? record : current,
    ),
  };
  if (!candidateIsValid(candidate)) {
    return invalidMutation();
  }

  return {
    changed: true,
    state: changedState(candidate.claims, candidate.evidence),
  };
}

export function removeEvidence(
  state: EvidenceState,
  id: unknown,
): RemoveEvidenceResult {
  if (!isValidIdentifier(id)) {
    return invalidMutation();
  }

  const index = state.evidence.findIndex((record) => record.id === id);
  if (index < 0) {
    return { changed: false, reason: 'not_found' };
  }

  const candidate: CandidateState = {
    claims: [...state.claims],
    evidence: state.evidence.filter(
      (_record, evidenceIndex) => evidenceIndex !== index,
    ),
  };
  if (!candidateIsValid(candidate)) {
    return invalidMutation();
  }

  return {
    changed: true,
    state: changedState(candidate.claims, candidate.evidence),
  };
}

export function clearState(): EvidenceState;
export function clearState(state: EvidenceState): ClearStateResult;
export function clearState(state?: EvidenceState): EvidenceState | ClearStateResult {
  if (state === undefined) {
    return createEmptyState();
  }

  const candidate: CandidateState = { claims: [], evidence: [] };
  if (!candidateIsValid(candidate)) {
    return invalidMutation();
  }
  if (isFreshState(state)) {
    return { changed: false, reason: 'no_change' };
  }

  return { changed: true, state: createEmptyState() };
}

export function isFreshState(state: EvidenceState): boolean {
  return state.claims.length === 0 && state.evidence.length === 0;
}

export function judgeState(state: EvidenceState): EvidenceVerdict {
  return judgeEvidence({
    claims: state.claims,
    evidence: state.evidence,
  });
}

export { isPlainRecord, hasOwn, hasOnlyKeys };
