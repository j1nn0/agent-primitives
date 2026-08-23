import { describe, expect, it } from 'vitest';
import { digest12 } from '../src/identifiers.js';
import {
  concatenateEvidenceText,
  resolveDiscoveryQuote,
} from '../src/provenance.js';
import type { DiscoveryProvenance } from '../src/types.js';
import {
  VERIFICATION_BENCHMARK_CORPUS,
  type VerificationBenchmarkCase,
  type VerificationCategory,
} from '../benchmark/verification-corpus.js';
import {
  evaluateVerificationBenchmark,
} from '../benchmark/verification-evaluate.js';
import {
  assessBacktickTolerantLiteralStatus,
  assessEvidence,
  assessLiteralStatus,
  assessEvidenceReference,
  assessItemEvidence,
  policyA,
  policyB,
  policyC1,
  policyC2,
  policyD,
} from '../benchmark/verification-policies.js';

function caseById(id: string): VerificationBenchmarkCase {
  const testCase = VERIFICATION_BENCHMARK_CORPUS.find(
    (candidate) => candidate.id === id,
  );
  if (testCase === undefined) {
    throw new Error(`Unknown verification benchmark case: ${id}`);
  }
  return testCase;
}

function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) {
    throw new Error('Expected a non-empty synthetic collection.');
  }
  return value;
}

function provenanceFor(testCase: VerificationBenchmarkCase): DiscoveryProvenance {
  return first(testCase.provenance);
}

