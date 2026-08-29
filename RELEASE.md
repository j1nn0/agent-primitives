# Release procedure

The release workflow uses one guarded path for the package families listed below. It never bumps
versions and it never publishes source directories. Validate mode packs and audits the release
tarballs; publish mode reuses those exact tarball bytes with npm.

## Package families

| Family | Core package | Pi adapter package | Current registry status |
| --- | --- | --- | --- |
| `context-guard` | `packages/context-guard` → `@j1nn0/agent-context-guard` `0.1.1` | `packages/context-guard-pi` → `@j1nn0/agent-context-guard-pi` `0.1.1` | Published |
| `agent-state` | `packages/agent-state` → `@j1nn0/agent-state` `0.1.0` | `packages/agent-state-pi` → `@j1nn0/agent-state-pi` `0.1.0` | Published |
| `agent-progress` | `packages/agent-progress` → `@j1nn0/agent-progress` `0.1.1` | `packages/agent-progress-pi` → `@j1nn0/agent-progress-pi` `0.1.1` | Published |
| `agent-retry-guard` | `packages/agent-retry-guard` → `@j1nn0/agent-retry-guard` `0.1.1` | `packages/agent-retry-guard-pi` → `@j1nn0/agent-retry-guard-pi` `0.1.1` | Published |
| `agent-evidence` | `packages/agent-evidence` → `@j1nn0/agent-evidence` `0.1.0` | `packages/agent-evidence-pi` → `@j1nn0/agent-evidence-pi` `0.1.0` | Published |
| `agent-handoff` | `packages/agent-handoff` → `@j1nn0/agent-handoff` `0.1.1` | `packages/agent-handoff-pi` → `@j1nn0/agent-handoff-pi` `0.1.1` | Published |
| `agent-budget` | `packages/agent-budget` → `@j1nn0/agent-budget` `0.1.0` | `packages/agent-budget-pi` → `@j1nn0/agent-budget-pi` `0.1.0` | Published
| `agent-tool-policy` | `packages/agent-tool-policy` → `@j1nn0/agent-tool-policy` `0.1.1` | `packages/agent-tool-policy-pi` → `@j1nn0/agent-tool-policy-pi` `0.1.1` | Published |

The published packages listed above reached the registry through the bootstrap procedure
below. Each newly bootstrapped pair must have Trusted Publishing configured before its
normal publish dispatch is used.

## Primary path: GitHub Actions

Use [`.github/workflows/release.yml`](.github/workflows/release.yml), whose
workflow name is **Release**. It is `workflow_dispatch` only. The workflow
filename is part of the npm Trusted Publisher identity and must remain exactly
`release.yml`.

### Dispatch inputs and target selection

- `family` is required and selects exactly one family: `context-guard`,
  `agent-state`, `agent-progress`, `agent-retry-guard`, `agent-evidence`,
  `agent-handoff`, `agent-budget`, or `agent-tool-policy`. It defaults to `context-guard`.
- `mode` is required and is either `validate` or `publish`; it defaults to
  `validate`.
- `core_version` is the manifest version of the selected family's core package.
  Its workflow default is `0.1.1`.
- `pi_version` is the manifest version of the selected family's Pi adapter. Its
  workflow default is `0.1.1`.
- `confirmation` is optional in the input form and is checked only in publish
  mode. It must equal exactly
  `publish-<family>-<core_version>-<pi_version>`.
- `allow_existing_core` defaults to `false` and is only for deliberate partial
  recovery when the requested core version already exists and the adapter does
  not.

For the current Agent State manifests, select the matching family
with `core_version=0.1.0` and `pi_version=0.1.0`. The workflow defaults remain
`0.1.1` so the already-published Context Guard release remains the safe default.
For the current Agent Progress manifests, select the matching family
with `core_version=0.1.1` and `pi_version=0.1.1`. The workflow defaults remain
`0.1.1` so the already-published Context Guard release remains the safe default.
For the current Retry Guard manifests, select family `agent-retry-guard` with `core_version=0.1.1` and `pi_version=0.1.1`. The workflow defaults remain `0.1.1` so the already-published Context Guard release remains the safe default.
For the current Evidence manifests, select family `agent-evidence` with `core_version=0.1.0` and `pi_version=0.1.0`. The workflow defaults remain `0.1.1` so the already-published Context Guard release remains the safe default.
For the current Agent Handoff manifests, select family `agent-handoff` with `core_version=0.1.1` and `pi_version=0.1.1`. The workflow defaults remain `0.1.1` so the already-published Context Guard release remains the safe default.
For the current Agent Budget manifests, select family `agent-budget` with `core_version=0.1.0` and `pi_version=0.1.0`. The workflow defaults remain `0.1.1` so the already-published Context Guard release remains the safe default.
For the current Agent Tool Policy manifests, select family `agent-tool-policy` with `core_version=0.1.1` and `pi_version=0.1.1`. The workflow defaults remain `0.1.1` so the already-published Context Guard release remains the safe default.

