# @j1nn0/agent-context-guard-pi

## What

`@j1nn0/agent-context-guard-pi` is a Pi extension that checks whether explicitly protected context survives a Pi compaction. It connects the core context guard to Pi's session and compaction lifecycle, persists the protected registry in the Pi session, reports verification results, and can optionally restore critical items.

> **Defaults:** `default verifier = literal` · `default recovery = off` · `default extraction = off` · `default discovery = off`

The extension uses the core guard's built-in literal verifier. It checks normalized literal presence, not semantic equivalence. A constraint can be paraphrased while preserving its meaning and still be reported as lost. This is exactly why automatic recovery is off by default.

## Relationship to core

`@j1nn0/agent-context-guard` is the decision engine: it stores context items, creates snapshots, and produces verification reports. This package is the Pi harness adapter: it registers the protected items through Pi commands, captures snapshots around Pi compaction, projects the post-compaction context, invokes the verifier, persists state, and optionally injects recovery content.

Installing the core package alone does not observe a running agent. Installing this adapter is what connects the core decision to Pi lifecycle events.

## Why a harness adapter is required

The core guard does not know when a harness is about to compact, which messages form the effective context afterward, where session state is stored, or how recovered context should be delivered. Those are Pi-specific concerns. The adapter listens to Pi events and supplies the core guard with a snapshot and a candidate context at the appropriate boundary.

## Installation

This package is **not currently published to npm**. For local development, build it from the repository root and install the package by local path:

```sh
pnpm install
pnpm --filter @j1nn0/agent-context-guard-pi build
pi install "$(pwd)/packages/context-guard-pi"
```

Pi also supports a one-run, temporary load without adding the package to settings:

```sh
pi -e "$(pwd)/packages/context-guard-pi"
```

When a published release is available, the Pi npm package syntax is:

```sh
pi install npm:@j1nn0/agent-context-guard-pi
```

## Pi configuration

The package advertises its extension through the `pi` manifest key in its `package.json`:

```json
{
  "pi": {
    "extensions": ["./dist/extension.js"]
  }
}
```

The path is relative to the package root. Pi loads the extension automatically after the package is installed.

By default, `pi install` writes to the user settings file at `~/.pi/agent/settings.json`. Use `-l` (or `--local`) to write a project setting at `.pi/settings.json` instead:

```sh
# From the repository root; keeps this package configured for this project.
pi install -l "$(pwd)/packages/context-guard-pi"

# Writes the user-level setting instead.
pi install "$(pwd)/packages/context-guard-pi"
```

A project setting can be shared with the project, while a user setting applies to the user's Pi sessions. The absolute local path also avoids ambiguity because Pi resolves local path references relative to the settings file. The npm form is equivalent after a release is published:

```sh
pi install -l npm:@j1nn0/agent-context-guard-pi
```

## Commands

The extension registers the `/context-guard` command. Its complete usage is:

```text
Usage: /context-guard add <id> <kind> [--critical] <content...> | list | remove <id> | clear [--yes] | status | recovery [off|critical] | extraction [off|automatic] | discovery [off|automatic]
```

The supported item kinds are `goal`, `constraint`, `requirement`, `decision`, and `fact`. Automatic extraction uses only `goal`, `constraint`, `requirement`, and `decision`; it never creates `fact` items.

