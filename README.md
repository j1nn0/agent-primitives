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

### Harness adapters

#### `@j1nn0/agent-context-guard-pi`

`@j1nn0/agent-context-guard-pi` is implemented in this repository. The Pi extension observes compaction boundaries, verifies protected context after compaction, persists its registry in the local Pi session, and can recover critical failures when explicitly enabled. It also offers optional automatic extraction of protected context from user messages, off by default, and can capture evidence-backed facts learned from tool output, also off by default. See [`packages/context-guard-pi/README.md`](packages/context-guard-pi/README.md) for the package documentation.

## Direction

The first harness adapter is now available for Pi. Future work can use that
integration's real lifecycle feedback before more primitives are built on top of
it; adapters for other harnesses follow from what it teaches.

### Possible future primitives

The following are **not implemented**. They describe a direction, not an API promise:

- **Retry guard** — whether the same failure is being repeated.
- **Progress** — whether the work is actually moving forward.
- **Evidence** — whether a completion claim is backed by something.
- **Handoff** — whether one agent can correctly take over from another.
- **Budget** — limits on tool calls, attempts, time, and sub-agents.
- **Tool policy** — allow, deny, and require-approval rules for tool invocation.
- **MCP adapter** — exposing primitives to MCP-based agents, without the core packages depending on an MCP SDK.

The context guard core, Agent state core, and Pi harness adapter are implemented in this repository.

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

`pnpm build` comes first: the Pi adapter and the example resolve
`@j1nn0/agent-context-guard` through its built `dist`, so typecheck, test and
the example need the workspace built at least once.

The example is a private workspace package and runs after the context-guard package has been built.

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability privately. Do not report vulnerabilities in public GitHub issues.

## License

MIT. See [`LICENSE`](LICENSE).
