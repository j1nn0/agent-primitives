/**
 * Privacy-scrubbed operational discovery-session fixtures for offline research.
 *
 * The recording boundary permits repository-safe fact content, local per-turn
 * `eN` evidence references, turn indexes, counts, and tool category names if
 * they are added to a future fixture. It excludes raw transcripts, provider
 * responses, credentials, absolute home paths, and unrelated private content.
 * For the embedded operational session, every occurrence of the repository
 * prefix `/home/j1nn0/repos/j1nn0.github/agent-primitives` was replaced with
 * `.`, and every other `/home/j1nn0/...` prefix was replaced with `~`. The
 * non-sensitive observations `HERDR_ENV=1` and `HERDR_TAB_ID=w11:t5` remain
 * verbatim because they describe the measured environment rather than a
 * credential or private value.
 *
 * This module imports existing recorded fixtures instead of copying them and
 * performs no provider calls. It is measurement-only and does not change
 * production lifecycle, persistence, or discovery behavior.
 */

import {
  RECORDED_LIVE_CAPTURE_TURNS,
  RECORDED_LIVE_SESSION_METADATA,
} from './discovery-granularity-recorded.js';
import type { CapturedTurn } from './discovery-granularity-evaluate.js';
import { OPERATIONAL_DATASETS } from './operational-candidate-corpus.js';
import { RECORDED_SEMANTIC_CANDIDATE_FACTS } from './semantic-candidate-recorded.js';

export interface OperationalLifecycleTransitions {
  readonly natural: {
    readonly retire: number;
    readonly supersede: number;
  };
  readonly experimental: {
    readonly retire: number;
    readonly supersede: number;
  };
  readonly unknown: {
    readonly retire: number;
    readonly supersede: number;
  };
}

export interface OperationalSessionQuality {
  readonly isRealPi: boolean;
  readonly isSynthetic: boolean;
  readonly hasTurnMetadata: boolean;
  readonly hasEvidenceMetadata: boolean;
}

export interface OperationalLifecycleCounts {
  readonly active: number;
  readonly superseded: number;
  readonly retired: number;
}

export interface OperationalSessionRecord {
  readonly sessionId: string;
  readonly source: string;
  readonly modelId?: string;
  readonly capturedTurns?: readonly CapturedTurn[];
  readonly factContents?: readonly string[];
  readonly quality: OperationalSessionQuality;
  readonly finalLifecycleCounts?: OperationalLifecycleCounts;
  readonly statusUnknownCount: number;
  readonly transitions?: OperationalLifecycleTransitions;
  readonly transitionNotes?: readonly string[];
}

const UNKNOWN_TRANSITIONS: OperationalLifecycleTransitions = {
  natural: { retire: 0, supersede: 0 },
  experimental: { retire: 0, supersede: 0 },
  unknown: { retire: 1, supersede: 1 },
};

const EXPERIMENTAL_TRANSITIONS: OperationalLifecycleTransitions = {
  natural: { retire: 0, supersede: 0 },
  experimental: { retire: 1, supersede: 1 },
  unknown: { retire: 0, supersede: 0 },
};

function factContentsForDataset(datasetId: string): readonly string[] {
  const dataset = OPERATIONAL_DATASETS.find(({ id }) => id === datasetId);
  if (dataset === undefined) {
    throw new Error(`Missing operational dataset: ${datasetId}`);
  }
  return dataset.facts.map(({ content }) => content);
}

