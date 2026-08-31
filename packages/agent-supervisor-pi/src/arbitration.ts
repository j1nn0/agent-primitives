import type { EffectiveFeatureMode } from './feature.js';
import {
  SUPERVISOR_INTERVENTION_BOUNDARIES,
  type SupervisorInterventionBoundary,
  type SupervisorInterventionIntent,
  type SupervisorInterventionProposal,
  validateSupervisorInterventionProposal,
} from './intervention.js';
import { hasOwn } from './internal.js';

export const SUPERVISOR_INTENT_RANKS: Readonly<Record<SupervisorInterventionIntent, number>> =
  Object.freeze({
    stop: 5,
    handoff: 4,
    'change-strategy': 3,
    verify: 2,
    continue: 1,
  });

export interface SupervisorArbitrationResult {
  readonly boundary: SupervisorInterventionBoundary;
  readonly targetToolCallId: string | null;
  readonly winner?: SupervisorInterventionProposal;
  readonly suppressed: readonly SupervisorInterventionProposal[];
  readonly observedOnly: readonly SupervisorInterventionProposal[];
  readonly ineligible: readonly SupervisorInterventionProposal[];
}

interface ProposalGroup {
  readonly boundary: SupervisorInterventionBoundary;
  readonly targetToolCallId: string | null;
  readonly proposals: SupervisorInterventionProposal[];
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

function compareProposals(
  left: SupervisorInterventionProposal,
  right: SupervisorInterventionProposal,
): number {
  const intentRankDifference = SUPERVISOR_INTENT_RANKS[right.intent] - SUPERVISOR_INTENT_RANKS[left.intent];
  if (intentRankDifference !== 0) {
    return intentRankDifference;
  }
  if (left.priority !== right.priority) {
    return right.priority - left.priority;
  }
  const sourceDifference = compareStrings(left.sourceFeatureId, right.sourceFeatureId);
  if (sourceDifference !== 0) {
    return sourceDifference;
  }
  return compareStrings(left.reasonCode, right.reasonCode);
}

function freezeProposals(
  proposals: readonly SupervisorInterventionProposal[],
): readonly SupervisorInterventionProposal[] {
  return Object.freeze([...proposals].sort(compareProposals));
}

export function arbitrateInterventions(input: {
  readonly proposals: readonly SupervisorInterventionProposal[];
  readonly featureModes: Readonly<Record<string, EffectiveFeatureMode>>;
}): readonly SupervisorArbitrationResult[] {
  const canonicalProposals = input.proposals.map((proposal) =>
    validateSupervisorInterventionProposal(proposal),
  );
  const groupsByBoundary = new Map<
    SupervisorInterventionBoundary,
    Map<string, ProposalGroup>
  >();

  for (const proposal of canonicalProposals) {
    const targetToolCallId =
      proposal.boundary === 'tool-call' ? proposal.targetToolCallId ?? '' : null;
    const targetKey = targetToolCallId ?? '';
    let groupsByTarget = groupsByBoundary.get(proposal.boundary);
    if (groupsByTarget === undefined) {
      groupsByTarget = new Map<string, ProposalGroup>();
      groupsByBoundary.set(proposal.boundary, groupsByTarget);
    }
    let group = groupsByTarget.get(targetKey);
    if (group === undefined) {
      group = { boundary: proposal.boundary, targetToolCallId, proposals: [] };
      groupsByTarget.set(targetKey, group);
    }
    group.proposals.push(proposal);
  }

  const results: SupervisorArbitrationResult[] = [];
  for (const boundary of SUPERVISOR_INTERVENTION_BOUNDARIES) {
    const groupsByTarget = groupsByBoundary.get(boundary);
    if (groupsByTarget === undefined) {
      continue;
    }

    const targetKeys = [...groupsByTarget.keys()].sort(compareStrings);
    for (const targetKey of targetKeys) {
      const group = groupsByTarget.get(targetKey);
      if (group === undefined) {
        continue;
      }

      const eligible: SupervisorInterventionProposal[] = [];
      const observedOnly: SupervisorInterventionProposal[] = [];
      const ineligible: SupervisorInterventionProposal[] = [];
      for (const proposal of group.proposals) {
        const mode = hasOwn(input.featureModes, proposal.sourceFeatureId)
          ? input.featureModes[proposal.sourceFeatureId]
          : undefined;
        if (mode === 'autonomous') {
          eligible.push(proposal);
        } else if (mode === 'observe') {
          observedOnly.push(proposal);
        } else {
          ineligible.push(proposal);
        }
      }

      const rankedEligible = freezeProposals(eligible);
      const suppressed = Object.freeze(rankedEligible.slice(1));
      const observed = freezeProposals(observedOnly);
      const unavailable = freezeProposals(ineligible);
      const winner = rankedEligible[0];
      const result = {
        boundary: group.boundary,
        targetToolCallId: group.targetToolCallId,
        suppressed,
        observedOnly: observed,
        ineligible: unavailable,
      };
      if (winner !== undefined) {
        results.push(Object.freeze({ ...result, winner }));
      } else {
        results.push(Object.freeze(result));
      }
    }
  }

  return Object.freeze(results);
}

