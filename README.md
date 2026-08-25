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

### Harness adapters

#### `@j1nn0/agent-context-guard-pi`

`@j1nn0/agent-context-guard-pi` is implemented in this repository. The Pi extension observes compaction boundaries, verifies protected context after compaction, persists its registry in the local Pi session, and can recover critical failures when explicitly enabled. It also offers optional automatic extraction of protected context from user messages, off by default, and can capture evidence-backed facts learned from tool output, also off by default. See [`packages/context-guard-pi/README.md`](packages/context-guard-pi/README.md) for the package documentation.

#### `@j1nn0/agent-state-pi`

`@j1nn0/agent-state-pi` is implemented in this repository. The Pi extension provides explicit `/agent-state` commands and four model-callable tools for recording and inspecting caller-declared Agent State, persists it in the local Pi session, and restores it on resume without automatic extraction or per-turn injection. See [`packages/agent-state-pi/README.md`](packages/agent-state-pi/README.md) for the package documentation.

#### `@j1nn0/agent-progress-pi`

`@j1nn0/agent-progress-pi` is implemented in this repository. The minimal Pi adapter provides explicit `/agent-progress` commands and four model-callable tools for maintaining a caller-declared milestone set, delegates every verdict to `@j1nn0/agent-progress`, and persists the current set plus cumulative baseline in the local Pi session. See [`packages/agent-progress-pi/README.md`](packages/agent-progress-pi/README.md) for the package documentation.

## Direction

The context guard, Agent state, and Progress core primitives now have Pi harness adapters. These integrations provide concrete lifecycle boundaries while keeping each core primitive independent and explicit.

### Possible future primitives

The following are **not implemented**. They describe a direction, not an API promise:

- **Retry guard** — whether the same failure is being repeated.
- **Evidence** — whether a completion claim is backed by something.
- **Handoff** — whether one agent can correctly take over from another.
- **Budget** — limits on tool calls, attempts, time, and sub-agents.
- **Tool policy** — allow, deny, and require-approval rules for tool invocation.
- **MCP adapter** — exposing primitives to MCP-based agents, without the core packages depending on an MCP SDK.

The context guard core, Agent state core, and Progress core are implemented in this repository, and each currently has a Pi harness adapter.

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
