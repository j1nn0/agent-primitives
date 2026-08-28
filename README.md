# agent-primitives

`agent-primitives` is a small, npm-first collection of focused building blocks for reliable agent workflows. It is language-agnostic at the boundary: each primitive should expose a small data model and a predictable contract that can be used from an application, a service, or another language through serialized data.

## What it is not

This repository is not an agent framework. It does not choose a model, provider, orchestration runtime, memory backend, prompt format, or deployment architecture. The primitives are deliberately composable rather than prescriptive.

## Layers

Each layer has one job, and the core packages stay on the first line:

| Layer | Responsibility |
| --- | --- |
| **Core primitive** | Decide. Given explicit inputs, return a verdict as plain data. |
| **Harness adapter** | Observe the lifecycle of a specific agent runtime and enforce or recover. |
| **MCP adapter** | Expose primitives as capabilities to MCP-based agents. |

Concretely, for the primitive implemented today:

```text
@j1nn0/agent-context-guard is a decision engine.

It does not automatically observe agent lifecycle events,
capture compaction boundaries, or reinject lost context.

Automatic enforcement belongs to harness-specific integrations
such as Pi extensions, OpenCode plugins, and lifecycle hooks.
```

Installing a core package does not, by itself, protect a running agent. A core
package answers a question the caller asks; something has to ask it at the right
moment, and that is the adapter's job.

## Design principles

- **Small contracts:** expose the minimum useful state and behavior.
- **Boundary-friendly data:** prefer plain, serializable snapshots and reports.
- **Fail safe:** uncertainty must be visible and must not be upgraded to success.
- **Privacy by default:** no telemetry, network calls, persistence, or hidden output.
- **npm-first:** publishable packages should be easy to consume from JavaScript and TypeScript without a runtime dependency stack.
- **Language-agnostic seams:** serialized inputs and outputs should make process and language boundaries straightforward.

## Implemented primitives

### Core primitives

#### `@j1nn0/agent-context-guard`

`@j1nn0/agent-context-guard` is implemented in this repository. The context guard records goals, constraints, requirements, decisions, and facts; creates deterministic snapshots; and verifies a candidate context with a literal or injected verifier. See [`packages/context-guard/README.md`](packages/context-guard/README.md) for the package documentation.

#### `@j1nn0/agent-state`

`@j1nn0/agent-state` records the caller-declared current position of work: an optional objective, insertion-ordered work items with explicit statuses, and decisions. It creates deterministic snapshots, restores validated plain data, and summarizes current status counts. See [`packages/agent-state/README.md`](packages/agent-state/README.md) for the package documentation.

#### `@j1nn0/agent-progress`

`@j1nn0/agent-progress` judges whether caller-declared work is moving forward by comparing a current milestone set with a cumulative baseline. It reports progress only when a genuinely new opaque identifier appears, preserves uncertainty when no baseline is supplied, and returns the cumulative set for the next round. See [`packages/agent-progress/README.md`](packages/agent-progress/README.md) for the package documentation.
#### `@j1nn0/agent-retry-guard`

`@j1nn0/agent-retry-guard` judges the current retry episode: it counts trailing failures and no-progress outcomes, detects repeated identified strategies, and applies explicit attempt limits. See [`packages/agent-retry-guard/README.md`](packages/agent-retry-guard/README.md) for the package documentation.

#### `@j1nn0/agent-evidence`

`@j1nn0/agent-evidence` judges whether caller-declared claims are backed by explicitly linked evidence records, applying deterministic outcome and subject-identity rules while preserving uncertainty and claim order. See [`packages/agent-evidence/README.md`](packages/agent-evidence/README.md) for the package documentation.
#### `@j1nn0/agent-handoff`

`@j1nn0/agent-handoff` validates caller-declared packets that pass work between agents and sessions, and returns a JSON-safe, opaque-reference-only document. A Pi harness adapter now exists in this repository (see the Harness adapters section). See [`packages/agent-handoff/README.md`](packages/agent-handoff/README.md) for the package documentation.

#### `@j1nn0/agent-budget`

`@j1nn0/agent-budget` is implemented in this repository. The control primitive judges caller-declared numeric consumption against a caller-declared limit and reports `within_budget` or `exhausted` with the unclamped remaining quantity. Units are opaque to the core; policy about what counts toward `consumed` belongs entirely to the caller. See [`packages/agent-budget/README.md`](packages/agent-budget/README.md) for the package documentation.

#### `@j1nn0/agent-tool-policy`

`@j1nn0/agent-tool-policy` is implemented in this repository. The control primitive judges a caller-declared tool name against a caller-declared policy and reports `allowed`, `denied`, or `requires_approval` with the source of the decision (an explicit rule or the declared default). The core declares outcomes only; approval prompts and enforcement belong to integrations. See [`packages/agent-tool-policy/README.md`](packages/agent-tool-policy/README.md) for the package documentation.

### Harness adapters

#### `@j1nn0/agent-context-guard-pi`

