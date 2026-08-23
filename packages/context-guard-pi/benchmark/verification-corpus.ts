import { digest12 } from '../src/identifiers.js';
import type { DiscoveryProvenance } from '../src/types.js';

export interface BenchmarkToolResult {
  readonly toolCallId: string;
  readonly toolName?: string;
  readonly content: readonly unknown[];
}

export type VerificationCategory =
  | 'literal-preserved'
  | 'formatting-only'
  | 'punctuation-rewrite'
  | 'paraphrase'
  | 'claim-omitted'
  | 'claim-omitted-evidence-present'
  | 'evidence-missing'
  | 'hash-mismatch'
  | 'span-invalid'
  | 'legacy-no-span'
  | 'multi-ref-all-resolve'
  | 'multi-ref-one-missing'
  | 'contradictory-later-evidence';

export interface VerificationBenchmarkCase {
  readonly id: string;
  readonly language: 'en' | 'ja';
  readonly category: VerificationCategory;
  /** The discovery item's registered content. */
  readonly itemContent: string;
  /** The post-compaction context string the verifier is given. */
  readonly contextFixture: string;
  readonly provenance: readonly DiscoveryProvenance[];
  readonly branchToolResults: readonly BenchmarkToolResult[];
  /**
   * Evaluation-only ground truth: does the context fixture actually convey the
   * claim to the model? Never available at runtime, never in production.
   */
  readonly claimActuallyIncludedByFixture: boolean;
}

interface EvidenceReferenceFixture {
  readonly provenance: DiscoveryProvenance;
  readonly branchToolResult?: BenchmarkToolResult;
}

interface ProvenanceOptions {
  readonly includeSpan?: boolean;
  readonly startOffset?: number;
  readonly endOffset?: number;
  readonly hashMismatch?: boolean;
}

function textBlock(text: string): { readonly type: 'text'; readonly text: string } {
  return { type: 'text', text };
}

function toolResult(toolCallId: string, text: string): BenchmarkToolResult {
  return {
    toolCallId,
    toolName: 'synthetic-evidence-tool',
    content: [textBlock(text)],
  };
}

function provenanceFor(
  toolCallId: string,
  text: string,
  quote: string,
  options: ProvenanceOptions = {},
): DiscoveryProvenance {
  const startOffset = options.startOffset ?? text.indexOf(quote);
  if (startOffset < 0) {
    throw new Error(`Quote is not present in synthetic evidence: ${quote}`);
  }
  const endOffset = options.endOffset ?? startOffset + quote.length;
  const selectedQuote = text.slice(startOffset, endOffset);
  const base: DiscoveryProvenance = {
    toolCallId,
    toolName: 'synthetic-evidence-tool',
    quoteHash: options.hashMismatch
      ? digest12(`different quote for ${selectedQuote}`)
      : digest12(selectedQuote),
  };

  if (options.includeSpan === false) {
    return base;
  }
  return {
    ...base,
    span: { startOffset, endOffset },
  };
}

function reference(
  toolCallId: string,
  text: string,
  quote = text,
  options: ProvenanceOptions = {},
  resultAvailable = true,
): EvidenceReferenceFixture {
  const provenance = provenanceFor(toolCallId, text, quote, options);
  if (!resultAvailable) {
    return { provenance };
  }
  return { provenance, branchToolResult: toolResult(toolCallId, text) };
}

function benchmarkCase(
  id: string,
  language: 'en' | 'ja',
  category: VerificationCategory,
  itemContent: string,
  contextFixture: string,
  references: readonly EvidenceReferenceFixture[],
  claimActuallyIncludedByFixture: boolean,
): VerificationBenchmarkCase {
  return {
    id,
    language,
    category,
    itemContent,
    contextFixture,
    provenance: references.map(({ provenance }) => provenance),
    branchToolResults: references.flatMap(({ branchToolResult }) =>
      branchToolResult === undefined ? [] : [branchToolResult],
    ),
    claimActuallyIncludedByFixture,
  };
}

