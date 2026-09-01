import { describe, expect, it } from 'vitest';
import {
  SupervisorContractError,
  validateSupervisorFeatureDescriptor,
  validateSupervisorFeatureModule,
  validateSupervisorFeatureStateCodec,
} from '../src/index.js';
import type {
  JsonValue,
  SupervisorFeatureModule,
  SupervisorFeatureRuntimeContext,
} from '../src/index.js';

function descriptor() {
  return validateSupervisorFeatureDescriptor({
    id: 'feature-a',
    schemaVersion: 1,
    maturity: 'validated',
    defaultMode: 'observe',
    observes: ['tool-result'],
    provides: [],
    requires: [],
    conflictsWith: [],
    usesAuxiliaryModel: false,
    interventionIntents: [],
  });
}

describe('supervisor feature module boundary', () => {
  it('does not expose a feature-to-feature handle', () => {
    const context = {} as SupervisorFeatureRuntimeContext;
    // @ts-expect-error Context deliberately has no feature lookup handle.
    const featureHandle = context.getFeature;
    expect(featureHandle).toBeUndefined();
  });

  it('types a module without a codec as stateless', () => {
    const module = {
      descriptor: descriptor(),
      create: () => ({ onObservation: () => undefined }),
    } satisfies SupervisorFeatureModule;

    expect(validateSupervisorFeatureModule(module).state).toBeUndefined();
  });

  it('carries a state type through a required codec and whole-state emission', () => {
    type State = { readonly count: number };
    const module = {
      descriptor: descriptor(),
      state: {
        schemaVersion: 1,
        validate: (value: unknown): State => ({ count: value === null ? 0 : 1 }),
      },
      create: (context) => ({
        onObservation: () => ({ nextState: { count: context.initialState?.count ?? 0 } }),
      }),
    } satisfies SupervisorFeatureModule<JsonValue, State>;

    expect(module.state.validate(null)).toEqual({ count: 0 });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a state codec schemaVersion that is not a positive safe integer: %s',
    (schemaVersion) => {
      expect(() =>
        validateSupervisorFeatureStateCodec({
          schemaVersion,
          validate: () => ({ count: 0 }),
        }),
      ).toThrow(SupervisorContractError);
    },
  );

  it('validates a module codec while preserving stateless modules', () => {
    const create = () => ({ onObservation: () => undefined });
    const stateless = validateSupervisorFeatureModule({ descriptor: descriptor(), create });
    expect(stateless.state).toBeUndefined();

    const stateful = validateSupervisorFeatureModule<JsonValue, { readonly count: number }>({
      descriptor: descriptor(),
      create,
      state: { schemaVersion: 2, validate: () => ({ count: 0 }) },
    });
    expect(stateful.state?.schemaVersion).toBe(2);
  });

  it('rejects a malformed module state codec', () => {
    expect(() =>
      validateSupervisorFeatureModule({
        descriptor: descriptor(),
        create: () => ({}),
        state: { schemaVersion: 1, validate: 'not-a-function' },
      }),
    ).toThrow(SupervisorContractError);
  });
});
