# @j1nn0/agent-state-pi

## What it is

`@j1nn0/agent-state-pi` is a minimal Pi harness adapter for recording and inspecting Agent State during a real Pi session. It provides one slash-command namespace for a human and four explicit tools for the model. The adapter records only state that a caller explicitly supplies.


## Relationship to the core

`@j1nn0/agent-state` is the harness-agnostic core primitive. It validates work items, statuses, decisions, and snapshots; preserves insertion order; restores validated snapshots; and summarizes work-item counts.

This package owns only the Pi integration: command and tool registration, Pi session custom-entry persistence, and restoration on `session_start`. It uses `restoreAgentState(...)` for every restored snapshot and for the objective command's rebuilt snapshot. It does not add a setter or other API to the core.

The adapter is tested against Pi `0.84.4`. Its Pi peer dependency intentionally remains wide.

## Installation

Install the published adapter from the registry:

```sh
pi install npm:@j1nn0/agent-state-pi
```

Add `-l` to install it project-locally instead of for your user.

### From a local checkout

Build from the repository root, then install the package by absolute path:
The local commands are `pi install <abs-path> -l` and `pi -e <abs-path>/dist/extension.js`; the examples below use a shell variable for the absolute path.

```sh
PACKAGE_DIR=/abs/path/to/agent-primitives/packages/agent-state-pi
pnpm install
pnpm --filter @j1nn0/agent-state-pi build
pi install "$PACKAGE_DIR" -l
```

For a one-run load without installing it in Pi settings:

```sh
pi -e "$PACKAGE_DIR/dist/extension.js"
```

The package manifest also advertises `./dist/extension.js` through Pi's `pi.extensions` entry.

## Commands

The extension registers exactly one command namespace, `/agent-state`:

```text
/agent-state status
/agent-state objective <text...>
/agent-state add <id> <content...>
/agent-state set <id> <open|in_progress|blocked|done>
/agent-state remove <id>
/agent-state decide <id> <content...>
/agent-state clear --yes
```

Running `/agent-state` with no arguments prints the usage line. `status` uses the core's `summarizeAgentState(...)` counts and then lists work items and decisions in insertion order. An empty state is displayed as:

```text
Agent State: no objective, 0 work items, 0 decisions.
```

Statuses are exact. A typo is rejected with the valid status list; it is never corrected automatically. `clear` without `--yes` reports the objective, work-item, and decision state that would be removed and does nothing.

## Tools

The model can use exactly these four tools:

- `agent_state_get` — read the current Agent State as readable text.
- `agent_state_add_work_item` — record `{ id, content, status? }` as a caller-declared work item.
- `agent_state_set_work_item_status` — record `{ id, status }` for an existing work item.
- `agent_state_add_decision` — record `{ id, content }` as a caller-declared decision.

Every tool description makes the authority boundary explicit: these tools record caller-declared state and do not establish truth or verify progress, evidence, or completion. Tool and command validation errors are returned as short messages without stack traces.

## Persistence and sessions

Successful explicit mutations append a custom Pi session entry with custom type `agent-state-state`:

```text
{ schemaVersion: 1, state: AgentStateSnapshot }
```

The adapter's schema version is separate from the core snapshot's `schemaVersion`. On every `session_start`, regardless of the start reason, it reads the current branch, selects the newest matching custom entry, and restores its snapshot through the core's `restoreAgentState(...)`. Loading alone never appends an entry.

A new session has no matching custom entry and starts empty. Resuming a session restores its latest valid entry. If the newest entry is missing a required payload, has an unsupported adapter schema version, is malformed, or fails core restoration, the adapter warns once and starts with empty state. It does not silently repair the entry, fall back to an older entry, or append a replacement while loading.

Pi does not write a session file for a brand-new session until the first model turn produces an assistant message. While a new session contains only commands and tool calls, Pi keeps the transcript in memory, so recording state and exiting before any model turn leaves nothing on disk. This is Pi's session-persistence rule rather than a property of this adapter: once a session contains an assistant message, later entries are written normally, and resuming a saved session restores the latest valid entry.

There is no filesystem or cross-session persistence beyond Pi's own session entries.

## Coexistence with Context Guard

This adapter can be loaded alongside `@j1nn0/agent-context-guard-pi`. It uses the command name `/agent-state`, the four `agent_state_*` tool names, and the custom-entry type `agent-state-state`; these are distinct from Context Guard's command, tools, and `agent-context-guard-state` entry type. The two adapters keep separate state.

## Deliberate limits

This package has:

- **no automatic extraction** from prompts, responses, or tool results;
- **no automatic progress or evidence detection**;
- **no automatic done or blocker detection**;
- **no progress, retry, attempt, handoff, or evidence-validation logic**;
- **no model calls, network calls, MCP integration, telemetry, or global state**; and
- **no per-turn context injection**.

It does not register a `context` handler and does not call `sendMessage` or `sendUserMessage`. The `agent_state_get` tool is the on-demand alternative when the model needs to inspect state. The human must decide what to record and when to change it.

The core has no objective setter, so the objective command rebuilds a snapshot with `restoreAgentState(...)`. This is intentional: real-session use should reveal whether that public API is sufficient before the core grows another mutation method. State is also local to the active Pi session; this adapter does not synchronize it across sessions.

## Real usage guidance

Use the human commands to establish a small objective, add concrete work items with caller-supplied IDs, record decisions, and update statuses explicitly as the work changes. Use the tools when the model is asked to record or inspect state during its loop. Keep content concise enough for a readable status display, and treat every entry as a declared note rather than a verified fact or completion claim.

For a first smoke run, try `objective`, two or three `add` commands, `decide`, `set`, and `status`, then resume the same session and confirm the state is still present. Start a new session separately to confirm it starts empty. Do not use the adapter as a substitute for tests, evidence, or Context Guard's compaction verification.
