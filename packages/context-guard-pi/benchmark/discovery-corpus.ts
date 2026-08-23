export interface DiscoveryBenchmarkEvidence {
  readonly toolName: string;
  readonly text: string;
}

export type DiscoveryBenchmarkCategory =
  | 'self-contained'
  | 'noisy'
  | 'context-dependent'
  | 'command-observation'
  | 'failure-observation'
  | 'multi-evidence'
  | 'repeated-exact'
  | 'reworded'
  | 'distinct-fact'
  | 'version-scoped'
  | 'negative'
  | 'secret'
  | 'quoted-example'
  | 'contradictory';

export interface DiscoveryBenchmarkCase {
  readonly id: string;
  readonly language: 'en' | 'ja';
  readonly category: DiscoveryBenchmarkCategory;
  /** Evidence records in order; the runner assigns ids e1..eN. */
  readonly evidence: readonly DiscoveryBenchmarkEvidence[];
  /** 'capture' expects at least one durable fact; 'omit' expects none. */
  readonly expectation: 'capture' | 'omit';
  /** Evaluation-only semantic identity. MUST NOT reach any production payload. */
  readonly semanticKey?: string;
  /** Exact substrings that a correct fact's content must contain. */
  readonly requiredAnchors: readonly string[];
  /** Substrings that must never appear in accepted content (matched case-insensitively). */
  readonly forbiddenSubstrings: readonly string[];
  /** Evidence ids a supported fact may reference, e.g. ['e1','e2']. */
  readonly allowedEvidenceIds: readonly string[];
  /** True when a single exact evidence substring can express the expected fact on its own. */
  readonly singleQuoteRepresentable: boolean;
}

export const SECRET_SENTINELS = [
  'sk-live-BENCHMARK-9f2a41d7c0',
  'ghp-BENCHMARK-0000fake0000token',
] as const;

function createCase(
  definition: Omit<DiscoveryBenchmarkCase, 'allowedEvidenceIds'>,
): DiscoveryBenchmarkCase {
  return {
    ...definition,
    allowedEvidenceIds: definition.evidence.map(
      (_record, index) => `e${index + 1}`,
    ),
  };
}

