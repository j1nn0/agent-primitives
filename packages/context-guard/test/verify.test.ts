import { describe, expect, it } from 'vitest';
import {
  ContextGuardError,
  createContextGuard,
  createLiteralVerifier,
  verifyContext,
} from '../src/index.js';
import type {
  ContextItemInput,
  ContextSnapshot,
  ContextVerifier,
  ContextVerifierInput,
  VerificationFinding,
  VerificationReport,
  VerifyContextInput,
} from '../src/index.js';

function item(
  id: string,
  content = `content-${id}`,
  critical = false,
): ContextItemInput {
  return { id, kind: 'fact', content, critical };
}

function snapshotOf(items: readonly ContextItemInput[] = [item('item')]): ContextSnapshot {
  return createContextGuard(items).snapshot();
}

function verifierReturning(result: unknown): ContextVerifier {
  return {
    verify: () => result as unknown as readonly VerificationFinding[],
  };
}

function expectNotPreserved(report: VerificationReport, id = 'item'): void {
  expect(report.ok).toBe(false);
  expect(report.preserved).not.toContain(id);
}

async function expectInvalidInput(input: unknown, code = 'invalid_input'): Promise<void> {
  let thrown: unknown;
  try {
    await verifyContext(input as unknown as VerifyContextInput);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(ContextGuardError);
  expect((thrown as ContextGuardError).code).toBe(code);
}

describe('custom verification and report normalization', () => {
  it('maps every verifier status into the matching report bucket and batches input', async () => {
    const snapshot = snapshotOf([
      item('preserved'),
      item('changed'),
      item('lost'),
      item('unknown'),
    ]);
    const calls: ContextVerifierInput[] = [];
    const verifier: ContextVerifier = {
      verify(input) {
        calls.push(input);
        return [
          { itemId: 'preserved', status: 'preserved' },
          { itemId: 'changed', status: 'changed' },
          { itemId: 'lost', status: 'lost' },
          { itemId: 'unknown', status: 'unknown' },
        ];
      },
    };

    const report = await verifyContext({
      snapshot,
      context: 'candidate context',
      verifier,
    });

    expect(report.preserved).toEqual(['preserved']);
    expect(report.changed).toEqual(['changed']);
    expect(report.lost).toEqual(['lost']);
    expect(report.unknown).toEqual(['unknown']);
    expect(report.findings.map((finding) => finding.itemId)).toEqual([
      'preserved',
      'changed',
      'lost',
      'unknown',
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.items.map((entry) => entry.id)).toEqual([
      'preserved',
      'changed',
      'lost',
      'unknown',
    ]);
  });

  it('supports asynchronous verifiers and the guard convenience method', async () => {
    const guard = createContextGuard([item('item', 'keep')]);
    const verifier: ContextVerifier = {
      async verify() {
        return [{ itemId: 'item', status: 'preserved' }];
      },
    };

    const standalone = await verifyContext({
      snapshot: guard.snapshot(),
      context: 'keep',
      verifier,
    });
    const convenience = await guard.verify('keep', { verifier: createLiteralVerifier() });

    expect(standalone.ok).toBe(true);
    expect(convenience.ok).toBe(true);
  });

  it('normalizes missing findings to unknown', async () => {
    const report = await verifyContext({
      snapshot: snapshotOf(),
      context: 'candidate',
      verifier: verifierReturning([]),
    });

    expectNotPreserved(report);
    expect(report.findings).toEqual([
      {
        itemId: 'item',
        status: 'unknown',
        reason: 'The verifier returned no finding for this item.',
      },
    ]);
    expect(report.issues).toContain('missing finding for item "item"');
  });

  it('normalizes agreeing and disagreeing duplicate findings to unknown', async () => {
    const duplicateResults = [
      [
        { itemId: 'item', status: 'lost' },
        { itemId: 'item', status: 'lost' },
      ],
      [
        { itemId: 'item', status: 'lost' },
        { itemId: 'item', status: 'changed' },
      ],
    ];

    for (const result of duplicateResults) {
      const report = await verifyContext({
        snapshot: snapshotOf(),
        context: 'candidate',
        verifier: verifierReturning(result),
      });

      expectNotPreserved(report);
      expect(report.unknown).toEqual(['item']);
      expect(report.issues).toContain('duplicate findings for item "item"');
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0]?.reason).toBe(
        'The verifier returned conflicting findings for this item.',
      );
    }
  });

  it('rejects unknown ids, unsupported statuses, non-array results, and malformed entries safely', async () => {
    const cases: readonly { result: unknown; issue: string }[] = [
      {
        result: [{ itemId: 'unknown', status: 'preserved' }],
        issue: 'finding for unknown item id "unknown"',
      },
      {
        result: [{ itemId: 'item', status: 'unsupported' }],
        issue: 'unsupported status for item "item"',
      },
      {
        result: { itemId: 'item', status: 'preserved' },
        issue: 'verifier returned a non-array result',
      },
      {
        result: [null, 42, 'not an object'],
        issue: 'malformed finding at index 0',
      },
    ];

    for (const testCase of cases) {
      const report = await verifyContext({
        snapshot: snapshotOf(),
        context: 'candidate',
        verifier: verifierReturning(testCase.result),
      });

      expectNotPreserved(report);
      expect(report.issues).toContain(testCase.issue);
    }

    const malformedEntries = await verifyContext({
      snapshot: snapshotOf(),
      context: 'candidate',
      verifier: verifierReturning([{ status: 'lost' }]),
    });
    expectNotPreserved(malformedEntries);
    expect(malformedEntries.issues).toContain('malformed finding at index 0');
  });

  it('taints a known item when any finding for it is structurally invalid', async () => {
    const report = await verifyContext({
      snapshot: snapshotOf([item('baseline', 'Do not use a baseline.', true), item('other')]),
      context: 'candidate',
      verifier: verifierReturning([
        { itemId: 'baseline', status: 'preserved' },
        { itemId: 'baseline', status: 'INVALID' },
        { itemId: 'other', status: 'preserved' },
      ]),
    });

    expect(report.findings).toEqual([
      {
        itemId: 'baseline',
        status: 'unknown',
        reason: 'The verifier returned a structurally invalid finding for this item.',
      },
      { itemId: 'other', status: 'preserved' },
    ]);
    expect(report.unknown).toEqual(['baseline']);
    expect(report.preserved).toEqual(['other']);
    expect(report.criticalFailures).toEqual(['baseline']);
    expect(report.issues).toContain('unsupported status for item "baseline"');
    expect(report.ok).toBe(false);
  });

  it('taints a known item when reading its finding throws', async () => {
    const hostile = { itemId: 'item' };
    Object.defineProperty(hostile, 'status', {
      get() {
        throw new Error('hostile getter');
      },
      enumerable: true,
    });

    const report = await verifyContext({
      snapshot: snapshotOf([item('item', 'content-item', true)]),
      context: 'candidate',
      verifier: verifierReturning([{ itemId: 'item', status: 'preserved' }, hostile]),
    });

    expect(report.unknown).toEqual(['item']);
    expect(report.criticalFailures).toEqual(['item']);
    expect(report.issues).toContain('malformed finding at index 1');
    expect(report.ok).toBe(false);
  });

  it('does not taint items when a finding names an unknown item id', async () => {
    const report = await verifyContext({
      snapshot: snapshotOf(),
      context: 'candidate',
      verifier: verifierReturning([
        { itemId: 'item', status: 'preserved' },
        { itemId: 'ghost', status: 'INVALID' },
      ]),
    });

    expect(report.preserved).toEqual(['item']);
    expect(report.issues).toEqual(['finding for unknown item id "ghost"']);
    expect(report.ok).toBe(false);
  });

  it('drops non-string reasons while honoring the finding status', async () => {
    const report = await verifyContext({
      snapshot: snapshotOf(),
      context: 'candidate',
      verifier: verifierReturning([
        { itemId: 'item', status: 'lost', reason: { private: 'value' } },
      ]),
    });

    expect(report.ok).toBe(false);
    expect(report.lost).toEqual(['item']);
    expect(report.findings).toEqual([{ itemId: 'item', status: 'lost' }]);
    expect(report.issues).toContain('non-string reason for item "item"');
  });

  it('fails safely when the verifier throws or rejects', async () => {
    const thrown = await verifyContext({
      snapshot: snapshotOf(),
      context: 'candidate',
      verifier: {
        verify() {
          throw new Error('verifier failed');
        },
      },
    });
    const rejected = await verifyContext({
      snapshot: snapshotOf(),
      context: 'candidate',
      verifier: {
        async verify() {
          throw new Error('verifier rejected');
        },
      },
    });

    for (const report of [thrown, rejected]) {
      expectNotPreserved(report);
      expect(report.unknown).toEqual(['item']);
      expect(report.findings[0]?.reason).toBe(
        'The verifier failed, so this item could not be evaluated.',
      );
      expect(report.issues).toEqual(['verifier threw an error']);
    }
  });
});

