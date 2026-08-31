import { SupervisorContractError } from './errors.js';

export const SUPERVISOR_ID_SEGMENT_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const SUPERVISOR_KERNEL_SOURCE_ID = 'kernel';

const SUPERVISOR_RESERVED_FEATURE_IDS: ReadonlySet<string> = new Set([
  SUPERVISOR_KERNEL_SOURCE_ID,
]);
const SUPERVISOR_NAMESPACED_ID_PATTERN =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*:[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

// The same strict segment grammar is used on both sides of the namespace separator.
function isSupervisorIdSegment(value: unknown): value is string {
  return typeof value === 'string' && SUPERVISOR_ID_SEGMENT_PATTERN.test(value);
}

export function isSupervisorFeatureId(value: unknown): value is string {
  return isSupervisorIdSegment(value);
}

export function isRegistrableSupervisorFeatureId(value: unknown): value is string {
  return isSupervisorFeatureId(value) && !SUPERVISOR_RESERVED_FEATURE_IDS.has(value);
}

export function isSupervisorNamespacedId(value: unknown): value is string {
  return typeof value === 'string' && SUPERVISOR_NAMESPACED_ID_PATTERN.test(value);
}

export function isSupervisorCapabilityId(value: unknown): value is string {
  return isSupervisorNamespacedId(value);
}

export function isSupervisorFactKind(value: unknown): value is string {
  return isSupervisorNamespacedId(value);
}

export function isSupervisorReasonCode(value: unknown): value is string {
  return isSupervisorNamespacedId(value);
}

export function assertSupervisorFeatureId(value: unknown): asserts value is string {
  if (!isSupervisorFeatureId(value)) {
    throw new SupervisorContractError('invalid_id', 'Invalid supervisor feature ID.');
  }
}

export function assertRegistrableSupervisorFeatureId(value: unknown): asserts value is string {
  if (!isRegistrableSupervisorFeatureId(value)) {
    throw new SupervisorContractError('invalid_id', 'Invalid registrable supervisor feature ID.');
  }
}

export function assertSupervisorNamespacedId(value: unknown): asserts value is string {
  if (!isSupervisorNamespacedId(value)) {
    throw new SupervisorContractError('invalid_id', 'Invalid supervisor namespaced ID.');
  }
}

export function assertSupervisorCapabilityId(value: unknown): asserts value is string {
  if (!isSupervisorCapabilityId(value)) {
    throw new SupervisorContractError('invalid_id', 'Invalid supervisor capability ID.');
  }
}

export function assertSupervisorFactKind(value: unknown): asserts value is string {
  if (!isSupervisorFactKind(value)) {
    throw new SupervisorContractError('invalid_id', 'Invalid supervisor fact kind.');
  }
}

export function assertSupervisorReasonCode(value: unknown): asserts value is string {
  if (!isSupervisorReasonCode(value)) {
    throw new SupervisorContractError('invalid_id', 'Invalid supervisor reason code.');
  }
}
