import { writeFile } from 'node:fs/promises';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import {
  createDiscoveryPayload,
  parseDiscoveryResponse,
} from '../dist/discovery.js';
import { REQUEST_TIMEOUT_MS, signalFailureKind } from '../src/request.js';
import type { DiscoveryEvidence } from '../src/discovery.js';
import {
  DISCOVERY_BENCHMARK_CORPUS,
  type DiscoveryBenchmarkCase,
} from './discovery-corpus.js';
import {
  evaluateDiscoveryBenchmark,
  type DiscoveryBenchmarkOutcome,
  type ParsedDiscoveryOutput,
} from './discovery-evaluate.js';
import {
  getDiscoveryPrompt,
  parseDiscoveryPromptVariant,
  type DiscoveryPromptVariant,
} from './discovery-prompts.js';

const RESULTS_PATH_ENV = 'CONTEXT_GUARD_DISCOVERY_BENCHMARK_RESULTS_PATH';

/**
 * Reasoning level used for every benchmark request. Kept well inside
 * REQUEST_TIMEOUT_MS so a slow reasoning phase cannot turn a quality
 * measurement into a timeout measurement.
 */
const BENCHMARK_REASONING_EFFORT = 'medium';

interface CaseRecord {
  readonly caseId: string;
  readonly category: DiscoveryBenchmarkCase['category'];
  readonly outcome: DiscoveryBenchmarkOutcome;
  readonly elapsedMs: number;
  readonly factCount: number;
  readonly facts: readonly {
    readonly content: string;
    readonly evidenceIds: readonly string[];
    readonly evidenceNative: boolean;
    readonly anchored: boolean;
    readonly forbidden: boolean;
    readonly outOfScopeReference: boolean;
  }[];
}

function failureOutput(
  caseId: string,
  outcome: Exclude<DiscoveryBenchmarkOutcome, 'success'>,
): ParsedDiscoveryOutput {
  return {
    caseId,
    outcome,
    facts: [],
  };
}

function buildEvidence(testCase: DiscoveryBenchmarkCase): DiscoveryEvidence[] {
  return testCase.evidence.map((record, index) => ({
    id: `e${index + 1}`,
    toolCallId: `${testCase.id}-${index + 1}`,
    toolName: record.toolName,
    text: record.text,
  }));
}

async function discoverCase(
  testCase: DiscoveryBenchmarkCase,
  ctx: ExtensionCommandContext,
  promptVariant: DiscoveryPromptVariant,
): Promise<ParsedDiscoveryOutput> {
  if (ctx.model === undefined) {
    throw new Error('The benchmark requires an active model.');
  }

  const evidence = buildEvidence(testCase);
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort('timeout');
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await ctx.modelRegistry.complete(
      ctx.model,
      {
        systemPrompt: getDiscoveryPrompt(promptVariant),
        messages: [
          {
            role: 'user',
            content: createDiscoveryPayload(evidence),
            timestamp: Date.now(),
          },
        ],
      },
      {
        signal: controller.signal,
        maxTokens: 1024,
        // Production omits reasoningEffort, but pi-ai then sends the model's
        // thinkingLevelMap.off value, which some providers reject outright. A
        // request that never reaches the model measures nothing, so the runner
        // pins one valid level. Every variant uses the same level, so the
        // comparison between representations stays controlled.
        reasoningEffort: BENCHMARK_REASONING_EFFORT,
      },
    );

    const signalKind = signalFailureKind(controller.signal);
    if (signalKind !== undefined) {
      return failureOutput(testCase.id, signalKind);
    }

    const parsed = parseDiscoveryResponse(response, evidence);
    if (!parsed.ok) {
      return failureOutput(testCase.id, parsed.failureKind);
    }

    return {
      caseId: testCase.id,
      outcome: 'success',
      facts: parsed.output.discoveries.map((fact) => ({
        content: fact.content,
        evidenceIds: fact.evidence.map((reference) => reference.id),
      })),
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
  promptVariant: DiscoveryPromptVariant,
): Promise<void> {
  const resultsPath = process.env[RESULTS_PATH_ENV];
  if (resultsPath === undefined || resultsPath.length === 0) {
    throw new Error(`Set ${RESULTS_PATH_ENV} to the JSON output path.`);
  }
  const activeModel = ctx.model;
  if (activeModel === undefined) {
    throw new Error('The benchmark requires an active model.');
  }

  const outputs: ParsedDiscoveryOutput[] = [];
  const records: CaseRecord[] = [];
  for (const testCase of DISCOVERY_BENCHMARK_CORPUS) {
    const startedAt = Date.now();
    const parsed = await discoverCase(testCase, ctx, promptVariant);
    const evaluation = evaluateDiscoveryBenchmark([testCase], [parsed]);
    const diagnostic = evaluation.diagnostics[0];
    const facts =
      diagnostic?.facts.map((fact, index) => ({
        ...fact,
        evidenceIds: parsed.facts[index]?.evidenceIds ?? [],
      })) ?? [];
    const record: CaseRecord = {
      caseId: parsed.caseId,
      category: testCase.category,
      outcome: parsed.outcome,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      factCount: parsed.facts.length,
      facts,
    };
    outputs.push(parsed);
    records.push(record);
    process.stdout.write(
      `${JSON.stringify({
        caseId: record.caseId,
        category: record.category,
        outcome: record.outcome,
        elapsedMs: record.elapsedMs,
        factCount: record.factCount,
      })}\n`,
    );
  }

  const evaluation = evaluateDiscoveryBenchmark(
    DISCOVERY_BENCHMARK_CORPUS,
    outputs,
  );
  const results = {
    schemaVersion: 1,
    model: {
      id: activeModel.id,
      provider: activeModel.provider,
    },
    variant: promptVariant,
    totalCases: evaluation.totalCases,
    qualityCaseCount: evaluation.qualityCaseCount,
    providerFailures: evaluation.providerFailures,
    capture: evaluation.capture,
    expectedFactCapture: evaluation.expectedFactCapture,
    anchorCoverage: evaluation.anchorCoverage,
    negativeRejection: evaluation.negativeRejection,
    unsupportedCaptureCount: evaluation.unsupportedCaptureCount,
    unsupportedCaptureReasons: evaluation.unsupportedCaptureReasons,
    evidenceNativeRate: evaluation.evidenceNativeRate,
    synthesisRate: evaluation.synthesisRate,
    structuralGateCapture: evaluation.structuralGateCapture,
    duplicateAmplification: evaluation.duplicateAmplification,
    sameContentRate: evaluation.sameContentRate,
    multiEvidenceUsefulness: evaluation.multiEvidenceUsefulness,
    secretSentinelCount: evaluation.secretSentinelCount,
    cases: records,
  };
  await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
}

export default function registerDiscoveryBenchmarkExtension(
  pi: ExtensionAPI,
): void {
  pi.registerCommand('context-guard-discovery-benchmark', {
    description: 'Run the offline-scored context discovery benchmark.',
    handler: async (args, ctx): Promise<void> => {
      const promptVariant = parseDiscoveryPromptVariant(args);
      await runBenchmark(ctx, promptVariant);
    },
  });
}