| Command | Behaviour |
| --- | --- |
| `/context-guard add <id> <kind> [--critical] <content...>` | Adds one protected item. `<id>` and `<kind>` are single non-whitespace arguments. Put `--critical` before the content to include the item in critical-failure recovery. The remaining content must be non-empty and is stored as entered, except that one trailing ASCII space is removed. A duplicate id is rejected. |
| `/context-guard list` | Lists the registered items, including their ids, `[manual]`, `[auto]`, or `[discovery]` provenance markers, kinds, critical markers, and content. Discovery items may also show their evidence-reference count and tool names; quotes are never shown. It accepts no extra arguments. |
| `/context-guard remove <id>` | Removes one item by id and accepts exactly one id. |
| `/context-guard clear` | Does not delete anything. It shows the number of items that would be deleted and asks you to run `/context-guard clear --yes`. |
| `/context-guard clear --yes` | Deletes all protected items after explicit confirmation. `--yes` must be the complete argument. |
| `/context-guard status` | Shows item, critical, manual, automatic, and discovery counts; recovery, extraction, and discovery modes; degraded-state status; the last-extraction and last-discovery summaries; and the latest verification summary. It accepts no extra arguments. |
| `/context-guard recovery [off\|critical]` | Sets recovery to `off` or `critical`. One of those two arguments is required; an omitted or invalid value shows usage. |
| `/context-guard extraction [off\|automatic]` | With no argument, prints the current extraction mode. With `off` or `automatic`, disables or enables automatic extraction. An invalid value shows usage. |
| `/context-guard discovery [off\|automatic]` | With no argument, prints the current discovery mode. With `off` or `automatic`, disables or enables agent discovery capture. An invalid value shows usage. |

A successful add, remove, clear, recovery-mode change, extraction-mode change, or discovery-mode change is persisted and clears the pending pre-compaction snapshot. Automatic extraction and discovery mutations are also persisted and clear that snapshot. Duplicate adds, invalid commands, and an already-selected mode do not change state. Invalid syntax or an unknown kind reports usage without mutating the registry.

### Worked example

```text
/context-guard add phpstan goal --critical Keep phpstan passing before completing the change.
/context-guard add public-api constraint --critical Preserve the public API unless a change is explicitly requested.
/context-guard add baseline constraint --critical Keep the existing baseline valid.
/context-guard status
```

The status command reports the three registered items and their critical count. On a Pi compaction, the extension captures the pre-compaction snapshot, then verifies the effective context on the first context event after compaction. It sends a counts-only notification such as preserved, lost, and critical-failure counts; it does not automatically restore anything while recovery is off.

To opt in to restoration of critical failures:

```text
/context-guard recovery critical
```

## Recovery modes

- **`off` (default):** report verification results but inject nothing, even when critical items are lost.
- **`critical`:** after verification, select only the ids in `report.criticalFailures`. For those ids, the extension takes content from the pre-compaction snapshot and creates one hidden custom recovery message. The message is returned for the imminent context and is also sent to Pi for persistence after the handler returns.

Recovery is one message per compaction. It does not fire twice for the same compaction, and a later compaction can recover again. If there are no critical failures, no recovery message is created.

## Automatic extraction

Automatic extraction is an opt-in adapter feature and is **off by default**. When enabled, it examines eligible user messages for durable protected context and can add or retire automatic items. It runs only for a non-empty, non-slash message received from the interactive or RPC input source while a model is selected; it does not run for extension input.

It is opt-in because each eligible message causes exactly one additional model request. That request adds model usage and latency to the user turn. Disabling extraction stops those requests:

```text
/context-guard extraction automatic
/context-guard extraction off
/context-guard extraction
```

The first command enables extraction, the second disables it, and the bare command prints the current mode. Changing the mode is persisted and clears any pending pre-compaction snapshot, just like the other adapter mutations.

### What is extracted

The extractor looks only for durable instructions that must remain true in later turns:

- goals;
- constraints;
- requirements; and
- decisions.

It never creates `fact` items. It is deliberately instructed not to extract questions, greetings, one-off requests, formatting preferences, text inside code blocks or logs, quoted third-party or example instructions, hypothetical instructions, or anything the user has not adopted as their own. When uncertain, it should omit the item.

Every new item's content must be an **exact contiguous substring** of the current user message, copied character for character. A paraphrase is rejected by the adapter. This keeps the core literal verifier meaningful after compaction: an automatically protected item still has literal source wording that can be checked, rather than a model-generated paraphrase that could not be verified literally.

### Authority and supersession

