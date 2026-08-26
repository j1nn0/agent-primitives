# @j1nn0/agent-evidence

## What

`@j1nn0/agent-evidence` judges whether caller-declared claims are backed by explicitly linked caller-declared evidence records. It resolves every requirement of every claim against one supplied evidence snapshot and returns a small deterministic verdict for each claim. It is an ESM-only package with zero runtime dependencies.

The package evaluates declarations supplied by its caller. It does not inspect evidence content, run commands, observe an agent, or decide what a claim means. It is an **evidence judgment**, not a verifier, tracker, retry policy, or agent framework.

## Why

A caller often has an explicit claim and several observations that may support or contradict it. Linking a claim requirement to an evidence identifier keeps that boundary visible: the caller chooses the records and subjects, while this primitive applies only the closed outcome and identity rules in its contract.

The result makes uncertainty and stale subject references explicit instead of silently treating any record with a familiar identifier as proof. A caller can then decide how a judgment participates in a larger workflow without this core package inferring lifecycle state or truth.

## Installation

Install the published package from the registry with your package manager:

- pnpm: `pnpm add @j1nn0/agent-evidence`
- npm: `npm install @j1nn0/agent-evidence`
- Yarn: `yarn add @j1nn0/agent-evidence`

### From a local checkout (development)

For development or local use, build the package, then install the built package by local path:

```sh
pnpm install
pnpm --filter @j1nn0/agent-evidence build
pnpm add file:/path/to/agent-primitives/packages/agent-evidence
```

Requirements:

- Node.js `>=22.12.0`
- ESM imports
- zero runtime dependencies

## Quick start

Declare the claims, the non-empty requirements for each claim, and the evidence records that those requirements name:

```ts
import { judgeEvidence } from '@j1nn0/agent-evidence';
import type { EvidenceClaim, EvidenceRecord } from '@j1nn0/agent-evidence';

const claims: readonly EvidenceClaim[] = [
  { id: 'tests-pass', requires: [{ evidenceId: 'tests-run' }] },
  { id: 'release-ready', requires: [{ evidenceId: 'release-check' }] },
];
const evidence: readonly EvidenceRecord[] = [
  { id: 'tests-run', outcome: 'confirmed' },
  { id: 'release-check', outcome: 'unknown' },
];

console.log(judgeEvidence({ claims, evidence }));
// { claims: [
//   { claimId: 'tests-pass', outcome: 'supported' },
//   {
//     claimId: 'release-ready',
//     outcome: 'unsupported',
//     reason: 'unconfirmed_evidence',
//     evidenceId: 'release-check'
//   }
// ] }
```

## The model

An evidence record is a caller-declared observation with an opaque identifier, a closed outcome, and an optional opaque subject:

```ts
interface EvidenceRecord {
  readonly id: string;
  readonly outcome: 'confirmed' | 'refuted' | 'unknown';
  readonly subject?: string;
}
```

A claim has an opaque identifier and at least one explicitly linked requirement. A requirement names one evidence record and may constrain its subject:

```ts
interface ClaimRequirement {
  readonly evidenceId: string;
  readonly subject?: string;
}

interface EvidenceClaim {
  readonly id: string;
  readonly requires: readonly ClaimRequirement[];
}
```

The judge input is a plain object with required `claims` and `evidence` arrays. Both arrays may be empty, but every individual claim must have a non-empty `requires` array. Identifiers are accepted when they are non-empty and not all whitespace; the original strings are retained exactly.

## Public API reference

The package root exports the runtime values `judgeEvidence` and `EvidenceError`, plus these TypeScript types:

- `EvidenceOutcome` — the closed `confirmed`, `refuted`, or `unknown` vocabulary;
- `UnsupportedReason` — `missing_evidence`, `unconfirmed_evidence`, or `subject_mismatch`;
- `ClaimOutcome` — `supported`, `contradicted`, or `unsupported`;
- `EvidenceRecord` — one caller-declared evidence record;
- `ClaimRequirement` — one explicit evidence link and optional subject constraint;
- `EvidenceClaim` — one claim with at least one requirement;
- `ClaimResult` — the result for one claim;
- `EvidenceVerdict` — one result per input claim in input order;
- `EvidenceErrorCode` — currently only `invalid_input`.

`judgeEvidence(input: unknown): EvidenceVerdict` treats its input as untrusted. It throws `EvidenceError` with `code === 'invalid_input'` for malformed input. The error's `name` is `EvidenceError`. Its constructor signature is `new EvidenceError(code: EvidenceErrorCode, message: string)`; callers normally match on the thrown error rather than construct one.

Inputs must be plain objects. `claims` and `evidence` are required own properties and must be arrays. Claims, requirements, and evidence records must be plain objects with the required own properties and valid values. Optional `subject` properties are validated when present, and explicit `undefined` is rejected rather than treated as absent. Extra keys are accepted and ignored throughout.

