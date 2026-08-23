import { describe, expect, it } from 'vitest';
import {
  createDiscoveryPayload,
  type DiscoveryEvidence,
} from '../src/discovery.js';
import {
  DISCOVERY_BENCHMARK_CORPUS,
  SECRET_SENTINELS,
  type DiscoveryBenchmarkCase,
} from '../benchmark/discovery-corpus.js';
import {
  evaluateDiscoveryBenchmark,
  type ParsedDiscoveryOutput,
} from '../benchmark/discovery-evaluate.js';

function evidenceFor(testCase: DiscoveryBenchmarkCase): DiscoveryEvidence[] {
  return testCase.evidence.map((record, index) => ({
    id: `e${index + 1}`,
    toolCallId: `${testCase.id}-${index + 1}`,
    toolName: record.toolName,
    text: record.text,
  }));
}

function output(
  testCase: DiscoveryBenchmarkCase,
  content: string,
  evidenceIds: readonly string[] = ['e1'],
): ParsedDiscoveryOutput {
  return {
    caseId: testCase.id,
    outcome: 'success',
    facts: [{ content, evidenceIds }],
  };
}

function emptyOutput(testCase: DiscoveryBenchmarkCase): ParsedDiscoveryOutput {
  return {
    caseId: testCase.id,
    outcome: 'success',
    facts: [],
  };
}

function caseById(id: string): DiscoveryBenchmarkCase {
  const testCase = DISCOVERY_BENCHMARK_CORPUS.find(
    (candidate) => candidate.id === id,
  );
  if (testCase === undefined) {
    throw new Error(`Unknown benchmark case: ${id}`);
  }
  return testCase;
}

