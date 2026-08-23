import {
  VERIFICATION_BENCHMARK_CORPUS,
  type VerificationBenchmarkCase,
  type VerificationCategory,
} from './verification-corpus.js';
import {
  assessBacktickTolerantLiteralStatus,
  assessItemEvidence,
  assessLiteralStatus,
  policyA,
  policyB,
  policyC1,
  policyC2,
  policyD,
  type EvidenceOutcome,
  type LiteralStatus,
  type PolicyDecision,
  type PolicyStatus,
  type VerificationPolicyName,
} from './verification-policies.js';

export interface RateSummary {
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number;
}

export interface EvidenceResolutionSummary {
  readonly resolved: RateSummary;
  readonly counts: Readonly<Record<EvidenceOutcome, number>>;
}

export interface CategoryPolicyBreakdown {
  readonly unsafeNonRecovery: number;
  readonly unnecessaryRecovery: number;
}

export interface VerificationCaseDiagnostic {
  readonly caseId: string;
  readonly category: VerificationCategory;
  readonly literalStatus: LiteralStatus;
  readonly evidenceOutcome: EvidenceOutcome;
  readonly decisions: Readonly<
    Record<VerificationPolicyName, PolicyDecision>
  >;
}

export interface VerificationPolicyEvaluation {
  readonly literalPreserved: number;
  readonly supported: number;
  readonly lost: number;
  readonly unknown: number;
  readonly recoveryCount: number;
  readonly unsafeNonRecovery: number;
  readonly unnecessaryRecovery: number;
  readonly evidenceResolution: EvidenceResolutionSummary;
  readonly unsafeNonRecoveryByCategory: Readonly<
    Record<VerificationCategory, number>
  >;
  readonly unnecessaryRecoveryByCategory: Readonly<
    Record<VerificationCategory, number>
  >;
  readonly categoryBreakdown: Readonly<
    Record<VerificationCategory, CategoryPolicyBreakdown>
  >;
}

export interface VerificationEvaluation {
  readonly totalCases: number;
  readonly evidenceResolution: EvidenceResolutionSummary;
  readonly policies: Readonly<
    Record<VerificationPolicyName, VerificationPolicyEvaluation>
  >;
  readonly diagnostics: readonly VerificationCaseDiagnostic[];
}

export const VERIFICATION_CATEGORIES: readonly VerificationCategory[] = [
  'literal-preserved',
  'formatting-only',
  'punctuation-rewrite',
  'paraphrase',
  'claim-omitted',
  'claim-omitted-evidence-present',
  'evidence-missing',
  'hash-mismatch',
  'span-invalid',
  'legacy-no-span',
  'multi-ref-all-resolve',
  'multi-ref-one-missing',
  'contradictory-later-evidence',
];

const POLICY_NAMES: readonly VerificationPolicyName[] = [
  'A',
  'B',
  'C1',
  'C2',
  'D',
];

const POLICY_FUNCTIONS: Readonly<
  Record<
    VerificationPolicyName,
    (
      literalStatus: LiteralStatus,
      evidenceOutcome: EvidenceOutcome,
    ) => PolicyDecision
  >
> = {
  A: policyA,
  B: policyB,
  C1: policyC1,
  C2: policyC2,
  D: policyD,
};

interface MutablePolicyEvaluation {
  literalPreserved: number;
  supported: number;
  lost: number;
  unknown: number;
  recoveryCount: number;
  unsafeNonRecovery: number;
  unnecessaryRecovery: number;
  unsafeNonRecoveryByCategory: Record<VerificationCategory, number>;
  unnecessaryRecoveryByCategory: Record<VerificationCategory, number>;
}

function rate(numerator: number, denominator: number): RateSummary {
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? 1 : numerator / denominator,
  };
}

function emptyCategoryCounts(): Record<VerificationCategory, number> {
  const counts = {} as Record<VerificationCategory, number>;
  for (const category of VERIFICATION_CATEGORIES) {
    counts[category] = 0;
  }
  return counts;
}

function emptyPolicyEvaluation(): MutablePolicyEvaluation {
  return {
    literalPreserved: 0,
    supported: 0,
    lost: 0,
    unknown: 0,
    recoveryCount: 0,
    unsafeNonRecovery: 0,
    unnecessaryRecovery: 0,
    unsafeNonRecoveryByCategory: emptyCategoryCounts(),
    unnecessaryRecoveryByCategory: emptyCategoryCounts(),
  };
}

function evidenceResolution(
  counts: Readonly<Record<EvidenceOutcome, number>>,
  totalCases: number,
): EvidenceResolutionSummary {
  return {
    resolved: rate(counts.resolved, totalCases),
    counts,
  };
}

