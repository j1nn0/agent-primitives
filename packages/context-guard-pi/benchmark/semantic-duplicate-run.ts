import { writeFile } from 'node:fs/promises';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';

import {
  getAuxiliaryReasoningEffort,
  REQUEST_TIMEOUT_MS,
  signalFailureKind,
} from '../src/request.js';
import {
  isSemanticClassification,
  tokenOverlapSimilarity,
  type SemanticClassification,
} from './semantic-duplicate-evaluate.js';
import {
  SEMANTIC_DUPLICATE_CORPUS,
  type SemanticLabel,
  type SemanticPair,
} from './semantic-duplicate-corpus.js';

export const SEMANTIC_RESULTS_PATH_ENV =
  'CONTEXT_GUARD_SEMANTIC_BENCHMARK_RESULTS_PATH';

export type SemanticBenchmarkSubset = 'subsample' | 'variance' | 'session';
export type SemanticFailureKind =
  | 'timeout'
  | 'aborted'
  | 'provider'
  | 'invalid-response'
  | 'invalid-output';
export type SemanticRunOutcome = 'success' | SemanticFailureKind;

const SUBSAMPLE_COUNTS: Readonly<
  Record<Exclude<SemanticLabel, 'ambiguous'>, number>
> = {
  duplicate: 10,
  'same-subject-different': 7,
  'compatible-distinct': 5,
  contradictory: 5,
  unrelated: 3,
};

const SEMANTIC_SYSTEM_PROMPT = [
  'Classify the relationship between the two facts in the user message.',
  'Return exactly one JSON object and no other text.',
  '{ "schemaVersion": 1, "classification": "duplicate" | "same-subject-different" | "compatible-distinct" | "contradictory" | "unrelated" }',
  'Definitions:',
  'duplicate — the same fact stated differently.',
  'same-subject-different — the same subject has a different value.',
  'compatible-distinct — the same subject has different properties that can both be true.',
  'contradictory — the two facts cannot both be true.',
  'unrelated — the facts concern different subjects.',
  'Do not explain the classification.',
].join('\n');

export interface SemanticPairRunRecord {
  readonly pairId: string;
  readonly trueLabel: SemanticLabel;
  readonly classification: SemanticClassification | null;
  readonly outcome: SemanticRunOutcome;
  readonly elapsedMs: number;
  readonly run: number;
}

export interface SemanticBenchmarkArtifact {
  readonly schemaVersion: 1;
  readonly subset: SemanticBenchmarkSubset;
  readonly model: {
    readonly id: string;
    readonly provider: string;
  };
  readonly iterations: number;
  readonly pairCount: number;
  readonly records: readonly SemanticPairRunRecord[];
  readonly failureCounts: Readonly<Record<SemanticFailureKind, number>>;
}

export const SEMANTIC_DUPLICATE_SUBSAMPLE: readonly SemanticPair[] = [
  ...Object.entries(SUBSAMPLE_COUNTS).flatMap(([label, count]) =>
    [...SEMANTIC_DUPLICATE_CORPUS]
      .filter((pair) => pair.label === label)
      .sort((left, right) => compareStrings(left.id, right.id))
      .slice(0, count),
  ),
].sort((left, right) => compareStrings(left.id, right.id));

const hardestHardNegatives = [...SEMANTIC_DUPLICATE_CORPUS]
  .filter((pair) => pair.hardNegative)
  .sort(compareBySimilarityDescending)
  .slice(0, 5);
const lowestOverlapDuplicates = [...SEMANTIC_DUPLICATE_CORPUS]
  .filter((pair) => pair.label === 'duplicate')
  .sort(compareBySimilarityAscending)
  .slice(0, 5);

export const SEMANTIC_DUPLICATE_VARIANCE: readonly SemanticPair[] = [
  ...hardestHardNegatives,
  ...lowestOverlapDuplicates,
].sort((left, right) => compareStrings(left.id, right.id));

/**
 * Pairs drawn from the seventeen discoveries a real Pi session captured, chosen
 * by hand: the ones a reviewer would most plausibly want flagged, plus two
 * unrelated controls.
 *
 * Their labels are the finding. The session produced facts about *different*
 * things, so there is no true duplicate here to find — which makes this subset
 * a test of restraint rather than of recall. A `duplicate` verdict on any of
 * these would be an operational false duplicate, the outcome that matters most.
 */