## What counts as supporting a claim

The judge evaluates **all** requirements of a claim. Each requirement resolves as follows:

1. If its `evidenceId` names no record, it is a `missing_evidence` candidate.
2. If it has a subject and the record's subject is absent or different, it is a `subject_mismatch` candidate. This check happens before the record outcome, so a subject-mismatched refuted record does not contradict the claim.
3. If the subjects are compatible and the record outcome is `refuted`, it is a contradicted candidate.
4. If the subjects are compatible and the record outcome is `unknown`, it is an `unconfirmed_evidence` candidate.
5. If the subjects are compatible and the record outcome is `confirmed`, that requirement is satisfied.

A claim is `supported` only when every requirement is satisfied. Otherwise, the aggregate classification uses this precedence, from highest to lowest:

1. `contradicted`;
2. `subject_mismatch`;
3. `missing_evidence`;
4. `unconfirmed_evidence`;
5. `supported` when all requirements are satisfied.

Precedence overrides declaration order. When multiple requirements have the winning classification, the first requirement in the claim's `requires` array supplies the reported `evidenceId`. Every `contradicted` or `unsupported` result names the requirement evidence responsible for that result. The verdict preserves the input `claims` order exactly, with one result per input claim.

## Duplicate identifiers

Duplicate claim `id` values are invalid, as are duplicate evidence record `id` values. A claim cannot repeat the same requirement `evidenceId` within its own `requires` array. The same evidence identifier may be referenced by requirements in different claims; that is valid and can support each of those claims.

## SUBJECT IDENTITY MISMATCH DETECTION

Subjects are opaque, caller-supplied identities. When a requirement supplies a subject, it matches a record only when the record supplies the exact same subject; there is no trimming, normalization, case folding, or other interpretation. A requirement without a subject matches a record regardless of whether that record has a subject. The core detects only this declared subject identity mismatch. It does **not** verify that a subject actually corresponds to a current HEAD, artifact, revision, or any other external state.

## Relationship to Progress

Progress measures movement in caller-declared milestone sets; Evidence judges whether caller-declared claims have linked supporting records. Progress is movement, not evidence, and there is no automatic mapping between a Progress verdict and Evidence declarations. A caller may explicitly convert one model into the other when that is appropriate.

## Relationship to Retry Guard

Retry Guard judges caller-declared retry episodes and produces `retryAllowed`; Evidence judges claim requirements. Declared outcomes stay claims here too: judging evidence does not change `retryAllowed`, and this package performs no automatic mapping to retry attempts or policies. A caller may consult an Evidence verdict before making a retry decision.

## Relationship to Agent State

Agent State records caller-declared work items and statuses. A `done` status remains a caller-declared status; Evidence does not decide whether work is done and does not automatically turn Agent State items into claims or evidence records.

## Relationship to Context Guard

Context Guard protects and verifies durable context across its own boundaries. Evidence judging is separate from durable context preservation: this core does not capture, persist, restore, summarize, or reinject context.

## Relationship to Future Handoff

A future handoff packet may consume Evidence verdicts as explicit data when a caller chooses, but this core is not handoff-specific. It does not create handoff packets, select a successor, or decide whether a handoff is safe or complete.

## What Evidence does not know

The primitive does not know:

- whether a caller's observations or outcomes are true;
- whether the commands or checks behind an observation actually ran;
- what a subject refers to or whether it identifies the claimed current revision;
- whether a task is complete, safe, or valuable;
- whether claim text and evidence content are semantically related;
- whether a different evidence record should be preferred.

It does not infer claims, inspect text, execute commands, normalize identifiers, consult history, or mutate caller state.

## Determinism and privacy

The judge is a pure function:

- equal inputs produce deep-equal, JSON-round-trip-safe verdicts;
- claim and requirement order is preserved where the contract specifies it, with no sorting or normalization;
- each judgment constructs fresh result objects and arrays without aliasing input arrays;
- no timestamps, random identifiers, global state, persistence, or hidden history are used;
- there is no filesystem or other I/O, network access, telemetry, or console output in the core package;
- caller-supplied identifiers and subjects are opaque and are never logged.

The primitive returns only plain serializable objects and arrays. It has no runtime dependencies.

## Limitations

Version 0.1 trusts self-reported observations at face value. It does not verify truth, whether a command ran, or what a subject identifies. It performs no text or semantic matching between claim content and evidence content, and it makes one judgment only over the supplied snapshot rather than retaining history or checking later changes.

The outcome and unsupported-reason vocabularies are fixed in version 0.1. The package does not provide confidence scores, external revision checks, a persistence layer, a CLI, a Pi adapter, an MCP integration, a handoff protocol, or provider integration.
