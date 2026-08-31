import { SupervisorContractError } from './errors.js';
import { isJsonValue, type JsonValue } from './json.js';
import {
  isSupervisorFeatureId,
  isSupervisorNamespacedId,
} from './ids.js';
import { hasOnlyAllowedKeys, hasOwn, isDenseArray, isPlainObject } from './internal.js';

// Candidates carry no id, sequence, sourceFeatureId, or rootRequestId.
// Global fact identity and ordering belong to the kernel.
export interface SupervisorFactCandidate {
  readonly kind: string;
  readonly evidenceRefs: readonly string[];
  readonly data: JsonValue;
}

export interface SupervisorFactRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly sequence: number;
  readonly sourceFeatureId: string;
  readonly rootRequestId: string | null;
  readonly kind: string;
  readonly evidenceRefs: readonly string[];
  readonly data: JsonValue;
}

export const SUPERVISOR_KERNEL_FACT_NAMESPACE = 'kernel';

const ALLOWED_FACT_CANDIDATE_KEYS = new Set(['kind', 'evidenceRefs', 'data']);

function invalidFact(): never {
  throw new SupervisorContractError('invalid_fact', 'Invalid supervisor fact.');
}

function isEvidenceRefs(value: unknown): value is readonly string[] {
  if (!isDenseArray(value)) {
    return false;
  }

  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const evidenceRef = value[index];
    if (typeof evidenceRef !== 'string' || evidenceRef.length === 0 || seen.has(evidenceRef)) {
      return false;
    }
    seen.add(evidenceRef);
  }
  return true;
}

export function validateSupervisorFactCandidate(value: unknown): SupervisorFactCandidate {
  if (!isPlainObject(value)) {
    return invalidFact();
  }

  try {
    if (!hasOnlyAllowedKeys(value, ALLOWED_FACT_CANDIDATE_KEYS)) {
      return invalidFact();
    }
    if (!hasOwn(value, 'kind') || !hasOwn(value, 'evidenceRefs') || !hasOwn(value, 'data')) {
      return invalidFact();
    }

    const kind = value.kind;
    const evidenceRefs = value.evidenceRefs;
    const data = value.data;
    if (!isSupervisorNamespacedId(kind) || !isEvidenceRefs(evidenceRefs) || !isJsonValue(data)) {
      return invalidFact();
    }

    return { kind, evidenceRefs: [...evidenceRefs], data };
  } catch (error) {
    if (error instanceof SupervisorContractError) {
      throw error;
    }
    return invalidFact();
  }
}

export function createSupervisorFactRecord(input: {
  readonly candidate: SupervisorFactCandidate;
  readonly sourceFeatureId: string;
  readonly rootRequestId: string | null;
  readonly sequence: number;
}): SupervisorFactRecord {
  try {
    const candidate = validateSupervisorFactCandidate(input.candidate);
    const { sourceFeatureId, rootRequestId, sequence } = input;
    if (
      !isSupervisorFeatureId(sourceFeatureId) ||
      (rootRequestId !== null && typeof rootRequestId !== 'string') ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0
    ) {
      return invalidFact();
    }

    const separatorIndex = candidate.kind.indexOf(':');
    const namespace = candidate.kind.slice(0, separatorIndex);
    const expectedNamespace =
      sourceFeatureId === SUPERVISOR_KERNEL_FACT_NAMESPACE
        ? SUPERVISOR_KERNEL_FACT_NAMESPACE
        : sourceFeatureId;
    if (namespace !== expectedNamespace) {
      return invalidFact();
    }

    // Fact IDs are kernel-owned and derived only from the canonical sequence: fact-${sequence}.
    return {
      schemaVersion: 1,
      id: `fact-${sequence}`,
      sequence,
      sourceFeatureId,
      rootRequestId,
      kind: candidate.kind,
      evidenceRefs: candidate.evidenceRefs,
      data: candidate.data,
    };
  } catch (error) {
    if (error instanceof SupervisorContractError) {
      throw error;
    }
    return invalidFact();
  }
}

export interface SupervisorFactSnapshot {
  all(): readonly SupervisorFactRecord[];
  byKind(kind: string): readonly SupervisorFactRecord[];
}

const EMPTY_FACT_RECORDS: readonly SupervisorFactRecord[] = Object.freeze([]);

function compareFacts(left: SupervisorFactRecord, right: SupervisorFactRecord): number {
  if (left.sequence < right.sequence) {
    return -1;
  }
  if (left.sequence > right.sequence) {
    return 1;
  }
  if (left.id < right.id) {
    return -1;
  }
  if (left.id > right.id) {
    return 1;
  }
  return 0;
}

export function createSupervisorFactSnapshot(
  records: readonly SupervisorFactRecord[],
): SupervisorFactSnapshot {
  const copiedRecords = records.map((record) =>
    Object.freeze({
      ...record,
      evidenceRefs: Object.freeze([...record.evidenceRefs]),
    }),
  );
  const allRecords = Object.freeze(copiedRecords.sort(compareFacts));
  const kindRecords = new Map<string, readonly SupervisorFactRecord[]>();

  for (const record of allRecords) {
    const existing = kindRecords.get(record.kind);
    const next = existing === undefined ? [record] : [...existing, record];
    kindRecords.set(record.kind, Object.freeze(next));
  }

  const snapshot: SupervisorFactSnapshot = {
    all(): readonly SupervisorFactRecord[] {
      return allRecords;
    },
    byKind(kind: string): readonly SupervisorFactRecord[] {
      return kindRecords.get(kind) ?? EMPTY_FACT_RECORDS;
    },
  };
  return Object.freeze(snapshot);
}
