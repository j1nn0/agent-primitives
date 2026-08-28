# @j1nn0/agent-handoff

## What

`@j1nn0/agent-handoff` validates caller-declared packets that pass work between agents and sessions, and returns a JSON-safe document containing the declared handoff information and opaque evidence references. It is an ESM-only package with zero runtime dependencies.

## Why

A handoff is a cross-boundary document, so the caller must declare what work is being passed without this core inferring completion, judging evidence, or selecting a successor. The primitive validates the packet shape and preserves its caller-owned content; lifecycle behavior belongs to an adapter or application that explicitly consumes the packet.

## Installation

Install the published package from the registry with your package manager:

- pnpm: `pnpm add @j1nn0/agent-handoff`
- npm: `npm install @j1nn0/agent-handoff`
- Yarn: `yarn add @j1nn0/agent-handoff`

### From a local checkout (development)

For development or local use, build the package, then install the built package by local path:

```sh
pnpm install
pnpm --filter @j1nn0/agent-handoff build
pnpm add file:/path/to/agent-primitives/packages/agent-handoff
```

Requirements:

- Node.js `>=22.12.0`
- ESM imports
- zero runtime dependencies

## Quick start

Declare a packet and pass it through the validating construction boundary:

```ts
import { createHandoff } from '@j1nn0/agent-handoff';
import type { HandoffInput, HandoffPacket } from '@j1nn0/agent-handoff';

const input: HandoffInput = {
  schemaVersion: 1,
  id: 'handoff-pr-42',
  source: 'engineer',
  destination: 'reviewer',
  goal: 'Review pull request 42 before merge.',
  constraints: ['Check the diff.', 'Run the relevant tests.'],
  openItems: ['Confirm the deployment note.'],
  evidenceReferences: ['tests-run-123', 'lint-pass-456'],
};

const packet: HandoffPacket = createHandoff(input);
console.log(packet);
```

The returned `HandoffPacket` is plain data suitable for a serialized boundary.

## The model

`HandoffPacket` is the validated output. Required fields are marked below; the remaining fields are optional and are present only when supplied:

```ts
interface HandoffPacket {
  readonly schemaVersion: 1; // required
  readonly id: string; // required
  readonly source: string; // required
  readonly destination?: string; // optional
  readonly goal: string; // required
  readonly constraints?: readonly string[]; // optional prose
  readonly openItems?: readonly string[]; // optional prose
  readonly evidenceReferences?: readonly string[]; // optional opaque ids
}
```

`HandoffInput` is the typed construction shape for static TypeScript callers. The runtime accepts `unknown` and applies the same validation:

```ts
interface HandoffInput {
  schemaVersion: 1; // required
  id: string; // required
  source: string; // required
  destination?: string; // optional
  goal: string; // required
  constraints?: readonly string[]; // optional prose
  openItems?: readonly string[]; // optional prose
  evidenceReferences?: readonly string[]; // optional opaque ids
}
```

`constraints` carries caller-declared prose restrictions. `openItems` carries caller-declared prose about work that remains open; it is a first-class Phase 1 packet field, not inferred state or an adapter-only extension. `evidenceReferences` carries opaque identifiers rather than evidence content.

## Public API reference

The package root exports these runtime values:

- `createHandoff(input: unknown): HandoffPacket` — validate an unknown input and return a fresh packet, or throw `HandoffError`.
- `HandoffError` — an error with `name === 'HandoffError'` and `code === 'invalid_input'`.

The package root exports these TypeScript types:

- `HandoffErrorCode` — currently only `invalid_input`;
- `HandoffPacket` — the validated JSON-safe packet;
- `HandoffInput` — the typed construction shape.

There is no public constructor and no `validateHandoff` export. Malformed input fails at the `createHandoff` boundary with the message `Invalid handoff input.`.

## Validation rules

- The input must be a plain object whose prototype is `Object.prototype` or `null`. Arrays, primitives, class instances, and objects with another prototype are invalid.
- `schemaVersion` is a required own property and must be exactly the number `1`.
- `id`, `source`, and `goal` are required own string properties. `destination`, when present, follows the same rule. A valid identifier has `trim().length > 0`; the original spelling is retained exactly, so surrounding spaces are significant.
- `constraints`, when present, must be an array of non-empty strings. Duplicate prose is allowed, and exact content and declaration order are preserved.
- `openItems`, when present, must be an array of non-empty strings. Duplicate prose is allowed, and exact content and declaration order are preserved.
- `evidenceReferences`, when present, must be an array of non-empty strings. Exact duplicate opaque identifiers are invalid; declaration order is preserved.
- Optional properties are validated when they are own properties. Explicit `undefined` is invalid rather than being treated as absent.
- Unknown top-level keys are invalid. The accepted key allow-list is exactly `schemaVersion`, `id`, `source`, `destination`, `goal`, `constraints`, `openItems`, and `evidenceReferences`.

## Duplicate identifiers

The duplicate rule is intentionally asymmetric. `constraints` and `openItems` contain caller-owned prose, so duplicates are allowed and preserved exactly in order. `evidenceReferences` contains opaque identifiers, so an exact duplicate is rejected with `HandoffError` and `code === 'invalid_input'`. The scalar `id` and `source` fields are required fields; duplicate terminology does not apply to them.

## Determinism and privacy

`createHandoff` returns only plain serializable values: equal inputs produce equal packets and the result is safe to JSON round-trip. Every call constructs a fresh object and fresh copies of supplied arrays, so caller arrays and prior results are not aliased. The core uses no timestamps, random identifiers, I/O, network access, persistence, telemetry, or console output. Caller-owned identifiers and prose are opaque and are never logged; callers must still scrub sensitive content before transmitting a packet.

## Relationship to Evidence

`evidenceReferences` are opaque identifiers only. A handoff packet never inlines Evidence records or verdicts, and this core does not judge whether a reference is supported. A caller may consult the corresponding Evidence verdict at consumption time and make an explicit workflow decision outside this package.

## Relationship to Agent State

Phase 1 carries no Agent State references. Agent State work-item and decision IDs are caller-supplied opaque strings scoped to one `createAgentState(...)` instance, with no global uniqueness guarantee, so they are unsafe for cross-boundary identification. A future revision may add a deliberately globally-scoped reference abstraction.

## Relationship to Progress

Phase 1 has a zero-reference surface for Progress. The packet neither carries Progress milestones nor maps a Progress result to handoff fields; a caller may explicitly include relevant prose or evidence references when appropriate.

## Relationship to Retry Guard

Phase 1 has a zero-reference surface for Retry Guard. The packet has no retry policy, attempt history, or `retryAllowed` field, and this core does not make or alter retry decisions.

## Relationship to Context Guard

Handoff packets never bundle a `ContextSnapshot`. This core does not capture, persist, restore, summarize, or reinject Context Guard data.

## Pi adapter

A minimal Pi adapter is implemented in this repository as `@j1nn0/agent-handoff-pi`. It provides explicit `/agent-handoff` commands, three model-callable tools, and session persistence while observing an explicitly requested boundary without automatically coupling handoff creation to Evidence, Agent State, Progress, Retry Guard, or Context Guard.

## Limitations

Version 0.1 validates and copies a caller-declared packet only. It performs no judgment, successor selection, or semantic matching, and the core provides no persistence or external verification. A Pi adapter and release family exist in this repository as `@j1nn0/agent-handoff-pi`, wired as the agent-handoff release family; the core still has no MCP adapter or CLI. Packet prose is caller-owned content and may carry secrets, so callers must scrub it before transmission.
