import { SupervisorContractError } from './errors.js';
import { isJsonValue, type JsonValue } from './json.js';
import { isSupervisorFeatureId } from './ids.js';
import { hasOnlyAllowedKeys, hasOwn, isPlainObject } from './internal.js';

export const SUPERVISOR_OBSERVATION_KINDS = [
  'root-request-started',
  'before-tool-call',
  'tool-result',
  'turn-ended',
  'agent-settled',
  'session-started',
  'session-shutdown',
  'before-compact',
  'compacted',
  'compaction-failed',
  'context-changed',
] as const;

export type SupervisorBuiltinObservationKind = (typeof SUPERVISOR_OBSERVATION_KINDS)[number];
export type SupervisorObservationKind =
  | SupervisorBuiltinObservationKind
  | (string & Record<never, never>);

export interface SupervisorObservation<TPayload extends JsonValue = JsonValue> {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly sequence: number;
  readonly rootRequestId: string | null;
  readonly kind: SupervisorObservationKind;
  readonly payload: TPayload;
}

const ALLOWED_OBSERVATION_KEYS = new Set([
  'schemaVersion',
  'id',
  'sequence',
  'rootRequestId',
  'kind',
  'payload',
]);

export function isSupervisorObservationKind(value: unknown): value is SupervisorObservationKind {
  return isSupervisorFeatureId(value);
}

function invalidObservation(): never {
  throw new SupervisorContractError('invalid_observation', 'Invalid supervisor observation.');
}

export function validateSupervisorObservation(value: unknown): SupervisorObservation {
  if (!isPlainObject(value)) {
    return invalidObservation();
  }

  try {
    if (!hasOnlyAllowedKeys(value, ALLOWED_OBSERVATION_KEYS)) {
      return invalidObservation();
    }
    if (
      !hasOwn(value, 'schemaVersion') ||
      !hasOwn(value, 'id') ||
      !hasOwn(value, 'sequence') ||
      !hasOwn(value, 'rootRequestId') ||
      !hasOwn(value, 'kind') ||
      !hasOwn(value, 'payload')
    ) {
      return invalidObservation();
    }

    const schemaVersion = value.schemaVersion;
    const id = value.id;
    const sequence = value.sequence;
    const rootRequestId = value.rootRequestId;
    const kind = value.kind;
    const payload = value.payload;

    if (schemaVersion !== 1 || typeof id !== 'string' || id.length === 0) {
      return invalidObservation();
    }
    // Sequence is canonical ordering; no wall-clock field is part of this envelope.
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) {
      return invalidObservation();
    }
    if (rootRequestId !== null && typeof rootRequestId !== 'string') {
      return invalidObservation();
    }
    if (!isSupervisorObservationKind(kind) || !isJsonValue(payload)) {
      return invalidObservation();
    }

    return { schemaVersion: 1, id, sequence, rootRequestId, kind, payload };
  } catch (error) {
    if (error instanceof SupervisorContractError) {
      throw error;
    }
    return invalidObservation();
  }
}
