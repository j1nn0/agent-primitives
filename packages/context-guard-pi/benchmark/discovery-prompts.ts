import { DISCOVERY_SYSTEM_PROMPT } from '../src/discovery.js';

export const DISCOVERY_PROMPT_VARIANTS = [
  'synthesized',
  'evidence-native',
  'quote-first',
] as const;

export type DiscoveryPromptVariant = (typeof DISCOVERY_PROMPT_VARIANTS)[number];

export const DISCOVERY_PROMPT_ANCHOR =
  'Fact content must be a short self-contained claim in your own words, at most 500 Unicode code points. State the scope when it matters, including the relevant name, version, file, or command.';

export const EVIDENCE_NATIVE_PROMPT_REPLACEMENT = [
  'Fact content must be exactly one contiguous substring of one referenced evidence text, copied character for character, at most 500 Unicode code points. Never paraphrase, never write your own words, never join two substrings, and never add or remove characters.',
  'Choose a substring that stands alone as a complete fact without the surrounding conversation, carrying its own subject and scope. If no single substring is self-contained enough to stand alone, omit the fact instead of shortening or rewriting one.',
].join('\n');

export const QUOTE_FIRST_PROMPT_REPLACEMENT = [
  'When one contiguous substring of a referenced evidence text already stands alone as a short, complete fact without the surrounding conversation, use that substring unchanged as the content, copied character for character.',
  'Write your own wording only when no single substring is sufficient because scope, context, or several evidence records are required. Then keep the claim minimal and copy identifiers, versions, names, commands, and paths exactly as they appear in the evidence.',
  'Fact content is at most 500 Unicode code points. State the scope when it matters, including the relevant name, version, file, or command.',
].join('\n');

export function replaceAtAnchor(
  productionPrompt: string,
  replacement: string,
): string {
  const anchorIndex = productionPrompt.indexOf(DISCOVERY_PROMPT_ANCHOR);
  if (anchorIndex === -1) {
    throw new Error(
      `Cannot derive discovery benchmark prompt: anchor line not found in DISCOVERY_SYSTEM_PROMPT: "${DISCOVERY_PROMPT_ANCHOR}"`,
    );
  }

  const nextAnchorIndex = productionPrompt.indexOf(
    DISCOVERY_PROMPT_ANCHOR,
    anchorIndex + DISCOVERY_PROMPT_ANCHOR.length,
  );
  if (nextAnchorIndex !== -1) {
    throw new Error(
      `Cannot derive discovery benchmark prompt: anchor line occurs more than once in DISCOVERY_SYSTEM_PROMPT: "${DISCOVERY_PROMPT_ANCHOR}"`,
    );
  }

  return `${productionPrompt.slice(0, anchorIndex)}${replacement}${productionPrompt.slice(anchorIndex + DISCOVERY_PROMPT_ANCHOR.length)}`;
}

export function deriveDiscoveryPrompts(
  productionPrompt: string = DISCOVERY_SYSTEM_PROMPT,
): Readonly<Record<DiscoveryPromptVariant, string>> {
  return {
    synthesized: productionPrompt,
    'evidence-native': replaceAtAnchor(
      productionPrompt,
      EVIDENCE_NATIVE_PROMPT_REPLACEMENT,
    ),
    'quote-first': replaceAtAnchor(
      productionPrompt,
      QUOTE_FIRST_PROMPT_REPLACEMENT,
    ),
  };
}

export const DISCOVERY_PROMPTS = deriveDiscoveryPrompts();

export function getDiscoveryPrompt(variant: DiscoveryPromptVariant): string {
  return DISCOVERY_PROMPTS[variant];
}

function isDiscoveryPromptVariant(
  value: string,
): value is DiscoveryPromptVariant {
  return DISCOVERY_PROMPT_VARIANTS.includes(value as DiscoveryPromptVariant);
}

export function parseDiscoveryPromptVariant(
  args: string,
): DiscoveryPromptVariant {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    return 'synthesized';
  }

  const values = trimmed.split(/\s+/);
  if (values.length !== 1) {
    throw new Error(
      `Expected at most one discovery prompt variant argument; expected one of: ${DISCOVERY_PROMPT_VARIANTS.join(', ')}.`,
    );
  }

  const value = values[0];
  if (value === undefined || !isDiscoveryPromptVariant(value)) {
    throw new Error(
      `Unknown discovery prompt variant "${value ?? trimmed}". Expected one of: ${DISCOVERY_PROMPT_VARIANTS.join(', ')}.`,
    );
  }
  return value;
}
