import { EXTRACTOR_SYSTEM_PROMPT } from '../src/extraction.js';

export const BENCHMARK_PROMPT_VARIANTS = [
  'baseline',
  'span',
  'kind',
  'span-kind',
] as const;

export type BenchmarkPromptVariant =
  (typeof BENCHMARK_PROMPT_VARIANTS)[number];

export const PROMPT_ANCHOR =
  'Extract only instructions that must stay true in later turns.';

export const SPAN_PROMPT_ADDITION =
  'For each new item, choose the shortest contiguous substring that still expresses the complete durable instruction on its own; exclude politeness, discourse markers, reasons, explanations, and surrounding context unless needed to preserve meaning.';

export const KIND_PROMPT_ADDITION =
  'Kind definitions: goal is the desired end state or outcome; constraint is a boundary or prohibition restricting how work may be done or what must not change; requirement is a condition, property, validation or deliverable the result must satisfy; decision is a choice already made between alternatives.';

function augmentAtAnchor(
  productionPrompt: string,
  addition: string,
): string {
  const anchorIndex = productionPrompt.indexOf(PROMPT_ANCHOR);
  if (anchorIndex === -1) {
    throw new Error(
      `Cannot derive benchmark prompt: anchor sentence not found in EXTRACTOR_SYSTEM_PROMPT: "${PROMPT_ANCHOR}"`,
    );
  }

  const nextAnchorIndex = productionPrompt.indexOf(
    PROMPT_ANCHOR,
    anchorIndex + PROMPT_ANCHOR.length,
  );
  if (nextAnchorIndex !== -1) {
    throw new Error(
      `Cannot derive benchmark prompt: anchor sentence occurs more than once in EXTRACTOR_SYSTEM_PROMPT: "${PROMPT_ANCHOR}"`,
    );
  }

  const insertion = `${PROMPT_ANCHOR}\n${addition}`;
  return `${productionPrompt.slice(0, anchorIndex)}${insertion}${productionPrompt.slice(anchorIndex + PROMPT_ANCHOR.length)}`;
}

export function deriveBenchmarkPrompts(
  productionPrompt: string = EXTRACTOR_SYSTEM_PROMPT,
): Readonly<Record<BenchmarkPromptVariant, string>> {
  return {
    baseline: productionPrompt,
    span: augmentAtAnchor(productionPrompt, SPAN_PROMPT_ADDITION),
    kind: augmentAtAnchor(productionPrompt, KIND_PROMPT_ADDITION),
    'span-kind': augmentAtAnchor(
      productionPrompt,
      `${SPAN_PROMPT_ADDITION}\n${KIND_PROMPT_ADDITION}`,
    ),
  };
}

export const BENCHMARK_PROMPTS = deriveBenchmarkPrompts();

export function getBenchmarkPrompt(
  variant: BenchmarkPromptVariant,
): string {
  return BENCHMARK_PROMPTS[variant];
}

function isBenchmarkPromptVariant(
  value: string,
): value is BenchmarkPromptVariant {
  return BENCHMARK_PROMPT_VARIANTS.includes(
    value as BenchmarkPromptVariant,
  );
}

export function parseBenchmarkPromptVariant(
  args: string,
): BenchmarkPromptVariant {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    return 'baseline';
  }

  const values = trimmed.split(/\s+/);
  if (values.length !== 1) {
    throw new Error(
      `Expected at most one benchmark prompt variant argument; expected one of: ${BENCHMARK_PROMPT_VARIANTS.join(', ')}.`,
    );
  }

  const value = values[0];
  if (value === undefined || !isBenchmarkPromptVariant(value)) {
    throw new Error(
      `Unknown benchmark prompt variant "${value ?? trimmed}". Expected one of: ${BENCHMARK_PROMPT_VARIANTS.join(', ')}.`,
    );
  }
  return value;
}
