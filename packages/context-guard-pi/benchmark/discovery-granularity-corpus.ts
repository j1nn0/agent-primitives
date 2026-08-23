export type DiscoveryGranularityCategory =
  | 'directory-listing'
  | 'package-json-metadata'
  | 'tsconfig-compiler-config'
  | 'ci-workflow'
  | 'lifecycle-implementation'
  | 'test-output'
  | 'api-config-output'
  | 'japanese-evidence'
  | 'mixed-language-evidence';

export type DiscoveryGranularityLanguage = 'en' | 'ja' | 'mixed';

export type DiscoveryFragmentationClass =
  | 'independent'
  | 'related-fragmentary'
  | 'duplicate'
  | 'complementary'
  | 'ambiguous';

export interface DiscoveryGranularityEvidence {
  readonly toolName: string;
  readonly text: string;
}

/**
 * Synthetic input-side ground truth for discovery-fact granularity research.
 * The grouping metadata is evaluation-only and must never enter a production
 * discovery request or persisted payload.
 */
export interface DiscoveryGranularityScenario {
  readonly id: string;
  readonly category: DiscoveryGranularityCategory;
  readonly language?: DiscoveryGranularityLanguage;
  readonly evidence: readonly DiscoveryGranularityEvidence[];
  /** Exact substrings a durable fact ought to preserve. */
  readonly expectedClaims: readonly string[];
  readonly fragmentationClass: DiscoveryFragmentationClass;
  readonly safetySensitive?: boolean;
  readonly notes?: string;
  /** Acceptable total fact counts for this scenario, when known. */
  readonly acceptableGroupings?: readonly number[];
  /** Total fact counts that would merge or fragment the evidence incorrectly. */
  readonly unacceptableGroupings?: readonly number[];
}

/** The categories required by this benchmark's synthetic corpus. */
export const DISCOVERY_GRANULARITY_CATEGORIES: readonly DiscoveryGranularityCategory[] = [
  'directory-listing',
  'package-json-metadata',
  'tsconfig-compiler-config',
  'ci-workflow',
  'lifecycle-implementation',
  'test-output',
  'api-config-output',
  'japanese-evidence',
  'mixed-language-evidence',
];

export const DISCOVERY_FRAGMENTATION_CLASSES: readonly DiscoveryFragmentationClass[] = [
  'independent',
  'related-fragmentary',
  'duplicate',
  'complementary',
  'ambiguous',
];