export const VERIFICATION_BENCHMARK_CORPUS: readonly VerificationBenchmarkCase[] = [
  benchmarkCase(
    'literal-preserved-ledger-en',
    'en',
    'literal-preserved',
    'Ledger version 2.3.0 runs with strict mode enabled.',
    'Compaction summary: Ledger version 2.3.0 runs with strict mode enabled.',
    [
      reference(
        'literal-ledger-en',
        'Ledger version 2.3.0 runs with strict mode enabled.',
      ),
    ],
    true,
  ),
  benchmarkCase(
    'literal-preserved-audit-ja',
    'ja',
    'literal-preserved',
    '監査ログ😀は毎日午前二時に保存されます。',
    '要約: 監査ログ😀は毎日午前二時に保存されます。',
    [
      reference(
        'literal-audit-ja',
        '監査ログ😀は毎日午前二時に保存されます。',
      ),
    ],
    true,
  ),
  benchmarkCase(
    'literal-preserved-route-ja',
    'ja',
    'literal-preserved',
    '通知は大阪リージョンから送信されます。',
    '記録: 通知は大阪リージョンから送信されます。',
    [
      reference(
        'literal-route-ja',
        '通知は大阪リージョンから送信されます。',
      ),
    ],
    true,
  ),
  benchmarkCase(
    'formatting-only-shard-en',
    'en',
    'formatting-only',
    'The shard identifier is QSHARD-7731-ZETA.',
    'Summary: The shard identifier is `QSHARD-7731-ZETA`.',
    [
      reference(
        'format-shard-en',
        'The shard identifier is QSHARD-7731-ZETA.',
      ),
    ],
    true,
  ),
  benchmarkCase(
    'formatting-only-path-en',
    'en',
    'formatting-only',
    'Artifacts are stored at /var/lib/novacache/index.db.',
    'Summary: Artifacts are stored at `/var/lib/novacache/index.db`.',
    [
      reference(
        'format-path-en',
        'Artifacts are stored at /var/lib/novacache/index.db.',
      ),
    ],
    true,
  ),
  benchmarkCase(
    'formatting-only-version-ja',
    'ja',
    'formatting-only',
    '検証対象はリリース v4.2.0 です。',
    '要約: 検証対象はリリース `v4.2.0` です。',
    [
      reference('format-version-ja', '検証対象はリリース v4.2.0 です。'),
    ],
    true,
  ),
  benchmarkCase(
    'formatting-only-bold-version-en',
    'en',
    'formatting-only',
    'The Ledger version 2.3.0 is pinned.',
    'The **Ledger version 2.3.0** is pinned.',
    [
      reference('format-bold-version-en', 'The Ledger version 2.3.0 is pinned.'),
    ],
    true,
  ),
  benchmarkCase(
    'punctuation-rewrite-timeout-en',
    'en',
    'punctuation-rewrite',
    'The worker retries after a timeout, then writes the audit record.',
    'The worker retries after a timeout: then writes the audit record.',
    [
      reference(
        'punctuation-timeout-en',
        'The worker retries after a timeout, then writes the audit record.',
      ),
    ],
    true,
  ),
  benchmarkCase(
    'punctuation-rewrite-config-ja',
    'ja',
    'punctuation-rewrite',
    '設定は検証後に保存されます。',
    '設定は検証後に保存されます:',
    [
      reference('punctuation-config-ja', '設定は検証後に保存されます。'),
    ],
    true,
  ),
  benchmarkCase(
    'paraphrase-cache-en',
    'en',
    'paraphrase',
    'The cache is stored on the local disk.',
    'Summary: the cache uses local disk storage.',
    [
      reference('paraphrase-cache-en', 'The cache is stored on the local disk.'),
    ],
    true,
  ),
  benchmarkCase(
    'paraphrase-deploy-ja',
    'ja',
    'paraphrase',
    'デプロイは毎週月曜日に自動実行されます。',
    '要約: 自動デプロイは毎週月曜に走ります。',
    [
      reference(
        'paraphrase-deploy-ja',
        'デプロイは毎週月曜日に自動実行されます。',
      ),
    ],
    true,
  ),
  benchmarkCase(
    'paraphrase-tls-en',
    'en',
    'paraphrase',
    'The API listens on port 8443 for TLS traffic.',
    'TLS requests are accepted by the API on port 8443.',
    [
      reference('paraphrase-tls-en', 'The API listens on port 8443 for TLS traffic.'),
    ],
    true,
  ),
  benchmarkCase(
    'claim-omitted-feature-en',
    'en',
    'claim-omitted',
    'The feature flag frost is enabled in production.',
    'Compaction summary: the deployment completed without warnings.',
    [
      reference(
        'omitted-feature-en',
        'The deployment completed without warnings.',
      ),
    ],
    false,
  ),
  benchmarkCase(
    'claim-omitted-test-ja',
    'ja',
    'claim-omitted',
    'データベースは暗号化されています。',
    '要約: テストは成功しました。',
    [reference('omitted-test-ja', 'テストは成功しました。')],
    false,
  ),
  benchmarkCase(
    'claim-omitted-retention-en',
    'en',
    'claim-omitted',
    'The backup retention is thirty days.',
    'Summary: the backup job finished.',
    [reference('omitted-retention-en', 'The backup job finished.')],
    false,
  ),
  benchmarkCase(
    'claim-omitted-evidence-scheduler-en',
    'en',
    'claim-omitted-evidence-present',
    'The scheduler uses UTC for all jobs.',
    'Compaction summary: the migration checklist is complete.',
    [
      reference('omitted-evidence-scheduler-en', 'The scheduler uses UTC for all jobs.'),
    ],
    false,
  ),
  benchmarkCase(
    'claim-omitted-evidence-notification-ja',
    'ja',
    'claim-omitted-evidence-present',
    '通知は大阪リージョンから送信されます。',
    '要約: リリースノートの確認が完了しました。',
    [
      reference(
        'omitted-evidence-notification-ja',
        '通知は大阪リージョンから送信されます。',
      ),
    ],
    false,
  ),
  benchmarkCase(
    'claim-omitted-evidence-artifact-en',
    'en',
    'claim-omitted-evidence-present',
    'The artifact path is /srv/artifacts/current.',
    'Summary: the build finished with no warnings.',
    [
      reference(
        'omitted-evidence-artifact-en',
        'The artifact path is /srv/artifacts/current.',
      ),
    ],
    false,
  ),
  benchmarkCase(
    'evidence-missing-token-en',
    'en',
    'evidence-missing',
    'The token expires after 15 minutes.',
    'Compaction summary: authentication settings were reviewed.',
    [
      reference(
        'missing-token-en',
        'The token expires after 15 minutes.',
        'The token expires after 15 minutes.',
        {},
        false,
      ),
    ],
    false,
  ),
  benchmarkCase(
    'evidence-missing-monitor-ja',
    'ja',
    'evidence-missing',
    '監視通知は一時間ごとに送信されます。',
    '要約: 運用手順の確認が完了しました。',
    [
      reference(
        'missing-monitor-ja',
        '監視通知は一時間ごとに送信されます。',
        '監視通知は一時間ごとに送信されます。',
        {},
        false,
      ),
    ],
    false,
  ),
  benchmarkCase(
    'hash-mismatch-service-en',
    'en',
    'hash-mismatch',
    'The service runs in read-only mode.',
    'Summary: no service policy was retained.',
    [
      reference(
        'mismatch-service-en',
        'The service runs in read-only mode.',
        'The service runs in read-only mode.',
        { hashMismatch: true },
      ),
    ],
    false,
  ),
  benchmarkCase(
    'hash-mismatch-index-ja',
    'ja',
    'hash-mismatch',
    'インデックスは三時間ごとに再構築されます。',
    '要約: インデックスの状態は記録されませんでした。',
    [
      reference(
        'mismatch-index-ja',
        'インデックスは三時間ごとに再構築されます。',
        'インデックスは三時間ごとに再構築されます。',
        { hashMismatch: true },
      ),
    ],
    false,
  ),
  benchmarkCase(
    'span-invalid-token-en',
    'en',
    'span-invalid',
    'The token expires after 15 minutes.',
    'Compaction summary: authentication settings were reviewed.',
    [
      reference(
        'invalid-token-en',
        'The token expires after 15 minutes.',
        'The token expires after 15 minutes.',
        { endOffset: 'The token expires after 15 minutes.'.length + 1 },
      ),
    ],
    false,
  ),
  benchmarkCase(
    'span-invalid-key-ja',
    'ja',
    'span-invalid',
    '鍵は🔐毎晩ローテーションされます。',
    '要約: 鍵の管理方針は確認されませんでした。',
    [
      reference(
        'invalid-key-ja',
        '鍵は🔐毎晩ローテーションされます。',
        '鍵は🔐毎晩ローテーションされます。',
        { endOffset: '鍵は🔐毎晩ローテーションされます。'.length + 1 },
      ),
    ],
    false,
  ),
  benchmarkCase(
    'legacy-no-span-endpoint-en',
    'en',
    'legacy-no-span',
    'The staging endpoint requires mTLS.',
    'Compaction summary: staging connectivity was reviewed.',
    [
      reference(
        'legacy-endpoint-en',
        'The staging endpoint requires mTLS.',
        'The staging endpoint requires mTLS.',
        { includeSpan: false },
      ),
    ],
    false,
  ),
  benchmarkCase(
    'legacy-no-span-backup-ja',
    'ja',
    'legacy-no-span',
    'バックアップは暗号化されています。',
    '要約: バックアップ処理が完了しました。',
    [
      reference(
        'legacy-backup-ja',
        'バックアップは暗号化されています。',
        'バックアップは暗号化されています。',
        { includeSpan: false },
      ),
    ],
    false,
  ),
  benchmarkCase(
    'multi-ref-all-resolve-active-en',
    'en',
    'multi-ref-all-resolve',
    'The blue shard is the active shard.',
    'Summary: The blue shard is the active shard.',
    [
      reference('multi-active-en-1', 'The blue shard is the active shard.'),
      reference(
        'multi-active-en-2',
        'Audit confirms: The blue shard is the active shard.',
        'The blue shard is the active shard.',
      ),
    ],
    true,
  ),
  benchmarkCase(
    'multi-ref-all-resolve-active-ja',
    'ja',
    'multi-ref-all-resolve',
    '青いシャードが現在のアクティブシャードです。',
    '要約: 実行ログの整理が完了しました。',
    [
      reference(
        'multi-active-ja-1',
        '確認結果: 青いシャードが現在のアクティブシャードです。',
        '青いシャードが現在のアクティブシャードです。',
      ),
      reference(
        'multi-active-ja-2',
        '監査記録: 青いシャードが現在のアクティブシャードです。',
        '青いシャードが現在のアクティブシャードです。',
      ),
    ],
    false,
  ),
  benchmarkCase(
    'multi-ref-one-missing-rollout-en',
    'en',
    'multi-ref-one-missing',
    'The canary rollout is limited to 10 percent.',
    'Compaction summary: the rollout plan was reviewed.',
    [
      reference(
        'multi-rollout-en-1',
        'The canary rollout is limited to 10 percent.',
      ),
      reference(
        'multi-rollout-en-2',
        'The canary rollout is limited to 10 percent in the first wave.',
        'The canary rollout is limited to 10 percent',
        {},
        false,
      ),
    ],
    false,
  ),
  benchmarkCase(
    'contradictory-later-evidence-en',
    'en',
    'contradictory-later-evidence',
    'The deployment flag is enabled.',
    'Later summary: The deployment flag is disabled.',
    [
      reference('contradiction-original-en', 'The deployment flag is enabled.'),
      reference('contradiction-later-en', 'Later evidence: The deployment flag is disabled.', 'The deployment flag is disabled.'),
    ],
    false,
  ),
];

export const VERIFICATION_CORPUS = VERIFICATION_BENCHMARK_CORPUS;
