import {
  type OrderedScenario,
  type RecordedSemanticLabel,
} from './semantic-candidate-corpus.js';

export interface RecordedSemanticCandidateFact {
  readonly content: string;
  readonly toolNames: readonly string[];
}

/** Ten ordinary repository-investigation turns with automatic discovery enabled. */
export const RECORDED_SEMANTIC_CANDIDATE_FACTS: readonly RecordedSemanticCandidateFact[] = [
  {
    // Scrubbed absolute repository path from the recorded fixture.
    content: 'The repository root is the agent-primitives repository.',
    toolNames: ['bash'],
  },
  {
    content: 'The repository root contains package.json, pnpm-lock.yaml, pnpm-workspace.yaml, and README.md.',
    toolNames: ['bash'],
  },
  {
    content: 'The repository has packages named context-guard and context-guard-pi.',
    toolNames: ['bash'],
  },
  {
    content: 'Package manifests exist for examples/context-guard, packages/context-guard, and packages/context-guard-pi.',
    toolNames: ['bash'],
  },
  {
    content: 'The repository contains five TypeScript configuration files: three package-level configs and tsconfig.base.json.',
    toolNames: ['bash'],
  },
  {
    content: 'One shown TypeScript configuration extends ../../tsconfig.base.json, includes src and test, enables Node types, and sets noEmit to true.',
    toolNames: ['read'],
  },
  {
    content: 'One shown TypeScript build configuration extends ../../tsconfig.base.json, includes src, disables ambient types, and emits to dist with src as rootDir.',
    toolNames: ['read'],
  },
  {
    content: 'The repository is a pnpm workspace of small, composable agent primitives.',
    toolNames: ['read'],
  },
  {
    content: 'The repository has 15 test files total: 11 in context-guard-pi and 4 in context-guard.',
    toolNames: ['bash'],
  },
  {
    content: 'The TypeScript configuration enables strict mode, noUncheckedIndexedAccess, exactOptionalPropertyTypes, and noImplicitOverride.',
    toolNames: ['read'],
  },
  {
    content: 'The supplied evidence references the workflow file `.github/workflows/ci.yml`.',
    toolNames: ['bash'],
  },
  {
    content: 'The CI workflow runs on pushes to main and on pull requests.',
    toolNames: ['read'],
  },
  {
    content: 'The CI matrix tests Node.js 22.x and 24.x on ubuntu-latest.',
    toolNames: ['read'],
  },
  {
    content: 'The workflow runs pnpm build before pnpm typecheck and pnpm test.',
    toolNames: ['read'],
  },
  {
    content: 'On Node.js 24.x, the workflow additionally runs pnpm check:package and pnpm example.',
    toolNames: ['read'],
  },
  {
    content: 'On session_start, the extension increments the session epoch, aborts active requests, resets discovery and lifecycle state, and loads persisted state.',
    toolNames: ['read'],
  },
  {
    content: 'On session_before_compact, the extension captures a snapshot; on session_compact, it delegates handling to the lifecycle controller.',
    toolNames: ['read'],
  },
  {
    content: 'The code comments state that Pi 0.84.2 has no session_compact_failed event.',
    toolNames: ['read'],
  },
  {
    content: 'The listing includes candidate-corpus.ts (16 KB), candidate-evaluate.ts (8 KB), and corpus.ts (16 KB).',
    toolNames: ['bash'],
  },
  {
    content: 'The listing includes discovery-corpus.ts (16 KB), discovery-evaluate.ts (16 KB), discovery-prompts.ts (4 KB), and discovery-run.ts (8 KB).',
    toolNames: ['bash'],
  },
  {
    content: 'The listing includes evaluate.ts (20 KB), operational-candidate-corpus.ts (8 KB), operational-candidate-evaluate.ts (8 KB), prompts.ts (4 KB), and README.md (16 KB).',
    toolNames: ['bash'],
  },
  {
    content: 'The listing includes semantic-duplicate-corpus.ts (20 KB), semantic-duplicate-evaluate.ts (20 KB), semantic-duplicate-recorded.ts (8 KB), semantic-duplicate-run.ts (16 KB), verification-corpus.ts (16 KB), verification-evaluate.ts (12 KB), and verification-policies.ts (8 KB).',
    toolNames: ['bash'],
  },
  {
    content: 'The listing includes candidate-corpus.ts, candidate-evaluate.ts, corpus.ts, and discovery-corpus.ts.',
    toolNames: ['bash'],
  },
  {
    content: 'The listing includes discovery-evaluate.ts, discovery-prompts.ts, discovery-run.ts, and evaluate.ts.',
    toolNames: ['bash'],
  },
  {
    content: 'The listing includes operational-candidate-corpus.ts and operational-candidate-evaluate.ts.',
    toolNames: ['bash'],
  },
  {
    content: 'The listing includes prompts.ts, README.md, run.ts, semantic-duplicate-corpus.ts, semantic-duplicate-evaluate.ts, semantic-duplicate-recorded.ts, semantic-duplicate-run.ts, verification-corpus.ts, verification-evaluate.ts, and verification-policies.ts.',
    toolNames: ['bash'],
  },
  {
    content: 'SemanticLabel permits the values duplicate, same-subject-different, compatible-distinct, contradictory, unrelated, and ambiguous.',
    toolNames: ['read'],
  },
  {
    content: 'SemanticPair contains readonly id, language, left, right, label, and hardNegative fields; language is limited to en, ja, or mixed.',
    toolNames: ['read'],
  },
  {
    content: 'The corpus labels the pair stating that the project targets ES2023 and that the compiler target is ES2023 as a duplicate.',
    toolNames: ['read'],
  },
  {
    content: 'The corpus includes a Japanese duplicate pair about configuration being supplied only by explicit inputs.',
    toolNames: ['read'],
  },
  {
    content: 'The repository uses pnpm 10.34.5 and requires Node.js >=22.12.0.',
    toolNames: ['read'],
  },
  {
    content: 'The root package defines build, lint, typecheck, test, package-check, and example scripts.',
    toolNames: ['read'],
  },
  {
    content: 'The context-guard example depends on the workspace package @j1nn0/agent-context-guard.',
    toolNames: ['read'],
  },
  {
    content: 'Repository documentation says the example and Pi adapter resolve the context-guard package through its built dist, so the workspace must be built before those consumers run.',
    toolNames: ['read'],
  },
];

