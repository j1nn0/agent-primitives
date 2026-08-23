import { describe, expect, it } from 'vitest';
import { DISCOVERY_SYSTEM_PROMPT } from '../src/discovery.js';
import {
  DISCOVERY_PROMPT_ANCHOR,
  DISCOVERY_PROMPT_VARIANTS,
  DISCOVERY_PROMPTS,
  EVIDENCE_NATIVE_PROMPT_REPLACEMENT,
  QUOTE_FIRST_PROMPT_REPLACEMENT,
  deriveDiscoveryPrompts,
  parseDiscoveryPromptVariant,
  replaceAtAnchor,
} from '../benchmark/discovery-prompts.js';

function withoutRepresentationInstruction(
  prompt: string,
  replacement: string,
): string {
  return prompt.replace(replacement, '');
}

describe('discovery benchmark prompt variants', () => {
  it('derives all variants from the real production prompt', () => {
    expect(DISCOVERY_PROMPTS.synthesized).toBe(DISCOVERY_SYSTEM_PROMPT);
    expect(DISCOVERY_PROMPTS['evidence-native']).toContain(
      EVIDENCE_NATIVE_PROMPT_REPLACEMENT,
    );
    expect(DISCOVERY_PROMPTS['quote-first']).toContain(
      QUOTE_FIRST_PROMPT_REPLACEMENT,
    );
  });

  it('has one production representation anchor', () => {
    expect(DISCOVERY_SYSTEM_PROMPT.split(DISCOVERY_PROMPT_ANCHOR)).toHaveLength(
      2,
    );
  });

  it('rejects missing and duplicate anchors', () => {
    expect(() => replaceAtAnchor('unrelated prompt', 'replacement')).toThrow(
      'anchor line not found',
    );
    expect(() =>
      replaceAtAnchor(
        `${DISCOVERY_PROMPT_ANCHOR}\n${DISCOVERY_PROMPT_ANCHOR}`,
        'replacement',
      ),
    ).toThrow('anchor line occurs more than once');
  });

  it('keeps variants byte-identical outside the representation instruction', () => {
    const prompts = deriveDiscoveryPrompts();
    expect(
      withoutRepresentationInstruction(
        prompts.synthesized,
        DISCOVERY_PROMPT_ANCHOR,
      ),
    ).toBe(
      withoutRepresentationInstruction(
        prompts['evidence-native'],
        EVIDENCE_NATIVE_PROMPT_REPLACEMENT,
      ),
    );
    expect(
      withoutRepresentationInstruction(
        prompts.synthesized,
        DISCOVERY_PROMPT_ANCHOR,
      ),
    ).toBe(
      withoutRepresentationInstruction(
        prompts['quote-first'],
        QUOTE_FIRST_PROMPT_REPLACEMENT,
      ),
    );
  });

  it('changes only the representation wording for evidence-native', () => {
    expect(DISCOVERY_PROMPTS['evidence-native']).toContain(
      'Never paraphrase, never write your own words',
    );
    expect(DISCOVERY_PROMPTS['evidence-native']).not.toContain(
      'in your own words',
    );
  });

  it('defaults to synthesized and accepts each variant', () => {
    expect(parseDiscoveryPromptVariant('')).toBe('synthesized');
    for (const variant of DISCOVERY_PROMPT_VARIANTS) {
      expect(parseDiscoveryPromptVariant(variant)).toBe(variant);
    }
    expect(() => parseDiscoveryPromptVariant('unknown')).toThrow(
      'Unknown discovery prompt variant "unknown"',
    );
  });

  it('rejects multiple variant arguments', () => {
    expect(() =>
      parseDiscoveryPromptVariant('synthesized quote-first'),
    ).toThrow('Expected at most one discovery prompt variant argument');
  });
});
