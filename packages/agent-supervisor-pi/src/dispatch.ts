import { SupervisorContractError } from './errors.js';
import {
  createSupervisorFactRecord,
  createSupervisorFactSnapshot,
  validateSupervisorFactCandidate,
  type SupervisorFactCandidate,
  type SupervisorFactRecord,
} from './fact.js';
import type { EffectiveFeatureMode } from './feature.js';
import {
  validateSupervisorInterventionProposal,
  type SupervisorInterventionProposal,
} from './intervention.js';
import {
  type SupervisorFeatureEmission,
  type SupervisorFeatureRuntime,
} from './module.js';
import { assertJsonValue, type JsonValue } from './json.js';
import { isRegistrableSupervisorFeatureId } from './ids.js';
import type { SupervisorObservation, SupervisorObservationKind } from './observation.js';
import { hasOnlyAllowedKeys, hasOwn, isDenseArray, isPlainObject } from './internal.js';

export interface SupervisorDispatchFeature {
  readonly featureId: string;
  readonly effectiveMode: EffectiveFeatureMode;
  readonly observes: readonly SupervisorObservationKind[];
  readonly runtime: SupervisorFeatureRuntime;
  readonly state: JsonValue | null;
}

export interface SupervisorDispatchInput {
  readonly observation: SupervisorObservation;
  readonly features: readonly SupervisorDispatchFeature[];
  readonly facts: readonly SupervisorFactRecord[];
  readonly nextFactSequence: number;
}

export interface SupervisorDispatchResult {
  readonly emittedFacts: readonly SupervisorFactRecord[];
  readonly proposals: readonly SupervisorInterventionProposal[];
  readonly nextStates: Readonly<Record<string, JsonValue>>;
  readonly nextFactSequence: number;
}

const ALLOWED_EMISSION_KEYS = new Set(['facts', 'interventions', 'nextState']);

function invalidDispatch(): never {
  throw new SupervisorContractError('invalid_dispatch', 'Invalid supervisor dispatch result.');
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function validateDispatchFeatureIdentities(features: readonly SupervisorDispatchFeature[]): void {
  const seen = new Set<string>();
  for (const feature of features) {
    if (!isRegistrableSupervisorFeatureId(feature.featureId) || seen.has(feature.featureId)) {
      return invalidDispatch();
    }
    seen.add(feature.featureId);
  }
}

function validateEmission(value: unknown): SupervisorFeatureEmission | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value) || !hasOnlyAllowedKeys(value, ALLOWED_EMISSION_KEYS)) {
    return invalidDispatch();
  }
  return value as SupervisorFeatureEmission;
}

function readCandidates(value: unknown): readonly unknown[] {
  if (!isDenseArray(value)) {
    return invalidDispatch();
  }
  return value;
}

export async function dispatchObservation(input: SupervisorDispatchInput): Promise<SupervisorDispatchResult> {
  validateDispatchFeatureIdentities(input.features);
  if (!Number.isSafeInteger(input.nextFactSequence) || input.nextFactSequence < 0) {
    return invalidDispatch();
  }

  // Every feature receives this one pre-dispatch view; buffered emissions never enter it.
  const facts = createSupervisorFactSnapshot(input.facts);
  const emittedFacts: SupervisorFactRecord[] = [];
  const proposals: SupervisorInterventionProposal[] = [];
  const nextStates: Record<string, JsonValue> = {};
  let nextFactSequence = input.nextFactSequence;

  const features = [...input.features].sort((left, right) =>
    compareStrings(left.featureId, right.featureId),
  );
  for (const feature of features) {
    if (
      feature.effectiveMode === 'off' ||
      feature.effectiveMode === 'unavailable' ||
      !feature.observes.includes(input.observation.kind)
    ) {
      continue;
    }

    const onObservation = feature.runtime.onObservation;
    if (onObservation === undefined) {
      continue;
    }

    const emission = validateEmission(
      await onObservation(input.observation, {
        featureId: feature.featureId,
        effectiveMode: feature.effectiveMode,
        facts,
        state: feature.state,
      }),
    );
    if (emission === undefined) {
      continue;
    }

    if (hasOwn(emission, 'facts')) {
      const candidates = readCandidates(emission.facts);
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate: SupervisorFactCandidate = validateSupervisorFactCandidate(candidates[index]);
        const record = createSupervisorFactRecord({
          candidate,
          sourceFeatureId: feature.featureId,
          rootRequestId: input.observation.rootRequestId,
          sequence: nextFactSequence,
        });
        emittedFacts.push(record);
        if (nextFactSequence === Number.MAX_SAFE_INTEGER) {
          return invalidDispatch();
        }
        nextFactSequence += 1;
      }
    }

    if (hasOwn(emission, 'interventions')) {
      const emittedInterventions = readCandidates(emission.interventions);
      for (let index = 0; index < emittedInterventions.length; index += 1) {
        const proposal = validateSupervisorInterventionProposal(emittedInterventions[index]);
        if (proposal.sourceFeatureId !== feature.featureId) {
          throw new SupervisorContractError(
            'invalid_intervention',
            'Invalid supervisor intervention source.',
          );
        }
        proposals.push(proposal);
      }
    }

    if (hasOwn(emission, 'nextState')) {
      nextStates[feature.featureId] = assertJsonValue(emission.nextState);
    }
  }

  return {
    emittedFacts: Object.freeze(emittedFacts),
    proposals: Object.freeze(proposals),
    nextStates: Object.freeze(nextStates),
    nextFactSequence,
  };
}