Manual items are authoritative. Automatic extraction can never delete, rewrite, re-kind, or re-flag a manual item. It can only retire ids recorded as automatic provenance created by the adapter itself. A later message retires an automatic item only when it explicitly withdraws, replaces, or reverses that item; an unrelated message cannot retire it. New automatic items are deduplicated against both manual and automatic items, and a digest-id collision is probed without overwriting the existing item.

The `/context-guard list` output marks each line with `[manual]`, `[auto]`, or `[discovery]`. Discovery lines may include an evidence-reference count and tool names, but never quotes. `/context-guard status` reports the manual, automatic, and discovery counts, both automatic modes, and short last-extraction and last-discovery summaries in addition to the existing recovery and verification information.

### Persistence and privacy

Automatic extraction provenance is stored in the package's persisted state schema v4. The state stores the extraction mode and adapter-side `autoItemIds` provenance alongside the protected items and discovery metadata. A valid v1 state still loads normally, with extraction and discovery off and every loaded item treated as manual. A valid v2 state preserves extraction and automatic provenance while adding discovery off with empty discovery metadata; unknown automatic ids are ignored. A malformed latest state remains fail-safe and does not fall back to an older entry.

On an eligible message, the provider receives the fixed extractor system prompt plus one user payload containing only:

- the current user message text; and
- the existing automatic items, each with only its `id`, `kind`, and `content`.

The adapter never sends manual item content as registry data, the session transcript, tool results, candidate effective context, files, or compaction summaries to the extractor. The extractor call is a single completion request; it does not create a session entry or hidden agent turn.

### Reasoning level of auxiliary requests

Automatic extraction and automatic discovery each make one small auxiliary completion request. Where the active model would otherwise be sent its `off` thinking mapping, the adapter instead asks for the lowest reasoning level that model's own metadata declares. Extraction and discovery are classification work, so the cheapest declared level is the right ask, and naming a level explicitly is necessary because some OpenAI-compatible gateways reject the `off` mapping Pi sends when the option is omitted.

This applies only to those two auxiliary requests. It does not read, change, or depend on the reasoning level of your own agent turns.

### When extraction does not finish

The extraction request is given 20 seconds. If it has not answered by then it is abandoned and the registry is left alone.

A request can also outlive the session that started it, because Pi neither waits for nor cancels an extension handler when a session is replaced. The adapter aborts an in-flight extraction when the session ends, and — because a provider is free to ignore that — it also checks before applying anything that the answer still belongs to the session and registry that asked for it. A result that arrives too late is discarded silently: the session it was for no longer exists, so there is nothing to report.

Every other failure — a timeout, a provider error, an unusable response, or output that breaks the extraction contract — leaves the registry untouched, keeps the agent turn running, and shows one short warning. The provider's error text is never displayed. `/context-guard status` names the category of the last failure, for example `Last extraction: failed (provider).`, and nothing else about it.

### Worked example

For example:

```text
/context-guard extraction automatic
```

The user then sends one message containing these three lines:

```text
Upgrade PHPStan to level 3.
Do not modify public APIs.
Do not use a baseline.
```

Finally, the user runs:

```text
/context-guard list
```

A possible list result (using `goal` for the first line and `constraint` for the other two) is:

```text
auto:goal:6375d161a2e0 [auto] [goal]: Upgrade PHPStan to level 3.
auto:constraint:db02c3d86494 [auto] [constraint]: Do not modify public APIs.
auto:constraint:de7a14169917 [auto] [constraint]: Do not use a baseline.
```

The exact kinds are selected by the active model, but every accepted content string must still obey the exact-source rule.

### Extraction limitations and secrets

This feature is LLM-based. It can produce false positives, miss durable instructions (false negatives), and behave differently with different active models; it must not be treated as a guarantee that it will find every important instruction. Keep the existing guidance: **do not register secrets in protected items**. The extractor is not a secret detector and cannot prevent a user from writing a secret into an ordinary instruction.

## Agent discovery capture

