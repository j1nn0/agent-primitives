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

## Discovery representation benchmark

The discovery benchmark compares three representations for facts captured from tool
output. `synthesized` is the unchanged production prompt and is the control.
`evidence-native` requires each fact content to be one self-contained, contiguous
substring copied from a referenced evidence record. `quote-first` prefers that same
unchanged quote when one is sufficient, but permits minimal synthesis when scope or
multiple evidence records require it. The variants replace only the one production
fact-representation instruction; every other prompt line and the production parser
remain unchanged.

The 27-case corpus is entirely synthetic. Its `semanticKey` values identify expected
fact identity for evaluation only and must never enter a production payload or
production code. The runner stores accepted content in the result artifact only
because the evidence and outputs in this benchmark are synthetic.

The discovery evaluator reports:

- `capture`: the share of expected-capture cases with at least one accepted fact.
- `expectedFactCapture`: the share with at least one fact containing every required
  anchor for that case.
- `anchorCoverage`: among cases that captured, the best fact's present-anchor count
  divided by the total required-anchor count.
- `negativeRejection`: the share of expected-omit cases with no accepted facts.
- `unsupportedCaptureCount`: accepted facts from omit cases, facts containing a
  forbidden keyword, or facts with an out-of-scope evidence reference; the result
  also reports each reason's count.
- `evidenceNativeRate` and `synthesisRate`: exact substring and complementary shares
  over accepted facts. A fact is native only when its content occurs in evidence it
  actually references.
- `structuralGateCapture`: expected-capture cases with a fact that is both anchored
  and evidence-native.
- `duplicateAmplification`: exact content diversity within each evaluation-only
  semantic-key group, with a mean over groups observed at least twice. One is ideal.
  `sameContentRate` is the repeated-exact group's exact-content consistency rate.
- `multiEvidenceUsefulness`: the share of multi-evidence cases with an anchored fact.
- `secretSentinelCount`: accepted facts containing one of the corpus's synthetic
  secret sentinels.

All rates use `{ numerator, denominator, rate }`; an empty denominator reports rate
`1` while retaining denominator `0`. `forbiddenSubstrings` is only a deterministic,
case-insensitive keyword proxy for unsupported wording. It is not semantic matching,
secret detection, or a guarantee that a fact is safe. The live runner makes exactly
one model call per case, with no retries and no provider or model override. Provider
failures are listed and excluded from all quality denominators.

### Request shape

The runner pins one reasoning level for every request. Production omits the reasoning
option entirely, but `pi-ai` then sends the model's `thinkingLevelMap.off` value, which
some providers reject outright; a request that never reaches the model measures nothing.
Every variant uses the same level, so the comparison between representations stays
controlled. This is the only place the benchmark request differs from the production
request.

### Measured result

All three variants were run against the full corpus on one model, one call per case.
Both representation contracts were **rejected**; production still uses `synthesized`.

| metric | synthesized | evidence-native | quote-first |
| --- | --- | --- | --- |
| `capture` | 1.000 | 1.000 | 1.000 |
| `expectedFactCapture` | 0.818 | 0.773 | 0.727 |
| `anchorCoverage` | 0.875 | 0.854 | 0.833 |
| `negativeRejection` | 0.000 | 0.200 | 0.400 |
| `unsupportedCaptureCount` | 5 | 5 | 3 |
| `evidenceNativeRate` | 0.242 | 1.000 | 0.903 |
| `structuralGateCapture` | 0.227 | 0.773 | 0.727 |
| `duplicateAmplification` (reworded group) | 3.0 | 3.0 | 3.0 |
| `duplicateAmplification` (repeated-exact group) | 1.0 | 1.0 | 1.0 |
| `multiEvidenceUsefulness` | 0.000 | 0.000 | 0.000 |
| `secretSentinelCount` | 0 | 0 | 0 |

The decisive number is `duplicateAmplification`. Constraining the representation did not
reduce it at all. When the same fact is observed through differently worded evidence, a
verbatim copy of that evidence is itself differently worded, so exact-content dedupe
misses it exactly as it misses a paraphrase. Identical evidence already deduped perfectly
under every variant. Paraphrase duplication is therefore a property of the evidence, not
of the representation contract.

A follow-up experiment registered eight facts per variant in a real Pi session, forced
compaction, and verified literally. `synthesized` preserved 0 of 8, `evidence-native` 1 of
8, and `quote-first` 1 of 8. Reading the compaction summaries showed why: the summarizer
retains the facts but re-decorates them, most often by wrapping identifiers in backticks,
so `Ledger version 2.3.0 runs with strict mode enabled.` is summarized as
``Ledger version `2.3.0` runs with strict mode enabled.`` and no longer matches literally.
Copying evidence verbatim does not help, because the summarizer reformats regardless.