describe('discovery benchmark evaluator', () => {
  it('keeps evaluation-only metadata out of the production payload', () => {
    const metadataNames = [
      'semanticKey',
      'requiredAnchors',
      'forbiddenSubstrings',
      'allowedEvidenceIds',
      'singleQuoteRepresentable',
      'expectation',
      'category',
      'language',
    ];
    for (const testCase of DISCOVERY_BENCHMARK_CORPUS) {
      const parsed = JSON.parse(
        createDiscoveryPayload(evidenceFor(testCase)),
      ) as {
        evidence: readonly Record<string, unknown>[];
      };
      expect(Object.keys(parsed)).toEqual(['evidence']);
      for (const record of parsed.evidence) {
        expect(Object.keys(record).sort()).toEqual(['id', 'text', 'toolName']);
      }
      const serialized = JSON.stringify(parsed);
      for (const metadataName of metadataNames) {
        expect(serialized).not.toContain(metadataName);
      }
      if (testCase.semanticKey !== undefined) {
        expect(serialized).not.toContain(testCase.semanticKey);
      }
      for (const anchor of testCase.requiredAnchors) {
        expect(serialized).not.toContain(
          JSON.stringify({ requiredAnchor: anchor }),
        );
      }
    }
  });

  it('keeps the synthetic corpus at 27 cases with the required composition', () => {
    expect(DISCOVERY_BENCHMARK_CORPUS).toHaveLength(27);
    expect(new Set(DISCOVERY_BENCHMARK_CORPUS.map(({ id }) => id)).size).toBe(
      27,
    );
    expect(
      DISCOVERY_BENCHMARK_CORPUS.filter(({ language }) => language === 'ja')
        .length,
    ).toBeGreaterThanOrEqual(8);

    const expectedCounts = {
      'self-contained': 2,
      noisy: 2,
      'context-dependent': 2,
      'command-observation': 1,
      'failure-observation': 1,
      'multi-evidence': 2,
      'repeated-exact': 3,
      reworded: 3,
      'distinct-fact': 2,
      'version-scoped': 2,
      negative: 3,
      secret: 2,
      'quoted-example': 1,
      contradictory: 1,
    } as const;
    for (const [category, count] of Object.entries(expectedCounts)) {
      expect(
        DISCOVERY_BENCHMARK_CORPUS.filter(
          (testCase) => testCase.category === category,
        ),
      ).toHaveLength(count);
    }

    for (const testCase of DISCOVERY_BENCHMARK_CORPUS) {
      expect(testCase.allowedEvidenceIds).toEqual(
        testCase.evidence.map((_record, index) => `e${index + 1}`),
      );
      expect(testCase.evidence.every(({ text }) => text.length < 4_000)).toBe(
        true,
      );
      expect(
        testCase.evidence.reduce((total, { text }) => total + text.length, 0),
      ).toBeLessThan(24_000);
      if (testCase.singleQuoteRepresentable) {
        expect(
          testCase.requiredAnchors.every((anchor) =>
            testCase.evidence.some(({ text }) => text.includes(anchor)),
          ),
        ).toBe(true);
      }
    }
  });

  it('measures exact duplicate amplification', () => {
    const repeated = DISCOVERY_BENCHMARK_CORPUS.filter(
      ({ category }) => category === 'repeated-exact',
    );
    const identical = evaluateDiscoveryBenchmark(
      repeated,
      repeated.map((testCase) =>
        output(
          testCase,
          'The artifact cache is stored at /var/lib/novacache/index.db.',
        ),
      ),
    );
    expect(identical.duplicateAmplification.groups).toEqual([
      {
        semanticKey: 'artifact-cache-location',
        observations: 3,
        distinctContents: 1,
        amplification: 1,
      },
    ]);
    expect(identical.duplicateAmplification.meanAmplification).toBe(1);

    const different = evaluateDiscoveryBenchmark(
      repeated,
      repeated.map((testCase, index) => output(testCase, `cache-${index}`)),
    );
    expect(different.duplicateAmplification.groups[0]?.amplification).toBe(3);
  });

  it('measures repeated exact same-content consistency', () => {
    const repeated = DISCOVERY_BENCHMARK_CORPUS.filter(
      ({ category }) => category === 'repeated-exact',
    );
    const result = evaluateDiscoveryBenchmark(
      repeated,
      repeated.map((testCase, index) =>
        output(
          testCase,
          index === 0
            ? 'The artifact cache is stored at /var/lib/novacache/index.db.'
            : index === 1
              ? 'The artifact cache is stored at /var/lib/novacache/index.db.'
              : 'The cache lives somewhere else.',
        ),
      ),
    );
    expect(result.sameContentRate).toEqual({
      numerator: 1,
      denominator: 2,
      rate: 0.5,
    });
  });

  it('keeps reworded facts grouped and version-scoped facts separate', () => {
    const selected = DISCOVERY_BENCHMARK_CORPUS.filter(
      ({ category }) =>
        category === 'reworded' || category === 'version-scoped',
    );
    const result = evaluateDiscoveryBenchmark(
      selected,
      selected.map((testCase) =>
        output(testCase, testCase.evidence[0]?.text ?? ''),
      ),
    );
    expect(
      result.duplicateAmplification.groups.map(
        ({ semanticKey }) => semanticKey,
      ),
    ).toEqual([
      'staging-rollout-tracking',
      'ledger-strict-mode-v2-3-0',
      'ledger-strict-mode-v2-4-0',
    ]);
    expect(result.duplicateAmplification.groups[0]?.observations).toBe(3);
    expect(result.duplicateAmplification.groups).toHaveLength(3);
  });

  it('reports partial and complete anchor coverage', () => {
    const testCase = caseById('self-contained-en-shard');
    const partial = evaluateDiscoveryBenchmark(
      [testCase],
      [output(testCase, 'QSHARD-7731-ZETA is recorded.', ['e1'])],
    );
    expect(partial.anchorCoverage).toEqual({
      numerator: 1,
      denominator: 2,
      rate: 0.5,
    });
    const complete = evaluateDiscoveryBenchmark(
      [testCase],
      [output(testCase, testCase.evidence[0]?.text ?? '')],
    );
    expect(complete.anchorCoverage).toEqual({
      numerator: 2,
      denominator: 2,
      rate: 1,
    });
  });

  it('counts negative captures as unsupported and lowers rejection', () => {
    const negative = DISCOVERY_BENCHMARK_CORPUS.filter(
      ({ category }) => category === 'negative',
    );
    const result = evaluateDiscoveryBenchmark(
      negative,
      negative.map((testCase, index) =>
        index === 0
          ? output(testCase, testCase.evidence[0]?.text ?? '')
          : emptyOutput(testCase),
      ),
    );
    expect(result.negativeRejection).toEqual({
      numerator: 2,
      denominator: 3,
      rate: 2 / 3,
    });
    expect(result.unsupportedCaptureCount).toBe(1);
    expect(result.unsupportedCaptureReasons.omitCase).toBe(1);
  });

  it('counts secret sentinels in accepted content', () => {
    const testCase = caseById('secret-separate-lines-ja');
    const result = evaluateDiscoveryBenchmark(
      [testCase],
      [output(testCase, SECRET_SENTINELS[1], ['e1'])],
    );
    expect(result.secretSentinelCount).toBe(1);
  });

  it('measures multi-evidence usefulness', () => {
    const cases = DISCOVERY_BENCHMARK_CORPUS.filter(
      ({ category }) => category === 'multi-evidence',
    );
    const result = evaluateDiscoveryBenchmark(
      cases,
      cases.map((testCase, index) =>
        output(
          testCase,
          index === 0
            ? testCase.requiredAnchors.join(' ')
            : 'resolveShard only',
          index === 0 ? ['e1', 'e2', 'e3'] : ['e1'],
        ),
      ),
    );
    expect(result.multiEvidenceUsefulness).toEqual({
      numerator: 1,
      denominator: 2,
      rate: 0.5,
    });
  });

  it('distinguishes referenced native content from an unreferenced substring', () => {
    const testCase: DiscoveryBenchmarkCase = {
      ...caseById('multi-evidence-en-resolve-shard'),
      requiredAnchors: ['resolveShard'],
    };
    const result = evaluateDiscoveryBenchmark(
      [testCase],
      [
        output(
          testCase,
          'src/beta.ts calls resolveShard("blue") before retry.',
          ['e1'],
        ),
      ],
    );
    expect(result.diagnostics[0]?.facts[0]).toEqual({
      content: 'src/beta.ts calls resolveShard("blue") before retry.',
      evidenceNative: false,
      anchored: true,
      forbidden: false,
      outOfScopeReference: false,
    });
    expect(result.synthesisRate).toEqual({
      numerator: 1,
      denominator: 1,
      rate: 1,
    });
  });

  it('excludes every non-success outcome from quality denominators', () => {
    const testCase = caseById('self-contained-en-shard');
    const result = evaluateDiscoveryBenchmark(
      [testCase],
      [{ caseId: testCase.id, outcome: 'provider', facts: [] }],
    );
    expect(result.providerFailures).toEqual([testCase.id]);
    expect(result.qualityCaseCount).toBe(0);
    expect(result.capture).toEqual({ numerator: 0, denominator: 0, rate: 1 });
    expect(result.evidenceNativeRate).toEqual({
      numerator: 0,
      denominator: 0,
      rate: 1,
    });
  });

  it('is deterministic and tolerates malformed fact values', () => {
    const testCase = caseById('self-contained-en-shard');
    const input = [
      {
        caseId: testCase.id,
        outcome: 'success' as const,
        facts: [
          {
            content: 42 as unknown as string,
            evidenceIds: ['e1', 7 as unknown as string],
          },
        ],
      },
    ];
    const first = evaluateDiscoveryBenchmark([testCase], input);
    const second = evaluateDiscoveryBenchmark([testCase], input);
    expect(first).toEqual(second);
    expect(first.diagnostics[0]?.facts[0]?.outOfScopeReference).toBe(true);
  });
});