Agent discovery is a second, deliberately lower-authority source of protected context. It watches eligible Pi tool-result evidence and asks the active model to synthesize durable `fact` items that a later session might otherwise have to rediscover. It is **off by default**. User intent remains authoritative: automatic extraction handles user-authored goals, constraints, requirements, and decisions, while discovery may only add facts that are structurally backed by tool evidence.

### Evidence boundary

Only a tool result containing text content blocks is eligible. The adapter concatenates the text blocks for that tool result and identifies the record by its Pi `toolCallId`. An assistant message is never evidence, and an assistant message alone can never produce a discovery. User messages, custom messages including Context Guard's recovery messages and notifications, compaction summaries, branch summaries, and any non-text block such as an image or binary content are also never collected.

At `turn_end`, an eligible automatic-discovery turn makes at most one extra model request. The provider receives the fixed discovery prompt and only the bounded evidence records labelled `e1`, `e2`, and so on, with each record's tool name and text. It does not receive assistant text, user messages, manual protected-item content, automatic user-intent item content, the session transcript, compaction or branch summaries, uncollected files, or binary content. If discovery is off, there is no extra request; a turn with no eligible tool evidence also makes no discovery request.

### Evidence-backed acceptance

A candidate batch is accepted atomically only when it is JSON in the discovery contract, contains at most four entries, uses only `fact`, keeps each claim within 500 Unicode code points, and gives every fact at least one evidence reference. Every reference must name a record that was actually sent and quote an exact contiguous substring of that record, copied character for character. An invalid candidate rejects the whole batch, so a valid candidate is not partially applied alongside a bad one.

The exact-quote gate structurally prevents the model from fabricating a source that was not supplied to it. It does **not** prove that the claim follows from the quote: the fact is still model-synthesized, and the adapter performs no semantic entailment check. An observed failure can be registered as a fact; an inferred root cause is not established merely by this gate. Phase 1 captures only `fact`. The agent can never create `goal`, `constraint`, `requirement`, or `decision` items through discovery; those remain user-authority kinds.

Evidence bounds are applied before the request: the turn keeps at most the first 8 evidence records, skips an individual evidence text longer than 4,000 characters rather than truncating it, and stops adding records when the total collected evidence payload would exceed 24,000 characters. Skipping is intentional: a fact synthesized from an invisible cut-off fragment could appear supported while omitting the part that changes its meaning.

### Enabling discovery and registration

Inspect or change the persisted mode with the exact commands:

```text
/context-guard discovery
/context-guard discovery automatic
/context-guard discovery off
```

Accepted discoveries are registered by the adapter as `discovery:fact:<first 12 hex of sha256("fact " + content)>`, with the same deterministic collision probing used for automatic items. The adapter always marks them `critical: true`; the model does not choose that flag. Measured LLM critical classification was the weakest signal in the user-intent benchmark, so the judgement is removed from the model and the acceptance bar is structural instead: a fact must quote supplied evidence. Re-injection still requires the separate, also-off-by-default `/context-guard recovery critical` setting, so two explicit opt-ins are required before a discovery can be re-injected after compaction.

Discovery is add-only. An existing item with the same kind and content is skipped silently, whether it is manual, user-automatic, or a previous discovery. Discovery never removes, rewrites, re-kinds, re-flags, or retires an item. When a batch adds items, the adapter sends a counts-only notification such as `Context Guard: captured 2 discoveries from tool evidence.`; a batch that adds nothing sends no discovery-capture notification.

### Persistence and provenance

Discovery uses persisted state schema v4. It stores the discovery mode, `discoveryItemIds`, and `discoveryProvenance` alongside the existing recovery, extraction, items, and `autoItemIds` fields. v1 and v2 entries still load normally rather than degraded: v1 turns both automatic modes off and treats every item as manual; v2 preserves extraction and automatic provenance while adding discovery off with empty discovery metadata. A valid v3 or v4 load drops discovery ids and provenance entries that refer to no current item. v3 provenance records remain valid without spans; v4 spans are validated. An invalid latest state still uses the existing fail-safe empty/degraded behavior without falling back to an older entry.

