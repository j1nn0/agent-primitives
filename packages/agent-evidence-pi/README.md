# @j1nn0/agent-evidence-pi

## What it is

`@j1nn0/agent-evidence-pi` is a minimal Pi harness adapter for maintaining caller-declared claims and evidence in the current session. It provides one human command namespace, `/agent-evidence`, and seven explicit model-callable tools. The adapter records only values supplied by a caller or model and judges them only when explicitly asked.

## Relationship to the core

`@j1nn0/agent-evidence` is the harness-agnostic core primitive. **Every judgment delegates to its `judgeEvidence(...)` function.** The adapter does not reimplement claim or evidence semantics and never stores a verdict or any other derived value.

Before every successful claim add/remove, evidence add/replace/remove, or confirmed clear, the adapter builds the complete candidate `{ claims, evidence }` state and calls `judgeEvidence({ claims, evidence })` in a guarded validation step. The returned verdict is discarded. If the core rejects the candidate, the mutation is rejected, the current state is unchanged, and no session entry is appended. This makes the core validator authoritative without duplicating its rules in the adapter.

The adapter is tested against `@earendil-works/pi-coding-agent` `0.84.4`. Its Pi peer dependency intentionally remains wide (`*`).

## Installation

Install the published adapter from the registry:

```sh
pi install npm:@j1nn0/agent-evidence-pi
```

Add `-l` to install it project-locally instead of for your user.

### From a local checkout (development)

For development or local use, build from the repository root, then install the package by absolute path:

```sh
PACKAGE_DIR=/abs/path/to/agent-primitives/packages/agent-evidence-pi
pnpm install
pnpm --filter @j1nn0/agent-evidence-pi build
pi install "$PACKAGE_DIR" -l
```

For a one-run load without installing it in Pi settings:

```sh
pi -e "$PACKAGE_DIR/dist/extension.js"
```

The package manifest also advertises `./dist/extension.js` through Pi's `pi.extensions` entry.

## Commands

The extension registers exactly one command namespace, `/agent-evidence`. A bare command is the same as `status`:

```text
/agent-evidence
/agent-evidence status
/agent-evidence claim add <id> --require <evidenceId> [--subject <value>] [--require <evidenceId> [--subject <value>] ...]
/agent-evidence claim remove <id>
/agent-evidence evidence add <id> <confirmed|refuted|unknown> [subject <value>]
/agent-evidence evidence replace <id> <confirmed|refuted|unknown> [subject <value>]
/agent-evidence evidence remove <id>
/agent-evidence judge
/agent-evidence clear
/agent-evidence clear --yes
```

Claim requirements use repeatable flags. Each `--require` starts a new requirement, and an immediately following `--subject` attaches to the most recent requirement. At least one `--require` is required; unknown tokens, a subject without a preceding requirement, or a duplicate subject flag are usage errors. Claim `--subject` values are single tokens, while model tools accept arbitrary non-empty subject strings. Evidence command subjects consume the remaining tokens after the `subject` marker and join them with single spaces.

`status` and the bare command show the exact same raw summary as `agent_evidence_get`. They do not judge. `judge` explicitly delegates to the core and prints one human-readable line per claim followed by compact verdict JSON. `clear` requires `--yes` and is human-command-only.

## Tools

The model can use exactly these seven tools:

| Tool | Parameters | Behavior |
| --- | --- | --- |
| `agent_evidence_get` | none | Returns the raw, non-judging summary for the current session. |
| `agent_evidence_add_claim` | `id` required string; `requires` required array with at least one `{ evidenceId, subject? }` | Adds one caller-declared claim after core validation. |
| `agent_evidence_remove_claim` | `id` required string | Removes one claim after core validation. |
| `agent_evidence_add_evidence` | `id` and `outcome` required; `subject` optional | Adds one caller-declared evidence record after core validation. |
| `agent_evidence_replace_evidence` | `id` and `outcome` required; `subject` optional | Replaces an existing evidence record wholesale; an omitted subject clears it. |
| `agent_evidence_remove_evidence` | `id` required string | Removes one evidence record after core validation. |
| `agent_evidence_judge` | none | Explicitly delegates judgment to `judgeEvidence(...)` and returns formatted human lines plus compact JSON. |

The outcome vocabulary is exactly `confirmed`, `refuted`, or `unknown`, case-sensitively. The adapter does not collect evidence automatically, execute commands, generate claims or subjects, judge automatically, map to other primitives, or verify truth. Judgment happens only when `agent_evidence_judge` or the human `judge` command is explicitly called.

## Session model

Claims and evidence have an explicit lifecycle. A caller adds, replaces, or removes records and explicitly asks for a judgment when it needs one. Adding evidence does not judge existing claims, and adding a claim does not judge the new claim. There is no automatic evidence collection from tool results, exit codes, files, git state, prompts, or model responses.

## Claim semantics

A claim has a caller-supplied `id` and a non-empty `requires` array. Each requirement names one evidence identifier and may include an opaque subject. Claim identifiers and evidence identifiers must be unique within their respective collections; duplicate identifiers and empty requirements are rejected by the core validator.

Phase 1 deliberately has no claim-replace operation. To change a claim's requirements, remove the claim and then add the replacement claim. There is also no model-facing clear tool.

## Evidence semantics

An evidence record has a caller-supplied identifier, one exact outcome from:

```ts
'confirmed' | 'refuted' | 'unknown'
```