export const RECORDED_SEMANTIC_CANDIDATE_SCENARIO: OrderedScenario = {
  id: 'recorded-pi-investigation',
  language: 'en',
  category: 'recorded-session',
  discoveries: RECORDED_SEMANTIC_CANDIDATE_FACTS.map((fact, index) => ({
    id: `recorded-candidate-${index}`,
    content: fact.content,
    toolName: fact.toolNames[0] ?? '',
    status: 'active',
  })),
  duplicatePairs: [],
  duplicateGroups: [],
};

/**
 * Every one of these nine verdicts was `not_duplicate`, including the four
 * pairs a human reader would most want collapsed. Those four pairs are four
 * different partitions of one directory listing: each names a different set
 * of files, so none restates another. The classifier is right to refuse them.
 * The redundancy is repeated partitioned observation, which pairwise duplicate
 * detection does not address by design.
 */
export interface RecordedSemanticCandidateVerdict {
  readonly id: string;
  readonly group: string;
  readonly distance: number;
  readonly classification: RecordedSemanticLabel;
}

export const RECORDED_SEMANTIC_CANDIDATE_VERDICTS: readonly RecordedSemanticCandidateVerdict[] = [
  {
    id: 'live-18-22',
    group: 'repeated-partition-cluster',
    distance: 4,
    classification: 'not_duplicate',
  },
  {
    id: 'live-19-23',
    group: 'repeated-partition-cluster',
    distance: 4,
    classification: 'not_duplicate',
  },
  {
    id: 'live-20-24',
    group: 'repeated-partition-cluster',
    distance: 4,
    classification: 'not_duplicate',
  },
  {
    id: 'live-21-25',
    group: 'repeated-partition-cluster',
    distance: 4,
    classification: 'not_duplicate',
  },
  {
    id: 'live-5-9',
    group: 'plausible-overlap',
    distance: 4,
    classification: 'not_duplicate',
  },
  {
    id: 'live-0-1',
    group: 'plausible-overlap',
    distance: 1,
    classification: 'not_duplicate',
  },
  {
    id: 'live-2-12',
    group: 'controls-unrelated',
    distance: 10,
    classification: 'not_duplicate',
  },
  {
    id: 'live-7-30',
    group: 'controls-unrelated',
    distance: 23,
    classification: 'not_duplicate',
  },
  {
    id: 'live-11-31',
    group: 'controls-unrelated',
    distance: 20,
    classification: 'not_duplicate',
  },
];

export const RECORDED_SEMANTIC_CANDIDATE_DISCOVERIES =
  RECORDED_SEMANTIC_CANDIDATE_FACTS;
export const RECORDED_SEMANTIC_CANDIDATE_CLASSIFICATIONS =
  RECORDED_SEMANTIC_CANDIDATE_VERDICTS;
