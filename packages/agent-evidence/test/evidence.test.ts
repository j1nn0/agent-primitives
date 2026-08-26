import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as evidenceApi from '../src/index.js';
import { EvidenceError, judgeEvidence } from '../src/index.js';
import type {
  EvidenceErrorCode,
  EvidenceVerdict,
} from '../src/index.js';

function expectEvidenceError(
  action: () => unknown,
  code: EvidenceErrorCode = 'invalid_input',
): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(EvidenceError);
  expect((thrown as EvidenceError).name).toBe('EvidenceError');
  expect((thrown as EvidenceError).code).toBe(code);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

describe('agent evidence public boundary', () => {
  it('exports only the public runtime values and has no dependencies', () => {
    expect(Object.keys(evidenceApi).sort()).toEqual([
      'EvidenceError',
      'judgeEvidence',
    ]);

    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      readonly dependencies?: Record<string, string>;
      readonly peerDependencies?: Record<string, string>;
    };
    expect(packageJson.dependencies).toBeUndefined();
    expect(packageJson.peerDependencies).toBeUndefined();
  });

  it('returns an empty verdict for empty claims and evidence', () => {
    expect(judgeEvidence({ claims: [], evidence: [] })).toEqual({ claims: [] });
  });

  it('requires every claim to have a non-empty requires array', () => {
    expectEvidenceError(() =>
      judgeEvidence({
        claims: [{ id: 'claim' }],
        evidence: [],
      }),
    );
    expectEvidenceError(() =>
      judgeEvidence({
        claims: [{ id: 'claim', requires: [] }],
        evidence: [],
      }),
    );
  });

  it('supports a claim when its one confirmed requirement matches', () => {
    expect(
      judgeEvidence({
        claims: [{ id: 'claim', requires: [{ evidenceId: 'proof' }] }],
        evidence: [{ id: 'proof', outcome: 'confirmed' }],
      }),
    ).toEqual({ claims: [{ claimId: 'claim', outcome: 'supported' }] });
  });

  it('requires all confirmed requirements to support a claim', () => {
    expect(
      judgeEvidence({
        claims: [
          {
            id: 'claim',
            requires: [
              { evidenceId: 'first-proof' },
              { evidenceId: 'second-proof' },
            ],
          },
        ],
        evidence: [
          { id: 'first-proof', outcome: 'confirmed' },
          { id: 'second-proof', outcome: 'confirmed' },
        ],
      }),
    ).toEqual({ claims: [{ claimId: 'claim', outcome: 'supported' }] });
  });

  it('reports contradicted and unconfirmed evidence with their evidence ids', () => {
    expect(
      judgeEvidence({
        claims: [
          { id: 'refuted-claim', requires: [{ evidenceId: 'refuted-proof' }] },
          { id: 'unknown-claim', requires: [{ evidenceId: 'unknown-proof' }] },
        ],
        evidence: [
          { id: 'refuted-proof', outcome: 'refuted' },
          { id: 'unknown-proof', outcome: 'unknown' },
        ],
      }),
    ).toEqual({
      claims: [
        {
          claimId: 'refuted-claim',
          outcome: 'contradicted',
          evidenceId: 'refuted-proof',
        },
        {
          claimId: 'unknown-claim',
          outcome: 'unsupported',
          reason: 'unconfirmed_evidence',
          evidenceId: 'unknown-proof',
        },
      ],
    });
  });

  it('reports dangling evidence links as missing evidence', () => {
    expect(
      judgeEvidence({
        claims: [{ id: 'claim', requires: [{ evidenceId: 'missing-proof' }] }],
        evidence: [],
      }),
    ).toEqual({
      claims: [
        {
          claimId: 'claim',
          outcome: 'unsupported',
          reason: 'missing_evidence',
          evidenceId: 'missing-proof',
        },
      ],
    });
  });

  it('matches subjects exactly and leaves absent requirement subjects unconstrained', () => {
    expect(
      judgeEvidence({
        claims: [
          {
            id: 'matching-subject',
            requires: [{ evidenceId: 'matching-proof', subject: 'revision-a' }],
          },
          {
            id: 'mismatched-subject',
            requires: [{ evidenceId: 'different-proof', subject: 'revision-a' }],
          },
          {
            id: 'no-requirement-subject',
            requires: [{ evidenceId: 'subjectful-proof' }],
          },
        ],
        evidence: [
          {
            id: 'matching-proof',
            outcome: 'confirmed',
            subject: 'revision-a',
          },
          {
            id: 'different-proof',
            outcome: 'confirmed',
            subject: 'revision-b',
          },
          {
            id: 'subjectful-proof',
            outcome: 'confirmed',
            subject: 'revision-c',
          },
        ],
      }),
    ).toEqual({
      claims: [
        { claimId: 'matching-subject', outcome: 'supported' },
        {
          claimId: 'mismatched-subject',
          outcome: 'unsupported',
          reason: 'subject_mismatch',
          evidenceId: 'different-proof',
        },
        { claimId: 'no-requirement-subject', outcome: 'supported' },
      ],
    });

    expect(
      judgeEvidence({
        claims: [
          {
            id: 'no-record-subject',
            requires: [{ evidenceId: 'proof-without-subject', subject: 'revision-a' }],
          },
        ],
        evidence: [{ id: 'proof-without-subject', outcome: 'confirmed' }],
      }),
    ).toEqual({
      claims: [
        {
          claimId: 'no-record-subject',
          outcome: 'unsupported',
          reason: 'subject_mismatch',
          evidenceId: 'proof-without-subject',
        },
      ],
    });
  });

  it('does not let stale refuted proof contradict a subject-specific claim', () => {
    expect(
      judgeEvidence({
        claims: [
          {
            id: 'current-claim',
            requires: [{ evidenceId: 'old-proof', subject: 'current-revision' }],
          },
        ],
        evidence: [
          { id: 'old-proof', outcome: 'refuted', subject: 'old-revision' },
        ],
      }),
    ).toEqual({
      claims: [
        {
          claimId: 'current-claim',
          outcome: 'unsupported',
          reason: 'subject_mismatch',
          evidenceId: 'old-proof',
        },
      ],
    });
  });

  it('applies classification precedence over requirement declaration order', () => {
    const cases = [
      {
        requirements: [
          { evidenceId: 'mismatched-proof', subject: 'current' },
          { evidenceId: 'refuted-proof' },
        ],
        evidence: [
          { id: 'mismatched-proof', outcome: 'refuted', subject: 'old' },
          { id: 'refuted-proof', outcome: 'refuted' },
        ],
        expected: {
          outcome: 'contradicted' as const,
          evidenceId: 'refuted-proof',
        },
      },
      {
        requirements: [
          { evidenceId: 'missing-proof' },
          { evidenceId: 'refuted-proof' },
        ],
        evidence: [{ id: 'refuted-proof', outcome: 'refuted' }],
        expected: {
          outcome: 'contradicted' as const,
          evidenceId: 'refuted-proof',
        },
      },
      {
        requirements: [
          { evidenceId: 'missing-proof' },
          { evidenceId: 'mismatched-proof', subject: 'current' },
        ],
        evidence: [{ id: 'mismatched-proof', outcome: 'confirmed', subject: 'old' }],
        expected: {
          outcome: 'unsupported' as const,
          reason: 'subject_mismatch' as const,
          evidenceId: 'mismatched-proof',
        },
      },
      {
        requirements: [
          { evidenceId: 'unknown-proof' },
          { evidenceId: 'mismatched-proof', subject: 'current' },
        ],
        evidence: [
          { id: 'unknown-proof', outcome: 'unknown' },
          { id: 'mismatched-proof', outcome: 'confirmed', subject: 'old' },
        ],
        expected: {
          outcome: 'unsupported' as const,
          reason: 'subject_mismatch' as const,
          evidenceId: 'mismatched-proof',
        },
      },
      {
        requirements: [
          { evidenceId: 'unknown-proof' },
          { evidenceId: 'missing-proof' },
        ],
        evidence: [{ id: 'unknown-proof', outcome: 'unknown' }],
        expected: {
          outcome: 'unsupported' as const,
          reason: 'missing_evidence' as const,
          evidenceId: 'missing-proof',
        },
      },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      expect(
        judgeEvidence({
          claims: [{ id: `claim-${index}`, requires: testCase.requirements }],
          evidence: testCase.evidence,
        }),
      ).toEqual({ claims: [{ claimId: `claim-${index}`, ...testCase.expected }] });
    }
  });

  it('uses the first declaration when several requirements share the winning class', () => {
    expect(
      judgeEvidence({
        claims: [
          {
            id: 'claim',
            requires: [
              { evidenceId: 'first-missing' },
              { evidenceId: 'second-missing' },
            ],
          },
        ],
        evidence: [],
      }),
    ).toEqual({
      claims: [
        {
          claimId: 'claim',
          outcome: 'unsupported',
          reason: 'missing_evidence',
          evidenceId: 'first-missing',
        },
      ],
    });
  });

  it('preserves shuffled claim input order in the verdict', () => {
    expect(
      judgeEvidence({
        claims: [
          { id: 'third', requires: [{ evidenceId: 'third-proof' }] },
          { id: 'first', requires: [{ evidenceId: 'first-proof' }] },
          { id: 'second', requires: [{ evidenceId: 'second-proof' }] },
        ],
        evidence: [
          { id: 'first-proof', outcome: 'confirmed' },
          { id: 'second-proof', outcome: 'refuted' },
          { id: 'third-proof', outcome: 'unknown' },
        ],
      }),
    ).toEqual({
      claims: [
        { claimId: 'third', outcome: 'unsupported', reason: 'unconfirmed_evidence', evidenceId: 'third-proof' },
        { claimId: 'first', outcome: 'supported' },
        { claimId: 'second', outcome: 'contradicted', evidenceId: 'second-proof' },
      ],
    });
  });

  it('rejects duplicate claim, evidence, and within-claim requirement identifiers', () => {
    expectEvidenceError(() =>
      judgeEvidence({
        claims: [
          { id: 'same-claim', requires: [{ evidenceId: 'proof-a' }] },
          { id: 'same-claim', requires: [{ evidenceId: 'proof-b' }] },
        ],
        evidence: [],
      }),
    );
    expectEvidenceError(() =>
      judgeEvidence({
        claims: [{ id: 'claim', requires: [{ evidenceId: 'proof-a' }] }],
        evidence: [
          { id: 'same-proof', outcome: 'confirmed' },
          { id: 'same-proof', outcome: 'unknown' },
        ],
      }),
    );
    expectEvidenceError(() =>
      judgeEvidence({
        claims: [
          {
            id: 'claim',
            requires: [
              { evidenceId: 'same-proof' },
              { evidenceId: 'same-proof' },
            ],
          },
        ],
        evidence: [],
      }),
    );

    expect(
      judgeEvidence({
        claims: [
          { id: 'first-claim', requires: [{ evidenceId: 'shared-proof' }] },
          { id: 'second-claim', requires: [{ evidenceId: 'shared-proof' }] },
        ],
        evidence: [{ id: 'shared-proof', outcome: 'confirmed' }],
      }),
    ).toEqual({
      claims: [
        { claimId: 'first-claim', outcome: 'supported' },
        { claimId: 'second-claim', outcome: 'supported' },
      ],
    });
  });

  it('rejects malformed input and explicit undefined optionals', () => {
    const invalidInputs: readonly unknown[] = [
      undefined,
      null,
      42,
      'input',
      [],
      new Date(),
      Object.create({}),
      {},
      { claims: [] },
      { evidence: [] },
      { claims: undefined, evidence: [] },
      { claims: [], evidence: undefined },
      { claims: 'not-an-array', evidence: [] },
      { claims: [], evidence: 'not-an-array' },
      { claims: [null], evidence: [] },
      { claims: [{ id: 'claim', requires: [{ evidenceId: 'proof' }] }], evidence: [null] },
      { claims: [{ requires: [{ evidenceId: 'proof' }] }], evidence: [] },
      { claims: [{ id: '', requires: [{ evidenceId: 'proof' }] }], evidence: [] },
      { claims: [{ id: ' \t\n', requires: [{ evidenceId: 'proof' }] }], evidence: [] },
      { claims: [{ id: 42, requires: [{ evidenceId: 'proof' }] }], evidence: [] },
      { claims: [{ id: null, requires: [{ evidenceId: 'proof' }] }], evidence: [] },
      { claims: [{ id: 'claim', requires: undefined }], evidence: [] },
      { claims: [{ id: 'claim', requires: 'not-an-array' }], evidence: [] },
      { claims: [{ id: 'claim', requires: [null] }], evidence: [] },
      { claims: [{ id: 'claim', requires: [{}] }], evidence: [] },
      { claims: [{ id: 'claim', requires: [{ evidenceId: '' }] }], evidence: [] },
      { claims: [{ id: 'claim', requires: [{ evidenceId: ' \t\n' }] }], evidence: [] },
      { claims: [{ id: 'claim', requires: [{ evidenceId: 42 }] }], evidence: [] },
      { claims: [{ id: 'claim', requires: [{ evidenceId: null }] }], evidence: [] },
      {
        claims: [{ id: 'claim', requires: [{ evidenceId: 'proof', subject: undefined }] }],
        evidence: [],
      },
      {
        claims: [{ id: 'claim', requires: [{ evidenceId: 'proof', subject: '' }] }],
        evidence: [],
      },
      {
        claims: [{ id: 'claim', requires: [{ evidenceId: 'proof', subject: 42 }] }],
        evidence: [],
      },
      {
        claims: [{ id: 'claim', requires: [{ evidenceId: 'proof' }] }],
        evidence: [{ id: 'proof', outcome: 'confirmed', subject: undefined }],
      },
      {
        claims: [{ id: 'claim', requires: [{ evidenceId: 'proof' }] }],
        evidence: [{ id: 'proof', outcome: 'confirmed', subject: '' }],
      },
      {
        claims: [{ id: 'claim', requires: [{ evidenceId: 'proof' }] }],
        evidence: [{ id: 'proof', outcome: 'CONFIRMED' }],
      },
      {
        claims: [{ id: 'claim', requires: [{ evidenceId: 'proof' }] }],
        evidence: [{ id: 'proof', outcome: undefined }],
      },
      {
        claims: [{ id: 'claim', requires: [{ evidenceId: 'proof' }] }],
        evidence: [{ id: 'proof' }],
      },
      {
        claims: [{ id: 'claim', requires: [{ evidenceId: 'proof' }] }],
        evidence: [{ id: '', outcome: 'confirmed' }],
      },
      {
        claims: [{ id: 'claim', requires: [{ evidenceId: 'proof' }] }],
        evidence: [{ id: ' \t\n', outcome: 'confirmed' }],
      },
      {
        claims: [{ id: 'claim', requires: [{ evidenceId: 'proof' }] }],
        evidence: [{ id: 42, outcome: 'confirmed' }],
      },
    ];

    for (const input of invalidInputs) {
      expectEvidenceError(() => judgeEvidence(input));
    }
  });

  it('preserves identifier spelling and treats surrounding spaces as significant', () => {
    expect(
      judgeEvidence({
        claims: [
          {
            id: ' claim ',
            requires: [{ evidenceId: ' alpha ' }, { evidenceId: 'alpha' }],
          },
        ],
        evidence: [
          { id: ' alpha ', outcome: 'confirmed' },
          { id: 'alpha', outcome: 'confirmed' },
        ],
      }),
    ).toEqual({ claims: [{ claimId: ' claim ', outcome: 'supported' }] });
  });

  it('ignores unreferenced evidence', () => {
    expect(
      judgeEvidence({
        claims: [
          { id: 'claim', requires: [{ evidenceId: 'required-proof' }] },
        ],
        evidence: [
          { id: 'unreferenced-refutation', outcome: 'refuted' },
          { id: 'required-proof', outcome: 'confirmed' },
          { id: 'unreferenced-confirmation', outcome: 'confirmed' },
        ],
      }),
    ).toEqual({ claims: [{ claimId: 'claim', outcome: 'supported' }] });
  });

  it('is deterministic and safe to JSON round-trip', () => {
    const input = {
      claims: [
        { id: 'second', requires: [{ evidenceId: 'unknown-proof' }] },
        { id: 'first', requires: [{ evidenceId: 'confirmed-proof' }] },
      ],
      evidence: [
        { id: 'confirmed-proof', outcome: 'confirmed' },
        { id: 'unknown-proof', outcome: 'unknown' },
      ],
    };
    const first = judgeEvidence(input);
    const second = judgeEvidence(input);

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(JSON.parse(JSON.stringify(input))).toEqual(input);
  });

  it('judges frozen inputs without aliasing returned values', () => {
    const input = deepFreeze({
      claims: [
        { id: 'claim', requires: [{ evidenceId: 'proof' }] },
      ],
      evidence: [{ id: 'proof', outcome: 'confirmed' }],
    });
    const expected: EvidenceVerdict = {
      claims: [{ claimId: 'claim', outcome: 'supported' }],
    };
    const first = judgeEvidence(input);
    const second = judgeEvidence(input);

    expect(first).toEqual(expected);
    expect(first).not.toBe(second);
    expect(first.claims).not.toBe(second.claims);
    expect(first.claims[0]).not.toBe(second.claims[0]);

    const mutableFirst = first as unknown as {
      claims: Array<{ claimId: string; outcome: string }>;
    };
    mutableFirst.claims[0]!.outcome = 'contradicted';
    mutableFirst.claims.push({ claimId: 'returned-only', outcome: 'supported' });

    expect(judgeEvidence(input)).toEqual(expected);
  });

  it('keeps the Progress boundary explicit without importing agent-progress', () => {
    const progressShapedVerdict = {
      outcome: 'progress' as const,
      newMilestones: ['implemented'],
      recordedMilestones: ['planned', 'implemented'],
    };
    const evidence = progressShapedVerdict.newMilestones.map((milestone) => ({
      id: `progress:${milestone}`,
      outcome: 'confirmed' as const,
    }));

    expect(
      judgeEvidence({
        claims: [
          {
            id: 'implemented',
            requires: [{ evidenceId: 'progress:implemented' }],
          },
        ],
        evidence,
      }),
    ).toEqual({ claims: [{ claimId: 'implemented', outcome: 'supported' }] });
  });

  it('leaves Retry Guard decisions to the caller', () => {
    const verdict = judgeEvidence({
      claims: [{ id: 'claim', requires: [{ evidenceId: 'proof' }] }],
      evidence: [{ id: 'proof', outcome: 'confirmed' }],
    });

    // A caller may consult this data before retry decisions; this package never touches retryAllowed.
    expect(verdict).not.toHaveProperty('retryAllowed');
    expect(verdict.claims[0]).not.toHaveProperty('retryAllowed');
    expect(Object.keys(verdict)).toEqual(['claims']);
  });
});
