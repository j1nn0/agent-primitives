# @j1nn0/agent-tool-policy-pi

> **Not published:** this package is available only from this repository for local development. Do not use a registry install command for it yet.

## What it is

`@j1nn0/agent-tool-policy-pi` is a minimal Pi adapter that enforces a caller-declared tool policy at Pi's pre-execution `tool_call` boundary. It provides the human-only `/agent-tool-policy` command namespace and registers no model-callable tools.

The adapter is safe by default: a session with no policy entry or with a corrupt newest entry blocks tool calls. An explicit `clear --yes` operation is the only way to select the pass-through state.

## Installation

Build and install the package from a local checkout:

```sh
REPO_DIR=/abs/path/to/agent-primitives
PACKAGE_DIR="$REPO_DIR/packages/agent-tool-policy-pi"
cd "$REPO_DIR"
pnpm install
pnpm --filter @j1nn0/agent-tool-policy-pi build
pi install "$PACKAGE_DIR" -l
```

For a single run without changing Pi's installed extensions, load the built extension directly:

```sh
pi -e "$PACKAGE_DIR/dist/extension.js"
```

## Enforcement states

The adapter loads only the newest `agent-tool-policy-state` entry on the current Pi branch. It never falls back to an older entry or repairs a corrupt entry.

| State | Tool-call behavior | How it is selected |
| --- | --- | --- |
| `unconfigured` | Block all calls | No matching session entry exists. |
| `disabled` | Pass through all calls | The newest entry is the explicit `policy: null` marker written by `clear --yes`. |
| `enforcing` | Delegate every call to the frozen core judge | The newest entry contains a valid policy. |
| `corrupt` | Block all calls | The newest matching entry has a wrong schema, extra keys, or an invalid policy. |

Silent allow happens **only** in `disabled`, after an operator explicitly writes the null marker with `clear --yes`. Missing, malformed, or contradictory configuration is never silently treated as disabled.

## Commands

The extension registers the human command `/agent-tool-policy`. A bare command is the same as `status`:

```text
/agent-tool-policy
/agent-tool-policy status
/agent-tool-policy set <policy-json>
/agent-tool-policy judge <tool>
/agent-tool-policy clear
/agent-tool-policy clear --yes
```

For example, configure a deny-by-default policy while allowing search, denying writes, and requiring approval for a deployment tool:

```sh
/agent-tool-policy set '{"default":"deny","allow":["mcp__search__query"],"deny":["write"],"requiresApproval":["deploy"]}'
```

`set` consumes the remainder of the command as one JSON value. JSON parsing and the frozen core's policy validation must both succeed; otherwise the state is unchanged. A successful set replaces the in-memory policy and persists exactly one full snapshot.

Use `judge` for a transient verdict without changing state:

```text
/agent-tool-policy judge mcp__search__query
```

`clear` is gated and changes nothing until explicitly confirmed:

```text
/agent-tool-policy clear
/agent-tool-policy clear --yes
```

`clear --yes` writes an explicit DISABLED marker with `policy: null`; it does not delete session history. Repeating `clear --yes` while already disabled reports that the policy is already disabled and writes nothing.

## Approval flow

When the core returns `requires_approval`, the adapter:

- blocks immediately when `ctx.hasUI` is false;
- calls `ctx.ui.confirm` when dialog-capable UI is available;
- allows the call only when confirmation resolves to exactly `true`;
- blocks when confirmation is `false`, `undefined`, or throws.

The current `ctx.signal` is forwarded to the confirmation dialog. Aborting the turn therefore cancels the dialog rather than turning an unresolved approval into an allow.

## Persistence

Each successful `set` or confirmed `clear --yes` appends one exact envelope to the current Pi session branch:

```json
{
  "schemaVersion": 1,
  "policy": {
    "default": "deny",
    "allow": ["mcp__search__query"],
    "deny": ["write"],
    "requiresApproval": ["deploy"]
  }
}
```

The disabled marker has the same envelope shape with `"policy": null`. Verdicts and approval decisions are transient and are never persisted.

## What this adapter does not do

- It has no model-callable tools, so the model can never change its own policy.
- It does not support patterns, globs, prefixes, regular expressions, or other matching semantics.
- It does not inspect tool arguments.
- It does not write an audit log or persist verdicts or approvals.
- It does not implement session-once approvals; that is a future candidate.
- It never uses Pi's `terminate` result.
- It does not discover tools, execute tools, infer a policy, or make provider/model calls.

## Relationship to `@j1nn0/agent-tool-policy`

`@j1nn0/agent-tool-policy` is the frozen, harness-agnostic core. This adapter validates and persists the caller-declared policy, routes each Pi `tool_call` through `judgeToolPolicy({ tool, policy })`, and maps the returned outcome to Pi enforcement. The adapter owns approval UI and fail-safe blocking; the core owns exact-name policy semantics. The adapter does not replace or reinterpret the core judge.

## Coexistence with the other Pi adapters

This adapter can be loaded alongside the other seven Pi adapters. Each adapter owns an independent command namespace, tool family, and session entry type:

| Adapter | Command | Tools | Session entry |
| --- | --- | --- | --- |
| Context Guard | `/context-guard` | none | `agent-context-guard-state` |
| Agent State | `/agent-state` | `agent_state_*` | `agent-state-state` |
| Agent Progress | `/agent-progress` | `agent_progress_*` | `agent-progress-state` |
| Agent Retry Guard | `/agent-retry` | `agent_retry_*` | `agent-retry-state` |
| Agent Evidence | `/agent-evidence` | `agent_evidence_*` | `agent-evidence-state` |
| Agent Handoff | `/agent-handoff` | `agent_handoff_*` | `agent-handoff-state` |
| Agent Budget | `/agent-budget` | `agent_budget_*` | `agent-budget-state` |
| Agent Tool Policy | `/agent-tool-policy` | none | `agent-tool-policy-state` |

It does not merge or map the other adapters' state, and those adapters do not change this policy.

## Limitations

Version 0.1 supports a session-scoped policy only. Matching is exact-name and case-sensitive. A corrupt newest policy requires a manual `/agent-tool-policy set <policy-json>` before any tool call can pass; the adapter never falls back to an older valid entry. The core's `requires_approval` result is limited to this adapter's interactive confirmation flow, with no session-once approval memory.