`evidence-native` also produced context-free content such as `{"version":"3.7.1"}` where a
single quote carried no scope, which is a regression the control does not have.


## Discovery verification policy benchmark

This benchmark keeps four propositions separate:

- **A — context presence:** the registered claim is present in the post-compaction context given to the model.
- **B — evidence resolvability:** the stored provenance can recover its quote from a tool result still reachable on the current branch.
- **C — entailment:** the claim follows from that evidence.
- **D — truth:** the claim remains true in the world.

Verification answers only A. Branch reachability does not tell us what the model can see after compaction, and evidence resolution alone does not establish entailment or continuing truth.

The synthetic benchmark compares five decisions:

- **A, literal only:** the current production control; only a literal match is preserved, and every other result recovers.
- **B, literal or evidence-resolvable:** a missing literal match with resolved evidence is marked `preserved` without recovery.
- **C1:** uses `supported` for a missing literal match with resolved evidence and does not recover that case; other non-literal cases are `unknown` and recover.
- **C2:** uses the same statuses as C1 but still recovers `supported` cases.
- **D, backtick-tolerant literal:** removes U+0060 backticks from the item and context before calling the core literal verifier; it never uses evidence resolution.

Here, `preserved` means the literal content remains in model-visible context. `supported` is not a claim about the model-visible context: it means only that the original evidence is still resolvable on the current branch.

`unsafeNonRecovery` counts cases whose evaluation-only ground truth says the claim is absent from the context fixture but the policy does not recover. A candidate for adoption must have zero of these. `unnecessaryRecovery` counts cases whose fixture ground truth says the claim is present but the policy recovers anyway. Category breakdowns retain the case category for both metrics.

`claimActuallyIncludedByFixture` is evaluation-only ground truth. Runtime cannot know it, so it must never enter a production payload, production decision, or production code. The corpus and every context, evidence record, and outcome in this benchmark are entirely synthetic.

### Measured result

All five decisions were run over the 30-case corpus. No policy was adopted; production
still verifies discovery items with the core literal verifier alone.

| metric | A | B | C1 | C2 | D |
| --- | --- | --- | --- | --- | --- |
| `preserved` | 4 | 21 | 4 | 4 | 7 |
| `supported` | 0 | 0 | 17 | 17 | 0 |
| `lost` | 26 | 9 | 0 | 0 | 23 |
| `unknown` | 0 | 0 | 9 | 9 | 0 |
| `recoveryCount` | 26 | 9 | 9 | 26 | 23 |
| **`unsafeNonRecovery`** | **0** | **8** | **8** | **0** | **0** |
| `unnecessaryRecovery` | 9 | 0 | 0 | 9 | 6 |

Evidence resolution over the corpus: 21 of 30 `resolved`, 3 `unavailable`, 4 `invalid`,
2 `legacy-unresolvable`.

B and C1 fail the safety requirement. Their eight unsafe non-recoveries are three
`claim-omitted`, three `claim-omitted-evidence-present`, one `multi-ref-all-resolve` and
one `contradictory-later-evidence` — every case where the claim is gone from the context
while the evidence still resolves. That is the whole problem in one line: a compaction
does not delete tool-result entries, it only hides them from model context, so evidence
resolution carries no information about whether the claim survived.

C2 is safe but pointless: it recovers exactly the cases A recovers and leaves both metrics
identical to the control, so it adds a status concept and buys nothing.

D is safe and improves the control slightly, but only on the one formatting mode it
targets. Its remaining unnecessary recoveries are two punctuation rewrites, three
paraphrases and one non-backtick formatting change.

### Real Pi observation

A separate run captured four discovery facts from real tool evidence in one Pi session,
then compacted twice. Across both compactions every discovery item was literally lost and
had `resolved` evidence — the signal B and C1 depend on was constant at 100% while the
literal signal was constant at 0%, so it could not have discriminated anything.

The summariser preserved all four claims in meaning but rewrote every one of them:

    registered  The artifact cache is stored at /var/lib/novacache/index.db.
    summary     `cache.txt`: Cache path is `/var/lib/novacache/index.db`.

    registered  Ledger version 2.3.0 runs with strict mode enabled.
    summary     `ledger.txt`: Ledger v2.3.0 uses strict mode.

Backtick tolerance recovers none of these, because the rewriting is not decoration. A
formatting-normalising policy is therefore worth only as much as the next summary's
formatting happens to match, which is not something this package can rely on.