For each registered discovery item, provenance stores only a small list of `toolCallId`, tool name, a hash of each accepted quote, and, in schema v4, a half-open UTF-16 code-unit span into the concatenated text blocks of one tool result. The raw quote is still never persisted. The recorded span is the first occurrence of the quote; when the quote occurs more than once, it does not identify which occurrence the model referenced. Resolution needs the matching tool result to be on the caller's current branch path. An unresolvable record means **cannot verify**, not **invalid**. The session already retains the tool result, and duplicating it would increase session size and persist whatever the tool printed. Provenance is adapter-side; it is not a field on the core `ContextItem`. The Pi tool call id remains the evidence identity across resume, branch, and fork, subject to the current branch containing the tool result.

### Measured smoke behavior

The live smoke test measured these behaviors against schema v3, before evidence
spans were added:

- with discovery off, a turn that used tools made zero extra model calls;
- with discovery automatic, reading one fixture file produced two evidence-backed facts, both registered critical, with provenance containing only the tool call id, tool name, and quote hash;
- a turn that used no tool produced no discovery and no model call;
- a fake secret string in the same tool result produced 0 occurrences in adapter state, although it remains in the Pi session because Pi stores tool results;
- after manual compaction with `recovery=critical`, lost discovery facts were re-injected into the next model call;
- resume restored the discovery mode, items, and provenance, and the tool call id still resolved;
- deduplication is exact kind-plus-content, so a re-phrased restatement of the same fact registered as a second item.

### Limitations and secrets

Discovery facts are model-synthesized and are therefore more prone to literal false-loss than user-quoted items when the core verifier checks them after compaction. Exact kind-plus-content deduplication does not recognize paraphrases: a re-phrased version of an existing fact is a new item. Phase 1 has no discovery retirement, conflict resolution, or semantic deduplication; claims that are only true for a particular version, file, or command should carry that scope in their content.

**Do not enable automatic discovery for workflows where tool output may expose secrets unless you accept that eligible evidence may be sent to the active model provider.** The measured 0-occurrence result is about adapter state, not prevention: the tool result still lives in the session and eligible text is intentionally sent to the active provider.

## Default behaviour

With a new or empty state, the extension starts with no protected items, `literal` verification, recovery `off`, automatic extraction `off`, and agent discovery `off`. After items are added, it snapshots them before each Pi compaction and verifies them against the post-compaction context. The automatic notification contains the preservation and failure counts. No recovery content is injected until `/context-guard recovery critical` is selected.

The literal verifier normalizes case and whitespace before checking whether each protected item is present as a substring. It does not understand whether a paraphrase retained the same meaning.

## Compaction lifecycle

For Pi `0.84.2`, the extension uses these lifecycle events:

1. `session_before_compact` always overwrites the pending snapshot with the current registry.
2. `session_compact` consumes and clears that snapshot. If there is no pending snapshot, the compaction is reported as unverifiable and the current registry is not snapshotted or verified. If a snapshot exists, verification waits for the first following `context` event.
3. Any protected-registry change (manual or automatic add/retire, or clear), and any recovery-, extraction-, or discovery-mode change, clears the pending snapshot.

The first context event consumes the pending verification, so one compaction is never verified twice. The candidate is the projected effective context from that context event plus `ctx.getSystemPrompt()`. It is not the compaction summary alone: text from relevant message blocks, eligible bash execution content, and summary messages are projected according to Pi's context event.

Pi `0.84.2` has no compaction-failure event. The extension therefore does not register `session_compact_failed`; the three invariants above prevent a stale snapshot from being used. Session start and shutdown also clear pending lifecycle state.

## Persistence

Explicitly registered protected items, the recovery and extraction modes, the discovery mode, automatic provenance, and discovery provenance are persisted in the local Pi session as schema-v4 custom entries of type `agent-context-guard-state`. State is appended after each successful mutation and restored from the latest matching entry on `session_start`. Valid v1 and v2 entries still load normally: v1 has both automatic modes off and all items treated as manual, while v2 preserves extraction and automatic provenance and adds discovery off with empty discovery metadata. The latest matching entry is authoritative: if it is malformed, the extension starts with an empty registry, marks the state degraded, and shows a warning rather than falling back to an older valid entry.