export const DISCOVERY_GRANULARITY_CORPUS: readonly DiscoveryGranularityScenario[] = [
  {
    id: 'directory-independent-top-level',
    category: 'directory-listing',
    language: 'en',
    evidence: [
      {
        toolName: 'find',
        text: 'src/\ntest/\nREADME.md\npackages/context-guard-pi/',
      },
    ],
    expectedClaims: ['src/', 'test/', 'README.md'],
    fragmentationClass: 'independent',
    acceptableGroupings: [3],
    unacceptableGroupings: [1, 2],
    notes: 'The entries are unrelated paths from one listing and should remain separately addressable.',
  },
  {
    id: 'directory-related-package-fragments',
    category: 'directory-listing',
    language: 'en',
    evidence: [
      {
        toolName: 'ls packages',
        text: 'packages/context-guard-pi/benchmark',
      },
      {
        toolName: 'ls packages/context-guard-pi',
        text: 'packages/context-guard-pi/test',
      },
    ],
    expectedClaims: ['packages/context-guard-pi/benchmark', 'packages/context-guard-pi/test'],
    fragmentationClass: 'related-fragmentary',
    acceptableGroupings: [1, 2],
    unacceptableGroupings: [3],
    notes: 'Two directory observations describe one package but arrive in separate evidence records.',
  },
  {
    id: 'directory-duplicate-workspace-root',
    category: 'directory-listing',
    language: 'en',
    evidence: [
      {
        toolName: 'pwd && ls',
        text: 'packages/context-guard-pi',
      },
      {
        toolName: 'tree -L 1',
        text: 'packages/context-guard-pi',
      },
    ],
    expectedClaims: ['packages/context-guard-pi'],
    fragmentationClass: 'duplicate',
    acceptableGroupings: [1],
    unacceptableGroupings: [2],
    notes: 'The same path is observed twice; exact duplicate content should not require two durable facts.',
  },
  {
    id: 'directory-ambiguous-sibling-names',
    category: 'directory-listing',
    language: 'en',
    evidence: [
      {
        toolName: 'find packages -maxdepth 1',
        text: 'packages/context-guard-pi\npackages/context-guard-core',
      },
    ],
    expectedClaims: ['packages/context-guard-pi', 'packages/context-guard-core'],
    fragmentationClass: 'ambiguous',
    acceptableGroupings: [1, 2],
    unacceptableGroupings: [3],
    notes: 'A single listing does not establish whether the sibling names are one project concept or two subjects.',
  },
  {
    id: 'package-independent-runtime-tools',
    category: 'package-json-metadata',
    language: 'en',
    evidence: [
      {
        toolName: 'node --version && pnpm --version',
        text: 'node --version: v22.12.0\npnpm --version: 10.34.5',
      },
    ],
    expectedClaims: ['node --version: v22.12.0', 'pnpm --version: 10.34.5'],
    fragmentationClass: 'independent',
    acceptableGroupings: [2],
    unacceptableGroupings: [1],
    notes: 'Hard case: one command output reports Node version and package-manager version; these are separate subjects and should stay separate.',
  },
  {
    id: 'package-complementary-name-version',
    category: 'package-json-metadata',
    language: 'en',
    evidence: [
      {
        toolName: 'cat package.json | jq .name',
        text: '"name": "agent-primitives"',
      },
      {
        toolName: 'cat package.json | jq .version',
        text: '"version": "0.1.0"',
      },
    ],
    expectedClaims: ['"name": "agent-primitives"', '"version": "0.1.0"'],
    fragmentationClass: 'complementary',
    acceptableGroupings: [1, 2],
    unacceptableGroupings: [3],
    notes: 'The properties belong to one package subject, but each value remains independently useful.',
  },
  {
    id: 'package-duplicate-name-inspection',
    category: 'package-json-metadata',
    language: 'en',
    evidence: [
      {
        toolName: 'pnpm list --depth 0',
        text: '"name": "agent-primitives"',
      },
      {
        toolName: 'jq .name package.json',
        text: '"name": "agent-primitives"',
      },
    ],
    expectedClaims: ['"name": "agent-primitives"'],
    fragmentationClass: 'duplicate',
    acceptableGroupings: [1],
    unacceptableGroupings: [2],
  },
  {
    id: 'tsconfig-related-target-module',
    category: 'tsconfig-compiler-config',
    language: 'en',
    evidence: [
      {
        toolName: 'cat tsconfig.json',
        text: '"compilerOptions": { "target": "ES2023",',
      },
      {
        toolName: 'cat tsconfig.json',
        text: '"module": "NodeNext" }',
      },
    ],
    expectedClaims: ['"target": "ES2023"', '"module": "NodeNext"'],
    fragmentationClass: 'related-fragmentary',
    acceptableGroupings: [1, 2],
    unacceptableGroupings: [3],
    notes: 'Hard case: compiler target and module are separate properties of one tsconfig subject; one combined fact or two focused facts may be acceptable.',
  },
  {
    id: 'tsconfig-independent-include-noemit',
    category: 'tsconfig-compiler-config',
    language: 'en',
    evidence: [
      {
        toolName: 'tsc --showConfig',
        text: '"include": ["src", "test"]',
      },
      {
        toolName: 'tsc --showConfig',
        text: '"noEmit": true',
      },
    ],
    expectedClaims: ['"include": ["src", "test"]', '"noEmit": true'],
    fragmentationClass: 'independent',
    acceptableGroupings: [2],
    unacceptableGroupings: [1],
    notes: 'The compiler input boundary and emit policy answer different operational questions.',
  },
  {
    id: 'tsconfig-duplicate-strict-mode',
    category: 'tsconfig-compiler-config',
    language: 'en',
    evidence: [
      {
        toolName: 'tsc --showConfig',
        text: '"strict": true',
      },
      {
        toolName: 'editor diagnostics',
        text: '"strict": true',
      },
    ],
    expectedClaims: ['"strict": true'],
    fragmentationClass: 'duplicate',
    acceptableGroupings: [1],
    unacceptableGroupings: [2],
  },
  {
    id: 'tsconfig-ambiguous-inherited-target',
    category: 'tsconfig-compiler-config',
    language: 'en',
    evidence: [
      {
        toolName: 'tsc --showConfig',
        text: '"target": "ES2023"',
      },
      {
        toolName: 'cat tsconfig.base.json',
        text: 'target inherited from base config',
      },
    ],
    expectedClaims: ['"target": "ES2023"', 'target inherited from base config'],
    fragmentationClass: 'ambiguous',
    acceptableGroupings: [1, 2],
    unacceptableGroupings: [3],
    notes: 'The value is concrete but the source of authority is ambiguous in this synthetic observation.',
  },
  {
    id: 'ci-complementary-trigger-runtime',
    category: 'ci-workflow',
    language: 'en',
    evidence: [
      {
        toolName: 'cat .github/workflows/check.yml',
        text: 'on: [push, pull_request]',
      },
      {
        toolName: 'cat .github/workflows/check.yml',
        text: 'node-version: 22',
      },
    ],
    expectedClaims: ['on: [push, pull_request]', 'node-version: 22'],
    fragmentationClass: 'complementary',
    acceptableGroupings: [1, 2],
    unacceptableGroupings: [3],
    notes: 'Both observations describe one workflow while preserving different configuration dimensions.',
  },
  {
    id: 'ci-independent-lint-test-jobs',
    category: 'ci-workflow',
    language: 'en',
    evidence: [
      {
        toolName: 'cat .github/workflows/check.yml',
        text: 'job lint runs pnpm lint',
      },
      {
        toolName: 'cat .github/workflows/check.yml',
        text: 'job test runs pnpm test',
      },
    ],
    expectedClaims: ['job lint runs pnpm lint', 'job test runs pnpm test'],
    fragmentationClass: 'independent',
    acceptableGroupings: [2],
    unacceptableGroupings: [1],
  },
  {
    id: 'ci-duplicate-success-status',
    category: 'ci-workflow',
    language: 'en',
    evidence: [
      {
        toolName: 'gh run view',
        text: 'workflow check: success',
      },
      {
        toolName: 'CI dashboard',
        text: 'workflow check: success',
      },
    ],
    expectedClaims: ['workflow check: success'],
    fragmentationClass: 'duplicate',
    acceptableGroupings: [1],
    unacceptableGroupings: [2],
  },
  {
    id: 'lifecycle-safety-recovery-policy',
    category: 'lifecycle-implementation',
    language: 'en',
    evidence: [
      {
        toolName: 'context-guard status',
        text: 'recovery mode: off',
      },
      {
        toolName: 'context-guard status',
        text: 'critical failures trigger recovery only when mode is critical',
      },
    ],
    expectedClaims: ['recovery mode: off', 'critical failures trigger recovery only when mode is critical'],
    fragmentationClass: 'independent',
    safetySensitive: true,
    acceptableGroupings: [2],
    unacceptableGroupings: [1],
    notes: 'Safety-sensitive pair: recovery mode off and critical recovery behavior must not be merged into one compound fact.',
  },
  {
    id: 'lifecycle-related-active-status',
    category: 'lifecycle-implementation',
    language: 'en',
    evidence: [
      {
        toolName: 'rg isRecoverableItem src',
        text: "return discoveryStatus(itemId) === 'active';",
      },
      {
        toolName: 'rg lifecycle src',
        text: "status may be 'superseded' or 'retired'",
      },
    ],
    expectedClaims: ["discoveryStatus(itemId) === 'active'", "status may be 'superseded' or 'retired'"],
    fragmentationClass: 'related-fragmentary',
    acceptableGroupings: [1, 2],
    unacceptableGroupings: [3],
    notes: 'The implementation rule and its inactive statuses form one lifecycle explanation across two observations.',
  },
  {
    id: 'lifecycle-duplicate-schema-version',
    category: 'lifecycle-implementation',
    language: 'en',
    evidence: [
      {
        toolName: 'session state dump',
        text: 'schemaVersion: 5',
      },
      {
        toolName: 'state loader trace',
        text: 'schemaVersion: 5',
      },
    ],
    expectedClaims: ['schemaVersion: 5'],
    fragmentationClass: 'duplicate',
    acceptableGroupings: [1],
    unacceptableGroupings: [2],
  },
  {
    id: 'test-independent-pass-coverage',
    category: 'test-output',
    language: 'en',
    evidence: [
      {
        toolName: 'pnpm test',
        text: '271 tests passed',
      },
      {
        toolName: 'coverage report',
        text: 'line coverage: 91%',
      },
    ],
    expectedClaims: ['271 tests passed', 'line coverage: 91%'],
    fragmentationClass: 'independent',
    acceptableGroupings: [2],
    unacceptableGroupings: [1],
    notes: 'Pass count and coverage are separate observations even when emitted by one test command family.',
  },
  {
    id: 'test-related-failure-fragments',
    category: 'test-output',
    language: 'en',
    evidence: [
      {
        toolName: 'pnpm test',
        text: 'FAIL test/discovery-granularity.test.ts',
      },
      {
        toolName: 'pnpm test',
        text: 'expected 2 facts, received 1',
      },
    ],
    expectedClaims: ['FAIL test/discovery-granularity.test.ts', 'expected 2 facts, received 1'],
    fragmentationClass: 'related-fragmentary',
    acceptableGroupings: [1, 2],
    unacceptableGroupings: [3],
  },
  {
    id: 'test-duplicate-pass-summary',
    category: 'test-output',
    language: 'en',
    evidence: [
      {
        toolName: 'vitest',
        text: 'Test Files 12 passed',
      },
      {
        toolName: 'CI summary',
        text: 'Test Files 12 passed',
      },
    ],
    expectedClaims: ['Test Files 12 passed'],
    fragmentationClass: 'duplicate',
    acceptableGroupings: [1],
    unacceptableGroupings: [2],
  },
  {
    id: 'api-independent-host-timeout',
    category: 'api-config-output',
    language: 'en',
    evidence: [
      {
        toolName: 'api-config show',
        text: 'base URL: https://api.sandbox.test/v1',
      },
      {
        toolName: 'api-config show',
        text: 'request timeout: 5000 ms',
      },
    ],
    expectedClaims: ['base URL: https://api.sandbox.test/v1', 'request timeout: 5000 ms'],
    fragmentationClass: 'independent',
    acceptableGroupings: [2],
    unacceptableGroupings: [1],
  },
  {
    id: 'api-complementary-retry-auth',
    category: 'api-config-output',
    language: 'en',
    evidence: [
      {
        toolName: 'curl /config',
        text: 'authentication mode: bearer',
      },
      {
        toolName: 'curl /config',
        text: 'retry limit: 3',
      },
    ],
    expectedClaims: ['authentication mode: bearer', 'retry limit: 3'],
    fragmentationClass: 'complementary',
    acceptableGroupings: [1, 2],
    unacceptableGroupings: [3],
    notes: 'The values configure one API client but should remain individually quotable.',
  },
  {
    id: 'api-duplicate-response-code',
    category: 'api-config-output',
    language: 'en',
    evidence: [
      {
        toolName: 'curl /health',
        text: 'HTTP 200 OK',
      },
      {
        toolName: 'api monitor',
        text: 'HTTP 200 OK',
      },
    ],
    expectedClaims: ['HTTP 200 OK'],
    fragmentationClass: 'duplicate',
    acceptableGroupings: [1],
    unacceptableGroupings: [2],
  },
  {
    id: 'japanese-independent-settings',
    category: 'japanese-evidence',
    language: 'ja',
    evidence: [
      {
        toolName: '設定確認コマンド',
        text: 'リトライ上限: 3',
      },
      {
        toolName: '設定確認コマンド',
        text: '監査ログ: 有効',
      },
    ],
    expectedClaims: ['リトライ上限: 3', '監査ログ: 有効'],
    fragmentationClass: 'independent',
    acceptableGroupings: [2],
    unacceptableGroupings: [1],
    notes: 'Japanese evidence must be evaluated by exact substrings, not translation or token similarity.',
  },
  {
    id: 'japanese-related-path-fragments',
    category: 'japanese-evidence',
    language: 'ja',
    evidence: [
      {
        toolName: 'ディレクトリ確認',
        text: '設定ファイルは packages/context-guard-pi/',
      },
      {
        toolName: 'ファイル確認',
        text: '設定ファイルは packages/context-guard-pi/benchmark/README.md にあります。',
      },
    ],
    expectedClaims: ['設定ファイルは packages/context-guard-pi/', 'packages/context-guard-pi/benchmark/README.md'],
    fragmentationClass: 'related-fragmentary',
    acceptableGroupings: [1, 2],
    unacceptableGroupings: [3],
    notes: 'The Japanese explanation and the English path are one cross-script observation split across tools.',
  },
  {
    id: 'japanese-duplicate-status',
    category: 'japanese-evidence',
    language: 'ja',
    evidence: [
      {
        toolName: '状態確認',
        text: '検証状態: 成功',
      },
      {
        toolName: 'CI 状態確認',
        text: '検証状態: 成功',
      },
    ],
    expectedClaims: ['検証状態: 成功'],
    fragmentationClass: 'duplicate',
    acceptableGroupings: [1],
    unacceptableGroupings: [2],
  },
  {
    id: 'mixed-complementary-strict-node',
    category: 'mixed-language-evidence',
    language: 'mixed',
    evidence: [
      {
        toolName: 'config inspector',
        text: 'strict mode は有効です',
      },
      {
        toolName: 'runtime inspector',
        text: 'Node 22 is selected',
      },
    ],
    expectedClaims: ['strict mode は有効です', 'Node 22 is selected'],
    fragmentationClass: 'complementary',
    acceptableGroupings: [1, 2],
    unacceptableGroupings: [3],
    notes: 'Mixed Japanese/English evidence describes one environment while retaining script-specific literals.',
  },
  {
    id: 'mixed-independent-command-versions',
    category: 'mixed-language-evidence',
    language: 'mixed',
    evidence: [
      {
        toolName: 'version check',
        text: 'node --version: v22.12.0',
      },
      {
        toolName: 'バージョン確認',
        text: 'パッケージマネージャー: pnpm 10.34.5',
      },
    ],
    expectedClaims: ['node --version: v22.12.0', 'パッケージマネージャー: pnpm 10.34.5'],
    fragmentationClass: 'independent',
    acceptableGroupings: [2],
    unacceptableGroupings: [1],
    notes: 'Mixed-language hard case: runtime and package-manager versions are separate subjects.',
  },
  {
    id: 'mixed-related-recovery-explanation',
    category: 'mixed-language-evidence',
    language: 'mixed',
    evidence: [
      {
        toolName: 'source search',
        text: "status === 'active' allows recovery",
      },
      {
        toolName: 'ソース説明',
        text: 'superseded は復旧対象外です',
      },
    ],
    expectedClaims: ["status === 'active' allows recovery", 'superseded は復旧対象外です'],
    fragmentationClass: 'related-fragmentary',
    acceptableGroupings: [1, 2],
    unacceptableGroupings: [3],
    notes: 'The code literal and Japanese explanation form one lifecycle rule across languages.',
  },
  {
    id: 'mixed-ambiguous-recovery-status',
    category: 'mixed-language-evidence',
    language: 'mixed',
    evidence: [
      {
        toolName: 'state dump',
        text: 'recovery mode: off',
      },
      {
        toolName: '状態ダンプ',
        text: '復旧モード: critical',
      },
    ],
    expectedClaims: ['recovery mode: off', '復旧モード: critical'],
    fragmentationClass: 'ambiguous',
    safetySensitive: true,
    acceptableGroupings: [2],
    unacceptableGroupings: [1],
    notes: 'Safety-sensitive mixed-language pair: apparently conflicting status observations must not be merged or silently resolved.',
  },
];

/** Compatibility name for benchmark callers that use the longer convention. */
export const DISCOVERY_GRANULARITY_BENCHMARK_CORPUS =
  DISCOVERY_GRANULARITY_CORPUS;
