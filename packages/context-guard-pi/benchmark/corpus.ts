export type BenchmarkKind =
  | 'goal'
  | 'constraint'
  | 'requirement'
  | 'decision';

export interface BenchmarkItem {
  readonly content: string;
  readonly kind: BenchmarkKind;
  readonly critical: boolean;
}

export interface ExistingAutomaticItem extends BenchmarkItem {
  readonly id: string;
}

export type BenchmarkCaseCategory =
  | 'positive'
  | 'negative'
  | 'mixed'
  | 'supersession';

export interface BenchmarkCase {
  readonly id: string;
  readonly category: BenchmarkCaseCategory;
  readonly message: string;
  readonly existingAutomaticItems: readonly ExistingAutomaticItem[];
  readonly expectedAdds: readonly BenchmarkItem[];
  readonly expectedRetirements: readonly string[];
  readonly expectNoAdds: boolean;
}

export const BENCHMARK_CORPUS = [
  {
    id: 'positive-goal-english-embedded',
    category: 'positive',
    message:
      'For this exercise, I want the final result to produce a concise migration plan for a new teammate.',
    existingAutomaticItems: [],
    expectedAdds: [
      {
        content: 'produce a concise migration plan for a new teammate',
        kind: 'goal',
        critical: true,
      },
    ],
    expectedRetirements: [],
    expectNoAdds: false,
  },
  {
    id: 'positive-goal-japanese-embedded',
    category: 'positive',
    message:
      'この作業では、利用者が迷わない導線を完成させたいです。細部は後で整えます。',
    existingAutomaticItems: [],
    expectedAdds: [
      {
        content: '利用者が迷わない導線を完成させたいです',
        kind: 'goal',
        critical: true,
      },
    ],
    expectedRetirements: [],
    expectNoAdds: false,
  },
  {
    id: 'positive-constraint-english-embedded',
    category: 'positive',
    message:
      'I am happy with the direction, so please keep the public interface unchanged while we refine it.',
    existingAutomaticItems: [],
    expectedAdds: [
      {
        content: 'keep the public interface unchanged',
        kind: 'constraint',
        critical: true,
      },
    ],
    expectedRetirements: [],
    expectNoAdds: false,
  },
  {
    id: 'positive-constraint-japanese-embedded',
    category: 'positive',
    message:
      '念のため、個人情報をログに出さないでください。確認用の表示は別に考えます。',
    existingAutomaticItems: [],
    expectedAdds: [
      {
        content: '個人情報をログに出さないでください',
        kind: 'constraint',
        critical: true,
      },
    ],
    expectedRetirements: [],
    expectNoAdds: false,
  },
  {
    id: 'positive-requirement-english-embedded',
    category: 'positive',
    message:
      'The release note can be short, but the final patch must include a rollback step before review.',
    existingAutomaticItems: [],
    expectedAdds: [
      {
        content: 'the final patch must include a rollback step',
        kind: 'requirement',
        critical: true,
      },
    ],
    expectedRetirements: [],
    expectNoAdds: false,
  },
  {
    id: 'positive-requirement-japanese-embedded',
    category: 'positive',
    message:
      '提出前には、必ずオフラインのテスト結果を確認してください。確認後に短い要約を作ります。',
    existingAutomaticItems: [],
    expectedAdds: [
      {
        content: '必ずオフラインのテスト結果を確認してください',
        kind: 'requirement',
        critical: true,
      },
    ],
    expectedRetirements: [],
    expectNoAdds: false,
  },
  {
    id: 'positive-decision-english-embedded',
    category: 'positive',
    message:
      'After comparing both options, I decided that we will use JSON for the interchange format.',
    existingAutomaticItems: [],
    expectedAdds: [
      {
        content: 'we will use JSON for the interchange format',
        kind: 'decision',
        critical: false,
      },
    ],
    expectedRetirements: [],
    expectNoAdds: false,
  },
  {
    id: 'positive-decision-japanese-embedded',
    category: 'positive',
    message:
      '検討した結果、今回は小さな変更を一つずつ出す方針に決めました。',
    existingAutomaticItems: [],
    expectedAdds: [
      {
        content: '小さな変更を一つずつ出す方針に決めました',
        kind: 'decision',
        critical: false,
      },
    ],
    expectedRetirements: [],
    expectNoAdds: false,
  },
  {
    id: 'positive-goal-english-conversational',
    category: 'positive',
    message:
      'I am trying to make the onboarding note useful to a new teammate, so keep the explanation welcoming.',
    existingAutomaticItems: [],
    expectedAdds: [
      {
        content: 'make the onboarding note useful to a new teammate',
        kind: 'goal',
        critical: false,
      },
    ],
    expectedRetirements: [],
    expectNoAdds: false,
  },
  {
    id: 'positive-constraint-english-conversational',
    category: 'positive',
    message:
      'While we discuss the details, do not change the command names already documented because readers rely on them.',
    existingAutomaticItems: [],
    expectedAdds: [
      {
        content: 'do not change the command names already documented',
        kind: 'constraint',
        critical: true,
      },
    ],
    expectedRetirements: [],
    expectNoAdds: false,
  },
  {
    id: 'positive-requirement-japanese-conversational',
    category: 'positive',
    message:
      '読み手が追いやすいように、各節には見出しを付ける必要があります。順番は後で相談します。',
    existingAutomaticItems: [],
    expectedAdds: [
      {
        content: '各節には見出しを付ける必要があります',
        kind: 'requirement',
        critical: false,
      },
    ],
    expectedRetirements: [],
    expectNoAdds: false,
  },
  {
    id: 'positive-decision-english-conversational',
    category: 'positive',
    message:
      'We reviewed the alternatives over lunch and chose the file-based report format for this benchmark.',
    existingAutomaticItems: [],
    expectedAdds: [
      {
        content: 'chose the file-based report format for this benchmark',
        kind: 'decision',
        critical: false,
      },
    ],
    expectedRetirements: [],
    expectNoAdds: false,
  },
  {
    id: 'positive-goal-japanese-conversational',
    category: 'positive',
    message:
      '今回の目的は、初めて読む人でも手順を最後まで試せる説明にすることです。',
    existingAutomaticItems: [],
    expectedAdds: [
      {
        content: '初めて読む人でも手順を最後まで試せる説明にすること',
        kind: 'goal',
        critical: true,
      },
    ],
    expectedRetirements: [],
    expectNoAdds: false,
  },
  {
    id: 'positive-requirement-english-conversational',
    category: 'positive',
    message:
      'For the result to be reviewable, every case must be recorded with a stable identifier.',
    existingAutomaticItems: [],
    expectedAdds: [
      {
        content: 'every case must be recorded with a stable identifier',
        kind: 'requirement',
        critical: true,
      },
    ],
    expectedRetirements: [],
    expectNoAdds: false,
  },
  {
    id: 'negative-ordinary-question',
    category: 'negative',
    message: 'Could you explain why this approach is useful for a small team?',
    existingAutomaticItems: [],
    expectedAdds: [],
    expectedRetirements: [],
    expectNoAdds: true,
  },
  {
    id: 'negative-greeting',
    category: 'negative',
    message: 'こんにちは、今日は元気ですか。',
    existingAutomaticItems: [],
    expectedAdds: [],
    expectedRetirements: [],
    expectNoAdds: true,
  },
  {
    id: 'negative-formatting-only',
    category: 'negative',
    message: 'Please put the answer in two short paragraphs with a blank line between them.',
    existingAutomaticItems: [],
    expectedAdds: [],
    expectedRetirements: [],
    expectNoAdds: true,
  },
  {
    id: 'negative-code-block-instruction',
    category: 'negative',
    message: 'Here is a sample script:\n```\nDo not delete the cache.\n```',
    existingAutomaticItems: [],
    expectedAdds: [],
    expectedRetirements: [],
    expectNoAdds: true,
  },
  {
    id: 'negative-log-must',
    category: 'negative',
    message: '2026-01-01 INFO check: the service must restart after a timeout.',
    existingAutomaticItems: [],
    expectedAdds: [],
    expectedRetirements: [],
    expectNoAdds: true,
  },
  {
    id: 'negative-quoted-third-party',
    category: 'negative',
    message: 'The reviewer wrote, "Always preserve the old endpoint."',
    existingAutomaticItems: [],
    expectedAdds: [],
    expectedRetirements: [],
    expectNoAdds: true,
  },
  {
    id: 'negative-hypothetical',
    category: 'negative',
    message: 'If we ever publish this note, always include a diagram.',
    existingAutomaticItems: [],
    expectedAdds: [],
    expectedRetirements: [],
    expectNoAdds: true,
  },
  {
    id: 'negative-example-instruction',
    category: 'negative',
    message: 'For example, use a blue heading for this draft.',
    existingAutomaticItems: [],
    expectedAdds: [],
    expectedRetirements: [],
    expectNoAdds: true,
  },
  {
    id: 'negative-rejected-alternative',
    category: 'negative',
    message: 'I considered "keep the old naming" but rejected that alternative.',
    existingAutomaticItems: [],
    expectedAdds: [],
    expectedRetirements: [],
    expectNoAdds: true,
  },
  {
    id: 'negative-documentation-excerpt',
    category: 'negative',
    message: 'Documentation excerpt: A client must send the token in the header.',
    existingAutomaticItems: [],
    expectedAdds: [],
    expectedRetirements: [],
    expectNoAdds: true,
  },
  {
    id: 'mixed-real-quoted-question',
    category: 'mixed',
    message:
      'Please keep the summary under 100 words, but the vendor says "rewrite everything"; could you also tell me whether JSON is readable?',
    existingAutomaticItems: [],
    expectedAdds: [
      {
        content: 'keep the summary under 100 words',
        kind: 'constraint',
        critical: true,
      },
    ],
    expectedRetirements: [],
    expectNoAdds: false,
  },
  {
    id: 'supersession-legacy-api',
    category: 'supersession',
    message:
      'We are changing direction: use the new API contract instead of keeping the legacy API stable.',
    existingAutomaticItems: [
      {
        id: 'auto:constraint:legacy-api',
        kind: 'constraint',
        content: 'keep the legacy API stable',
        critical: true,
      },
    ],
    expectedAdds: [
      {
        content: 'use the new API contract',
        kind: 'constraint',
        critical: true,
      },
    ],
    expectedRetirements: ['auto:constraint:legacy-api'],
    expectNoAdds: false,
  },
  {
    id: 'supersession-streaming-japanese',
    category: 'supersession',
    message:
      '方針を改め、今回はストリーミング処理を採用します。以前のバッチ処理案は取り下げます。',
    existingAutomaticItems: [
      {
        id: 'auto:decision:batch',
        kind: 'decision',
        content: 'バッチ処理を採用する',
        critical: false,
      },
    ],
    expectedAdds: [
      {
        content: '今回はストリーミング処理を採用します',
        kind: 'decision',
        critical: false,
      },
    ],
    expectedRetirements: ['auto:decision:batch'],
    expectNoAdds: false,
  },
  {
    id: 'supersession-report-length',
    category: 'supersession',
    message:
      'The report no longer needs to stay short; include the full rationale so the decision is auditable.',
    existingAutomaticItems: [
      {
        id: 'auto:requirement:short-report',
        kind: 'requirement',
        content: 'keep the report short',
        critical: false,
      },
    ],
    expectedAdds: [
      {
        content: 'include the full rationale',
        kind: 'requirement',
        critical: true,
      },
    ],
    expectedRetirements: ['auto:requirement:short-report'],
    expectNoAdds: false,
  },
  {
    id: 'mixed-supersession-yaml-question',
    category: 'mixed',
    message:
      'Please use YAML for the output now; someone suggested "use XML"; is YAML easy to review?',
    existingAutomaticItems: [
      {
        id: 'auto:constraint:old-format',
        kind: 'constraint',
        content: 'use the old report format',
        critical: true,
      },
    ],
    expectedAdds: [
      {
        content: 'use YAML for the output now',
        kind: 'decision',
        critical: true,
      },
    ],
    expectedRetirements: ['auto:constraint:old-format'],
    expectNoAdds: false,
  },
] satisfies readonly BenchmarkCase[];

export const benchmarkCorpus = BENCHMARK_CORPUS;