function categoryBreakdown(
  unsafeNonRecoveryByCategory: Readonly<
    Record<VerificationCategory, number>
  >,
  unnecessaryRecoveryByCategory: Readonly<
    Record<VerificationCategory, number>
  >,
): Readonly<Record<VerificationCategory, CategoryPolicyBreakdown>> {
  const breakdown = {} as Record<
    VerificationCategory,
    CategoryPolicyBreakdown
  >;
  for (const category of VERIFICATION_CATEGORIES) {
    breakdown[category] = {
      unsafeNonRecovery: unsafeNonRecoveryByCategory[category],
      unnecessaryRecovery: unnecessaryRecoveryByCategory[category],
    };
  }
  return breakdown;
}

function finalizePolicyEvaluation(
  accumulator: MutablePolicyEvaluation,
  evidenceSummary: EvidenceResolutionSummary,
): VerificationPolicyEvaluation {
  return {
    literalPreserved: accumulator.literalPreserved,
    supported: accumulator.supported,
    lost: accumulator.lost,
    unknown: accumulator.unknown,
    recoveryCount: accumulator.recoveryCount,
    unsafeNonRecovery: accumulator.unsafeNonRecovery,
    unnecessaryRecovery: accumulator.unnecessaryRecovery,
    evidenceResolution: evidenceSummary,
    unsafeNonRecoveryByCategory: accumulator.unsafeNonRecoveryByCategory,
    unnecessaryRecoveryByCategory: accumulator.unnecessaryRecoveryByCategory,
    categoryBreakdown: categoryBreakdown(
      accumulator.unsafeNonRecoveryByCategory,
      accumulator.unnecessaryRecoveryByCategory,
    ),
  };
}

function countStatus(
  accumulator: MutablePolicyEvaluation,
  status: PolicyStatus,
): void {
  switch (status) {
    case 'preserved':
      accumulator.literalPreserved += 1;
      break;
    case 'supported':
      accumulator.supported += 1;
      break;
    case 'lost':
      accumulator.lost += 1;
      break;
    case 'unknown':
      accumulator.unknown += 1;
      break;
  }
}

export function evaluateVerificationBenchmark(
  cases: readonly VerificationBenchmarkCase[] = VERIFICATION_BENCHMARK_CORPUS,
): VerificationEvaluation {
  const accumulators: Record<
    VerificationPolicyName,
    MutablePolicyEvaluation
  > = {
    A: emptyPolicyEvaluation(),
    B: emptyPolicyEvaluation(),
    C1: emptyPolicyEvaluation(),
    C2: emptyPolicyEvaluation(),
    D: emptyPolicyEvaluation(),
  };
  const evidenceCounts: Record<EvidenceOutcome, number> = {
    resolved: 0,
    unavailable: 0,
    invalid: 0,
    'legacy-unresolvable': 0,
  };
  const diagnostics: VerificationCaseDiagnostic[] = [];

  for (const testCase of cases) {
    const literalStatus = assessLiteralStatus(
      testCase.itemContent,
      testCase.contextFixture,
    );
    const backtickTolerantLiteralStatus = assessBacktickTolerantLiteralStatus(
      testCase.itemContent,
      testCase.contextFixture,
    );
    const evidenceOutcome = assessItemEvidence(
      testCase.provenance,
      testCase.branchToolResults,
    );
    evidenceCounts[evidenceOutcome] += 1;

    const decisions = {} as Record<
      VerificationPolicyName,
      PolicyDecision
    >;
    for (const policyName of POLICY_NAMES) {
      const policyLiteralStatus =
        policyName === 'D' ? backtickTolerantLiteralStatus : literalStatus;
      const decision = POLICY_FUNCTIONS[policyName](
        policyLiteralStatus,
        evidenceOutcome,
      );
      decisions[policyName] = decision;

      const accumulator = accumulators[policyName];
      countStatus(accumulator, decision.status);
      if (decision.recover) {
        accumulator.recoveryCount += 1;
      }
      if (!testCase.claimActuallyIncludedByFixture && !decision.recover) {
        accumulator.unsafeNonRecovery += 1;
        accumulator.unsafeNonRecoveryByCategory[testCase.category] += 1;
      }
      if (testCase.claimActuallyIncludedByFixture && decision.recover) {
        accumulator.unnecessaryRecovery += 1;
        accumulator.unnecessaryRecoveryByCategory[testCase.category] += 1;
      }
    }

    diagnostics.push({
      caseId: testCase.id,
      category: testCase.category,
      literalStatus,
      evidenceOutcome,
      decisions,
    });
  }

  const evidenceSummary = evidenceResolution(
    evidenceCounts,
    cases.length,
  );
  const policies = {} as Record<
    VerificationPolicyName,
    VerificationPolicyEvaluation
  >;
  for (const policyName of POLICY_NAMES) {
    policies[policyName] = finalizePolicyEvaluation(
      accumulators[policyName],
      evidenceSummary,
    );
  }

  return {
    totalCases: cases.length,
    evidenceResolution: evidenceSummary,
    policies,
    diagnostics,
  };
}

export const evaluateVerification = evaluateVerificationBenchmark;
