import { SupervisorContractError } from './errors.js';
import {
  isRegistrableSupervisorFeatureId,
  isSupervisorCapabilityId,
} from './ids.js';
import {
  SUPERVISOR_INTERVENTION_INTENTS,
  type SupervisorInterventionIntent,
} from './intervention.js';
import { isSupervisorObservationKind, type SupervisorObservationKind } from './observation.js';
import { hasOnlyAllowedKeys, hasOwn, isDenseArray, isPlainObject } from './internal.js';

export type SupervisorMode = 'autonomous' | 'observe' | 'off';
export type SupervisorFeatureMode = 'autonomous' | 'observe' | 'off';
/** `unavailable` is a runtime resolution result and is never a persisted user setting. */
export type EffectiveFeatureMode = 'autonomous' | 'observe' | 'off' | 'unavailable';

/**
 * `experimental` is new behavior normally introduced in observe mode; `validated` has benchmark
 * evidence; `default` is worth enabling autonomously in the install-and-forget profile.
 */
export type FeatureMaturity = 'experimental' | 'validated' | 'default';

export interface SupervisorFeatureDescriptor {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly maturity: FeatureMaturity;
  readonly defaultMode: SupervisorFeatureMode;
  readonly observes: readonly SupervisorObservationKind[];
  readonly provides: readonly string[];
  readonly requires: readonly string[];
  readonly conflictsWith: readonly string[];
  readonly usesAuxiliaryModel: boolean;
  readonly interventionIntents: readonly SupervisorInterventionIntent[];
}

export interface SupervisorFeatureRegistration {
  readonly descriptor: SupervisorFeatureDescriptor;
}

const ALLOWED_DESCRIPTOR_KEYS = new Set([
  'id',
  'schemaVersion',
  'maturity',
  'defaultMode',
  'observes',
  'provides',
  'requires',
  'conflictsWith',
  'usesAuxiliaryModel',
  'interventionIntents',
]);

function isFeatureMaturity(value: unknown): value is FeatureMaturity {
  return value === 'experimental' || value === 'validated' || value === 'default';
}

function isFeatureMode(value: unknown): value is SupervisorFeatureMode {
  return value === 'autonomous' || value === 'observe' || value === 'off';
}

function isInterventionIntent(value: unknown): value is SupervisorInterventionIntent {
  return (
    typeof value === 'string' &&
    (SUPERVISOR_INTERVENTION_INTENTS as readonly string[]).includes(value)
  );
}

function readUniqueArray<T extends string>(
  value: unknown,
  isValid: (entry: unknown) => entry is T,
): T[] | null {
  if (!isDenseArray(value)) {
    return null;
  }

  const entries: T[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (!isValid(entry) || seen.has(entry)) {
      return null;
    }
    seen.add(entry);
    entries.push(entry);
  }
  return entries;
}

function invalidDescriptor(): never {
  throw new SupervisorContractError('invalid_descriptor', 'Invalid supervisor feature descriptor.');
}

export function validateSupervisorFeatureDescriptor(
  value: unknown,
): SupervisorFeatureDescriptor {
  if (!isPlainObject(value)) {
    return invalidDescriptor();
  }

  try {
    if (!hasOnlyAllowedKeys(value, ALLOWED_DESCRIPTOR_KEYS)) {
      return invalidDescriptor();
    }
    if (
      !hasOwn(value, 'id') ||
      !hasOwn(value, 'schemaVersion') ||
      !hasOwn(value, 'maturity') ||
      !hasOwn(value, 'defaultMode') ||
      !hasOwn(value, 'observes') ||
      !hasOwn(value, 'provides') ||
      !hasOwn(value, 'requires') ||
      !hasOwn(value, 'conflictsWith') ||
      !hasOwn(value, 'usesAuxiliaryModel') ||
      !hasOwn(value, 'interventionIntents')
    ) {
      return invalidDescriptor();
    }

    const id = value.id;
    const schemaVersion = value.schemaVersion;
    const maturity = value.maturity;
    const defaultMode = value.defaultMode;
    const usesAuxiliaryModel = value.usesAuxiliaryModel;

    if (
      !isRegistrableSupervisorFeatureId(id) ||
      schemaVersion !== 1 ||
      !isFeatureMaturity(maturity) ||
      !isFeatureMode(defaultMode) ||
      typeof usesAuxiliaryModel !== 'boolean' ||
      (maturity === 'experimental' && defaultMode === 'autonomous')
    ) {
      return invalidDescriptor();
    }

    const observes = readUniqueArray(value.observes, isSupervisorObservationKind);
    const provides = readUniqueArray(value.provides, isSupervisorCapabilityId);
    const requires = readUniqueArray(value.requires, isSupervisorCapabilityId);
    const conflictsWith = readUniqueArray(value.conflictsWith, isRegistrableSupervisorFeatureId);
    const interventionIntents = readUniqueArray(value.interventionIntents, isInterventionIntent);

    if (
      observes === null ||
      provides === null ||
      requires === null ||
      conflictsWith === null ||
      interventionIntents === null ||
      conflictsWith.includes(id)
    ) {
      return invalidDescriptor();
    }

    return {
      id,
      schemaVersion: 1,
      maturity,
      defaultMode,
      observes,
      provides,
      requires,
      conflictsWith,
      usesAuxiliaryModel,
      interventionIntents,
    };
  } catch (error) {
    if (error instanceof SupervisorContractError) {
      throw error;
    }
    return invalidDescriptor();
  }
}