export const SEMANTIC_DUPLICATE_SESSION: readonly SemanticPair[] = [
  {
    id: 'session-workspace-layout',
    language: 'en',
    left: 'The repository contains top-level package.json, pnpm-lock.yaml, and pnpm-workspace.yaml files, plus examples, packages, and node_modules directories.',
    right: 'The workspace includes packages/* and examples/* directories.',
    // Overlapping but not the same claim; a reviewer could argue either way.
    label: 'ambiguous',
    hardNegative: false,
  },
  {
    id: 'session-root-files',
    language: 'en',
    left: 'The repository contains top-level package.json, pnpm-lock.yaml, and pnpm-workspace.yaml files, plus examples, packages, and node_modules directories.',
    right: 'The repository root includes eslint.config.js, AGENTS.md, CLAUDE.md, and package.json.',
    label: 'compatible-distinct',
    hardNegative: true,
  },
  {
    id: 'session-eslint-properties',
    language: 'en',
    left: 'The ESLint configuration ignores dist, node_modules, and coverage directories at any depth.',
    right: 'The ESLint configuration uses eslint.configs.recommended and the recommended typescript-eslint configuration.',
    label: 'compatible-distinct',
    hardNegative: true,
  },
  {
    id: 'session-compiler-strict-target',
    language: 'en',
    left: 'The compiler configuration enables strict type checking and unchecked-index safeguards.',
    right: 'The compiler targets ES2023 and uses NodeNext module and module-resolution settings.',
    label: 'compatible-distinct',
    hardNegative: true,
  },
  {
    id: 'session-compiler-strict-emit',
    language: 'en',
    left: 'The compiler configuration enables strict type checking and unchecked-index safeguards.',
    right: 'The compiler emits declaration files, declaration maps, and source maps.',
    label: 'compatible-distinct',
    hardNegative: true,
  },
  {
    id: 'session-compiler-target-emit',
    language: 'en',
    left: 'The compiler targets ES2023 and uses NodeNext module and module-resolution settings.',
    right: 'The compiler emits declaration files, declaration maps, and source maps.',
    label: 'compatible-distinct',
    hardNegative: true,
  },
  {
    id: 'session-extension-session-compact',
    language: 'en',
    left: 'The extension increments sessionEpoch, aborts active requests, and resets discovery and lifecycle state.',
    right: 'The extension captures a lifecycle snapshot before compaction and handles it when session_compact occurs.',
    label: 'compatible-distinct',
    hardNegative: true,
  },
  {
    id: 'session-extension-compact-turn',
    language: 'en',
    left: 'The extension captures a lifecycle snapshot before compaction and handles it when session_compact occurs.',
    right: 'The extension begins discovery turns on turn_start and processes tool results on tool_result.',
    label: 'compatible-distinct',
    hardNegative: true,
  },
  {
    id: 'session-package-ci',
    language: 'en',
    left: 'The root package is named agent-primitives, version 0.1.0, and is private.',
    right: 'The repository contains the file `.github/workflows/ci.yml`.',
    label: 'unrelated',
    hardNegative: false,
  },
  {
    id: 'session-engine-tests',
    language: 'en',
    left: 'The project requires Node.js >=22.12.0 and uses pnpm@10.34.5.',
    right: 'The @j1nn0/agent-context-guard-pi@0.1.0 test suite passed: 10 test files and 209 tests passed under Vitest.',
    label: 'unrelated',
    hardNegative: false,
  },
];

export const SEMANTIC_DUPLICATE_SUBSETS = {
  subsample: SEMANTIC_DUPLICATE_SUBSAMPLE,
  variance: SEMANTIC_DUPLICATE_VARIANCE,
  session: SEMANTIC_DUPLICATE_SESSION,
} as const;

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareBySimilarityDescending(
  left: SemanticPair,
  right: SemanticPair,
): number {
  const difference =
    tokenOverlapSimilarity(right.left, right.right) -
    tokenOverlapSimilarity(left.left, left.right);
  return difference === 0 ? compareStrings(left.id, right.id) : difference;
}

function compareBySimilarityAscending(
  left: SemanticPair,
  right: SemanticPair,
): number {
  const difference =
    tokenOverlapSimilarity(left.left, left.right) -
    tokenOverlapSimilarity(right.left, right.right);
  return difference === 0 ? compareStrings(left.id, right.id) : difference;
}

export function selectSemanticDuplicateSubset(
  subset: SemanticBenchmarkSubset,
): readonly SemanticPair[] {
  return SEMANTIC_DUPLICATE_SUBSETS[subset];
}

