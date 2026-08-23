import type { CandidateItem } from '../src/discovery-candidates.js';

export type CandidateCaseCategory =
  | 'true-path'
  | 'true-opaque-id'
  | 'true-versioned-subject'
  | 'true-three-way'
  | 'true-multi-anchor'
  | 'negative-basename'
  | 'negative-shared-version'
  | 'negative-bare-number'
  | 'negative-log-token'
  | 'negative-generic-word'
  | 'negative-route-fragment'
  | 'negative-similar-prose'
  | 'ordinary-unrelated'
  | 'ordinary-single'
  | 'ordinary-empty';

export interface CandidateBenchmarkCase {
  readonly id: string;
  readonly language: 'en' | 'ja';
  readonly category: CandidateCaseCategory;
  /** Active discovery contents keyed by item id. */
  readonly items: readonly CandidateItem[];
  /** Expected groups, each a sorted list of item ids. Empty means no candidate. */
  readonly expectedGroups: readonly (readonly string[])[];
  /** True when a false positive here would be especially damaging. */
  readonly highRisk: boolean;
}

function item(id: string, content: string): CandidateItem {
  return { id, content };
}

function benchmarkCase(
  id: string,
  language: 'en' | 'ja',
  category: CandidateCaseCategory,
  items: readonly CandidateItem[],
  expectedGroups: readonly (readonly string[])[],
  highRisk: boolean,
): CandidateBenchmarkCase {
  return { id, language, category, items, expectedGroups, highRisk };
}

