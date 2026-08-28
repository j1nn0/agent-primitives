# @j1nn0/agent-tool-policy

## What it is

`@j1nn0/agent-tool-policy` is a CONTROL-type core primitive for judging a caller-declared tool name against a caller-declared allow/deny policy. It returns a deterministic `allowed`, `denied`, or `requires_approval` outcome with whether that outcome came from an explicit `rule` or the declared `default`. It is an ESM-only package with zero runtime dependencies.

The package evaluates declarations supplied by its caller. It does not observe an agent, execute a tool, block a call, infer policy, or decide how an integration should enforce a verdict.

## Why it exists

A caller may need a small, explicit decision about whether a named tool invocation is allowed, denied, or requires approval before continuing work. This primitive keeps that decision separate from execution and integration policy: the caller supplies the tool name and policy, and the core applies only exact-name matching and the declared default.

`requires_approval` is a declared outcome only. The approval prompt and any enforcement belong to integrations, not to this core.

## Installation

Install the published package from the npm registry:

```sh
npm install @j1nn0/agent-tool-policy
```

pnpm works the same way: `pnpm add @j1nn0/agent-tool-policy`.

### From a local checkout (development)

For development or local use, build the package, then install the built package by local path:

```sh
REPO_DIR=/abs/path/to/agent-primitives
PACKAGE_DIR="$REPO_DIR/packages/agent-tool-policy"
cd "$REPO_DIR"
pnpm install
pnpm --filter @j1nn0/agent-tool-policy build
pnpm add "file:$PACKAGE_DIR"
```

Requirements:

- Node.js `>=22.12.0`
- ESM imports
- zero runtime dependencies

## Quick start

Pass a caller-declared tool name and policy to the judge:

```ts
import { judgeToolPolicy } from '@j1nn0/agent-tool-policy';

const policy = {
  default: 'deny',
  allow: ['mcp__srv__search'],
  deny: ['Bash'],
  requiresApproval: ['mcp__srv__write'],
} as const;

console.log(
  judgeToolPolicy({ tool: 'mcp__srv__search', policy }),
);
// { outcome: 'allowed', source: 'rule' }

console.log(
  judgeToolPolicy({ tool: 'mcp__srv__write', policy }),
);
// { outcome: 'requires_approval', source: 'rule' }

console.log(judgeToolPolicy({ tool: 'shell', policy }));
// { outcome: 'denied', source: 'default' }
```

## The model

`ToolPolicyJudgeInput` has two required caller-declared values:

```ts
interface ToolPolicyJudgeInput {
  readonly tool: string;
  readonly policy: ToolPolicy;
}
```

A policy declares one default action and three exact-name lists:

```ts
interface ToolPolicy {
  readonly default: 'allow' | 'deny' | 'requires_approval';
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly requiresApproval?: readonly string[];
}
```

The caller supplies the tool name verbatim. The core returns only the decision outcome and its source:

```ts
interface ToolPolicyVerdict {
  readonly outcome: 'allowed' | 'denied' | 'requires_approval';
  readonly source: 'rule' | 'default';
}
```

There is no tool echo, reason string, approval prompt, or enforcement action in the verdict. `requires_approval` remains a declaration for an integration to interpret.

## Public API reference

The package root exports the runtime values `judgeToolPolicy` and `ToolPolicyError`, plus these TypeScript types:

- `ToolPolicyOutcome` — the closed `allowed`, `denied`, or `requires_approval` vocabulary;
- `ToolPolicySource` — `rule` or `default`;
- `ToolPolicyDefaultAction` — the declared default action vocabulary;
- `ToolPolicyErrorCode` — currently only `invalid_input`;
- `ToolPolicy` — the exact-name policy declaration;
- `ToolPolicyJudgeInput` — the caller-declared tool and policy;
- `ToolPolicyVerdict` — the deterministic outcome and source.

```ts
judgeToolPolicy(input: unknown): ToolPolicyVerdict;
```

Invalid input throws `ToolPolicyError` with `code === 'invalid_input'` and message `Invalid tool policy input.`. The error's `name` is `ToolPolicyError`; callers normally match on the thrown error rather than construct one.

## Validation rules