`add` creates a new identifier and rejects duplicates. `replace` requires an existing identifier and replaces the outcome and subject as a whole; omitting `subject` removes it. `remove` deletes the record instead of replacing it with an unknown outcome. If a removed record is referenced by a claim, that claim remains stored and reports `missing_evidence` the next time it is explicitly judged, until the evidence is replaced or another claim is recorded.

## Subject identity

Subjects are caller-supplied opaque identity values. The core compares them exactly when a requirement supplies one; the adapter never normalizes, infers, or auto-fills a subject. A subject mismatch is a semantic identity mismatch, not freshness or truth verification. In particular, the adapter never reads git HEAD, file hashes, timestamps, or other ambient data to decide a subject.

## Judge UX

Judgment is explicit only. A result is shown in the core's claim order using lines like these, followed by one compact JSON line containing the complete verdict:

```text
Agent Evidence verdict:
[ok] release-ready
[!!] api-stable contradicted by api-check
[..] docs-current unsupported (missing_evidence: docs-check)
{"claims":[{"claimId":"release-ready","outcome":"supported"},{"claimId":"api-stable","outcome":"contradicted","evidenceId":"api-check"},{"claimId":"docs-current","outcome":"unsupported","reason":"missing_evidence","evidenceId":"docs-check"}]}
```

The adapter does not display a judgment during status, get, or any mutation. Neither explicit judge operation appends a session entry.

## Persistence and sessions

The adapter persists one raw snapshot per state-changing operation as a Pi custom session entry with custom type `agent-evidence-state` and schema version `1`:

```text
{
  schemaVersion: 1,
  claims: [
    { id: 'release-ready', requires: [{ evidenceId: 'api-check', subject: 'v2' }] }
  ],
  evidence: [
    { id: 'api-check', outcome: 'confirmed', subject: 'v2' }
  ]
}
```

Only raw claims, requirements, evidence records, outcomes, and caller-supplied subjects are stored. Optional `subject` keys are omitted when absent. Verdicts, counts, readings, and other derived values are never persisted.

On `session_start`, the adapter selects the newest matching custom entry in the current Pi branch and validates its envelope strictly. Wrong schema versions, non-array collections, duplicate identifiers, malformed nested objects, explicit undefined optional fields, and unexpected top-level keys are invalid. A malformed newest entry produces one warning—`Agent Evidence: persisted state was invalid; starting with fresh state.`—then starts with an empty state. It is not repair-appended, and an older valid entry is never used as a fallback. A branch with no matching entry starts fresh without a warning. New sessions are isolated and do not use unrelated branch entries.

Round-trip restoration, including absent subjects remaining absent through JSON serialization, is tested against Pi `0.84.x` behavior.

## Clear semantics

`clear` is a human-only operation. Without `--yes` it warns and changes nothing. `/agent-evidence clear --yes` validates the empty candidate state, then wipes both claims and evidence and appends exactly one entry only when something existed. Clearing an already-fresh state is a no-op and appends nothing.

## Relationship to Progress

This adapter never reads Progress state and never maps Progress milestones or verdicts automatically. A caller may use a Progress observation when deciding what to declare, but the declaration and any later evidence judgment remain explicit.

## Relationship to Retry Guard

This adapter never reads Retry Guard state, starts retries, or maps an evidence verdict to a retry decision. A caller may consume a verdict when making a separate Retry Guard declaration, but there is no automatic integration.

## Relationship to Agent State

This adapter never reads or writes Agent State and does not map evidence records or verdicts to state transitions. The two adapters retain independent session entries and explicit lifecycles.

## Relationship to Context Guard

This adapter never injects evidence or verdicts into context and does not change Context Guard policy. Loading the adapter does not change prompt construction or context decisions.

## Future Handoff

A future handoff or orchestration layer may consume an explicitly requested verdict as one input to a handoff packet. This phase provides no handoff mapping, completion decision, persistence outside Pi sessions, or automatic transfer of evidence.

## What the adapter does not know or do

The adapter does not know whether caller-declared evidence is true, whether a subject is fresh, whether an identifier has real-world meaning, or whether a claim is safe to act on. It does not call providers or models, make network calls, execute commands, inspect tool results or exit codes, collect telemetry, inject context, generate claims, generate subjects, or verify external truth.

## No automatic retry or completion

This package does not retry work, choose a retry strategy, declare task completion, or turn a supported claim into a completion signal. Explicit judgment is information for a caller; it is not an automatic action.

## Coexistence with the other Pi adapters

This adapter can be loaded alongside the four existing adapters. It uses independent namespaces:

| Adapter | Command | Tools | Session entry |
| --- | --- | --- | --- |
| Context Guard Pi | `/context-guard` | none | `agent-context-guard-state` |
| Agent State Pi | `/agent-state` | `agent_state_*` | `agent-state-state` |
| Agent Progress Pi | `/agent-progress` | `agent_progress_*` | `agent-progress-state` |
| Agent Retry Guard Pi | `/agent-retry` | `agent_retry_*` | `agent-retry-state` |
| Agent Evidence Pi | `/agent-evidence` | `agent_evidence_*` | `agent-evidence-state` |

It has no dependency on the other adapters, does not merge their state, and does not map their verdicts or entries.

## Limitations

Version 0.1 supports one active snapshot per Pi session and no cross-session store. Generic core rejection messages surface as invalid-mutation warnings. The CLI subject grammar is single-token for claim requirements, while tools can carry arbitrary non-empty strings. Claims use all-of requirements only; there is no any-of logic, alternative evidence set, temporal freshness check, provenance verification, automatic collector, or claim-replace operation.
