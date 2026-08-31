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

const ALLOWED_STATE_ENVELOPE_KEYS = new Set([
  'schemaVersion',
  'featureId',
  'featureSchemaVersion',
  'data',
]);

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
