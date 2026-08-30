# @j1nn0/agent-retry-guard-pi

## What it is

`@j1nn0/agent-retry-guard-pi` is a minimal Pi harness adapter for recording caller-declared retry attempts, keeping a session-level retry policy, and explicitly asking the Retry Guard core whether another attempt is allowed. It provides one slash-command namespace for a human and five explicit tools for the model. It maintains one current retry episode; episode boundaries remain an explicit model or caller decision.

## Relationship to the core

`@j1nn0/agent-retry-guard` is the harness-agnostic core primitive. **Every retry judgment comes from its `judgeRetry(...)` function.** The adapter only records the caller-declared attempts and policy, builds the core input, formats the returned verdict, and persists raw inputs. It never reimplements streak or strategy-run logic and never persists derived values such as `consecutiveFailures`, `consecutiveNoProgress`, `strategyRun`, or `retryAllowed`.

The adapter is tested against `@earendil-works/pi-coding-agent` `0.84.2`. Its Pi peer dependency intentionally remains wide.

## Installation

Install the published adapter from the registry:

```sh
pi install npm:@j1nn0/agent-retry-guard-pi
```

Add `-l` to install it project-locally instead of for your user.

### From a local checkout (development)

For development or local use, build from the repository root, then install the package by absolute path:

```sh
PACKAGE_DIR=/abs/path/to/agent-primitives/packages/agent-retry-guard-pi
pnpm install
pnpm --filter @j1nn0/agent-retry-guard-pi build
pi install "$PACKAGE_DIR" -l
```

For a one-run load without installing it in Pi settings:

```sh
pi -e "$PACKAGE_DIR/dist/extension.js"
```

The package manifest also advertises `./dist/extension.js` through Pi's `pi.extensions` entry.

## Commands

The extension registers exactly one command namespace, `/agent-retry`. A bare command is the same as `status`:

```text
/agent-retry
/agent-retry status
/agent-retry add <success|failure|no_progress|unknown> [strategyId]
/agent-retry policy
/agent-retry policy 6
/agent-retry policy 6 3
/agent-retry policy clear
/agent-retry judge
/agent-retry clear
/agent-retry clear --yes
/agent-retry auto-record on|off
```

For example:

```text
/agent-retry add failure
/agent-retry add no_progress "try a different search strategy"
/agent-retry policy 6 3
/agent-retry judge
/agent-retry clear --yes
```

`status` reports the number and exact declared contents of the current episode, followed by the current policy. It does not judge. `add` records one attempt and accepts an optional single-token or quoted strategy identifier; malformed usage is rejected with the help text.

`policy` with no arguments shows the current policy. `policy 6` replaces it with `{ maxAttempts: 6 }`; `policy 6 3` replaces it with `{ maxAttempts: 6, maxStrategyAttempts: 3 }`; and `policy clear` replaces it with an empty policy. A policy entry is appended only when the replacement changes the policy.

`judge` explicitly delegates to `judgeRetry(...)` and displays the complete verdict JSON with a short reading. `clear` requires `--yes`; without confirmation it warns and does nothing. `/agent-retry clear --yes` fully resets both the attempts and policy and records that reset.

Starting the next episode is intentionally a model- or caller-owned lifecycle operation exposed by `agent_retry_start_episode`, not an automatic command-side transition.

`auto-record on|off` opts the current session into or out of automatic failure-outcome recording. It is off by default. The setting is persisted in the session file, so reopening that session resumes the mode; a new session starts with it off. When enabled, each actually-executed tool that fails contributes exactly one `{ outcome: 'failure' }` attempt with no strategy identifier. Calls that never execute, including blocked or unknown tools, do not trigger this path. Manual `add` and `agent_retry_add_attempt` remain available; in auto mode, avoid declaring the same failure manually as well. Tool names, inputs, outputs, and error stacks are never persisted.

## Tools

The model can use exactly these five tools:

| Tool | Parameters | Behavior |
| --- | --- | --- |
| `agent_retry_get` | none | Returns the same raw, non-judging summary as `status`. |
| `agent_retry_add_attempt` | `outcome` required; `strategyId` optional | Records one attempt and returns the new episode count. |
| `agent_retry_set_policy` | `maxAttempts` and `maxStrategyAttempts` optional integers, each at least `1` | Replaces the whole policy. An omitted key is cleared; `{}` clears the policy. |
| `agent_retry_judge` | none | Delegates to `judgeRetry(...)` and returns formatted verdict JSON plus a short reading. |
| `agent_retry_start_episode` | none | Explicitly starts a new episode by clearing attempts while preserving policy. |

The outcome parameter is the closed enum `success`, `failure`, `no_progress`, or `unknown`. The tools do not infer outcomes, generate strategy identifiers, map Progress verdicts, execute retries, or verify truth. `agent_retry_start_episode` explicitly starts a new retry episode at model or caller discretion and is never triggered automatically by success.

## Episode model

The Retry Guard core judges the current retry episode only. On Pi, the caller starts a new episode explicitly with `agent_retry_start_episode`. Recording `success` does not clear attempts and never starts a new episode automatically. The current episode remains available for inspection and judgment until the caller starts another episode or uses `clear --yes`.

