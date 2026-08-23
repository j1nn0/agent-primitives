import { describe, expect, it } from 'vitest';
import { digest12 } from '../src/identifiers.js';
import {
  type DiscoveryToolResult,
  resolveDiscoveryQuote,
} from '../src/provenance.js';
import type {
  DiscoveryEvidenceSpan,
  DiscoveryProvenance,
} from '../src/types.js';

function toolResult(
  content: readonly unknown[],
  toolCallId = 'call-1',
): DiscoveryToolResult {
  return {
    toolCallId,
    toolName: 'test-tool',
    content,
  };
}

function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text };
}

function storedProvenance(
  text: string,
  startOffset: number,
  endOffset: number,
  toolCallId = 'call-1',
): DiscoveryProvenance {
  const quote = text.slice(startOffset, endOffset);
  return {
    toolCallId,
    toolName: 'test-tool',
    quoteHash: digest12(quote),
    span: { startOffset, endOffset },
  };
}

function malformedProvenance(span: unknown): DiscoveryProvenance {
  const base = {
    toolCallId: 'call-1',
    toolName: 'test-tool',
    quoteHash: digest12('valid text'),
  };
  return span === undefined
    ? base
    : { ...base, span: span as DiscoveryEvidenceSpan };
}

describe('discovery provenance resolution', () => {
  it('round-trips an ASCII quote', () => {
    const text = 'The command completed successfully.';
    const quote = 'completed successfully';
    const startOffset = text.indexOf(quote);
    const provenance = storedProvenance(
      text,
      startOffset,
      startOffset + quote.length,
    );

    expect(resolveDiscoveryQuote(provenance, [toolResult([textBlock(text)])])).toBe(
      quote,
    );
  });

  it('round-trips a Japanese quote', () => {
    const text = '検証結果はすべて成功しました。';
    const quote = 'すべて成功しました';
    const startOffset = text.indexOf(quote);
    const provenance = storedProvenance(
      text,
      startOffset,
      startOffset + quote.length,
    );

    expect(resolveDiscoveryQuote(provenance, [toolResult([textBlock(text)])])).toBe(
      quote,
    );
  });

  it('uses UTF-16 code-unit offsets around surrogate pairs', () => {
    const withEmoji = 'prefix 😀quoted value';
    const emojiQuote = '😀quoted';
    const emojiStart = withEmoji.indexOf(emojiQuote);
    const emojiProvenance = storedProvenance(
      withEmoji,
      emojiStart,
      emojiStart + emojiQuote.length,
    );

    expect(
      resolveDiscoveryQuote(emojiProvenance, [
        toolResult([textBlock(withEmoji)]),
      ]),
    ).toBe(emojiQuote);

    const afterEmoji = '😀日本語の結果';
    const afterEmojiQuote = '日本語';
    const afterEmojiStart = '😀'.length;
    const afterEmojiProvenance = storedProvenance(
      afterEmoji,
      afterEmojiStart,
      afterEmojiStart + afterEmojiQuote.length,
      'call-2',
    );

    expect(
      resolveDiscoveryQuote(afterEmojiProvenance, [
        toolResult([textBlock(afterEmoji)], 'call-2'),
      ]),
    ).toBe(afterEmojiQuote);
  });

  it('resolves a quote spanning multiple text blocks', () => {
    const content = [textBlock('prefix bo'), textBlock('undary suffix')];
    const text = 'prefix boundary suffix';
    const quote = 'boundary';
    const startOffset = text.indexOf(quote);
    const provenance = storedProvenance(
      text,
      startOffset,
      startOffset + quote.length,
    );

    expect(resolveDiscoveryQuote(provenance, [toolResult(content)])).toBe(quote);
  });

  it('excludes non-text blocks from the joined offsets', () => {
    const content = [
      textBlock('prefix-'),
      { type: 'image', data: 'PRIVATE-IMAGE-TEXT' },
      textBlock('suffix'),
    ];
    const text = 'prefix-suffix';
    const quote = text;
    const provenance = storedProvenance(text, 0, quote.length);

    expect(resolveDiscoveryQuote(provenance, [toolResult(content)])).toBe(quote);
  });

  it('records and resolves the first of two identical occurrences', () => {
    const text = 'before quote middle quote after';
    const quote = 'quote';
    const firstStart = text.indexOf(quote);
    const secondStart = text.indexOf(quote, firstStart + quote.length);
    const provenance = storedProvenance(
      text,
      firstStart,
      firstStart + quote.length,
    );
    const secondProvenance = storedProvenance(
      text,
      secondStart,
      secondStart + quote.length,
    );

    expect(firstStart).toBeLessThan(secondStart);
    expect(provenance.span).toEqual({
      startOffset: firstStart,
      endOffset: firstStart + quote.length,
    });
    expect(text.slice(provenance.span?.startOffset ?? -1, provenance.span?.endOffset)).toBe(
      quote,
    );
    expect(resolveDiscoveryQuote(provenance, [toolResult([textBlock(text)])])).toBe(
      quote,
    );
    expect(
      resolveDiscoveryQuote(secondProvenance, [toolResult([textBlock(text)])]),
    ).toBe(quote);
    expect(provenance.quoteHash).toBe(digest12(quote));
  });

  it('returns undefined when the quote hash does not match', () => {
    const text = 'verified text';
    const provenance: DiscoveryProvenance = {
      ...storedProvenance(text, 0, text.length),
      quoteHash: digest12('different text'),
    };

    expect(resolveDiscoveryQuote(provenance, [toolResult([textBlock(text)])])).toBe(
      undefined,
    );
  });

  it.each([
    { label: 'negative', startOffset: -1, endOffset: 2 },
    { label: 'non-integer', startOffset: 0.5, endOffset: 2 },
    { label: 'equal offsets', startOffset: 2, endOffset: 2 },
    { label: 'reversed offsets', startOffset: 3, endOffset: 2 },
    { label: 'past the end', startOffset: 0, endOffset: 99 },
  ])('returns undefined for $label spans', ({ startOffset, endOffset }) => {
    const text = 'valid text';
    const provenance = malformedProvenance({ startOffset, endOffset });

    expect(resolveDiscoveryQuote(provenance, [toolResult([textBlock(text)])])).toBe(
      undefined,
    );
  });

  it('returns undefined for an unknown tool call id', () => {
    const text = 'known result';
    const provenance = storedProvenance(text, 0, text.length, 'missing-call');

    expect(resolveDiscoveryQuote(provenance, [toolResult([textBlock(text)])])).toBe(
      undefined,
    );
  });

  it('returns undefined for pre-v4 provenance without a span', () => {
    const provenance: DiscoveryProvenance = {
      toolCallId: 'call-1',
      toolName: 'test-tool',
      quoteHash: digest12('legacy quote'),
    };

    expect(
      resolveDiscoveryQuote(provenance, [
        toolResult([textBlock('legacy quote')]),
      ]),
    ).toBeUndefined();
  });
});
