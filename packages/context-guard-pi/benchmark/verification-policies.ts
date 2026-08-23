import { createLiteralVerifier } from '@j1nn0/agent-context-guard';
import {
  resolveDiscoveryQuote,
  type DiscoveryToolResult,
} from '../src/provenance.js';
import type { DiscoveryProvenance } from '../src/types.js';

export type EvidenceOutcome =
  | 'resolved'
  | 'unavailable'
  | 'invalid'
  | 'legacy-unresolvable';

/** The literal signal returned by the real core verifier. */
export type LiteralStatus = 'preserved' | 'lost';

export type PolicyStatus = 'preserved' | 'supported' | 'lost' | 'unknown';

export interface PolicyDecision {
  readonly status: PolicyStatus;
  readonly recover: boolean;
}

export type VerificationPolicyName = 'A' | 'B' | 'C1' | 'C2' | 'D';

export type VerificationPolicy = (
  literalStatus: LiteralStatus,
  evidenceOutcome: EvidenceOutcome,
) => PolicyDecision;

const EVIDENCE_OUTCOMES_BY_SEVERITY: readonly EvidenceOutcome[] = [
  'invalid',
  'legacy-unresolvable',
  'unavailable',
  'resolved',
];

export function assessEvidenceReference(
  provenance: DiscoveryProvenance,
  branchToolResults: readonly DiscoveryToolResult[],
): EvidenceOutcome {
  if (provenance.span === undefined) {
    return 'legacy-unresolvable';
  }

  const resultExists = branchToolResults.some(
    ({ toolCallId }) => toolCallId === provenance.toolCallId,
  );
  if (!resultExists) {
    return 'unavailable';
  }

  return resolveDiscoveryQuote(provenance, branchToolResults) === undefined
    ? 'invalid'
    : 'resolved';
}

export function assessItemEvidence(
  provenance: readonly DiscoveryProvenance[],
  branchToolResults: readonly DiscoveryToolResult[],
): EvidenceOutcome {
  if (provenance.length === 0) {
    return 'legacy-unresolvable';
  }

  let itemOutcome: EvidenceOutcome = 'resolved';
  for (const reference of provenance) {
    const referenceOutcome = assessEvidenceReference(reference, branchToolResults);
    if (referenceOutcome === 'invalid') {
      return 'invalid';
    }
    if (
      EVIDENCE_OUTCOMES_BY_SEVERITY.indexOf(referenceOutcome) <
      EVIDENCE_OUTCOMES_BY_SEVERITY.indexOf(itemOutcome)
    ) {
      itemOutcome = referenceOutcome;
    }
  }
  return itemOutcome;
}

export function assessEvidence(
  provenance: DiscoveryProvenance,
  branchToolResults: readonly DiscoveryToolResult[],
): EvidenceOutcome;
export function assessEvidence(
  provenance: readonly DiscoveryProvenance[],
  branchToolResults: readonly DiscoveryToolResult[],
): EvidenceOutcome;
export function assessEvidence(
  provenance: DiscoveryProvenance | readonly DiscoveryProvenance[],
  branchToolResults: readonly DiscoveryToolResult[],
): EvidenceOutcome {
  if (Array.isArray(provenance)) {
    return assessItemEvidence(provenance, branchToolResults);
  }
  return assessEvidenceReference(
    provenance as DiscoveryProvenance,
    branchToolResults,
  );
}

function literalStatusForStrings(
  itemContent: string,
  contextFixture: string,
): LiteralStatus {
  const findings = createLiteralVerifier().verify({
    items: [
      {
        id: 'verification-benchmark-item',
        kind: 'fact',
        content: itemContent,
        critical: false,
      },
    ],
    context: contextFixture,
  });
  if (findings instanceof Promise) {
    throw new Error('The literal benchmark verifier must be synchronous.');
  }
  return findings[0]?.status === 'preserved' ? 'preserved' : 'lost';
}

export function assessLiteralStatus(
  itemContent: string,
  contextFixture: string,
): LiteralStatus {
  return literalStatusForStrings(itemContent, contextFixture);
}


export function assessBacktickTolerantLiteralStatus(
  itemContent: string,
  contextFixture: string,
): LiteralStatus {
  return literalStatusForStrings(
    itemContent.replaceAll('\u0060', ''),
    contextFixture.replaceAll('\u0060', ''),
  );
}


export function policyA(
  literalStatus: LiteralStatus,
  evidenceOutcome: EvidenceOutcome,
): PolicyDecision {
  void evidenceOutcome;
  return literalStatus === 'preserved'
    ? { status: 'preserved', recover: false }
    : { status: 'lost', recover: true };
}

export function policyB(
  literalStatus: LiteralStatus,
  evidenceOutcome: EvidenceOutcome,
): PolicyDecision {
  if (literalStatus === 'preserved' || evidenceOutcome === 'resolved') {
    return { status: 'preserved', recover: false };
  }
  return { status: 'lost', recover: true };
}

export function policyC1(
  literalStatus: LiteralStatus,
  evidenceOutcome: EvidenceOutcome,
): PolicyDecision {
  if (literalStatus === 'preserved') {
    return { status: 'preserved', recover: false };
  }
  if (evidenceOutcome === 'resolved') {
    return { status: 'supported', recover: false };
  }
  return { status: 'unknown', recover: true };
}

export function policyC2(
  literalStatus: LiteralStatus,
  evidenceOutcome: EvidenceOutcome,
): PolicyDecision {
  if (literalStatus === 'preserved') {
    return { status: 'preserved', recover: false };
  }
  if (evidenceOutcome === 'resolved') {
    return { status: 'supported', recover: true };
  }
  return { status: 'unknown', recover: true };
}

/**
 * Policy D receives the backtick-tolerant literal signal, not the ordinary
 * literal signal. It never uses evidence to infer that context contains a
 * claim.
 */
export function policyD(
  literalStatus: LiteralStatus,
  evidenceOutcome: EvidenceOutcome,
): PolicyDecision {
  void evidenceOutcome;
  return literalStatus === 'preserved'
    ? { status: 'preserved', recover: false }
    : { status: 'lost', recover: true };
}

export const VERIFICATION_POLICIES: Readonly<
  Record<VerificationPolicyName, VerificationPolicy>
> = {
  A: policyA,
  B: policyB,
  C1: policyC1,
  C2: policyC2,
  D: policyD,
};
