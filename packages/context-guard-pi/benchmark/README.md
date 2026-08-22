# Context Guard benchmark

This directory contains the corpus, offline evaluator, and live runner for the Pi
extraction benchmark. It is measurement-only: the extractor and its prompt remain in
`src/` and are not changed by benchmark work.

## Span target

An expected span is the smallest contiguous substring of the user message that still
expresses the complete durable instruction on its own, excluding politeness, discourse
markers, the reason the user gives, and any surrounding context that is not needed to
preserve the instruction's meaning.

The smallest span is the right target for this product because a protected item is
verified literally against a compacted context. A shorter span is more likely to survive
a summary verbatim than a long one carrying its original framing.

Expected and actual item contents are located with `message.indexOf(content)`. Offsets
are JavaScript string offsets (UTF-16 code units) on both sides. The first occurrence is
used when a content string occurs more than once. A content string that is not found is
invalid for matching and is counted as unmatched; it never causes evaluation to throw.

For located half-open spans `[start, end)`, the evaluator reports `exact`,
`actual-super-span`, `actual-sub-span`, `partial-overlap`, or `disjoint`. These relations
use only offset arithmetic. There is no normalization, text similarity, fuzzy matching,
or semantic matching.

For each case, all non-disjoint expected/actual candidate pairs are sorted by relation
(`exact`, containment, then partial overlap), overlap length descending, expected index,
and actual index. The evaluator walks that total ordering and accepts a pair only when
both items are still unused. Thus matching is deterministic and one-to-one.

## Reported metrics

The evaluator returns rate objects with `numerator`, `denominator`, and `rate` fields.
An empty denominator follows the existing evaluator convention and reports a rate of
`1` while retaining denominator `0`.

- `strictItem` keeps the original exact item metric: kind and content must both match.
- `detection` uses the one-to-one span matching and ignores kind.
- `spanRates` reports exact, super-span, sub-span, and partial-overlap shares over matched
  pairs.
- `kindAccuracy` and `kindConfusionMatrix` use matched pairs only.
- `critical` reports matched-pair critical precision, recall, accuracy, plus explicit
  `falseCritical` and `missedCritical` counts.
- `negativeRejection` measures zero-add outputs among cases with `expectNoAdds`.
- `retirements` retains aggregate retirement precision and recall. The
  `supersession.replacementDetection` rate reports the share of supersession cases whose
  expected replacement was detected.

Provider failures are listed by case id and excluded from quality denominators. The live
runner makes one model call per case without retries. Its per-case stdout record contains
only the case id, outcome, elapsed milliseconds, added count, and retired count.

The JSON result records the active model's id and provider, metrics, case ids, and kinds
only. It does not store model text, provider errors, or corpus content. This directory is
also intentionally excluded from the published package tarball.