### Validate versus publish

`validate` performs no registry publication and does not require the confirmation
literal. It installs dependencies from the frozen lockfile, validates only the selected
family's core and Pi adapter for build, typecheck, test, and `check:package`, runs the
family-specific root example script, retains repo-wide lint, and requires a successful
CI run for the dispatched commit with a `push` event on `main` and the same SHA before
proceeding, failing closed otherwise. It performs pnpm dry runs, packs and audits both
release tarballs, and runs the selected family's fresh-consumer smoke. Only after all
of those checks succeed, validate mode uploads the exact packed core and adapter
`.tgz` files as the Actions artifact
`release-tarballs-<family>-<core_version>-<pi_version>-<sha>-attempt-<run_attempt>`.
The artifact is retained for 90 days with `overwrite` disabled. Validate mode rejects
a non-empty `validated_run_id`.

`publish` requires a non-empty `validated_run_id` and the exact confirmation literal.
It repeats the safety checks, reasserts the manifest versions, and performs an
anonymous registry preflight. The publish job downloads and verifies exactly the
attempt-specific artifact from that validated run, re-audits both downloaded tarballs,
and publishes those exact bytes. It does not install dependencies, build, or pack.
A missing, deleted, expired (including HTTP 410), or otherwise inaccessible artifact
hard-fails the release; the operator must run a new validate dispatch. The publish job
then verifies the core on the registry and verifies its provenance before publishing
the adapter. Finally it verifies the adapter and its provenance, and the anonymous
`registry-smoke` job exercises both packages.

### Validated-run reuse

In `publish` mode, the operator must pass `validated_run_id` for an earlier successful
validate-mode run of the same workflow, commit, family, and requested versions. The
workflow verifies the reference through the Actions API: the same SHA on `main`, the
`release.yml` `workflow_dispatch` workflow, successful completion, an older run number,
the exact run attempt, validate-mode job states, every required validation step,
`Upload validated release tarballs` as a successful step on that attempt, and the
selected family's smoke binding. It then recomputes the attempt-specific artifact
name, requires exactly one unexpired artifact bound to that run ID and head SHA,
re-verifies GitHub's artifact SHA-256 digest locally, validates the ZIP strictly,
and audits both extracted tarballs. Any anomaly hard-fails; there is no inline-
validation fallback in publish mode. Validate mode rejects the input.

The CI preflight exits immediately on a terminal non-success CI conclusion; queued or
in-progress runs continue through the existing bounded polling window.

Registry visibility verification keeps its ~585s bounded budget: the first retry waits 15s and subsequent retries wait 5s. This is a tail-latency reduction for propagation that crosses the 15s boundary, not a happy-path release speedup. Track 2 (version-manifest gate) is designed but NOT implemented.

## Trusted Publishing and first-publish bootstrap

The release path is tokenless Trusted Publishing only:

- no `NPM_TOKEN`;
- no `NODE_AUTH_TOKEN`;
- no `secrets.*` expression; and
- no token-authenticated `.npmrc` or fallback authentication.

The workflow uses `contents: read` permissions globally. The `validate` job uses
`actions: read` plus `contents: read`; `publish` uses `actions: read`, `contents: read`,
and `id-token: write`; and `registry-smoke` uses `contents: read`. It declares no
GitHub Actions `environment:`. Do not add `NPM_TOKEN`, `NODE_AUTH_TOKEN`, a
`secrets.*` reference, or an environment to the release path.

Trusted Publishing cannot perform the first publish of a package that does not
exist on the npm registry, so a new package must first be published once by a
human outside CI. Any new package pair added to this repository needs the same
one-time bootstrap before Trusted Publishing can be configured for it. Bootstrap
the core before its adapter from exact `pnpm pack` tarballs only; bootstrap
publishes carry no provenance. This is documentation only; the workflow contains
no bootstrap automation.

A manual bootstrap publishes an audited `pnpm pack` tarball, never a source
directory, and publishes the core before its adapter. The registry read path lags
the write path for a brand-new package, so a single `npm view` immediately after
publishing can return 404 while the publish itself succeeded. Poll until the
requested version is actually visible, then confirm its version, `latest` tag,
metadata, and tarball shasum against the audited artifact before publishing the
adapter. Do not skip that confirmation because one `npm view` returned 404, and do
not substitute a fixed sleep: the observed delay varies. The GitHub Actions publish
job already retries its registry and attestation reads, so this constraint applies
to manual bootstraps only and is not a reason to change the workflow.

