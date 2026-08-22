import { describe, expect, it } from 'vitest';
import { EXTRACTOR_SYSTEM_PROMPT } from '../src/extraction.js';
import {
  BENCHMARK_PROMPT_VARIANTS,
  BENCHMARK_PROMPTS,
  KIND_PROMPT_ADDITION,
  PROMPT_ANCHOR,
  SPAN_PROMPT_ADDITION,
  deriveBenchmarkPrompts,
  parseBenchmarkPromptVariant,
} from '../benchmark/prompts.js';

function expectedPrompt(additions: readonly string[]): string {
  return EXTRACTOR_SYSTEM_PROMPT.replace(
    PROMPT_ANCHOR,
    [PROMPT_ANCHOR, ...additions].join('\n'),
  );
}

describe('benchmark prompt variants', () => {
  it('keeps the baseline byte-identical to the production prompt', () => {
    expect(BENCHMARK_PROMPTS.baseline).toBe(EXTRACTOR_SYSTEM_PROMPT);
  });

  it('adds only the span instruction to the span variant', () => {
    expect(BENCHMARK_PROMPTS.span).toBe(
      expectedPrompt([SPAN_PROMPT_ADDITION]),
    );
    expect(BENCHMARK_PROMPTS.span).not.toContain(KIND_PROMPT_ADDITION);
  });

  it('adds only the kind definitions to the kind variant', () => {
    expect(BENCHMARK_PROMPTS.kind).toBe(
      expectedPrompt([KIND_PROMPT_ADDITION]),
    );
    expect(BENCHMARK_PROMPTS.kind).not.toContain(SPAN_PROMPT_ADDITION);
  });

  it('adds both independent instructions to the span-kind variant', () => {
    expect(BENCHMARK_PROMPTS['span-kind']).toBe(
      expectedPrompt([SPAN_PROMPT_ADDITION, KIND_PROMPT_ADDITION]),
    );
  });

  it.each(BENCHMARK_PROMPT_VARIANTS)(
    'preserves the invariant extraction rules for %s',
    (variant) => {
      const prompt = BENCHMARK_PROMPTS[variant];
      expect(prompt).toContain(
        'Allowed kinds are exactly goal, constraint, requirement, and decision; never fact.',
      );
      expect(prompt).toContain(
        'For every new item, content MUST be an exact contiguous substring of the user message, copied character for character. Never paraphrase, translate, reformat, or merge.',
      );
      expect(prompt).toContain(
        'Do not extract questions, greetings, one-off requests, formatting preferences, text inside code blocks or logs, quoted third-party or example instructions, hypothetical instructions, or instructions the user has not adopted as their own.',
      );
      expect(prompt).toContain(
        'Set critical to true only when losing the item would change the task correctness, safety, scope, or required outcome.',
      );
      expect(prompt).toContain(
        'When uncertain, omit the item. Return at most 8 added items.',
      );
      expect(prompt).toContain(
        'Reply with JSON only, matching this exact contract and nothing else: { "schemaVersion": 1, "add": [{ "content": "...", "kind": "constraint", "critical": true }], "removeAutoItemIds": ["auto:constraint:..."] }',
      );
    },
  );

  it('defaults to baseline and rejects unknown variant names', () => {
    expect(parseBenchmarkPromptVariant('')).toBe('baseline');
    expect(parseBenchmarkPromptVariant(' span ')).toBe('span');
    expect(() => parseBenchmarkPromptVariant('unknown')).toThrow(
      'Unknown benchmark prompt variant "unknown"',
    );
  });

  it('rejects more than one variant argument', () => {
    expect(() => parseBenchmarkPromptVariant('span kind')).toThrow(
      'Expected at most one benchmark prompt variant argument',
    );
  });

  it('throws when the production prompt anchor is missing', () => {
    const promptWithoutAnchor = EXTRACTOR_SYSTEM_PROMPT.replace(
      PROMPT_ANCHOR,
      '',
    );
    expect(() => deriveBenchmarkPrompts(promptWithoutAnchor)).toThrow(
      'anchor sentence not found',
    );
  });
});
