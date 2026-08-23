/**
 * Measurement-only replay data from one real Pi discovery-capture session.
 *
 * Provenance: a real Pi session against the synthetic fixture repository
 * `task-bridge`, with the production discovery prompt unchanged. The session
 * used model `openai-codex/gpt-5.6-luna`.
 *
 * Privacy: only accepted fact contents and per-turn local evidence indices are
 * retained. Provider tool-call identifiers, quotes, quote hashes, spans,
 * timestamps, URLs, and transcripts are deliberately not persisted here. The
 * fact contents derive from a synthetic fixture repository created for
 * measurement; the one fixture-directory basename is retained where it is
 * useful to explain the captured claim, but no absolute path is embedded.
 *
 * Observability: zero-add eligible turns are included because eligibility was
 * reconstructed from the session transcript. Persisted state alone cannot
 * show those turns, so omitting them would bias the offline capture summary.
 * This module does not call a provider or alter production behavior.
 */

import {
  capTailDrop,
  oneFactPerToolCallId,
  summarizeCapture,
  summarizeEvidenceMultiplicity,
  type CaptureSummary,
  type CapturedTurn,
  type EvidenceMultiplicitySummary,
  type RateSummary,
} from './discovery-granularity-evaluate.js';

export const RECORDED_LIVE_CAPTURE_TURNS: readonly CapturedTurn[] = [
  { turnIndex: 0, evidenceCount: 0, facts: [] },
  { turnIndex: 1, evidenceCount: 0, facts: [] },
  { turnIndex: 2, evidenceCount: 0, facts: [] },
  {
    turnIndex: 3,
    evidenceCount: 1,
    facts: [
      {
        content:
          'In project task-bridge@2.4.1, `pnpm test` failed because `vitest` was not found; the output also warned that `node_modules` was missing.',
        evidenceRefs: ['e1'],
      },
    ],
  },
  { turnIndex: 4, evidenceCount: 1, facts: [] },
  {
    turnIndex: 5,
    evidenceCount: 4,
    facts: [
      {
        content:
          "Attempts to read docs/architecture.md, README.md, examples/demo/run-demo.mjs, and packages/legacy-tools/README.md failed because Bun's postinstall script was not run.",
        evidenceRefs: ['e1', 'e2', 'e3', 'e4'],
      },
    ],
  },
  { turnIndex: 6, evidenceCount: 4, facts: [] },
  { turnIndex: 7, evidenceCount: 0, facts: [] },
  {
    turnIndex: 8,
    evidenceCount: 1,
    facts: [
      {
        content:
          'The project tree contains TypeScript sources under src/, a queue test under test/, package.json, tsconfig.json, and a GitHub Actions workflow at .github/workflows/ci.yml.',
        evidenceRefs: ['e1'],
      },
    ],
  },
  { turnIndex: 9, evidenceCount: 0, facts: [] },
  {
    turnIndex: 10,
    evidenceCount: 1,
    facts: [
      {
        content:
          'Running `node examples/demo/run-demo.mjs` failed with `ERR_MODULE_NOT_FOUND` because `ap-granularity-fixture-43750/src/index.js` could not be found.',
        evidenceRefs: ['e1'],
      },
      {
        content: 'The demo command exited with status 1.',
        evidenceRefs: ['e1'],
      },
    ],
  },
  {
    turnIndex: 11,
    evidenceCount: 1,
    facts: [
      {
        content:
          'In ap-granularity-fixture-43750, `pnpm install --frozen-lockfile` completed successfully with exit code 0.',
        evidenceRefs: ['e1'],
      },
      {
        content:
          'In ap-granularity-fixture-43750, `pnpm test` failed with exit code 1 because `vitest` was not found.',
        evidenceRefs: ['e1'],
      },
    ],
  },
  { turnIndex: 12, evidenceCount: 0, facts: [] },
  { turnIndex: 13, evidenceCount: 1, facts: [] },
  {
    turnIndex: 14,
    evidenceCount: 1,
    facts: [
      {
        content: 'Git status reports pnpm-lock.yaml as an untracked file.',
        evidenceRefs: ['e1'],
      },
    ],
  },
  { turnIndex: 15, evidenceCount: 0, facts: [] },
  { turnIndex: 16, evidenceCount: 0, facts: [] },
  { turnIndex: 17, evidenceCount: 0, facts: [] },
];

type RecordedLifecycleStatus = 'active' | 'superseded' | 'retired';

const RECORDED_LIVE_FINAL_LIFECYCLE_STATUSES: readonly RecordedLifecycleStatus[] = [
  'active',
  'active',
  'active',
  'active',
  'superseded',
  'active',
  'active',
  'retired',
];