export function parseSemanticBenchmarkSubset(
  args: string | undefined,
): SemanticBenchmarkSubset {
  const value = args?.trim() ?? '';
  if (value.length === 0) {
    return 'subsample';
  }
  if (value === 'subsample' || value === 'variance' || value === 'session') {
    return value;
  }
  throw new Error(
    'Expected the optional subset argument to be subsample, variance, or session.',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractResponseText(
  response: Awaited<
    ReturnType<ExtensionCommandContext['modelRegistry']['complete']>
  >,
): string {
  return response.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function parseClassificationResponse(
  response: Awaited<
    ReturnType<ExtensionCommandContext['modelRegistry']['complete']>
  >,
):
  | { readonly ok: true; readonly classification: SemanticClassification }
  | {
      readonly ok: false;
      readonly outcome: 'invalid-response' | 'invalid-output';
    } {
  const text = extractResponseText(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, outcome: 'invalid-response' };
  }
  if (!isRecord(parsed)) {
    return { ok: false, outcome: 'invalid-output' };
  }
  const keys = Object.keys(parsed).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== 'classification' ||
    keys[1] !== 'schemaVersion' ||
    parsed.schemaVersion !== 1 ||
    !isSemanticClassification(parsed.classification)
  ) {
    return { ok: false, outcome: 'invalid-output' };
  }
  return { ok: true, classification: parsed.classification };
}

async function classifyPair(
  pair: SemanticPair,
  ctx: ExtensionCommandContext,
): Promise<{
  readonly classification: SemanticClassification | null;
  readonly outcome: SemanticRunOutcome;
}> {
  if (ctx.model === undefined) {
    throw new Error('The semantic benchmark requires an active model.');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort('timeout');
  }, REQUEST_TIMEOUT_MS);
  try {
    const response = await ctx.modelRegistry.complete(
      ctx.model,
      {
        systemPrompt: SEMANTIC_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: ['Fact 1:', pair.left, '', 'Fact 2:', pair.right].join(
              '\n',
            ),
            timestamp: Date.now(),
          },
        ],
      },
      {
        signal: controller.signal,
        maxTokens: 128,
        reasoningEffort: getAuxiliaryReasoningEffort(ctx.model),
      },
    );
    const signalKind = signalFailureKind(controller.signal);
    if (signalKind !== undefined) {
      return { classification: null, outcome: signalKind };
    }
    const parsed = parseClassificationResponse(response);
    return parsed.ok
      ? { classification: parsed.classification, outcome: 'success' }
      : { classification: null, outcome: parsed.outcome };
  } catch {
    return {
      classification: null,
      outcome: signalFailureKind(controller.signal) ?? 'provider',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function emptyFailureCounts(): Record<SemanticFailureKind, number> {
  return {
    timeout: 0,
    aborted: 0,
    provider: 0,
    'invalid-response': 0,
    'invalid-output': 0,
  };
}

async function runSemanticBenchmark(
  ctx: ExtensionCommandContext,
  subset: SemanticBenchmarkSubset,
): Promise<void> {
  const resultsPath = process.env[SEMANTIC_RESULTS_PATH_ENV];
  if (resultsPath === undefined || resultsPath.length === 0) {
    throw new Error(
      'Set ' + SEMANTIC_RESULTS_PATH_ENV + ' to the JSON output path.',
    );
  }
  if (ctx.model === undefined) {
    throw new Error('The semantic benchmark requires an active model.');
  }

  const pairs = selectSemanticDuplicateSubset(subset);
  const iterations = subset === 'variance' ? 2 : 1;
  const records: SemanticPairRunRecord[] = [];
  const failureCounts = emptyFailureCounts();
  if (pairs.length === 0) {
    process.stderr.write(
      'The ' + subset + ' subset is empty; no model calls will be made.\n',
    );
  }

  for (let run = 1; run <= iterations; run += 1) {
    for (const pair of pairs) {
      const startedAt = Date.now();
      const result = await classifyPair(pair, ctx);
      const record: SemanticPairRunRecord = {
        pairId: pair.id,
        trueLabel: pair.label,
        classification: result.classification,
        outcome: result.outcome,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        run,
      };
      records.push(record);
      if (record.outcome !== 'success') {
        failureCounts[record.outcome] += 1;
      }
      process.stdout.write(JSON.stringify(record) + '\n');
    }
  }

  const artifact: SemanticBenchmarkArtifact = {
    schemaVersion: 1,
    subset,
    model: {
      id: ctx.model.id,
      provider: ctx.model.provider,
    },
    iterations,
    pairCount: pairs.length,
    records,
    failureCounts,
  };
  await writeFile(
    resultsPath,
    JSON.stringify(artifact, null, 2) + '\n',
    'utf8',
  );
}

export default function registerSemanticDuplicateBenchmarkExtension(
  pi: ExtensionAPI,
): void {
  pi.registerCommand('context-guard-semantic-benchmark', {
    description: 'Run the semantic duplicate model benchmark.',
    handler: async (args, ctx): Promise<void> => {
      const subset = parseSemanticBenchmarkSubset(args);
      await runSemanticBenchmark(ctx, subset);
    },
  });
}
