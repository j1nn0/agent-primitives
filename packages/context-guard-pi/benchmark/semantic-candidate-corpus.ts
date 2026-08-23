import type { SemanticLabel } from './semantic-duplicate-corpus.js';

export type { SemanticLabel } from './semantic-duplicate-corpus.js';

export interface OrderedDiscovery {
  readonly id: string;
  readonly content: string;
  /** Tool that produced the evidence. Real sessions show very few distinct values. */
  readonly toolName: string;
  readonly status: 'active' | 'retired' | 'superseded';
}

export type OrderedScenarioCategory =
  | 'distance-1'
  | 'distance-2'
  | 'distance-5'
  | 'distance-10'
  | 'distance-15'
  | 'distance-25-plus'
  | 'two-duplicate-groups'
  | 'group-of-three'
  | 'hard-negatives-only'
  | 'nearby-same-subject-different'
  | 'inactive-duplicates'
  | 'mixed-distances'
  | 'recorded-session';

export interface OrderedScenario {
  readonly id: string;
  readonly language: 'en' | 'ja' | 'mixed';
  readonly category: OrderedScenarioCategory;
  /** Discoveries in registration order; index is the position. */
  readonly discoveries: readonly OrderedDiscovery[];
  /** Expected duplicate pairs as index pairs into `discoveries`. */
  readonly duplicatePairs: readonly (readonly [number, number])[];
  /** Expected duplicate groups as index lists, for group-level recall. */
  readonly duplicateGroups: readonly (readonly number[])[];
}

/** A live verdict uses this label in addition to the semantic corpus labels. */
export type RecordedSemanticLabel = SemanticLabel | 'not_duplicate';