`agent_retry_start_episode` resets only the attempts and preserves the policy. It appends a state entry when at least one attempt existed. Calling it on an already-empty episode is a no-op and appends nothing. `clear --yes` is different: it wipes both attempts and policy and records the confirmed full reset.

## Attempt and outcome semantics

An attempt is a caller-declared observation about one retry effort. Its outcome is declared from the attempt's intent, using exactly one of:

```ts
'success' | 'failure' | 'no_progress' | 'unknown'
```

The adapter does not infer a manually declared outcome from a model response, tool result, prompt, or any other event. Automatic failure recording is a separate opt-in mode that records only the observed failure outcome of an actually-executed failed tool.

## Strategy identifier responsibility

Strategy identifiers are opaque, caller- or model-owned strings. They are matched exactly and case-sensitively by the core. This adapter does not normalize, trim, rewrite, or generate them. A quoted command argument only supplies the quoting syntax needed to pass one string; the string's contents are preserved. An absent identifier remains absent, and id-less attempts never form a strategy run.

## Policy semantics

The policy is session-level retry guidance. It is preserved when a new episode starts and remains until explicitly replaced or cleared. `agent_retry_set_policy` uses replacement semantics: it stores exactly the provided keys, so an omitted key is cleared.

`maxAttempts` limits the number of attempts in the current episode. `maxStrategyAttempts` limits the trailing run of one identified strategy. Both limits are inclusive: a limit of `3` blocks when the relevant count reaches exactly `3`. An empty episode is allowed to receive its first attempt even when limits are set. The core's success rule takes precedence and makes `retryAllowed` false.

## Explicit judge

Judgment is never automatic. `status`, `agent_retry_get`, and all recording operations report or mutate raw state without calling `judgeRetry(...)`. Only `/agent-retry judge` and `agent_retry_judge` judge, and neither changes state or appends a session entry.

## Persistence and sessions

State is persisted as a Pi custom session entry with custom type `agent-retry-state` and schema version `1`:

```text
{
  schemaVersion: 1,
  attempts: [
    { outcome: 'failure' },
    { outcome: 'no_progress', strategyId: 'search-v1' }
  ],
  policy: { maxAttempts: 5, maxStrategyAttempts: 3 }
}
```

Only raw attempts and policy are stored in the retry-state envelope. Derived verdict fields are never written. The adapter appends entries after a successful add, an actual policy replacement, a confirmed `clear --yes`, or `agent_retry_start_episode` when attempts existed. Loading never appends. The automatic-recording setting is stored separately as an `agent-retry-auto-record` entry with `{ schemaVersion: 1, enabled: boolean }`; it never changes the main envelope.

On `session_start`, the adapter selects the newest matching entry in the current Pi branch and validates the envelope strictly. A malformed newest entry produces exactly one warning and starts fresh; it is not repaired, and an older valid entry is not used as a fallback. A branch without a matching entry starts fresh without a warning. JSON round-trip resume, including absent `strategyId` properties and policy preservation across an episode restart, is tested against Pi `0.84.x` behavior. There is no cross-session history beyond Pi's own session entries.

## Success lifecycle

The core returns `retryAllowed: false` for a declared success, but the adapter retains that successful attempt and its surrounding episode. The caller must explicitly invoke `agent_retry_start_episode` to begin the next episode or `clear --yes` to wipe the episode and policy.

## Relationship to Progress

Progress and Retry Guard have different boundaries. This adapter never reads Progress adapter state and never automatically maps Progress verdicts. The caller must declare a Retry Guard outcome from the intent of the retry attempt: a Progress observation can inform that decision, but it is not automatically a retry outcome. In particular, intermediate Progress movement is not automatically treated as a completed retry success.

## Relationship to Evidence

Declared outcomes are trusted as caller claims for Retry Guard judgment and are never verified by this adapter. An evidence verifier, if one exists at another boundary, is responsible for deciding whether a claimed result is supported.

## No automatic retry

This package does not execute retries, choose or generate strategies, observe model responses, inject context, call providers or models, make network calls, or maintain background resources. By default it records only caller-declared attempts and judgments; with `auto-record on`, it additionally records the Pi runtime's observed `isError: true` result for each executed failed tool, without selecting a strategy or retrying.

## Coexistence with the other Pi adapters

This adapter can be loaded alongside `@j1nn0/agent-context-guard-pi`, `@j1nn0/agent-state-pi`, and `@j1nn0/agent-progress-pi`. Its independent namespaces are:

- command: `/agent-retry`;
- tools: `agent_retry_get`, `agent_retry_add_attempt`, `agent_retry_set_policy`, `agent_retry_judge`, and `agent_retry_start_episode`; and
- session entry type: `agent-retry-state`;
- automatic-recording marker type: `agent-retry-auto-record`.

The other adapters use `/context-guard`, `/agent-state`, and `/agent-progress`, their own tool namespaces, and `agent-context-guard-state`, `agent-state-state`, and `agent-progress-state` custom types. This package has no dependency on their adapters or state and does not map or merge their entries.

## Limitations

Version 0.1 supports one active episode per Pi session. The policy is session-level rather than cross-session. Attempts have no reason field, the policy has no limits for consecutive failure or no-progress streaks, and there is no backoff or retry executor. The adapter cannot determine whether a caller-declared outcome is true, whether a strategy is semantically equivalent to another identifier, whether a retry is useful, or whether a task is safe or complete.
