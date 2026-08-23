import type { RecordedSemanticClassification } from './semantic-duplicate-evaluate.js';

/**
 * Classifications recorded from live runs, so every number in the semantic
 * evaluation can be re-derived without calling a provider again.
 *
 * A previous phase lost its measured outputs because the runner stored no model
 * text; these fixtures exist so that cannot happen twice. They hold verdicts
 * only — no prompt, no response text, no session content.
 */

/** openai-codex/gpt-5.6-luna, 30 pairs. */
export const RECORDED_LUNA_SUBSAMPLE: readonly RecordedSemanticClassification[] = [
  { pairId: 'compatible-compiler-properties', classification: 'compatible-distinct' },
  { pairId: 'compatible-eslint-properties', classification: 'compatible-distinct' },
  { pairId: 'compatible-japanese-compiler-properties', classification: 'compatible-distinct' },
  { pairId: 'compatible-japanese-recovery-properties', classification: 'compatible-distinct' },
  { pairId: 'compatible-japanese-redis-properties', classification: 'compatible-distinct' },
  { pairId: 'contradictory-audit-logging', classification: 'contradictory' },
  { pairId: 'contradictory-japanese-network', classification: 'contradictory' },
  { pairId: 'contradictory-japanese-persistence', classification: 'contradictory' },
  { pairId: 'contradictory-japanese-recovery', classification: 'contradictory' },
  { pairId: 'contradictory-mixed-cache-writes', classification: 'contradictory' },
  { pairId: 'duplicate-cache-memory', classification: 'duplicate' },
  { pairId: 'duplicate-compiler-target', classification: 'duplicate' },
  { pairId: 'duplicate-deterministic-results', classification: 'duplicate' },
  { pairId: 'duplicate-eslint-ignores', classification: 'duplicate' },
  { pairId: 'duplicate-explicit-inputs', classification: 'duplicate' },
  { pairId: 'duplicate-japanese-cache', classification: 'duplicate' },
  { pairId: 'duplicate-japanese-compiler-target', classification: 'duplicate' },
  { pairId: 'duplicate-japanese-inputs', classification: 'duplicate' },
  { pairId: 'duplicate-japanese-module-resolution', classification: 'duplicate' },
  { pairId: 'duplicate-japanese-retry', classification: 'duplicate' },
  { pairId: 'same-compiler-target', classification: 'contradictory' },
  { pairId: 'same-environment-logging', classification: 'compatible-distinct' },
  { pairId: 'same-japanese-compiler-target', classification: 'contradictory' },
  { pairId: 'same-japanese-environment-logging', classification: 'compatible-distinct' },
  { pairId: 'same-japanese-package-parser', classification: 'unrelated' },
  { pairId: 'same-japanese-temporal-cache', classification: 'compatible-distinct' },
  { pairId: 'same-japanese-typescript-version', classification: 'compatible-distinct' },
  { pairId: 'unrelated-backup-interface', classification: 'unrelated' },
  { pairId: 'unrelated-compiler-queue', classification: 'unrelated' },
  { pairId: 'unrelated-eslint-redis', classification: 'unrelated' },
];

