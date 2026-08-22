import { describe, expect, it } from 'vitest';
import {
  createContextGuard,
  createLiteralVerifier,
  verifyContext,
} from '../src/index.js';
import type {
  ContextItemInput,
  ContextVerifier,
  LiteralVerifierOptions,
} from '../src/index.js';

function item(id: string, content: string): ContextItemInput {
  return { id, kind: 'fact', content };
}

async function verifyOne(
  content: string,
  context: string,
  options?: LiteralVerifierOptions,
) {
  const guard = createContextGuard([item('item', content)]);
  return verifyContext({
    snapshot: guard.snapshot(),
    context,
    verifier: createLiteralVerifier(options),
  });
}

describe('literal verifier', () => {
  it('marks an exact match as preserved', async () => {
    const report = await verifyOne('Keep this requirement', 'Keep this requirement');

    expect(report.findings).toEqual([
      {
        itemId: 'item',
        status: 'preserved',
        reason:
          'The item content appears in the candidate context after the configured normalization.',
      },
    ]);
    expect(report.ok).toBe(true);
  });

  it('marks missing content and an empty context as lost', async () => {
    const missing = await verifyOne('Keep this requirement', 'A different context');
    const empty = await verifyOne('Keep this requirement', '');

    expect(missing.lost).toEqual(['item']);
    expect(empty.lost).toEqual(['item']);
    expect(missing.findings[0]?.reason).toBe(
      'The item content does not appear in the candidate context after the configured normalization.',
    );
  });

  it('supports case-sensitive and case-insensitive matching', async () => {
    const insensitive = await verifyOne('Keep This', 'keep this');
    const sensitive = await verifyOne('Keep This', 'keep this', {
      caseSensitive: true,
    });

    expect(insensitive.preserved).toEqual(['item']);
    expect(sensitive.lost).toEqual(['item']);
  });

  it('normalizes multi-space, newline, and tab whitespace when enabled', async () => {
    const normalized = await verifyOne(
      'multi space value',
      'prefix multi\t  space\nvalue suffix',
    );
    const disabled = await verifyOne(
      'multi space value',
      'prefix multi\t  space\nvalue suffix',
      { normalizeWhitespace: false },
    );
    const exactWhitespace = await verifyOne(
      'multi\tspace\nvalue',
      'multi\tspace\nvalue',
      { normalizeWhitespace: false },
    );

    expect(normalized.preserved).toEqual(['item']);
    expect(disabled.lost).toEqual(['item']);
    expect(exactWhitespace.preserved).toEqual(['item']);
  });

  it('never returns changed for a paraphrased context', async () => {
    const report = await verifyOne(
      'Do not remove the deployment constraint',
      'The deployment constraint should always remain in place.',
    );

    expect(report.changed).toEqual([]);
    expect(report.lost).toEqual(['item']);
  });

  it('handles many items in one verifier call', async () => {
    const guard = createContextGuard([
      item('one', 'one'),
      item('two', 'two'),
      item('three', 'three'),
    ]);
    const literal = createLiteralVerifier();
    let calls = 0;
    const verifier: ContextVerifier = {
      verify(input) {
        calls += 1;
        return literal.verify(input);
      },
    };

    const report = await verifyContext({
      snapshot: guard.snapshot(),
      context: 'one, two, and three',
      verifier,
    });

    expect(calls).toBe(1);
    expect(report.findings).toHaveLength(3);
    expect(report.preserved).toEqual(['one', 'two', 'three']);
  });
});
