# agent-primitives

`agent-primitives` is a small, npm-first collection of focused building blocks for reliable agent workflows. It is language-agnostic at the boundary: each primitive should expose a small data model and a predictable contract that can be used from an application, a service, or another language through serialized data.

## What it is not

This repository is not an agent framework. It does not choose a model, provider, orchestration runtime, memory backend, prompt format, or deployment architecture. The primitives are deliberately composable rather than prescriptive.

## Design principles

- **Small contracts:** expose the minimum useful state and behavior.
- **Boundary-friendly data:** prefer plain, serializable snapshots and reports.
- **Fail safe:** uncertainty must be visible and must not be upgraded to success.
- **Privacy by default:** no telemetry, network calls, persistence, or hidden output.
- **npm-first:** publishable packages should be easy to consume from JavaScript and TypeScript without a runtime dependency stack.
- **Language-agnostic seams:** serialized inputs and outputs should make process and language boundaries straightforward.

## Implemented primitives

### `@j1nn0/agent-context-guard`

**Shipped.** The context guard records goals, constraints, requirements, decisions, and facts; creates deterministic snapshots; and verifies a candidate context with a literal or injected verifier. See [`packages/context-guard/README.md`](packages/context-guard/README.md) for the package documentation.

## Possible future primitives

The following are **not implemented**. They describe a direction, not an API promise:

- **Agent state** — how far the work got, what was decided, what is still open.
- **Retry guard** — whether the same failure is being repeated.
- **Progress** — whether the work is actually moving forward.
- **Evidence** — whether a completion claim is backed by something.
- **Handoff** — whether one agent can correctly take over from another.
- **Budget** — limits on tool calls, attempts, time, and sub-agents.
- **Tool policy** — allow, deny, and require-approval rules for tool invocation.
- **MCP adapter** — exposing primitives to MCP-based agents, without the core packages depending on an MCP SDK.

Only the context guard is shipped today.

## Development

Install workspace dependencies, then run the checks from the repository root:

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check:package
pnpm example
```

The example is a private workspace package and runs after the context-guard package has been built.

## License

MIT. See [`LICENSE`](LICENSE).