describe('critical verification items', () => {
  it('records critical changed, lost, and unknown items as failures', async () => {
    const statuses = ['changed', 'lost', 'unknown'] as const;

    for (const status of statuses) {
      const report = await verifyContext({
        snapshot: snapshotOf([item('critical', 'content', true)]),
        context: 'candidate',
        verifier: verifierReturning([{ itemId: 'critical', status }]),
      });

      expect(report.ok).toBe(false);
      expect(report.criticalFailures).toEqual(['critical']);
    }
  });

  it('fails on a non-critical loss without a critical failure', async () => {
    const report = await verifyContext({
      snapshot: snapshotOf([item('ordinary')]),
      context: 'candidate',
      verifier: verifierReturning([{ itemId: 'ordinary', status: 'lost' }]),
    });

    expect(report.ok).toBe(false);
    expect(report.lost).toEqual(['ordinary']);
    expect(report.criticalFailures).toEqual([]);
  });

  it('is successful when all items are preserved', async () => {
    const report = await verifyContext({
      snapshot: snapshotOf([item('ordinary'), item('critical', 'content', true)]),
      context: 'candidate',
      verifier: verifierReturning([
        { itemId: 'ordinary', status: 'preserved' },
        { itemId: 'critical', status: 'preserved' },
      ]),
    });

    expect(report.ok).toBe(true);
    expect(report.criticalFailures).toEqual([]);
    expect(report.issues).toEqual([]);
  });
});