const OPERATIONAL_LIVE_02_CAPTURE_TURNS: readonly CapturedTurn[] = [
  {
    turnIndex: 0,
    evidenceCount: 1,
    facts: [
      {
        content:
          'The context-mode file tool blocked access to ~/.pi/agent/skills/agent-orchestration/SKILL.md because it resolves outside the project root ..',
        evidenceRefs: ['e1'],
      },
      {
        content:
          'The tool documentation says an explicit host Read allow rule can permit processing a file outside the project.',
        evidenceRefs: ['e1'],
      },
    ],
  },
  { turnIndex: 1, evidenceCount: 0, facts: [] },
  {
    turnIndex: 2,
    evidenceCount: 1,
    facts: [
      {
        content:
          'The environment variable HERDR_ENV is set to 1, and HERDR_TAB_ID is set to w11:t5.',
        evidenceRefs: ['e1'],
      },
    ],
  },
  { turnIndex: 3, evidenceCount: 0, facts: [] },
  {
    turnIndex: 4,
    evidenceCount: 1,
    facts: [
      {
        content: 'The focused pi agent is working in ..',
        evidenceRefs: ['e1'],
      },
      {
        content: 'The explorer agent is idle and interactive-ready in ..',
        evidenceRefs: ['e1'],
      },
      {
        content: 'The fixer agent is idle and interactive-ready in ..',
        evidenceRefs: ['e1'],
      },
      {
        content: 'The live-study agent is working in ..',
        evidenceRefs: ['e1'],
      },
    ],
  },
  { turnIndex: 5, evidenceCount: 0, facts: [] },
  { turnIndex: 6, evidenceCount: 0, facts: [] },
  { turnIndex: 7, evidenceCount: 0, facts: [] },
  {
    turnIndex: 8,
    evidenceCount: 1,
    facts: [
      {
        content:
          'The shell script failed before reporting the pnpm test result because `status` is a read-only variable.',
        evidenceRefs: ['e1'],
      },
    ],
  },
  {
    turnIndex: 9,
    evidenceCount: 1,
    facts: [
      {
        content:
          'The repository-wide `pnpm test` command exited successfully with status 0.',
        evidenceRefs: ['e1'],
      },
      {
        content:
          '`pnpm test` runs `pnpm -r run test` across 3 of 4 workspace projects.',
        evidenceRefs: ['e1'],
      },
      {
        content:
          'The `packages/context-guard` test suite passed 30 tests across 4 test files.',
        evidenceRefs: ['e1'],
      },
      {
        content:
          'The `packages/context-guard-pi` test suite passed 256 tests across 14 test files.',
        evidenceRefs: ['e1'],
      },
    ],
  },
  { turnIndex: 10, evidenceCount: 0, facts: [] },
  { turnIndex: 11, evidenceCount: 0, facts: [] },
  { turnIndex: 12, evidenceCount: 0, facts: [] },
  { turnIndex: 13, evidenceCount: 1, facts: [] },
  {
    turnIndex: 14,
    evidenceCount: 1,
    facts: [
      {
        content:
          'The packages/context-guard test suite contains prompts.test.ts with a “benchmark prompt variants” describe block.',
        evidenceRefs: ['e1'],
      },
      {
        content:
          'The packages/context-guard test suite contains discovery-prompts.test.ts with a “discovery benchmark prompt variants” describe block.',
        evidenceRefs: ['e1'],
      },
      {
        content:
          'The packages/context-guard test suite contains semantic-duplicate.test.ts with a test asserting required semantic duplicate corpus integrity.',
        evidenceRefs: ['e1'],
      },
      {
        content:
          'The supplied Python indexing operation indexed 9 sections from execute:python into the knowledge base.',
        evidenceRefs: ['e1'],
      },
    ],
  },
  {
    turnIndex: 15,
    evidenceCount: 1,
    facts: [
      {
        content:
          'The packages/context-guard test suite contains four files with 30 test cases total: guard.test.ts (5), literal-verifier.test.ts (6), privacy.test.ts (3), and verify.test.ts (16).',
        evidenceRefs: ['e1'],
      },
      {
        content:
          'The packages/context-guard-pi test suite includes extension.test.ts with 59 test cases covering commands, persistence, compaction lifecycle, verification, recovery, privacy, automatic extraction, and agent discovery capture.',
        evidenceRefs: ['e1'],
      },
    ],
  },
  {
    turnIndex: 16,
    evidenceCount: 1,
    facts: [
      {
        content:
          'The context search returned no results for the queried benchmark, discovery, verification, granularity, registry-growth, semantic-candidate, semantic-duplicate, and operational-candidate terms.',
        evidenceRefs: ['e1'],
      },
    ],
  },
  { turnIndex: 17, evidenceCount: 0, facts: [] },
  {
    turnIndex: 18,
    evidenceCount: 1,
    facts: [
      {
        content:
          'The benchmark is an offline, synthetic measurement harness for testing discovery.',
        evidenceRefs: ['e1'],
      },
      {
        content:
          'For located half-open spans `[start, end)`, the evaluator reports an `exact` metric.',
        evidenceRefs: ['e1'],
      },
      {
        content:
          'The `strictItem` metric requires both kind and content to match.',
        evidenceRefs: ['e1'],
      },
    ],
  },
  {
    turnIndex: 19,
    evidenceCount: 1,
    facts: [
      {
        content:
          'The metadata script scans TypeScript files in packages/context-guard-pi/benchmark.',
        evidenceRefs: ['e1'],
      },
      {
        content:
          'The script removes blank lines and retains at most the first two comment lines from each file.',
        evidenceRefs: ['e1'],
      },
      {
        content:
          'semantic-candidate-recorded.ts exports RecordedSemanticCandidateFact and RECORDED_SEMANTIC_CANDIDATE_FACTS.',
        evidenceRefs: ['e1'],
      },
    ],
  },
  {
    turnIndex: 20,
    evidenceCount: 1,
    facts: [
      {
        content:
          'The benchmark TypeScript files are located under `packages/context-guard-pi/benchmark`.',
        evidenceRefs: ['e1'],
      },
      {
        content:
          '`candidate-corpus.ts` exports `CandidateCaseCategory`, `CandidateBenchmarkCase`, and `CANDIDATE_BENCHMARK_CORPUS`.',
        evidenceRefs: ['e1'],
      },
      {
        content:
          '`discovery-corpus.ts` exports `DiscoveryBenchmarkEvidence`, `DiscoveryBenchmarkCategory`, `DiscoveryBenchmarkCase`, and `SECRET_SENTINELS`.',
        evidenceRefs: ['e1'],
      },
      {
        content:
          '`verification-corpus.ts` exports `BenchmarkToolResult`, `VerificationCategory`, `VerificationBenchmarkCase`, and `VERIFICATION_BENCHMARK_CORPUS`.',
        evidenceRefs: ['e1'],
      },
    ],
  },
  { turnIndex: 21, evidenceCount: 0, facts: [] },
  {
    turnIndex: 22,
    evidenceCount: 1,
    facts: [
      { content: 'The command output was "main".', evidenceRefs: ['e1'] },
    ],
  },
  { turnIndex: 23, evidenceCount: 0, facts: [] },
  {
    turnIndex: 24,
    evidenceCount: 1,
    facts: [
      { content: 'The command output is "main".', evidenceRefs: ['e1'] },
    ],
  },
  {
    turnIndex: 25,
    evidenceCount: 1,
    facts: [
      {
        content:
          'The benchmark scan targets TypeScript files under `packages/context-guard-pi/benchmark`.',
        evidenceRefs: ['e1'],
      },
      {
        content:
          'The scan output includes benchmark sections named `operational-candidate-evaluate.ts`, `corpus.ts`, `discovery-prompts.ts`, `registry-growth-evaluate.ts`, and `verification-evaluate.ts`.',
        evidenceRefs: ['e1'],
      },
      {
        content:
          'The execute:python result indexed 14 sections into the knowledge base.',
        evidenceRefs: ['e1'],
      },
      {
        content:
          'Five indexed sections matched the query for benchmark-family purpose clues from source declarations and comments.',
        evidenceRefs: ['e1'],
      },
    ],
  },
  {
    turnIndex: 26,
    evidenceCount: 1,
    facts: [
      {
        content:
          'packages/context-guard-pi/benchmark/README.md documents benchmarks for span targets, reported metrics, discovery representation, discovery verification policy, discovery granularity, and registry growth.',
        evidenceRefs: ['e1'],
      },
    ],
  },
  { turnIndex: 27, evidenceCount: 1, facts: [] },
  { turnIndex: 28, evidenceCount: 1, facts: [] },
  {
    turnIndex: 29,
    evidenceCount: 1,
    facts: [
      {
        content:
          'The discovery-candidates test file covers anchor extraction for paths, opaque IDs, versioned subjects, punctuation, Japanese text adjacency, templated routes, and absolute paths.',
        evidenceRefs: ['e1'],
      },
      {
        content:
          'The test suite covers grouping items by shared paths or opaque IDs and checks deterministic results under shuffled input.',
        evidenceRefs: ['e1'],
      },
      {
        content:
          'The discovery candidates command tests exclusion of retired, superseded, manual, removed, and extracted automatic items.',
        evidenceRefs: ['e1'],
      },
      {
        content:
          'The command test suite checks that output is bounded to ten groups and reports the total.',
        evidenceRefs: ['e1'],
      },
    ],
  },
  {
    turnIndex: 30,
    evidenceCount: 1,
    facts: [
      {
        content:
          'The file packages/context-guard-pi/test/verification-policies.test.ts contains a test named "classifies the five evidence outcomes with production resolution".',
        evidenceRefs: ['e1'],
      },
      {
        content:
          'The file contains a test named "uses worst-first precedence for multiple evidence references".',
        evidenceRefs: ['e1'],
      },
      {
        content:
          'The file contains a test named "resolves a quote containing a surrogate pair and rejects an off-by-one span".',
        evidenceRefs: ['e1'],
      },
      {
        content:
          'The file contains a test named "evaluates deterministically and reports every requested metric".',
        evidenceRefs: ['e1'],
      },
    ],
  },
  { turnIndex: 31, evidenceCount: 1, facts: [] },
  {
    turnIndex: 32,
    evidenceCount: 1,
    facts: [
      {
        content:
          'On session_start, the extension increments the session epoch, aborts active requests, resets discovery and lifecycle state, and loads persisted state.',
        evidenceRefs: ['e1'],
      },
      {
        content:
          'On session_shutdown, the extension increments the session epoch, aborts active requests, and resets discovery and lifecycle state.',
        evidenceRefs: ['e1'],
      },
      {
        content:
          'Before compaction, the extension captures a snapshot; on compaction, it delegates handling to the lifecycle controller.',
        evidenceRefs: ['e1'],
      },
      {
        content:
          'At turn start the extension begins discovery, tool results are passed to discovery handling, and turn end is handled asynchronously by discovery.',
        evidenceRefs: ['e1'],
      },
    ],
  },
  {
    turnIndex: 33,
    evidenceCount: 1,
    facts: [
      {
        content: 'The state custom-entry type is `agent-context-guard-state`.',
        evidenceRefs: ['e1'],
      },
      {
        content: '`loadState` identifies the latest matching custom state entry.',
        evidenceRefs: ['e1'],
      },
      {
        content: '`saveState` writes state with schema version 5.',
        evidenceRefs: ['e1'],
      },
      {
        content: 'After saving, the state’s `degraded` flag is set to false.',
        evidenceRefs: ['e1'],
      },
    ],
  },
  { turnIndex: 34, evidenceCount: 0, facts: [] },
];

