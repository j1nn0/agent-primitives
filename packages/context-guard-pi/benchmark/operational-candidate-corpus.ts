import type { CandidateItem } from '../src/discovery-candidates.js';

/**
 * Operational datasets for the supersession candidate command.
 *
 * The synthetic candidate corpus was written alongside the extractor, so it can
 * only show that the extractor satisfies its own author. These datasets exist to
 * answer a different question: how often does the command fire on discovery
 * content nobody shaped for it, and is what it produces worth reading.
 *
 * None of these fixtures is a training set. `independent` predates the feature,
 * `session` was captured from a real Pi run, and `adversarial` was built to make
 * the extractor fail rather than succeed.
 */
export type OperationalDatasetKind =
  | 'independent'
  | 'session'
  | 'adversarial';

export interface OperationalDataset {
  readonly id: string;
  readonly kind: OperationalDatasetKind;
  /** Where the contents came from, so a reader can judge their independence. */
  readonly provenance: string;
  readonly facts: readonly CandidateItem[];
}

/**
 * Discovery contents captured from a real Pi session: nine turns of ordinary
 * repository investigation with automatic discovery enabled, using the
 * unmodified production discovery prompt. No fact was requested, seeded, or
 * reworded to carry an anchor, and nothing here is secret — every statement is
 * about this public repository's own layout and tooling.
 */
const SESSION_FACTS: readonly CandidateItem[] = [
  {
    id: 'session-01',
    content:
      'The repository contains top-level package.json, pnpm-lock.yaml, and pnpm-workspace.yaml files, plus examples, packages, and node_modules directories.',
  },
  {
    id: 'session-02',
    content: 'The workspace includes packages/* and examples/* directories.',
  },
  {
    id: 'session-03',
    content:
      'The root package is named agent-primitives, version 0.1.0, and is private.',
  },
  {
    id: 'session-04',
    content: 'The project requires Node.js >=22.12.0 and uses pnpm@10.34.5.',
  },
  {
    id: 'session-05',
    content:
      'The root scripts include recursive build, typecheck, test, and package-check commands, plus an example command for examples/context-guard/basic.ts.',
  },
  {
    id: 'session-06',
    content:
      'The repository root includes eslint.config.js, AGENTS.md, CLAUDE.md, and package.json.',
  },
  {
    id: 'session-07',
    content:
      'The ESLint configuration ignores dist, node_modules, and coverage directories at any depth.',
  },
  {
    id: 'session-08',
    content:
      'The ESLint configuration uses eslint.configs.recommended and the recommended typescript-eslint configuration.',
  },
  {
    id: 'session-09',
    content:
      'The extension increments sessionEpoch, aborts active requests, and resets discovery and lifecycle state.',
  },
  {
    id: 'session-10',
    content:
      'The extension captures a lifecycle snapshot before compaction and handles it when session_compact occurs.',
  },
  {
    id: 'session-11',
    content:
      'The extension begins discovery turns on turn_start and processes tool results on tool_result.',
  },
  {
    id: 'session-12',
    content:
      'The code comments that Pi 0.84.2 has no session_compact_failed event and uses structural invariants instead.',
  },
  {
    id: 'session-13',
    content:
      'The @j1nn0/agent-context-guard-pi@0.1.0 test suite passed: 10 test files and 209 tests passed under Vitest.',
  },
  {
    id: 'session-14',
    content:
      'The compiler configuration enables strict type checking and unchecked-index safeguards.',
  },
  {
    id: 'session-15',
    content:
      'The compiler targets ES2023 and uses NodeNext module and module-resolution settings.',
  },
  {
    id: 'session-16',
    content:
      'The compiler emits declaration files, declaration maps, and source maps.',
  },
  {
    id: 'session-17',
    content: 'The repository contains the file `.github/workflows/ci.yml`.',
  },
];

/**
 * Shapes that plausibly co-occur in one real session and could collide by
 * accident: routes beside filesystem paths, error codes beside build ids, one
 * version number attached to different subjects, and the same identifier in
 * Japanese prose. Built to produce false candidates, not to avoid them.
 */
const ADVERSARIAL_FACTS: readonly CandidateItem[] = [
  {
    id: 'adv-01',
    content:
      'The users endpoint /api/users returns 200 for authenticated callers.',
  },
  {
    id: 'adv-02',
    content:
      'The settings endpoint /api/users/settings returns 404 when the flag is off.',
  },
  {
    id: 'adv-03',
    content:
      'The SSO route /apps/{app_id}/sso redirects to the identity provider.',
  },
  {
    id: 'adv-04',
    content: 'The admin route /admin/{org_id}/sso is gated by a feature flag.',
  },
  {
    id: 'adv-05',
    content: 'The primary database file is /var/lib/app/index.db.',
  },
  {
    id: 'adv-06',
    content: 'A stale copy of index.db was left in /var/backups/app/index.db.',
  },
  { id: 'adv-07', content: 'The web config is /etc/nginx/nginx.conf.' },
  {
    id: 'adv-08',
    content: 'The queue worker failed with HTTP-500 during the rollout.',
  },
  {
    id: 'adv-09',
    content: 'The metrics exporter also failed with HTTP-500 last night.',
  },
  {
    id: 'adv-10',
    content: 'A missing asset produced HTTP-404 on the docs site.',
  },
  { id: 'adv-11', content: 'Release BUILD-20260823 was promoted to staging.' },
  {
    id: 'adv-12',
    content: 'Release BUILD-20260824 replaced it the next morning.',
  },
  {
    id: 'adv-13',
    content: 'Shard SHARD-1001-NODE was drained for maintenance.',
  },
  { id: 'adv-14', content: 'Node 24.1.0 is installed on the build image.' },
  {
    id: 'adv-15',
    content: 'Node 24.2.0 replaced it after the security patch.',
  },
  {
    id: 'adv-16',
    content: 'The vendored parser is pinned at 24.1.0 for compatibility.',
  },
  { id: 'adv-17', content: 'Laravel 12.0 is used by the billing service.' },
  { id: 'adv-18', content: 'Laravel 13.0 is used by the reporting service.' },
  { id: 'adv-19', content: 'バックアップ対象は /srv/aurora/archive です。' },
  {
    id: 'adv-20',
    content: 'アーカイブ /srv/aurora/archive は毎晩ローテーションされます。',
  },
  {
    id: 'adv-21',
    content: 'キュー断片 QSHARD-7731-ZETA は staging に割り当てられています。',
  },
  { id: 'adv-22', content: 'ゲートウェイは QSHARD-7731-ZETA 以外を拒否します。' },
  { id: 'adv-23', content: 'The release 2.3.0 was tagged on Friday.' },
  { id: 'adv-24', content: 'The version 2.3.0 shipped without incident.' },
];

export const OPERATIONAL_DATASETS: readonly OperationalDataset[] = [
  {
    id: 'session',
    kind: 'session',
    provenance:
      'Captured from a real Pi session, nine turns of repository investigation with the production discovery prompt.',
    facts: SESSION_FACTS,
  },
  {
    id: 'adversarial',
    kind: 'adversarial',
    provenance:
      'Hand-built from shapes that collide by accident: routes, error codes, build ids, shared version numbers.',
    facts: ADVERSARIAL_FACTS,
  },
];