`@j1nn0/agent-context-guard-pi` is implemented in this repository. The Pi extension observes compaction boundaries, verifies protected context after compaction, persists its registry in the local Pi session, and can recover critical failures when explicitly enabled. It also offers optional automatic extraction of protected context from user messages, off by default, and can capture evidence-backed facts learned from tool output, also off by default. See [`packages/context-guard-pi/README.md`](packages/context-guard-pi/README.md) for the package documentation.

#### `@j1nn0/agent-state-pi`

`@j1nn0/agent-state-pi` is implemented in this repository. The Pi extension provides explicit `/agent-state` commands and four model-callable tools for recording and inspecting caller-declared Agent State, persists it in the local Pi session, and restores it on resume without automatic extraction or per-turn injection. See [`packages/agent-state-pi/README.md`](packages/agent-state-pi/README.md) for the package documentation.

#### `@j1nn0/agent-progress-pi`

`@j1nn0/agent-progress-pi` is implemented in this repository. The minimal Pi adapter provides explicit `/agent-progress` commands and four model-callable tools for maintaining a caller-declared milestone set, delegates every verdict to `@j1nn0/agent-progress`, and persists the current set plus cumulative baseline in the local Pi session. See [`packages/agent-progress-pi/README.md`](packages/agent-progress-pi/README.md) for the package documentation.

#### `@j1nn0/agent-retry-guard-pi`

`@j1nn0/agent-retry-guard-pi` is implemented in this repository. The minimal Pi adapter provides explicit `/agent-retry` commands and five model-callable tools for recording caller-declared retry attempts and policy, delegates every judgment to `@j1nn0/agent-retry-guard`, and persists the current episode plus policy in the local Pi session. See [`packages/agent-retry-guard-pi/README.md`](packages/agent-retry-guard-pi/README.md) for the package documentation.

#### `@j1nn0/agent-evidence-pi`

`@j1nn0/agent-evidence-pi` is implemented in this repository. The minimal Pi adapter provides explicit `/agent-evidence` commands and seven model-callable tools for maintaining caller-declared claims and evidence, delegates every judgment to `@j1nn0/agent-evidence`, and persists the raw evidence snapshot in the local Pi session. See [`packages/agent-evidence-pi/README.md`](packages/agent-evidence-pi/README.md) for the package documentation.

#### `@j1nn0/agent-handoff-pi`

`@j1nn0/agent-handoff-pi` is implemented in this repository. The Pi adapter registers `/agent-handoff` commands and three model-callable tools (`agent_handoff_get`, `agent_handoff_create`, and `agent_handoff_remove`), persists packets in the local Pi session, and delegates all packet validation to `@j1nn0/agent-handoff`. See [`packages/agent-handoff-pi/README.md`](packages/agent-handoff-pi/README.md) for the package documentation.

#### `@j1nn0/agent-budget-pi`

`@j1nn0/agent-budget-pi` is implemented in this repository. The minimal Pi adapter provides `/agent-budget` commands and four model-callable tools (`agent_budget_get`, `agent_budget_set`, `agent_budget_remove`, `agent_budget_judge`) for storing caller-declared budget records ({id, consumed, limit} with exact preservation) and judging them on demand through `@j1nn0/agent-budget`; judgment results are never persisted and the adapter does no automatic accounting. See [`packages/agent-budget-pi/README.md`](packages/agent-budget-pi/README.md) for the package documentation.

#### `@j1nn0/agent-tool-policy-pi`

`@j1nn0/agent-tool-policy-pi` is implemented in this repository. The Pi adapter enforces caller-declared tool policy at the pre-execution `tool_call` boundary: unconfigured or corrupted policy blocks tool calls, `denied` blocks, `requires_approval` passes only through an interactive confirmation, and only an explicit disable marker allows everything through. It registers `/agent-tool-policy` human commands and no model-callable tools. See [`packages/agent-tool-policy-pi/README.md`](packages/agent-tool-policy-pi/README.md) for the package documentation.

## Direction

Harness adapters ship on a per-primitive basis where a concrete consumer justifies the integration. They observe the lifecycle of a specific agent runtime and enforce or recover, while every core primitive stays independent and explicit.

### Possible future primitives

The following are **not implemented**. They describe a direction, not an API promise:

- **MCP adapter** — exposing primitives to MCP-based agents, without the core packages depending on an MCP SDK.

All implemented core primitives are listed in the Core primitives section above; each core that ships with a Pi adapter is listed in the Harness adapters section.

## Development

Install workspace dependencies, then run the checks from the repository root:

```sh
pnpm install
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm check:package
pnpm example
```

`pnpm build` comes first: the Pi adapters and examples resolve workspace core
packages through their built `dist`, so typecheck, test and examples need the
workspace built at least once.

The examples are private workspace packages and run after the core packages have been built.

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability privately. Do not report vulnerabilities in public GitHub issues.

## License

MIT. See [`LICENSE`](LICENSE).
