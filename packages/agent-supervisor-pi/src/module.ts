import { SupervisorContractError } from './errors.js';
import {
  validateSupervisorFeatureDescriptor,
  type SupervisorFeatureDescriptor,
  type SupervisorFeatureRegistration,
} from './feature.js';
import type {
  SupervisorFactCandidate,
  SupervisorFactSnapshot,
} from './fact.js';
import type { SupervisorInterventionProposal } from './intervention.js';
import type { JsonValue } from './json.js';
import type { SupervisorObservation } from './observation.js';
import { hasOnlyAllowedKeys, hasOwn, isPlainObject } from './internal.js';

export interface SupervisorFeatureStateCodec<TState extends JsonValue = JsonValue> {
  readonly schemaVersion: number;
  readonly validate: (value: unknown) => TState;
}

export interface SupervisorFeatureEmission<TState extends JsonValue = JsonValue> {
  readonly facts?: readonly SupervisorFactCandidate[];
  readonly interventions?: readonly SupervisorInterventionProposal[];
  /** A nextState is a WHOLE-state replacement; partial or implicit mutation is not supported. */
  readonly nextState?: TState;
}

export interface SupervisorFeatureRuntimeContext<TState extends JsonValue = JsonValue> {
  readonly featureId: string;
  readonly effectiveMode: 'autonomous' | 'observe';
  readonly facts: SupervisorFactSnapshot;
  readonly state: TState | null;
}

export interface SupervisorFeatureContext<
  TConfig extends JsonValue = JsonValue,
  TState extends JsonValue = JsonValue,
> {
  readonly featureId: string;
  readonly config: TConfig;
  readonly initialState: TState | null;
  readonly effectiveMode: 'autonomous' | 'observe';
}

export interface SupervisorFeatureRuntime<TState extends JsonValue = JsonValue> {
  readonly onObservation?: (
    observation: SupervisorObservation,
    context: SupervisorFeatureRuntimeContext<TState>,
  ) => void | SupervisorFeatureEmission<TState> | Promise<void | SupervisorFeatureEmission<TState>>;
  readonly dispose?: () => void | Promise<void>;
}

/**
 * ARCHITECTURAL INVARIANT: neither context type exposes a handle to another feature.
 * There is deliberately no getFeature, callFeature, features, registry, emit, or bus member.
 * Features communicate only through the observation bus, the fact bus, and intervention proposals
 * routed through the kernel.
 */
type SupervisorFeatureModuleShape<
  TConfig extends JsonValue,
  TState extends JsonValue,
> = SupervisorFeatureRegistration & {
  readonly descriptor: SupervisorFeatureDescriptor;
  readonly validateConfig?: (value: unknown) => TConfig;
  readonly create: (
    context: SupervisorFeatureContext<TConfig, TState>,
  ) => SupervisorFeatureRuntime<TState>;
};

type SupervisorFeatureModuleState<TState extends JsonValue> = [TState] extends [never]
  ? { readonly state?: never }
  : { readonly state: SupervisorFeatureStateCodec<TState> };

/**
 * The default `never` state parameter describes a stateless module. Supplying a state type makes
 * the codec required and carries that type through runtime contexts and whole-state emissions.
 */
export type SupervisorFeatureModule<
  TConfig extends JsonValue = JsonValue,
  TState extends JsonValue = never,
> = SupervisorFeatureModuleShape<TConfig, TState> & SupervisorFeatureModuleState<TState>;

const ALLOWED_STATE_CODEC_KEYS = new Set(['schemaVersion', 'validate']);
const ALLOWED_MODULE_KEYS = new Set(['descriptor', 'validateConfig', 'state', 'create']);

function invalidStateCodec(): never {
  throw new SupervisorContractError('invalid_state', 'Invalid supervisor feature state codec.');
}

function invalidModule(): never {
  throw new SupervisorContractError('invalid_descriptor', 'Invalid supervisor feature module.');
}

export function validateSupervisorFeatureStateCodec<TState extends JsonValue = JsonValue>(
  value: unknown,
): SupervisorFeatureStateCodec<TState> {
  if (!isPlainObject(value)) {
    return invalidStateCodec();
  }

  try {
    if (
      !hasOnlyAllowedKeys(value, ALLOWED_STATE_CODEC_KEYS) ||
      !hasOwn(value, 'schemaVersion') ||
      !hasOwn(value, 'validate')
    ) {
      return invalidStateCodec();
    }

    const schemaVersion = value.schemaVersion;
    const validate = value.validate;
    if (
      typeof schemaVersion !== 'number' ||
      !Number.isSafeInteger(schemaVersion) ||
      schemaVersion <= 0 ||
      typeof validate !== 'function'
    ) {
      return invalidStateCodec();
    }

    return {
      schemaVersion,
      validate: validate as (value: unknown) => TState,
    };
  } catch (error) {
    if (error instanceof SupervisorContractError) {
      throw error;
    }
    return invalidStateCodec();
  }
}

export function validateSupervisorFeatureModule<
  TConfig extends JsonValue = JsonValue,
  TState extends JsonValue = never,
>(value: unknown): SupervisorFeatureModule<TConfig, TState> {
  if (!isPlainObject(value)) {
    return invalidModule();
  }

  try {
    if (
      !hasOnlyAllowedKeys(value, ALLOWED_MODULE_KEYS) ||
      !hasOwn(value, 'descriptor') ||
      !hasOwn(value, 'create')
    ) {
      return invalidModule();
    }

    const descriptor = validateSupervisorFeatureDescriptor(value.descriptor);
    const create = value.create;
    if (typeof create !== 'function') {
      return invalidModule();
    }

    const hasValidateConfig = hasOwn(value, 'validateConfig');
    const validateConfig = value.validateConfig;
    if (hasValidateConfig && typeof validateConfig !== 'function') {
      return invalidModule();
    }

    const base = {
      descriptor,
      ...(hasValidateConfig
        ? { validateConfig: validateConfig as (value: unknown) => TConfig }
        : {}),
      create: create as SupervisorFeatureModuleShape<TConfig, TState>['create'],
    };

    if (hasOwn(value, 'state')) {
      const state = validateSupervisorFeatureStateCodec<TState>(value.state);
      return { ...base, state } as unknown as SupervisorFeatureModule<TConfig, TState>;
    }

    return base as SupervisorFeatureModule<TConfig, TState>;
  } catch (error) {
    if (error instanceof SupervisorContractError && error.code === 'invalid_descriptor') {
      throw error;
    }
    return invalidModule();
  }
}