- The input must be a plain object whose prototype is `Object.prototype` or `null`. Arrays, primitives, class instances, and objects with another prototype are invalid.
- The accepted top-level keys are exactly `tool` and `policy`. Unknown top-level keys are invalid, and both required own properties must be present.
- `tool` must be a non-whitespace string matching `/^\S+$/`. It is preserved verbatim: the core never trims, normalizes, or case-folds it.
- `policy` must be a plain object. Its accepted keys are exactly `default`, `allow`, `deny`, and `requiresApproval`; unknown policy keys are invalid.
- `default`, `allow`, and `deny` are required own properties. `default` must be exactly `allow`, `deny`, or `requires_approval`.
- `allow` and `deny` must be arrays. When present, `requiresApproval` must also be an array. Every element must be a non-whitespace string matching `/^\S+$/`; empty strings, whitespace-containing strings, non-strings, and explicit `undefined` values are invalid.
- An omitted `requiresApproval` list is equivalent to an empty list. There is no implicit default action, normalization, repair, or silent fallback.
- Duplicate entries within any one list are invalid.
- A name may not appear in more than one of `allow`, `deny`, and `requiresApproval`. Every cross-list overlap combination is invalid; contradictory policies are rejected rather than resolved by precedence.
- Invalid input throws `ToolPolicyError('invalid_input', 'Invalid tool policy input.')`.

## Decision semantics

Matching is exact-name matching using strict, case-sensitive string equality. Names are not trimmed, normalized, expanded, or interpreted as patterns.

| Matching list | Outcome | Source |
| --- | --- | --- |
| `allow` | `allowed` | `rule` |
| `deny` | `denied` | `rule` |
| `requiresApproval` | `requires_approval` | `rule` |

A matching rule wins over the declared default. Because cross-list overlap is invalid, this decision does not resolve contradictory rules. If no rule matches, the declared default supplies the outcome:

| Declared default | Outcome | Source |
| --- | --- | --- |
| `allow` | `allowed` | `default` |
| `deny` | `denied` | `default` |
| `requires_approval` | `requires_approval` | `default` |

## What this core does not do

- It does not execute tools, block calls, or enforce a verdict.
- It does not display approval prompts or decide how approval works.
- It does not provide enforcement; that is the integration boundary's responsibility, including an integration refusing a tool call when judgment is impossible.
- It does not inspect tool arguments.
- It does not support patterns, globs, regular-expression policy, prefixes, or other matching semantics.
- It does not define filesystem or network permissions, a sandbox, or provider-specific semantics.
- It does not persist policies or verdicts, write audit logs, or discover tools.
- It has no provider, model, runtime, or harness dependency and makes no I/O or network calls.

## Relationship to Agent Retry Guard

Agent Retry Guard owns attempt-loop continuation after a step. Tool Policy owns a caller-declared pre-execution permission decision; the two judgments are orthogonal and may be consulted explicitly by an integration.

## Relationship to Agent Budget

Agent Budget judges caller-declared quantitative ceilings. Tool Policy judges caller-declared permission by exact tool name; neither counts activity or supplies the other's policy.

## Relationship to Context Guard

Context Guard protects and verifies durable context across its own boundaries. Tool Policy concerns invocation gating by tool name and does not inspect or verify protected content.

## Relationship to Agent State

Agent State records caller-declared work items, statuses, and decisions. Tool Policy does not read or update that state and does not infer permission from work status.

## Relationship to Agent Progress

Agent Progress judges movement in caller-declared milestone sets. Tool Policy does not map progress results to tool permissions or infer a policy from milestones.

## Relationship to Agent Evidence

Agent Evidence judges whether caller-declared claims have linked supporting records. Tool Policy does not verify evidence for a policy or a tool invocation.

## Relationship to Handoff

Handoff carries caller-declared packets across agents or sessions. A caller may include a Tool Policy verdict as explicit data when appropriate, but Tool Policy does not create packets or decide whether a handoff is safe.

## Determinism and privacy

The judge is a pure function:

- equal valid inputs produce deep-equal and JSON-round-trip-safe verdicts;
- each call returns a fresh plain result object;
- exact-name comparisons are deterministic and case-sensitive;
- no I/O, telemetry, network access, global state, persistence, or hidden history is used;
- the core never logs inputs or stores declarations.

## Limitations

Version 0.1 judges one caller-declared tool name per call. Matching is exact-name only: there are no patterns, globs, prefixes, argument rules, tool discovery, or automatic policy construction. `requires_approval` is only a declared outcome; integrations own prompts and enforcement. Phase 1 ships no Pi adapter and no other harness adapter.