export const SEMANTIC_CANDIDATE_CORPUS: readonly OrderedScenario[] = [
  {
    id: 'distance-1-en',
    language: 'en',
    category: 'distance-1',
    discoveries: [
      {
        id: 'd1-en-0',
        content: 'The workspace lockfile pins the dependency resolution used by every package.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd1-en-1',
        content: 'The pnpm lockfile fixes the dependency resolution shared by all workspace packages.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd1-en-2',
        content: 'The repository documentation is written in Markdown.',
        toolName: 'read',
        status: 'active',
      },
    ],
    duplicatePairs: [[0, 1]],
    duplicateGroups: [[0, 1]],
  },
  {
    id: 'distance-1-ja',
    language: 'ja',
    category: 'distance-1',
    discoveries: [
      {
        id: 'd1-ja-0',
        content: 'リポジトリの設定は明示的な入力からだけ供給される。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd1-ja-1',
        content: '構成情報は明示された入力だけから提供される。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd1-ja-2',
        content: 'テスト用の設定はパッケージごとに分かれている。',
        toolName: 'bash',
        status: 'active',
      },
    ],
    duplicatePairs: [[0, 1]],
    duplicateGroups: [[0, 1]],
  },
  {
    id: 'distance-2-en',
    language: 'en',
    category: 'distance-2',
    discoveries: [
      {
        id: 'd2-en-0',
        content: 'The CI workflow runs the build before type checking.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd2-en-1',
        content: 'The workflow is triggered for pull requests.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd2-en-2',
        content: 'Continuous integration invokes the build ahead of the typecheck step.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd2-en-3',
        content: 'The example package consumes the built context-guard distribution.',
        toolName: 'read',
        status: 'active',
      },
    ],
    duplicatePairs: [[0, 2]],
    duplicateGroups: [[0, 2]],
  },
  {
    id: 'distance-2-mixed',
    language: 'mixed',
    category: 'distance-2',
    discoveries: [
      {
        id: 'd2-mixed-0',
        content: 'The adapter restores persisted discovery identifiers in their saved order.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd2-mixed-1',
        content: 'セッションの開始時にライフサイクル状態が初期化される。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd2-mixed-2',
        content: 'Persisted discovery ids are restored by the adapter without reordering them.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd2-mixed-3',
        content: 'The compaction hook records a snapshot before delegation.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd2-mixed-4',
        content: '保存された発見IDは並べ替えずにアダプターへ復元される。',
        toolName: 'read',
        status: 'active',
      },
    ],
    duplicatePairs: [[2, 4]],
    duplicateGroups: [[2, 4]],
  },
  {
    id: 'distance-5-ja',
    language: 'ja',
    category: 'distance-5',
    discoveries: [
      {
        id: 'd5-ja-0',
        content: '明示的な入力がない場合、設定値は暗黙に補完されない。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd5-ja-1',
        content: 'ワークスペースには複数の小さなエージェント部品がある。',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd5-ja-2',
        content: 'CIはプルリクエストとmainへのpushで起動する。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd5-ja-3',
        content: 'コンパクション前に現在のスナップショットが保存される。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd5-ja-4',
        content: 'ビルド成果物はサンプル実行前に必要になる。',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd5-ja-5',
        content: '入力を明示しなければ、設定の値は暗黙的に補われない。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd5-ja-6',
        content: 'テストの出力は決定的な順序で比較される。',
        toolName: 'bash',
        status: 'active',
      },
    ],
    duplicatePairs: [[0, 5]],
    duplicateGroups: [[0, 5]],
  },
  {
    id: 'distance-5-third-tool',
    language: 'en',
    category: 'distance-5',
    discoveries: [
      {
        id: 'd5-third-0',
        content: 'The package exports its public entry point through an explicit index file.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd5-third-1',
        content: 'The test command uses the package entry point declared by the workspace.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd5-third-2',
        content: 'The adapter resets active requests when a new session begins.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd5-third-3',
        content: 'The package README documents the no-network privacy default.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd5-third-4',
        content: 'The example imports the context guard through the workspace package.',
        toolName: 'edit',
        status: 'active',
      },
      {
        id: 'd5-third-5',
        content: 'A lifecycle record is materialised when the extension handles a session event.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd5-third-6',
        content: 'The workspace exposes its public package entry through a declared index module.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd5-third-7',
        content: 'The compiler target is configured as ES2023.',
        toolName: 'read',
        status: 'active',
      },
    ],
    duplicatePairs: [[1, 6]],
    duplicateGroups: [[1, 6]],
  },
  {
    id: 'distance-10-en',
    language: 'en',
    category: 'distance-10',
    discoveries: [
      {
        id: 'd10-en-0',
        content: 'The repository has a dedicated Pi adapter package.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd10-en-1',
        content: 'The CI matrix exercises Node.js 22 and Node.js 24.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd10-en-2',
        content: 'The package keeps runtime lifecycle behavior outside the core primitive.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd10-en-3',
        content: 'The root workspace is managed with pnpm.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd10-en-4',
        content: 'The compacted state is loaded when the next session starts.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd10-en-5',
        content: 'The example depends on the built core package.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd10-en-6',
        content: 'No implicit network access is part of the primitive contract.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd10-en-7',
        content: 'The extension has separate hooks for snapshot and compact handling.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd10-en-8',
        content: 'The test configuration includes the package source and test directories.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd10-en-9',
        content: 'The project uses strict TypeScript compiler checks.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd10-en-10',
        content: 'The build output is emitted beneath each package dist directory.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd10-en-11',
        content: 'Both Node.js 22 and Node.js 24 are covered by the continuous-integration matrix.',
        toolName: 'read',
        status: 'active',
      },
    ],
    duplicatePairs: [[1, 11]],
    duplicateGroups: [[1, 11]],
  },
  {
    id: 'distance-10-ja',
    language: 'ja',
    category: 'distance-10',
    discoveries: [
      {
        id: 'd10-ja-0',
        content: 'リポジトリには小さな部品をまとめるワークスペースがある。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd10-ja-1',
        content: 'セッション開始時に保存状態が読み込まれる。',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd10-ja-2',
        content: '設定は明示的な値を通じてだけ渡される。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd10-ja-3',
        content: 'Node.jsの複数のバージョンがCIで検証される。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd10-ja-4',
        content: 'コンパクションの前に状態のスナップショットを作成する。',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd10-ja-5',
        content: 'パッケージのビルド結果はdistに出力される。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd10-ja-6',
        content: 'テスト設定はソースとテストのディレクトリを含む。',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd10-ja-7',
        content: 'コアの機能には暗黙の永続化を含めない。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd10-ja-8',
        content: 'アダプターはライフサイクルイベントを処理する。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd10-ja-9',
        content: '例はワークスペース内のコアパッケージに依存する。',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd10-ja-10',
        content: 'この構成では暗黙のネットワーク通信を許可しない。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd10-ja-11',
        content: 'CIのジョブはビルド後に型検査を実行する。',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd10-ja-12',
        content: '明示した入力だけを設定の供給元として扱う。',
        toolName: 'read',
        status: 'active',
      },
    ],
    duplicatePairs: [[2, 12]],
    duplicateGroups: [[2, 12]],
  },
  {
    id: 'distance-15-mixed',
    language: 'mixed',
    category: 'distance-15',
    discoveries: [
      {
        id: 'd15-mixed-0',
        content: 'The persisted discovery list keeps registration order across a resume.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd15-mixed-1',
        content: 'The package uses a fail-safe default when evidence is uncertain.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd15-mixed-2',
        content: '調査結果は明示された入力として扱われる。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd15-mixed-3',
        content: 'The workspace has no telemetry dependency in its core primitive.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd15-mixed-4',
        content: 'A session event can materialise a lifecycle record.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd15-mixed-5',
        content: 'ビルドの出力先は各パッケージのdistディレクトリである。',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd15-mixed-6',
        content: 'The example is run only after the workspace packages have been built.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd15-mixed-7',
        content: 'Node.js 22 and 24 are both present in the CI matrix.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd15-mixed-8',
        content: '自動保存をコアの責務にしない設計になっている。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd15-mixed-9',
        content: 'The adapter resets pending requests at session start.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd15-mixed-10',
        content: 'ワークスペースの依存関係はロックファイルで固定される。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd15-mixed-11',
        content: 'The test suite is designed to run without provider access.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd15-mixed-12',
        content: 'コンパクションの前に観測状態をスナップショットへ書き出す。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd15-mixed-13',
        content: 'The public package interface accepts explicit serializable inputs.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd15-mixed-14',
        content: 'セッションの復元では既存の登録順を維持する。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd15-mixed-15',
        content: 'Registration order for the persisted discovery list is preserved after resuming.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd15-mixed-16',
        content: 'The repository keeps harness lifecycle behavior in its adapter layer.',
        toolName: 'bash',
        status: 'active',
      },
    ],
    duplicatePairs: [[0, 15]],
    duplicateGroups: [[0, 15]],
  },
  {
    id: 'distance-25-plus-en',
    language: 'en',
    category: 'distance-25-plus',
    discoveries: [
      {
        id: 'd25-en-0',
        content: 'The repository root is managed as a pnpm workspace.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd25-en-1',
        content: 'The workspace is organised around small composable agent primitives.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd25-en-2',
        content: 'The root manifest defines the build script.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd25-en-3',
        content: 'The Pi adapter is kept separate from the core package.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd25-en-4',
        content: 'The test suite runs with strict compiler settings.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd25-en-5',
        content: 'The CI workflow checks pull requests.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd25-en-6',
        content: 'The example package references a workspace dependency.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd25-en-7',
        content: 'The package contract avoids hidden persistence.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd25-en-8',
        content: 'The build emits JavaScript into a package dist directory.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd25-en-9',
        content: 'The lockfile records workspace dependency versions.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd25-en-10',
        content: 'The extension has a hook for session start.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd25-en-11',
        content: 'The lifecycle controller handles compaction.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd25-en-12',
        content: 'The repository documentation describes privacy defaults.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd25-en-13',
        content: 'The adapter can restore persisted state.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd25-en-14',
        content: 'The package examples are included in workspace checks.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd25-en-15',
        content: 'The compiler configuration enables noUncheckedIndexedAccess.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd25-en-16',
        content: 'The CI matrix uses Ubuntu runners.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd25-en-17',
        content: 'The core API returns plain serializable data.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd25-en-18',
        content: 'The example resolves its library through the workspace.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd25-en-19',
        content: 'The package scripts include a typecheck step.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd25-en-20',
        content: 'The adapter records lifecycle state around Pi events.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd25-en-21',
        content: 'The source tree contains separate benchmark assets.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd25-en-22',
        content: 'The repository uses ESM package boundaries.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd25-en-23',
        content: 'The test command is run after building the workspace.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd25-en-24',
        content: 'The extension keeps uncertainty visible to callers.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'd25-en-25',
        content: 'Package documentation lists the supported Node versions.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'd25-en-26',
        content: 'This pnpm workspace is composed of small agent primitives.',
        toolName: 'read',
        status: 'active',
      },
    ],
    duplicatePairs: [[1, 26]],
    duplicateGroups: [[1, 26]],
  },
  {
    id: 'two-duplicate-groups-ja',
    language: 'ja',
    category: 'two-duplicate-groups',
    discoveries: [
      {
        id: 'two-ja-0',
        content: 'CIはビルドの後に型検査を実行する。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'two-ja-1',
        content: 'セッションの復元では保存されたIDを利用する。',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'two-ja-2',
        content: 'パッケージには公開用のエントリーポイントがある。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'two-ja-3',
        content: 'コンパクション前のスナップショットは一時的に保持される。',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'two-ja-4',
        content: 'ビルドを済ませてから型検査を実行するCI構成である。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'two-ja-5',
        content: 'コアパッケージは外部通信を自動では行わない。',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'two-ja-6',
        content: '登録順は保存状態を復元した後も変わらない。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'two-ja-7',
        content: '実行例はビルド済みのパッケージを読み込む。',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'two-ja-8',
        content: 'ライフサイクルのイベントはアダプターが処理する。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'two-ja-9',
        content: '設定ファイルはパッケージのディレクトリに置かれる。',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'two-ja-10',
        content: 'CIではビルド完了後に型チェックを行う。',
        toolName: 'read',
        status: 'active',
      },
    ],
    duplicatePairs: [
      [0, 4],
      [6, 10],
    ],
    duplicateGroups: [
      [0, 4],
      [6, 10],
    ],
  },
  {
    id: 'group-of-three-mixed',
    language: 'mixed',
    category: 'group-of-three',
    discoveries: [
      {
        id: 'three-mixed-0',
        content: 'The adapter restores the discovery registry in registration order.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'three-mixed-1',
        content: 'The build command writes package output to dist.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'three-mixed-2',
        content: '登録された発見はセッション復元時に保持される。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'three-mixed-3',
        content: 'The persisted registry is loaded without changing discovery order.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'three-mixed-4',
        content: 'The example runs against built workspace packages.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'three-mixed-5',
        content: '明示されない状態は自動で推測しない。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'three-mixed-6',
        content: 'The package has a strict TypeScript configuration.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'three-mixed-7',
        content: 'CI runs on Linux hosts.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'three-mixed-8',
        content: 'The discovery list keeps its saved registration order after resume.',
        toolName: 'bash',
        status: 'active',
      },
    ],
    duplicatePairs: [
      [0, 3],
      [0, 8],
      [3, 8],
    ],
    duplicateGroups: [[0, 3, 8]],
  },
  {
    id: 'hard-negatives-only-en',
    language: 'en',
    category: 'hard-negatives-only',
    discoveries: [
      {
        id: 'negative-en-0',
        content: 'The compiler target is ES2023.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'negative-en-1',
        content: 'The runtime requirement starts at Node.js 22.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'negative-en-2',
        content: 'The CI job is named after the package build.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'negative-en-3',
        content: 'The example loads the core dependency from the workspace.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'negative-en-4',
        content: 'The adapter listens for a session start event.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'negative-en-5',
        content: 'The lockfile includes development dependencies.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'negative-en-6',
        content: 'The benchmark keeps measurements separate from runtime behavior.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'negative-en-7',
        content: 'The README explains how to build before running examples.',
        toolName: 'bash',
        status: 'active',
      },
    ],
    duplicatePairs: [],
    duplicateGroups: [],
  },
  {
    id: 'nearby-same-subject-different-ja',
    language: 'ja',
    category: 'nearby-same-subject-different',
    discoveries: [
      {
        id: 'nearby-ja-0',
        content: 'Node.js 22がCIの最初の実行環境である。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'nearby-ja-1',
        content: 'Node.js 24もCIの検証対象に含まれる。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'nearby-ja-2',
        content: 'ビルド処理は型検査より先に実行される。',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'nearby-ja-3',
        content: '型検査はビルド成果物を作る処理ではない。',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'nearby-ja-4',
        content: 'セッション開始では既存の要求が中断される。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'nearby-ja-5',
        content: 'コンパクション開始前には別のスナップショットを取得する。',
        toolName: 'read',
        status: 'active',
      },
    ],
    duplicatePairs: [],
    duplicateGroups: [],
  },
  {
    id: 'inactive-duplicates-mixed',
    language: 'mixed',
    category: 'inactive-duplicates',
    discoveries: [
      {
        id: 'inactive-mixed-0',
        content: 'The release manifest is generated before publishing.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'inactive-mixed-1',
        content: 'The release manifest is generated before publishing.',
        toolName: 'bash',
        status: 'retired',
      },
      {
        id: 'inactive-mixed-2',
        content: 'Publishing starts only after generating the release manifest.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'inactive-mixed-3',
        content: 'The release checklist requires a dry run before publishing.',
        toolName: 'read',
        status: 'superseded',
      },
      {
        id: 'inactive-mixed-4',
        content: 'A dry run is required by the release checklist before publishing.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'inactive-mixed-5',
        content: 'The package records whether a lifecycle event has completed.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'inactive-mixed-6',
        content: 'The test command is deterministic across repeated runs.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'inactive-mixed-7',
        content: 'The adapter leaves uncertain evidence visible to its caller.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'inactive-mixed-8',
        content: 'The registry is persisted without adding capture timestamps.',
        toolName: 'read',
        status: 'active',
      },
    ],
    duplicatePairs: [
      [0, 1],
      [0, 2],
      [1, 2],
      [3, 4],
    ],
    duplicateGroups: [
      [0, 1, 2],
      [3, 4],
    ],
  },
  {
    id: 'mixed-distances-ja',
    language: 'mixed',
    category: 'mixed-distances',
    discoveries: [
      {
        id: 'mixed-ja-0',
        content: 'The package build is required before consumers resolve its dist output.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'mixed-ja-1',
        content: 'ビルド成果物がないと利用側はパッケージを解決できない。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'mixed-ja-2',
        content: 'The core primitive accepts explicit inputs only.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'mixed-ja-3',
        content: 'The lifecycle adapter is responsible for session hooks.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'mixed-ja-4',
        content: '登録順は検索の近さを示すだけで、事実の新しさではない。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'mixed-ja-5',
        content: 'The test setup uses a no-network environment.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'mixed-ja-6',
        content: 'コンパクション後に保存状態を復元する。',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'mixed-ja-7',
        content: 'The package only persists values through explicit lifecycle inputs.',
        toolName: 'read',
        status: 'active',
      },
      {
        id: 'mixed-ja-8',
        content: 'The workspace keeps the test fixtures beside the package.',
        toolName: 'bash',
        status: 'active',
      },
      {
        id: 'mixed-ja-9',
        content: 'Consumers need the package build before they can resolve its dist files.',
        toolName: 'read',
        status: 'active',
      },
    ],
    duplicatePairs: [
      [0, 1],
      [0, 9],
    ],
    duplicateGroups: [[0, 1, 9]],
  },
];

export const SEMANTIC_CANDIDATE_SCENARIOS = SEMANTIC_CANDIDATE_CORPUS;