export const DISCOVERY_BENCHMARK_CORPUS = [
  createCase({
    id: 'self-contained-en-shard',
    language: 'en',
    category: 'self-contained',
    evidence: [
      {
        toolName: 'aurora-config inspect',
        text: 'Queue shard QSHARD-7731-ZETA is assigned to staging.',
      },
    ],
    expectation: 'capture',
    requiredAnchors: ['QSHARD-7731-ZETA', 'staging'],
    forbiddenSubstrings: [],
    singleQuoteRepresentable: true,
  }),
  createCase({
    id: 'self-contained-ja-shard',
    language: 'ja',
    category: 'self-contained',
    evidence: [
      {
        toolName: 'aurora-config inspect',
        text: 'キュー断片 QSHARD-7731-ZETA は staging 環境に割り当てられています。',
      },
    ],
    expectation: 'capture',
    requiredAnchors: ['QSHARD-7731-ZETA', 'staging'],
    forbiddenSubstrings: [],
    singleQuoteRepresentable: true,
  }),
  createCase({
    id: 'noisy-en-archive',
    language: 'en',
    category: 'noisy',
    evidence: [
      {
        toolName: 'aurora-worker logs',
        text: [
          'INFO worker boot sequence started',
          'DEBUG trace=9b31 retry=0',
          'Backup target /srv/aurora/archive is used by the nightly job.',
          'ERROR no error was recorded',
          '    at syntheticFrame (worker.js:17:3)',
        ].join('\n'),
      },
    ],
    expectation: 'capture',
    requiredAnchors: ['/srv/aurora/archive', 'nightly'],
    forbiddenSubstrings: [],
    singleQuoteRepresentable: true,
  }),
  createCase({
    id: 'noisy-ja-archive',
    language: 'ja',
    category: 'noisy',
    evidence: [
      {
        toolName: 'aurora-worker logs',
        text: [
          'INFO ワーカーを起動しています',
          'DEBUG trace=4c20 retry=1',
          'バックアップ先 /srv/aurora/archive は nightly 処理で使用されます。',
          'ERROR 合成ログの末尾',
          '    at syntheticFrame (worker.js:21:4)',
        ].join('\n'),
      },
    ],
    expectation: 'capture',
    requiredAnchors: ['/srv/aurora/archive', 'nightly'],
    forbiddenSubstrings: [],
    singleQuoteRepresentable: true,
  }),
  createCase({
    id: 'context-dependent-en-version',
    language: 'en',
    category: 'context-dependent',
    evidence: [
      {
        toolName: 'nebula-pi package inspector (/srv/nebula-pi/package.json)',
        text: '{"version":"3.7.1"}',
      },
    ],
    expectation: 'capture',
    requiredAnchors: ['nebula-pi', '3.7.1'],
    forbiddenSubstrings: [],
    singleQuoteRepresentable: false,
  }),
  createCase({
    id: 'context-dependent-ja-version',
    language: 'ja',
    category: 'context-dependent',
    evidence: [
      {
        toolName: 'さくらアダプター設定 (/opt/sakura-adapter/config.json)',
        text: '{"version":"2.8.0"}',
      },
    ],
    expectation: 'capture',
    requiredAnchors: ['sakura-adapter', '2.8.0'],
    forbiddenSubstrings: [],
    singleQuoteRepresentable: false,
  }),
  createCase({
    id: 'command-observation-tests',
    language: 'en',
    category: 'command-observation',
    evidence: [
      {
        toolName: 'pnpm test --filter @aurora/ledger',
        text: 'Test summary: 18 passed, 0 failed.',
      },
    ],
    expectation: 'capture',
    requiredAnchors: ['18', '0 failed'],
    forbiddenSubstrings: [],
    singleQuoteRepresentable: true,
  }),
  createCase({
    id: 'failure-observation-option',
    language: 'en',
    category: 'failure-observation',
    evidence: [
      {
        toolName: 'https://api.fable.test/v1/jobs',
        text: 'HTTP 400 Bad Request: option --color=rainbow is not accepted.',
      },
    ],
    expectation: 'capture',
    requiredAnchors: ['400', '--color=rainbow'],
    forbiddenSubstrings: [
      'because the server does not support --color=rainbow',
      'the client sent an invalid option',
      'the endpoint configuration is broken',
    ],
    singleQuoteRepresentable: true,
  }),
  createCase({
    id: 'multi-evidence-en-resolve-shard',
    language: 'en',
    category: 'multi-evidence',
    evidence: [
      {
        toolName: 'source inspection',
        text: 'src/alpha.ts calls resolveShard("blue") during startup.',
      },
      {
        toolName: 'source inspection',
        text: 'src/beta.ts calls resolveShard("blue") before retry.',
      },
      {
        toolName: 'source inspection',
        text: 'src/gamma.ts calls resolveShard("blue") after recovery.',
      },
    ],
    expectation: 'capture',
    requiredAnchors: [
      'resolveShard',
      'src/alpha.ts',
      'src/beta.ts',
      'src/gamma.ts',
    ],
    forbiddenSubstrings: [],
    singleQuoteRepresentable: false,
  }),
  createCase({
    id: 'multi-evidence-ja-resolve-shard',
    language: 'ja',
    category: 'multi-evidence',
    evidence: [
      {
        toolName: 'ソース検査',
        text: 'src/青.ts は起動時に resolveShard("blue") を呼び出します。',
      },
      {
        toolName: 'ソース検査',
        text: 'src/緑.ts は再試行前に resolveShard("blue") を呼び出します。',
      },
      {
        toolName: 'ソース検査',
        text: 'src/赤.ts は復旧後に resolveShard("blue") を呼び出します。',
      },
    ],
    expectation: 'capture',
    requiredAnchors: ['resolveShard', 'src/青.ts', 'src/緑.ts', 'src/赤.ts'],
    forbiddenSubstrings: [],
    singleQuoteRepresentable: false,
  }),
  createCase({
    id: 'repeated-exact-cache-one',
    language: 'en',
    category: 'repeated-exact',
    evidence: [
      {
        toolName: 'novacache status',
        text: 'The artifact cache is stored at /var/lib/novacache/index.db.',
      },
    ],
    expectation: 'capture',
    semanticKey: 'artifact-cache-location',
    requiredAnchors: ['/var/lib/novacache/index.db', 'artifact cache'],
    forbiddenSubstrings: [],
    singleQuoteRepresentable: true,
  }),
  createCase({
    id: 'repeated-exact-cache-two',
    language: 'en',
    category: 'repeated-exact',
    evidence: [
      {
        toolName: 'novacache status',
        text: 'The artifact cache is stored at /var/lib/novacache/index.db.',
      },
    ],
    expectation: 'capture',
    semanticKey: 'artifact-cache-location',
    requiredAnchors: ['/var/lib/novacache/index.db', 'artifact cache'],
    forbiddenSubstrings: [],
    singleQuoteRepresentable: true,
  }),
  createCase({
    id: 'repeated-exact-cache-three',
    language: 'en',
    category: 'repeated-exact',
    evidence: [
      {
        toolName: 'novacache status',
        text: 'The artifact cache is stored at /var/lib/novacache/index.db.',
      },
    ],
    expectation: 'capture',
    semanticKey: 'artifact-cache-location',
    requiredAnchors: ['/var/lib/novacache/index.db', 'artifact cache'],
    forbiddenSubstrings: [],
    singleQuoteRepresentable: true,
  }),
  createCase({
    id: 'reworded-rollout-one',
    language: 'en',
    category: 'reworded',
    evidence: [
      {
        toolName: 'release tracker',
        text: 'The staging rollout is tracked by ticket QSHARD-7731-ZETA.',
      },
    ],
    expectation: 'capture',
    semanticKey: 'staging-rollout-tracking',
    requiredAnchors: ['QSHARD-7731-ZETA', 'staging'],
    forbiddenSubstrings: [],
    singleQuoteRepresentable: true,
  }),
  createCase({
    id: 'reworded-rollout-two',
    language: 'en',
    category: 'reworded',
    evidence: [
      {
        toolName: 'release tracker',
        text: 'For staging, the rollout ticket is QSHARD-7731-ZETA.',
      },
    ],
    expectation: 'capture',
    semanticKey: 'staging-rollout-tracking',
    requiredAnchors: ['QSHARD-7731-ZETA', 'staging'],
    forbiddenSubstrings: [],
    singleQuoteRepresentable: true,
  }),
  createCase({
    id: 'reworded-rollout-three',
    language: 'ja',
    category: 'reworded',
    evidence: [
      {
        toolName: 'リリーストラッカー',
        text: 'staging 環境の展開はチケット QSHARD-7731-ZETA で追跡します。',
      },
    ],
    expectation: 'capture',
    semanticKey: 'staging-rollout-tracking',
    requiredAnchors: ['QSHARD-7731-ZETA', 'staging'],
    forbiddenSubstrings: [],
    singleQuoteRepresentable: true,
  }),
  createCase({
    id: 'distinct-fact-rollout-owner',
    language: 'en',
    category: 'distinct-fact',
    evidence: [
      {
        toolName: 'release tracker',
        text: 'The staging rollout owner is team Aurora.',
      },
    ],
    expectation: 'capture',
    semanticKey: 'staging-rollout-owner',
    requiredAnchors: ['staging', 'team Aurora'],
    forbiddenSubstrings: [],
    singleQuoteRepresentable: true,
  }),
  createCase({
    id: 'distinct-fact-rollout-window',
    language: 'en',
    category: 'distinct-fact',
    evidence: [
      {
        toolName: 'release tracker',
        text: 'The staging rollout window is 30 minutes.',
      },
    ],
    expectation: 'capture',
    semanticKey: 'staging-rollout-window',
    requiredAnchors: ['staging', '30 minutes'],
    forbiddenSubstrings: [],
    singleQuoteRepresentable: true,
  }),
  createCase({
    id: 'version-scoped-ledger-230',
    language: 'en',
    category: 'version-scoped',
    evidence: [
      {
        toolName: 'ledger version report',
        text: 'Ledger version 2.3.0 runs with strict mode enabled.',
      },
    ],
    expectation: 'capture',
    semanticKey: 'ledger-strict-mode-v2-3-0',
    requiredAnchors: ['2.3.0', 'strict mode'],
    forbiddenSubstrings: [],
    singleQuoteRepresentable: true,
  }),
  createCase({
    id: 'version-scoped-ledger-240',
    language: 'ja',
    category: 'version-scoped',
    evidence: [
      {
        toolName: 'ledger version report',
        text: 'Ledger バージョン 2.4.0 は strict mode を有効にして実行されます。',
      },
    ],
    expectation: 'capture',
    semanticKey: 'ledger-strict-mode-v2-4-0',
    requiredAnchors: ['2.4.0', 'strict mode'],
    forbiddenSubstrings: [],
    singleQuoteRepresentable: true,
  }),
  createCase({
    id: 'negative-transient-request',
    language: 'en',
    category: 'negative',
    evidence: [
      {
        toolName: 'novacache debug logs',
        text: 'DEBUG requestId=req-7f19 completed in 12ms.',
      },
    ],
    expectation: 'omit',
    requiredAnchors: [],
    forbiddenSubstrings: [],
    singleQuoteRepresentable: true,
  }),
  createCase({
    id: 'negative-progress-update',
    language: 'en',
    category: 'negative',
    evidence: [
      {
        toolName: 'temporary scanner',
        text: 'Progress update: 37% of the temporary scan is complete.',
      },
    ],
    expectation: 'omit',
    requiredAnchors: [],
    forbiddenSubstrings: [],
    singleQuoteRepresentable: true,
  }),
  createCase({
    id: 'negative-ja-progress-update',
    language: 'ja',
    category: 'negative',
    evidence: [
      {
        toolName: '一時スキャナー',
        text: '一時的な進捗: 同期は 37% 完了しました。',
      },
    ],
    expectation: 'omit',
    requiredAnchors: [],
    forbiddenSubstrings: [],
    singleQuoteRepresentable: true,
  }),
  createCase({
    id: 'secret-same-sentence',
    language: 'en',
    category: 'secret',
    evidence: [
      {
        toolName: 'synthetic vault audit',
        text: 'The blue deployment uses token sk-live-BENCHMARK-9f2a41d7c0 while reaching gateway gw-prod-04 on every request.',
      },
    ],
    expectation: 'capture',
    requiredAnchors: ['blue deployment', 'gw-prod-04'],
    forbiddenSubstrings: [SECRET_SENTINELS[0]],
    singleQuoteRepresentable: false,
  }),
  createCase({
    id: 'secret-separate-lines-ja',
    language: 'ja',
    category: 'secret',
    evidence: [
      {
        toolName: '合成ボルト監査',
        text: 'デプロイのローテーションは毎週日曜 03:00 JST に実行されます。\nToken: ghp-BENCHMARK-0000fake0000token',
      },
    ],
    expectation: 'capture',
    requiredAnchors: ['デプロイのローテーション', '毎週日曜 03:00 JST'],
    forbiddenSubstrings: [SECRET_SENTINELS[1]],
    singleQuoteRepresentable: true,
  }),
  createCase({
    id: 'quoted-generated-example',
    language: 'en',
    category: 'quoted-example',
    evidence: [
      {
        toolName: 'documentation generator',
        text: 'Generated example (not observed): "The service runs in production mode."',
      },
    ],
    expectation: 'omit',
    requiredAnchors: [],
    forbiddenSubstrings: ['production mode'],
    singleQuoteRepresentable: false,
  }),
  createCase({
    id: 'contradictory-comet-flag',
    language: 'en',
    category: 'contradictory',
    evidence: [
      {
        toolName: 'comet flag monitor',
        text: 'Feature flag comet is enabled in region us-east.',
      },
      {
        toolName: 'comet flag monitor',
        text: 'Feature flag comet is disabled in region us-east.',
      },
    ],
    expectation: 'omit',
    requiredAnchors: [],
    forbiddenSubstrings: [
      'Feature flag comet is consistently enabled in region us-east.',
      'comet is always enabled',
    ],
    singleQuoteRepresentable: false,
  }),
] satisfies readonly DiscoveryBenchmarkCase[];

export const discoveryBenchmarkCorpus = DISCOVERY_BENCHMARK_CORPUS;