export const CANDIDATE_BENCHMARK_CORPUS: readonly CandidateBenchmarkCase[] = [
  benchmarkCase(
    'true-path-absolute-en',
    'en',
    'true-path',
    [
      item('path-a', 'The backup archive is stored at /srv/aurora/archive.'),
      item('path-b', 'Nightly retention reads /srv/aurora/archive after rotation.'),
    ],
    [['path-a', 'path-b']],
    false,
  ),
  benchmarkCase(
    'true-path-relative-en',
    'en',
    'true-path',
    [
      item('relative-a', 'The state is defined in packages/context-guard-pi/src/state.ts.'),
      item('relative-b', 'Review packages/context-guard-pi/src/state.ts before changing the state.'),
    ],
    [['relative-a', 'relative-b']],
    false,
  ),
  benchmarkCase(
    'true-path-absolute-ja',
    'ja',
    'true-path',
    [
      item('ja-path-a', '夜間バックアップは/srv/aurora/archiveに保存されます。'),
      item('ja-path-b', '保持処理は/srv/aurora/archiveから古い記録を読み出します。'),
    ],
    [['ja-path-a', 'ja-path-b']],
    false,
  ),
  benchmarkCase(
    'true-path-punctuation-en',
    'en',
    'true-path',
    [
      item('punctuation-a', 'The cache lives at `/var/lib/novacache/index.db`. '),
      item('punctuation-b', 'The cache moved from `/var/lib/novacache/index.db`, after repair.'),
    ],
    [['punctuation-a', 'punctuation-b']],
    false,
  ),
  benchmarkCase(
    'true-path-three-ja',
    'ja',
    'true-three-way',
    [
      item('three-path-a', '/srv/aurora/archiveはワーカーAの読み取り先です。'),
      item('three-path-b', '/srv/aurora/archiveはワーカーBの読み取り先です。'),
      item('three-path-c', '/srv/aurora/archiveはワーカーCの読み取り先です。'),
    ],
    [['three-path-a', 'three-path-b', 'three-path-c']],
    false,
  ),
  benchmarkCase(
    'true-opaque-id-en',
    'en',
    'true-opaque-id',
    [
      item('opaque-a', 'Queue shard QSHARD-7731-ZETA is assigned to staging.'),
      item('opaque-b', 'Queue shard QSHARD-7731-ZETA is assigned to recovery.'),
    ],
    [['opaque-a', 'opaque-b']],
    false,
  ),
  benchmarkCase(
    'true-opaque-id-ja',
    'ja',
    'true-opaque-id',
    [
      item('ja-opaque-a', 'キュー断片QSHARD-7731-ZETAはstaging環境に割り当てられています。'),
      item('ja-opaque-b', '同じ識別子QSHARD-7731-ZETAは再試行用に保持されています。'),
    ],
    [['ja-opaque-a', 'ja-opaque-b']],
    false,
  ),
  benchmarkCase(
    'true-opaque-three-ja',
    'ja',
    'true-three-way',
    [
      item('three-opaque-a', '監視対象QSHARD-7731-ZETAの状態は正常です。'),
      item('three-opaque-b', '監視対象QSHARD-7731-ZETAの状態は待機中です。'),
      item('three-opaque-c', '監視対象QSHARD-7731-ZETAの状態は復旧しました。'),
    ],
    [['three-opaque-a', 'three-opaque-b', 'three-opaque-c']],
    false,
  ),
  benchmarkCase(
    'true-opaque-punctuation-ja',
    'ja',
    'true-opaque-id',
    [
      item('marker-a', '移行マーカーは`MIGRATE-2048-BETA`です。'),
      item('marker-b', 'ロールバックにも`MIGRATE-2048-BETA`を使います。'),
    ],
    [['marker-a', 'marker-b']],
    false,
  ),
  benchmarkCase(
    'true-versioned-subject-en',
    'en',
    'true-versioned-subject',
    [
      item('version-a', 'Ledger version 2.3.0 uses strict mode.'),
      item('version-b', 'Ledger version 2.4.0 uses strict mode.'),
    ],
    [['version-a', 'version-b']],
    false,
  ),
  benchmarkCase(
    'true-versioned-subject-ja',
    'ja',
    'true-versioned-subject',
    [
      item('ja-version-a', 'Ledger version 2.3.0は厳格モードを使用します。'),
      item('ja-version-b', 'Ledger v2.4.0は厳格モードを使用します。'),
    ],
    [['ja-version-a', 'ja-version-b']],
    false,
  ),
  benchmarkCase(
    'true-versioned-subject-case-ja',
    'ja',
    'true-versioned-subject',
    [
      item('case-version-a', 'Node 24.1.0は長期接続を有効にします。'),
      item('case-version-b', 'node: 24.2.0では長期接続を有効にします。'),
    ],
    [['case-version-a', 'case-version-b']],
    false,
  ),
  benchmarkCase(
    'true-versioned-subject-punctuation-en',
    'en',
    'true-versioned-subject',
    [
      item('punctuation-version-a', 'The package is Ledger: version 2.3.0, stable.'),
      item('punctuation-version-b', 'Ledger: v2.4.0 is the deployed release.'),
    ],
    [['punctuation-version-a', 'punctuation-version-b']],
    false,
  ),
  benchmarkCase(
    'true-multi-anchor-en',
    'en',
    'true-multi-anchor',
    [
      item(
        'multi-a',
        'CACHE-42-OMEGA uses /var/lib/novacache/index.db for metadata.',
      ),
      item(
        'multi-b',
        'CACHE-42-OMEGA uses /var/lib/novacache/index.db after repair.',
      ),
    ],
    [['multi-a', 'multi-b']],
    false,
  ),
  benchmarkCase(
    'true-multi-anchor-ja',
    'ja',
    'true-multi-anchor',
    [
      item(
        'ja-multi-a',
        'CACHE-42-OMEGAは/var/lib/novacache/index.dbを参照します。',
      ),
      item(
        'ja-multi-b',
        '復旧処理もCACHE-42-OMEGAと/var/lib/novacache/index.dbを使用します。',
      ),
    ],
    [['ja-multi-a', 'ja-multi-b']],
    false,
  ),
  benchmarkCase(
    'negative-basename-en',
    'en',
    'negative-basename',
    [
      item('basename-a', '/opt/alpha/config.json contains the alpha settings.'),
      item('basename-b', '/opt/beta/config.json contains the beta settings.'),
    ],
    [],
    true,
  ),
  benchmarkCase(
    'negative-basename-ja',
    'ja',
    'negative-basename',
    [
      item('ja-basename-a', '/opt/alpha/config.jsonはalpha用の設定です。'),
      item('ja-basename-b', '/opt/beta/config.jsonはbeta用の設定です。'),
    ],
    [],
    true,
  ),
  benchmarkCase(
    'negative-shared-version-en',
    'en',
    'negative-shared-version',
    [
      item('shared-version-a', 'Ledger version 2.3.0 uses strict mode.'),
      item('shared-version-b', 'Node version 2.3.0 uses a stream pool.'),
    ],
    [],
    true,
  ),
  benchmarkCase(
    'negative-shared-version-ja',
    'ja',
    'negative-shared-version',
    [
      item('ja-shared-version-a', 'Ledger version 2.3.0は厳格モードです。'),
      item('ja-shared-version-b', 'Node version 2.3.0は接続プールです。'),
    ],
    [],
    true,
  ),
  benchmarkCase(
    'negative-bare-number-en',
    'en',
    'negative-bare-number',
    [
      item('bare-number-a', 'The retry budget is 42.'),
      item('bare-number-b', 'The batch size is 42.'),
    ],
    [],
    true,
  ),
  benchmarkCase(
    'negative-bare-number-ja',
    'ja',
    'negative-bare-number',
    [
      item('ja-bare-number-a', '再試行の予算は42です。'),
      item('ja-bare-number-b', 'バッチの上限も42です。'),
    ],
    [],
    true,
  ),
  benchmarkCase(
    'negative-log-token-en',
    'en',
    'negative-log-token',
    [
      item('log-token-a', 'INFO worker boot sequence started.'),
      item('log-token-b', 'INFO worker shutdown completed.'),
    ],
    [],
    true,
  ),
  benchmarkCase(
    'negative-log-token-ja',
    'ja',
    'negative-log-token',
    [
      item('ja-log-token-a', 'INFOワーカーの起動が完了しました。'),
      item('ja-log-token-b', 'INFOワーカーの停止が完了しました。'),
    ],
    [],
    true,
  ),
  benchmarkCase(
    'negative-generic-word-en',
    'en',
    'negative-generic-word',
    [
      item('generic-a', 'Aurora staging accepts nightly writes.'),
      item('generic-b', 'Nebula staging rejects manual writes.'),
    ],
    [],
    true,
  ),
  benchmarkCase(
    'negative-generic-word-ja',
    'ja',
    'negative-generic-word',
    [
      item('ja-generic-a', 'Auroraのstaging環境は夜間書き込みを受け付けます。'),
      item('ja-generic-b', 'Nebulaのstaging環境は手動書き込みを拒否します。')
    ],
    [],
    true,
  ),
  benchmarkCase(
    'negative-route-fragment-en',
    'en',
    'negative-route-fragment',
    [
      item('route-a', 'GET /api/v1/jobs returns the current jobs.'),
      item('route-b', 'GET /api/v1/jobs/archive returns job history.'),
    ],
    [],
    true,
  ),
  benchmarkCase(
    'negative-route-fragment-ja',
    'ja',
    'negative-route-fragment',
    [
      item('ja-route-a', 'GET /api/v1/jobsは現在のジョブを返します。'),
      item('ja-route-b', 'GET /api/v1/jobs/archiveは履歴を返します。'),
    ],
    [],
    true,
  ),
  benchmarkCase(
    'negative-similar-prose-en',
    'en',
    'negative-similar-prose',
    [
      item('similar-a', 'Aurora reports that a worker is ready after recovery.'),
      item('similar-b', 'Aurora says a worker is ready following recovery.'),
    ],
    [],
    true,
  ),
  benchmarkCase(
    'negative-similar-prose-ja',
    'ja',
    'negative-similar-prose',
    [
      item('ja-similar-a', 'Auroraは復旧後にワーカーが準備完了だと報告しました。'),
      item('ja-similar-b', 'Auroraは復旧後にワーカーが利用可能だと伝えました。'),
    ],
    [],
    true,
  ),
  benchmarkCase(
    'ordinary-unrelated-en',
    'en',
    'ordinary-unrelated',
    [
      item('unrelated-a', 'The scheduler accepted the morning workload.'),
      item('unrelated-b', 'A reviewer approved the maintenance window.'),
    ],
    [],
    false,
  ),
  benchmarkCase(
    'ordinary-unrelated-ja',
    'ja',
    'ordinary-unrelated',
    [
      item('ja-unrelated-a', 'スケジューラーは朝の処理を受け付けました。'),
      item('ja-unrelated-b', '担当者は保守時間帯を承認しました。'),
    ],
    [],
    false,
  ),
  benchmarkCase(
    'ordinary-single-en',
    'en',
    'ordinary-single',
    [item('single-en', 'The worker is ready for the next task.')],
    [],
    false,
  ),
  benchmarkCase(
    'ordinary-single-ja',
    'ja',
    'ordinary-single',
    [item('single-ja', 'ワーカーは次の処理を実行する準備ができています。')],
    [],
    false,
  ),
  benchmarkCase(
    'ordinary-empty-en',
    'en',
    'ordinary-empty',
    [],
    [],
    false,
  ),
  benchmarkCase(
    'ordinary-empty-ja',
    'ja',
    'ordinary-empty',
    [],
    [],
    false,
  ),
  benchmarkCase(
    'ordinary-config-en',
    'en',
    'ordinary-unrelated',
    [
      item('config-a', 'The config is loaded before the worker starts.'),
      item('config-b', 'The config is checked after the worker stops.'),
    ],
    [],
    false,
  ),
  benchmarkCase(
    'ordinary-different-anchors-en',
    'en',
    'ordinary-unrelated',
    [
      item('different-a', 'The archive is /srv/aurora/archive for backups.'),
      item('different-b', 'The marker is QSHARD-7731-ZETA for the queue.'),
    ],
    [],
    false,
  ),
  benchmarkCase(
    'ordinary-version-single-ja',
    'ja',
    'ordinary-single',
    [item('version-single-ja', 'Node 24.1.0は接続を開始します。')],
    [],
    false,
  ),
  benchmarkCase(
    'ordinary-japanese-no-anchor',
    'ja',
    'ordinary-unrelated',
    [
      item('no-anchor-ja-a', '監視担当者は朝の確認を終えました。'),
      item('no-anchor-ja-b', '別の担当者は夕方の確認を始めました。'),
    ],
    [],
    false,
  ),
];