export interface RecordedLiveSessionMetadata {
  readonly source: string;
  readonly modelId: string;
  readonly schemaVersion: 1;
  readonly finalLifecycleCounts: Readonly<{
    readonly active: number;
    readonly superseded: number;
    readonly retired: number;
  }>;
  readonly eligibleTurns: number;
  readonly producingTurns: number;
}

function countLifecycleStatuses(
  statuses: readonly RecordedLifecycleStatus[],
): RecordedLiveSessionMetadata['finalLifecycleCounts'] {
  const counts = { active: 0, superseded: 0, retired: 0 };
  for (const status of statuses) {
    counts[status] += 1;
  }
  return counts;
}

export const RECORDED_LIVE_SESSION_METADATA: RecordedLiveSessionMetadata = {
  source:
    'Real Pi session against the synthetic fixture repository task-bridge; production discovery prompt unchanged.',
  modelId: 'openai-codex/gpt-5.6-luna',
  schemaVersion: 1,
  finalLifecycleCounts: countLifecycleStatuses(
    RECORDED_LIVE_FINAL_LIFECYCLE_STATUSES,
  ),
  eligibleTurns: RECORDED_LIVE_CAPTURE_TURNS.filter(
    ({ evidenceCount }) => evidenceCount > 0,
  ).length,
  producingTurns: RECORDED_LIVE_CAPTURE_TURNS.filter(
    ({ facts }) => facts.length > 0,
  ).length,
};

export interface RecordedLiveHypothesisSummary {
  readonly survivingFactCount: number;
  readonly reductionFromBaseline: RateSummary;
}

export interface RecordedLiveSummary {
  readonly capture: CaptureSummary;
  readonly multiplicity: EvidenceMultiplicitySummary;
  readonly hypotheses: Readonly<{
    readonly capTailDrop: Readonly<
      Record<1 | 2 | 3 | 4, RecordedLiveHypothesisSummary>
    >;
    readonly oneFactPerToolCallId: RecordedLiveHypothesisSummary;
  }>;
  readonly claimRecall: Readonly<{
    readonly applicable: false;
    readonly reason: string;
  }>;
}

function reductionFromBaseline(
  baseline: number,
  survivingFactCount: number,
): RateSummary {
  const numerator = baseline - survivingFactCount;
  return {
    numerator,
    denominator: baseline,
    rate: baseline === 0 ? 1 : numerator / baseline,
  };
}

function summarizeHypothesis(
  baseline: number,
  survivingFactCount: number,
): RecordedLiveHypothesisSummary {
  return {
    survivingFactCount,
    reductionFromBaseline: reductionFromBaseline(baseline, survivingFactCount),
  };
}

/**
 * Summarize the scrubbed real-session replay without making a provider call.
 *
 * `claimRecall` is explicitly marked not applicable: this recording has no
 * evaluation-only expected-claim labels, so no recall rate is fabricated for
 * the real session. The cap simulation remains capture-order-only, and its
 * ordering and atomic-response caveats are documented by the evaluator.
 */
export function recordedLiveSummary(): RecordedLiveSummary {
  const baseline = summarizeCapture(RECORDED_LIVE_CAPTURE_TURNS).totalFacts;
  return {
    capture: summarizeCapture(RECORDED_LIVE_CAPTURE_TURNS),
    multiplicity: summarizeEvidenceMultiplicity(RECORDED_LIVE_CAPTURE_TURNS),
    hypotheses: {
      capTailDrop: {
        1: summarizeHypothesis(
          baseline,
          capTailDrop(RECORDED_LIVE_CAPTURE_TURNS, 1).facts.length,
        ),
        2: summarizeHypothesis(
          baseline,
          capTailDrop(RECORDED_LIVE_CAPTURE_TURNS, 2).facts.length,
        ),
        3: summarizeHypothesis(
          baseline,
          capTailDrop(RECORDED_LIVE_CAPTURE_TURNS, 3).facts.length,
        ),
        4: summarizeHypothesis(
          baseline,
          capTailDrop(RECORDED_LIVE_CAPTURE_TURNS, 4).facts.length,
        ),
      },
      oneFactPerToolCallId: summarizeHypothesis(
        baseline,
        oneFactPerToolCallId(RECORDED_LIVE_CAPTURE_TURNS).facts.length,
      ),
    },
    claimRecall: {
      applicable: false,
      reason:
        'Not applicable: the real-session recording has no ground-truth expected claims.',
    },
  };
}