A bootstrap publish cannot carry provenance, because provenance requires a
supported cloud CI provider. Those first versions are therefore unattested, which
is an accepted one-time gap; every subsequent release goes through OIDC with
provenance. npm cannot configure a trusted publisher for a package that does not
exist yet: `npm trust` requires "Package must exist", and npm/cli#8544 is still
open. After each package exists, configure its npm Trusted Publisher separately
with:

- owner: `j1nn0`;
- repository: `agent-primitives`;
- workflow filename: `release.yml`; and
- environment: none.

After a new package pair completes its manual bootstrap, configure npm Trusted
Publisher for both its core and adapter before using that family's normal publish
dispatch. A bootstrap publish performed outside a supported CI provider cannot
carry provenance, so it is not a substitute for the provenance checks on
subsequent Trusted Publishing releases.

## Ordering and artifact integrity

For any family, validate mode first packs the core and adapter tarballs with pnpm,
audits them, and runs the selected packed-consumer smoke. It then uploads those exact
files under an attempt-specific Actions artifact name. Publish mode resolves that
artifact from the referenced validated run, verifies its run binding, SHA, size, and
GitHub-managed ZIP digest, strictly validates and extracts its two flat `.tgz` members,
and performs the full publish-side audit. It passes the extracted paths directly to
`npm publish`:

1. publish the validated core tarball with `npm publish --access public --provenance`;
2. verify the core registry manifest and provenance;
3. publish the validated adapter tarball with the same flags; and
4. verify the adapter registry manifest and provenance.

The adapter is never published before its core. The packed audits require the
expected name and version, `LICENSE`, `README.md`, `dist/`, and `src/` (and, for the
adapter, `pi.extensions` targets). They reject workspace, `file:`, and `link:`
dependencies, forbidden test and benchmark paths, `.git`, `.npmrc`, nested tarballs,
absolute `/home/` paths, and `/home/` in file contents. The adapter dependency must
be exactly `^<core_version>` after pnpm rewrites `workspace:^` during packing.

The provenance meaning is composed rather than implied by npm alone:

```text
Phase 1b validated_run_id + run_attempt verification
  → GitHub artifact bound to that run id and head SHA
  → GitHub-managed artifact SHA-256 digest re-verified locally
  → the downloaded exact validated .tgz
  → publish-side full tarball audit
  → npm provenance: published tarball subject digest + publishing workflow/source identity
```

npm provenance contributes only the last link (what was published, and by which
workflow and source); the earlier links tie those bytes back to the validated run.

Each provenance response must contain the npm publish predicate and SLSA v1. The
SLSA statement must identify:

- repository: `https://github.com/j1nn0/agent-primitives`;
- workflow: `.github/workflows/release.yml`;
- ref: `refs/heads/main`; and
- the dispatched commit (`github.sha`).

The guard in `scripts/guard-release-workflow.mjs` checks these static invariants,
including the family pairing, family-scoped build/typecheck/test/`check:package` validation,
family-specific examples, exact-SHA CI preflight, permissions, trigger, action pins, tokenless
policy, tarball operands, and core-before-adapter provenance ordering. The
negative-control suite is available as `pnpm test:release-guard`. CI runs it and the
registry polling fixture (`pnpm test:registry-poll`) on the Node 24 job after
`pnpm check:release`; the guard fails if either suite is removed from that job.

## Registry recovery

The publish preflight refuses to republish an existing version. It also refuses
an inconsistent state where the adapter exists but the core does not. If the
core exists and the adapter does not, the default is to stop; use
`allow_existing_core=true` only after an explicit decision to verify the existing
core and publish the missing adapter. State B additionally requires the registry
core's `dist.integrity`, read with
`npm view <core>@<version> dist.integrity --json --prefer-online`, to equal the
`sha512-` plus base64 SHA-512 integrity of the validated core tarball downloaded by
the publish job. Missing, malformed, or mismatching integrity hard-fails before the
adapter can be published.

Inspect the public registry before re-dispatching after a timeout. Registry and
attestation reads use bounded retries because new releases can take time to
propagate.

## Required sequence

1. Dispatch the selected family in `validate` mode from `main` and wait for the
   complete validation job, including the packed-consumer smoke and artifact upload,
   to pass. Record that run's ID and attempt.
2. Dispatch the same family and versions in `publish` mode with the exact
   family-aware confirmation literal and the validated run ID.
3. Let the workflow resolve and verify the exact artifact, finish its core publication,
   core registry/provenance checks, adapter publication, adapter checks, and anonymous
   registry smoke.

After any required first-publish bootstrap, no manual publish, tag, GitHub Release, or version bump is part of the normal release procedure.
