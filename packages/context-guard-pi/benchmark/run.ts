import { writeFile } from 'node:fs/promises';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import {
  createExtractionPayload,
  EXTRACTION_TIMEOUT_MS,
  parseExtractionResponse,
} from '../dist/extraction.js';
import {
  BENCHMARK_CORPUS,
  type BenchmarkCase,
  type BenchmarkItem,
} from './corpus.js';
import {
  evaluateBenchmark,
  type BenchmarkOutcome,
  type ParsedExtractionOutput,
} from './evaluate.js';
import {
  getBenchmarkPrompt,
  parseBenchmarkPromptVariant,
  type BenchmarkPromptVariant,
} from './prompts.js';

const RESULTS_PATH_ENV = 'CONTEXT_GUARD_BENCHMARK_RESULTS_PATH';

interface CaseRecord {
  readonly caseId: string;
  readonly outcome: BenchmarkOutcome;
  readonly elapsedMs: number;
  readonly added: number;
  readonly retired: number;
}

function failureOutput(
  caseId: string,
  outcome: Exclude<BenchmarkOutcome, 'success'>,
): ParsedExtractionOutput {
  return {
    caseId,
    outcome,
    add: [],
    removeAutoItemIds: [],
  };
}

function signalFailureKind(
  signal: AbortSignal,
): 'timeout' | 'aborted' | undefined {
  if (!signal.aborted) {
    return undefined;
  }
  if (signal.reason === 'timeout') {
    return 'timeout';
  }
  if (signal.reason === 'aborted') {
    return 'aborted';
  }
  return undefined;
}

async function extractCase(
  testCase: BenchmarkCase,
  ctx: ExtensionCommandContext,
  promptVariant: BenchmarkPromptVariant,
): Promise<ParsedExtractionOutput> {
  if (ctx.model === undefined) {
    throw new Error('The benchmark requires an active model.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort('timeout');
  }, EXTRACTION_TIMEOUT_MS);

  try {
    const response = await ctx.modelRegistry.complete(
      ctx.model,
      {
        systemPrompt: getBenchmarkPrompt(promptVariant),
        messages: [
          {
            role: 'user',
            content: createExtractionPayload(
              testCase.message,
              testCase.existingAutomaticItems,
            ),
            timestamp: Date.now(),
          },
        ],
      },
      {
        signal: controller.signal,
        maxTokens: 1024,
      },
    );

    const signalKind = signalFailureKind(controller.signal);
    if (signalKind !== undefined) {
      return failureOutput(testCase.id, signalKind);
    }

    const parsed = parseExtractionResponse(
      response,
      testCase.message,
      testCase.existingAutomaticItems,
    );
    if (!parsed.ok) {
      return failureOutput(testCase.id, parsed.failureKind);
    }

    const add: BenchmarkItem[] = parsed.output.add.map((item) => ({
      content: item.content,
      kind: item.kind as BenchmarkItem['kind'],
      critical: item.critical,
    }));
    return {
      caseId: testCase.id,
      outcome: 'success',
      add,
      removeAutoItemIds: parsed.output.removeAutoItemIds,
    };
  } catch {
    return failureOutput(
      testCase.id,
      signalFailureKind(controller.signal) ?? 'provider',
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function runBenchmark(
  ctx: ExtensionCommandContext,
  promptVariant: BenchmarkPromptVariant,
): Promise<void> {
  const resultsPath = process.env[RESULTS_PATH_ENV];
  if (resultsPath === undefined || resultsPath.length === 0) {
    throw new Error(`Set ${RESULTS_PATH_ENV} to the JSON output path.`);
  }
  const activeModel = ctx.model;
  if (activeModel === undefined) {
    throw new Error('The benchmark requires an active model.');
  }

  const outputs: ParsedExtractionOutput[] = [];
  const records: CaseRecord[] = [];
  for (const testCase of BENCHMARK_CORPUS) {
    const startedAt = Date.now();
    const parsed = await extractCase(testCase, ctx, promptVariant);
    const record: CaseRecord = {
      caseId: parsed.caseId,
      outcome: parsed.outcome,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      added: parsed.add.length,
      retired: parsed.removeAutoItemIds.length,
    };
    outputs.push(parsed);
    records.push(record);
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }

  const evaluation = evaluateBenchmark(BENCHMARK_CORPUS, outputs);
  const results = {
    schemaVersion: 2,
    model: {
      id: activeModel.id,
      provider: activeModel.provider,
    },
    variant: promptVariant,
    qualityCaseCount: evaluation.qualityCaseCount,
    providerFailures: evaluation.providerFailures,
    strictItem: evaluation.strictItem,
    detection: evaluation.detection,
    spanRates: evaluation.spanRates,
    kindAccuracy: evaluation.kindAccuracy,
    kindConfusionMatrix: evaluation.kindConfusionMatrix,
    critical: evaluation.critical,
    criticalAccuracy: evaluation.criticalAccuracy,
    negativeRejection: evaluation.negativeRejection,
    retirements: evaluation.retirements,
    supersession: evaluation.supersession,
    falsePositiveCount: evaluation.falsePositives.length,
    falseNegativeCount: evaluation.falseNegatives.length,
    // Ids and kinds only: enough to name a miss in a report without copying
    // corpus text into the artifact.
    falsePositiveCases: evaluation.falsePositives.map(({ caseId, item }) => ({
      caseId,
      kind: item.kind,
    })),
    falseNegativeCases: evaluation.falseNegatives.map(({ caseId, item }) => ({
      caseId,
      kind: item.kind,
    })),
    cases: records,
  };
  await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
}

export default function registerBenchmarkExtension(pi: ExtensionAPI): void {
  pi.registerCommand('context-guard-benchmark', {
    description: 'Run the offline-scored context extraction benchmark.',
    handler: async (args, ctx): Promise<void> => {
      const promptVariant = parseBenchmarkPromptVariant(args);
      await runBenchmark(ctx, promptVariant);
    },
  });
}