/**
 * Four sessions intentionally preserve different observability levels. A
 * missing lifecycle record is not converted into a zero-valued lifecycle.
 */
export const OPERATIONAL_SESSION_RECORDS: readonly OperationalSessionRecord[] = [
  {
    sessionId: 'granularity-live-01',
    source: RECORDED_LIVE_SESSION_METADATA.source,
    modelId: RECORDED_LIVE_SESSION_METADATA.modelId,
    capturedTurns: RECORDED_LIVE_CAPTURE_TURNS,
    quality: {
      isRealPi: true,
      isSynthetic: false,
      hasTurnMetadata: true,
      hasEvidenceMetadata: true,
    },
    finalLifecycleCounts: RECORDED_LIVE_SESSION_METADATA.finalLifecycleCounts,
    statusUnknownCount: 0,
    transitions: UNKNOWN_TRANSITIONS,
    transitionNotes: ['Lifecycle causes were not recorded at capture time.'],
  },
  {
    sessionId: 'operational-live-02',
    source:
      'Real Pi session against the agent-primitives repository with the production discovery prompt unchanged; lifecycle commands ran after capture.',
    modelId: 'openai-codex/gpt-5.6-luna',
    capturedTurns: OPERATIONAL_LIVE_02_CAPTURE_TURNS,
    quality: {
      isRealPi: true,
      isSynthetic: false,
      hasTurnMetadata: true,
      hasEvidenceMetadata: true,
    },
    finalLifecycleCounts: { active: 50, superseded: 1, retired: 1 },
    statusUnknownCount: 0,
    transitions: EXPERIMENTAL_TRANSITIONS,
    transitionNotes: [
      'orchestrator command after session end; near-duplicate pair both stating git branch main',
      'orchestrator command after session end; transient agent-status observation no longer true',
    ],
  },
  {
    sessionId: 'operational-candidate-01',
    source:
      'Fact-level contents imported from the real-session operational candidate dataset; turn and lifecycle metadata were not observed.',
    factContents: factContentsForDataset('session'),
    quality: {
      isRealPi: true,
      isSynthetic: false,
      hasTurnMetadata: false,
      hasEvidenceMetadata: false,
    },
    statusUnknownCount: factContentsForDataset('session').length,
  },
  {
    sessionId: 'semantic-candidate-01',
    source:
      'Fact-level contents imported from a real Pi semantic-candidate recording; lifecycle status was not observed and fixture statuses are ignored.',
    factContents: RECORDED_SEMANTIC_CANDIDATE_FACTS.map(({ content }) => content),
    quality: {
      isRealPi: true,
      isSynthetic: false,
      hasTurnMetadata: false,
      hasEvidenceMetadata: false,
    },
    statusUnknownCount: RECORDED_SEMANTIC_CANDIDATE_FACTS.length,
  },
];