describe('verification policy benchmark corpus', () => {
  it('has the required synthetic composition and internally consistent hashes', () => {
    expect(VERIFICATION_BENCHMARK_CORPUS.length).toBeGreaterThanOrEqual(26);
    expect(new Set(VERIFICATION_BENCHMARK_CORPUS.map(({ id }) => id)).size).toBe(
      VERIFICATION_BENCHMARK_CORPUS.length,
    );
    expect(
      VERIFICATION_BENCHMARK_CORPUS.filter(({ language }) => language === 'ja'),
    ).toHaveLength(12);

    const expectedCounts: Record<VerificationCategory, number> = {
      'literal-preserved': 3,
      'formatting-only': 4,
      'punctuation-rewrite': 2,
      paraphrase: 3,
      'claim-omitted': 3,
      'claim-omitted-evidence-present': 3,
      'evidence-missing': 2,
      'hash-mismatch': 2,
      'span-invalid': 2,
      'legacy-no-span': 2,
      'multi-ref-all-resolve': 2,
      'multi-ref-one-missing': 1,
      'contradictory-later-evidence': 1,
    };
    for (const [category, count] of Object.entries(expectedCounts)) {
      expect(
        VERIFICATION_BENCHMARK_CORPUS.filter(
          (testCase) => testCase.category === category,
        ),
      ).toHaveLength(count);
    }

    const trueCategories: readonly VerificationCategory[] = [
      'literal-preserved',
      'formatting-only',
      'punctuation-rewrite',
      'paraphrase',
    ];
    for (const testCase of VERIFICATION_BENCHMARK_CORPUS) {
      if (trueCategories.includes(testCase.category)) {
        expect(testCase.claimActuallyIncludedByFixture).toBe(true);
      }
    }
    expect(
      VERIFICATION_BENCHMARK_CORPUS.filter(
        ({ category }) => category === 'multi-ref-all-resolve',
      ).map(({ claimActuallyIncludedByFixture }) => claimActuallyIncludedByFixture),
    ).toEqual([true, false]);

    for (const testCase of VERIFICATION_BENCHMARK_CORPUS) {
      if (testCase.category === 'hash-mismatch') {
        continue;
      }
      for (const provenance of testCase.provenance) {
        if (provenance.span === undefined) {
          continue;
        }
        const result = testCase.branchToolResults.find(
          ({ toolCallId }) => toolCallId === provenance.toolCallId,
        );
        if (result === undefined) {
          continue;
        }
        const evidenceText = concatenateEvidenceText(result.content);
        expect(provenance.quoteHash).toBe(
          digest12(
            evidenceText.slice(
              provenance.span.startOffset,
              provenance.span.endOffset,
            ),
          ),
        );
      }
    }
  });

  it('classifies the five evidence outcomes with production resolution', () => {
    const resolved = caseById('literal-preserved-audit-ja');
    expect(
      assessEvidenceReference(
        provenanceFor(resolved),
        resolved.branchToolResults,
      ),
    ).toBe('resolved');

    const unavailable = caseById('evidence-missing-token-en');
    expect(
      assessEvidenceReference(
        provenanceFor(unavailable),
        unavailable.branchToolResults,
      ),
    ).toBe('unavailable');

    const mismatch = caseById('hash-mismatch-service-en');
    expect(
      assessEvidenceReference(
        provenanceFor(mismatch),
        mismatch.branchToolResults,
      ),
    ).toBe('invalid');

    const invalidSpan = caseById('span-invalid-token-en');
    expect(
      assessEvidenceReference(
        provenanceFor(invalidSpan),
        invalidSpan.branchToolResults,
      ),
    ).toBe('invalid');

    const legacy = caseById('legacy-no-span-endpoint-en');
    expect(
      assessEvidenceReference(
        provenanceFor(legacy),
        legacy.branchToolResults,
      ),
    ).toBe('legacy-unresolvable');
  });

  it('uses worst-first precedence for multiple evidence references', () => {
    const allResolved = caseById('multi-ref-all-resolve-active-en');
    expect(
      assessItemEvidence(
        allResolved.provenance,
        allResolved.branchToolResults,
      ),
    ).toBe('resolved');
    expect(
      assessEvidence(allResolved.provenance, allResolved.branchToolResults),
    ).toBe('resolved');

    const oneMissing = caseById('multi-ref-one-missing-rollout-en');
    expect(
      assessItemEvidence(oneMissing.provenance, oneMissing.branchToolResults),
    ).toBe('unavailable');

    const mismatch = caseById('hash-mismatch-service-en');
    const invalid = provenanceFor(mismatch);
    const missing = first(oneMissing.provenance.slice(1));
    expect(
      assessItemEvidence([missing, invalid], mismatch.branchToolResults),
    ).toBe('invalid');
  });

  it('resolves a quote containing a surrogate pair and rejects an off-by-one span', () => {
    const testCase = caseById('literal-preserved-audit-ja');
    const provenance = provenanceFor(testCase);
    const span = provenance.span;
    if (span === undefined) {
      throw new Error('The surrogate-pair fixture must have a span.');
    }
    expect(resolveDiscoveryQuote(provenance, testCase.branchToolResults)).toBe(
      testCase.itemContent,
    );

    const offByOne: DiscoveryProvenance = {
      ...provenance,
      span: {
        startOffset: span.startOffset + 1,
        endOffset: span.endOffset,
      },
    };
    expect(resolveDiscoveryQuote(offByOne, testCase.branchToolResults)).toBe(
      undefined,
    );
  });

  it('makes the five policy decisions distinct on representative cases', () => {
    const literalCase = caseById('literal-preserved-ledger-en');
    const literalStatus = assessLiteralStatus(
      literalCase.itemContent,
      literalCase.contextFixture,
    );
    const literalEvidence = assessItemEvidence(
      literalCase.provenance,
      literalCase.branchToolResults,
    );
    expect(policyA(literalStatus, literalEvidence)).toEqual({
      status: 'preserved',
      recover: false,
    });
    expect(policyB(literalStatus, literalEvidence)).toEqual({
      status: 'preserved',
      recover: false,
    });
    expect(policyC1(literalStatus, literalEvidence)).toEqual({
      status: 'preserved',
      recover: false,
    });
    expect(policyC2(literalStatus, literalEvidence)).toEqual({
      status: 'preserved',
      recover: false,
    });
    expect(
      policyD(
        assessBacktickTolerantLiteralStatus(
          literalCase.itemContent,
          literalCase.contextFixture,
        ),
        literalEvidence,
      ),
    ).toEqual({ status: 'preserved', recover: false });

    const formattingCase = caseById('formatting-only-shard-en');
    const formattingStatus = assessLiteralStatus(
      formattingCase.itemContent,
      formattingCase.contextFixture,
    );
    const formattingEvidence = assessItemEvidence(
      formattingCase.provenance,
      formattingCase.branchToolResults,
    );
    expect(policyA(formattingStatus, formattingEvidence)).toEqual({
      status: 'lost',
      recover: true,
    });
    expect(policyB(formattingStatus, formattingEvidence)).toEqual({
      status: 'preserved',
      recover: false,
    });
    expect(policyC1(formattingStatus, formattingEvidence)).toEqual({
      status: 'supported',
      recover: false,
    });
    expect(policyC2(formattingStatus, formattingEvidence)).toEqual({
      status: 'supported',
      recover: true,
    });
    expect(
      policyD(
        assessBacktickTolerantLiteralStatus(
          formattingCase.itemContent,
          formattingCase.contextFixture,
        ),
        formattingEvidence,
      ),
    ).toEqual({ status: 'preserved', recover: false });

    const omittedCase = caseById('claim-omitted-evidence-scheduler-en');
    const omittedStatus = assessLiteralStatus(
      omittedCase.itemContent,
      omittedCase.contextFixture,
    );
    const omittedEvidence = assessItemEvidence(
      omittedCase.provenance,
      omittedCase.branchToolResults,
    );
    expect(policyA(omittedStatus, omittedEvidence)).toEqual({
      status: 'lost',
      recover: true,
    });
    expect(policyB(omittedStatus, omittedEvidence)).toEqual({
      status: 'preserved',
      recover: false,
    });
    expect(policyC1(omittedStatus, omittedEvidence)).toEqual({
      status: 'supported',
      recover: false,
    });
    expect(policyC2(omittedStatus, omittedEvidence)).toEqual({
      status: 'supported',
      recover: true,
    });
    expect(
      policyD(
        assessBacktickTolerantLiteralStatus(
          omittedCase.itemContent,
          omittedCase.contextFixture,
        ),
        omittedEvidence,
      ),
    ).toEqual({ status: 'lost', recover: true });
  });

  it('keeps the claim-omitted evidence-present cases safe from B and C1', () => {
    const omittedCases = VERIFICATION_BENCHMARK_CORPUS.filter(
      ({ category }) => category === 'claim-omitted-evidence-present',
    );
    expect(omittedCases).toHaveLength(3);
    for (const testCase of omittedCases) {
      const literalStatus = assessLiteralStatus(
        testCase.itemContent,
        testCase.contextFixture,
      );
      const tolerantStatus = assessBacktickTolerantLiteralStatus(
        testCase.itemContent,
        testCase.contextFixture,
      );
      const evidenceOutcome = assessItemEvidence(
        testCase.provenance,
        testCase.branchToolResults,
      );
      expect(evidenceOutcome).toBe('resolved');
      expect(policyB(literalStatus, evidenceOutcome).recover).toBe(false);
      expect(policyC1(literalStatus, evidenceOutcome).recover).toBe(false);
      expect(policyA(literalStatus, evidenceOutcome).recover).toBe(true);
      expect(policyC2(literalStatus, evidenceOutcome).recover).toBe(true);
      expect(policyD(tolerantStatus, evidenceOutcome).recover).toBe(true);
    }
  });

  it('does not need evaluation-only truth to assess evidence, literals, or policies', () => {
    const testCase = caseById('literal-preserved-ledger-en');
    const evidenceOutcome = assessEvidenceReference(
      provenanceFor(testCase),
      testCase.branchToolResults,
    );
    expect(evidenceOutcome).toBe('resolved');
    expect(
      assessLiteralStatus(testCase.itemContent, testCase.contextFixture),
    ).toBe('preserved');
    expect(policyA('lost', 'resolved')).toEqual({
      status: 'lost',
      recover: true,
    });
    expect(policyB('lost', 'resolved')).toEqual({
      status: 'preserved',
      recover: false,
    });
    expect(policyC1('lost', 'resolved')).toEqual({
      status: 'supported',
      recover: false,
    });
    expect(policyC2('lost', 'resolved')).toEqual({
      status: 'supported',
      recover: true,
    });
    expect(policyD('lost', 'resolved')).toEqual({
      status: 'lost',
      recover: true,
    });
  });

  it('evaluates deterministically and reports every requested metric', () => {
    const firstEvaluation = evaluateVerificationBenchmark(
      VERIFICATION_BENCHMARK_CORPUS,
    );
    const secondEvaluation = evaluateVerificationBenchmark(
      VERIFICATION_BENCHMARK_CORPUS,
    );
    expect(firstEvaluation).toEqual(secondEvaluation);
    expect(firstEvaluation.totalCases).toBe(30);
    expect(firstEvaluation.diagnostics).toHaveLength(30);
    expect(firstEvaluation.evidenceResolution).toEqual({
      resolved: { numerator: 21, denominator: 30, rate: 0.7 },
      counts: {
        resolved: 21,
        unavailable: 3,
        invalid: 4,
        'legacy-unresolvable': 2,
      },
    });

    for (const policyName of ['A', 'B', 'C1', 'C2', 'D'] as const) {
      const evaluation = firstEvaluation.policies[policyName];
      expect(evaluation).toEqual(
        expect.objectContaining({
          literalPreserved: expect.any(Number),
          supported: expect.any(Number),
          lost: expect.any(Number),
          unknown: expect.any(Number),
          recoveryCount: expect.any(Number),
          unsafeNonRecovery: expect.any(Number),
          unnecessaryRecovery: expect.any(Number),
          evidenceResolution: firstEvaluation.evidenceResolution,
          unsafeNonRecoveryByCategory: expect.any(Object),
          unnecessaryRecoveryByCategory: expect.any(Object),
          categoryBreakdown: expect.any(Object),
        }),
      );
    }
  });
});