Pending snapshots, pending verifications, the last-extraction summary, and the last-discovery summary are in-memory lifecycle state, not durable recovery records. Do not put secrets in protected items. Item content is stored in the local Pi session and may be shown by `/context-guard list` or included in an opted-in recovery message. Discovery provenance intentionally stores only tool call ids, tool names, quote hashes, and UTF-16 spans; it does not duplicate evidence text.

## Privacy

The adapter has no telemetry or `console.*` output. With both automatic extraction and agent discovery off, it makes no provider request of its own. In automatic extraction mode, an eligible user message makes the one extractor request described above. In automatic discovery mode, a turn with eligible tool evidence makes at most one discovery request at `turn_end`; a turn without tool evidence makes none. Verification, extraction, and discovery notifications do not include the candidate projection, evidence text, or protected content; recovery message `details` contain only a schema version, source compaction id, and item ids.

`/context-guard list` is an explicit inspection command and intentionally displays the registered item content. In `critical` recovery mode, the hidden recovery message body necessarily contains the selected snapshot content so Pi can restore it; that body is not a UI notification and is not duplicated in `details`.

## Limitations

- Verification is fixed to the core literal verifier in this phase; it is not semantic and can classify a meaningful paraphrase as lost.
- A compaction cannot be verified without a pre-compaction snapshot. Registry or recovery changes intentionally invalidate the pending snapshot.
- Recovery is limited to `report.criticalFailures`, uses the pre-compaction snapshot, and is disabled by default.
- Discovery facts are model-synthesized, so they are more prone to literal false-loss than user-quoted items.
- Discovery deduplication is exact kind-plus-content; a re-phrased version of an existing fact becomes a second item.
- Phase 1 has no discovery retirement, conflict resolution, or semantic entailment check; version-scoped claims should carry their scope.
- Pi `0.84.2` does not expose a compaction-failure lifecycle event, so there is no failure-event handler.
- The package is a Pi adapter only. It does not implement integrations for other agent harnesses or an MCP adapter.

## Phase 1 scope

Phase 1 provides a small Pi `0.84.2` extension with explicit protected-item commands, literal post-compaction verification, local schema-v4 session persistence, evidence-backed fact discovery off by default, counts-and-ids lifecycle reporting, and opt-in recovery for critical failures. It deliberately leaves semantic verification, discovery retirement, automatic recovery by default, other harness adapters, and an MCP adapter out of scope.

## Troubleshooting

### Everything reports as lost

The default verifier is literal substring matching after case and whitespace normalization. It cannot recognize a paraphrase as equivalent. Check the post-compaction wording against the registered item content, or register wording that must literally be retained. If semantic preservation is required, this Phase 1 extension cannot provide that verifier; keep recovery off rather than treating a literal loss as proof that the meaning disappeared.

### A compaction is reported as unverifiable

The extension did not have a pending snapshot when `session_compact` arrived. This happens when Pi did not deliver `session_before_compact`, or when an add, remove, clear, automatic mutation, or recovery-, extraction-, or discovery-mode change cleared the snapshot between the two events. Ensure the extension is loaded before the next compaction, avoid changing the registry or any mode during that lifecycle window, and run the compaction again.

### Critical recovery did not appear

Check `/context-guard status` and confirm recovery is `critical`. Recovery is generated only for ids in the verification report's `criticalFailures`; non-critical losses do not qualify. A compaction's pending verification is consumed by the first context event, so the same compaction will not inject a second message.

### Items disappeared after restarting Pi

Check for the persisted-state warning. The latest matching custom state entry is authoritative; if it is malformed, the extension intentionally starts empty and does not fall back to an older entry. Re-register the items after resolving the session-state problem, and do not store secrets in the registry.
