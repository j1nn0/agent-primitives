import { digest12 } from './identifiers.js';
import { isTextBlock } from './extraction.js';
import type {
  DiscoveryEvidenceSpan,
  DiscoveryProvenance,
} from './types.js';

/** The smallest tool-result shape needed to resolve discovery provenance. */
export interface DiscoveryToolResult {
  readonly toolCallId: string;
  readonly toolName?: string;
  readonly content: readonly unknown[];
}

/**
 * Joins the text blocks exactly as discovery evidence is collected. The
 * offsets in DiscoveryEvidenceSpan are UTF-16 code-unit offsets into this
 * string.
 */
export function concatenateEvidenceText(content: readonly unknown[]): string {
  return content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('');
}

function isEvidenceSpan(value: unknown): value is DiscoveryEvidenceSpan {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const span = value as {
    readonly startOffset?: unknown;
    readonly endOffset?: unknown;
  };
  return (
    typeof span.startOffset === 'number' &&
    typeof span.endOffset === 'number' &&
    Number.isInteger(span.startOffset) &&
    Number.isInteger(span.endOffset) &&
    span.startOffset >= 0 &&
    span.endOffset > span.startOffset
  );
}

/**
 * Resolves and verifies a discovery quote from tool results on a caller's
 * current branch. An absent result or any unverifiable metadata returns
 * undefined rather than implying that the associated fact is invalid.
 */
export function resolveDiscoveryQuote(
  provenance: DiscoveryProvenance,
  toolResults: readonly DiscoveryToolResult[],
): string | undefined {
  try {
    const span = provenance.span;
    if (!isEvidenceSpan(span)) {
      return undefined;
    }

    const result = toolResults.find(
      (toolResult) => toolResult.toolCallId === provenance.toolCallId,
    );
    if (result === undefined) {
      return undefined;
    }

    const text = concatenateEvidenceText(result.content);
    if (span.endOffset > text.length) {
      return undefined;
    }

    const quote = text.slice(span.startOffset, span.endOffset);
    return digest12(quote) === provenance.quoteHash ? quote : undefined;
  } catch {
    return undefined;
  }
}