describe('verifyContext input validation', () => {
  const validInput = (): VerifyContextInput => ({
    snapshot: snapshotOf(),
    context: 'candidate',
    verifier: createLiteralVerifier(),
  });

  it('rejects invalid outer input and snapshot shapes', async () => {
    await expectInvalidInput(null);
    await expectInvalidInput({});
    await expectInvalidInput({ ...validInput(), snapshot: null });
    await expectInvalidInput({
      ...validInput(),
      snapshot: { schemaVersion: 2, items: [] },
    });
    await expectInvalidInput({
      ...validInput(),
      snapshot: { schemaVersion: 1, items: {} },
    });
    await expectInvalidInput({
      ...validInput(),
      snapshot: {
        schemaVersion: 1,
        items: [{ id: '', kind: 'fact', content: 'content', critical: false }],
      },
    });
  });

  it('rejects duplicate snapshot ids with the duplicate error code', async () => {
    await expectInvalidInput(
      {
        ...validInput(),
        snapshot: {
          schemaVersion: 1,
          items: [item('same'), item('same')],
        },
      },
      'duplicate_item_id',
    );
  });

  it('rejects non-string context and verifiers without a verify function', async () => {
    await expectInvalidInput({ ...validInput(), context: 42 });
    await expectInvalidInput({ ...validInput(), verifier: null });
    await expectInvalidInput({ ...validInput(), verifier: {} });
  });
});