/** opencode-go/deepseek-v4-flash, 30 pairs. */
export const RECORDED_DEEPSEEK_SUBSAMPLE: readonly RecordedSemanticClassification[] = [
  { pairId: 'compatible-compiler-properties', classification: 'compatible-distinct' },
  { pairId: 'compatible-eslint-properties', classification: 'compatible-distinct' },
  { pairId: 'compatible-japanese-compiler-properties', classification: 'compatible-distinct' },
  { pairId: 'compatible-japanese-recovery-properties', classification: 'compatible-distinct' },
  { pairId: 'compatible-japanese-redis-properties', classification: 'compatible-distinct' },
  { pairId: 'contradictory-audit-logging', classification: 'contradictory' },
  { pairId: 'contradictory-japanese-network', classification: 'contradictory' },
  { pairId: 'contradictory-japanese-persistence', classification: 'contradictory' },
  { pairId: 'contradictory-japanese-recovery', classification: 'contradictory' },
  { pairId: 'contradictory-mixed-cache-writes', classification: 'contradictory' },
  { pairId: 'duplicate-cache-memory', classification: 'duplicate' },
  { pairId: 'duplicate-compiler-target', classification: 'duplicate' },
  { pairId: 'duplicate-deterministic-results', classification: 'duplicate' },
  { pairId: 'duplicate-eslint-ignores', classification: 'duplicate' },
  { pairId: 'duplicate-explicit-inputs', classification: 'duplicate' },
  { pairId: 'duplicate-japanese-cache', classification: 'duplicate' },
  { pairId: 'duplicate-japanese-compiler-target', classification: 'compatible-distinct' },
  { pairId: 'duplicate-japanese-inputs', classification: 'duplicate' },
  { pairId: 'duplicate-japanese-module-resolution', classification: 'duplicate' },
  { pairId: 'duplicate-japanese-retry', classification: 'duplicate' },
  { pairId: 'same-compiler-target', classification: 'same-subject-different' },
  { pairId: 'same-environment-logging', classification: 'compatible-distinct' },
  { pairId: 'same-japanese-compiler-target', classification: 'contradictory' },
  { pairId: 'same-japanese-environment-logging', classification: 'compatible-distinct' },
  { pairId: 'same-japanese-package-parser', classification: 'unrelated' },
  { pairId: 'same-japanese-temporal-cache', classification: 'unrelated' },
  { pairId: 'same-japanese-typescript-version', classification: 'unrelated' },
  { pairId: 'unrelated-backup-interface', classification: 'unrelated' },
  { pairId: 'unrelated-compiler-queue', classification: 'unrelated' },
  { pairId: 'unrelated-eslint-redis', classification: 'unrelated' },
];

/** openai-codex/gpt-5.6-luna, 10 pairs. */
export const RECORDED_LUNA_SESSION: readonly RecordedSemanticClassification[] = [
  { pairId: 'session-workspace-layout', classification: 'compatible-distinct' },
  { pairId: 'session-root-files', classification: 'compatible-distinct' },
  { pairId: 'session-eslint-properties', classification: 'compatible-distinct' },
  { pairId: 'session-compiler-strict-target', classification: 'compatible-distinct' },
  { pairId: 'session-compiler-strict-emit', classification: 'compatible-distinct' },
  { pairId: 'session-compiler-target-emit', classification: 'compatible-distinct' },
  { pairId: 'session-extension-session-compact', classification: 'compatible-distinct' },
  { pairId: 'session-extension-compact-turn', classification: 'compatible-distinct' },
  { pairId: 'session-package-ci', classification: 'compatible-distinct' },
  { pairId: 'session-engine-tests', classification: 'compatible-distinct' },
];

/** openai-codex/gpt-5.6-luna, the ten hardest pairs classified twice. */
export const RECORDED_LUNA_VARIANCE: Readonly<Record<string, readonly string[]>> = {
  'contradictory-audit-logging': ['contradictory', 'contradictory'],
  'contradictory-japanese-network': ['contradictory', 'contradictory'],
  'duplicate-eslint-ignores': ['duplicate', 'duplicate'],
  'duplicate-japanese-compiler-target': ['duplicate', 'duplicate'],
  'duplicate-mixed-offline': ['duplicate', 'duplicate'],
  'duplicate-node-engine': ['duplicate', 'duplicate'],
  'duplicate-offline-evaluation': ['duplicate', 'duplicate'],
  'same-japanese-compiler-target': ['contradictory', 'contradictory'],
  'same-japanese-package-parser': ['unrelated', 'unrelated'],
  'same-japanese-typescript-version': ['compatible-distinct', 'compatible-distinct'],
};
