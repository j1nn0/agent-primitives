import { SupervisorContractError } from './errors.js';
import { isRegistrableSupervisorFeatureId } from './ids.js';
import { isJsonValue, type JsonValue } from './json.js';
import { hasOnlyAllowedKeys, hasOwn, isPlainObject } from './internal.js';

// Binding this name to a real Pi persistence custom type belongs to S1.
export const SUPERVISOR_STATE_CUSTOM_TYPE = 'agent-supervisor-state';

export interface SupervisorFeatureStateEnvelope {
  readonly schemaVersion: 1;
  readonly featureId: string;
  readonly featureSchemaVersion: number;
  readonly data: JsonValue;
}

export interface SupervisorRuntimeStateV1 {
  readonly schemaVersion: 1;
  readonly nextRootRequestSequence: number;
  /** Future compatible runtime fields must remain JSON-safe. */
  readonly [key: string]: JsonValue;
}

export const DEFAULT_SUPERVISOR_RUNTIME_STATE: SupervisorRuntimeStateV1 = Object.freeze({
  schemaVersion: 1,
  nextRootRequestSequence: 1,
});

export interface SupervisorRuntimeStateRecordV1 {
  readonly schemaVersion: 1;
  readonly kind: 'runtime';
  readonly state: SupervisorRuntimeStateV1;
}

export interface SupervisorFeatureStateRecordV1 {
  readonly schemaVersion: 1;
  readonly kind: 'feature';
  readonly state: SupervisorFeatureStateEnvelope;
}

export type SupervisorStateRecordV1 =
  | SupervisorRuntimeStateRecordV1
  | SupervisorFeatureStateRecordV1;

export type SupervisorStateDiagnosticCode =
  | 'invalid-top-level'
  | 'invalid-schema-version'
  | 'invalid-record-kind'
  | 'invalid-runtime-state'
  | 'invalid-feature-state';

export interface SupervisorStateDiagnostic {
  readonly code: SupervisorStateDiagnosticCode;
}

export type SupervisorStateRecordParseResult =
  | {
      readonly status: 'valid';
      readonly record: SupervisorStateRecordV1;
    }
  | {
      readonly status: 'invalid';
      readonly diagnostics: readonly SupervisorStateDiagnostic[];
    };

const ALLOWED_STATE_ENVELOPE_KEYS = new Set([
  'schemaVersion',
  'featureId',
  'featureSchemaVersion',
  'data',
]);
const ALLOWED_STATE_RECORD_KEYS = new Set(['schemaVersion', 'kind', 'state']);

function invalidState(): never {
  throw new SupervisorContractError('invalid_state', 'Invalid supervisor feature state.');
}

export function validateSupervisorFeatureStateEnvelope(
  value: unknown,
): SupervisorFeatureStateEnvelope {
  if (!isPlainObject(value)) {
    return invalidState();
  }

  try {
    if (!hasOnlyAllowedKeys(value, ALLOWED_STATE_ENVELOPE_KEYS)) {
      return invalidState();
    }
    if (
      !hasOwn(value, 'schemaVersion') ||
      !hasOwn(value, 'featureId') ||
      !hasOwn(value, 'featureSchemaVersion') ||
      !hasOwn(value, 'data')
    ) {
      return invalidState();
    }

    const schemaVersion = value.schemaVersion;
    const featureId = value.featureId;
    const featureSchemaVersion = value.featureSchemaVersion;
    const data = value.data;
    // Feature state migration is the feature's responsibility; the kernel treats data as opaque JSON.
    if (
      schemaVersion !== 1 ||
      !isRegistrableSupervisorFeatureId(featureId) ||
      typeof featureSchemaVersion !== 'number' ||
      !Number.isSafeInteger(featureSchemaVersion) ||
      featureSchemaVersion <= 0 ||
      !isJsonValue(data)
    ) {
      return invalidState();
    }

    return { schemaVersion: 1, featureId, featureSchemaVersion, data };
  } catch (error) {
    if (error instanceof SupervisorContractError) {
      throw error;
    }
    return invalidState();
  }
}

function invalidRecord(code: SupervisorStateDiagnosticCode): SupervisorStateRecordParseResult {
  return { status: 'invalid', diagnostics: [{ code }] };
}

function parseRuntimeState(value: unknown): SupervisorRuntimeStateV1 | null {
  if (!isPlainObject(value) || !isJsonValue(value)) {
    return null;
  }

  try {
    if (!hasOwn(value, 'schemaVersion') || !hasOwn(value, 'nextRootRequestSequence')) {
      return null;
    }

    const schemaVersion = value.schemaVersion;
    const nextRootRequestSequence = value.nextRootRequestSequence;
    if (
      schemaVersion !== 1 ||
      typeof nextRootRequestSequence !== 'number' ||
      !Number.isSafeInteger(nextRootRequestSequence) ||
      nextRootRequestSequence < 1
    ) {
      return null;
    }

    return { ...value, schemaVersion: 1, nextRootRequestSequence } as SupervisorRuntimeStateV1;
  } catch {
    return null;
  }
}

export function parseSupervisorStateRecord(value: unknown): SupervisorStateRecordParseResult {
  try {
    if (!isPlainObject(value)) {
      return invalidRecord('invalid-top-level');
    }
    if (!hasOnlyAllowedKeys(value, ALLOWED_STATE_RECORD_KEYS)) {
      return invalidRecord('invalid-top-level');
    }
    if (!hasOwn(value, 'schemaVersion') || !hasOwn(value, 'kind') || !hasOwn(value, 'state')) {
      return invalidRecord('invalid-top-level');
    }

    if (value.schemaVersion !== 1) {
      return invalidRecord('invalid-schema-version');
    }
    if (value.kind !== 'runtime' && value.kind !== 'feature') {
      return invalidRecord('invalid-record-kind');
    }

    if (value.kind === 'runtime') {
      const state = parseRuntimeState(value.state);
      return state === null
        ? invalidRecord('invalid-runtime-state')
        : { status: 'valid', record: { schemaVersion: 1, kind: 'runtime', state } };
    }

    try {
      const state = validateSupervisorFeatureStateEnvelope(value.state);
      return { status: 'valid', record: { schemaVersion: 1, kind: 'feature', state } };
    } catch {
      return invalidRecord('invalid-feature-state');
    }
  } catch {
    return invalidRecord('invalid-top-level');
  }
}
